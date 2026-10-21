import { describe, expect, it, vi } from 'vitest';
import type { EconomicEvent } from '../src/server/calendar';
import {
  releaseFactsProvider,
  releaseSeries,
  titledMonth,
} from '../src/server/calendar-release-facts';
import type { EcosObservation } from '../src/server/macro/ecos';

const event = (title: string, over: Partial<EconomicEvent> = {}) =>
  ({
    id: 1,
    date: '2026-10-21',
    time: '06:00',
    title,
    country: '한국',
    sourceName: '한국은행 공식 보도자료',
    ...over,
  }) as EconomicEvent;
const row = (date: string, value: string | null): EcosObservation => ({
  date,
  period: date.slice(0, 7).replace('-', ''),
  value,
  unit: null,
});
// ECOS values checked on 2026-10-21 (404Y014 *AA, 402Y014/401Y015 *AA W, 511Y002, 732Y001 99).
const series: Record<string, EcosObservation[]> = {
  'kr-ppi': [row('2025-09-01', '125.00'), row('2026-08-01', '129.58'), row('2026-09-01', '129.78')],
  'kr-export-price': [row('2026-08-01', '183.67'), row('2026-09-01', '182.29')],
  'kr-import-price': [row('2026-08-01', '156.68'), row('2026-09-01', '159.37')],
  'kr-ccsi': [row('2026-08-01', '104.5'), row('2026-09-01', '106.6')],
  'kr-fx-reserves': [row('2026-08-01', '442281314'), row('2026-09-01', '440556657')],
  'kr-current-account': [row('2026-07-01', '40894.8'), row('2026-08-01', '48587.6')],
  'kr-loan-rate': [row('2026-07-01', '4.27'), row('2026-08-01', '4.4')],
};
const source = () => ({
  observations: vi.fn(async (id: string, range: { from: string; to: string }) =>
    (series[id] ?? []).filter((item) => item.date >= range.from && item.date <= range.to),
  ),
});

describe('한국은행 통계 발표의 공식 수치(ECOS)', () => {
  it('제목으로 계열과 기준 월을 고르고, 한국은행 피드가 아니면 고르지 않는다', () => {
    expect(releaseSeries(event('2026년 9월 생산자물가지수(잠정)')).map((s) => s.id)).toEqual([
      'kr-ppi',
    ]);
    expect(releaseSeries(event('2026년 8월 국제수지(잠정)')).map((s) => s.id)).toEqual([
      'kr-current-account',
    ]);
    expect(releaseSeries(event('2026년 2/4분기 국제투자대조표(잠정)'))).toEqual([]);
    expect(releaseSeries(event('2026년 9월 「물가상황점검회의」 개최'))).toEqual([]);
    expect(releaseSeries(event('2026년 9월 생산자물가지수', { sourceName: 'FRED' }))).toEqual([]);
    expect(titledMonth('2026년 9월말 외환보유액')).toBe('2026-09-01');
    expect(titledMonth('2026년 13월 무엇')).toBeNull();
    expect(titledMonth('통화정책방향(2026.8.27)')).toBeNull();
  });
  it('지수는 수준·전월 대비·전년 동월 대비를 코드가 계산하고 출처 주석을 단다', async () => {
    const facts = await releaseFactsProvider(source())(event('2026년 9월 생산자물가지수(잠정)'));
    expect(facts).toEqual([
      {
        label: '생산자물가지수(2020=100)',
        value: '129.78',
        note: '출처: 한국은행 ECOS, 2026년 9월(현재 공표값)',
      },
      { label: '전월 대비', value: '+0.2%' },
      { label: '전년 동월 대비', value: '+3.8%' },
    ]);
  });
  it('두 계열 발표는 변동 항목에 계열 이름을 붙이고, 단위를 읽기 쉽게 바꾼다', async () => {
    const provider = releaseFactsProvider(source());
    expect(await provider(event('2026년 9월 수출입물가지수 및 무역지수(잠정)'))).toEqual([
      expect.objectContaining({ label: '수출물가지수(원화기준)', value: '182.29' }),
      { label: '수출물가지수 전월 대비', value: '-0.8%' },
      { label: '수입물가지수(원화기준)', value: '159.37' },
      { label: '수입물가지수 전월 대비', value: '+1.7%' },
    ]);
    expect(await provider(event('2026년 9월 소비자동향조사 결과'))).toEqual([
      expect.objectContaining({ label: '소비자심리지수(CCSI)', value: '106.6' }),
      { label: '전월 대비', value: '+2.1p' },
    ]);
    expect(await provider(event('2026년 9월말 외환보유액'))).toEqual([
      expect.objectContaining({ label: '외환보유액', value: '4405.6억 달러' }),
      { label: '전월 대비', value: '-17.2억 달러' },
    ]);
    expect(await provider(event('2026년 8월 국제수지(잠정)'))).toEqual([
      expect.objectContaining({ label: '경상수지(계절조정)', value: '+485.9억 달러' }),
      { label: '전월', value: '+408.9억 달러' },
    ]);
    expect(await provider(event('2026년 8월 금융기관 가중평균금리'))).toEqual([
      expect.objectContaining({ value: '4.40%' }),
      { label: '전월 대비', value: '+0.13%p' },
    ]);
  });
  it('기준 월 값이 아직 없으면 null(대기), 계열이 없는 발표는 빈 배열', async () => {
    const provider = releaseFactsProvider(source());
    expect(await provider(event('2026년 10월 생산자물가지수(잠정)'))).toBeNull();
    expect(await provider(event('한국은행 부총재 인사'))).toEqual([]);
  });
});
