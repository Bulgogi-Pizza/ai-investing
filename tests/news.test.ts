import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { MemoryCalendarRepository } from '../src/server/calendar';
import {
  createNewsRouter,
  officialNewsSources,
  parseOfficialFeed,
  syncOfficialNews,
  type NewsSyncOptions,
} from '../src/server/news';
const now = () => new Date('2026-10-20T08:00:00Z');
function fixture(
  host = 'www.federalreserve.gov',
  title = 'Federal Reserve interest rate announcement',
  pubDate = 'Mon, 19 Oct 2026 18:00:00 GMT',
) {
  return `<?xml version="1.0"?><rss version="2.0"><channel><item><title>${title}</title><link>https://${host}/newsevents/release.htm</link><pubDate>${pubDate}</pubDate><description>PRIVATE BODY MUST NOT BE PERSISTED</description></item></channel></rss>`;
}
function mockTransport(xml = fixture()) {
  return vi.fn(
    async () => new Response(xml, { headers: { 'content-type': 'text/xml' } }),
  ) as unknown as ReturnType<typeof vi.fn> & typeof fetch;
}
function app(
  role: 'admin' | 'member' | null,
  repository = new MemoryCalendarRepository(),
  options: NewsSyncOptions = {},
) {
  const server = express();
  server.use(express.json());
  server.use((_req, res, next) => {
    if (role) res.locals.user = { id: 'test-admin', role, active: true };
    next();
  });
  server.use(createNewsRouter({ repository, options: { now, cache: new Map(), ...options } }));
  return server;
}
describe('공식 RSS 뉴스 수집', () => {
  it('공식 게시시각을 KST로 변환하고 제목·출처만 보존한다', () => {
    const result = parseOfficialFeed(fixture(), officialNewsSources[0], now());
    expect(result.events).toHaveLength(1);
    const event = result.events[0];
    expect(event.date).toBe('2026-10-20');
    expect(event.time).toBe('03:00');
    expect(event.eventKind).toBe('news-release');
    expect(event.country).toBe('미국');
    expect(event.confidence).toBe('low');
    expect(event.impactDirection).toBe('unknown');
    expect(event.importance).toBe(3);
    expect(event.assets).toContain('금리');
    expect(event.factualObservedAt).toBe(now().toISOString());
    expect(Number.isSafeInteger(event.id) && event.id > 0).toBe(true);
    expect(JSON.stringify(event)).not.toContain('PRIVATE BODY');
    expect(event.description).toContain('미래 경제지표 발표 일정');
  });
  it('한국은행 표준시각과 출처를 지원한다', () => {
    const result = parseOfficialFeed(
      fixture('www.bok.or.kr', '한국은행 기준금리 발표', 'Tue, 20 Oct 2026 12:00:00 +0900'),
      officialNewsSources[1],
      now(),
    );
    expect(result.events[0].country).toBe('한국');
    expect(result.events[0].time).toBe('12:00');
    expect(result.events[0].assets).toContain('원화');
  });
  it('DOCTYPE·ENTITY·잘못된 XML과 과대 입력을 거부한다', () => {
    for (const xml of [
      '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>',
      '<!ENTITY test "x"><rss/>',
      '<rss><channel></rss>',
      'a'.repeat(2 * 1024 * 1024 + 1),
    ])
      expect(() => parseOfficialFeed(xml, officialNewsSources[0], now())).toThrow();
  });
  it('비공식 링크·인증정보·미래시각·잘못된 날짜는 저장하지 않는다', () => {
    for (const xml of [
      fixture('evil.example'),
      fixture('user:pass@www.federalreserve.gov'),
      fixture(undefined, undefined, 'not a date'),
      fixture(undefined, undefined, 'Wed, 21 Oct 2026 18:00:00 GMT'),
    ]) {
      const result = parseOfficialFeed(xml, officialNewsSources[0], now());
      expect(result.events).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    }
  });
  it('15분 캐시·고정 URL·redirect 금지·8초 제한 및 중복 ID upsert를 지킨다', async () => {
    const repository = new MemoryCalendarRepository();
    const transport = mockTransport();
    const cache = new Map();
    const first = await syncOfficialNews(repository, {
      sourceIds: ['fed-press'],
      transport,
      cache,
      now,
    });
    const second = await syncOfficialNews(repository, {
      sourceIds: ['fed-press'],
      transport,
      cache,
      now,
    });
    expect(first.sources[0].status).toBe('synced');
    expect(second.sources[0].status).toBe('cached');
    expect(transport).toHaveBeenCalledTimes(1);
    const call = transport.mock.calls[0];
    expect(call[0]).toBe(officialNewsSources[0].feedUrl);
    expect(call[1].redirect).toBe('error');
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
    expect(await repository.list('2026-10-01', '2026-10-31')).toHaveLength(1);
    await syncOfficialNews(repository, {
      sourceIds: ['fed-press'],
      transport,
      cache,
      now: () => new Date(now().getTime() + 16 * 60000),
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('동시 수집의 외부 요청은 출처별 한 번으로 합친다', async () => {
    const transport = mockTransport();
    const repository = new MemoryCalendarRepository();
    const options = { sourceIds: ['fed-press'], transport, cache: new Map(), now };
    await Promise.all([
      syncOfficialNews(repository, options),
      syncOfficialNews(repository, options),
    ]);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('헤더 및 스트림의 과대 응답과 리다이렉트 응답을 실패 처리하고 이전 데이터를 유지한다', async () => {
    const repository = new MemoryCalendarRepository();
    const valid = parseOfficialFeed(fixture(), officialNewsSources[0], now()).events;
    await repository.upsert(valid, 'test');
    for (const makeResponse of [
      () => new Response('<rss/>', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
      () => new Response('a'.repeat(2 * 1024 * 1024 + 1)),
      () => {
        const response = new Response('<rss/>');
        Object.defineProperty(response, 'redirected', { value: true });
        return response;
      },
    ]) {
      const result = await syncOfficialNews(repository, {
        sourceIds: ['fed-press'],
        transport: (async () => makeResponse()) as typeof fetch,
        cache: new Map(),
        now,
      });
      expect(result.sources[0].status).toBe('failed');
      expect(result.count).toBe(0);
      expect(await repository.list('2026-10-01', '2026-10-31')).toHaveLength(1);
    }
  });
  it('임의 URL·알 수 없는 출처·중복 출처를 요청하지 않는다', async () => {
    const transport = mockTransport();
    for (const sourceIds of [['https://evil.example/rss'], ['fed-press', 'fed-press'], []])
      await expect(
        syncOfficialNews(new MemoryCalendarRepository(), { sourceIds, transport }),
      ).rejects.toThrow('INVALID_NEWS_SOURCES');
    expect(transport).not.toHaveBeenCalled();
  });
});
describe('공식 뉴스 API 권한 및 상태', () => {
  it('출처 조회 인증과 수집 관리자 권한을 검사한다', async () => {
    expect((await request(app(null)).get('/api/news/sources')).status).toBe(401);
    expect(
      (
        await request(app('member'))
          .post('/api/admin/news/sync')
          .send({ sourceIds: ['fed-press'] })
      ).status,
    ).toBe(403);
    expect((await request(app('member')).get('/api/news/sources')).body.sources).toHaveLength(2);
  });
  it('성공과 부분실패·전체실패를 구분하며 임의 URL 입력을 거부한다', async () => {
    const transport = mockTransport();
    const admin = app('admin', undefined, { transport });
    const result = await request(admin)
      .post('/api/admin/news/sync')
      .send({ sourceIds: ['fed-press'] });
    expect(result.status).toBe(200);
    expect(result.body.count).toBe(1);
    expect(
      (await request(admin).post('/api/admin/news/sync').send({ url: 'https://evil.example' }))
        .status,
    ).toBe(400);
    const failed = app('admin', undefined, {
      transport: (async () => {
        throw new Error('provider internal secret');
      }) as typeof fetch,
    });
    const failure = await request(failed)
      .post('/api/admin/news/sync')
      .send({ sourceIds: ['fed-press'] });
    expect(failure.status).toBe(503);
    expect(JSON.stringify(failure.body)).not.toContain('internal secret');
    const mixed = app('admin', undefined, {
      transport: (async (url: string | URL | Request) => {
        if (String(url).includes('bok.or.kr')) throw new Error('down');
        return new Response(fixture());
      }) as typeof fetch,
    });
    const partial = await request(mixed).post('/api/admin/news/sync').send({});
    expect(partial.status).toBe(200);
    expect(partial.body.sources.map((source: { status: string }) => source.status)).toEqual([
      'synced',
      'failed',
    ]);
  });
  it('limits repeated authenticated collection writes to three attempts per fifteen minutes', async () => {
    const repository = new MemoryCalendarRepository();
    const writes = vi.spyOn(repository, 'upsert');
    const admin = app('admin', repository, { transport: mockTransport() });
    for (let i = 0; i < 3; i++) {
      expect(
        (
          await request(admin)
            .post('/api/admin/news/sync')
            .send({ sourceIds: ['fed-press'] })
        ).status,
      ).toBe(200);
    }
    const limited = await request(admin)
      .post('/api/admin/news/sync')
      .send({ sourceIds: ['fed-press'] });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(writes).toHaveBeenCalledTimes(3);
  });
});
