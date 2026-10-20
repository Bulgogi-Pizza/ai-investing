import { atr } from './atr';
import {
  assertNumberInRange,
  assertPositiveInteger,
  emaSeeded,
  type IndicatorCandle,
} from './common';

export type KeltnerOptions = {
  emaPeriod?: number;
  atrPeriod?: number;
  multiplier?: number;
};

export type KeltnerPoint = { middle: number | null; upper: number | null; lower: number | null };

/**
 * Keltner channel: middle = EMA(close, 20), upper/lower = middle +/- 2 * ATR(10). The EMA is seeded
 * with the SMA of the first `emaPeriod` closes and ATR uses Wilder smoothing (see atr.ts), so a
 * position is null until both are available (index max(emaPeriod, atrPeriod) - 1). Flat prices give
 * ATR 0 and a zero-width channel.
 */
export function keltner(candles: IndicatorCandle[], options: KeltnerOptions = {}): KeltnerPoint[] {
  const { emaPeriod = 20, atrPeriod = 10, multiplier = 2 } = options;
  assertPositiveInteger('keltner', 'emaPeriod', emaPeriod);
  assertPositiveInteger('keltner', 'atrPeriod', atrPeriod);
  assertNumberInRange('keltner', 'multiplier', multiplier, 0, Infinity, true);
  const middle = emaSeeded(
    candles.map((c) => c.close),
    emaPeriod,
  );
  const range = atr(candles, atrPeriod);
  return middle.map((m, i) => {
    const a = range[i];
    return m === null || a === null
      ? { middle: null, upper: null, lower: null }
      : { middle: m, upper: m + multiplier * a, lower: m - multiplier * a };
  });
}
