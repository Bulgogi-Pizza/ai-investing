import { describe, expect, it } from 'vitest';
import {
  addSample,
  annualizedVolatility,
  bucketIndex,
  buildBucketStats,
  capitalGainsTaxForYear,
  checkOrder,
  compositeScore,
  createAlgorithm,
  createBucketStats,
  decideDualMomentum,
  decideFormula,
  defaultSafeguards,
  expectedProfit,
  maxDrawdown,
  requiredBars,
  resolveCosts,
  roundTripCostRate,
  templateDefaults,
  validateAlgorithm,
  type OrderCheckInput,
} from '../src/lib/algo';

describe('composite score', () => {
  const weights = [
    { id: 'trend' as const, weight: 0.5 },
    { id: 'momentum' as const, weight: 0.3 },
    { id: 'value' as const, weight: 0.2 },
  ];
  it('is the weighted sum when every signal is available', () => {
    const c = compositeScore(weights, { trend: 1, momentum: -0.5, value: 0 });
    expect(c.score).toBeCloseTo(0.5 * 1 + 0.3 * -0.5 + 0, 12);
    expect(c.insufficient).toBe(false);
  });
  it('renormalizes over the available signals', () => {
    const c = compositeScore(weights, { trend: 1, momentum: -0.5, value: null });
    expect(c.score).toBeCloseTo((0.5 * 1 + 0.3 * -0.5) / 0.8, 12);
  });
  it('is insufficient when null signals carry more than half of the weight, not at exactly half', () => {
    const sixty = compositeScore(weights, { trend: null, momentum: 1, value: 1 }); // 0.5 of 1.0 -> exactly half
    expect(sixty.insufficient).toBe(false);
    const over = compositeScore(weights, { trend: null, momentum: null, value: 1 }); // 0.8 of 1.0
    expect(over.insufficient).toBe(true);
    expect(over.score).toBeNull();
  });
  it('treats missing scores as null and ignores zero weights', () => {
    const c = compositeScore(
      [
        { id: 'trend', weight: 1 },
        { id: 'momentum', weight: 0 },
      ],
      { trend: 0.4 },
    );
    expect(c.score).toBeCloseTo(0.4, 12);
  });
});

describe('formula decision', () => {
  const algo = {
    signals: [{ id: 'trend' as const, weight: 1 }],
    buyThreshold: 0.3,
    sellThreshold: -0.2,
  };
  it('buys at or above the buy threshold, sells at or below the sell threshold', () => {
    expect(decideFormula(algo, { trend: 0.3 })).toMatchObject({
      action: 'buy',
      reason: 'buy-threshold',
    });
    expect(decideFormula(algo, { trend: -0.2 })).toMatchObject({
      action: 'sell',
      reason: 'sell-threshold',
    });
    expect(decideFormula(algo, { trend: 0.1 })).toMatchObject({
      action: 'hold',
      reason: 'between-thresholds',
    });
  });
  it("holds with reason 'insufficient-data' and a null score when data is missing", () => {
    expect(decideFormula(algo, { trend: null })).toEqual({
      action: 'hold',
      score: null,
      reason: 'insufficient-data',
      signals: { trend: { score: null, weight: 1 } },
    });
  });
});

describe('dual momentum', () => {
  const p = { lookbackDays: 126, topN: 1, absoluteThreshold: 0, scale: 0.2 };
  it('buys only the best-ranked symbol with positive absolute momentum', () => {
    const d = decideDualMomentum({ A: 0.2, B: 0.1, C: -0.05, D: null }, p);
    expect(d.A).toMatchObject({ action: 'buy', score: 1, reason: 'dual-momentum-pass' });
    expect(d.A.detail).toEqual({ momentumReturn: 0.2, rank: 1 });
    expect(d.B).toMatchObject({ action: 'sell', score: 0, reason: 'relative-momentum' });
    expect(d.C).toMatchObject({ action: 'sell', reason: 'absolute-momentum' });
    expect(d.C.score).toBeCloseTo(-0.25, 12);
    expect(d.D).toMatchObject({ action: 'hold', reason: 'insufficient-data', score: null });
  });
  it('holds cash when even the best symbol fails the absolute test', () => {
    const d = decideDualMomentum({ A: -0.01, B: -0.1 }, p);
    expect(d.A.action).toBe('sell');
    expect(d.B.action).toBe('sell');
  });
  it('breaks rank ties by symbol and honors topN', () => {
    const d = decideDualMomentum({ B: 0.1, A: 0.1, C: 0.05 }, { ...p, topN: 2 });
    expect(d.A.action).toBe('buy');
    expect(d.B.action).toBe('buy');
    expect(d.C.action).toBe('sell');
  });
});

