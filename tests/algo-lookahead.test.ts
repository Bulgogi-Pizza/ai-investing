import { describe, expect, it } from 'vitest';
import {
  createAlgorithm,
  runBacktest,
  type AlgorithmDefinition,
  type BacktestOptions,
  type DailyBar,
  type ValueSnapshot,
} from '../src/lib/algo';

/** Small deterministic generator (mulberry32) so fixtures are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dayFrom = (i: number) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);

function genBars(seed: number, n: number): DailyBar[] {
  const rand = rng(seed);
  let close = 100 + rand() * 50;
  return Array.from({ length: n }, (_, i) => {
    const open = close * (1 + (rand() - 0.5) * 0.03);
    // Slow cycle plus noise so there are trends, reversals and a few trading signals.
    close = open * (1 + Math.sin(i / 17 + seed) * 0.01 + (rand() - 0.5) * 0.03);
    return {
      date: dayFrom(i),
      open,
      high: Math.max(open, close) * (1 + rand() * 0.01),
      low: Math.min(open, close) * (1 - rand() * 0.01),
      close,
      volume: 1e6 + rand() * 4e6,
    };
  });
}

function genValues(seed: number): ValueSnapshot[] {
  const rand = rng(seed);
  return Array.from({ length: 12 }, (_, q) => ({
    filedAt: dayFrom(20 + q * 30),
    per: 8 + rand() * 20,
    pbr: 0.8 + rand() * 3,
    roe: rand() * 0.2,
  }));
}

const N = 400;
const SYMBOLS = ['AAA', 'BBB', 'CCC'];
const bars = Object.fromEntries(SYMBOLS.map((s, i) => [s, genBars(11 + i, N)]));
const values = Object.fromEntries(SYMBOLS.map((s, i) => [s, genValues(31 + i)]));

/**
 * Everything the decision at index `t` must NOT see: all bars after t, and day t's own
 * high/low/close/volume (only its open is allowed), and filings dated on or after day t.
 */
function mutateFuture(
  src: Record<string, DailyBar[]>,
  srcValues: Record<string, ValueSnapshot[]>,
  t: number,
) {
  const rand = rng(999);
  const outBars: Record<string, DailyBar[]> = {};
  const outValues: Record<string, ValueSnapshot[]> = {};
  const cutDate = dayFrom(t);
  for (const [symbol, list] of Object.entries(src)) {
    outBars[symbol] = list.map((b, i) => {
      if (i < t) return { ...b };
      const wild = () => 5 + rand() * 900;
      const open = i === t ? b.open : wild();
      return { date: b.date, open, high: wild(), low: wild(), close: wild(), volume: rand() * 1e9 };
    });
    outValues[symbol] = [
      ...srcValues[symbol].filter((v) => v.filedAt < cutDate).map((v) => ({ ...v })),
      ...srcValues[symbol]
        .filter((v) => v.filedAt >= cutDate)
        .map((v) => ({ ...v, per: 1 + rand() * 100, pbr: 1 + rand() * 9 })),
      { filedAt: cutDate, per: 0.5, pbr: 0.1, roe: 0.9 },
    ];
  }
  return { bars: outBars, values: outValues };
}

const tradingOptions: BacktestOptions = {
  recordDecisions: true,
  costs: { commissionRate: 0.001, sellTaxRate: 0.002 },
  safeguards: { liquidityMinAvgValue: 0 },
};

function mixedAlgorithm(): AlgorithmDefinition {
  return createAlgorithm(
    'custom',
    { name: 'mixed', market: 'KR', symbols: SYMBOLS, budget: 30_000_000 },
    {
      signals: [
        { id: 'trend', weight: 0.3 },
        { id: 'momentum', weight: 0.3 },
        { id: 'meanReversion', weight: 0.2 },
        { id: 'value', weight: 0.2 },
      ],
      buyThreshold: 0.15,
      sellThreshold: -0.15,
      params: { momentum: { lookbackDays: 20 } },
    },
  );
}

const variants: { name: string; algorithm: () => AlgorithmDefinition; options: BacktestOptions }[] =
  [
    {
      name: 'formula, expected-profit ignored',
      algorithm: mixedAlgorithm,
      options: { ...tradingOptions, expectedProfit: { mode: 'ignore' } },
    },
    {
      name: 'formula, walk-forward expected-profit rule',
      algorithm: mixedAlgorithm,
      options: { ...tradingOptions, expectedProfit: { mode: 'walk-forward', minSamples: 2 } },
    },
    {
      name: 'dual momentum',
      algorithm: () =>
        createAlgorithm(
          'dualMomentum',
          { name: 'dual', market: 'KR', symbols: SYMBOLS, budget: 30_000_000 },
          { dualMomentum: { lookbackDays: 40, topN: 1, absoluteThreshold: 0, scale: 0.2 } },
        ),
      options: { ...tradingOptions, expectedProfit: { mode: 'ignore' } },
    },
  ];

describe('no look-ahead: mutating everything after a decision date', () => {
  for (const v of variants) {
    for (const t of [150, 260, 333]) {
      it(`${v.name}: decisions, fills and equity are identical up to day index ${t}`, () => {
        const base = runBacktest({ algorithm: v.algorithm(), bars, values, options: v.options });
        const mutated = mutateFuture(bars, values, t);
        const other = runBacktest({
          algorithm: v.algorithm(),
          bars: mutated.bars,
          values: mutated.values,
          options: v.options,
        });
        const cut = dayFrom(t);
        const upTo = <T extends { date: string }>(rows: T[]) => rows.filter((r) => r.date <= cut);
        const before = <T extends { date: string }>(rows: T[]) => rows.filter((r) => r.date < cut);

        // Sanity: the fixture actually decides and trades before the cut, and the mutation matters later.
        const decided = upTo(base.decisions).filter((d) => d.reason !== 'insufficient-data');
        expect(decided.length).toBeGreaterThan(30);
        expect(base.decisions.filter((d) => d.date > cut)).not.toEqual(
          other.decisions.filter((d) => d.date > cut),
        );

        expect(upTo(other.decisions)).toEqual(upTo(base.decisions));
        expect(upTo(other.trades)).toEqual(upTo(base.trades));
        // The decision day's own close is not a decision input but does feed that day's equity mark.
        expect(before(other.equityCurve)).toEqual(before(base.equityCurve));
      });
    }
  }

  it('actually trades in the fixture (the comparison above is not vacuous)', () => {
    const base = runBacktest({
      algorithm: mixedAlgorithm(),
      bars,
      values,
      options: { ...tradingOptions, expectedProfit: { mode: 'ignore' } },
    });
    expect(base.trades.length).toBeGreaterThan(6);
    expect(base.decisions.some((d) => d.action === 'buy')).toBe(true);
    expect(base.decisions.some((d) => d.action === 'sell')).toBe(true);
  });

  it('a result for a truncated history equals the full run up to that day', () => {
    const t = 300;
    const full = runBacktest({
      algorithm: mixedAlgorithm(),
      bars,
      values,
      options: tradingOptions,
    });
    const truncated = runBacktest({
      algorithm: mixedAlgorithm(),
      bars: Object.fromEntries(Object.entries(bars).map(([s, b]) => [s, b.slice(0, t + 1)])),
      values,
      options: tradingOptions,
    });
    const cut = dayFrom(t);
    expect(truncated.decisions.filter((d) => d.date < cut)).toEqual(
      full.decisions.filter((d) => d.date < cut),
    );
    expect(truncated.trades.filter((x) => x.date < cut)).toEqual(
      full.trades.filter((x) => x.date < cut),
    );
  });
});
