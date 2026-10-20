import { describe, expect, it } from 'vitest';
import type { ChartRow } from '../src/lib/chartData';
import {
  clusterEvents,
  defaultEventFilter,
  eventWindow,
  filterEvents,
  layoutEventLabels,
  snapToRow,
  textWidth,
  toggleIn,
  truncateLabel,
  type ChartEvent,
} from '../src/lib/chartEvents';
import {
  computeComparison,
  costLineState,
  placeFills,
  rebaseRows,
  valuesByDate,
} from '../src/lib/compare';

const event = (id: string, date: string, extra: Partial<ChartEvent> = {}): ChartEvent => ({
  id,
  date,
  title: `이벤트 ${id}`,
  titleLanguage: 'ko',
  kind: 'disclosure',
  importance: 2,
  market: 'KR',
  source: '테스트',
  url: 'https://example.test/x',
  origin: 'dart',
  ...extra,
});

describe('이벤트 필터', () => {
  const events = [
    event('a', '2026-10-01', { importance: 3, kind: 'rate-decision', market: 'US' }),
    event('b', '2026-10-02', { importance: 2, kind: 'earnings' }),
    event('c', '2026-10-03', { importance: 1 }),
  ];
  it('기본값은 최상·높음이고 모든 종류·시장을 켠다', () => {
    const filter = defaultEventFilter();
    expect([...filter.importance].sort()).toEqual([2, 3]);
    expect(filterEvents(events, filter).map((e) => e.id)).toEqual(['a', 'b']);
  });
  it('중요도·종류·시장은 AND로 걸러진다', () => {
    const base = defaultEventFilter();
    expect(
      filterEvents(events, { ...base, importance: new Set([1, 2, 3]) }).map((e) => e.id),
    ).toEqual(['a', 'b', 'c']);
    expect(
      filterEvents(events, { ...base, kinds: new Set(['earnings']) }).map((e) => e.id),
    ).toEqual(['b']);
    expect(filterEvents(events, { ...base, markets: new Set(['US']) }).map((e) => e.id)).toEqual([
      'a',
    ]);
    expect(filterEvents(events, { ...base, markets: new Set() })).toEqual([]);
  });
  it('toggleIn은 원본을 바꾸지 않는다', () => {
    const original = new Set([1]);
    const next = toggleIn(original, 2);
    expect([...original]).toEqual([1]);
    expect([...next]).toEqual([1, 2]);
    expect([...toggleIn(next, 1)]).toEqual([2]);
  });
});

describe('이벤트 위치', () => {
  const rows = ['2026-10-05', '2026-10-06', null, '2026-10-08', '2026-10-12'];
  it('휴장일 이벤트는 다음 거래일 행에, 범위 밖은 제외한다', () => {
    expect(snapToRow('2026-10-06', rows)).toBe(1);
    expect(snapToRow('2026-10-07', rows)).toBe(3);
    expect(snapToRow('2026-10-10', rows)).toBe(4); // weekend -> Monday
    expect(snapToRow('2026-10-04', rows)).toBeNull();
    expect(snapToRow('2026-10-13', rows)).toBeNull();
    expect(snapToRow('2026-10-06', [])).toBeNull();
    expect(snapToRow('2026-10-06', [null, null])).toBeNull();
  });
  it('같은 행의 이벤트는 한 묶음이 되고 중요도순으로 정렬된다', () => {
    const { clusters, outside } = clusterEvents(
      [
        event('a', '2026-10-09', { importance: 1 }),
        event('b', '2026-10-12', { importance: 3 }),
        event('c', '2026-10-07', { importance: 2 }),
        event('d', '2026-10-01'),
        event('e', '2026-10-20'),
      ],
      rows,
    );
    expect(outside).toBe(2);
    expect(clusters.map((c) => [c.rowIndex, c.rowDate, c.events.map((e) => e.id)])).toEqual([
      [3, '2026-10-08', ['c']],
      [4, '2026-10-12', ['b', 'a']],
    ]);
  });
  it('이벤트 조회 창은 400일로 자른다', () => {
    expect(eventWindow('2026-08-20', '2026-10-20')).toEqual({
      from: '2026-08-20',
      to: '2026-10-20',
      clamped: false,
    });
    expect(eventWindow('2023-01-01', '2026-10-20')).toEqual({
      from: '2025-09-15',
      to: '2026-10-20',
      clamped: true,
    });
    expect(eventWindow('2025-09-15', '2026-10-20')?.clamped).toBe(false);
    expect(eventWindow('bad', '2026-10-20')).toBeNull();
    expect(eventWindow('2026-10-21', '2026-10-20')).toBeNull();
  });
});

