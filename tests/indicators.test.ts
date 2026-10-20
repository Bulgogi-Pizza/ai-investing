import { describe, expect, it } from 'vitest';
import {
  adx,
  atr,
  cci,
  fibonacciLevels,
  fibonacciRetracement,
  ichimoku,
  indicatorDescriptions,
  indicatorIds,
  keltner,
  obv,
  parabolicSar,
  stochastic,
  trueRange,
  vwap,
  type IndicatorCandle,
} from '../src/lib/indicators';

const candle = (
  i: number,
  high: number,
  low: number,
  close: number,
  volume: number,
  timestamp: string | number = new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
): IndicatorCandle => ({ timestamp, open: close, high, low, close, volume });

/**
 * Small hand-computable fixture (index: high / low / close / volume):
 * 0: 10 / 8 / 9 / 100    1: 12 / 9 / 11 / 200    2: 13 / 10 / 10 / 150
 * 3: 11 / 8 / 9 / 300    4: 12 / 9 / 12 / 250    5: 14 / 11 / 13 / 100
 */
const small = (): IndicatorCandle[] => [
  candle(0, 10, 8, 9, 100),
  candle(1, 12, 9, 11, 200),
  candle(2, 13, 10, 10, 150),
  candle(3, 11, 8, 9, 300),
  candle(4, 12, 9, 12, 250),
  candle(5, 14, 11, 13, 100),
];

/** Deterministic longer series for warm-up and length checks. */
const long = (n = 100): IndicatorCandle[] =>
  Array.from({ length: n }, (_, i) => {
    const price = 100 + 10 * Math.sin(i * 0.3) + i * 0.1;
    return candle(i, price + 1, price - 1, price, 1000 + (i % 7) * 100);
  });

const flat = (n = 60): IndicatorCandle[] =>
  Array.from({ length: n }, (_, i) => candle(i, 100, 100, 100, 10));

const firstNonNull = (values: (number | null)[]) => values.findIndex((v) => v !== null);
const allFinite = (values: (number | null)[]) =>
  values.every((v) => v === null || Number.isFinite(v));

describe('true range and ATR', () => {
  it('true range uses the previous close', () => {
    // i0: 10-8 = 2. i1: max(12-9=3, |12-9|=3, |9-9|=0) = 3. i2: max(3, |13-11|=2, |10-11|=1) = 3.
    expect(trueRange(small())).toEqual([2, 3, 3, 3, 3, 3]);
    // A gap up: previous close 10, next candle 20..21 -> max(1, 11, 10) = 11.
    expect(trueRange([candle(0, 10, 10, 10, 1), candle(1, 21, 20, 20.5, 1)])[1]).toBe(11);
  });

  it('applies Wilder smoothing seeded with the mean of the first period', () => {
    const out = atr(small(), 3);
    // ATR[2] = (2 + 3 + 3) / 3 = 8/3; ATR[3] = (8/3 * 2 + 3) / 3 = 25/9; ATR[4] = (25/9 * 2 + 3) / 3
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).toBeCloseTo(8 / 3, 10);
    expect(out[3]).toBeCloseTo(25 / 9, 10);
    expect(out[4]).toBeCloseTo(77 / 27, 10);
    expect(out[5]).toBeCloseTo(235 / 81, 10);
  });

  it('is null until the period is filled and zero for flat prices', () => {
    expect(firstNonNull(atr(long()))).toBe(13);
    expect(atr(small(), 10).every((v) => v === null)).toBe(true);
    expect(atr(flat())[59]).toBe(0);
  });
});

