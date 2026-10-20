import { describe, expect, it } from 'vitest';
import {
  buildBucketStats,
  createAlgorithm,
  createPaperLedger,
  heldTradingDays,
  paperMetrics,
  runBacktest,
  runPaperDay,
  supplyScore,
  type AlgorithmDefinition,
  type DailyBar,
  type PaperDayInput,
  type PaperLedger,
  type PaperQuote,
} from '../src/lib/algo';

const dayFrom = (start: string, i: number) =>
  new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
function makeBars(opens: number[], start = '2026-03-01', volume = 1e9): DailyBar[] {
  return opens.map((o, i) => ({
    date: dayFrom(start, i),
    open: o,
    high: o,
    low: o,
    close: o,
    volume,
  }));
}
/** Deterministic +-9% gap walk. */
function walk(seed: number, n: number, start = 100): number[] {
  let x = seed;
  const out = [start];
  for (let i = 1; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const r = x / 2147483648;
    out.push(Math.max(10, out[i - 1] * (1 + (r - 0.5) * 0.18)));
  }
  return out;
}
function gapAlgorithm(symbols: string[], market: 'KR' | 'US' = 'KR'): AlgorithmDefinition {
  return createAlgorithm(
    'custom',
    { name: 'gap', market, symbols, budget: 10_000 },
    {
      signals: [{ id: 'momentum', weight: 1 }],
      buyThreshold: 0.4,
      sellThreshold: -0.4,
      params: { momentum: { lookbackDays: 1, scale: 0.1 } },
    },
  );
}
const loose = { liquidityWindow: 1, liquidityMinAvgValue: 0 };

function paperInput(
  ledger: PaperLedger,
  algorithm: AlgorithmDefinition,
  date: string,
  quotes: PaperQuote[],
  over: Partial<PaperDayInput> = {},
): PaperDayInput {
  return {
    ledger,
    algorithm,
    usedSignals: algorithm.signals,
    date,
    runId: `${algorithm.market}_${date}`,
    now: `${date}T00:05:00.000Z`,
    quotes,
    safeguards: loose,
    stats: buildBucketStats(ledger.samples, { asOf: date }),
    minSamples: 1,
    ...over,
  };
}

describe('paper day matches the backtest day by day', () => {
  const algorithm = gapAlgorithm(['AAA', 'BBB', 'CCC']);
  const bars = {
    AAA: makeBars(walk(7, 140)),
    BBB: makeBars(walk(11, 140, 80)),
    CCC: makeBars(walk(13, 140, 120)),
  };
  const costs = { commissionRate: 0.001, sellTaxRate: 0.002 };
  const slippageBps = 10;
  const backtest = runBacktest({
    algorithm,
    bars,
    options: {
      costs,
      slippageBps,
      safeguards: loose,
      expectedProfit: { mode: 'walk-forward', minSamples: 1 },
    },
  });

  function replay() {
    let ledger = createPaperLedger({
      algorithmId: 'a',
      market: 'KR',
      budget: algorithm.budget,
      startedOn: '2026-03-02',
      now: '2026-03-02T00:00:00.000Z',
    });
    const trades: {
      date: string;
      symbol: string;
      side: string;
      quantity: number;
      price: number;
    }[] = [];
    const rejections: Record<string, number> = {};
    for (let i = 1; i < 140; i++) {
      const date = dayFrom('2026-03-01', i);
      const quotes = Object.entries(bars).map(([symbol, series]) => ({
        symbol,
        price: series[i].open,
        completed: series.slice(0, i),
      }));
      const result = runPaperDay(
        paperInput(ledger, algorithm, date, quotes, { costs, slippageBps }),
      );
      for (const f of result.fills)
        trades.push({
          date,
          symbol: f.symbol,
          side: f.side,
          quantity: f.quantity,
          price: f.price,
        });
      for (const [k, v] of Object.entries(result.rejections))
        rejections[k] = (rejections[k] ?? 0) + (v ?? 0);
      ledger = result.ledger;
    }
    return { ledger, trades, rejections };
  }

  it('produces the same trades, quantities and prices as runBacktest', () => {
    const paper = replay();
    expect(backtest.trades.length).toBeGreaterThan(6);
    expect(paper.trades).toEqual(
      backtest.trades.map((t) => ({
        date: t.date,
        symbol: t.symbol,
        side: t.side,
        quantity: t.quantity,
        price: t.price,
      })),
    );
  });

  it('has the same cash, costs, round trips, shadow samples and rejections', () => {
    const paper = replay();
    const [lastTrade] = backtest.trades.slice(-1);
    expect(lastTrade).toBeDefined();
    expect(paper.ledger.totals.commission).toBeCloseTo(backtest.costs.commission, 8);
    expect(paper.ledger.totals.transactionTax).toBeCloseTo(backtest.costs.transactionTax, 8);
    expect(paper.ledger.totals.roundTrips).toBe(backtest.roundTrips.length);
    expect(paper.ledger.samples).toEqual(backtest.samples);
    expect(paper.rejections).toEqual(backtest.rejections);
    const positions = Object.values(paper.ledger.positions).map((p) => [p.symbol, p.quantity]);
    expect(positions).toEqual(backtest.openPositions.map((p) => [p.symbol, p.quantity]));
  });
});

