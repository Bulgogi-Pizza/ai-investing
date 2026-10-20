import { describe, expect, it } from 'vitest';
import {
  buildBucketStats,
  createAlgorithm,
  expectedProfit,
  runBacktest,
  type AlgorithmDefinition,
  type BacktestOptions,
  type DailyBar,
} from '../src/lib/algo';

const dayFrom = (start: string, i: number) =>
  new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);

/** Bars whose close equals the open unless `closes` is given; huge volume so liquidity never binds. */
function makeBars(
  opens: number[],
  start = '2026-03-01',
  volume = 1e9,
  closes?: number[],
): DailyBar[] {
  return opens.map((o, i) => {
    const c = closes?.[i] ?? o;
    return {
      date: dayFrom(start, i),
      open: o,
      high: Math.max(o, c),
      low: Math.min(o, c),
      close: c,
      volume,
    };
  });
}

/**
 * One-day gap momentum: score = (open_t / close_{t-1} - 1) / scale. With scale 0.1 a +5% gap buys
 * (score .5) and a -5% gap sells. Easy to drive by hand.
 */
function gapAlgorithm(
  symbols: string[],
  over: { scale?: number; buy?: number; sell?: number; market?: 'KR' | 'US'; budget?: number } = {},
): AlgorithmDefinition {
  return createAlgorithm(
    'custom',
    { name: 'gap', market: over.market ?? 'KR', symbols, budget: over.budget ?? 10_000 },
    {
      signals: [{ id: 'momentum', weight: 1 }],
      buyThreshold: over.buy ?? 0.5,
      sellThreshold: over.sell ?? -0.5,
      params: { momentum: { lookbackDays: 1, scale: over.scale ?? 0.1 } },
    },
  );
}

const loose: BacktestOptions = {
  safeguards: { liquidityWindow: 1, liquidityMinAvgValue: 0 },
  expectedProfit: { mode: 'ignore' },
};