describe('Ichimoku', () => {
  const options = { tenkanPeriod: 2, kijunPeriod: 3, senkouBPeriod: 4, displacement: 2 };

  it('shifts the cloud forward and the lagging span back explicitly', () => {
    const out = ichimoku(small(), options);
    // Output has candles + displacement positions so the future cloud can be drawn.
    expect(out).toHaveLength(8);
    expect(out.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // tenkan(2) at i1: (max(10,12) + min(8,9)) / 2 = (12 + 8) / 2 = 10; at i5: (14 + 9) / 2 = 11.5
    expect(out.map((p) => p.tenkan)).toEqual([null, 10, 11, 10.5, 10, 11.5, null, null]);
    // kijun(3) at i2: (13 + 8) / 2 = 10.5; at i5: (14 + 8) / 2 = 11
    expect(out.map((p) => p.kijun)).toEqual([null, null, 10.5, 10.5, 10.5, 11, null, null]);
    // senkouA raw[i] = (tenkan + kijun) / 2: i2 = (11 + 10.5) / 2 = 10.75, drawn at 2 + 2 = 4.
    expect(out.map((p) => p.senkouA)).toEqual([null, null, null, null, 10.75, 10.5, 10.25, 11.25]);
    // senkouB(4) raw[i3] = (13 + 8) / 2 = 10.5 drawn at 5; raw[i5] = (14 + 8) / 2 = 11 drawn at 7.
    expect(out.map((p) => p.senkouB)).toEqual([null, null, null, null, null, 10.5, 10.5, 11]);
    // chikou at p is the close of p + 2 (the last two positions have no future close).
    expect(out.map((p) => p.chikou)).toEqual([10, 9, 12, 13, null, null, null, null]);
  });

  it('uses 9/26/52 shifted by 26 by default and returns [] for no candles', () => {
    const out = ichimoku(long());
    expect(out).toHaveLength(126);
    expect(firstNonNull(out.map((p) => p.tenkan))).toBe(8);
    expect(firstNonNull(out.map((p) => p.kijun))).toBe(25);
    expect(firstNonNull(out.map((p) => p.senkouA))).toBe(25 + 26);
    expect(firstNonNull(out.map((p) => p.senkouB))).toBe(51 + 26);
    expect(out[99].chikou).toBeNull();
    expect(out[73].chikou).toBe(long()[99].close);
    expect(ichimoku([])).toEqual([]);
  });

  it('collapses to the price for flat candles', () => {
    const out = ichimoku(flat(), options);
    expect(out[59].tenkan).toBe(100);
    expect(out[61].senkouA).toBe(100);
    expect(out[61].senkouB).toBe(100);
  });

  it('validates parameters', () => {
    expect(() => ichimoku(small(), { tenkanPeriod: 0 })).toThrow(/tenkanPeriod/);
    expect(() => ichimoku(small(), { displacement: 1.5 })).toThrow(/positive integer/);
  });
});

describe('VWAP', () => {
  it('accumulates cumulatively for daily data', () => {
    const out = vwap(small(), { anchor: 'cumulative' });
    // TP0 = (10+8+9)/3 = 9 -> 9.
    expect(out[0]).toBeCloseTo(9, 10);
    // TP1 = (12+9+11)/3 = 32/3; pv = 9*100 + 32/3*200 = 9100/3; vol = 300 -> 9100/900.
    expect(out[1]).toBeCloseTo(9100 / 900, 10);
    // TP2 = 11; pv = 9100/3 + 11*150 = 14050/3; vol = 450 -> 14050/1350.
    expect(out[2]).toBeCloseTo(14050 / 1350, 10);
  });

  it('restarts every session for intraday data', () => {
    const candles = small().map((c, i) => ({
      ...c,
      timestamp: `2026-10-0${i < 3 ? 1 : 2}T0${9 + (i % 3)}:00:00+09:00`,
    }));
    const out = vwap(candles);
    expect(out[2]).toBeCloseTo(14050 / 1350, 10);
    // Session 2 restarts: TP3 = (11+8+9)/3 = 28/3 -> 28/3.
    expect(out[3]).toBeCloseTo(28 / 3, 10);
    // TP4 = (12+9+12)/3 = 11; pv = 28/3*300 + 11*250 = 5550; vol = 550.
    expect(out[4]).toBeCloseTo(5550 / 550, 10);
  });

  it('supports a custom session key and an anchor index', () => {
    const byPair = vwap(small(), { sessionKey: (_, i) => String(Math.floor(i / 2)) });
    // Index 2 starts a new session: its own typical price 11.
    expect(byPair[2]).toBeCloseTo(11, 10);
    const anchored = vwap(small(), { anchor: 'cumulative', anchorIndex: 3 });
    expect(anchored.slice(0, 3)).toEqual([null, null, null]);
    expect(anchored[3]).toBeCloseTo(28 / 3, 10);
  });

  it('is null while accumulated volume is zero and handles epoch timestamps', () => {
    const candles = [candle(0, 10, 10, 10, 0), candle(1, 12, 12, 12, 5)];
    expect(vwap(candles, { anchor: 'cumulative' })).toEqual([null, 12]);
    const epoch = [
      candle(0, 10, 10, 10, 1, Date.UTC(2026, 9, 1, 0, 0)),
      candle(1, 20, 20, 20, 1, Date.UTC(2026, 9, 2, 0, 0)),
    ];
    expect(vwap(epoch)).toEqual([10, 20]);
  });

  it('equals the price for flat candles and validates the anchor index', () => {
    expect(vwap(flat(), { anchor: 'cumulative' })[59]).toBe(100);
    expect(() => vwap(small(), { anchorIndex: -1 })).toThrow(/anchorIndex/);
  });
});

describe('Stochastic', () => {
  it('computes the fast variant (smoothing 1) from the window range', () => {
    const out = stochastic(small(), { kPeriod: 3, kSmoothing: 1, dPeriod: 1 });
    // i2: HH = 13, LL = 8, close 10 -> 100 * (10 - 8) / (13 - 8) = 40.
    expect(out.slice(0, 2).map((p) => p.k)).toEqual([null, null]);
    expect(out[2].k).toBeCloseTo(40, 10);
    // i3: HH 13, LL 8, close 9 -> 20; i4: close 12 -> 80; i5: HH 14, LL 8, close 13 -> 500 / 6.
    expect(out[3].k).toBeCloseTo(20, 10);
    expect(out[4].k).toBeCloseTo(80, 10);
    expect(out[5].k).toBeCloseTo(500 / 6, 10);
  });

  it('smooths %K into slow %K and %D with SMA', () => {
    const out = stochastic(small(), { kPeriod: 3, kSmoothing: 2, dPeriod: 2 });
    // slow K: i3 = (40 + 20) / 2 = 30, i4 = (20 + 80) / 2 = 50, i5 = (80 + 500/6) / 2.
    expect(out.map((p) => p.k)).toEqual([null, null, null, 30, 50, expect.closeTo(81.6667, 3)]);
    // %D: i4 = (30 + 50) / 2 = 40, i5 = (50 + 81.6667) / 2.
    expect(out[3].d).toBeNull();
    expect(out[4].d).toBeCloseTo(40, 10);
    expect(out[5].d).toBeCloseTo(65.8333, 3);
  });

  it('defaults to the slow 14/3/3 variant with the documented warm-up', () => {
    const out = stochastic(long());
    // rawK from index 13; slow %K needs 3 raw values (index 15); %D needs 3 %K (index 17).
    expect(firstNonNull(out.map((p) => p.k))).toBe(15);
    expect(firstNonNull(out.map((p) => p.d))).toBe(17);
    expect(out.every((p) => (p.k ?? 0) >= 0 && (p.k ?? 0) <= 100)).toBe(true);
  });

  it('returns the neutral 50 for flat prices and validates parameters', () => {
    const out = stochastic(flat());
    expect(out[59]).toEqual({ k: 50, d: 50 });
    expect(() => stochastic(small(), { kPeriod: 0 })).toThrow(/kPeriod/);
    expect(() => stochastic(small(), { dPeriod: -2 })).toThrow(/dPeriod/);
  });
});

describe('OBV', () => {
  it('adds volume on rises, subtracts on falls, keeps equal closes', () => {
    // 0; 11 > 9: +200 = 200; 10 < 11: -150 = 50; 9 < 10: -300 = -250; 12 > 9: +250 = 0; +100.
    expect(obv(small())).toEqual([0, 200, 50, -250, 0, 100]);
    expect(obv([candle(0, 1, 1, 5, 10), candle(1, 1, 1, 5, 99)])).toEqual([0, 0]);
  });

  it('is zero for flat prices and empty for no candles', () => {
    expect(obv(flat()).every((v) => v === 0)).toBe(true);
    expect(obv([])).toEqual([]);
  });
});

describe('Parabolic SAR', () => {
  it('follows Wilder with acceleration steps, clamping and reversals', () => {
    const out = parabolicSar(small());
    // Start: close1 11 >= close0 9 -> up; SAR = low0 = 8, EP = high0 = 10, AF = 0.02.
    // i1: 8 + 0.02 * (10 - 8) = 8.04, clamped to low0 = 8; new EP 12, AF 0.04.
    // i2: 8 + 0.04 * (12 - 8) = 8.16, clamped to min(low1 9, low0 8) = 8; new EP 13, AF 0.06.
    // i3: 8 + 0.06 * (13 - 8) = 8.3; low 8 < 8.3 -> reversal: SAR = old EP 13, EP = 8, AF = 0.02.
    // i4: 13 + 0.02 * (8 - 13) = 12.9, clamped to max(high3 11, high2 13) = 13; no cross.
    // i5: 13 + 0.02 * (8 - 13) = 12.9 (high4 12, high3 11); high 14 > 12.9 -> reversal to 8.
    expect(out.map((p) => p.sar)).toEqual([null, 8, 8, 13, 13, 8]);
    expect(out.map((p) => p.trend)).toEqual([null, 'up', 'up', 'down', 'down', 'up']);
  });

  it('caps the acceleration factor at max', () => {
    // A steady climb: highs rise by 1 each candle, lows stay safely above the SAR.
    const climb = Array.from({ length: 12 }, (_, i) => candle(i, 11 + i, 10 + i, 10.5 + i, 1));
    const capped = parabolicSar(climb, { step: 0.1, increment: 0.1, max: 0.2 });
    const uncapped = parabolicSar(climb, { step: 0.1, increment: 0.1, max: 1 });
    expect(capped[11].sar).toBeLessThan(uncapped[11].sar as number);
    expect(capped.every((p) => p.sar === null || Number.isFinite(p.sar))).toBe(true);
  });

  it('is null for fewer than two candles and stays on the price for flat candles', () => {
    expect(parabolicSar([candle(0, 1, 1, 1, 1)])).toEqual([{ sar: null, trend: null }]);
    expect(parabolicSar(flat())[59]).toEqual({ sar: 100, trend: 'up' });
  });

  it('validates parameters', () => {
    expect(() => parabolicSar(small(), { step: 0 })).toThrow(/step/);
    expect(() => parabolicSar(small(), { increment: -0.1 })).toThrow(/increment/);
    expect(() => parabolicSar(small(), { max: Number.NaN })).toThrow(/max/);
    expect(() => parabolicSar(small(), { step: 0.3, max: 0.2 })).toThrow(/max must be >= step/);
  });
});

describe('ADX', () => {
  it('computes +DI, -DI and ADX with Wilder smoothing', () => {
    const out = adx(small(), 2);
    // TR = [2, 3, 3, 3, 3, 3]; +DM[1..5] = 2, 1, 0, 1, 2; -DM[1..5] = 0, 0, 2, 0, 0.
    // i2: sTR = 3 + 3 = 6, s+DM = 2 + 1 = 3, s-DM = 0 -> +DI = 50, -DI = 0, DX = 100.
    expect(out[1]).toEqual({ plusDI: null, minusDI: null, adx: null });
    expect(out[2].plusDI).toBeCloseTo(50, 10);
    expect(out[2].minusDI).toBeCloseTo(0, 10);
    expect(out[2].adx).toBeNull();
    // i3: sTR = 6 - 3 + 3 = 6, s+DM = 3 - 1.5 + 0 = 1.5, s-DM = 0 + 2 = 2
    //   -> +DI = 25, -DI = 33.333, DX = 100 * 8.333 / 58.333 = 14.2857; ADX = (100 + 14.2857) / 2.
    expect(out[3].plusDI).toBeCloseTo(25, 10);
    expect(out[3].minusDI).toBeCloseTo(100 / 3, 10);
    expect(out[3].adx).toBeCloseTo((100 + 100 / 7) / 2, 10);
    // i4: s+DM = 1.5 - 0.75 + 1 = 1.75, s-DM = 2 - 1 = 1 -> DX = 100 * 12.5 / 45.8333 = 300/11.
    expect(out[4].adx).toBeCloseTo(((100 + 100 / 7) / 2 + 300 / 11) / 2, 10);
    // i5: s+DM = 1.75 - 0.875 + 2 = 2.875, s-DM = 0.5 -> DX = 100 * 39.5833 / 56.25.
    const dx5 = (100 * (2.875 / 6 - 0.5 / 6)) / (2.875 / 6 + 0.5 / 6);
    expect(out[5].adx).toBeCloseTo((((100 + 100 / 7) / 2 + 300 / 11) / 2 + dx5) / 2, 10);
  });

  it('has DI after period candles and ADX after 2 * period - 1 candles', () => {
    const out = adx(long());
    expect(firstNonNull(out.map((p) => p.plusDI))).toBe(14);
    expect(firstNonNull(out.map((p) => p.adx))).toBe(27);
    expect(out.every((p) => (p.adx ?? 0) >= 0 && (p.adx ?? 0) <= 100)).toBe(true);
  });

  it('returns nulls for short input and zeros (not NaN) for flat prices', () => {
    expect(adx(small(), 14).every((p) => p.adx === null && p.plusDI === null)).toBe(true);
    expect(adx(flat())[59]).toEqual({ plusDI: 0, minusDI: 0, adx: 0 });
    expect(() => adx(small(), 0)).toThrow(/period/);
  });
});

describe('CCI', () => {
  it('uses the mean deviation and the 0.015 constant', () => {
    const out = cci(small(), 3);
    // TP = [9, 32/3, 11]; mean = 92/9; |dev| = [11/9, 4/9, 7/9] -> MD = 22/27;
    // CCI = (11 - 92/9) / (0.015 * 22/27) = (7/9) / (0.015 * 22/27) = 63.636...
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).toBeCloseTo(7 / 9 / (0.015 * (22 / 27)), 10);
    expect(out[2]).toBeCloseTo(63.6364, 3);
  });

  it('allows a custom constant, is null before the window is full and 0 for flat prices', () => {
    expect(cci(small(), 3, 0.03)[2]).toBeCloseTo(63.6364 / 2, 3);
    expect(firstNonNull(cci(long()))).toBe(19);
    expect(cci(flat())[59]).toBe(0);
  });

  it('validates parameters', () => {
    expect(() => cci(small(), 0)).toThrow(/period/);
    expect(() => cci(small(), 20, 0)).toThrow(/constant/);
  });
});

