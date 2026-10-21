import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { FredAdapter, fredFromEnvironment, parseObservations } from '../src/server/macro/fred';
import { RateLimiter } from '../src/server/fundamentals/shared';
import { ProviderError } from '../src/server/toss';

const KEY = 'abcdefghijklmnopqrstuvwxyz012345';
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/macro/${name}`, import.meta.url), 'utf8'));
// 10:00 in Chicago, so FRED's own date (US Central) is also 2026-10-21.
const NOW = new Date('2026-10-21T15:00:00Z');

function reply(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
function adapter(transport: ReturnType<typeof vi.fn>) {
  return new FredAdapter({
    apiKey: KEY,
    transport: transport as unknown as typeof fetch,
    now: () => NOW,
    limiter: new RateLimiter(0),
  });
}
const calledUrl = (transport: ReturnType<typeof vi.fn>, index = 0) =>
  new URL(String(calls(transport)[index][0]));
const calls = (transport: unknown) =>
  (transport as { mock: { calls: [string, RequestInit | undefined][] } }).mock.calls;
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected failure');
};

describe('FRED 관측값', () => {
  it('고정 호스트·JSON·실시간 기본값으로 요청하고 "."을 null로 정규화한다', async () => {
    const transport = vi.fn(async () => reply(fixture('fred-observations-cpi.json')));
    const rows = await adapter(transport).observations('us-cpi');
    expect(rows).toEqual([
      { date: '2026-05-01', value: '300.100' },
      { date: '2026-06-01', value: '301.250' },
      { date: '2026-07-01', value: null },
      { date: '2026-08-01', value: '302.900' },
      { date: '2026-09-01', value: '303.500' },
    ]);
    const url = calledUrl(transport);
    expect(url.origin + url.pathname).toBe('https://api.stlouisfed.org/fred/series/observations');
    expect(url.searchParams.get('series_id')).toBe('CPIAUCSL');
    expect(url.searchParams.get('file_type')).toBe('json');
    expect(url.searchParams.get('api_key')).toBe(KEY);
    expect(url.searchParams.get('realtime_start')).toBe('2026-10-21');
    expect(url.searchParams.get('realtime_end')).toBe('2026-10-21');
    expect(url.searchParams.get('limit')).toBe('100000');
    const init = calls(transport)[0][1]!;
    expect(init.redirect).toBe('error');
    expect(init.method).toBe('GET');
  });

  it('기간을 observation_start/end로 넘기고 형식이 틀린 날짜는 거부한다', async () => {
    const transport = vi.fn(async () => reply(fixture('fred-observations-cpi.json')));
    await adapter(transport).observations('us-gdp', { from: '2026-01-01', to: '2026-09-30' });
    const url = calledUrl(transport);
    expect(url.searchParams.get('series_id')).toBe('GDPC1');
    expect(url.searchParams.get('observation_start')).toBe('2026-01-01');
    expect(url.searchParams.get('observation_end')).toBe('2026-09-30');
    await expect(adapter(transport).observations('us-cpi', { from: '2026-13-01' })).rejects.toThrow(
      RangeError,
    );
    await expect(adapter(transport).observations('us-cpi', { to: '20261001' })).rejects.toThrow(
      RangeError,
    );
  });

  it('카탈로그 id만 받는다: 임의 시리즈 ID·ECOS id·형식이 다른 값은 요청 전에 거부한다', async () => {
    const transport = vi.fn(async () => reply(fixture('fred-observations-cpi.json')));
    for (const id of ['CPIAUCSL', 'kr-usdkrw', 'us-cpi&series_id=X', '', 'us-unknown'])
      await expect(adapter(transport).observations(id)).rejects.toThrow(RangeError);
    expect(transport).not.toHaveBeenCalled();
  });

  it('형식이 다른 응답은 PROVIDER_SCHEMA_INVALID로 실패한다', async () => {
    const row = (patch: Record<string, unknown>) => ({
      realtime_start: '2026-10-21',
      realtime_end: '2026-10-21',
      date: '2026-09-01',
      value: '1.5',
      ...patch,
    });
    const bad = [
      {},
      { observations: 'x' },
      { observations: [row({ date: '2026-02-31' })] },
      { observations: [row({ date: 20260901 })] },
      { observations: [row({ value: 'abc' })] },
      { observations: [row({ value: 1.5 })] },
      { observations: [row({ value: '1e5' })] },
      { observations: [row({ realtime_end: undefined })] },
      { observations: [null] },
    ];
    for (const body of bad) {
      const transport = vi.fn(async () => reply(body));
      const error = await failure(adapter(transport).observations('us-cpi'));
      expect(error, JSON.stringify(body)).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe('PROVIDER_SCHEMA_INVALID');
    }
    expect(() => parseObservations({ observations: [row({ value: '-0.25' })] })).not.toThrow();
    const notJson = vi.fn(async () => reply('<html>'));
    expect(((await failure(adapter(notJson).observations('us-cpi'))) as ProviderError).code).toBe(
      'PROVIDER_SCHEMA_INVALID',
    );
  });

  it('같은 조회는 캐시하고 동시 요청은 한 번만 보낸다', async () => {
    const transport = vi.fn(async () => reply(fixture('fred-observations-cpi.json')));
    const fred = adapter(transport);
    await Promise.all([fred.observations('us-cpi'), fred.observations('us-cpi')]);
    await fred.observations('us-cpi');
    expect(transport).toHaveBeenCalledTimes(1);
    await fred.observations('us-core-cpi');
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

describe('FRED 시점 기준 값(vintage)', () => {
  it('realtime_start=realtime_end=기준일로 조회하고 이후에 알려진 값은 버린다', async () => {
    const transport = vi.fn(async () => reply(fixture('fred-observations-vintage.json')));
    const rows = await adapter(transport).observationsKnownAt('us-cpi', '2026-09-15');
    const url = calledUrl(transport);
    expect(url.searchParams.get('realtime_start')).toBe('2026-09-15');
    expect(url.searchParams.get('realtime_end')).toBe('2026-09-15');
    expect(url.searchParams.get('observation_end')).toBe('2026-09-15');
    // fixture holds a revised 08-01 value that only became known on 2026-09-16 and an observation
    // dated after the as-of day; both must be filtered even if the API returned them.
    expect(rows.map((row) => [row.date, row.value])).toEqual([
      ['2026-06-01', '301.000'],
      ['2026-07-01', '302.000'],
      ['2026-08-01', '302.800'],
    ]);
    expect(rows.every((row) => row.realtimeStart <= '2026-09-15')).toBe(true);
    expect(rows.every((row) => row.realtimeEnd >= '2026-09-15')).toBe(true);
  });

  it('기준일이 다르면 캐시를 공유하지 않고 같은 id로 다른 vintage를 요청한다', async () => {
    const transport = vi.fn(async () => reply(fixture('fred-observations-vintage.json')));
    const fred = adapter(transport);
    await fred.observationsKnownAt('us-cpi', '2026-09-15');
    await fred.observationsKnownAt('us-cpi', '2026-09-20');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(calledUrl(transport, 1).searchParams.get('realtime_start')).toBe('2026-09-20');
    // the later vintage legitimately contains the revision (period 09-16..09-30 includes 09-20)
  });

  it('잘못된 기준일은 거부한다', async () => {
    const transport = vi.fn(async () => reply(fixture('fred-observations-vintage.json')));
    await expect(adapter(transport).observationsKnownAt('us-cpi', '2026-9-15')).rejects.toThrow(
      RangeError,
    );
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('FRED 최신값', () => {
  it('결측을 건너뛰고 최신값과 이전값을 돌려준다', async () => {
    const rows = fixture('fred-observations-cpi.json').observations.slice().reverse();
    const transport = vi.fn(async () => reply({ observations: rows }));
    const [cpi] = await adapter(transport).latestObservations(['us-cpi'], '2026-10-21');
    expect(cpi).toEqual({
      id: 'us-cpi',
      asOf: '2026-10-21',
      latest: { date: '2026-09-01', value: '303.500' },
      previous: { date: '2026-08-01', value: '302.900' },
    });
    const url = calledUrl(transport);
    expect(url.searchParams.get('sort_order')).toBe('desc');
    expect(url.searchParams.get('realtime_end')).toBe('2026-10-21');
    expect(url.searchParams.get('observation_end')).toBe('2026-10-21');
  });

  it('값이 하나뿐이거나 전부 결측이면 null로 둔다', async () => {
    const one = vi.fn(async () =>
      reply({
        observations: [
          {
            realtime_start: '2026-10-21',
            realtime_end: '2026-10-21',
            date: '2026-09-01',
            value: '4.2',
          },
          {
            realtime_start: '2026-10-21',
            realtime_end: '2026-10-21',
            date: '2026-08-01',
            value: '.',
          },
        ],
      }),
    );
    const [rate] = await adapter(one).latestObservations(['us-unemployment'], '2026-10-21');
    expect(rate.latest).toEqual({ date: '2026-09-01', value: '4.2' });
    expect(rate.previous).toBeNull();
    const none = vi.fn(async () => reply({ observations: [] }));
    const [empty] = await adapter(none).latestObservations(['us-gdp'], '2026-10-21');
    expect(empty.latest).toBeNull();
  });

  it('과거 기준일의 최신값도 그 시점에 알려진 값만 쓴다', async () => {
    const transport = vi.fn(async () => reply(fixture('fred-observations-vintage.json')));
    const [cpi] = await adapter(transport).latestObservations(['us-cpi'], '2026-09-15');
    // observation 2026-10-01 is after the as-of date and the 09-16 revision is not yet known
    expect(cpi.latest?.date).toBe('2026-08-01');
    expect(cpi.latest?.value).toBe('302.800');
  });

  it('입력을 검증한다', async () => {
    const transport = vi.fn(async () => reply({ observations: [] }));
    const fred = adapter(transport);
    await expect(fred.latestObservations([], '2026-10-21')).rejects.toThrow(RangeError);
    await expect(fred.latestObservations(['kr-cpi'], '2026-10-21')).rejects.toThrow(RangeError);
    await expect(fred.latestObservations(['us-cpi'], 'today')).rejects.toThrow(RangeError);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('FRED 발표 일정', () => {
  const dates = (releaseId: number, list: string[]) => ({
    release_dates: list.map((date) => ({ release_id: releaseId, date })),
  });
  it('카탈로그 발표마다 한 번 조회하고 구간 안 날짜만 정렬해 돌려준다', async () => {
    const transport = vi.fn(async (input: string) => {
      const id = Number(new URL(input).searchParams.get('release_id'));
      if (id === 10) return reply(fixture('fred-release-dates.json'));
      if (id === 50) return reply(dates(50, ['2026-11-06', '2026-12-04']));
      return reply(dates(id, []));
    });
    const releases = await adapter(transport).upcomingReleases('2026-10-22', '2026-12-05');
    expect(releases).toEqual([
      {
        releaseId: 50,
        date: '2026-11-06',
        indicatorIds: ['us-unemployment', 'us-nonfarm-payrolls'],
      },
      { releaseId: 10, date: '2026-11-13', indicatorIds: ['us-cpi', 'us-core-cpi'] },
      {
        releaseId: 50,
        date: '2026-12-04',
        indicatorIds: ['us-unemployment', 'us-nonfarm-payrolls'],
      },
    ]);
    expect(transport).toHaveBeenCalledTimes(5);
    const url = calledUrl(transport);
    expect(url.pathname).toBe('/fred/release/dates');
    expect(url.searchParams.get('include_release_dates_with_no_data')).toBe('true');
    expect(url.searchParams.get('realtime_start')).toBe('2026-10-22');
    expect(url.searchParams.get('realtime_end')).toBe('2026-12-05');
    const ids = calls(transport).map((call) =>
      new URL(String(call[0])).searchParams.get('release_id'),
    );
    expect([...ids].sort()).toEqual(['10', '101', '50', '53', '54']);
  });

  it('120일 초과·역순·형식 오류 구간은 거부한다', async () => {
    const transport = vi.fn(async () => reply(dates(10, [])));
    const fred = adapter(transport);
    await expect(fred.upcomingReleases('2026-10-01', '2027-02-01')).rejects.toThrow(RangeError);
    await expect(fred.upcomingReleases('2026-11-01', '2026-10-01')).rejects.toThrow(RangeError);
    await expect(fred.upcomingReleases('2026-10-01', '2026/11/01')).rejects.toThrow(RangeError);
    expect(transport).not.toHaveBeenCalled();
    // exactly 120 days is allowed
    await expect(fred.upcomingReleases('2026-10-01', '2026-10-31')).resolves.toBeDefined();
    await expect(fred.upcomingReleases('2026-10-01', '2027-01-29')).resolves.toBeDefined();
  });

  it('요청한 발표와 다른 release_id가 오면 스키마 오류다', async () => {
    const transport = vi.fn(async () => reply(dates(999, ['2026-11-01'])));
    const error = await failure(adapter(transport).upcomingReleases('2026-10-22', '2026-11-30'));
    expect((error as ProviderError).code).toBe('PROVIDER_SCHEMA_INVALID');
  });

  it('verifyCatalog는 카탈로그와 다른 발표 ID를 보고한다', async () => {
    const transport = vi.fn(async () => reply(fixture('fred-series-release.json')));
    const mismatches = await adapter(transport).verifyCatalog([
      { id: 'us-cpi', seriesId: 'CPIAUCSL', releaseId: 10 },
      { id: 'us-unemployment', seriesId: 'UNRATE', releaseId: 50 },
    ] as never);
    expect(mismatches).toEqual([
      { indicatorId: 'us-unemployment', expectedReleaseId: 50, actualReleaseIds: [10] },
    ]);
  });
});

describe('FRED 오류와 키 보호', () => {
  it('상태 코드를 앱 오류로 바꾸고 제공자 메시지는 전달하지 않는다', async () => {
    const cases: [number, unknown, string, number][] = [
      [
        400,
        {
          error_code: 400,
          error_message: 'Bad Request. The value for variable api_key is not registered.',
        },
        'PROVIDER_ACCESS_DENIED',
        503,
      ],
      [
        400,
        { error_code: 400, error_message: 'Bad Request. Variable limit is invalid.' },
        'PROVIDER_REQUEST_REJECTED',
        502,
      ],
      [400, 'not json', 'PROVIDER_REQUEST_REJECTED', 502],
      [401, {}, 'PROVIDER_ACCESS_DENIED', 503],
      [404, {}, 'PROVIDER_UNAVAILABLE', 503],
      [423, {}, 'PROVIDER_UNAVAILABLE', 503],
      [429, {}, 'PROVIDER_RATE_LIMITED', 503],
      [500, {}, 'PROVIDER_UNAVAILABLE', 503],
    ];
    for (const [status, body, code, mapped] of cases) {
      const transport = vi.fn(async () => reply(body, status));
      const error = (await failure(adapter(transport).observations('us-cpi'))) as ProviderError;
      expect(error, String(status)).toBeInstanceOf(ProviderError);
      expect(error.code).toBe(code);
      expect(error.status).toBe(mapped);
      const dump = JSON.stringify({ message: error.message, code: error.code });
      expect(dump).not.toContain(KEY);
      expect(dump).not.toContain('api_key');
      expect(dump).not.toContain('Bad Request');
    }
  });

  it('전송 오류의 원문(키가 든 URL)은 어디에도 남기지 않는다', async () => {
    const transport = vi.fn(async (input: string) => {
      throw new TypeError(`fetch failed for ${input}`);
    });
    const error = (await failure(adapter(transport).observations('us-cpi'))) as ProviderError;
    expect(error.code).toBe('PROVIDER_UNREACHABLE');
    expect(JSON.stringify(error)).not.toContain(KEY);
    expect(error.message).not.toContain(KEY);
    expect(String(error.stack)).not.toContain(KEY);
    expect(error.cause).toBeUndefined();
  });

  it('429 뒤에는 대기 시간 동안 제공자를 다시 부르지 않는다', async () => {
    const transport = vi.fn(async () => reply({}, 429, { 'retry-after': '30' }));
    const fred = adapter(transport);
    const first = (await failure(fred.observations('us-cpi'))) as ProviderError;
    expect(first.retryAfter).toBe(30);
    const second = (await failure(fred.observations('us-core-cpi'))) as ProviderError;
    expect(second.code).toBe('PROVIDER_RATE_LIMITED');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('응답 크기 한도를 넘기면 거부한다', async () => {
    const big = vi.fn(async () => reply('x', 200, { 'content-length': String(50 * 1024 * 1024) }));
    expect(((await failure(adapter(big).observations('us-cpi'))) as ProviderError).code).toBe(
      'PROVIDER_RESPONSE_TOO_LARGE',
    );
  });

  it('키 형식은 문서(소문자 영숫자 32자)를 따르고 환경 변수에서 만든다', () => {
    expect(() => new FredAdapter({ apiKey: 'short' })).toThrow('Invalid FRED configuration');
    expect(() => new FredAdapter({ apiKey: KEY.toUpperCase() })).toThrow();
    expect(fredFromEnvironment({})).toBeUndefined();
    expect(fredFromEnvironment({ FRED_API_KEY: 'bad key' })).toBeUndefined();
    expect(fredFromEnvironment({ FRED_API_KEY: KEY })).toBeInstanceOf(FredAdapter);
  });
});

describe('FRED real-time date follows FRED today (US Central)', () => {
  it('clamps a Korean "today" that is already ahead of FRED and keeps the rows', async () => {
    // 2026-10-21 04:30Z is 10-21 in Korea and UTC but still 10-20 23:30 in Chicago.
    const now = new Date('2026-10-21T04:30:00Z');
    const urls: string[] = [];
    const transport = vi.fn(async (url: string) => {
      urls.push(String(url));
      return reply({
        observations: [
          {
            realtime_start: '2026-10-20',
            realtime_end: '2026-10-20',
            date: '2026-09-01',
            value: '336.298',
          },
          {
            realtime_start: '2026-10-20',
            realtime_end: '2026-10-20',
            date: '2026-08-01',
            value: '335.000',
          },
        ],
      });
    });
    const fred = new FredAdapter({
      apiKey: KEY,
      transport: transport as unknown as typeof fetch,
      now: () => now,
      limiter: new RateLimiter(0),
    });
    const [cpi] = await fred.latestObservations(['us-cpi'], '2026-10-21');
    const query = new URL(urls[0]).searchParams;
    expect(query.get('realtime_start')).toBe('2026-10-20');
    expect(query.get('realtime_end')).toBe('2026-10-20');
    expect(cpi.latest).toEqual({ date: '2026-09-01', value: '336.298' });
    expect(cpi.previous).toEqual({ date: '2026-08-01', value: '335.000' });
    const vintage = await fred.observationsKnownAt('us-cpi', '2026-10-21');
    expect(new URL(urls[1]).searchParams.get('realtime_start')).toBe('2026-10-20');
    expect(vintage.map((row) => row.date)).toEqual(['2026-09-01', '2026-08-01']);
  });
});
