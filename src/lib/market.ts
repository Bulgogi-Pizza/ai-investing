/** Deterministic synthetic prices. These values are never live quotes. */
export const demoPrices = Array.from({ length: 90 }, (_, i) => ({
  date: `${Math.floor(i / 28) + 7}.${String((i % 28) + 1).padStart(2, '0')}`,
  close: Math.round(69000 + i * 193 + Math.sin(i * 0.27) * 2100 + Math.cos(i * 0.63) * 700),
  compare: 100 + i * 0.18 + Math.sin(i * 0.2) * 1.5,
}));
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
  date?: string;
  assets?: string[];
  sourceUrl?: string;
  sourceName?: string;
  impactDirection?: 'mixed' | 'up' | 'down' | 'unknown';
  impactHorizon?: string;
  confidence?: 'low' | 'medium' | 'high';
  factualObservedAt?: string;
};
export const events: MarketEvent[] = [
  {
    id: 1,
    day: 1,
    time: '21:30',
    title: '미국 신규 실업수당 청구건수',
    country: '미국',
    category: '고용',
    asset: '달러',
    importance: 2,
    forecast: '—',
    previous: '—',
    description: '노동시장 둔화는 금리 인하 기대에 영향을 줄 수 있습니다.',
  },
  {
    id: 2,
    day: 2,
    time: '21:30',
    title: '미국 비농업 고용지수',
    country: '미국',
    category: '고용',
    asset: '금리',
    importance: 3,
    forecast: '—',
    previous: '—',
    description: '고용 증가가 예상보다 강하면 금리 인하 기대가 약해질 수 있습니다.',
  },
  {
    id: 3,
    day: 6,
    time: '09:00',
    title: '한국 소비자물가지수',
    country: '한국',
    category: '물가',
    asset: '원화',
    importance: 3,
    forecast: '—',
    previous: '—',
    description: '물가 상승률은 한국은행 통화정책과 원화 가치에 영향을 줄 수 있습니다.',
  },
  {
    id: 4,
    day: 8,
    time: '03:00',
    title: 'FOMC 회의록 공개',
    country: '미국',
    category: '통화정책',
    asset: '채권',
    importance: 3,
    forecast: '—',
    previous: '—',
    description: '정책위원들의 발언에 따라 국채 수익률과 주식 변동성이 높아질 수 있습니다.',
  },
  {
    id: 5,
    day: 13,
    time: '21:30',
    title: '미국 소비자물가지수 (CPI)',
    country: '미국',
    category: '물가',
    asset: '금리',
    importance: 3,
    forecast: '2.5%',
    previous: '2.7%',
    description:
      '물가가 예상보다 낮을 경우 채권 가격에 우호적일 수 있습니다. 실제 영향은 정책 기대와 시장 포지셔닝에 따라 달라집니다.',
  },
  {
    id: 6,
    day: 14,
    time: '23:30',
    title: '미국 원유 재고',
    country: '미국',
    category: '에너지',
    asset: '유가',
    importance: 2,
    forecast: '—',
    previous: '—',
    description:
      '재고 감소는 유가 상승 요인이 될 수 있으나 수요와 공급 전망을 함께 확인해야 합니다.',
  },
  {
    id: 7,
    day: 15,
    time: '10:00',
    title: '한국은행 기준금리 결정',
    country: '한국',
    category: '통화정책',
    asset: '원화',
    importance: 3,
    forecast: '2.50%',
    previous: '2.50%',
    description: '기준금리 변경은 원화, 국내 채권, 주식의 할인율에 영향을 줄 수 있습니다.',
  },
  {
    id: 8,
    day: 16,
    time: '21:30',
    title: '미국 소매판매',
    country: '미국',
    category: '경기',
    asset: '달러',
    importance: 2,
    forecast: '0.3%',
    previous: '0.4%',
    description:
      '소비 지표 강세는 성장 기대를 높이는 동시에 고금리 유지 전망을 강화할 수 있습니다.',
  },
  {
    id: 9,
    day: 20,
    time: '09:00',
    title: '한국 생산자물가지수',
    country: '한국',
    category: '물가',
    asset: '원화',
    importance: 2,
    forecast: '0.2%',
    previous: '0.1%',
    description: '생산 단계의 물가 변화가 소비자물가에 전가될 가능성을 점검합니다.',
  },
  {
    id: 10,
    day: 20,
    time: '21:30',
    title: '미국 주택착공 건수',
    country: '미국',
    category: '경기',
    asset: '채권',
    importance: 2,
    forecast: '142만',
    previous: '138만',
    description: '주택 경기는 금리 민감 업종의 수요와 성장 전망을 파악하는 참고 자료입니다.',
  },
  {
    id: 11,
    day: 21,
    time: '23:30',
    title: '미국 원유 재고',
    country: '미국',
    category: '에너지',
    asset: '유가',
    importance: 2,
    forecast: '—',
    previous: '—',
    description: '원유 재고 발표 전후 유가 변동성이 높아질 수 있습니다.',
  },
  {
    id: 12,
    day: 22,
    time: '21:30',
    title: '미국 신규 실업수당 청구건수',
    country: '미국',
    category: '고용',
    asset: '금',
    importance: 2,
    forecast: '—',
    previous: '—',
    description: '고용 둔화에 따른 금리 기대 변화는 금 가격에 간접적인 영향을 줄 수 있습니다.',
  },
  {
    id: 13,
    day: 23,
    time: '22:45',
    title: '미국 제조업 PMI',
    country: '미국',
    category: '경기',
    asset: '달러',
    importance: 3,
    forecast: '51.2',
    previous: '50.8',
    description: '제조업 심리 개선은 경기민감 업종과 달러의 방향에 영향을 줄 수 있습니다.',
  },
  {
    id: 14,
    day: 27,
    time: '23:00',
    title: '미국 소비자신뢰지수',
    country: '미국',
    category: '경기',
    asset: '달러',
    importance: 2,
    forecast: '—',
    previous: '—',
    description: '소비 심리 변화로 향후 소비 지출과 경기 방향을 살펴볼 수 있습니다.',
  },
  {
    id: 15,
    day: 29,
    time: '21:30',
    title: '미국 GDP 성장률',
    country: '미국',
    category: '경기',
    asset: '채권',
    importance: 3,
    forecast: '2.8%',
    previous: '3.0%',
    description:
      '성장률과 물가를 함께 해석해야 하며 단일 발표만으로 자산 방향을 단정할 수 없습니다.',
  },
  {
    id: 16,
    day: 30,
    time: '21:30',
    title: '미국 개인소비지출 (PCE)',
    country: '미국',
    category: '물가',
    asset: '금리',
    importance: 3,
    forecast: '2.4%',
    previous: '2.5%',
    description: '연준이 참고하는 물가 지표로, 정책금리 경로에 대한 기대를 바꿀 수 있습니다.',
  },
];
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
      (!filters.asset || (event.assets ?? [event.asset]).includes(filters.asset)) &&
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
  const date = (event: MarketEvent) =>
    event.date ?? `2026-10-${String(event.day).padStart(2, '0')}`;
  return date(a).localeCompare(date(b)) || a.time.localeCompare(b.time) || a.id - b.id;
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