describe('Keltner channel', () => {
  it('uses an SMA-seeded EMA and Wilder ATR', () => {
    const out = keltner(small(), { emaPeriod: 3, atrPeriod: 4, multiplier: 2 });
    // EMA(3) seed at i2 = (9 + 11 + 10) / 3 = 10, k = 0.5, i3 = 9 * 0.5 + 10 * 0.5 = 9.5.
    // ATR(4) at i3 = (2 + 3 + 3 + 3) / 4 = 2.75 -> upper = 9.5 + 2 * 2.75 = 15, lower = 4.
    expect(out.slice(0, 3).every((p) => p.middle === null && p.upper === null)).toBe(true);
    expect(out[3]).toEqual({ middle: 9.5, upper: 15, lower: 4 });
    // i4: EMA = 12 * 0.5 + 9.5 * 0.5 = 10.75, ATR = (2.75 * 3 + 3) / 4 = 2.8125 -> upper 16.375.
    expect(out[4].middle).toBeCloseTo(10.75, 10);
    expect(out[4].upper).toBeCloseTo(10.75 + 2 * 2.8125, 10);
  });

  it('starts at max(emaPeriod, atrPeriod) - 1 with the defaults and is flat for flat prices', () => {
    expect(firstNonNull(keltner(long()).map((p) => p.middle))).toBe(19);
    const last = keltner(flat())[59];
    expect(last).toEqual({ middle: 100, upper: 100, lower: 100 });
  });

  it('validates parameters', () => {
    expect(() => keltner(small(), { emaPeriod: 0 })).toThrow(/emaPeriod/);
    expect(() => keltner(small(), { atrPeriod: 2.5 })).toThrow(/atrPeriod/);
    expect(() => keltner(small(), { multiplier: 0 })).toThrow(/multiplier/);
  });
});

