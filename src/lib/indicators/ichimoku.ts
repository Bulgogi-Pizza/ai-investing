import {
  assertPositiveInteger,
  rollingMax,
  rollingMin,
  type IndicatorCandle,
  type Series,
} from './common';

export type IchimokuOptions = {
  tenkanPeriod?: number;
  kijunPeriod?: number;
  senkouBPeriod?: number;
  /** Forward shift of the cloud and backward shift of the lagging span. */
  displacement?: number;
};

/**
 * One drawing position. Positions 0..n-1 line up with the input candles; the last `displacement`
 * positions are future positions (no candle yet) that only carry the cloud (senkouA/senkouB).
 */
export type IchimokuPoint = {
  /** Candle index this position aligns with; `>= candles.length` for future positions. */
  index: number;
  tenkan: number | null;
  kijun: number | null;
  /** Leading span A as drawn at this position (already shifted forward by `displacement`). */
  senkouA: number | null;
  /** Leading span B as drawn at this position (already shifted forward by `displacement`). */
  senkouB: number | null;
  /** Lagging span as drawn at this position: the close of `index + displacement`. */
  chikou: number | null;
};

const midpoint = (high: Series, low: Series): Series =>
  high.map((h, i) => (h === null || low[i] === null ? null : (h + (low[i] as number)) / 2));

/**
 * Ichimoku Kinko Hyo. tenkan = (highest high + lowest low) / 2 over 9; kijun likewise over 26;
 * senkouA = (tenkan + kijun) / 2 and senkouB = midpoint over 52, both drawn `displacement` (26)
 * positions to the right; chikou = close drawn `displacement` positions to the left.
 *
 * The result has length `candles.length + displacement` (empty for no candles) so the future cloud
 * is explicit. Positions without a value (warm-up, no future close for chikou, no candle yet for
 * tenkan/kijun) are null. Flat prices need no special case (midpoints of equal values).
 */
export function ichimoku(
  candles: IndicatorCandle[],
  options: IchimokuOptions = {},
): IchimokuPoint[] {
  const { tenkanPeriod = 9, kijunPeriod = 26, senkouBPeriod = 52, displacement = 26 } = options;
  assertPositiveInteger('ichimoku', 'tenkanPeriod', tenkanPeriod);
  assertPositiveInteger('ichimoku', 'kijunPeriod', kijunPeriod);
  assertPositiveInteger('ichimoku', 'senkouBPeriod', senkouBPeriod);
  assertPositiveInteger('ichimoku', 'displacement', displacement);
  const n = candles.length;
  if (n === 0) return [];
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const tenkan = midpoint(rollingMax(highs, tenkanPeriod), rollingMin(lows, tenkanPeriod));
  const kijun = midpoint(rollingMax(highs, kijunPeriod), rollingMin(lows, kijunPeriod));
  const rawA: Series = tenkan.map((t, i) =>
    t === null || kijun[i] === null ? null : (t + (kijun[i] as number)) / 2,
  );
  const rawB = midpoint(rollingMax(highs, senkouBPeriod), rollingMin(lows, senkouBPeriod));
  return Array.from({ length: n + displacement }, (_, i) => ({
    index: i,
    tenkan: i < n ? tenkan[i] : null,
    kijun: i < n ? kijun[i] : null,
    senkouA: i - displacement >= 0 ? rawA[i - displacement] : null,
    senkouB: i - displacement >= 0 ? rawB[i - displacement] : null,
    chikou: i + displacement < n ? candles[i + displacement].close : null,
  }));
}