describe('hand-checked round trip with costs', () => {
  // i0 100, i1 100 (hold), i2 110 (+10%: buy), i3..i7 110, i8 100 (-9.1%: sell), i9 100.
  const opens = [100, 100, 110, 110, 110, 110, 110, 110, 100, 100];
  const result = runBacktest({
    algorithm: gapAlgorithm(['AAA']),
    bars: { AAA: makeBars(opens) },
    options: {
      ...loose,
      costs: { commissionRate: 0.001, sellTaxRate: 0.002 },
    },
  });

  it('fills at the decision day open with integer shares and charges commission and tax', () => {
    expect(result.trades).toHaveLength(2);
    const [buy, sell] = result.trades;
    expect(buy).toMatchObject({ date: '2026-03-03', side: 'buy', quantity: 90, price: 110 });
    expect(buy.commission).toBeCloseTo(9.9, 10); // floor(10000 / (110 * 1.001)) = 90
    expect(sell).toMatchObject({ date: '2026-03-09', side: 'sell', quantity: 90, price: 100 });
    expect(sell.commission).toBeCloseTo(9, 10);
    expect(sell.tax).toBeCloseTo(18, 10);
  });
  it('computes cash, equity and returns exactly', () => {
    // cash: 10000 - 9900 - 9.9 + 9000 - 9 - 18 = 9063.1
    expect(result.metrics.finalEquity).toBeCloseTo(9063.1, 8);
    expect(result.metrics.netReturn).toBeCloseTo(-0.09369, 8);
    expect(result.costs.commission).toBeCloseTo(18.9, 10);
    expect(result.costs.transactionTax).toBeCloseTo(18, 10);
    expect(result.costs.capitalGainsTax).toBe(0);
    expect(result.costs.total).toBeCloseTo(36.9, 10);
    // gross = net + costs: (9063.1 + 36.9) / 10000 - 1 = -0.09
    expect(result.metrics.totalReturn).toBeCloseTo(-0.09, 10);
  });
  it('records the round trip, win rate, exposure and drawdown', () => {
    expect(result.roundTrips).toHaveLength(1);
    expect(result.roundTrips[0].grossReturn).toBeCloseTo(100 / 110 - 1, 12);
    expect(result.roundTrips[0].netPnl).toBeCloseTo(9000 - 9 - 18 - (9900 + 9.9), 8);
    expect(result.roundTrips[0].heldTradingDays).toBe(6);
    expect(result.metrics).toMatchObject({ trades: 2, roundTrips: 1, winRate: 0 });
    expect(result.period).toEqual({ start: '2026-03-02', end: '2026-03-10', tradingDays: 9 });
    expect(result.metrics.daysInvested).toBeCloseTo(6 / 9, 12);
    // peak: day after the buy marks 90 * 110 + 90.1 = 9990.1; low is the final 9063.1
    expect(result.metrics.maxDrawdown).toBeCloseTo((10000 - 9063.1) / 10000, 8);
    expect(result.metrics.volatility).not.toBeNull();
    expect(result.openPositions).toEqual([]);
  });
  it('labels the result: excluded signals, cost setup, mode', () => {
    expect(result.excludedSignals).toEqual(['supply', 'news']);
    expect(result.expectedProfitMode).toBe('ignored-for-research');
    expect(result.researchOnly).toBe(true);
    expect(result.costSettings.needsSetup).toEqual([]);
    expect(result.currency).toBe('KRW');
  });
  it('applies adverse slippage on both fills', () => {
    const r = runBacktest({
      algorithm: gapAlgorithm(['AAA']),
      bars: { AAA: makeBars(opens) },
      options: { ...loose, slippageBps: 100 },
    });
    expect(r.trades[0].price).toBeCloseTo(110 * 1.01, 10);
    expect(r.trades[1].price).toBeCloseTo(100 * 0.99, 10);
    expect(r.trades[0].quantity).toBe(Math.floor(10_000 / (110 * 1.01)));
  });
  it('flags missing cost settings', () => {
    const r = runBacktest({
      algorithm: gapAlgorithm(['AAA']),
      bars: { AAA: makeBars(opens) },
      options: loose,
    });
    expect(r.costSettings.needsSetup).toEqual(['commissionRate', 'sellTaxRate']);
    expect(r.warnings.some((w) => w.startsWith('설정 필요'))).toBe(true);
  });
});

describe('capital-gains tax per calendar year', () => {
  // Year 1 round trip: buy 110, sell 122.2 (gain 909 * 12.2). Year 2 round trip: buy 130, sell 122.2 (loss).
  const opens = [
    100, 100, 110, 115, 120, 125, 130, 122.2, 122.2, 122.2, 122.2, 122.2, 122.2, 130, 130, 130, 130,
    130, 130, 122.2, 122.2, 122.2,
  ];
  const bars = makeBars(opens, '2026-12-20'); // i11 = Dec 31, i12 = Jan 1
  const result = runBacktest({
    algorithm: gapAlgorithm(['AAA'], {
      scale: 1,
      buy: 0.05,
      sell: -0.05,
      market: 'US',
      budget: 100_000,
    }),
    bars: { AAA: bars },
    options: {
      ...loose,
      costs: { commissionRate: 0, capitalGainsTax: { rate: 0.22, annualDeduction: 200 } },
    },
  });
  it('taxes net realized gains above the deduction in the year they were realized', () => {
    expect(result.roundTrips).toHaveLength(2);
    const gain1 = 909 * (122.2 - 110);
    const tax1 = (gain1 - 200) * 0.22;
    const [y1, y2] = result.costs.capitalGainsTaxByYear;
    expect(y1.year).toBe('2026');
    expect(y1.netRealizedGain).toBeCloseTo(gain1, 6);
    expect(y1.tax).toBeCloseTo(tax1, 6);
    // Year 2 realizes a loss: no tax and no carry-over credit.
    expect(y2.year).toBe('2027');
    expect(y2.netRealizedGain).toBeLessThan(0);
    expect(y2.tax).toBe(0);
    expect(result.costs.capitalGainsTax).toBeCloseTo(tax1, 6);
    expect(result.costs.total).toBeCloseTo(tax1, 6);
  });
  it('deducts the tax from equity on the last trading day of the year, not from trading cash', () => {
    const dec31 = result.equityCurve.find((p) => p.date === '2026-12-31')!;
    const dec30 = result.equityCurve.find((p) => p.date === '2026-12-30')!;
    const tax1 = (909 * 12.2 - 200) * 0.22;
    expect(dec30.equity - dec31.equity).toBeCloseTo(tax1, 6);
    expect(dec31.cash).toBeCloseTo(dec30.cash, 8);
  });
  it('is not charged when the year gain stays under the deduction', () => {
    const r = runBacktest({
      algorithm: gapAlgorithm(['AAA'], {
        scale: 1,
        buy: 0.05,
        sell: -0.05,
        market: 'US',
        budget: 100_000,
      }),
      bars: { AAA: bars },
      options: {
        ...loose,
        costs: { commissionRate: 0, capitalGainsTax: { rate: 0.22, annualDeduction: 50_000 } },
      },
    });
    expect(r.costs.capitalGainsTax).toBe(0);
  });
});