describe('이름표 배치', () => {
  const area = { left: 0, right: 400 };
  const overlap = (a: { left: number; width: number }, b: { left: number; width: number }) =>
    a.left < b.left + b.width && b.left < a.left + a.width;

  it('글자 폭: 한글은 영문보다 넓고 길면 말줄임표로 자른다', () => {
    expect(textWidth('가나')).toBeGreaterThan(textWidth('ab'));
    expect(truncateLabel('짧음', 100)).toBe('짧음');
    const cut = truncateLabel('아주 아주 긴 이벤트 이름입니다 정말로', 60);
    expect(cut.endsWith('…')).toBe(true);
    expect(textWidth(cut)).toBeLessThanOrEqual(60);
  });
  it('겹치지 않으면 한 줄에 놓는다', () => {
    const { placed, hidden } = layoutEventLabels(
      [
        { id: 'a', x: 60, width: 80, priority: 1 },
        { id: 'b', x: 200, width: 80, priority: 1 },
      ],
      area,
      3,
    );
    expect(hidden).toEqual([]);
    expect(placed.map((p) => p.tier)).toEqual([0, 0]);
  });
  it('겹치면 다음 줄로 내리고 같은 줄의 이름표는 절대 겹치지 않는다', () => {
    const boxes = Array.from({ length: 9 }, (_, i) => ({
      id: String(i),
      x: 100 + i * 18,
      width: 90,
      priority: 1,
    }));
    const { placed, hidden } = layoutEventLabels(boxes, area, 3);
    expect(placed.length + hidden.length).toBe(9);
    for (let tier = 0; tier < 3; tier++) {
      const row = placed.filter((p) => p.tier === tier);
      for (let i = 0; i < row.length; i++)
        for (let j = i + 1; j < row.length; j++) expect(overlap(row[i], row[j])).toBe(false);
    }
    expect(Math.max(...placed.map((p) => p.tier))).toBeLessThan(3);
  });
  it('자리가 모자라면 중요도가 낮은 쪽이 이름표를 잃는다', () => {
    const { placed, hidden } = layoutEventLabels(
      [
        { id: 'low', x: 200, width: 100, priority: 1 },
        { id: 'high', x: 200, width: 100, priority: 3 },
        { id: 'mid', x: 200, width: 100, priority: 2 },
      ],
      area,
      2,
    );
    expect(placed.map((p) => p.id).sort()).toEqual(['high', 'mid']);
    expect(hidden).toEqual(['low']);
    expect(placed.find((p) => p.id === 'high')!.tier).toBe(0);
  });
  it('이름표는 그림 영역 안으로 밀어 넣는다', () => {
    const { placed } = layoutEventLabels(
      [
        { id: 'left', x: 2, width: 80, priority: 1 },
        { id: 'right', x: 399, width: 80, priority: 1 },
      ],
      area,
      1,
    );
    expect(placed.find((p) => p.id === 'left')!.left).toBe(0);
    const right = placed.find((p) => p.id === 'right')!;
    expect(right.left + right.width).toBe(400);
  });
  it('영역보다 넓은 이름표는 영역 폭으로 줄이고 빈 입력은 빈 결과다', () => {
    const { placed } = layoutEventLabels([{ id: 'x', x: 50, width: 900, priority: 1 }], area, 1);
    expect(placed[0].width).toBe(400);
    expect(layoutEventLabels([], area, 3)).toEqual({ placed: [], hidden: [] });
  });
});

