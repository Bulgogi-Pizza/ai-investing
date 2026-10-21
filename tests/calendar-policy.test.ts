import { describe, expect, it, vi } from 'vitest';
import { cleanEvent, type EconomicEvent } from '../src/server/calendar';
import {
  isBokDecision,
  isFedDecision,
  policyFactsProvider,
  type PolicySource,
} from '../src/server/calendar-policy';

const base = {
  eventKind: 'news-release' as const,
  category: '공식 보도자료·통화정책',
  assets: ['금리'],
  importance: 3,
  description: 'x',
  impactDirection: 'unknown' as const,
  impactHorizon: 'x',
  confidence: 'low' as const,
  factualObservedAt: '2026-10-30T00:00:00Z',
};
const fed = (date = '2026-10-29', title = 'Federal Reserve issues FOMC statement') =>
  cleanEvent({
    ...base,
    id: 1,
    date,
    time: '03:00',
    title,
    country: '미국',
    sourceUrl: 'https://www.federalreserve.gov/a.htm',
    sourceName: '미 연준 공식 보도자료',
  })!;
const bok = (title = '2026년 10월 통화정책방향', date = '2026-10-23') =>
  cleanEvent({
    ...base,
    id: 2,
    date,
    time: '10:00',
    title,
    country: '한국',
    sourceUrl: 'https://www.bok.or.kr/a',
    sourceName: '한국은행 공식 보도자료',
  })!;
/** Observations by id and as-of date: the latest one known on or before that day. */
const source = (
  series: Record<string, [string, string][]>,
): PolicySource & {
  latestObservations: ReturnType<typeof vi.fn>;
} => ({
  latestObservations: vi.fn(async (ids: string[], asOf: string) =>
    ids.map((id) => {
      const known = (series[id] ?? [])
        .filter(([date]) => date <= asOf)
        .sort((a, b) => b[0].localeCompare(a[0]));
      const row = (entry?: [string, string]) =>
        entry ? { date: entry[0], value: entry[1] } : null;
      return { id, latest: row(known[0]), previous: row(known[1]) };
    }),
  ),
});
const provider = (deps: Parameters<typeof policyFactsProvider>[0]) => policyFactsProvider(deps);

