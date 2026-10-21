import { describe, expect, it } from 'vitest';
import { cleanupEvent } from '../src/server/calendar-enrich';
import { cleanTitle, decodeEntities, needsCleanup } from '../src/server/calendar-clean';
import { cleanEvent } from '../src/server/calendar';
import { mergeStoredEvent } from '../src/server/calendar-merge';
import { officialNewsSources, parseOfficialFeed } from '../src/server/news';

const fetchedAt = new Date('2026-10-21T00:00:00Z');
const feed = (title: string, host = 'www.federalreserve.gov') =>
  `<?xml version="1.0"?><rss version="2.0"><channel><item><title>${title}</title><link>https://${host}/x/a.htm</link><pubDate>Mon, 19 Oct 2026 18:00:00 GMT</pubDate></item></channel></rss>`;

describe('제목 정리(결정적, AI 없음)', () => {
  it('HTML 엔터티를 해석한다(이중 인코딩 포함)', () => {
    expect(decodeEntities('Powell&#39;s remarks')).toBe("Powell's remarks");
    expect(decodeEntities('Powell&amp;#39;s remarks')).toBe("Powell's remarks");
    expect(decodeEntities('a &#x27;b&#x27; &quot;c&quot; &amp; d')).toBe(`a 'b' "c" & d`);
    expect(decodeEntities('금융&middot;통화&nbsp;정책')).toBe('금융·통화 정책');
    // Unknown names and invalid code points are left as they are.
    expect(decodeEntities('&unknown; &#1; &#xD800;')).toBe('&unknown; &#1; &#xD800;');
  });
  it('앞쪽 [보도자료]·[보도참고자료] 태그를 releaseType으로 분리한다', () => {
    expect(cleanTitle('[보도자료] 2026년 10월 금융통화위원회 개최')).toEqual({
      title: '2026년 10월 금융통화위원회 개최',
      releaseType: '보도자료',
    });
    expect(cleanTitle('[보도참고자료]  한국은행 기준금리 결정')).toEqual({
      title: '한국은행 기준금리 결정',
      releaseType: '보도참고자료',
    });
    expect(cleanTitle('[보도자료][정정] 물가 동향')).toEqual({
      title: '물가 동향',
      releaseType: '보도자료',
    });
    // Tags inside the title and a title that is only a tag stay.
    expect(cleanTitle('물가 [참고] 동향')).toEqual({ title: '물가 [참고] 동향' });
    expect(cleanTitle('[보도자료]')).toEqual({ title: '[보도자료]' });
  });
  it('마크업과 제어 문자를 제거하고 공백을 정리하며 멱등이다', () => {
    const once = cleanTitle('  [보도자료] <b>물가</b>\u0007  동향 &lt;script&gt;x&lt;/script&gt; ');
    expect(once.title).toBe('물가 동향 x');
    expect(cleanTitle(once.title)).toEqual({ title: once.title });
    expect(needsCleanup('Powell&#39;s')).toBe(true);
    expect(needsCleanup('Powell’s remarks')).toBe(false);
  });
});

describe('RSS 수집에 정리 적용', () => {
  it('연준 제목의 엔터티를 풀고 정확한 원문 제목을 titleOriginal로 남긴다', () => {
    const { events } = parseOfficialFeed(
      feed('Federal Reserve Board announces Chair&amp;#39;s remarks'),
      officialNewsSources[0],
      fetchedAt,
    );
    expect(events[0].title).toBe("Federal Reserve Board announces Chair's remarks");
    expect(events[0].titleOriginal).toBe('Federal Reserve Board announces Chair&#39;s remarks');
    expect(events[0].translation).toBeUndefined();
    expect(events[0].releaseType).toBeUndefined();
  });
  it('한국은행 제목의 태그를 releaseType으로 분리한다', () => {
    const { events } = parseOfficialFeed(
      feed('[보도자료] 2026년 10월 통화정책방향', 'www.bok.or.kr'),
      officialNewsSources[1],
      fetchedAt,
    );
    expect(events[0]).toMatchObject({
      title: '2026년 10월 통화정책방향',
      titleOriginal: '[보도자료] 2026년 10월 통화정책방향',
      releaseType: '보도자료',
      importance: 3,
    });
    // Nothing to clean: the title is the source title and no original is stored.
    const plain = parseOfficialFeed(
      feed('Federal Reserve issues FOMC statement'),
      officialNewsSources[0],
      fetchedAt,
    );
    expect(plain.events[0].titleOriginal).toBeUndefined();
  });
});

