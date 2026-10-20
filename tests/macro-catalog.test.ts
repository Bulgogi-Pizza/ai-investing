import { describe, expect, it } from 'vitest';
import { cleanEvent } from '../src/server/calendar';
import {
  ecosIndicator,
  fredIndicator,
  indicatorById,
  indicatorCatalog,
  releaseCatalog,
} from '../src/server/macro/catalog';
import { macroEventId, releaseEventDraft, toEconomicEvent } from '../src/server/macro/events';

describe('지표 카탈로그', () => {
  it('id가 유일하고 필드 규칙을 지킨다', () => {
    const ids = indicatorCatalog.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of indicatorCatalog) {
      expect(entry.id).toMatch(/^(us|kr)-[a-z0-9-]+$/);
      expect([1, 2, 3]).toContain(entry.importance);
      expect(entry.importanceRationale.length).toBeGreaterThan(5);
      expect(['경제 지표', '금리 결정']).toContain(entry.category);
      expect(entry.assets.length).toBeGreaterThan(0);
      expect(entry.titleKo).toMatch(/[가-힣]/);
      expect(new URL(entry.sourceUrl).protocol).toBe('https:');
      expect(entry.country).toBe(entry.id.startsWith('us-') ? '미국' : '한국');
    }
  });

  it('공식 페이지·ECOS 코드 검색으로 확인한 시리즈 ID와 발표 ID만 담는다', () => {
    const fred = Object.fromEntries(
      indicatorCatalog.flatMap((entry) =>
        entry.source === 'fred' ? [[entry.seriesId, entry.releaseId]] : [],
      ),
    );
    expect(fred).toEqual({
      CPIAUCSL: 10,
      CPILFESL: 10,
      UNRATE: 50,
      PAYEMS: 50,
      GDPC1: 53,
      PCEPI: 54,
      PCEPILFE: 54,
      DFEDTARU: 101,
      DFEDTARL: 101,
    });
    const ecos = Object.fromEntries(
      indicatorCatalog.flatMap((entry) =>
        entry.source === 'ecos'
          ? [[entry.id, `${entry.statCode}/${entry.itemCode}/${entry.cycle}`]]
          : [],
      ),
    );
    expect(ecos).toEqual({
      'kr-base-rate': '722Y001/0101000/D',
      'kr-cpi': '901Y009/0/M',
      'kr-usdkrw': '731Y001/0000001/D',
    });
  });

  it('조회 함수는 카탈로그 id만 찾고 출처가 다르면 찾지 못한다', () => {
    expect(indicatorById('us-cpi')?.source).toBe('fred');
    expect(fredIndicator('us-cpi')?.seriesId).toBe('CPIAUCSL');
    expect(ecosIndicator('us-cpi')).toBeUndefined();
    expect(fredIndicator('kr-usdkrw')).toBeUndefined();
    for (const value of [
      'CPIAUCSL',
      '731Y001',
      '',
      undefined,
      1,
      null,
      {},
      ['us-cpi'],
      '__proto__',
      'constructor',
    ])
      expect(indicatorById(value)).toBeUndefined();
  });

  it('발표 카탈로그는 발표 ID별로 묶고 가장 높은 중요도를 쓴다', () => {
    const releases = releaseCatalog();
    expect(releases.map((release) => release.releaseId).sort((a, b) => a - b)).toEqual([
      10, 50, 53, 54, 101,
    ]);
    const gdp = releases.find((release) => release.releaseId === 53);
    expect(gdp?.importance).toBe(2);
    const pce = releases.find((release) => release.releaseId === 54);
    expect(pce?.importance).toBe(3);
    expect(pce?.indicatorIds).toEqual(['us-pce', 'us-core-pce']);
    expect(releases.find((release) => release.releaseId === 101)?.category).toBe('금리 결정');
  });
});

describe('캘린더 연결', () => {
  const release = { releaseId: 10, date: '2026-11-13', indicatorIds: ['us-cpi', 'us-core-cpi'] };
  it('이벤트 ID는 결정적이고 안전한 양의 정수다', () => {
    const a = macroEventId('fred-release:10:2026-11-13');
    expect(a).toBe(macroEventId('fred-release:10:2026-11-13'));
    expect(a).not.toBe(macroEventId('fred-release:10:2026-12-10'));
    expect(Number.isSafeInteger(a)).toBe(true);
    expect(a).toBeGreaterThan(1_000_000_000_000_000);
  });
  it('초안은 시각 없이 만들고 KST 날짜·시각을 받아야 캘린더 모델이 된다', () => {
    const draft = releaseEventDraft(release, new Date('2026-10-21T03:00:00Z'));
    expect(draft).not.toBeNull();
    expect(draft).not.toHaveProperty('time');
    expect(draft?.releaseDate).toBe('2026-11-13');
    const event = toEconomicEvent(draft!, { date: '2026-11-13', time: '22:30' });
    expect(event).toMatchObject({
      date: '2026-11-13',
      time: '22:30',
      country: '미국',
      importance: 3,
      sourceName: 'FRED',
      eventKind: 'scheduled',
    });
    expect(cleanEvent(event)).toEqual(event);
    expect(toEconomicEvent(draft!, { date: '2026-11-13', time: '25:00' })).toBeNull();
    expect(toEconomicEvent(draft!, { date: '2026-02-31', time: '22:30' })).toBeNull();
  });
  it('카탈로그에 없는 발표는 초안을 만들지 않는다', () => {
    expect(
      releaseEventDraft({ releaseId: 999, date: '2026-11-13', indicatorIds: [] }, new Date()),
    ).toBeNull();
  });
});