describe('정책금리 공식 수치(결정적)', () => {
  const cut = {
    'us-fed-funds-lower': [
      ['2026-10-27', '4.25'],
      ['2026-10-30', '4.00'],
    ] as [string, string][],
    'us-fed-funds-upper': [
      ['2026-10-27', '4.50'],
      ['2026-10-30', '4.25'],
    ] as [string, string][],
  };
  const hold = {
    'us-fed-funds-lower': [
      ['2026-10-27', '4.25'],
      ['2026-10-30', '4.25'],
    ] as [string, string][],
    'us-fed-funds-upper': [
      ['2026-10-27', '4.50'],
      ['2026-10-30', '4.50'],
    ] as [string, string][],
  };
  it('연준: 결정 직후와 직전의 두 공식 관측을 비교해 목표 범위와 변동(bp)을 만든다', async () => {
    const fred = source(cut);
    const facts = await provider({ fred, today: () => '2026-11-05' })(fed());
    expect(facts).toEqual([
      { label: '연방기금금리 목표 범위', value: '4.00~4.25%', note: '출처: FRED, 2026-10-30 기준' },
      { label: '변동', value: '인하 25bp' },
    ]);
    // After = as of D+3, before = as of D-2.
    expect(fred.latestObservations.mock.calls.map((call) => call[1])).toEqual([
      '2026-11-01',
      '2026-10-27',
    ]);
    expect(await provider({ fred: source(hold), today: () => '2026-11-05' })(fed())).toEqual([
      { label: '연방기금금리 목표 범위', value: '4.25~4.50%', note: '출처: FRED, 2026-10-30 기준' },
      { label: '변동', value: '동결(0bp)' },
    ]);
    const hike = {
      'us-fed-funds-lower': [
        ['2026-10-27', '4.25'],
        ['2026-10-30', '4.50'],
      ] as [string, string][],
      'us-fed-funds-upper': [
        ['2026-10-27', '4.50'],
        ['2026-10-30', '4.75'],
      ] as [string, string][],
    };
    expect(
      (await provider({ fred: source(hike), today: () => '2026-11-05' })(fed()))[1].value,
    ).toBe('인상 25bp');
  });
  it('결정 이후 관측이 아직 없거나 직전 관측이 너무 오래됐으면 수치를 만들지 않는다', async () => {
    // Same day: the new level is not in FRED yet (latest observation is before the decision).
    expect(await provider({ fred: source(cut), today: () => '2026-10-29' })(fed())).toEqual([]);
    const stale = { ...cut, 'us-fed-funds-lower': [['2026-09-01', '4.25']] as [string, string][] };
    expect(await provider({ fred: source(stale), today: () => '2026-11-05' })(fed())).toEqual([]);
    const bad = {
      ...cut,
      'us-fed-funds-upper': [
        ['2026-10-27', 'n/a'],
        ['2026-10-30', 'n/a'],
      ] as [string, string][],
    };
    expect(await provider({ fred: source(bad), today: () => '2026-11-05' })(fed())).toEqual([]);
  });
  it('한국은행: ECOS 기준금리의 결정일 값과 직전 값', async () => {
    const ecos = source({
      'kr-base-rate': [
        ['2026-10-22', '2.75'],
        ['2026-10-23', '2.50'],
      ],
    });
    const facts = await provider({ ecos, today: () => '2026-10-30' })(bok());
    expect(facts).toEqual([
      { label: '기준금리', value: '2.50%', note: '출처: 한국은행 ECOS, 2026-10-23 기준' },
      { label: '변동', value: '인하 25bp' },
    ]);
    expect(ecos.latestObservations.mock.calls.map((call) => call[1])).toEqual([
      '2026-10-25',
      '2026-10-22',
    ]);
    const held = source({
      'kr-base-rate': [
        ['2026-10-22', '2.50'],
        ['2026-10-23', '2.50'],
      ],
    });
    expect((await provider({ ecos: held, today: () => '2026-10-30' })(bok()))[1].value).toBe(
      '동결(0bp)',
    );
  });
  it('결정 발표가 아니거나 어댑터가 없으면 아무 것도 만들지 않는다', async () => {
    const fred = source(cut);
    const ecos = source({ 'kr-base-rate': [['2026-10-23', '2.50']] });
    const facts = provider({ fred, ecos, today: () => '2026-11-05' });
    expect(
      await facts(fed('2026-10-29', 'Federal Reserve Board announces approval of application')),
    ).toEqual([]);
    expect(await facts(bok('통화정책방향 의사록 공개'))).toEqual([]);
    expect(await facts(bok('외환시장 동향', '2026-10-23'))).toEqual([]);
    expect(fred.latestObservations).not.toHaveBeenCalled();
    expect(await provider({ today: () => '2026-11-05' })(fed())).toEqual([]);
    expect(await provider({ ecos, today: () => '2026-11-05' })(fed())).toEqual([]);
  });
  it('판별: 번역된 제목이어도 정확한 원문 제목으로 연준 결정을 알아본다', () => {
    const translated: EconomicEvent = {
      ...fed(),
      title: '연준, FOMC 성명 발표',
      titleOriginal: 'Federal Reserve issues FOMC statement',
    };
    expect(isFedDecision(translated)).toBe(true);
    expect(isFedDecision(fed('2026-10-29', 'Federal Reserve issues FOMC minutes'))).toBe(false);
    expect(isBokDecision(bok())).toBe(true);
    expect(isBokDecision(bok('통화정책방향 설명자료'))).toBe(false);
  });
});