describe('templates', () => {
  const base = {
    name: 't',
    market: 'KR' as const,
    symbols: ['005930', '000660'],
    budget: 1_000_000,
  };
  it('has the documented defaults', () => {
    const m = createAlgorithm('momentum', base);
    expect(m.signals).toEqual([
      { id: 'trend', weight: 0.4 },
      { id: 'momentum', weight: 0.6 },
    ]);
    expect([m.buyThreshold, m.sellThreshold]).toEqual([0.3, -0.1]);
    expect(m.params.momentum).toEqual({ lookbackDays: 60, scale: 0.2 });
    const r = createAlgorithm('meanReversion', base);
    expect(r.signals).toEqual([{ id: 'meanReversion', weight: 1 }]);
    expect([r.buyThreshold, r.sellThreshold]).toEqual([0.5, 0]);
    expect(r.params.meanReversion).toEqual({ rsiPeriod: 14, bbPeriod: 20, bbK: 2, rsiScale: 30 });
    const d = createAlgorithm('dualMomentum', base);
    expect(d.dualMomentum).toEqual({
      lookbackDays: 126,
      topN: 1,
      absoluteThreshold: 0,
      scale: 0.2,
    });
    expect(d.method).toBe('formula');
    expect(Object.keys(templateDefaults)).toEqual([
      'momentum',
      'meanReversion',
      'dualMomentum',
      'custom',
    ]);
  });
  it('applies overrides without mutating the defaults', () => {
    const a = createAlgorithm('momentum', base, {
      buyThreshold: 0.4,
      params: { momentum: { lookbackDays: 20 } },
    });
    expect(a.buyThreshold).toBe(0.4);
    expect(a.params.momentum.lookbackDays).toBe(20);
    expect(createAlgorithm('momentum', base).params.momentum.lookbackDays).toBe(60);
    expect(templateDefaults.momentum.buyThreshold).toBe(0.3);
  });
  it('computes the warm-up length', () => {
    expect(requiredBars(createAlgorithm('momentum', base))).toBe(60);
    expect(requiredBars(createAlgorithm('meanReversion', base))).toBe(19);
    expect(requiredBars(createAlgorithm('dualMomentum', base))).toBe(126);
  });
  it('validates definitions', () => {
    const ok = createAlgorithm('momentum', base);
    expect(() => validateAlgorithm({ ...ok, symbols: [] })).toThrow(/symbols/);
    expect(() => validateAlgorithm({ ...ok, symbols: ['A', 'A'] })).toThrow(/unique/);
    expect(() => validateAlgorithm({ ...ok, budget: 0 })).toThrow(/budget/);
    expect(() => validateAlgorithm({ ...ok, sellThreshold: 0.5, buyThreshold: 0.1 })).toThrow(
      /below/,
    );
    expect(() => validateAlgorithm({ ...ok, signals: [{ id: 'trend', weight: -1 }] })).toThrow(
      /weight/,
    );
    expect(() => validateAlgorithm({ ...ok, signals: [{ id: 'trend', weight: 0 }] })).toThrow(
      /positive/,
    );
    expect(() => validateAlgorithm({ ...ok, method: 'ai' as never })).toThrow(/formula/);
  });
});

