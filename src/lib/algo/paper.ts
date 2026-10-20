import { decideDualMomentum, decideFormula } from './composite';
import {
  capitalGainsTaxForYear,
  resolveCosts,
  roundTripCostRate,
  type CostSettings,
} from './costs';
import {
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
import type {
  AlgorithmDefinition,
  Decision,
  DailyBar,
  Market,
  SignalId,
  SignalWeight,
  ValueSnapshot,
} from './types';

/**
 * One trading day of a paper (virtual) algorithm with persisted state (stage 7c).
 *
 * `runPaperDay` is the stateful twin of one iteration of `runBacktest`: the same decision engine,
 * the same safeguard function (`checkOrder`), the same fill, cost, tranche and shadow-round-trip
 * rules, so a paper run and a simulation of the same history trade identically (tests/algo-paper
 * compares them day by day). The differences are inherent to a live run and documented in
 * docs/implementation/algorithm.md: the decision price is the fresh quote (not a historical open),
 * the equity curve is marked at that quote, and the annual tax accrues when a new year starts.
 *
 * Pure: no network, no clock, no storage and no order code. Fills are virtual records only.
 */
export type PaperPosition = {
  symbol: string;
  quantity: number;
  entryDate: string;
  /** Fill price including slippage. */
  entryPrice: number;
  /** Entry commission not yet attributed to sold shares. */
  entryCommissionLeft: number;
  /** True once a sell started; the rest is sold on later days (order value cap tranches). */
  liquidating: boolean;
  soldQuantity: number;
  soldNotional: number;
  realizedNet: number;
  /** Last known price (decision quote of the latest run). */
  markPrice: number;
};

export type PaperShadow = { entryDate: string; entryPrice: number; score: number };
export type PaperEquityPoint = {
  date: string;
  equity: number;
  cash: number;
  positionValue: number;
};

export const maxPaperEquityPoints = 1000;
export const maxPaperSamples = 5000;

export type PaperLedger = {
  version: 1;
  algorithmId: string;
  market: Market;
  currency: 'KRW' | 'USD';
  /** 'stopped' after the cumulative-loss stop; no order is simulated until it is restarted. */
  status: 'running' | 'stopped';
  /** Session date of the first paper run: the paper period starts here. */
  startedOn: string;
  stoppedOn: string | null;
  stoppedReason: 'loss-limit' | null;
  /** Virtual starting capital in the market currency. */
  budget: number;
  cash: number;
  positions: Record<string, PaperPosition>;
  /** Signal-level round trips in progress (feed the expected-profit statistics). */
  shadows: Record<string, PaperShadow>;
  /** Closed signal-level round trips; their `closedOn` is a paper session date. */
  samples: ProfitSample[];
  totals: {
    fills: number;
    roundTrips: number;
    wins: number;
    commission: number;
    transactionTax: number;
    /** Adverse price move paid on fills; informational (already inside the fill prices). */
    slippage: number;
    realizedNet: number;
  };
  /** Net realized gain per calendar year (before annual capital-gains tax). */
  yearGain: Record<string, number>;
  /** Years whose capital-gains tax has been accrued into `accruedTax`. */
  taxedYears: string[];
  accruedTax: number;
  lastRunDate: string | null;
  /** Idempotency marker: the run that produced this state. */
  lastRunId: string | null;
  equityCurve: PaperEquityPoint[];
  updatedAt: string;
};

export function createPaperLedger(input: {
  algorithmId: string;
  market: Market;
  budget: number;
  startedOn: string;
  now: string;
}): PaperLedger {
  if (!(input.budget > 0) || !Number.isFinite(input.budget))
    throw new Error('paper: budget must be a positive number');
  return {
    version: 1,
    algorithmId: input.algorithmId,
    market: input.market,
    currency: input.market === 'KR' ? 'KRW' : 'USD',
    status: 'running',
    startedOn: input.startedOn,
    stoppedOn: null,
    stoppedReason: null,
    budget: input.budget,
    cash: input.budget,
    positions: {},
    shadows: {},
    samples: [],
    totals: {
      fills: 0,
      roundTrips: 0,
      wins: 0,
      commission: 0,
      transactionTax: 0,
      slippage: 0,
      realizedNet: 0,
    },
    yearGain: {},
    taxedYears: [],
    accruedTax: 0,
    lastRunDate: null,
    lastRunId: null,
    equityCurve: [],
    updatedAt: input.now,
  };
}

/** A decision supplied from outside the formula engine (AI method). */
export type ExternalDecision = {
  action: 'buy' | 'sell' | 'hold';
  reasons: string[];
  /** Expected gross return of the round trip (fraction); null = none given. */
  expectedReturn: number | null;
};

export type PaperQuote = {
  symbol: string;
  /** Fresh decision-time quote; null when there is none (the symbol is then not traded today). */
  price: number | null;
  /** Bars complete before the decision day, oldest first. */
  completed: DailyBar[];
  values?: ValueSnapshot[];
  external?: { supply?: number | null; news?: number | null };
};

export type PaperDayInput = {
  ledger: PaperLedger;
  /** Target list and signal parameters. `budget` is ignored: the ledger budget is used. */
  algorithm: AlgorithmDefinition;
  /** Signals the formula uses today (availability already applied by the caller). */
  usedSignals: SignalWeight[];
  /** Decisions for AI-method algorithms; when set the formula engine is not used. */
  externalDecisions?: Record<string, ExternalDecision>;
  /** Session date (market-local) and the id of this run. */
  date: string;
  runId: string;
  now: string;
  quotes: PaperQuote[];
  costs?: CostSettings;
  safeguards?: Partial<Safeguards>;
  slippageBps?: number;
  /** Bucket statistics as of `date` (walk-forward: only round trips closed before it). */
  stats: BucketStats;
  minSamples?: number;
};

export type PaperFill = {
  /** 1-based sequence within this algorithm and run. */
  seq: number;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  /** Fill price: decision price with adverse slippage. */
  price: number;
  referencePrice: number;
  notional: number;
  commission: number;
  /** Transaction tax on sells. */
  tax: number;
  /** Adverse price move paid, in market currency (informational). */
  slippage: number;
  score: number | null;
  reasons: string[];
};

export type PaperDecisionRecord = {
  symbol: string;
  action: 'buy' | 'sell' | 'hold';
  score: number | null;
  reason: string;
  /** Set when an order was wanted but a safeguard blocked it. */
  blockedBy?: OrderRejection;
};

export type PaperDayResult = {
  ledger: PaperLedger;
  fills: PaperFill[];
  decisions: PaperDecisionRecord[];
  rejections: Partial<Record<OrderRejection, number>>;
  heldBack: { insufficientHistory: number; expectedBelowCost: number };
  newlyStopped: boolean;
};

const reasonText: Record<string, string> = {
  'buy-threshold': '종합 점수가 매수 기준 이상',
  'sell-threshold': '종합 점수가 매도 기준 이하',
  'between-thresholds': '점수가 매수·매도 기준 사이',
  'insufficient-data': '신호 데이터 부족',
  'dual-momentum-pass': '상대·절대 모멘텀 통과',
  'absolute-momentum': '절대 모멘텀 미달',
  'relative-momentum': '상대 모멘텀 순위 밖',
  'target-removed': '대상 종목에서 제외됨',
};

function reasonsFor(d: {
  reason: string;
  score: number | null;
  signals?: Decision['signals'];
}): string[] {
  const out = [reasonText[d.reason] ?? d.reason];
  if (d.score !== null) out.push(`종합 점수 ${d.score.toFixed(2)}`);
  if (d.signals) {
    const parts = Object.entries(d.signals)
      .filter(([, v]) => v && v.score !== null)
      .map(([id, v]) => `${id} ${(v!.score as number).toFixed(2)}`);
    if (parts.length) out.push(`신호 ${parts.join(', ')}`);
  }
  return out;
}

const bySymbol = (a: { symbol: string }, b: { symbol: string }) =>
  a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;

/** Trading days from `entryDate` to the decision day: completed bars after the entry, plus today. */
export function heldTradingDays(completed: DailyBar[], entryDate: string): number {
  let after = 0;
  for (let i = completed.length - 1; i >= 0 && completed[i].date > entryDate; i--) after++;
  return after + 1;
}

export function runPaperDay(input: PaperDayInput): PaperDayResult {
  const { algorithm, date } = input;
  const market = algorithm.market;
  const ledger: PaperLedger = structuredClone(input.ledger);
  if (ledger.market !== market) throw new Error('paper: ledger and algorithm markets differ');
  const slipBps = input.slippageBps ?? 0;
  if (!Number.isFinite(slipBps) || slipBps < 0 || slipBps >= 10_000)
    throw new Error('paper: slippageBps must be within [0, 10000)');
  const slip = slipBps / 10_000;
  const costs = resolveCosts(market, input.costs);
  const sg: Safeguards = { ...defaultSafeguards(market), ...input.safeguards };
  if (!(sg.lossStopFraction > 0 && sg.lossStopFraction <= 1))
    throw new Error('paper: lossStopFraction must be within (0, 1]');
  const minSamples = input.minSamples ?? defaultMinSamples;
  const roundTripCost = roundTripCostRate(costs);
  const budget = ledger.budget;
  const isDual = algorithm.template === 'dualMomentum';
  const external = input.externalDecisions;
  const targets = new Set(algorithm.symbols);
  const fills: PaperFill[] = [];
  const decisionRecords: PaperDecisionRecord[] = [];
  const rejections: Partial<Record<OrderRejection, number>> = {};
  const heldBack = { insufficientHistory: 0, expectedBelowCost: 0 };
  const reject = (reason: OrderRejection) => {
    rejections[reason] = (rejections[reason] ?? 0) + 1;
  };
  let newlyStopped = false;

  // Annual capital-gains tax of finished years accrues when a new calendar year starts.
  const year = date.slice(0, 4);
  for (const [gainYear, gain] of Object.entries(ledger.yearGain)) {
    if (gainYear < year && !ledger.taxedYears.includes(gainYear)) {
      ledger.accruedTax += capitalGainsTaxForYear(gain, costs.capitalGainsTax);
      ledger.taxedYears.push(gainYear);
    }
  }

  const quotes = [...input.quotes].sort(bySymbol);
  const quoteOf = new Map(quotes.map((q) => [q.symbol, q]));
  const lastClose = (q: PaperQuote | undefined) => q?.completed[q.completed.length - 1]?.close;
  const markOf = (symbol: string, entryPrice: number, markPrice: number) => {
    const q = quoteOf.get(symbol);
    return q?.price ?? lastClose(q) ?? markPrice ?? entryPrice;
  };

  // 4. Cumulative-loss stop, evaluated before any order using today's marks.
  if (ledger.status === 'running') {
    let mv = 0;
    for (const p of Object.values(ledger.positions))
      mv += p.quantity * markOf(p.symbol, p.entryPrice, p.markPrice);
    if (ledger.cash + mv - ledger.accruedTax - budget <= -sg.lossStopFraction * budget) {
      ledger.status = 'stopped';
      ledger.stoppedOn = date;
      ledger.stoppedReason = 'loss-limit';
      newlyStopped = true;
    }
  }

  // Decisions for every symbol with a fresh quote: targets, plus held symbols that left the list.
  const decisions = new Map<
    string,
    { action: 'buy' | 'sell' | 'hold'; score: number | null; reason: string }
  >();
  const traded = quotes.filter(
    (q) => q.price !== null && (targets.has(q.symbol) || ledger.positions[q.symbol]),
  );
  const expectedOverride = new Map<string, number | null>();
  const reasonsOf = new Map<string, string[]>();
  if (external) {
    for (const q of traded) {
      const e = external[q.symbol];
      const action = !targets.has(q.symbol) ? 'sell' : (e?.action ?? 'hold');
      decisions.set(q.symbol, {
        action,
        score: null,
        reason: !targets.has(q.symbol)
          ? 'target-removed'
          : e
            ? `ai-${action}`
            : 'insufficient-data',
      });
      expectedOverride.set(q.symbol, e?.expectedReturn ?? null);
      reasonsOf.set(
        q.symbol,
        !targets.has(q.symbol)
          ? [reasonText['target-removed']]
          : e
            ? e.reasons
            : [reasonText['insufficient-data']],
      );
    }
  } else if (isDual) {
    const returns: Record<string, number | null> = {};
    for (const q of traded)
      if (targets.has(q.symbol))
        returns[q.symbol] = momentumReturn(
          q.completed,
          q.price as number,
          algorithm.dualMomentum!.lookbackDays,
        );
    const d = decideDualMomentum(returns, algorithm.dualMomentum!);
    for (const q of traded) {
      if (!targets.has(q.symbol)) {
        decisions.set(q.symbol, { action: 'sell', score: null, reason: 'target-removed' });
        reasonsOf.set(q.symbol, [reasonText['target-removed']]);
      } else {
        decisions.set(q.symbol, d[q.symbol]);
        reasonsOf.set(q.symbol, reasonsFor(d[q.symbol]));
      }
    }
  } else {
    const formula = {
      signals: input.usedSignals,
      buyThreshold: algorithm.buyThreshold,
      sellThreshold: algorithm.sellThreshold,
    };
    const ids = input.usedSignals.map((s) => s.id) as SignalId[];
    for (const q of traded) {
      if (!targets.has(q.symbol)) {
        decisions.set(q.symbol, { action: 'sell', score: null, reason: 'target-removed' });
        reasonsOf.set(q.symbol, [reasonText['target-removed']]);
        continue;
      }
      const scores = computeSignalScores(
        {
          bars: q.completed,
          price: q.price as number,
          decisionDate: date,
          values: q.values,
          external: q.external,
        },
        ids,
        algorithm.params,
      );
      const d = decideFormula(formula, scores);
      decisions.set(q.symbol, d);
      reasonsOf.set(q.symbol, reasonsFor(d));
    }
  }

  // Signal-level shadow round trips feed the expected-profit buckets (applied after today's orders).
  const pending: ProfitSample[] = [];
  if (!external) {
    for (const q of traded) {
      const d = decisions.get(q.symbol)!;
      const sh = ledger.shadows[q.symbol];
      const price = q.price as number;
      if (!sh && d.action === 'buy' && d.score !== null) {
        ledger.shadows[q.symbol] = {
          entryDate: date,
          entryPrice: price * (1 + slip),
          score: d.score,
        };
      } else if (
        sh &&
        d.action === 'sell' &&
        heldTradingDays(q.completed, sh.entryDate) >= sg.minHoldingTradingDays
      ) {
        pending.push({
          score: sh.score,
          grossReturn: (price * (1 - slip)) / sh.entryPrice - 1,
          openedOn: sh.entryDate,
          closedOn: date,
        });
        delete ledger.shadows[q.symbol];
      }
    }
  }

  const block = new Map<string, OrderRejection>();
  let ordersToday = 0;
  let seq = 0;
  if (ledger.status === 'running') {
    // Sells first (frees cash).
    for (const q of traded) {
      const d = decisions.get(q.symbol)!;
      const pos = ledger.positions[q.symbol];
      // A started exit (`liquidating`) continues on later days until the position is closed.
      if (!pos || (d.action !== 'sell' && !pos.liquidating)) continue;
      const price = (q.price as number) * (1 - slip);
      const trancheMax =
        sg.maxOrderValue === null ? Infinity : maxQuantityBelowValue(price, sg.maxOrderValue);
      const held = heldTradingDays(q.completed, pos.entryDate);
      while (pos.quantity > 0) {
        const res = checkOrder({
          side: 'sell',
          quantity: Math.min(pos.quantity, trancheMax),
          price,
          ordersToday,
          stopped: false,
          ownQuantity: pos.quantity,
          heldTradingDays: held,
          avgTradedValue: null,
          expectedProfit: { enforce: false, expected: null, roundTripCost },
          safeguards: sg,
        });
        if (!res.ok) {
          const reason = trancheMax < 1 ? 'order-too-large' : res.reason;
          reject(reason);
          block.set(q.symbol, reason);
          break;
        }
        pos.liquidating = true;
        const notional = res.quantity * price;
        const commission = notional * costs.commissionRate;
        const tax = notional * costs.sellTaxRate;
        ledger.cash += notional - commission - tax;
        ledger.totals.commission += commission;
        ledger.totals.transactionTax += tax;
        const entryCommission = pos.entryCommissionLeft * (res.quantity / pos.quantity);
        pos.entryCommissionLeft -= entryCommission;
        const netPnl =
          notional - commission - tax - (res.quantity * pos.entryPrice + entryCommission);
        ledger.yearGain[year] = (ledger.yearGain[year] ?? 0) + netPnl;
        ledger.totals.realizedNet += netPnl;
        pos.soldQuantity += res.quantity;
        pos.soldNotional += notional;
        pos.realizedNet += netPnl;
        pos.quantity -= res.quantity;
        const slippage = res.quantity * (q.price as number) * slip;
        ledger.totals.slippage += slippage;
        fills.push({
          seq: ++seq,
          symbol: q.symbol,
          side: 'sell',
          quantity: res.quantity,
          price,
          referencePrice: q.price as number,
          notional,
          commission,
          tax,
          slippage,
          score: d.score,
          reasons: reasonsOf.get(q.symbol) ?? [],
        });
        ordersToday++;
        if (pos.quantity === 0) {
          ledger.totals.roundTrips++;
          if (pos.realizedNet > 0) ledger.totals.wins++;
          delete ledger.positions[q.symbol];
        }
      }
    }

    const buys = traded
      .filter((q) => {
        const d = decisions.get(q.symbol)!;
        return (
          targets.has(q.symbol) &&
          d.action === 'buy' &&
          (external ? true : d.score !== null) &&
          !ledger.positions[q.symbol]
        );
      })
      .sort(
        (a, b) =>
          (decisions.get(b.symbol)!.score ?? 0) - (decisions.get(a.symbol)!.score ?? 0) ||
          (a.symbol < b.symbol ? -1 : 1),
      );
    const positionBudget =
      budget *
      (algorithm.positionFraction ??
        (isDual ? 1 / (algorithm.dualMomentum?.topN ?? 1) : 1 / algorithm.symbols.length));
    for (const q of buys) {
      const d = decisions.get(q.symbol)!;
      const price = (q.price as number) * (1 + slip);
      const quantity = Math.floor(
        Math.min(positionBudget, ledger.cash) / (price * (1 + costs.commissionRate)),
      );
      if (quantity < 1) {
        reject('insufficient-budget');
        block.set(q.symbol, 'insufficient-budget');
        continue;
      }
      const window = q.completed.slice(-sg.liquidityWindow);
      const avgTradedValue =
        window.length < sg.liquidityWindow
          ? null
          : window.reduce((a, b) => a + b.close * b.volume, 0) / window.length;
      const expected = external
        ? (expectedOverride.get(q.symbol) ?? null)
        : expectedProfit(input.stats, d.score as number, minSamples);
      const res = checkOrder({
        side: 'buy',
        quantity,
        price,
        ordersToday,
        stopped: false,
        ownQuantity: 0,
        heldTradingDays: null,
        avgTradedValue,
        expectedProfit: { enforce: true, expected, roundTripCost },
        safeguards: sg,
      });
      if (!res.ok) {
        reject(res.reason);
        block.set(q.symbol, res.reason);
        if (res.reason === 'insufficient-history') heldBack.insufficientHistory++;
        if (res.reason === 'expected-profit-below-cost') heldBack.expectedBelowCost++;
        continue;
      }
      const notional = res.quantity * price;
      const commission = notional * costs.commissionRate;
      ledger.cash -= notional + commission;
      ledger.totals.commission += commission;
      const slippage = res.quantity * (q.price as number) * slip;
      ledger.totals.slippage += slippage;
      ledger.positions[q.symbol] = {
        symbol: q.symbol,
        quantity: res.quantity,
        entryDate: date,
        entryPrice: price,
        entryCommissionLeft: commission,
        liquidating: false,
        soldQuantity: 0,
        soldNotional: 0,
        realizedNet: 0,
        markPrice: q.price as number,
      };
      fills.push({
        seq: ++seq,
        symbol: q.symbol,
        side: 'buy',
        quantity: res.quantity,
        price,
        referencePrice: q.price as number,
        notional,
        commission,
        tax: 0,
        slippage,
        score: d.score,
        reasons: reasonsOf.get(q.symbol) ?? [],
      });
      ordersToday++;
    }
  }
  ledger.totals.fills += fills.length;

  for (const q of traded) {
    const d = decisions.get(q.symbol)!;
    decisionRecords.push({
      symbol: q.symbol,
      action: d.action,
      score: d.score,
      reason: d.reason,
      ...(block.has(q.symbol) ? { blockedBy: block.get(q.symbol) } : {}),
    });
  }

  // Marks, equity point (marked at the decision quote), new shadow samples.
  for (const p of Object.values(ledger.positions))
    p.markPrice = markOf(p.symbol, p.entryPrice, p.markPrice);
  let positionValue = 0;
  for (const p of Object.values(ledger.positions)) positionValue += p.quantity * p.markPrice;
  const point: PaperEquityPoint = {
    date,
    equity: ledger.cash + positionValue - ledger.accruedTax,
    cash: ledger.cash,
    positionValue,
  };
  const lastPoint = ledger.equityCurve[ledger.equityCurve.length - 1];
  if (lastPoint && lastPoint.date === date)
    ledger.equityCurve[ledger.equityCurve.length - 1] = point;
  else ledger.equityCurve.push(point);
  if (ledger.equityCurve.length > maxPaperEquityPoints)
    ledger.equityCurve = ledger.equityCurve.slice(-maxPaperEquityPoints);
  ledger.samples.push(...pending);
  if (ledger.samples.length > maxPaperSamples)
    ledger.samples = ledger.samples.slice(-maxPaperSamples);
  ledger.lastRunDate = date;
  ledger.lastRunId = input.runId;
  ledger.updatedAt = input.now;
  return { ledger, fills, decisions: decisionRecords, rejections, heldBack, newlyStopped };
}

export type PaperMetrics = {
  /** First and last equity point dates. */
  since: string;
  days: number;
  equity: number;
  /** Return before explicit costs (slippage is already inside the fill prices). */
  totalReturn: number;
  /** Return after commission, transaction tax and capital-gains tax. */
  netReturn: number;
  costs: {
    commission: number;
    transactionTax: number;
    capitalGainsTax: number;
    total: number;
    /** Informational; already inside the fill prices, not part of `total`. */
    slippage: number;
  };
  maxDrawdown: number;
  volatility: number | null;
  fills: number;
  roundTrips: number;
  winRate: number | null;
  realizedPnl: number;
  unrealizedPnl: number;
};

/** Result metrics since the paper start, computed like the backtester's. */
export function paperMetrics(ledger: PaperLedger): PaperMetrics {
  const equities = [ledger.budget, ...ledger.equityCurve.map((p) => p.equity)];
  const equity = equities[equities.length - 1];
  const costsTotal = ledger.totals.commission + ledger.totals.transactionTax + ledger.accruedTax;
  let unrealized = 0;
  for (const p of Object.values(ledger.positions))
    unrealized += p.quantity * (p.markPrice - p.entryPrice);
  return {
    since: ledger.startedOn,
    days: ledger.equityCurve.length,
    equity,
    totalReturn: (equity + costsTotal) / ledger.budget - 1,
    netReturn: equity / ledger.budget - 1,
    costs: {
      commission: ledger.totals.commission,
      transactionTax: ledger.totals.transactionTax,
      capitalGainsTax: ledger.accruedTax,
      total: costsTotal,
      slippage: ledger.totals.slippage,
    },
    maxDrawdown: maxDrawdown(equities),
    volatility: annualizedVolatility(equities),
    fills: ledger.totals.fills,
    roundTrips: ledger.totals.roundTrips,
    winRate: ledger.totals.roundTrips === 0 ? null : ledger.totals.wins / ledger.totals.roundTrips,
    realizedPnl: ledger.totals.realizedNet,
    unrealizedPnl: unrealized,
  };
}
