import { assertNumberInRange, assertPositiveInteger, type IndicatorCandle } from './common';

export const defaultFibonacciRatios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

export type FibonacciDirection = 'up' | 'down';

export type FibonacciLevel = { ratio: number; label: string; price: number };

export type FibonacciRetracement = {
  /** 'up': swing low came first and the retracement falls from the high; 'down': the reverse. */
  direction: FibonacciDirection;
  high: number;
  low: number;
  /** Candle indices (in the original array) of the first candle that made the window high / low. */
  highIndex: number;
  lowIndex: number;
  /** Index of the first candle of the analysed window. */
  startIndex: number;
  levels: FibonacciLevel[];
};

export type FibonacciOptions = {
  /** Use only the latest `window` candles; default: all candles. */
  window?: number;
  /** 'auto' (default) infers the direction from which extreme came first. */
  direction?: FibonacciDirection | 'auto';
  /** Retracement ratios between 0 and 1. */
  ratios?: readonly number[];
};

/** Price levels for a given swing. Ratio 0 is the end of the move, ratio 1 its start. */
export function fibonacciLevels(
  high: number,
  low: number,
  direction: FibonacciDirection,
  ratios: readonly number[] = defaultFibonacciRatios,
): FibonacciLevel[] {
  ratios.forEach((r) => assertNumberInRange('fibonacci', 'ratio', r, 0, 1));
  const range = high - low;
  return ratios.map((ratio) => ({
    ratio,
    label: `${Number((ratio * 100).toFixed(1))}%`,
    price: direction === 'up' ? high - ratio * range : low + ratio * range,
  }));
}

/**
 * Fibonacci retracement over the high/low of a window. Uptrend (low before high): 0% = high,
 * 100% = low, levels fall from the high. Downtrend (high before low): 0% = low, 100% = high,
 * levels rise from the low. The first candle holding an extreme is used when it repeats. If both
 * extremes fall on one candle (single candle or flat prices) the direction defaults to 'up' and
 * every level equals that price. Returns null for an empty window.
 */
export function fibonacciRetracement(
  candles: IndicatorCandle[],
  options: FibonacciOptions = {},
): FibonacciRetracement | null {
  const { window, direction = 'auto', ratios = defaultFibonacciRatios } = options;
  if (window !== undefined) assertPositiveInteger('fibonacci', 'window', window);
  if (direction !== 'auto' && direction !== 'up' && direction !== 'down')
    throw new Error(`fibonacci: direction must be 'auto', 'up' or 'down' (got ${direction})`);
  ratios.forEach((r) => assertNumberInRange('fibonacci', 'ratio', r, 0, 1));
  const startIndex = window === undefined ? 0 : Math.max(0, candles.length - window);
  const slice = candles.slice(startIndex);
  if (!slice.length) return null;
  let highIndex = 0;
  let lowIndex = 0;
  slice.forEach((c, i) => {
    if (c.high > slice[highIndex].high) highIndex = i;
    if (c.low < slice[lowIndex].low) lowIndex = i;
  });
  const high = slice[highIndex].high;
  const low = slice[lowIndex].low;
  const resolved: FibonacciDirection =
    direction === 'auto' ? (highIndex < lowIndex ? 'down' : 'up') : direction;
  return {
    direction: resolved,
    high,
    low,
    highIndex: startIndex + highIndex,
    lowIndex: startIndex + lowIndex,
    startIndex,
    levels: fibonacciLevels(high, low, resolved, ratios),
  };
}