describe('safeguards inside the paper day', () => {
  const algorithm = gapAlgorithm(['AAA']);
  const ledger0 = createPaperLedger({
    algorithmId: 'a',
    market: 'KR',
    budget: 10_000,
    startedOn: '2026-03-02',
    now: '2026-03-02T00:00:00.000Z',
  });
  // Yesterday's close 100, today's quote 110: +10% gap, score 1 -> buy.
  const completed = makeBars([100, 100, 100]);
  const buyQuote = (price = 110): PaperQuote => ({ symbol: 'AAA', price, completed });

  it('holds back a buy while the expected-profit statistics are insufficient', () => {
    const r = runPaperDay(
      paperInput(ledger0, algorithm, '2026-03-04', [buyQuote()], { minSamples: 20 }),
    );
    expect(r.fills).toHaveLength(0);
    expect(r.heldBack.insufficientHistory).toBe(1);
    expect(r.decisions[0]).toMatchObject({ action: 'buy', blockedBy: 'insufficient-history' });
  });

  it('holds back a buy whose expected profit does not exceed the round-trip cost', () => {
    const stats = buildBucketStats(
      [{ score: 1, grossReturn: 0.001, openedOn: '2026-01-01', closedOn: '2026-01-10' }],
      { asOf: '2026-03-04' },
    );
    const r = runPaperDay(
      paperInput(ledger0, algorithm, '2026-03-04', [buyQuote()], {
        stats,
        costs: { commissionRate: 0.001, sellTaxRate: 0.002 },
      }),
    );
    expect(r.fills).toHaveLength(0);
    expect(r.heldBack.expectedBelowCost).toBe(1);
  });

  it('buys when the bucket mean beats the cost, with costs, slippage and reasons recorded', () => {
    const stats = buildBucketStats(
      [{ score: 1, grossReturn: 0.05, openedOn: '2026-01-01', closedOn: '2026-01-10' }],
      { asOf: '2026-03-04' },
    );
    const r = runPaperDay(
      paperInput(ledger0, algorithm, '2026-03-04', [buyQuote()], {
        stats,
        costs: { commissionRate: 0.001 },
        slippageBps: 100,
      }),
    );
    expect(r.fills).toHaveLength(1);
    const [fill] = r.fills;
    expect(fill).toMatchObject({ side: 'buy', symbol: 'AAA', referencePrice: 110, seq: 1 });
    expect(fill.price).toBeCloseTo(111.1, 8);
    expect(fill.commission).toBeCloseTo(fill.notional * 0.001, 8);
    expect(fill.slippage).toBeCloseTo(fill.quantity * 1.1, 8);
    expect(fill.reasons.join(' ')).toContain('매수 기준');
    expect(r.ledger.cash).toBeCloseTo(10_000 - fill.notional - fill.commission, 8);
    expect(r.ledger.lastRunId).toBe('KR_2026-03-04');
  });

  it('does not sell inside the minimum holding period, and sells afterwards', () => {
    const stats = buildBucketStats(
      [{ score: 1, grossReturn: 0.05, openedOn: '2026-01-01', closedOn: '2026-01-10' }],
      { asOf: '2026-03-04' },
    );
    let ledger = runPaperDay(
      paperInput(ledger0, algorithm, '2026-03-04', [buyQuote()], { stats }),
    ).ledger;
    const bars = makeBars([100, 100, 100, 110, 110, 110, 110, 110, 110]);
    const sellDay = (i: number) => {
      const day = bars[i].date;
      const completedBars = bars.slice(0, i);
      return runPaperDay(
        paperInput(
          ledger,
          algorithm,
          day,
          [{ symbol: 'AAA', price: completedBars[i - 1].close * 0.9, completed: completedBars }],
          { stats },
        ),
      );
    };
    // The position opened on 2026-03-04 (bar index 3); held 2 trading days on index 5.
    expect(heldTradingDays(bars.slice(0, 5), '2026-03-04')).toBe(2);
    const early = sellDay(5);
    expect(early.fills).toHaveLength(0);
    expect(early.decisions[0].blockedBy).toBe('min-holding-period');
    // Day with index 8: 5 trading days since the entry.
    ledger = early.ledger;
    const late = sellDay(8);
    expect(late.fills).toHaveLength(1);
    expect(late.fills[0]).toMatchObject({ side: 'sell', quantity: expect.any(Number) });
    expect(late.ledger.positions.AAA).toBeUndefined();
    expect(late.ledger.totals.roundTrips).toBe(1);
  });

  it('caps order value below 1e8 and sells the rest in tranches over several days', () => {
    const big = createPaperLedger({
      algorithmId: 'a',
      market: 'KR',
      budget: 3.2e8,
      startedOn: '2026-03-02',
      now: '2026-03-02T00:00:00.000Z',
    });
    big.cash = 0;
    big.positions.AAA = {
      symbol: 'AAA',
      quantity: 4000,
      entryDate: '2026-02-01',
      entryPrice: 100_000,
      entryCommissionLeft: 0,
      liquidating: false,
      soldQuantity: 0,
      soldNotional: 0,
      realizedNet: 0,
      markPrice: 100_000,
    };
    const history = makeBars(Array(30).fill(100_000), '2026-02-01', 1e9);
    const date = '2026-03-04';
    const day1 = runPaperDay(
      paperInput(big, algorithm, date, [{ symbol: 'AAA', price: 80_000, completed: history }], {
        safeguards: { ...loose, maxOrdersPerDay: 3 },
      }),
    );
    // Each tranche stays strictly below 1e8: 80,000 * 1,249 = 99.92M.
    expect(day1.fills).toHaveLength(3);
    for (const f of day1.fills) expect(f.notional).toBeLessThan(1e8);
    expect(day1.rejections['max-orders-per-day']).toBe(1);
    expect(day1.ledger.positions.AAA.liquidating).toBe(true);
    // The exit continues on the next day even without a fresh sell signal.
    const day2 = runPaperDay(
      paperInput(
        day1.ledger,
        algorithm,
        '2026-03-05',
        [{ symbol: 'AAA', price: 80_000, completed: history }],
        { safeguards: { ...loose, maxOrdersPerDay: 3 } },
      ),
    );
    expect(day2.fills.length).toBeGreaterThan(0);
    expect(day2.fills.every((f) => f.side === 'sell')).toBe(true);
  });

  it('stops at the -20% cumulative loss and simulates no order afterwards', () => {
    const ledger = createPaperLedger({
      algorithmId: 'a',
      market: 'KR',
      budget: 10_000,
      startedOn: '2026-03-02',
      now: '2026-03-02T00:00:00.000Z',
    });
    ledger.cash = 0;
    ledger.positions.AAA = {
      symbol: 'AAA',
      quantity: 100,
      entryDate: '2026-03-01',
      entryPrice: 100,
      entryCommissionLeft: 0,
      liquidating: false,
      soldQuantity: 0,
      soldNotional: 0,
      realizedNet: 0,
      markPrice: 100,
    };
    // 100 shares at 79: value 7,900 = -21% of the 10,000 budget.
    const r = runPaperDay(
      paperInput(ledger, algorithm, '2026-03-10', [
        { symbol: 'AAA', price: 79, completed: makeBars([100, 100, 100, 100, 100, 100, 100, 100]) },
      ]),
    );
    expect(r.newlyStopped).toBe(true);
    expect(r.ledger).toMatchObject({ status: 'stopped', stoppedOn: '2026-03-10' });
    expect(r.ledger.stoppedReason).toBe('loss-limit');
    expect(r.fills).toHaveLength(0);
    // A later day on a stopped ledger is not a new stop and still places nothing.
    const later = runPaperDay(
      paperInput(r.ledger, algorithm, '2026-03-11', [
        { symbol: 'AAA', price: 60, completed: makeBars([100, 100, 100, 100, 100, 100, 100, 100]) },
      ]),
    );
    expect(later.newlyStopped).toBe(false);
    expect(later.fills).toHaveLength(0);
  });

  it('only sells held symbols that left the target list (never buys them)', () => {
    const ledger = createPaperLedger({
      algorithmId: 'a',
      market: 'KR',
      budget: 1_000,
      startedOn: '2026-03-02',
      now: '2026-03-02T00:00:00.000Z',
    });
    ledger.cash = 0;
    ledger.positions.OLD = {
      symbol: 'OLD',
      quantity: 10,
      entryDate: '2026-02-01',
      entryPrice: 100,
      entryCommissionLeft: 0,
      liquidating: false,
      soldQuantity: 0,
      soldNotional: 0,
      realizedNet: 0,
      markPrice: 100,
    };
    const history = makeBars(Array(30).fill(100), '2026-02-01');
    const r = runPaperDay(
      paperInput(ledger, algorithm, '2026-03-10', [
        { symbol: 'OLD', price: 130, completed: history },
        { symbol: 'AAA', price: 100, completed: history },
      ]),
    );
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]).toMatchObject({ symbol: 'OLD', side: 'sell' });
    expect(r.fills[0].reasons[0]).toContain('대상 종목에서 제외');
  });

  it('records the equity curve and metrics since the start', () => {
    const stats = buildBucketStats(
      [{ score: 1, grossReturn: 0.05, openedOn: '2026-01-01', closedOn: '2026-01-10' }],
      { asOf: '2026-03-04' },
    );
    const r = runPaperDay(
      paperInput(ledger0, algorithm, '2026-03-04', [buyQuote()], {
        stats,
        costs: { commissionRate: 0.001 },
      }),
    );
    const m = paperMetrics(r.ledger);
    expect(m.since).toBe('2026-03-02');
    expect(m.days).toBe(1);
    expect(m.costs.commission).toBeGreaterThan(0);
    expect(m.netReturn).toBeLessThan(0);
    expect(m.totalReturn).toBeCloseTo(0, 8);
    expect(m.roundTrips).toBe(0);
    expect(m.winRate).toBeNull();
    // Re-running the same date replaces the point instead of appending.
    const again = runPaperDay(paperInput(r.ledger, algorithm, '2026-03-04', [buyQuote()]));
    expect(again.ledger.equityCurve).toHaveLength(1);
  });

  it('uses supplied AI decisions and their expected return instead of bucket statistics', () => {
    const buy = (expectedReturn: number | null) =>
      runPaperDay(
        paperInput(ledger0, algorithm, '2026-03-04', [buyQuote()], {
          externalDecisions: {
            AAA: { action: 'buy', reasons: ['근거 하나'], expectedReturn },
          },
          costs: { commissionRate: 0.001, sellTaxRate: 0.002 },
        }),
      );
    expect(buy(0.02).fills).toHaveLength(1);
    expect(buy(0.02).fills[0].reasons).toEqual(['근거 하나']);
    expect(buy(0.002).fills).toHaveLength(0);
    expect(buy(null).fills).toHaveLength(0);
    expect(buy(null).decisions[0].blockedBy).toBe('insufficient-history');
  });

  it('accrues the US capital-gains tax of a finished year when a new year starts', () => {
    const us = gapAlgorithm(['AAA'], 'US');
    const ledger = createPaperLedger({
      algorithmId: 'a',
      market: 'US',
      budget: 10_000,
      startedOn: '2026-03-02',
      now: '2026-03-02T00:00:00.000Z',
    });
    ledger.yearGain['2026'] = 5_000;
    const r = runPaperDay(
      paperInput(ledger, us, '2027-01-04', [], {
        costs: { capitalGainsTax: { rate: 0.22, annualDeduction: 1_000 } },
      }),
    );
    expect(r.ledger.accruedTax).toBeCloseTo((5_000 - 1_000) * 0.22, 8);
    expect(r.ledger.taxedYears).toEqual(['2026']);
    const again = runPaperDay(
      paperInput(r.ledger, us, '2027-01-05', [], {
        costs: { capitalGainsTax: { rate: 0.22, annualDeduction: 1_000 } },
      }),
    );
    expect(again.ledger.accruedTax).toBeCloseTo((5_000 - 1_000) * 0.22, 8);
  });
});

describe('supplyScore', () => {
  const bars = makeBars([100, 100, 100, 100, 100, 100], '2026-03-01', 1_000);
  const flows = (net: number, dates = bars.slice(-5).map((b) => b.date)) =>
    dates.map((date) => ({ date, foreignerNet: net, institutionNet: net }));
  it('maps net buying relative to volume onto [-1, 1]', () => {
    expect(supplyScore(flows(50), bars)).toBe(1); // 100 / 1000 = 10% of volume, scale 5%
    expect(supplyScore(flows(-50), bars)).toBe(-1);
    expect(supplyScore(flows(10), bars)).toBeCloseTo(0.4, 8);
    expect(supplyScore(flows(0), bars)).toBe(0);
  });
  it('needs at least three of the last five days, else null', () => {
    expect(
      supplyScore(
        flows(
          50,
          bars.slice(-2).map((b) => b.date),
        ),
        bars,
      ),
    ).toBeNull();
    expect(
      supplyScore(
        flows(
          50,
          bars.slice(-3).map((b) => b.date),
        ),
        bars,
      ),
    ).toBe(1);
    expect(supplyScore([], bars)).toBeNull();
  });
});
