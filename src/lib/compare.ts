// Market comparison overlay (stage 5e): every series is rebased to 100 at the first date where the
// stock and all selected overlay series have a value. Pure functions, no I/O.
import type { ChartRow } from './chartData';
import { snapToRow } from './chartEvents';

export type CompareId = 'kospi' | 'kosdaq' | 'sp500' | 'usdkrw';
export type CompareDef = {
  id: CompareId;
  label: string;
  color: string;
  /** What the series is, for the legend and notes. */
  detail: string;
};
export const COMPARE_SERIES: readonly CompareDef[] = [
  { id: 'kospi', label: '코스피', color: '#d6455d', detail: '토스 시장 지표 일봉(KOSPI) 종가' },
  { id: 'kosdaq', label: '코스닥', color: '#e08a2c', detail: '토스 시장 지표 일봉(KOSDAQ) 종가' },
  {
    id: 'sp500',
    label: 'S&P 500 (SPY ETF 기준)',
    color: '#2f8f6b',
    detail: '토스 SPY(S&P 500 추종 ETF) 일봉 수정주가 종가. 지수 자체가 아니라 ETF 가격입니다',
  },
  {
    id: 'usdkrw',
    label: '원/달러 환율',
    color: '#3a86c4',
    detail: '한국은행 ECOS 원/미국달러 매매기준율(일별)',
  },
];
export const compareDef = (id: CompareId) => COMPARE_SERIES.find((item) => item.id === id)!;
/** Row key under which a series' normalized values are stored. */
export const compareKey = (id: CompareId) => `cmp_${id}` as const;

export type DatedValue = { date: string; value: number };
/** Date -> value; a later duplicate date wins. Non-finite or non-positive values are dropped. */
export function valuesByDate(points: readonly DatedValue[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const point of points)
    if (Number.isFinite(point.value) && point.value > 0) map.set(point.date, point.value);
  return map;
}

export type Comparison = {
  /** Index into the rows of the first date every series (and the close) has a value. */
  baseIndex: number;
  baseDate: string;
  /** Multiplier that turns a price into its index value (100 / close at the base date). */
  priceScale: number;
  /** Per series, values on the rows (null where the series has no value on that date). */
  values: Record<string, (number | null)[]>;
};

/**
 * Rebases the stock and each series to 100 at the first common date. Dates must match exactly
 * (each series keeps its own market's trading calendar; days with no value stay null and the chart
 * draws across them). Returns null when no series is given or there is no common date.
 */
export function computeComparison(
  rowDates: readonly (string | null)[],
  closes: readonly (number | null)[],
  series: Record<string, ReadonlyMap<string, number>>,
): Comparison | null {
  const ids = Object.keys(series);
  if (!ids.length) return null;
  let baseIndex = -1;
  for (let i = 0; i < rowDates.length; i++) {
    const date = rowDates[i];
    const close = closes[i];
    if (!date || close === null || !(close > 0)) continue;
    if (ids.every((id) => (series[id].get(date) ?? 0) > 0)) {
      baseIndex = i;
      break;
    }
  }
  if (baseIndex < 0) return null;
  const baseDate = rowDates[baseIndex]!;
  const values: Record<string, (number | null)[]> = {};
  for (const id of ids) {
    const base = series[id].get(baseDate)!;
    values[id] = rowDates.map((date) => {
      const value = date ? series[id].get(date) : undefined;
      return value === undefined ? null : (value / base) * 100;
    });
  }
  return { baseIndex, baseDate, priceScale: 100 / closes[baseIndex]!, values };
}

const priceFields = [
  'close',
  'sma',
  'ema',
  'bbUpper',
  'bbLower',
  'tenkan',
  'kijun',
  'senkouA',
  'senkouB',
  'chikou',
  'vwap',
  'sar',
  'kcMiddle',
  'kcUpper',
  'kcLower',
] as const;

export type CompareRow = ChartRow & { [key: `cmp_${string}`]: number | null };
/** Every price-unit value of the rows times `scale`, plus the normalized series as `cmp_<id>`. */
export function rebaseRows(
  rows: readonly ChartRow[],
  scale: number,
  comparison: Comparison,
): CompareRow[] {
  return rows.map((row, index) => {
    const next: CompareRow = { ...row };
    for (const field of priceFields) {
      const value = row[field];
      if (value !== null) next[field] = value * scale;
    }
    if (row.cloudUp) next.cloudUp = [row.cloudUp[0] * scale, row.cloudUp[1] * scale];
    if (row.cloudDown) next.cloudDown = [row.cloudDown[0] * scale, row.cloudDown[1] * scale];
    for (const [id, values] of Object.entries(comparison.values))
      next[`cmp_${id}`] = values[index] ?? null;
    return next;
  });
}

/**
 * A flat line only when it is near the drawn prices: a cost far outside the range would squash the
 * chart, so it is reported as outside and left out (the page says so).
 */
export function costLineState(
  average: number | null,
  closes: readonly (number | null)[],
): 'none' | 'draw' | 'outside' {
  if (average === null || !(average > 0)) return 'none';
  const real = closes.filter((value): value is number => value !== null);
  if (!real.length) return 'none';
  const low = Math.min(...real);
  const high = Math.max(...real);
  return average >= low * 0.7 && average <= high * 1.3 ? 'draw' : 'outside';
}

export type FillInput = {
  id: string;
  algorithmName: string;
  side: 'buy' | 'sell';
  mode: 'paper' | 'live';
  date: string;
  price: string;
  quantity: string;
  currency: 'KRW' | 'USD';
};
export type FillMark = FillInput & { rowIndex: number; priceNumber: number };
/** Puts algorithm fills on chart rows (first trading row on or after the fill date). */
export function placeFills(
  fills: readonly FillInput[],
  rowDates: readonly (string | null)[],
): { marks: FillMark[]; outside: number } {
  const marks: FillMark[] = [];
  let outside = 0;
  for (const fill of fills) {
    const rowIndex = snapToRow(fill.date, rowDates);
    const priceNumber = Number(fill.price);
    if (rowIndex === null || !(priceNumber > 0)) {
      outside += 1;
      continue;
    }
    marks.push({ ...fill, rowIndex, priceNumber });
  }
  return { marks, outside };
}
export const modeLabel = (mode: 'paper' | 'live') => (mode === 'paper' ? '가상' : '실제');
export const sideLabel = (side: 'buy' | 'sell') => (side === 'buy' ? '매수' : '매도');
