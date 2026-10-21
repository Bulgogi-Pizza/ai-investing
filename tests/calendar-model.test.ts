import { describe, expect, it } from 'vitest';
import { cleanEvent } from '../src/server/calendar';

const event = {
  id: 7,
  eventKind: 'news-release',
  date: '2026-10-20',
  time: '10:00',
  title: '한국은행 발표',
  country: '한국',
  category: '공식 보도자료·기관발표',
  assets: ['시장전반'],
  importance: 1,
  description: 'x',
  sourceUrl: 'https://www.bok.or.kr/a',
  sourceName: '한국은행 공식 보도자료',
  impactDirection: 'unknown',
  impactHorizon: 'x',
  confidence: 'low',
  factualObservedAt: '2026-10-21T00:00:00Z',
};
const row = {
  asset: 'KOSPI',
  from: { date: '2026-10-19', value: 2500 },
  to: { date: '2026-10-20', value: 2510 },
  change: 0.4,
  unit: '%',
  source: '토스증권 OpenAPI 시장 지표(일봉 종가)',
};
const full = {
  ...event,
  titleOriginal: '[보도자료] 한국은행 발표',
  releaseType: '보도자료',
  outcome: {
    headline: '기준금리를 동결했다',
    facts: [{ label: '기준금리', value: '2.50%', note: '출처: ECOS' }],
  },
  reaction: [row, { ...row, asset: 'USDKRW', unit: '원', change: 3.2, changePercent: 0.23 }],
  impact: [{ asset: '채권', effect: '금리 하락 압력이 완화될 수 있다' }],
  explainer: '정책금리는 중앙은행이 정하는 기준 금리이다.',
  enrichment: {
    model: 'Claude Sonnet 5.5',
    generatedAt: '2026-10-21T00:00:00.000Z',
    version: 1,
    aiFields: ['outcome', 'impact', 'explainer'],
  },
};

describe('캘린더 모델: 보강 필드', () => {
  it('기존 이벤트(새 필드 없음)는 그대로 통과하고 새 필드는 만들어지지 않는다', () => {
    const old = cleanEvent(event)!;
    for (const key of ['outcome', 'reaction', 'impact', 'explainer', 'enrichment', 'releaseType'])
      expect(old).not.toHaveProperty(key);
    // The exact provider title without a translation is valid now; a translation still needs it.
    expect(cleanEvent({ ...event, titleOriginal: '원문' })?.titleOriginal).toBe('원문');
    expect(
      cleanEvent({ ...event, translation: { model: 'm', translatedAt: '2026-10-21T00:00:00Z' } }),
    ).toBeNull();
  });
  it('모든 새 필드를 검증해서 그대로 돌려준다', () => {
    const cleaned = cleanEvent({ ...full, authorId: 'secret' })!;
    expect(cleaned).toMatchObject(full);
    expect(cleaned).not.toHaveProperty('authorId');
    expect(cleaned.reaction?.[1]).toMatchObject({ unit: '원', changePercent: 0.23 });
  });
  it('형식이 어긋나면 이벤트 전체를 거부한다', () => {
    const bad: Record<string, unknown>[] = [
      { outcome: { headline: '가'.repeat(61), facts: [] } },
      {
        outcome: {
          headline: '결과',
          facts: Array.from({ length: 9 }, (_, i) => ({ label: `항목${i}`, value: 'v' })),
        },
      },
      { outcome: { headline: '결과', facts: [{ label: '', value: 'v' }] } },
      { outcome: { headline: '결과 https://x.example', facts: [] } },
      { outcome: { headline: '<b>결과</b>', facts: [] } },
      { reaction: [{ ...row, asset: 'NASDAQ' }] },
      { reaction: [{ ...row, unit: 'bp' }] },
      { reaction: [{ ...row, change: Number.NaN }] },
      { reaction: [{ ...row, from: { date: '2026-13-01', value: 1 } }] },
      { reaction: [row, row] },
      { reaction: Array.from({ length: 7 }, () => row) },
      { impact: [{ asset: '채권', effect: '가'.repeat(61) }] },
      { impact: Array.from({ length: 5 }, (_, i) => ({ asset: `자산${i}`, effect: '상승 압력' })) },
      { explainer: '가'.repeat(301) },
      { explainer: '자세한 내용은 https://example.com' },
      { explainer: ' 앞뒤 공백 ' },
      { enrichment: { ...full.enrichment, aiFields: ['price'] } },
      { enrichment: { ...full.enrichment, aiFields: ['title', 'title'] } },
      { enrichment: { ...full.enrichment, version: 0 } },
      { enrichment: { ...full.enrichment, generatedAt: 'yesterday' } },
      { releaseType: '' },
    ];
    for (const extra of bad)
      expect(cleanEvent({ ...event, ...extra }), JSON.stringify(extra).slice(0, 60)).toBeNull();
  });
});
