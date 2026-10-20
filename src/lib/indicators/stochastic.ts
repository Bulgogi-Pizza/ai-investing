import {
  assertPositiveInteger,
  rollingMax,
  rollingMin,
  smaSeries,
  type IndicatorCandle,
  type Series,
} from './common';

export type StochasticOptions = {
  kPeriod?: number;
  /** %K smoothing: 3 gives the slow stochastic (default); 1 gives the fast stochastic. */
  kSmoothing?: number;
  dPeriod?: number;
};

export type StochasticPoint = { k: number | null; d: number | null };

/**
 * Slow stochastic oscillator (14, 3, 3). rawK = 100 * (close - lowestLow) / (highestHigh -
 * lowestLow) over `kPeriod`; %K = SMA(rawK, kSmoothing); %D = SMA(%K, dPeriod). With
 * kSmoothing = 1 this is the fast stochastic. Output is bounded to 0..100; positions without a
 * full window are null. When the window range is 0 (flat prices) rawK is the neutral 50, the
 * same neutral value market.ts uses for a flat RSI.
 */
export function stochastic(
  candles: IndicatorCandle[],
  options: StochasticOptions = {},
): StochasticPoint[] {
  const { kPeriod = 14, kSmoothing = 3, dPeriod = 3 } = options;
  assertPositiveInteger('stochastic', 'kPeriod', kPeriod);
  assertPositiveInteger('stochastic', 'kSmoothing', kSmoothing);
  assertPositiveInteger('stochastic', 'dPeriod', dPeriod);
  const hh = rollingMax(
    candles.map((c) => c.high),
    kPeriod,
  );
  const ll = rollingMin(
    candles.map((c) => c.low),
    kPeriod,
  );
  const rawK: Series = candles.map((c, i) => {
    const high = hh[i];
    const low = ll[i];
    if (high === null || low === null) return null;
    return high === low ? 50 : (100 * (c.close - low)) / (high - low);
  });
  const k = smaSeries(rawK, kSmoothing);
  const d = smaSeries(k, dPeriod);
  return k.map((value, i) => ({ k: value, d: d[i] }));
}