describe('pre-trade check', () => {
  const sg = defaultSafeguards('KR');
  const buy = (over: Partial<OrderCheckInput> = {}): OrderCheckInput => ({
    side: 'buy',
    quantity: 10,
    price: 1000,
    ordersToday: 0,
    stopped: false,
    ownQuantity: 0,
    heldTradingDays: null,
    avgTradedValue: 2e9,
    expectedProfit: { enforce: true, expected: 0.05, roundTripCost: 0.004 },
    safeguards: sg,
    ...over,
  });
  const sell = (over: Partial<OrderCheckInput> = {}): OrderCheckInput =>
    buy({ side: 'sell', ownQuantity: 10, heldTradingDays: 5, ...over });

  it('has the design defaults per market', () => {
    expect(defaultSafeguards('KR')).toEqual({
      maxOrdersPerDay: 3,
      minHoldingTradingDays: 5,
      lossStopFraction: 0.2,
      liquidityMinAvgValue: 1e9,
      liquidityWindow: 20,
      maxOrderValue: 100_000_000,
    });
    expect(defaultSafeguards('US')).toMatchObject({
      liquidityMinAvgValue: 5e6,
      maxOrderValue: null,
    });
  });
  it('accepts a clean buy and a clean sell', () => {
    expect(checkOrder(buy())).toEqual({ ok: true, quantity: 10, clamped: false });
    expect(checkOrder(sell())).toEqual({ ok: true, quantity: 10, clamped: false });
  });
  it('sells only what the algorithm bought', () => {
    expect(checkOrder(sell({ quantity: 100, ownQuantity: 40 }))).toEqual({
      ok: true,
      quantity: 40,
      clamped: true,
    });
    expect(checkOrder(sell({ ownQuantity: 0 }))).toEqual({ ok: false, reason: 'not-owned' });
  });
  it('blocks sells inside the minimum holding period', () => {
    expect(checkOrder(sell({ heldTradingDays: 4 }))).toEqual({
      ok: false,
      reason: 'min-holding-period',
    });
    expect(checkOrder(sell({ heldTradingDays: 5 })).ok).toBe(true);
  });
  it('enforces the per-day order limit, the loss stop, liquidity and the order value cap', () => {
    expect(checkOrder(buy({ ordersToday: 3 }))).toEqual({
      ok: false,
      reason: 'max-orders-per-day',
    });
    expect(checkOrder(buy({ ordersToday: 2 })).ok).toBe(true);
    expect(checkOrder(buy({ stopped: true }))).toEqual({ ok: false, reason: 'loss-stop' });
    expect(checkOrder(buy({ avgTradedValue: 9.99e8 }))).toEqual({ ok: false, reason: 'liquidity' });
    expect(checkOrder(buy({ avgTradedValue: null }))).toEqual({ ok: false, reason: 'liquidity' });
    expect(checkOrder(buy({ quantity: 100_000, price: 1000 }))).toEqual({
      ok: false,
      reason: 'order-too-large',
    });
    expect(checkOrder(buy({ quantity: 99_999, price: 1000 })).ok).toBe(true);
    expect(checkOrder(buy({ quantity: 0 }))).toEqual({ ok: false, reason: 'invalid-quantity' });
    expect(checkOrder(buy({ quantity: 1.5 }))).toEqual({ ok: false, reason: 'invalid-quantity' });
  });
  it('requires expected profit to be known and above the round-trip cost', () => {
    const rule = (expected: number | null, enforce = true) => ({
      enforce,
      expected,
      roundTripCost: 0.004,
    });
    expect(checkOrder(buy({ expectedProfit: rule(null) }))).toEqual({
      ok: false,
      reason: 'insufficient-history',
    });
    expect(checkOrder(buy({ expectedProfit: rule(0.004) }))).toEqual({
      ok: false,
      reason: 'expected-profit-below-cost',
    });
    expect(checkOrder(buy({ expectedProfit: rule(0.0041) })).ok).toBe(true);
    expect(checkOrder(buy({ expectedProfit: rule(null, false) })).ok).toBe(true);
  });
});

