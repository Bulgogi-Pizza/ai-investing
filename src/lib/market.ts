export function sma(values: number[], period: number): (number | null)[] {
  return values.map((_, i) =>
    i < period - 1 ? null : values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period,
  );
}
export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  return values.reduce<number[]>((a, v, i) => [...a, i ? v * k + a[i - 1] * (1 - k) : v], []);
}
export function bollinger(values: number[], period = 20) {
  const means = sma(values, period);
  return means.map((mean, i) => {
    if (mean === null) return { upper: null, lower: null };
    const std = Math.sqrt(
      values.slice(i - period + 1, i + 1).reduce((a, v) => a + (v - mean) ** 2, 0) / period,
    );
    return { upper: mean + 2 * std, lower: mean - 2 * std };
  });
}
export function rsi(values: number[], period = 14): (number | null)[] {
  return values.map((_, i) => {
    if (i < period) return null;
    const changes = values.slice(i - period + 1, i + 1).map((v, j) => v - values[i - period + j]);
    const gain = changes.reduce((a, v) => a + Math.max(0, v), 0);
    const loss = changes.reduce((a, v) => a + Math.max(0, -v), 0);
    return loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  });
}
export function macd(values: number[]) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);
  const line = fast.map((v, i) => v - slow[i]);
  const signal = ema(line, 9);
  return line.map((v, i) => ({ macd: v, signal: signal[i], histogram: v - signal[i] }));
}
export type MarketEvent = {
  id: number;
  day: number;
  time: string;
  title: string;
  country: string;
  category: string;
  asset: string;
  importance: number;
  forecast: string;
  previous: string;
  description: string;
  date: string;
  assets: string[];
  sourceUrl?: string;
  sourceName?: string;
  impactDirection?: 'mixed' | 'up' | 'down' | 'unknown';
  impactHorizon?: string;
  confidence?: 'low' | 'medium' | 'high';
  factualObservedAt?: string;
  /** Released values attached by the morning job (source and fetch time per value). */
  values?: EventValue[];
  /** Present only when an AI summary exists; null/undefined means none. */
  aiSummary?: { text: string; model: string; generatedAt: string } | null;
  /** Exact provider title when `title` differs from it (Korean translation or cleaned text). */
  titleOriginal?: string;
  /** Present when `title` is an AI translation of `titleOriginal`. */
  translation?: { model: string; translatedAt: string };
  /** Leading release-type tag of the source title ("보도자료"). */
  releaseType?: string;
  outcome?: EventOutcome;
  reaction?: EventReaction[];
  impact?: EventImpact[];
  explainer?: string;
  enrichment?: EventEnrichment;
};
export type EventOutcome = {
  headline: string;
  facts: { label: string; value: string; note?: string }[];
};
export type EventReaction = {
  asset: 'KOSPI' | 'KOSDAQ' | 'KR_BOND_3Y' | 'KR_BOND_10Y' | 'USDKRW' | 'SPY';
  from: { date: string; value: number };
  to: { date: string; value: number };
  change: number;
  unit: '%' | '%p' | '원';
  /** USD/KRW only. */
  changePercent?: number;
  source: string;
};
export type EventImpact = { asset: string; effect: string };
export type EventEnrichment = {
  model: string;
  generatedAt: string;
  version: number;
  aiFields: ('title' | 'outcome' | 'impact' | 'explainer')[];
};
export type EventValue = {
  indicatorId: string;
  label: string;
  actual: string;
  previous: string | null;
  unit: string;
  period: string;
  previousPeriod: string | null;
  source: string;
  observedAt: string;
};
export type EventFilters = {
  importance?: number;
  category?: string;
  asset?: string;
  country?: string;
  search?: string;
};
export function filterEvents(items: MarketEvent[], filters: EventFilters): MarketEvent[] {
  return items.filter(
    (event) =>
      (!filters.importance || event.importance === filters.importance) &&
      (!filters.category || event.category === filters.category) &&
      (!filters.asset || event.assets.includes(filters.asset)) &&
      (!filters.country || event.country === filters.country) &&
      (!filters.search || event.title.toLowerCase().includes(filters.search.toLowerCase())),
  );
}
/** Local calendar arithmetic; display dates use KST-aligned calendar labels. */
export function startOfWeekDay(year: number, month: number, day: number): number {
  return day - new Date(year, month, day).getDay();
}
export function shiftCalendarDate(year: number, month: number, day: number, delta: number) {
  const date = new Date(year, month, day + delta);
  return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() };
}
export function adjacentCalendarDate(year: number, month: number, day: number) {
  return shiftCalendarDate(year, month, 1, day - 1);
}

/** ISO calendar ordering is independent of month/year boundaries. */
export function compareEventTime(a: MarketEvent, b: MarketEvent): number {
  return a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id - b.id;
}
export function importancePresentation(value: number) {
  return value === 3
    ? { tone: 'high', label: '높음', dots: '● ● ●' }
    : value === 2
      ? { tone: 'medium', label: '보통', dots: '● ● ○' }
      : { tone: 'low', label: '낮음', dots: '● ○ ○' };
}
export function formatChartPrice(value: number, currency: 'KRW' | 'USD' | 'INDEX') {
  return new Intl.NumberFormat('ko-KR', {
    minimumFractionDigits: currency === 'KRW' ? 0 : 2,
    maximumFractionDigits: currency === 'KRW' ? 0 : 2,
  }).format(value);
}
/** Normalize after selecting the visible period; each price series has its own baseline. */
export function normalizeComparison<
  T extends {
    close: number;
    compare: number;
    sma?: number | null;
    ema?: number | null;
    upper?: number | null;
    lower?: number | null;
  },
>(visible: T[]) {
  if (!visible.length) return [];
  const priceBase = visible[0].close;
  const compareBase = visible[0].compare;
  if (!(priceBase > 0) || !(compareBase > 0))
    throw new Error('Positive comparison baselines required');
  const indicator = (value: number | null | undefined) =>
    value == null ? value : (value / priceBase) * 100;
  return visible.map((point) => ({
    ...point,
    close: (point.close / priceBase) * 100,
    compare: (point.compare / compareBase) * 100,
    sma: indicator(point.sma),
    ema: indicator(point.ema),
    upper: indicator(point.upper),
    lower: indicator(point.lower),
  }));
}

/** Approximate trading-day windows for daily candle views; holidays can shorten coverage. */
export function chartWindowLength(period: string): number {
  return period === '1주' ? 5 : period === '1개월' ? 21 : 63;
}
