import { describe, expect, it } from 'vitest';
import {
  assertCompletedBars,
  computeSignalScores,
  defaultSignalParams,
  meanReversionScore,
  momentumReturn,
  momentumScore,
  requiredBarsForSignal,
  trendScore,
  valueScore,
  type DailyBar,
  type ValueSnapshot,
} from '../src/lib/algo';

const day = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
const bar = (i: number, close: number, spread = 0): DailyBar => ({
  date: day(i),
  open: close,
  high: close + spread,
  low: close - spread,
  close,
  volume: 1000,
});
const barsFrom = (closes: number[], spread = 0) => closes.map((c, i) => bar(i, c, spread));

describe('momentum signal', () => {
  it('uses the close N trading days back and the decision price', () => {
    const bars = barsFrom([100, 110, 121, 133.1]);
    // lookback 3 -> close of bars[len - 3] = 110
    expect(momentumReturn(bars, 150, 3)).toBeCloseTo(150 / 110 - 1, 12);
    expect(momentumScore(bars, 150, { lookbackDays: 3, scale: 0.5 })).toBeCloseTo(
      (150 / 110 - 1) / 0.5,
      12,
    );
  });
  it('clamps to [-1, 1] and returns null without enough history', () => {
    const bars = barsFrom([100, 100, 100]);
    expect(momentumScore(bars, 1000, { lookbackDays: 3, scale: 0.2 })).toBe(1);
    expect(momentumScore(bars, 1, { lookbackDays: 3, scale: 0.2 })).toBe(-1);
    expect(momentumScore(bars, 100, { lookbackDays: 4, scale: 0.2 })).toBeNull();
  });
});

describe('mean reversion signal', () => {
  const flat = barsFrom(Array.from({ length: 25 }, () => 100));
  it('is neutral on flat prices', () => {
    expect(meanReversionScore(flat, 100, defaultSignalParams.meanReversion)).toBeCloseTo(0, 12);
  });
  it('is maximal (hand-checked RSI 0, %B < 0) after a sharp drop', () => {
    // RSI window: 13 zero changes and one -10 -> RSI 0 -> rsiScore 1; %B ~ -0.59 -> bbScore 1.
    expect(meanReversionScore(flat, 90, defaultSignalParams.meanReversion)).toBeCloseTo(1, 12);
  });
  it('is negative after a sharp rise and null with too little data', () => {
    expect(meanReversionScore(flat, 110, defaultSignalParams.meanReversion)).toBeCloseTo(-1, 12);
    expect(
      meanReversionScore(flat.slice(0, 10), 100, defaultSignalParams.meanReversion),
    ).toBeNull();
  });
});

describe('trend signal', () => {
  const rising = barsFrom(
    Array.from({ length: 80 }, (_, i) => 100 + i * 2),
    1,
  );
  const falling = barsFrom(
    Array.from({ length: 80 }, (_, i) => 300 - i * 2),
    1,
  );
  it('is positive in an up trend, negative in a down trend, zero when flat', () => {
    const up = trendScore(rising, 260, defaultSignalParams.trend)!;
    const down = trendScore(falling, 140, defaultSignalParams.trend)!;
    expect(up).toBeGreaterThan(0.2);
    expect(up).toBeLessThanOrEqual(1);
    expect(down).toBeLessThan(-0.2);
    expect(
      trendScore(barsFrom(Array.from({ length: 80 }, () => 100)), 100, defaultSignalParams.trend),
    ).toBeCloseTo(0, 12);
  });
  it('halves the direction when ADX is zero and keeps it when ADX is at full strength', () => {
    // Flat bars give ADX 0 -> factor 0.5. Direction comes only from the decision price.
    const flat = barsFrom(Array.from({ length: 80 }, () => 100));
    const price = 105; // slow SMA over 49 closes + price = (4900 + 105)/50 = 100.1
    const sma50 = (49 * 100 + price) / 50;
    const sma20 = (19 * 100 + price) / 20;
    const cross = Math.max(-1, Math.min(1, (sma20 / sma50 - 1) / 0.05));
    const pos = Math.max(-1, Math.min(1, (price / sma50 - 1) / 0.1));
    expect(trendScore(flat, price, defaultSignalParams.trend)).toBeCloseTo(
      ((cross + pos) / 2) * 0.5,
      12,
    );
  });
  it('is null before the slow SMA and ADX are available', () => {
    expect(trendScore(rising.slice(0, 20), 150, defaultSignalParams.trend)).toBeNull();
  });
  it('does not depend on history older than the ADX tail window', () => {
    const long = barsFrom(
      Array.from({ length: 400 }, (_, i) => 100 + Math.sin(i / 7) * 10 + i * 0.1),
      1,
    );
    const a = trendScore(long, 130, defaultSignalParams.trend);
    const b = trendScore(long.slice(200), 130, defaultSignalParams.trend);
    expect(a).toBe(b);
  });
});

