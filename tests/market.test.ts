import { describe, expect, it } from 'vitest';
import type { MarketEvent } from '../src/lib/market';
import {
  bollinger,
  chartWindowLength,
  compareEventTime,
  importancePresentation,
  formatChartPrice,
  normalizeComparison,
  ema,
  filterEvents,
  startOfWeekDay,
  shiftCalendarDate,
  macd,
  rsi,
  sma,
} from '../src/lib/market';

// Synthetic events for filter logic only; never imported by application code.
const event = (
  id: number,
  country: string,
  category: string,
  assets: string[],
  importance: number,
  title: string,
): MarketEvent => ({
  id,
  date: '2026-10-' + String(id).padStart(2, '0'),
  day: id,
  time: '09:00',
  title,
  country,
  category,
  asset: assets[0],
  assets,
  importance,
  forecast: '—',
  previous: '—',
  description: '테스트 전용 합성 이벤트',
});
const events: MarketEvent[] = [
  event(1, '미국', '고용', ['달러'], 2, '미국 신규 실업수당 청구건수'),
  event(5, '미국', '물가', ['금리'], 3, '미국 소비자물가지수 (CPI)'),
  event(7, '한국', '통화정책', ['원화'], 3, '한국은행 기준금리 결정'),
  event(14, '미국', '에너지', ['유가'], 2, '미국 원유 재고'),
  event(16, '미국', '물가', ['금리'], 3, '미국 개인소비지출 (PCE)'),
];
describe('technical indicators', () => {
  it('SMA requires full window and computes mean', () => {
    expect(sma([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3]);
  });
  it('EMA smooths with defined alpha', () => {
    expect(ema([2, 4, 6], 3)).toEqual([2, 3, 4.5]);
  });
  it('constant prices have zero-width bands and neutral RSI', () => {
    const v = Array(30).fill(10);
    expect(bollinger(v)[29]).toEqual({ upper: 10, lower: 10 });
    expect(rsi(v)[29]).toBe(50);
    expect(macd(v)[29].histogram).toBe(0);
  });
  it('rising and falling RSI are bounded', () => {
    expect(rsi([1, 2, 3, 4], 3)[3]).toBe(100);
    expect(rsi([4, 3, 2, 1], 3)[3]).toBe(0);
  });
});

describe('calendar AND filtering', () => {
  it('combines asset, market and category with importance', () => {
    const result = filterEvents(events, {
      country: '미국',
      category: '물가',
      asset: '금리',
      importance: 3,
    });
    expect(result.map((e) => e.id)).toEqual([5, 16]);
  });
  it('applies case-insensitive title search and empty results', () => {
    expect(filterEvents(events, { search: 'cpi' }).map((e) => e.id)).toEqual([5]);
    expect(filterEvents(events, { country: '한국', asset: '금' })).toEqual([]);
    expect(filterEvents(events, {})).toHaveLength(events.length);
  });
});

describe('calendar date arithmetic', () => {
  it('finds the actual Sunday in October 2026', () => {
    expect(startOfWeekDay(2026, 9, 20)).toBe(18);
    expect(startOfWeekDay(2026, 9, 1)).toBe(-3);
  });
  it('moves day/week boundaries across months and years', () => {
    expect(shiftCalendarDate(2026, 9, 31, 1)).toEqual({ year: 2026, month: 10, day: 1 });
    expect(shiftCalendarDate(2026, 0, 1, -1)).toEqual({ year: 2025, month: 11, day: 31 });
    expect(shiftCalendarDate(2026, 9, 28, 7)).toEqual({ year: 2026, month: 10, day: 4 });
  });
});

describe('registered calendar assets', () => {
  it('matches any impacted asset instead of only the first', () => {
    const registered = {
      ...events[0],
      date: '2026-11-01',
      asset: '달러',
      assets: ['달러', '채권'],
    };
    expect(filterEvents([registered], { asset: '채권', country: '미국' })).toEqual([registered]);
    expect(filterEvents([registered], { asset: '금' })).toEqual([]);
  });
});

describe('UI domain regressions', () => {
  it('sorts registered events chronologically across month and year boundaries', () => {
    const first = { ...events[0], id: 31, date: '2026-12-31', day: 31, time: '23:00' };
    const second = { ...events[0], id: 1, date: '2027-01-01', day: 1, time: '01:00' };
    const third = { ...second, id: 2, time: '02:00' };
    expect([third, second, first].sort(compareEventTime).map((event) => event.id)).toEqual([
      31, 1, 2,
    ]);
  });
  it('preserves cents for USD and precision for normalized indices', () => {
    expect(formatChartPrice(234.76, 'USD')).toBe('234.76');
    expect(formatChartPrice(234, 'USD')).toBe('234.00');
    expect(formatChartPrice(100.126, 'INDEX')).toBe('100.13');
    expect(formatChartPrice(76000, 'KRW')).toBe('76,000');
  });
  it('distinguishes all three importance labels, dots and color tones', () => {
    expect([1, 2, 3].map(importancePresentation)).toEqual([
      { tone: 'low', label: '낮음', dots: '● ○ ○' },
      { tone: 'medium', label: '보통', dots: '● ● ○' },
      { tone: 'high', label: '높음', dots: '● ● ●' },
    ]);
  });
  it('normalizes each visible comparison series using its own selected-period start', () => {
    const history = [
      { close: 10, compare: 500, sma: null },
      { close: 15, compare: 800, sma: 12 },
      { close: 20, compare: 1000, sma: 18 },
      { close: 24, compare: 1100, sma: 22 },
    ];
    const visible = normalizeComparison(history.slice(-2));
    expect(visible[0]).toMatchObject({ close: 100, compare: 100, sma: 90 });
    expect(visible[1].close).toBe(120);
    expect(visible[1].compare).toBeCloseTo(110);
    expect(normalizeComparison([])).toEqual([]);
    expect(normalizeComparison(history.slice(0, 1))[0].sma).toBeNull();
  });
});

describe('daily chart trading-day windows', () => {
  it('shows five, twenty-one and sixty-three daily candles for the labelled periods', () => {
    expect(chartWindowLength('1주')).toBe(5);
    expect(chartWindowLength('1개월')).toBe(21);
    expect(chartWindowLength('3개월')).toBe(63);
    const fullHistory = Array.from({ length: 100 }, (_, i) => ({ close: i + 1, compare: 200 + i }));
    for (const period of ['1주', '1개월', '3개월']) {
      const visible = fullHistory.slice(-chartWindowLength(period));
      expect(visible).toHaveLength(chartWindowLength(period));
      expect(normalizeComparison(visible)[0]).toMatchObject({ close: 100, compare: 100 });
    }
  });
  it('retains pre-window indicator warmup while displaying only selected trading days', () => {
    const history = Array.from({ length: 100 }, (_, i) => i + 1);
    const indicator = sma(history, 20);
    const visibleIndicator = indicator.slice(-chartWindowLength('1주'));
    expect(visibleIndicator).toHaveLength(5);
    expect(visibleIndicator[0]).toBe(86.5);
    expect(visibleIndicator.every((value) => value !== null)).toBe(true);
  });
});
