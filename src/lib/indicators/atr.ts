import { assertPositiveInteger, type IndicatorCandle, type Series } from './common';

/**
 * True range: max(high-low, |high-prevClose|, |low-prevClose|). The first candle has no previous
 * close, so its true range is high-low.
 */
export function trueRange(candles: IndicatorCandle[]): number[] {
  return candles.map((c, i) =>
    i === 0
      ? c.high - c.low
      : Math.max(
          c.high - c.low,
          Math.abs(c.high - candles[i - 1].close),
          Math.abs(c.low - candles[i - 1].close),
        ),
  );
}

/**
 * Average True Range with Wilder smoothing. The first value (index period-1) is the simple mean of
 * the first `period` true ranges (including the first candle's high-low); afterwards
 * ATR[i] = (ATR[i-1] * (period-1) + TR[i]) / period. Earlier positions are null. Flat prices give 0.
 */
export function atr(candles: IndicatorCandle[], period = 14): Series {
  assertPositiveInteger('atr', 'period', period);
  const tr = trueRange(candles);
  const out: Series = tr.map(() => null);
  if (tr.length < period) return out;
  let prev = tr.slice(0, period).reduce((a, v) => a + v, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < tr.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}