describe('value signal', () => {
  const snap = (filedAt: string, per: number | null, pbr: number | null = null): ValueSnapshot => ({
    filedAt,
    per,
    pbr,
    roe: 0.1,
  });
  const quarterly = (pers: (number | null)[], pbrs: (number | null)[] = []) =>
    pers.map((per, i) =>
      snap(`2025-${String(i * 3 + 1).padStart(2, '0')}-15`, per, pbrs[i] ?? null),
    );

  it('gives +1 when the current PER is the cheapest of its own history and -1 when the dearest', () => {
    expect(valueScore(quarterly([16, 14, 12, 10]), '2026-02-01', defaultSignalParams.value)).toBe(
      1,
    );
    expect(valueScore(quarterly([10, 12, 14, 16]), '2026-02-01', defaultSignalParams.value)).toBe(
      -1,
    );
  });
  it('ranks in the middle and averages PER and PBR', () => {
    // PER: current 12 of [10, 14, 16, 12]; above = 2 of 3 others -> 2*(2/3)-1 = 1/3.
    // PBR: current 1.0 of [2, 1.5, 1.2, 1.0]; all 3 others above -> +1.
    const s = valueScore(
      quarterly([10, 14, 16, 12], [2, 1.5, 1.2, 1.0]),
      '2026-02-01',
      defaultSignalParams.value,
    )!;
    expect(s).toBeCloseTo((1 / 3 + 1) / 2, 12);
  });
  it('ignores filings dated on or after the decision day (no look-ahead)', () => {
    const rows = [...quarterly([16, 14, 12, 10]), snap('2026-02-01', 99)];
    expect(valueScore(rows, '2026-02-01', defaultSignalParams.value)).toBe(1);
    expect(valueScore(rows, '2026-02-02', defaultSignalParams.value)).toBe(-1);
  });
  it('is null with too little history, stale data, or non-positive values', () => {
    expect(valueScore(quarterly([12, 10, 9]), '2026-02-01', defaultSignalParams.value)).toBeNull();
    expect(
      valueScore(quarterly([16, 14, 12, 10]), '2028-01-01', defaultSignalParams.value),
    ).toBeNull();
    expect(
      valueScore(quarterly([16, 14, 12, -3]), '2026-02-01', defaultSignalParams.value),
    ).toBeNull();
    expect(valueScore([], '2026-02-01', defaultSignalParams.value)).toBeNull();
  });
  it('does not need the input to be sorted', () => {
    const shuffled = [...quarterly([16, 14, 12, 10])].reverse();
    expect(valueScore(shuffled, '2026-02-01', defaultSignalParams.value)).toBe(1);
  });
});

describe('computeSignalScores', () => {
  const bars = barsFrom(
    Array.from({ length: 80 }, (_, i) => 100 + i),
    1,
  );
  it('rejects bars that are not complete before the decision day', () => {
    expect(() => assertCompletedBars(bars, bars[79].date)).toThrow(/look-ahead/);
    expect(() =>
      computeSignalScores({ bars, price: 180, decisionDate: bars[79].date }, ['momentum']),
    ).toThrow(/look-ahead/);
    expect(() => assertCompletedBars(bars, day(80))).not.toThrow();
  });
  it('returns null for value without snapshots and passes supply/news through', () => {
    const out = computeSignalScores(
      { bars, price: 180, decisionDate: day(80), external: { supply: 0.4 } },
      ['value', 'supply', 'news', 'momentum'],
    );
    expect(out.value).toBeNull();
    expect(out.supply).toBe(0.4);
    expect(out.news).toBeNull();
    expect(out.momentum).not.toBeNull();
  });
  it('rejects out-of-range external scores and invalid prices', () => {
    expect(() =>
      computeSignalScores({ bars, price: 180, decisionDate: day(80), external: { news: 1.5 } }, [
        'news',
      ]),
    ).toThrow(/within/);
    expect(() =>
      computeSignalScores({ bars, price: 0, decisionDate: day(80) }, ['momentum']),
    ).toThrow();
  });
  it('reports the completed bars each signal needs', () => {
    expect(requiredBarsForSignal('trend', defaultSignalParams)).toBe(49);
    expect(requiredBarsForSignal('momentum', defaultSignalParams)).toBe(60);
    expect(requiredBarsForSignal('meanReversion', defaultSignalParams)).toBe(19);
    expect(requiredBarsForSignal('value', defaultSignalParams)).toBe(0);
  });
});