describe('safeguards in simulation', () => {
  it('does not sell before the minimum holding period, however strong the sell signal', () => {
    // buy i2 (k=1); sell signal at i4 (k=3, held 2) and again nothing later.
    const opens = [100, 100, 110, 110, 100, 100, 100, 100, 100];
    const r = runBacktest({
      algorithm: gapAlgorithm(['AAA']),
      bars: { AAA: makeBars(opens) },
      options: loose,
    });
    expect(r.trades.map((t) => t.side)).toEqual(['buy']);
    expect(r.rejections['min-holding-period']).toBe(1);
    expect(r.openPositions).toHaveLength(1);
    // A shorter holding rule lets the same signal through.
    const r2 = runBacktest({
      algorithm: gapAlgorithm(['AAA']),
      bars: { AAA: makeBars(opens) },
      options: { ...loose, safeguards: { ...loose.safeguards, minHoldingTradingDays: 2 } },
    });
    expect(r2.trades.map((t) => t.side)).toEqual(['buy', 'sell']);
  });

  it('sells on the first day the holding period is reached', () => {
    // buy at k=1; sell signals at k=5 (held 4: blocked) and k=6 (held 5: allowed). Prices fall twice.
    const opens = [100, 100, 110, 110, 110, 110, 110, 100, 90, 90];
    const r = runBacktest({
      algorithm: gapAlgorithm(['AAA']),
      bars: { AAA: makeBars(opens) },
      options: loose,
    });
    // i7 = 100 (-9%) is k=6 -> held 5 -> sells right there.
    expect(r.trades[1]).toMatchObject({ side: 'sell', date: '2026-03-08', price: 100 });
    expect(r.roundTrips[0].heldTradingDays).toBe(5);
  });

  it('limits orders per algorithm per day and keeps the strongest signals', () => {
    const flat = [100, 100, 100, 100];
    const spike = (pct: number) => [100, 100, 100 * (1 + pct), 100 * (1 + pct)];
    const bars = {
      A: makeBars(spike(0.1)),
      B: makeBars(spike(0.2)),
      C: makeBars(spike(0.3)),
      D: makeBars(spike(0.06)),
      E: makeBars(flat),
    };
    const r = runBacktest({
      algorithm: gapAlgorithm(['A', 'B', 'C', 'D', 'E'], {
        scale: 1,
        buy: 0.05,
        sell: -0.5,
        budget: 50_000,
      }),
      bars,
      options: loose,
    });
    expect(r.trades.map((t) => t.symbol)).toEqual(['C', 'B', 'A']);
    expect(r.rejections['max-orders-per-day']).toBe(1);
    // positions are sized at budget / number of symbols
    expect(r.trades[0].quantity).toBe(Math.floor(10_000 / 130));
    const r2 = runBacktest({
      algorithm: gapAlgorithm(['A', 'B', 'C', 'D', 'E'], {
        scale: 1,
        buy: 0.05,
        sell: -0.5,
        budget: 50_000,
      }),
      bars,
      options: { ...loose, safeguards: { ...loose.safeguards, maxOrdersPerDay: 4 } },
    });
    expect(r2.trades).toHaveLength(4);
  });

  it('stops the algorithm for the rest of the run when cumulative loss reaches -20% of budget', () => {
    // buy 90 sh at 110 (cost 9900); i3 opens at 80: equity 100 + 7200 = 7300 -> -27% -> stop.
    // Later spike would buy again; none may happen.
    const opens = [100, 100, 110, 80, 80, 80, 80, 80, 80, 80, 100, 100];
    const r = runBacktest({
      algorithm: gapAlgorithm(['AAA']),
      bars: { AAA: makeBars(opens) },
      options: loose,
    });
    expect(r.stoppedOn).toBe('2026-03-04');
    expect(r.trades.map((t) => t.side)).toEqual(['buy']);
    expect(r.openPositions).toHaveLength(1);
    expect(r.warnings.some((w) => w.includes('누적 손실'))).toBe(true);
  });

  it('does not stop on a loss that stays above the limit', () => {
    // i3 opens at 90: equity 100 + 8100 = 8200 -> -18%: keep trading (the sell is only blocked by min holding).
    const opens = [100, 100, 110, 90, 90, 90, 90, 90, 90, 100, 100];
    const r = runBacktest({
      algorithm: gapAlgorithm(['AAA']),
      bars: { AAA: makeBars(opens) },
      options: loose,
    });
    expect(r.stoppedOn).toBeNull();
    expect(r.rejections['min-holding-period']).toBe(1);
  });

  it('counts unrealized loss from open marks, and costs, in the cumulative loss', () => {
    // Same -18% path but a 3% loss limit stops it.
    const opens = [100, 100, 110, 90, 90, 90];
    const r = runBacktest({
      algorithm: gapAlgorithm(['AAA']),
      bars: { AAA: makeBars(opens) },
      options: { ...loose, safeguards: { ...loose.safeguards, lossStopFraction: 0.03 } },
    });
    expect(r.stoppedOn).toBe('2026-03-04');
  });

  it('rejects buys for illiquid symbols (20-day average traded value) and short histories', () => {
    const opens = [100, 100, 110, 110, 110, 110];
    const thin = makeBars(opens, '2026-03-01', 10); // 10 shares/day * ~100 = ~1000
    const r = runBacktest({
      algorithm: gapAlgorithm(['AAA']),
      bars: { AAA: thin },
      options: {
        expectedProfit: { mode: 'ignore' },
        safeguards: { liquidityWindow: 2, liquidityMinAvgValue: 5_000 },
      },
    });
    expect(r.trades).toHaveLength(0);
    expect(r.rejections.liquidity).toBe(1);
    const thick = runBacktest({
      algorithm: gapAlgorithm(['AAA']),
      bars: { AAA: makeBars(opens, '2026-03-01', 1000) },
      options: {
        expectedProfit: { mode: 'ignore' },
        safeguards: { liquidityWindow: 2, liquidityMinAvgValue: 5_000 },
      },
    });
    expect(thick.trades).toHaveLength(1);
    // Default KR window of 20 completed bars is not available this early -> treated as illiquid.
    const short = runBacktest({
      algorithm: gapAlgorithm(['AAA']),
      bars: { AAA: makeBars(opens) },
      options: { expectedProfit: { mode: 'ignore' } },
    });
    expect(short.trades).toHaveLength(0);
    expect(short.rejections.liquidity).toBe(1);
  });

  it('never opens a position of 100,000,000 KRW or more', () => {
    const r = runBacktest({
      algorithm: gapAlgorithm(['AAA'], { budget: 500_000_000 }),
      bars: { AAA: makeBars([100_000, 100_000, 110_000, 110_000]) },
      options: loose,
    });
    expect(r.trades).toHaveLength(0);
    expect(r.rejections['order-too-large']).toBe(1);
  });

  it('sells exactly the quantity it bought and never goes short or beyond the budget', () => {
    const opens = [100, 100, 110, 110, 110, 110, 110, 110, 100, 100];
    const r = runBacktest({
      algorithm: gapAlgorithm(['AAA']),
      bars: { AAA: makeBars(opens) },
      options: loose,
    });
    const bought = r.trades.filter((t) => t.side === 'buy').reduce((a, t) => a + t.quantity, 0);
    const sold = r.trades.filter((t) => t.side === 'sell').reduce((a, t) => a + t.quantity, 0);
    expect(sold).toBe(bought);
    for (const p of r.equityCurve) expect(p.cash).toBeGreaterThanOrEqual(0);
    expect(r.trades[0].notional).toBeLessThanOrEqual(10_000);
  });

  it('does not buy again while holding and ignores sell signals while flat', () => {
    const opens = [100, 100, 120, 144, 144, 144, 144, 144, 144, 144];
    const r = runBacktest({
      algorithm: gapAlgorithm(['AAA']),
      bars: { AAA: makeBars(opens) },
      options: loose,
    });
    expect(r.trades.filter((t) => t.side === 'buy')).toHaveLength(1);
    const falling = runBacktest({
      algorithm: gapAlgorithm(['AAA']),
      bars: { AAA: makeBars([100, 100, 90, 80, 70]) },
      options: loose,
    });
    expect(falling.trades).toHaveLength(0);
    expect(falling.rejections).toEqual({});
  });
});

