// Event vertical lines on the 종목 분석 chart: shared types, filters, placement on chart rows and
// collision-aware label layout. Pure functions, no I/O. The server (src/server/analysis-events.ts)
// builds ChartEvent objects; the browser filters, places and draws them.

export type EventKind = 'rate-decision' | 'earnings' | 'economic-indicator' | 'disclosure';
export type EventMarket = 'US' | 'KR';
export type EventImportance = 1 | 2 | 3;
export type EventOrigin = 'calendar' | 'fred' | 'dart' | 'sec';

export interface ChartEvent {
  /** Stable key, unique within one response. */
  id: string;
  /**
   * Calendar date of the event. KR events: KST date. US events: US (Eastern) local date. The chart
   * places it on the first trading row on or after this date.
   */
  date: string;
  title: string;
  /** `ko` when the title is Korean (written by this app or registered in Korean); otherwise as the provider wrote it. */
  titleLanguage: 'ko' | 'original';
  kind: EventKind;
  importance: EventImportance;
  market: EventMarket;
  /** Human-readable source name. */
  source: string;
  /** https link to the source (SourceLink renders only https). */
  url: string;
  origin: EventOrigin;
}

export const EVENT_KINDS: { id: EventKind; label: string }[] = [
  { id: 'rate-decision', label: '금리 결정' },
  { id: 'earnings', label: '실적 발표' },
  { id: 'economic-indicator', label: '경제 지표' },
  { id: 'disclosure', label: '공시' },
];
export const EVENT_MARKETS: { id: EventMarket; label: string }[] = [
  { id: 'US', label: '미국' },
  { id: 'KR', label: '국내' },
];
export const IMPORTANCE_LEVELS: { id: EventImportance; label: string }[] = [
  { id: 3, label: '최상' },
  { id: 2, label: '높음' },
  { id: 1, label: '보통' },
];
export const importanceLabel = (importance: EventImportance) =>
  IMPORTANCE_LEVELS.find((level) => level.id === importance)!.label;
export const kindLabel = (kind: EventKind) => EVENT_KINDS.find((item) => item.id === kind)!.label;
export const marketLabel = (market: EventMarket) =>
  EVENT_MARKETS.find((item) => item.id === market)!.label;

export type EventFilter = {
  importance: ReadonlySet<EventImportance>;
  kinds: ReadonlySet<EventKind>;
  markets: ReadonlySet<EventMarket>;
};
/** 보통 (1) is off by default: routine filings would crowd the chart. */
export const defaultEventFilter = (): EventFilter => ({
  importance: new Set<EventImportance>([3, 2]),
  kinds: new Set(EVENT_KINDS.map((kind) => kind.id)),
  markets: new Set(EVENT_MARKETS.map((market) => market.id)),
});

export function filterEvents(events: readonly ChartEvent[], filter: EventFilter): ChartEvent[] {
  return events.filter(
    (event) =>
      filter.importance.has(event.importance) &&
      filter.kinds.has(event.kind) &&
      filter.markets.has(event.market),
  );
}

export function toggleIn<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

/** Highest importance first, then earlier date, then title: the order events are listed in. */
export const byImportance = (a: ChartEvent, b: ChartEvent) =>
  b.importance - a.importance || a.date.localeCompare(b.date) || a.title.localeCompare(b.title);

export type EventCluster = {
  /** Index into the chart rows. */
  rowIndex: number;
  /** Date of that row. */
  rowDate: string;
  /** Events on this row, most important first. */
  events: ChartEvent[];
};

/**
 * Row an item dated `date` is drawn on: the first trading row on or after it (weekends and
 * holidays move to the next trading day). Null when it falls outside the rows' dates.
 */
export function snapToRow(date: string, rowDates: readonly (string | null)[]): number | null {
  const real: { index: number; date: string }[] = [];
  rowDates.forEach((value, index) => {
    if (value) real.push({ index, date: value });
  });
  if (!real.length || date < real[0].date) return null;
  let low = 0;
  let high = real.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (real[mid].date < date) low = mid + 1;
    else high = mid;
  }
  return low >= real.length ? null : real[low].index;
}