describe('저장된 이벤트 정리', () => {
  const stored = cleanEvent({
    id: 77,
    eventKind: 'news-release',
    date: '2026-10-20',
    time: '10:00',
    title: '[보도참고자료] 외환시장 동향',
    country: '한국',
    category: '공식 보도자료·외환',
    assets: ['원화'],
    importance: 2,
    description: 'x',
    sourceUrl: 'https://www.bok.or.kr/portal/a',
    sourceName: '한국은행 공식 보도자료',
    impactDirection: 'unknown',
    impactHorizon: 'x',
    confidence: 'low',
    factualObservedAt: '2026-10-21T00:00:00Z',
  })!;
  it('기존 데이터(원문 그대로)를 정리하고 원문을 보존한다', () => {
    const cleaned = cleanupEvent(stored);
    expect(cleaned).toMatchObject({
      title: '외환시장 동향',
      titleOriginal: '[보도참고자료] 외환시장 동향',
      releaseType: '보도참고자료',
    });
    expect(cleanEvent(cleaned)).not.toBeNull();
    // Idempotent; and a translated title is never touched.
    expect(cleanupEvent(cleaned)).toBe(cleaned);
    const translated = {
      ...stored,
      title: '[연준] 번역된 제목',
      titleOriginal: 'Original',
      translation: { model: 'm', translatedAt: '2026-10-21T00:00:00Z' },
    };
    expect(cleanupEvent(translated)).toBe(translated);
  });
  it('RSS가 같은 항목을 다시 줘도 한국어 제목과 보강 내용이 남는다', () => {
    const enriched = {
      ...cleanupEvent(stored),
      outcome: { headline: '외환시장 동향 발표', facts: [] },
      enrichment: {
        model: 'Claude Sonnet 5.5',
        generatedAt: '2026-10-21T00:00:00.000Z',
        version: 1,
        aiFields: ['outcome' as const],
      },
    };
    // What the RSS sync delivers again: cleaned title, exact original, no enrichment.
    const incoming = {
      ...stored,
      title: '외환시장 동향',
      titleOriginal: '[보도참고자료] 외환시장 동향',
      releaseType: '보도참고자료',
    };
    const merged = mergeStoredEvent(enriched, incoming);
    expect(merged.outcome).toEqual(enriched.outcome);
    expect(merged.enrichment).toEqual(enriched.enrichment);
    // A provider-side title change is a different item: nothing is carried over.
    const changed = mergeStoredEvent(enriched, {
      ...incoming,
      title: '완전히 다른 제목',
      titleOriginal: '[보도자료] 완전히 다른 제목',
    });
    expect(changed.outcome).toBeUndefined();
  });
  it('번역된 영어 제목: RSS가 다시 영어 원문을 줘도 번역이 유지된다', () => {
    const translated = {
      ...stored,
      country: '미국' as const,
      title: '연준, 최종 규칙 승인',
      titleOriginal: 'Federal Reserve approves final rule',
      translation: { model: 'Claude Sonnet 5.5', translatedAt: '2026-10-21T00:00:00.000Z' },
      impact: [{ asset: '은행', effect: '자본 부담 완화 가능성' }],
    };
    const incoming = {
      ...stored,
      country: '미국' as const,
      title: 'Federal Reserve approves final rule',
    };
    const merged = mergeStoredEvent(translated, incoming);
    expect(merged.title).toBe('연준, 최종 규칙 승인');
    expect(merged.translation).toEqual(translated.translation);
    expect(merged.impact).toEqual(translated.impact);
    expect(merged.titleOriginal).toBe('Federal Reserve approves final rule');
  });
});
