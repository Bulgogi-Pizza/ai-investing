import { decideDualMomentum, decideFormula } from './composite';
import {
  capitalGainsTaxForYear,
  costWarnings,
  resolveCosts,
  roundTripCostRate,
  type CostSettings,
  type ResolvedCosts,
} from './costs';
import {
  addSample,
  createBucketStats,
  defaultMinSamples,
  expectedProfit,
  type BucketStats,
  type ProfitSample,
} from './expectedProfit';
import { annualizedVolatility, maxDrawdown } from './metrics';
import {
  checkOrder,
  defaultSafeguards,
  maxQuantityBelowValue,
  type OrderRejection,
  type Safeguards,
} from './safeguards';
import { computeSignalScores, momentumReturn } from './signals';
import { requiredBars, validateAlgorithm } from './templates';
import {
  excludedHistoricalSignals,
  historicalSignalIds,
  type AlgorithmDefinition,
  type Decision,
  type DailyBar,
  type SignalWeight,
  type ValueSnapshot,
} from './types';

export type BacktestOptions = {
  /** First simulated decision day. Earlier bars are history only. Default: first day with enough history. */
  startDate?: string;
  /** Last simulated day (inclusive). */
  endDate?: string;
  /** Adverse price move on every fill in basis points (buy at open*(1+s), sell at open*(1-s)). Default 0. */
  slippageBps?: number;
  costs?: CostSettings;
  safeguards?: Partial<Safeguards>;
  expectedProfit?: {
    /**
     * 'walk-forward' (default): the live rule, using only samples closed before the decision day.
     * 'ignore': research mode that skips the rule; the result is labeled `researchOnly`.
     */
    mode?: 'walk-forward' | 'ignore';
    minSamples?: number;
    bucketWidth?: number;
  };
  /** Keep every per-day decision in the result (default false). */
  recordDecisions?: boolean;
};

export type BacktestInput = {
  algorithm: AlgorithmDefinition;
  /** Daily bars per symbol, oldest first, split-adjusted. Must contain every target symbol. */
  bars: Record<string, DailyBar[]>;
  /** Point-in-time fundamentals per symbol (adapter output). */
  values?: Record<string, ValueSnapshot[]>;
  options?: BacktestOptions;
};

export type Trade = {
  date: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  notional: number;
  commission: number;
  /** Transaction tax on sells. */
  tax: number;
  score: number | null;
};

export type RoundTrip = {
  symbol: string;
  quantity: number;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  heldTradingDays: number;
  /** exit / entry - 1 on fill prices (before commission and tax). */
  grossReturn: number;
  /** Proceeds - cost minus commissions and transaction tax (annual capital-gains tax excluded). */
  netPnl: number;
};

export type DecisionRecord = {
  date: string;
  symbol: string;
  action: Decision['action'];
  score: number | null;
  reason: Decision['reason'];
};

export type EquityPoint = { date: string; equity: number; cash: number; positionValue: number };

export type OpenPosition = {
  symbol: string;
  quantity: number;
  entryDate: string;
  entryPrice: number;
  markPrice: number;
};

