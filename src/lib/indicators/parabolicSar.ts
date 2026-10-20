import { assertNumberInRange, type IndicatorCandle, type Series } from './common';

export type ParabolicSarOptions = {
  /** Initial acceleration factor. */
  step?: number;
  /** Increase applied each time a new extreme point is made. */
  increment?: number;
  /** Upper bound of the acceleration factor. */
  max?: number;
};

export type ParabolicSarPoint = { sar: number | null; trend: 'up' | 'down' | null };

/**
 * Wilder's Parabolic SAR (0.02 / 0.02 / 0.2). Index 0 is null (a trend needs two candles). The
 * initial trend is up when close[1] >= close[0] (so a flat start counts as up), with the initial
 * SAR at the first candle's low (up) or high (down) and the extreme point at its high (up) or low
 * (down). Each step: SAR += AF * (EP - SAR), clamped to the lows (up) / highs (down) of the two
 * previous candles; a candle that crosses the SAR flips the trend, sets SAR to the old extreme
 * point and resets AF to `step`; a new extreme raises AF by `increment` up to `max`. `trend` tells
 * which side of the price the dot is drawn on. No division, so flat prices need no special case.
 */
export function parabolicSar(
  candles: IndicatorCandle[],
  options: ParabolicSarOptions = {},
): ParabolicSarPoint[] {
  const { step = 0.02, increment = 0.02, max = 0.2 } = options;
  assertNumberInRange('parabolicSar', 'step', step, 0, 1, true);
  assertNumberInRange('parabolicSar', 'increment', increment, 0, 1, true);
  assertNumberInRange('parabolicSar', 'max', max, 0, 1, true);
  if (max < step)
    throw new Error(`parabolicSar: max must be >= step (got max ${max}, step ${step})`);
  const out: ParabolicSarPoint[] = candles.map(() => ({ sar: null, trend: null }));
  if (candles.length < 2) return out;
  let up = candles[1].close >= candles[0].close;
  let sar = up ? candles[0].low : candles[0].high;
  let ep = up ? candles[0].high : candles[0].low;
  let af = step;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    let next = sar + af * (ep - sar);
    if (up) {
      next = Math.min(next, candles[i - 1].low, i >= 2 ? candles[i - 2].low : Infinity);
      if (c.low < next) {
        up = false;
        next = ep;
        ep = c.low;
        af = step;
      } else if (c.high > ep) {
        ep = c.high;
        af = Math.min(af + increment, max);
      }
    } else {
      next = Math.max(next, candles[i - 1].high, i >= 2 ? candles[i - 2].high : -Infinity);
      if (c.high > next) {
        up = true;
        next = ep;
        ep = c.high;
        af = step;
      } else if (c.low < ep) {
        ep = c.low;
        af = Math.min(af + increment, max);
      }
    }
    sar = next;
    out[i] = { sar, trend: up ? 'up' : 'down' };
  }
  return out;
}

/** Convenience projection for charts that only draw the dots. */
export const parabolicSarValues = (points: ParabolicSarPoint[]): Series => points.map((p) => p.sar);