describe('costs', () => {
  it('flags unset settings instead of inventing legal rates', () => {
    expect(resolveCosts('KR').needsSetup).toEqual(['commissionRate', 'sellTaxRate']);
    expect(resolveCosts('US').needsSetup).toEqual(['commissionRate', 'capitalGainsTax']);
    expect(resolveCosts('KR', { commissionRate: 0, sellTaxRate: 0 }).needsSetup).toEqual([]);
    const c = resolveCosts('US');
    expect([c.commissionRate, c.sellTaxRate, c.capitalGainsTax]).toEqual([
      0,
      0,
      { rate: 0, annualDeduction: 0 },
    ]);
  });
  it('rejects invalid rates', () => {
    expect(() => resolveCosts('KR', { commissionRate: -0.1 })).toThrow();
    expect(() => resolveCosts('KR', { sellTaxRate: 1 })).toThrow();
    expect(() =>
      resolveCosts('US', { capitalGainsTax: { rate: 0.2, annualDeduction: -1 } }),
    ).toThrow();
  });
  it('computes the explicit round-trip cost and the annual tax', () => {
    expect(roundTripCostRate({ commissionRate: 0.001, sellTaxRate: 0.002 })).toBeCloseTo(0.004, 12);
    const s = { rate: 0.22, annualDeduction: 200 };
    expect(capitalGainsTaxForYear(1000, s)).toBeCloseTo(176, 12);
    expect(capitalGainsTaxForYear(150, s)).toBe(0);
    expect(capitalGainsTaxForYear(-5000, s)).toBe(0);
  });
});

describe('expected profit buckets', () => {
  it('places scores in 0.1-wide buckets without float drift', () => {
    expect(bucketIndex(0.3)).toBe(3);
    expect(bucketIndex(0.1)).toBe(1);
    expect(bucketIndex(0.29)).toBe(2);
    expect(bucketIndex(1)).toBe(9);
  });
  it('returns the mean gross return or null below minSamples', () => {
    const stats = createBucketStats();
    for (let i = 0; i < 19; i++) addSample(stats, 0.35, 0.02);
    expect(expectedProfit(stats, 0.31)).toBeNull();
    addSample(stats, 0.39, 0.04);
    expect(expectedProfit(stats, 0.31)).toBeCloseTo((19 * 0.02 + 0.04) / 20, 12);
    expect(expectedProfit(stats, 0.51)).toBeNull();
    expect(expectedProfit(stats, 0.31, 21)).toBeNull();
    expect(stats.buckets['3']).toMatchObject({ lower: 3 * 0.1, count: 20 });
  });
  it('rebuilds statistics as of a date: only round trips closed strictly before it', () => {
    const samples = [
      { score: 0.35, grossReturn: 0.1, openedOn: '2026-01-01', closedOn: '2026-01-10' },
      { score: 0.35, grossReturn: 0.3, openedOn: '2026-01-05', closedOn: '2026-01-20' },
    ];
    expect(expectedProfit(buildBucketStats(samples, { asOf: '2026-01-10' }), 0.35, 1)).toBeNull();
    expect(expectedProfit(buildBucketStats(samples, { asOf: '2026-01-11' }), 0.35, 1)).toBeCloseTo(
      0.1,
      12,
    );
    expect(expectedProfit(buildBucketStats(samples), 0.35, 1)).toBeCloseTo(0.2, 12);
  });
});

describe('metrics', () => {
  it('computes the maximum drawdown as a fraction of the running peak', () => {
    expect(maxDrawdown([100, 120, 90, 110])).toBeCloseTo(0.25, 12);
    expect(maxDrawdown([100, 101, 102])).toBe(0);
  });
  it('annualizes the sample standard deviation of daily returns by sqrt(252)', () => {
    // returns +10% and -10%: mean 0, sample variance 0.02
    expect(annualizedVolatility([100, 110, 99])).toBeCloseTo(Math.sqrt(0.02) * Math.sqrt(252), 12);
    expect(annualizedVolatility([100, 110])).toBeNull();
  });
});