describe('기준 100 정규화', () => {
  const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'];
  const closes = [100, 110, 121, 133.1];
  it('첫 공통 날짜의 값을 100으로 맞춘다', () => {
    const kospi = valuesByDate([
      { date: '2026-10-06', value: 2000 },
      { date: '2026-10-07', value: 2100 },
      { date: '2026-10-08', value: 2200 },
    ]);
    const fx = valuesByDate([
      { date: '2026-10-05', value: 1300 },
      { date: '2026-10-07', value: 1430 },
      { date: '2026-10-08', value: 1300 },
    ]);
    const result = computeComparison(dates, closes, { kospi, usdkrw: fx })!;
    // 10-05 has no KOSPI, 10-06 has no USD/KRW: the first common date is 10-07.
    expect(result.baseDate).toBe('2026-10-07');
    expect(result.baseIndex).toBe(2);
    expect(result.priceScale).toBeCloseTo(100 / 121, 10);
    expect(result.values.kospi.map((v) => v && Math.round(v * 100) / 100)).toEqual([
      null,
      95.24,
      100,
      104.76,
    ]);
    expect(result.values.usdkrw[2]).toBe(100);
    expect(result.values.usdkrw[1]).toBeNull();
    expect(result.values.usdkrw[3]).toBeCloseTo((1300 / 1430) * 100, 8);
    // The stock itself is 100 at the base date too.
    expect(closes[2] * result.priceScale).toBeCloseTo(100, 10);
  });
  it('공통 날짜가 없거나 계열이 없으면 null', () => {
    expect(
      computeComparison(dates, closes, {
        a: valuesByDate([{ date: '2026-10-05', value: 1 }]),
        b: valuesByDate([{ date: '2026-10-08', value: 1 }]),
      }),
    ).toBeNull();
    expect(computeComparison(dates, closes, {})).toBeNull();
    expect(computeComparison([], [], { a: new Map([['2026-10-05', 1]]) })).toBeNull();
  });
  it('종가가 없는 행(미래 구름 위치)과 0 이하 값은 기준이 되지 않는다', () => {
    const series = valuesByDate([
      { date: '2026-10-05', value: 0 },
      { date: '2026-10-06', value: -3 },
      { date: '2026-10-07', value: 5 },
    ]);
    expect([...series.keys()]).toEqual(['2026-10-07']);
    const result = computeComparison([null, '2026-10-06', '2026-10-07'], [null, null, 50], {
      a: series,
    })!;
    expect(result.baseIndex).toBe(2);
  });
  it('rebaseRows는 가격 단위 값을 같은 비율로 바꾸고 계열을 cmp_ 키로 붙인다', () => {
    const row = (index: number, close: number): ChartRow =>
      ({
        index,
        label: `r${index}`,
        date: dates[index],
        future: false,
        close,
        sma: close - 1,
        ema: null,
        cloudUp: [close - 2, close + 2],
        cloudDown: null,
        rsi: 55,
      }) as unknown as ChartRow;
    const comparison = computeComparison(dates, closes, {
      kospi: valuesByDate(dates.map((date, i) => ({ date, value: 1000 + i * 10 }))),
    })!;
    const rebased = rebaseRows(
      closes.map((close, index) => row(index, close)),
      comparison.priceScale,
      comparison,
    );
    expect(rebased[0].close).toBeCloseTo(100, 8);
    expect(rebased[0].sma).toBeCloseTo(99, 8);
    expect(rebased[0].ema).toBeNull();
    expect(rebased[1].cloudUp![1]).toBeCloseTo(112, 8);
    expect(rebased[1].rsi).toBe(55); // not a price: untouched
    expect(rebased[3]['cmp_kospi']).toBeCloseTo(103, 8);
  });
  it('평균 매수가 선은 가격대에서 너무 멀면 그리지 않는다', () => {
    const closes = [70000, 72000, 74000];
    expect(costLineState(68000, closes)).toBe('draw');
    expect(costLineState(76000, closes)).toBe('draw');
    expect(costLineState(20000, closes)).toBe('outside');
    expect(costLineState(500000, closes)).toBe('outside');
    expect(costLineState(null, closes)).toBe('none');
    expect(costLineState(0, closes)).toBe('none');
    expect(costLineState(100, [null])).toBe('none');
  });
  it('체결 표시는 거래일 행에 놓고 구간 밖·잘못된 가격은 센다', () => {
    const rows = ['2026-10-05', '2026-10-06', '2026-10-08'];
    const fill = (id: string, date: string, price: string) => ({
      id,
      algorithmName: '테스트',
      side: 'buy' as const,
      mode: 'paper' as const,
      date,
      price,
      quantity: '1',
      currency: 'KRW' as const,
    });
    const { marks, outside } = placeFills(
      [
        fill('a', '2026-10-07', '100'), // holiday -> next trading row
        fill('b', '2026-10-01', '100'),
        fill('c', '2026-10-06', '0'),
        fill('d', '2026-10-05', '99.5'),
      ],
      rows,
    );
    expect(marks.map((m) => [m.id, m.rowIndex, m.priceNumber])).toEqual([
      ['a', 2, 100],
      ['d', 0, 99.5],
    ]);
    expect(outside).toBe(2);
  });
});
