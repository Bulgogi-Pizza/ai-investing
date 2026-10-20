import { typicalPrice, type IndicatorCandle, type Series } from './common';

export type VwapOptions = {
  /**
   * 'session' (default): restart the accumulation whenever the session key changes; intended for
   * intraday candles. 'cumulative': one accumulation from `anchorIndex` (default 0); intended for
   * daily candles, where a per-day reset would make VWAP equal to each day's typical price.
   */
  anchor?: 'session' | 'cumulative';
  /**
   * Session identifier for 'session' anchoring. Default: the date part (first 10 characters) of an
   * ISO timestamp as written by the provider, or the UTC date for epoch-millisecond timestamps.
   * Pass a custom function for exchange-specific sessions (for example US sessions that cross
   * midnight in KST).
   */
  sessionKey?: (candle: IndicatorCandle, index: number) => string;
  /** First candle index of the 'cumulative' accumulation; earlier positions are null. */
  anchorIndex?: number;
};

export function defaultSessionKey(candle: IndicatorCandle): string {
  return typeof candle.timestamp === 'string'
    ? candle.timestamp.slice(0, 10)
    : new Date(candle.timestamp).toISOString().slice(0, 10);
}

/**
 * Volume-weighted average price: cumsum(typicalPrice * volume) / cumsum(volume), where
 * typicalPrice = (high + low + close) / 3. Positions before the anchor, and positions where the
 * accumulated volume is still 0, are null (the ratio is undefined; no price is invented).
 */
export function vwap(candles: IndicatorCandle[], options: VwapOptions = {}): Series {
  const { anchor = 'session', sessionKey = defaultSessionKey, anchorIndex = 0 } = options;
  if (!Number.isInteger(anchorIndex) || anchorIndex < 0)
    throw new Error(`vwap: anchorIndex must be a non-negative integer (got ${anchorIndex})`);
  let pv = 0;
  let vol = 0;
  let key: string | undefined;
  return candles.map((c, i) => {
    if (anchor === 'cumulative') {
      if (i < anchorIndex) return null;
    } else {
      const next = sessionKey(c, i);
      if (next !== key) {
        key = next;
        pv = 0;
        vol = 0;
      }
    }
    pv += typicalPrice(c) * c.volume;
    vol += c.volume;
    return vol > 0 ? pv / vol : null;
  });
}