/**
 * Places events on chart rows (see snapToRow). Events outside the rows are counted in `outside`.
 * Events that land on the same row form one cluster (one line, one label).
 */
export function clusterEvents(
  events: readonly ChartEvent[],
  rowDates: readonly (string | null)[],
): { clusters: EventCluster[]; outside: number } {
  const byRow = new Map<number, ChartEvent[]>();
  let outside = 0;
  for (const event of events) {
    const row = snapToRow(event.date, rowDates);
    if (row === null) {
      outside += 1;
      continue;
    }
    byRow.set(row, [...(byRow.get(row) ?? []), event]);
  }
  const clusters = [...byRow]
    .sort(([a], [b]) => a - b)
    .map(([rowIndex, list]) => ({
      rowIndex,
      rowDate: rowDates[rowIndex]!,
      events: [...list].sort(byImportance),
    }));
  return { clusters, outside };
}

const isWide = (char: string) => /[ᄀ-ᇿ㄰-㆏가-힯一-鿿]/.test(char);
/** Rough rendered width in px at 11px font; Korean glyphs are wider than Latin ones. */
export function textWidth(text: string): number {
  let width = 0;
  for (const char of text) width += isWide(char) ? 11.5 : 6.4;
  return width;
}
/** Shortens a label to fit `maxWidth` px, ending with an ellipsis when cut. */
export function truncateLabel(text: string, maxWidth: number): string {
  if (textWidth(text) <= maxWidth) return text;
  let result = '';
  for (const char of text) {
    if (textWidth(result + char + '…') > maxWidth) break;
    result += char;
  }
  return `${result}…`;
}

export type LabelBox = { id: string; x: number; width: number; priority: number };
export type PlacedLabel = { id: string; left: number; width: number; tier: number };

/**
 * Collision-aware label placement. Each label is centred on its line, clamped inside the plot, and
 * put in the first tier (row) where it overlaps nothing already placed there. Labels are placed
 * most important first, so when space runs out the least important ones are the ones left without
 * a label (`hidden`). Their lines are still drawn and still reachable by marker and list.
 */
export function layoutEventLabels(
  boxes: readonly LabelBox[],
  area: { left: number; right: number },
  tiers: number,
  gap = 4,
): { placed: PlacedLabel[]; hidden: string[] } {
  const occupied: [number, number][][] = Array.from({ length: tiers }, () => []);
  const placed: PlacedLabel[] = [];
  const hidden: string[] = [];
  const order = [...boxes].sort((a, b) => b.priority - a.priority || a.x - b.x);
  for (const box of order) {
    const width = Math.min(box.width, Math.max(0, area.right - area.left));
    const left = Math.max(area.left, Math.min(box.x - width / 2, area.right - width));
    const tier = occupied.findIndex((spans) =>
      spans.every(([start, end]) => left + width + gap <= start || left >= end + gap),
    );
    if (tier < 0) {
      hidden.push(box.id);
      continue;
    }
    occupied[tier].push([left, left + width]);
    placed.push({ id: box.id, left, width, tier });
  }
  placed.sort((a, b) => a.left - b.left);
  return { placed, hidden };
}

const evenDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date);
/** Window the events route is asked for: the chart's dates, limited to the route's cap. */
export const EVENT_WINDOW_MAX_DAYS = 400;
export function eventWindow(
  firstDate: string,
  lastDate: string,
): { from: string; to: string; clamped: boolean } | null {
  if (!evenDate(firstDate) || !evenDate(lastDate) || firstDate > lastDate) return null;
  const day = 86400000;
  const span = (Date.parse(`${lastDate}T00:00:00Z`) - Date.parse(`${firstDate}T00:00:00Z`)) / day;
  if (span <= EVENT_WINDOW_MAX_DAYS) return { from: firstDate, to: lastDate, clamped: false };
  const from = new Date(Date.parse(`${lastDate}T00:00:00Z`) - EVENT_WINDOW_MAX_DAYS * day)
    .toISOString()
    .slice(0, 10);
  return { from, to: lastDate, clamped: true };
}