describe('expected-profit rule (walk-forward)', () => {
  const cycle = [100, 110, 110, 110, 110, 110, 125, 117];
  const opens = Array.from({ length: 5 }, () => cycle).flat();
  const bars = { AAA: makeBars(opens) };
  const algorithm = () =>
    gapAlgorithm(['AAA'], { scale: 1, buy: 0.05, sell: -0.05, budget: 100_000 });
  const run = (o: BacktestOptions) => runBacktest({ algorithm: algorithm(), bars, options: o });
  const rule = { mode: 'walk-forward' as const, minSamples: 2 };

  it('holds buys back until enough earlier round trips have closed, then trades', () => {
    const r = run({
      safeguards: loose.safeguards,
      expectedProfit: rule,
      costs: { commissionRate: 0.001, sellTaxRate: 0.002 },
    });
    // Cycles 1 and 2 have 0 and 1 closed samples (< 2): both buy signals of each cycle (the 110 and 125 gaps) are held back. Cycle 3+ trade.
    expect(r.heldBack.insufficientHistory).toBe(4);
    expect(r.rejections['insufficient-history']).toBe(4);
    expect(r.samples).toHaveLength(5);
    const firstBuy = r.trades.find((t) => t.side === 'buy')!;
    expect(firstBuy.date).toBe('2026-03-18'); // cycle 3 spike (index 17 from 2026-03-01)
    expect(r.trades.filter((t) => t.side === 'buy')).toHaveLength(3);
    // Every sample is the signal-level round trip 117 / 110 - 1 in bucket [0.1, 0.2).
    for (const s of r.samples) {
      expect(s.grossReturn).toBeCloseTo(117 / 110 - 1, 10);
      expect(s.score).toBeCloseTo(0.1, 10);
    }
    expect(r.researchOnly).toBe(false);
    expect(r.expectedProfitMode).toBe('walk-forward');
  });

  it('uses only samples closed strictly before the decision day', () => {
    const r = run({ safeguards: loose.safeguards, expectedProfit: rule });
    // The second sample closes on the last day of cycle 2 (index 15 -> 2026-03-16); the cycle 3 spike
    // is index 17, so it is visible there. With minSamples 3 the same data only unlocks cycle 4.
    const r3 = run({ safeguards: loose.safeguards, expectedProfit: { ...rule, minSamples: 3 } });
    expect(r3.heldBack.insufficientHistory).toBe(6);
    expect(r3.trades.find((t) => t.side === 'buy')!.date).toBe('2026-03-26');
    expect(r.trades.find((t) => t.side === 'buy')!.date).toBe('2026-03-18');
    // The final statistics equal a rebuild from the stored samples.
    expect(expectedProfit(r.bucketStats, 0.1, 1)).toBeCloseTo(
      expectedProfit(buildBucketStats(r.samples), 0.1, 1)!,
      12,
    );
    // A rebuild "as of" the closing day excludes that sample.
    const closing = r.samples[1].closedOn;
    expect(buildBucketStats(r.samples, { asOf: closing }).buckets['1'].count).toBe(1);
  });

  it('holds back when the bucket average does not beat the round-trip cost', () => {
    const loser = [100, 110, 110, 110, 110, 110, 100];
    const r = runBacktest({
      algorithm: gapAlgorithm(['AAA'], { scale: 1, buy: 0.05, sell: -0.05, budget: 100_000 }),
      bars: { AAA: makeBars(Array.from({ length: 5 }, () => loser).flat()) },
      options: {
        safeguards: loose.safeguards,
        expectedProfit: rule,
        costs: { commissionRate: 0.001, sellTaxRate: 0.002 },
      },
    });
    expect(r.trades).toHaveLength(0);
    expect(r.heldBack.expectedBelowCost).toBeGreaterThan(0);
    expect(r.heldBack.insufficientHistory).toBe(2);
  });

  it('is skipped in the labeled research mode', () => {
    const r = run({ ...loose });
    expect(r.heldBack).toEqual({ insufficientHistory: 0, expectedBelowCost: 0 });
    expect(r.trades.filter((t) => t.side === 'buy')).toHaveLength(5);
    expect(r.researchOnly).toBe(true);
    expect(r.warnings.some((w) => w.includes('연구용'))).toBe(true);
  });

  it('does not let a buy signal that was held back skip the learning: signal round trips still accrue', () => {
    const r = run({
      safeguards: loose.safeguards,
      expectedProfit: { mode: 'walk-forward', minSamples: 1000 },
    });
    expect(r.trades).toHaveLength(0);
    expect(r.samples).toHaveLength(5);
  });
});

