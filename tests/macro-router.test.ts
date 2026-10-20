import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { EcosAdapter } from '../src/server/macro/ecos';
import { FredAdapter } from '../src/server/macro/fred';
import { createMacroRouter } from '../src/server/macro/router';
import { RateLimiter } from '../src/server/fundamentals/shared';
import { ProviderError } from '../src/server/toss';

const OWNER = 'owner-1';
const FRED_KEY = 'abcdefghijklmnopqrstuvwxyz012345';
const ECOS_KEY = 'TESTKEY0123456789ABCDEF';
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/macro/${name}`, import.meta.url), 'utf8'));

function fredStub() {
  return {
    observations: vi.fn(async () => [
      { date: '2026-08-01', value: '302.900' },
      { date: '2026-09-01', value: null },
    ]),
    upcomingReleases: vi.fn(async () => [
      {
        releaseId: 50,
        date: '2026-11-06',
        indicatorIds: ['us-unemployment', 'us-nonfarm-payrolls'],
      },
      { releaseId: 999, date: '2026-11-07', indicatorIds: [] },
    ]),
  };
}
function ecosStub() {
  return {
    observations: vi.fn(async () => [
      { date: '2026-10-12', period: '20261012', value: '1400.5', unit: '원' },
    ]),
  };
}
type User = { id: string; role?: string; active?: boolean } | null;
function app(
  user: User,
  options: {
    fred?: ReturnType<typeof fredStub> | FredAdapter;
    ecos?: ReturnType<typeof ecosStub> | EcosAdapter;
    owner?: string;
  } = {},
) {
  const server = express();
  server.use((_req, res, next) => {
    if (user) res.locals.user = user;
    next();
  });
  server.use(
    createMacroRouter({
      fred: options.fred,
      ecos: options.ecos,
      ownerUserId: options.owner ?? OWNER,
      now: () => new Date('2026-10-21T03:00:00Z'),
    }),
  );
  return server;
}
const owner = { id: OWNER, role: 'member', active: true };
const seriesUrl = '/api/macro/series?source=fred&id=us-cpi&from=2026-01-01&to=2026-10-01';
const releasesUrl = '/api/macro/releases?from=2026-10-22&to=2026-11-30';

describe('거시 지표 API 권한', () => {
  it('비로그인·비활성은 401, 소유자가 아니면 403이며 제공자를 호출하지 않는다', async () => {
    const fred = fredStub();
    const ecos = ecosStub();
    for (const url of [seriesUrl, releasesUrl]) {
      expect((await request(app(null, { fred, ecos })).get(url)).status).toBe(401);
      expect(
        (await request(app({ ...owner, active: false }, { fred, ecos })).get(url)).status,
      ).toBe(401);
      const other = await request(
        app({ id: 'someone', role: 'admin', active: true }, { fred, ecos }),
      ).get(url);
      expect(other.status).toBe(403);
      expect(other.body.error.code).toBe('OWNER_REQUIRED');
      expect((await request(app(owner, { fred, ecos, owner: '' })).get(url)).status).toBe(403);
    }
    expect(fred.observations).not.toHaveBeenCalled();
    expect(fred.upcomingReleases).not.toHaveBeenCalled();
    expect(ecos.observations).not.toHaveBeenCalled();
  });
  it('인증은 입력 검증과 제공자 설정 확인보다 먼저다', async () => {
    expect((await request(app(null)).get('/api/macro/series?source=xx')).status).toBe(401);
    expect((await request(app(null)).get('/api/macro/releases')).status).toBe(401);
  });
});

describe('거시 지표 API 입력 검증', () => {
  it('series는 source·카탈로그 id·기간만 받는다', async () => {
    const fred = fredStub();
    const ecos = ecosStub();
    const server = app(owner, { fred, ecos });
    const queries = [
      '',
      '?source=fred&id=us-cpi&from=2026-01-01',
      '?source=fred&id=us-cpi&to=2026-10-01',
      '?id=us-cpi&from=2026-01-01&to=2026-10-01',
      '?source=FRED&id=us-cpi&from=2026-01-01&to=2026-10-01',
      '?source=bls&id=us-cpi&from=2026-01-01&to=2026-10-01',
      // series ids and codes straight from the providers are not catalog ids
      '?source=fred&id=CPIAUCSL&from=2026-01-01&to=2026-10-01',
      '?source=ecos&id=731Y001&from=2026-01-01&to=2026-10-01',
      '?source=fred&id=UNRATE&from=2026-01-01&to=2026-10-01',
      // catalog id used with the wrong source
      '?source=ecos&id=us-cpi&from=2026-01-01&to=2026-10-01',
      '?source=fred&id=kr-usdkrw&from=2026-01-01&to=2026-10-01',
      '?source=fred&id=us-cpi%26series_id%3DX&from=2026-01-01&to=2026-10-01',
      '?source=fred&id=..%2Fus-cpi&from=2026-01-01&to=2026-10-01',
      '?source=fred&id=&from=2026-01-01&to=2026-10-01',
      '?source=fred&id=us-cpi&from=2026-13-01&to=2026-10-01',
      '?source=fred&id=us-cpi&from=20260101&to=2026-10-01',
      '?source=fred&id=us-cpi&from=2026-10-02&to=2026-10-01',
      '?source=fred&id=us-cpi&from=2010-01-01&to=2026-10-01',
      '?source=fred&id=us-cpi&from=2026-01-01&to=2026-10-01&extra=1',
      '?source=fred&source=ecos&id=us-cpi&from=2026-01-01&to=2026-10-01',
      '?source=fred&id=us-cpi&id=us-gdp&from=2026-01-01&to=2026-10-01',
      '?source[a]=fred&id=us-cpi&from=2026-01-01&to=2026-10-01',
      '?source=fred&id[]=us-cpi&from=2026-01-01&to=2026-10-01',
    ];
    for (const query of queries) {
      const response = await request(server).get(`/api/macro/series${query}`);
      expect(response.status, query).toBe(400);
      expect(response.body.error.code).toBe('INVALID_MACRO_QUERY');
    }
    expect(fred.observations).not.toHaveBeenCalled();
    expect(ecos.observations).not.toHaveBeenCalled();
  });
  it('releases는 from·to만 받고 최대 120일이다', async () => {
    const fred = fredStub();
    const server = app(owner, { fred });
    for (const query of [
      '',
      '?from=2026-10-22',
      '?from=2026-10-22&to=2027-03-01',
      '?from=2026-10-22&to=2027-02-20', // 121 days
      '?from=2026-11-30&to=2026-10-22',
      '?from=2026-10-22&to=2026-11-30&limit=5',
      '?from=2026-10-22&to=2026-02-31',
      '?from=2026-10-22&from=2026-10-23&to=2026-11-30',
    ]) {
      const response = await request(server).get(`/api/macro/releases${query}`);
      expect(response.status, query).toBe(400);
      expect(response.body.error.code).toBe('INVALID_MACRO_QUERY');
    }
    expect(fred.upcomingReleases).not.toHaveBeenCalled();
    const edge = await request(server).get('/api/macro/releases?from=2026-10-22&to=2027-02-19');
    expect(edge.status).toBe(200);
  });
});

describe('거시 지표 API 설정 상태', () => {
  it('설정되지 않은 제공자는 503이고 코드가 서로 다르다', async () => {
    const server = app(owner);
    const fred = await request(server).get(seriesUrl);
    expect(fred.status).toBe(503);
    expect(fred.body.error.code).toBe('FRED_UNAVAILABLE');
    const ecos = await request(server).get(
      '/api/macro/series?source=ecos&id=kr-usdkrw&from=2026-10-01&to=2026-10-15',
    );
    expect(ecos.status).toBe(503);
    expect(ecos.body.error.code).toBe('ECOS_UNAVAILABLE');
    const releases = await request(server).get(releasesUrl);
    expect(releases.status).toBe(503);
    expect(releases.body.error.code).toBe('FRED_UNAVAILABLE');
  });
  it('한쪽만 설정돼도 그쪽은 동작한다', async () => {
    const response = await request(app(owner, { ecos: ecosStub() })).get(
      '/api/macro/series?source=ecos&id=kr-usdkrw&from=2026-10-01&to=2026-10-15',
    );
    expect(response.status).toBe(200);
  });
  it('입력 검증이 설정 확인보다 먼저다', async () => {
    const response = await request(app(owner)).get(
      '/api/macro/series?source=fred&id=CPIAUCSL&from=a&to=b',
    );
    expect(response.status).toBe(400);
  });
});

describe('거시 지표 API 동작', () => {
  it('FRED 시리즈를 카탈로그 정보와 함께 돌려준다', async () => {
    const fred = fredStub();
    const response = await request(app(owner, { fred })).get(seriesUrl);
    expect(response.status).toBe(200);
    expect(fred.observations).toHaveBeenCalledWith('us-cpi', {
      from: '2026-01-01',
      to: '2026-10-01',
    });
    expect(response.body).toMatchObject({
      id: 'us-cpi',
      source: 'fred',
      country: '미국',
      unit: '지수(1982-1984=100)',
      asOf: '2026-10-21T03:00:00.000Z',
      observations: [
        { date: '2026-08-01', value: '302.900' },
        { date: '2026-09-01', value: null },
      ],
    });
    expect(response.body.notice).toContain('수정될 수 있어');
    expect(JSON.stringify(response.body)).not.toContain('seriesId');
  });
  it('ECOS 시리즈는 날짜와 값만 내보낸다', async () => {
    const ecos = ecosStub();
    const response = await request(app(owner, { ecos })).get(
      '/api/macro/series?source=ecos&id=kr-usdkrw&from=2026-10-01&to=2026-10-15',
    );
    expect(response.status).toBe(200);
    expect(ecos.observations).toHaveBeenCalledWith('kr-usdkrw', {
      from: '2026-10-01',
      to: '2026-10-15',
    });
    expect(response.body.observations).toEqual([{ date: '2026-10-12', value: '1400.5' }]);
    expect(response.body.titleKo).toBe('원/달러 환율(매매기준율)');
  });
  it('발표 일정은 카탈로그 정보를 붙이고 카탈로그에 없는 발표는 버린다', async () => {
    const fred = fredStub();
    const response = await request(app(owner, { fred })).get(releasesUrl);
    expect(response.status).toBe(200);
    expect(fred.upcomingReleases).toHaveBeenCalledWith('2026-10-22', '2026-11-30');
    expect(response.body.source).toBe('FRED');
    expect(response.body.releases).toHaveLength(1);
    expect(response.body.releases[0]).toMatchObject({
      releaseId: 50,
      date: '2026-11-06',
      timeKnown: false,
      importance: 3,
      category: '경제 지표',
      indicatorIds: ['us-unemployment', 'us-nonfarm-payrolls'],
      sourceUrl: 'https://fred.stlouisfed.org/release?rid=50',
    });
  });
  it('제공자 오류를 코드·상태·Retry-After로 옮기고 그 밖의 오류는 일반 문구로 가린다', async () => {
    const fred = fredStub();
    fred.observations.mockRejectedValueOnce(
      new ProviderError(
        503,
        'PROVIDER_RATE_LIMITED',
        '제공자 요청 한도로 잠시 대기해야 합니다.',
        30,
      ),
    );
    const limited = await request(app(owner, { fred })).get(seriesUrl);
    expect(limited.status).toBe(503);
    expect(limited.body.error.code).toBe('PROVIDER_RATE_LIMITED');
    expect(limited.headers['retry-after']).toBe('30');
    fred.observations.mockRejectedValueOnce(new Error(`boom ${FRED_KEY}`));
    const unknown = await request(app(owner, { fred })).get(seriesUrl);
    expect(unknown.status).toBe(500);
    expect(unknown.body.error.code).toBe('MACRO_FAILED');
    expect(JSON.stringify(unknown.body)).not.toContain(FRED_KEY);
    fred.observations.mockRejectedValueOnce(new RangeError('x'));
    expect((await request(app(owner, { fred })).get(seriesUrl)).status).toBe(400);
  });
});

describe('실제 어댑터와 연결(주입 transport)', () => {
  it('응답과 오류 어디에도 키가 나오지 않는다', async () => {
    const urls: string[] = [];
    const fredTransport = vi.fn(async (input: string) => {
      urls.push(input);
      return new Response(JSON.stringify(fixture('fred-observations-cpi.json')), { status: 200 });
    });
    const ecosTransport = vi.fn(async (input: string) => {
      urls.push(input);
      return new Response(JSON.stringify(fixture('ecos-error-key.json')), { status: 200 });
    });
    const server = app(owner, {
      fred: new FredAdapter({
        apiKey: FRED_KEY,
        transport: fredTransport as never,
        limiter: new RateLimiter(0),
      }),
      ecos: new EcosAdapter({
        apiKey: ECOS_KEY,
        transport: ecosTransport as never,
        limiter: new RateLimiter(0),
      }),
    });
    const ok = await request(server).get(seriesUrl);
    expect(ok.status).toBe(200);
    expect(ok.body.observations).toHaveLength(5);
    const denied = await request(server).get(
      '/api/macro/series?source=ecos&id=kr-usdkrw&from=2026-10-01&to=2026-10-15',
    );
    expect(denied.status).toBe(503);
    expect(denied.body.error.code).toBe('PROVIDER_ACCESS_DENIED');
    for (const text of [
      JSON.stringify(ok.body),
      JSON.stringify(denied.body),
      JSON.stringify(denied.headers),
    ]) {
      expect(text).not.toContain(FRED_KEY);
      expect(text).not.toContain(ECOS_KEY);
    }
    // the provider calls did carry the keys, and only the fixed hosts were used
    expect(urls.some((url) => url.includes(FRED_KEY))).toBe(true);
    expect(
      urls.every((url) => /^https:\/\/(api\.stlouisfed\.org|ecos\.bok\.or\.kr)\//.test(url)),
    ).toBe(true);
  });
});
