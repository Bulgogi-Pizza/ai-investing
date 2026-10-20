/**
 * Shared types and helpers for the additional indicators. Pure and deterministic; inputs are
 * never mutated. Warm-up positions are always `null`, never 0 or NaN. Callers must pass candles
 * ordered oldest first with finite numeric prices (the server already validates provider data).
 */
export type IndicatorCandle = {
  /** ISO-8601 string (as returned by the candles API) or epoch milliseconds. */
  timestamp: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Series = (number | null)[];

export function assertPositiveInteger(fn: string, name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${fn}: ${name} must be a positive integer (got ${value})`);
}

/** Finite number inside the range; `exclusiveMin` rejects a value equal to `min`. */
export function assertNumberInRange(
  fn: string,
  name: string,
  value: number,
  min: number,
  max: number,
  exclusiveMin = false,
): void {
  const belowMin = exclusiveMin ? value <= min : value < min;
  if (!Number.isFinite(value) || belowMin || value > max)
    throw new Error(
      `${fn}: ${name} must be a finite number ${exclusiveMin ? '>' : '>='} ${min} and <= ${max} (got ${value})`,
    );
}

/** Highest value of `values[i - period + 1..i]`, null before the window is full. */
export function rollingMax(values: number[], period: number): Series {
  return values.map((_, i) =>
    i < period - 1 ? null : Math.max(...values.slice(i - period + 1, i + 1)),
  );
}

export function rollingMin(values: number[], period: number): Series {
  return values.map((_, i) =>
    i < period - 1 ? null : Math.min(...values.slice(i - period + 1, i + 1)),
  );
}

/** Simple moving average over a series that may contain warm-up nulls; any null in window -> null. */
export function smaSeries(values: Series, period: number): Series {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (v === null) return null;
      sum += v;
    }
    return sum / period;
  });
}

/**
 * EMA seeded with the SMA of the first `period` values (first value at index `period - 1`), so it
 * has an explicit warm-up. This differs from market.ts `ema`, which seeds with the first value.
 */
export function emaSeeded(values: number[], period: number): Series {
  const k = 2 / (period + 1);
  const out: Series = values.map(() => null);
  if (values.length < period) return out;
  let prev = values.slice(0, period).reduce((a, v) => a + v, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export const typicalPrice = (c: IndicatorCandle): number => (c.high + c.low + c.close) / 3;