describe('signal exclusion and inputs', () => {
  it('excludes supply and news from the simulation and reports it', () => {
    const algo = createAlgorithm(
      'custom',
      { name: 'mixed', market: 'KR', symbols: ['AAA'], budget: 10_000 },
      {
        signals: [
          { id: 'momentum', weight: 0.5 },
          { id: 'supply', weight: 0.3 },
          { id: 'news', weight: 0.2 },
        ],
        buyThreshold: 0.5,
        sellThreshold: -0.5,
        params: { momentum: { lookbackDays: 1, scale: 0.1 } },
      },
    );
    const r = runBacktest({
      algorithm: algo,
      bars: { AAA: makeBars([100, 100, 110, 110, 110]) },
      options: loose,
    });
    expect(r.excludedSignals).toEqual(['supply', 'news']);
    expect(r.excludedSignalWeightShare).toBeCloseTo(0.5, 12);
    // Decisions renormalize over the momentum weight alone, so the buy still happens.
    expect(r.trades).toHaveLength(1);
    expect(() =>
      runBacktest({
        algorithm: createAlgorithm(
          'custom',
          { name: 'only external', market: 'KR', symbols: ['AAA'], budget: 10_000 },
          { signals: [{ id: 'supply', weight: 1 }] },
        ),
        bars: { AAA: makeBars([100, 100, 110]) },
        options: loose,
      }),
    ).toThrow(/point-in-time/);
  });

  it('validates the inputs', () => {
    const algorithm = gapAlgorithm(['AAA']);
    expect(() => runBacktest({ algorithm, bars: {} })).toThrow(/no bars/);
    expect(() =>
      runBacktest({
        algorithm,
        bars: { AAA: [...makeBars([100, 101]), ...makeBars([100], '2026-03-01')] },
      }),
    ).toThrow(/ascending/);
    expect(() => runBacktest({ algorithm, bars: { AAA: makeBars([100, -1]) } })).toThrow(
      /non-positive/,
    );
    expect(() =>
      runBacktest({
        algorithm,
        bars: { AAA: makeBars([100, 101]) },
        options: { startDate: '2030-01-01' },
      }),
    ).toThrow(/no trading days/);
    expect(() =>
      runBacktest({ algorithm, bars: { AAA: makeBars([100, 101]) }, options: { slippageBps: -1 } }),
    ).toThrow(/slippage/);
  });

  it('uses the value signal only from filings dated before each decision day', () => {
    const algo = createAlgorithm(
      'custom',
      { name: 'value', market: 'US', symbols: ['AAA'], budget: 10_000 },
      { signals: [{ id: 'value', weight: 1 }], buyThreshold: 0.5, sellThreshold: -0.5 },
    );
    const bars = makeBars(
      Array.from({ length: 12 }, () => 100),
      '2026-03-01',
    );
    // Four prior quarters falling PER; the cheapest filing is dated 2026-03-05, so buys can only start 03-06.
    const values = [
      { filedAt: '2025-06-01', per: 20, pbr: null, roe: null },
      { filedAt: '2025-09-01', per: 18, pbr: null, roe: null },
      { filedAt: '2025-12-01', per: 16, pbr: null, roe: null },
      { filedAt: '2026-03-05', per: 10, pbr: null, roe: null },
    ];
    const r = runBacktest({
      algorithm: algo,
      bars: { AAA: bars },
      values: { AAA: values },
      options: { ...loose, startDate: '2026-03-02', recordDecisions: true },
    });
    const buys = r.decisions.filter((d) => d.action === 'buy');
    expect(buys[0].date).toBe('2026-03-06');
    expect(
      r.decisions
        .filter((d) => d.date <= '2026-03-05')
        .every((d) => d.reason === 'insufficient-data'),
    ).toBe(true);
  });
});

