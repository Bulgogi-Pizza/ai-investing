import { adx, type IndicatorCandle } from '../indicators';
import { rsi } from '../market';
import type {
  DailyBar,
  MeanReversionParams,
  MomentumParams,
  SignalId,
  SignalParams,
  TrendParams,
  ValueParams,
  ValueSnapshot,
} from './types';

export const defaultSignalParams: SignalParams = {
  trend: {
    fastPeriod: 20,
    slowPeriod: 50,
    crossScale: 0.05,
    priceScale: 0.1,
    adxPeriod: 14,
    adxFull: 40,
  },
  momentum: { lookbackDays: 60, scale: 0.2 },
  meanReversion: { rsiPeriod: 14, bbPeriod: 20, bbK: 2, rsiScale: 30 },
  value: { window: 12, minHistory: 4, maxAgeDays: 400 },
};

export const clampScore = (x: number): number => Math.max(-1, Math.min(1, x));

const lastN = <T>(items: T[], n: number): T[] => items.slice(Math.max(0, items.length - n));
const mean = (values: number[]): number => values.reduce((a, v) => a + v, 0) / values.length;

export const isoDate = (value: string): string => value.slice(0, 10);

export function daysBetween(from: string, to: string): number {
  const parse = (s: string) => {
    const [y, m, d] = isoDate(s).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/**
 * Look-ahead guard. `bars` must be the bars that were complete before the decision day: every
 * bar has to be dated strictly before `decisionDate`. The decision-time price is passed
 * separately (it is day t's open, the only day-t value that may be used).
 */
export function assertCompletedBars(bars: DailyBar[], decisionDate: string): void {
  const last = bars[bars.length - 1];
  if (last && last.date >= decisionDate)
    throw new Error(
      `look-ahead: bar dated ${last.date} is not complete before decision date ${decisionDate}`,
    );
}

/**
 * Number of completed bars a signal needs before it can produce a score. Used for warm-up.
 */
export function requiredBarsForSignal(id: SignalId, params: SignalParams): number {
  switch (id) {
    case 'trend':
      return Math.max(params.trend.slowPeriod - 1, 2 * params.trend.adxPeriod);
    case 'momentum':
      return params.momentum.lookbackDays;
    case 'meanReversion':
      return Math.max(params.meanReversion.rsiPeriod, params.meanReversion.bbPeriod - 1);
    default:
      return 0;
  }
}

const toCandle = (b: DailyBar): IndicatorCandle => ({
  timestamp: b.date,
  open: b.open,
  high: b.high,
  low: b.low,
  close: b.close,
  volume: b.volume,
});

/**
 * Trend score. Series S = last completed closes followed by the decision price.
 * cross = clamp((SMAfast(S) / SMAslow(S) - 1) / crossScale); pos = clamp((price / SMAslow(S) - 1)
 * / priceScale); direction = (cross + pos) / 2. Strength factor f = 0.5 + 0.5 * clamp01(ADX /
 * adxFull) where ADX is Wilder ADX of the completed bars only (tail of 10 * adxPeriod bars, so
 * the value does not depend on how much older history exists). score = direction * f.
 * Null when fewer than slowPeriod series points or no ADX value yet.
 */
export function trendScore(bars: DailyBar[], price: number, p: TrendParams): number | null {
  if (p.fastPeriod >= p.slowPeriod) throw new Error('trend: fastPeriod must be < slowPeriod');
  if (bars.length + 1 < p.slowPeriod) return null;
  const series = [...lastN(bars, p.slowPeriod - 1).map((b) => b.close), price];
  const smaSlow = mean(series);
  const smaFast = mean(lastN(series, p.fastPeriod));
  const adxValue = adx(lastN(bars, 10 * p.adxPeriod).map(toCandle), p.adxPeriod).at(-1)?.adx;
  if (adxValue === null || adxValue === undefined) return null;
  const cross = clampScore((smaFast / smaSlow - 1) / p.crossScale);
  const pos = clampScore((price / smaSlow - 1) / p.priceScale);
  const strength = 0.5 + 0.5 * Math.max(0, Math.min(1, adxValue / p.adxFull));
  return ((cross + pos) / 2) * strength;
}

/**
 * N-day momentum: ret = price / close of the bar N trading days before the decision day - 1,
 * score = clamp(ret / scale). Null with fewer than N completed bars.
 */
export function momentumReturn(
  bars: DailyBar[],
  price: number,
  lookbackDays: number,
): number | null {
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1)
    throw new Error('momentum: lookbackDays must be a positive integer');
  if (bars.length < lookbackDays) return null;
  return price / bars[bars.length - lookbackDays].close - 1;
}

export function momentumScore(bars: DailyBar[], price: number, p: MomentumParams): number | null {
  const ret = momentumReturn(bars, price, p.lookbackDays);
  return ret === null ? null : clampScore(ret / p.scale);
}

/**
 * Mean reversion score (oversold -> positive). Series S as in trend. rsiScore = clamp((50 - RSI)
 * / rsiScale) with the charts RSI (simple window average, market.ts) of S; pctB = (price -
 * lower) / (upper - lower) with Bollinger bands of the last bbPeriod points of S (population
 * std, k = bbK), pctB = 0.5 when the bands collapse; bbScore = clamp((0.5 - pctB) / 0.5).
 * score = (rsiScore + bbScore) / 2. Null before both are computable.
 */
export function meanReversionScore(
  bars: DailyBar[],
  price: number,
  p: MeanReversionParams,
): number | null {
  const need = Math.max(p.rsiPeriod, p.bbPeriod - 1);
  if (bars.length < need) return null;
  const series = [...lastN(bars, need).map((b) => b.close), price];
  const rsiValue = rsi(lastN(series, p.rsiPeriod + 1), p.rsiPeriod).at(-1);
  if (rsiValue === null || rsiValue === undefined) return null;
  const window = lastN(series, p.bbPeriod);
  if (window.length < p.bbPeriod) return null;
  const m = mean(window);
  const std = Math.sqrt(mean(window.map((v) => (v - m) ** 2)));
  const pctB = std === 0 ? 0.5 : (price - (m - p.bbK * std)) / (2 * p.bbK * std);
  const rsiScore = clampScore((50 - rsiValue) / p.rsiScale);
  const bbScore = clampScore((0.5 - pctB) / 0.5);
  return (rsiScore + bbScore) / 2;
}

/** Sort ascending by filedAt, validating the shape. Pure; returns a new array. */
export function normalizeValueSnapshots(rows: ValueSnapshot[]): ValueSnapshot[] {
  rows.forEach((r) => {
    if (!/^\d{4}-\d{2}-\d{2}/.test(r.filedAt))
      throw new Error(`value: invalid filedAt ${r.filedAt}`);
  });
  return [...rows].sort((a, b) => (a.filedAt < b.filedAt ? -1 : a.filedAt > b.filedAt ? 1 : 0));
}

/**
 * Value score from the symbol's own trailing history. Usable snapshots: filedAt date strictly
 * before the decision date (a filing on the decision day itself is not yet known at the open).
 * The latest usable snapshot is "current" (null when older than maxAgeDays); history is the last
 * `window` usable snapshots. For PER and PBR separately (only values > 0 count): pct = share of the
 * other history values that are higher than the current one (ties count half); metric score =
 * 2 * pct - 1, so the cheapest value of its own history gives +1 and the dearest -1. The score is
 * the mean of the available metrics. ROE is carried by the snapshot but not scored (reserved).
 */
export function valueScore(
  snapshots: ValueSnapshot[],
  decisionDate: string,
  p: ValueParams,
): number | null {
  const known = normalizeValueSnapshots(snapshots).filter((s) => isoDate(s.filedAt) < decisionDate);
  if (known.length === 0) return null;
  const recent = lastN(known, p.window);
  const current = recent[recent.length - 1];
  if (daysBetween(current.filedAt, decisionDate) > p.maxAgeDays) return null;
  const scores: number[] = [];
  for (const key of ['per', 'pbr'] as const) {
    const cur = current[key];
    if (cur === null || !Number.isFinite(cur) || cur <= 0) continue;
    const values = recent
      .map((s) => s[key])
      .filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
    if (values.length < p.minHistory) continue;
    const others = values.length - 1;
    const above = values.filter((v) => v > cur).length;
    const ties = values.filter((v) => v === cur).length - 1;
    scores.push(2 * ((above + 0.5 * ties) / others) - 1);
  }
  return scores.length === 0 ? null : mean(scores);
}

export type SignalInput = {
  /** Bars complete before the decision day, oldest first. */
  bars: DailyBar[];
  /** Decision-time price: the decision day's open (live: the fresh quote). */
  price: number;
  /** Decision day, `YYYY-MM-DD`. */
  decisionDate: string;
  values?: ValueSnapshot[];
  /** Optional live-only scores in [-1, 1] (no point-in-time history exists for them). */
  external?: { supply?: number | null; news?: number | null };
};

/**
 * Scores for the requested signals; each is in [-1, 1] or null for insufficient data. Only
 * `input.bars` (completed, enforced), the decision price and filings before the decision date are
 * read. Supply and news are passed through from `external` and are never computed here.
 */
export function computeSignalScores(
  input: SignalInput,
  ids: SignalId[],
  params: SignalParams = defaultSignalParams,
): Partial<Record<SignalId, number | null>> {
  assertCompletedBars(input.bars, input.decisionDate);
  if (!(input.price > 0) || !Number.isFinite(input.price))
    throw new Error('signals: price must be a positive finite number');
  const out: Partial<Record<SignalId, number | null>> = {};
  for (const id of ids) {
    switch (id) {
      case 'trend':
        out.trend = trendScore(input.bars, input.price, params.trend);
        break;
      case 'momentum':
        out.momentum = momentumScore(input.bars, input.price, params.momentum);
        break;
      case 'meanReversion':
        out.meanReversion = meanReversionScore(input.bars, input.price, params.meanReversion);
        break;
      case 'value':
        out.value = input.values
          ? valueScore(input.values, input.decisionDate, params.value)
          : null;
        break;
      case 'supply':
      case 'news': {
        const v = input.external?.[id];
        if (v !== null && v !== undefined && (!Number.isFinite(v) || v < -1 || v > 1))
          throw new Error(`signals: external ${id} score must be within [-1, 1]`);
        out[id] = v ?? null;
        break;
      }
    }
  }
  return out;
}