describe('Fibonacci retracement', () => {
  it('draws levels down from the high after an up move', () => {
    const result = fibonacciRetracement(small());
    // Window high 14 (index 5), low 8 (first at index 0): low first -> 'up', range 6.
    expect(result).toMatchObject({ direction: 'up', high: 14, low: 8, highIndex: 5, lowIndex: 0 });
    // 14 - 0.236 * 6 = 12.584; 14 - 0.382 * 6 = 11.708; 14 - 0.5 * 6 = 11; 14 - 0.618 * 6 = 10.292
    expect(result?.levels.map((l) => l.label)).toEqual([
      '0%',
      '23.6%',
      '38.2%',
      '50%',
      '61.8%',
      '78.6%',
      '100%',
    ]);
    const prices = result?.levels.map((l) => l.price) ?? [];
    expect(prices[0]).toBe(14);
    expect(prices[1]).toBeCloseTo(12.584, 10);
    expect(prices[2]).toBeCloseTo(11.708, 10);
    expect(prices[3]).toBe(11);
    expect(prices[4]).toBeCloseTo(10.292, 10);
    expect(prices[5]).toBeCloseTo(9.284, 10);
    expect(prices[6]).toBe(8);
  });

  it('draws levels up from the low after a down move', () => {
    const down = [candle(0, 14, 11, 12, 1), candle(1, 12, 9, 10, 1), candle(2, 10, 8, 9, 1)];
    const result = fibonacciRetracement(down);
    expect(result?.direction).toBe('down');
    // 8 + 0.382 * 6 = 10.292 and 100% is the high.
    expect(result?.levels[0].price).toBe(8);
    expect(result?.levels[2].price).toBeCloseTo(10.292, 10);
    expect(result?.levels[6].price).toBe(14);
  });

  it('limits the window to the latest candles and honours an explicit direction', () => {
    const windowed = fibonacciRetracement(small(), { window: 3 });
    // Indices 3..5: highs 11, 12, 14; lows 8, 9, 11 -> high 14 (index 5), low 8 (index 3).
    expect(windowed).toMatchObject({ startIndex: 3, highIndex: 5, lowIndex: 3, direction: 'up' });
    expect(fibonacciRetracement(small(), { direction: 'down' })?.levels[0].price).toBe(8);
    expect(fibonacciRetracement(small(), { window: 100 })?.startIndex).toBe(0);
  });

  it('handles empty windows, flat prices and custom ratios', () => {
    expect(fibonacciRetracement([])).toBeNull();
    const flatResult = fibonacciRetracement(flat());
    expect(flatResult?.direction).toBe('up');
    expect(flatResult?.levels.every((l) => l.price === 100)).toBe(true);
    expect(fibonacciLevels(20, 10, 'up', [0.5]).map((l) => l.price)).toEqual([15]);
  });

  it('validates parameters', () => {
    expect(() => fibonacciRetracement(small(), { window: 0 })).toThrow(/window/);
    expect(() => fibonacciRetracement(small(), { ratios: [1.5] })).toThrow(/ratio/);
    expect(() => fibonacciRetracement(small(), { ratios: [-0.1] })).toThrow(/ratio/);
    expect(() =>
      fibonacciRetracement(small(), { direction: 'sideways' as unknown as 'up' }),
    ).toThrow(/direction/);
  });
});

