import {
  assertNumberInRange,
  assertPositiveInteger,
  typicalPrice,
  type IndicatorCandle,
  type Series,
} from './common';

/**
 * Commodity Channel Index. TP = (high + low + close) / 3; CCI = (TP - SMA(TP, period)) /
 * (constant * meanDeviation), where meanDeviation is the mean of |TP - SMA| over the same window
 * (not the standard deviation) and `constant` defaults to 0.015. Null before the window is full.
 * Flat prices have meanDeviation 0; the result is defined as 0 (TP equals its average).
 */
export function cci(candles: IndicatorCandle[], period = 20, constant = 0.015): Series {
  assertPositiveInteger('cci', 'period', period);
  assertNumberInRange('cci', 'constant', constant, 0, Infinity, true);
  const tp = candles.map(typicalPrice);
  return tp.map((value, i) => {
    if (i < period - 1) return null;
    const window = tp.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, v) => a + v, 0) / period;
    const deviation = window.reduce((a, v) => a + Math.abs(v - mean), 0) / period;
    return deviation === 0 ? 0 : (value - mean) / (constant * deviation);
  });
}
