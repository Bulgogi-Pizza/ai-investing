import type { IndicatorCandle } from './common';

/**
 * On-Balance Volume. OBV[0] = 0 (only changes are meaningful, so the absolute level depends on the
 * start of the supplied history); then +volume when the close rises, -volume when it falls and
 * unchanged when the close is equal. No warm-up, so the result never contains null.
 */
export function obv(candles: IndicatorCandle[]): number[] {
  let total = 0;
  return candles.map((c, i) => {
    if (i > 0) {
      const prev = candles[i - 1].close;
      if (c.close > prev) total += c.volume;
      else if (c.close < prev) total -= c.volume;
    }
    return total;
  });
}