describe('shared guarantees', () => {
  const sampleOutputs = (candles: IndicatorCandle[]) => ({
    atr: atr(candles),
    vwap: vwap(candles),
    obv: obv(candles),
    cci: cci(candles),
    stochasticK: stochastic(candles).map((p) => p.k),
    stochasticD: stochastic(candles).map((p) => p.d),
    sar: parabolicSar(candles).map((p) => p.sar),
    plusDI: adx(candles).map((p) => p.plusDI),
    minusDI: adx(candles).map((p) => p.minusDI),
    adx: adx(candles).map((p) => p.adx),
    keltner: keltner(candles).map((p) => p.upper),
  });

  it('returns series with the input length and no NaN or Infinity', () => {
    for (const candles of [long(), flat(), small(), []]) {
      for (const series of Object.values(sampleOutputs(candles))) {
        expect(series).toHaveLength(candles.length);
        expect(allFinite(series)).toBe(true);
      }
      const cloud = ichimoku(candles);
      expect(cloud).toHaveLength(candles.length ? candles.length + 26 : 0);
      for (const key of ['tenkan', 'kijun', 'senkouA', 'senkouB', 'chikou'] as const) {
        expect(allFinite(cloud.map((p) => p[key]))).toBe(true);
      }
    }
  });

  it('does not mutate its input', () => {
    const candles = long(60);
    const snapshot = structuredClone(candles);
    candles.forEach(Object.freeze);
    Object.freeze(candles);
    ichimoku(candles);
    vwap(candles);
    vwap(candles, { anchor: 'cumulative' });
    stochastic(candles);
    atr(candles);
    obv(candles);
    parabolicSar(candles);
    adx(candles);
    cci(candles);
    keltner(candles);
    fibonacciRetracement(candles);
    expect(candles).toEqual(snapshot);
  });

  it('is deterministic', () => {
    expect(sampleOutputs(long())).toEqual(sampleOutputs(long()));
  });

  it('rejects non-integer, zero, negative and NaN periods consistently', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => atr(small(), bad)).toThrow(/period must be a positive integer/);
      expect(() => adx(small(), bad)).toThrow(/period must be a positive integer/);
      expect(() => cci(small(), bad)).toThrow(/period must be a positive integer/);
    }
  });
});