describe('dual momentum backtest', () => {
  it('holds only the top-ranked symbol and goes to cash when its momentum turns negative', () => {
    const algo = createAlgorithm(
      'dualMomentum',
      { name: 'dual', market: 'US', symbols: ['AAA', 'BBB'], budget: 10_000 },
      { dualMomentum: { lookbackDays: 2, topN: 1, absoluteThreshold: 0, scale: 0.2 } },
    );
    // AAA rises faster than BBB, then both fall.
    const aaa = [100, 102, 110, 120, 130, 140, 120, 100, 90, 80];
    const bbb = [100, 101, 103, 105, 107, 109, 100, 95, 90, 85];
    const r = runBacktest({
      algorithm: algo,
      bars: { AAA: makeBars(aaa), BBB: makeBars(bbb) },
      options: {
        ...loose,
        safeguards: { ...loose.safeguards, minHoldingTradingDays: 1 },
        recordDecisions: true,
      },
    });
    expect(r.trades.length).toBeGreaterThanOrEqual(2);
    expect(r.trades.filter((t) => t.side === 'buy').every((t) => t.symbol === 'AAA')).toBe(true);
    expect(r.trades[r.trades.length - 1].side).toBe('sell');
    expect(r.openPositions).toEqual([]);
    expect(r.metrics.roundTrips).toBe(1);
  });
});

describe('determinism', () => {
  it('returns identical results for identical inputs and does not mutate them', () => {
    const opens = [100, 100, 110, 110, 110, 110, 110, 110, 100, 100];
    const bars = { AAA: makeBars(opens) };
    const snapshot = JSON.stringify(bars);
    const algorithm = gapAlgorithm(['AAA']);
    const options: BacktestOptions = {
      ...loose,
      costs: { commissionRate: 0.001, sellTaxRate: 0.002 },
      recordDecisions: true,
    };
    const a = runBacktest({ algorithm, bars, options });
    const b = runBacktest({ algorithm, bars, options });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(bars)).toBe(snapshot);
  });
  it('does not depend on the order of the symbol list', () => {
    const bars = {
      A: makeBars([100, 100, 110, 110, 110, 110, 110, 110, 100]),
      B: makeBars([50, 50, 56, 56, 56, 56, 56, 56, 50]),
    };
    const run = (symbols: string[]) =>
      runBacktest({ algorithm: gapAlgorithm(symbols, { budget: 20_000 }), bars, options: loose });
    expect(JSON.stringify(run(['A', 'B']).trades)).toBe(JSON.stringify(run(['B', 'A']).trades));
  });
});