export type BacktestResult = {
  algorithmName: string;
  market: AlgorithmDefinition['market'];
  currency: 'KRW' | 'USD';
  budget: number;
  period: { start: string; end: string; tradingDays: number };
  /** Signals without point-in-time history; they were not used. */
  excludedSignals: ['supply', 'news'];
  /** Share of the configured weight that sat on excluded signals (0 when none configured). */
  excludedSignalWeightShare: number;
  expectedProfitMode: 'walk-forward' | 'ignored-for-research';
  /** True when the expected-profit rule was skipped; never use such a result to judge live readiness. */
  researchOnly: boolean;
  costSettings: ResolvedCosts;
  warnings: string[];
  metrics: {
    finalEquity: number;
    /** Return before explicit costs (slippage is already in the fill prices). */
    totalReturn: number;
    /** Return after commission, transaction tax and capital-gains tax. */
    netReturn: number;
    /** Largest peak-to-trough equity fall, non-negative fraction. */
    maxDrawdown: number;
    /** Annualized (252) sample standard deviation of daily equity returns; null with < 2 returns. */
    volatility: number | null;
    trades: number;
    roundTrips: number;
    /** Share of round trips with positive net P&L (before annual tax); null without round trips. */
    winRate: number | null;
    /** Average over days of position value / equity. */
    exposure: number;
    /** Share of days that ended with at least one open position. */
    daysInvested: number;
  };
  costs: {
    commission: number;
    transactionTax: number;
    capitalGainsTax: number;
    total: number;
    capitalGainsTaxByYear: { year: string; netRealizedGain: number; tax: number }[];
  };
  equityCurve: EquityPoint[];
  trades: Trade[];
  roundTrips: RoundTrip[];
  openPositions: OpenPosition[];
  /** Per-day decisions when `recordDecisions` was set. */
  decisions: DecisionRecord[];
  /** Buy signals the expected-profit rule held back. */
  heldBack: { insufficientHistory: number; expectedBelowCost: number };
  /** Blocked order attempts by reason (no-op signals such as 'sell while flat' are not counted). */
  rejections: Partial<Record<OrderRejection, number>>;
  /** Set when the cumulative-loss stop ended trading. */
  stoppedOn: string | null;
  /** Signal-level round trips used for the expected-profit buckets. */
  samples: ProfitSample[];
  bucketStats: BucketStats;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateBars(symbol: string, bars: DailyBar[]): void {
  let prev = '';
  for (const b of bars) {
    if (!DATE.test(b.date))
      throw new Error(`backtest: ${symbol} has an invalid bar date ${b.date}`);
    if (b.date <= prev)
      throw new Error(`backtest: ${symbol} bars must be strictly ascending (${b.date})`);
    prev = b.date;
    for (const v of [b.open, b.high, b.low, b.close])
      if (!Number.isFinite(v) || v <= 0)
        throw new Error(`backtest: ${symbol} ${b.date} has a non-positive or non-finite price`);
    if (!Number.isFinite(b.volume) || b.volume < 0)
      throw new Error(`backtest: ${symbol} ${b.date} has an invalid volume`);
  }
}

type Position = {
  quantity: number;
  entryK: number;
  entryDate: string;
  entryPrice: number;
  /** Entry commission not yet attributed to sold shares. */
  entryCommissionLeft: number;
  /** True once a sell started; the rest is sold on later days (order value cap tranches). */
  liquidating: boolean;
  soldQuantity: number;
  soldNotional: number;
  realizedNet: number;
};

/**
 * Deterministic daily backtest of a formula algorithm. Timing mirrors the live design: on day t
 * the decision uses bars through day t-1 (completed) and day t's open price; the order is a
 * limit order at the open (plus adverse slippage) and fills at day t's open. Nothing from day t's
 * high/low/close/volume or later is read when deciding (enforced by slicing and by an assertion in
 * the signal layer). Positions are long-only, integer shares, funded only from the budget.
 */
export function runBacktest(input: BacktestInput): BacktestResult {
  const { algorithm } = input;
  validateAlgorithm(algorithm);
  const options = input.options ?? {};
  const slipBps = options.slippageBps ?? 0;
  if (!Number.isFinite(slipBps) || slipBps < 0 || slipBps >= 10_000)
    throw new Error('backtest: slippageBps must be within [0, 10000)');
  const slip = slipBps / 10_000;
  const costs = resolveCosts(algorithm.market, options.costs);
  const sg: Safeguards = { ...defaultSafeguards(algorithm.market), ...options.safeguards };
  if (!(sg.lossStopFraction > 0 && sg.lossStopFraction <= 1))
    throw new Error('backtest: lossStopFraction must be within (0, 1]');
  const ruleMode = options.expectedProfit?.mode ?? 'walk-forward';
  const minSamples = options.expectedProfit?.minSamples ?? defaultMinSamples;
  const enforceExpected = ruleMode === 'walk-forward';
  const roundTripCost = roundTripCostRate(costs);

  const isDual = algorithm.template === 'dualMomentum';
  const used: SignalWeight[] = isDual
    ? []
    : algorithm.signals.filter((s) => s.weight > 0 && historicalSignalIds.includes(s.id));
  const totalWeight = algorithm.signals.reduce((a, s) => a + Math.max(0, s.weight), 0);
  const usedWeight = used.reduce((a, s) => a + s.weight, 0);
  if (!isDual && used.length === 0)
    throw new Error(
      'backtest: no signal with point-in-time history is configured (supply/news are excluded)',
    );
  const formula = {
    signals: used,
    buyThreshold: algorithm.buyThreshold,
    sellThreshold: algorithm.sellThreshold,
  };
  const usedIds = used.map((s) => s.id);

  const symbols = [...algorithm.symbols].sort();
  const barsBy: Record<string, DailyBar[]> = {};
  const dateIndex: Record<string, Map<string, number>> = {};
  for (const symbol of symbols) {
    const bars = input.bars[symbol];
    if (!bars) throw new Error(`backtest: no bars for ${symbol}`);
    validateBars(symbol, bars);
    barsBy[symbol] = bars;
    dateIndex[symbol] = new Map(bars.map((b, i) => [b.date, i]));
  }

  const required = requiredBars(algorithm);
  const historyCap = Math.max(500, 3 * required);
  const allDates = [...new Set(symbols.flatMap((s) => barsBy[s].map((b) => b.date)))].sort();
  let start = options.startDate;
  if (start === undefined) {
    const firsts = symbols
      .map((s) => barsBy[s][required]?.date)
      .filter((d): d is string => d !== undefined)
      .sort();
    start = firsts[0] ?? allDates[0];
  }
  const calendar = allDates.filter(
    (d) => d >= (start as string) && (options.endDate === undefined || d <= options.endDate),
  );
  if (calendar.length === 0) throw new Error('backtest: no trading days in the requested range');

  const budget = algorithm.budget;
  const positionBudget =
    budget *
    (algorithm.positionFraction ??
      (isDual ? 1 / (algorithm.dualMomentum?.topN ?? 1) : 1 / symbols.length));

  let cash = budget;
  let accruedTax = 0;
  let stoppedOn: string | null = null;
  const positions = new Map<string, Position>();
  const lastClose = new Map<string, number>();
  const shadows = new Map<
    string,
    { entryK: number; entryPrice: number; score: number; openedOn: string }
  >();
  const stats = createBucketStats(options.expectedProfit?.bucketWidth);
  const samples: ProfitSample[] = [];
  const trades: Trade[] = [];
  const roundTrips: RoundTrip[] = [];
  const curve: EquityPoint[] = [];
  const decisionLog: DecisionRecord[] = [];
  const rejections: Partial<Record<OrderRejection, number>> = {};
  const heldBack = { insufficientHistory: 0, expectedBelowCost: 0 };
  const yearGain = new Map<string, number>();
  const yearTax: { year: string; netRealizedGain: number; tax: number }[] = [];
  let commissionTotal = 0;
  let transactionTaxTotal = 0;
  let exposureSum = 0;
  let investedDays = 0;
  const reject = (reason: OrderRejection) => {
    rejections[reason] = (rejections[reason] ?? 0) + 1;
  };

  for (let k = 0; k < calendar.length; k++) {
    const date = calendar[k];
    type Quote = { symbol: string; bar: DailyBar; completed: DailyBar[]; price: number };
    const quotes: Quote[] = [];
    for (const symbol of symbols) {
      const idx = dateIndex[symbol].get(date);
      if (idx === undefined || idx === 0) continue;
      const bar = barsBy[symbol][idx];
      quotes.push({
        symbol,
        bar,
        // Structural cut-off: only bars before day t. Day t contributes only its open (price).
        completed: barsBy[symbol].slice(Math.max(0, idx - historyCap), idx),
        price: bar.open,
      });
    }
    const quoteOf = new Map(quotes.map((q) => [q.symbol, q]));

    // 4. Cumulative-loss stop, evaluated before any order using the open marks.
    if (stoppedOn === null) {
      let mv = 0;
      for (const [symbol, p] of positions)
        mv += p.quantity * (quoteOf.get(symbol)?.price ?? lastClose.get(symbol) ?? p.entryPrice);
      if (cash + mv - accruedTax - budget <= -sg.lossStopFraction * budget) stoppedOn = date;
    }

    // Decisions for every target symbol that trades today.
    const decisions = new Map<string, Decision>();
    if (isDual) {
      const returns: Record<string, number | null> = {};
      for (const q of quotes)
        returns[q.symbol] = momentumReturn(
          q.completed,
          q.price,
          algorithm.dualMomentum!.lookbackDays,
        );
      const d = decideDualMomentum(returns, algorithm.dualMomentum!);
      for (const q of quotes) decisions.set(q.symbol, d[q.symbol]);
    } else {
      for (const q of quotes) {
        const scores = computeSignalScores(
          {
            bars: q.completed,
            price: q.price,
            decisionDate: date,
            values: input.values?.[q.symbol],
          },
          usedIds,
          algorithm.params,
        );
        decisions.set(q.symbol, decideFormula(formula, scores));
      }
    }
    if (options.recordDecisions)
      for (const q of quotes) {
        const d = decisions.get(q.symbol)!;
        decisionLog.push({
          date,
          symbol: q.symbol,
          action: d.action,
          score: d.score,
          reason: d.reason,
        });
      }

    // Signal-level shadow round trips feed the expected-profit buckets (applied after today's orders).
    const pending: ProfitSample[] = [];
    for (const q of quotes) {
      const d = decisions.get(q.symbol)!;
      const sh = shadows.get(q.symbol);
      if (!sh && d.action === 'buy' && d.score !== null) {
        shadows.set(q.symbol, {
          entryK: k,
          entryPrice: q.price * (1 + slip),
          score: d.score,
          openedOn: date,
        });
      } else if (sh && d.action === 'sell' && k - sh.entryK >= sg.minHoldingTradingDays) {
        pending.push({
          score: sh.score,
          grossReturn: (q.price * (1 - slip)) / sh.entryPrice - 1,
          openedOn: sh.openedOn,
          closedOn: date,
        });
        shadows.delete(q.symbol);
      }
    }

    // Orders: sells first (frees cash), then buys by score. Skipped entirely once stopped.
    let ordersToday = 0;
    if (stoppedOn === null) {
      for (const q of quotes) {
        const d = decisions.get(q.symbol)!;
        const pos = positions.get(q.symbol);
        // A started exit (`liquidating`) continues on later days until the position is closed.
        if (!pos || (d.action !== 'sell' && !pos.liquidating)) continue;
        const price = q.price * (1 - slip);
        // Orders at or above the value cap are never placed: sell in tranches below it.
        const trancheMax =
          sg.maxOrderValue === null ? Infinity : maxQuantityBelowValue(price, sg.maxOrderValue);
        while (pos.quantity > 0) {
          const res = checkOrder({
            side: 'sell',
            quantity: Math.min(pos.quantity, trancheMax),
            price,
            ordersToday,
            stopped: false,
            ownQuantity: pos.quantity,
            heldTradingDays: k - pos.entryK,
            avgTradedValue: null,
            expectedProfit: { enforce: false, expected: null, roundTripCost },
            safeguards: sg,
          });
          if (!res.ok) {
            reject(trancheMax < 1 ? 'order-too-large' : res.reason);
            break;
          }
          pos.liquidating = true;
          const notional = res.quantity * price;
          const commission = notional * costs.commissionRate;
          const tax = notional * costs.sellTaxRate;
          cash += notional - commission - tax;
          commissionTotal += commission;
          transactionTaxTotal += tax;
          // Entry commission is released in proportion to the shares sold.
          const entryCommission = pos.entryCommissionLeft * (res.quantity / pos.quantity);
          pos.entryCommissionLeft -= entryCommission;
          const netPnl =
            notional - commission - tax - (res.quantity * pos.entryPrice + entryCommission);
          const year = date.slice(0, 4);
          yearGain.set(year, (yearGain.get(year) ?? 0) + netPnl);
          pos.soldQuantity += res.quantity;
          pos.soldNotional += notional;
          pos.realizedNet += netPnl;
          pos.quantity -= res.quantity;
          trades.push({
            date,
            symbol: q.symbol,
            side: 'sell',
            quantity: res.quantity,
            price,
            notional,
            commission,
            tax,
            score: d.score,
          });
          ordersToday++;
          if (pos.quantity === 0) {
            const exitPrice = pos.soldNotional / pos.soldQuantity;
            roundTrips.push({
              symbol: q.symbol,
              quantity: pos.soldQuantity,
              entryDate: pos.entryDate,
              exitDate: date,
              entryPrice: pos.entryPrice,
              exitPrice,
              heldTradingDays: k - pos.entryK,
              grossReturn: exitPrice / pos.entryPrice - 1,
              netPnl: pos.realizedNet,
            });
            positions.delete(q.symbol);
          }
        }
      }

      const buys = quotes
        .filter((q) => {
          const d = decisions.get(q.symbol)!;
          return d.action === 'buy' && d.score !== null && !positions.has(q.symbol);
        })
        .sort(
          (a, b) =>
            (decisions.get(b.symbol)!.score as number) -
              (decisions.get(a.symbol)!.score as number) || (a.symbol < b.symbol ? -1 : 1),
        );
      for (const q of buys) {
        const d = decisions.get(q.symbol)!;
        const score = d.score as number;
        const price = q.price * (1 + slip);
        const quantity = Math.floor(
          Math.min(positionBudget, cash) / (price * (1 + costs.commissionRate)),
        );
        if (quantity < 1) {
          reject('insufficient-budget');
          continue;
        }
        const window = q.completed.slice(-sg.liquidityWindow);
        const avgTradedValue =
          window.length < sg.liquidityWindow
            ? null
            : window.reduce((a, b) => a + b.close * b.volume, 0) / window.length;
        const res = checkOrder({
          side: 'buy',
          quantity,
          price,
          ordersToday,
          stopped: false,
          ownQuantity: 0,
          heldTradingDays: null,
          avgTradedValue,
          expectedProfit: {
            enforce: enforceExpected,
            expected: enforceExpected ? expectedProfit(stats, score, minSamples) : null,
            roundTripCost,
          },
          safeguards: sg,
        });
        if (!res.ok) {
          reject(res.reason);
          if (res.reason === 'insufficient-history') heldBack.insufficientHistory++;
          if (res.reason === 'expected-profit-below-cost') heldBack.expectedBelowCost++;
          continue;
        }
        const notional = res.quantity * price;
        const commission = notional * costs.commissionRate;
        cash -= notional + commission;
        commissionTotal += commission;
        positions.set(q.symbol, {
          quantity: res.quantity,
          entryK: k,
          entryDate: date,
          entryPrice: price,
          entryCommissionLeft: commission,
          liquidating: false,
          soldQuantity: 0,
          soldNotional: 0,
          realizedNet: 0,
        });
        trades.push({
          date,
          symbol: q.symbol,
          side: 'buy',
          quantity: res.quantity,
          price,
          notional,
          commission,
          tax: 0,
          score,
        });
        ordersToday++;
      }
    }

    // Close: mark to market, accrue annual capital-gains tax at year end, record the curve.
    for (const q of quotes) lastClose.set(q.symbol, q.bar.close);
    const lastOfYear =
      k === calendar.length - 1 || calendar[k + 1].slice(0, 4) !== date.slice(0, 4);
    if (lastOfYear) {
      const year = date.slice(0, 4);
      const gain = yearGain.get(year);
      if (gain !== undefined) {
        const tax = capitalGainsTaxForYear(gain, costs.capitalGainsTax);
        accruedTax += tax;
        yearTax.push({ year, netRealizedGain: gain, tax });
      }
    }
    let positionValue = 0;
    for (const [symbol, p] of positions)
      positionValue += p.quantity * (lastClose.get(symbol) ?? p.entryPrice);
    const equity = cash + positionValue - accruedTax;
    curve.push({ date, equity, cash, positionValue });
    if (positions.size > 0) investedDays++;
    if (equity > 0) exposureSum += positionValue / equity;
    for (const s of pending) {
      samples.push(s);
      addSample(stats, s.score, s.grossReturn);
    }
  }

  const equities = [budget, ...curve.map((p) => p.equity)];
  const finalEquity = equities[equities.length - 1];
  const capitalGainsTax = accruedTax;
  const totalCosts = commissionTotal + transactionTaxTotal + capitalGainsTax;
  const wins = roundTrips.filter((r) => r.netPnl > 0).length;
  const warnings: string[] = costs.needsSetup.map((n) => costWarnings[n]);
  warnings.push('수급·뉴스 신호는 과거 시점 데이터가 없어 제외했다.');
  if (algorithm.market === 'US' && sg.maxOrderValue === null)
    warnings.push('설정 필요: 미국 종목의 1억 원 환산 주문 상한이 설정되지 않아 확인하지 않았다.');
  if (!enforceExpected)
    warnings.push('연구용: 예상 이익 규칙을 적용하지 않았다. 실전 가능 여부 판단에 쓰지 않는다.');
  if (stoppedOn !== null) warnings.push(`누적 손실 한도에 닿아 ${stoppedOn}부터 주문을 멈췄다.`);

  const openPositions: OpenPosition[] = [...positions]
    .map(([symbol, p]) => ({
      symbol,
      quantity: p.quantity,
      entryDate: p.entryDate,
      entryPrice: p.entryPrice,
      markPrice: lastClose.get(symbol) ?? p.entryPrice,
    }))
    .sort((a, b) => (a.symbol < b.symbol ? -1 : 1));

  return {
    algorithmName: algorithm.name,
    market: algorithm.market,
    currency: algorithm.market === 'KR' ? 'KRW' : 'USD',
    budget,
    period: {
      start: calendar[0],
      end: calendar[calendar.length - 1],
      tradingDays: calendar.length,
    },
    excludedSignals: [...excludedHistoricalSignals] as ['supply', 'news'],
    excludedSignalWeightShare:
      totalWeight > 0 && !isDual ? (totalWeight - usedWeight) / totalWeight : 0,
    expectedProfitMode: enforceExpected ? 'walk-forward' : 'ignored-for-research',
    researchOnly: !enforceExpected,
    costSettings: costs,
    warnings,
    metrics: {
      finalEquity,
      totalReturn: (finalEquity + totalCosts) / budget - 1,
      netReturn: finalEquity / budget - 1,
      maxDrawdown: maxDrawdown(equities),
      volatility: annualizedVolatility(equities),
      trades: trades.length,
      roundTrips: roundTrips.length,
      winRate: roundTrips.length === 0 ? null : wins / roundTrips.length,
      exposure: exposureSum / curve.length,
      daysInvested: investedDays / curve.length,
    },
    costs: {
      commission: commissionTotal,
      transactionTax: transactionTaxTotal,
      capitalGainsTax,
      total: totalCosts,
      capitalGainsTaxByYear: yearTax,
    },
    equityCurve: curve,
    trades,
    roundTrips,
    openPositions,
    decisions: decisionLog,
    heldBack,
    rejections,
    stoppedOn,
    samples,
    bucketStats: stats,
  };
}