describe('indicator descriptions', () => {
  const expectedIds = [
    'sma',
    'ema',
    'bollinger',
    'rsi',
    'macd',
    'ichimoku',
    'vwap',
    'stochastic',
    'atr',
    'obv',
    'parabolicSar',
    'adx',
    'cci',
    'keltner',
    'fibonacci',
  ];

  it('covers every existing and new indicator', () => {
    expect([...indicatorIds].sort()).toEqual([...expectedIds].sort());
    for (const id of indicatorIds) expect(indicatorDescriptions[id].id).toBe(id);
  });

  it('has Korean tooltips of two to three sentences and default parameters', () => {
    for (const description of Object.values(indicatorDescriptions)) {
      const sentences = description.tooltip.match(/[.!?](\s|$)/g) ?? [];
      expect(sentences.length, description.id).toBeGreaterThanOrEqual(2);
      expect(sentences.length, description.id).toBeLessThanOrEqual(3);
      expect(description.tooltip, description.id).toMatch(/[가-힣]/);
      expect(description.name, description.id).toMatch(/[가-힣]|MACD/);
      expect(description.defaultParams.length, description.id).toBeGreaterThan(0);
    }
  });

  it('avoids buy/sell advice wording', () => {
    for (const description of Object.values(indicatorDescriptions)) {
      expect(description.tooltip, description.id).not.toMatch(
        /(매수|매도|사|팔)(하세요|하십시오|하라|해야|하는 것이 좋)/,
      );
    }
  });

  it('marks price-pane overlays versus separate panes', () => {
    const price = [
      'sma',
      'ema',
      'bollinger',
      'ichimoku',
      'vwap',
      'parabolicSar',
      'keltner',
      'fibonacci',
    ];
    const separate = ['rsi', 'macd', 'stochastic', 'atr', 'obv', 'adx', 'cci'];
    for (const id of price)
      expect(indicatorDescriptions[id as keyof typeof indicatorDescriptions].pane).toBe('price');
    for (const id of separate)
      expect(indicatorDescriptions[id as keyof typeof indicatorDescriptions].pane).toBe('separate');
  });
});
