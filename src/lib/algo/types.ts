/**
 * Shared types for the formula-based algorithm engine (stage 7b). Everything in `src/lib/algo`
 * is pure and deterministic: no network, no clock, no storage, no order code.
 */

export type Market = 'KR' | 'US';

/**
 * One daily bar of an exchange trading day. `date` is the exchange-local calendar date
 * (`YYYY-MM-DD`); bars are passed oldest first. Prices must be split-adjusted (Toss candles are
 * requested with `adjusted=true`).
 */
export type DailyBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * Point-in-time fundamentals row. This is the adapter point to the fundamentals library (built
 * separately): map its rows to this shape. `filedAt` is the date the numbers became public
 * (disclosure date, `YYYY-MM-DD` or an ISO timestamp); a row is only usable on decision days
 * strictly after that date. Values are null when not computable (e.g. negative earnings).
 */
export interface ValueSnapshot {
  filedAt: string;
  per: number | null;
  pbr: number | null;
  roe: number | null;
}

export type ChartSignalId = 'trend' | 'momentum' | 'meanReversion';
export type SignalId = ChartSignalId | 'value' | 'supply' | 'news';

/** Signals that can be reproduced from point-in-time history. */
export const historicalSignalIds: readonly SignalId[] = [
  'trend',
  'momentum',
  'meanReversion',
  'value',
];
/** Signals with no point-in-time history; the backtester always excludes them. */
export const excludedHistoricalSignals = ['supply', 'news'] as const;

export type SignalWeight = { id: SignalId; weight: number };

export type Action = 'buy' | 'sell' | 'hold';

export type DecisionReason =
  | 'buy-threshold'
  | 'sell-threshold'
  | 'between-thresholds'
  | 'insufficient-data'
  | 'dual-momentum-pass'
  | 'absolute-momentum'
  | 'relative-momentum';

/** Same output shape for formula decisions today and AI decisions later. */
export type Decision = {
  action: Action;
  /** Composite score in [-1, 1]; null when the decision is 'insufficient-data'. */
  score: number | null;
  reason: DecisionReason;
  signals: Partial<Record<SignalId, { score: number | null; weight: number }>>;
  /** Dual momentum only: N-day return and its relative rank (1 = best). */
  detail?: { momentumReturn: number | null; rank: number | null };
};

export type TrendParams = {
  fastPeriod: number;
  slowPeriod: number;
  /** fast/slow SMA ratio - 1 that maps to +-1. */
  crossScale: number;
  /** price/slow SMA - 1 that maps to +-1. */
  priceScale: number;
  adxPeriod: number;
  /** ADX at or above which the trend counts as fully strong. */
  adxFull: number;
};
export type MomentumParams = {
  lookbackDays: number;
  /** N-day return that maps to +-1. */
  scale: number;
};
export type MeanReversionParams = {
  rsiPeriod: number;
  bbPeriod: number;
  bbK: number;
  /** RSI distance from 50 that maps to +-1. */
  rsiScale: number;
};
export type ValueParams = {
  /** Number of most recent known snapshots forming the symbol's own history. */
  window: number;
  /** Minimum valid history points (including the current one) per metric. */
  minHistory: number;
  /** Latest known snapshot older than this many days is stale -> null. */
  maxAgeDays: number;
};
export type SignalParams = {
  trend: TrendParams;
  momentum: MomentumParams;
  meanReversion: MeanReversionParams;
  value: ValueParams;
};

export type DualMomentumParams = {
  lookbackDays: number;
  /** Number of best-ranked symbols allowed to be held. */
  topN: number;
  /** Absolute momentum: N-day return must exceed this (>= 0). */
  absoluteThreshold: number;
  /** N-day return that maps to score 1. */
  scale: number;
};

export type AlgorithmTemplateId = 'momentum' | 'meanReversion' | 'dualMomentum' | 'custom';

/** Mode-independent definition: the same object drives simulation, paper and live. */
export type AlgorithmDefinition = {
  name: string;
  method: 'formula';
  template: AlgorithmTemplateId;
  market: Market;
  /** Fixed target list; one currency (KRW for KR, USD for US). */
  symbols: string[];
  signals: SignalWeight[];
  params: SignalParams;
  dualMomentum?: DualMomentumParams;
  buyThreshold: number;
  sellThreshold: number;
  /** Budget in the market currency. */
  budget: number;
  /** Fraction of the budget per position; default 1/symbols (1/topN for dual momentum). */
  positionFraction?: number;
};
