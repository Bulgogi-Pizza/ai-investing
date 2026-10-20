import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app';
import { MemoryCalendarRepository, type EconomicEvent } from '../src/server/calendar';
import {
  cleanFills,
  NoAlgorithmFills,
  type AlgorithmFill,
  type AlgorithmFillSource,
} from '../src/server/algorithm-fills';
import {
  calendarToEvents,
  createAnalysisEventsRouter,
  kstToUsDate,
  MAX_EVENTS,
} from '../src/server/analysis-events';
import { hashPassword } from '../src/server/auth';
import { DartAdapter } from '../src/server/fundamentals/dart';
import {
  classifyDart,
  classifySec,
  parseDartList,
  parseSecSubmissions,
  secRecentCoverage,
} from '../src/server/fundamentals/filings';
import { SecAdapter } from '../src/server/fundamentals/sec';
import { RateLimiter } from '../src/server/fundamentals/shared';
import { MemoryStore } from '../src/server/store';
import { MemoryTokenCache, ProviderError, TossClient } from '../src/server/toss';
import { buildZip } from './fixtures/fundamentals/build-zip';

// Everything here is synthetic. No network is used.
const OWNER = 'owner-1';
const origin = 'http://localhost:5173';
const query = (extra = '') =>
  `/api/analysis/events?market=KR&symbol=005930&from=2026-09-01&to=2026-10-20${extra}`;

function calEvent(
  id: number,
  date: string,
  time: string,
  title: string,
  country: EconomicEvent['country'],
  importance: 1 | 2 | 3,
  extra: Partial<EconomicEvent> = {},
): EconomicEvent {
  return {
    id,
    date,
    time,
    title,
    country,
    category: '경제 지표',
    assets: ['금리'],
    importance,
    description: '합성 일정',
    sourceUrl: 'https://example.test/release',
    sourceName: '테스트 출처',
    impactDirection: 'mixed',
    impactHorizon: '1주',
    confidence: 'low',
    factualObservedAt: '2026-10-20T00:00:00Z',
    ...extra,
  };
}
async function repositoryWith(...events: EconomicEvent[]) {
  const repository = new MemoryCalendarRepository();
  await repository.upsert(events, 'test');
  return repository;
}
const filing = (key: string, date: string, extra = {}) => ({
  date,
  title: `보고서 ${key}`,
  titleLanguage: 'ko' as const,
  kind: 'disclosure' as const,
  importance: 2 as const,
  key,
  url: `https://dart.example.test/${key}`,
  ...extra,
});
type User = { id: string; role?: string; active?: boolean } | null;
const owner = { id: OWNER, role: 'member', active: true };
const now = () => new Date('2026-10-21T03:00:00Z');

function app(user: User, options: Partial<Parameters<typeof createAnalysisEventsRouter>[0]> = {}) {
  const server = express();
  server.use((_req, res, next) => {
    if (user) res.locals.user = user;
    next();
  });
  server.use(
    createAnalysisEventsRouter({
      calendar: options.calendar ?? new MemoryCalendarRepository(),
      ownerUserId: OWNER,
      now,
      ...options,
    }),
  );
  return server;
}

describe('이벤트 API 권한과 입력 검증', () => {
  it('비로그인 401, 소유자 아님 403, 소유자 미설정 503이며 소스를 호출하지 않는다', async () => {
    const fred = { upcomingReleases: vi.fn(async () => []) };
    const dart = { disclosures: vi.fn() };
    const calendar = { list: vi.fn(async () => []), upsert: vi.fn() };
    const url = query();
    const fills = '/api/analysis/algorithm-fills?symbol=005930&from=2026-09-01&to=2026-10-20';
    for (const path of [url, fills]) {
      expect((await request(app(null, { fred, dart, calendar })).get(path)).status).toBe(401);
      expect(
        (await request(app({ ...owner, active: false }, { fred, dart, calendar })).get(path))
          .status,
      ).toBe(401);
      const other = await request(
        app({ id: 'someone', role: 'admin', active: true }, { fred, dart, calendar }),
      ).get(path);
      expect(other.status).toBe(403);
      expect(other.body.error.code).toBe('OWNER_REQUIRED');
      expect(
        (await request(app(owner, { fred, dart, calendar, ownerUserId: '' })).get(path)).status,
      ).toBe(503);
    }
    expect(fred.upcomingReleases).not.toHaveBeenCalled();
    expect(dart.disclosures).not.toHaveBeenCalled();
    expect(calendar.list).not.toHaveBeenCalled();
  });

  it('인증은 입력 검증보다 먼저다', async () => {
    expect((await request(app(null)).get('/api/analysis/events?market=zz')).status).toBe(401);
  });

  it.each([
    ['market 누락', '/api/analysis/events?symbol=005930&from=2026-09-01&to=2026-09-02'],
    ['잘못된 market', query().replace('market=KR', 'market=JP')],
    ['KR 종목 코드 형식', query().replace('005930', '5930')],
    [
      'US 종목 코드 형식',
      '/api/analysis/events?market=US&symbol=BAD%20X&from=2026-09-01&to=2026-09-02',
    ],
    ['존재하지 않는 날짜', query().replace('2026-09-01', '2026-02-30')],
    ['from > to', query().replace('to=2026-10-20', 'to=2026-08-01')],
    ['추가 파라미터', query('&extra=1')],
    ['반복 파라미터', query('&market=US')],
    ['객체형 파라미터', query().replace('market=KR', 'market[a]=KR')],
    ['401일 창', query().replace('2026-09-01', '2025-09-14')],
  ])('입력 오류는 400이고 소스를 부르지 않는다: %s', async (_name, url) => {
    const dart = { disclosures: vi.fn() };
    const response = await request(app(owner, { dart })).get(url);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_EVENTS_QUERY');
    expect(dart.disclosures).not.toHaveBeenCalled();
  });

  it('정확히 400일 창은 허용한다', async () => {
    // 2025-09-15 .. 2026-10-20 is exactly 400 days apart.
    const response = await request(app(owner)).get(query().replace('2026-09-01', '2025-09-15'));
    expect(response.status).toBe(200);
    expect(response.body.windowDays).toBe(401);
  });
});

describe('이벤트 병합', () => {
  it('등록 일정·FRED·DART를 날짜순, 같은 날 중요도순으로 합치고 출처 상태를 낸다', async () => {
    const calendar = await repositoryWith(
      calEvent(1, '2026-09-17', '03:00', '테스트 FOMC 금리 결정', '미국', 3, {
        category: '금리 결정',
      }),
      calEvent(2, '2026-10-15', '10:00', '테스트 기준금리 결정', '한국', 3, {
        category: '통화정책',
      }),
      calEvent(3, '2026-10-15', '09:00', '테스트 생산자물가', '한국', 2),
      calEvent(4, '2026-10-06', '10:00', '공식 보도자료', '한국', 3, { eventKind: 'news-release' }),
      calEvent(5, '2026-10-01', '09:00', '범위 밖 일정', '한국', 3, { date: '2026-08-01' }),
    );
    const fred = {
      upcomingReleases: vi.fn(async () => [
        { releaseId: 10, date: '2026-10-13', indicatorIds: ['us-cpi', 'us-core-cpi'] },
        { releaseId: 101, date: '2026-09-16', indicatorIds: ['us-fed-funds-upper'] },
        { releaseId: 999, date: '2026-10-14', indicatorIds: [] },
      ]),
    };
    const dart = {
      disclosures: vi.fn(async () => ({
        filings: [
          filing('20261015000001', '2026-10-15', { importance: 3, kind: 'earnings' }),
          filing('20260901000001', '2026-09-01'),
        ],
        truncated: false,
        asOf: '2026-10-21T03:00:00.000Z',
      })),
    };
    const response = await request(app(owner, { calendar, fred, dart })).get(query());
    expect(response.status).toBe(200);
    const events = response.body.events as { id: string; date: string; importance: number }[];
    expect(events.map((e) => e.id)).toEqual([
      'dart-20260901000001', // 2026-09-01
      'calendar-1', // registered FOMC (2026-09-17 03:00 KST = 2026-09-16 in New York) replaces FRED rid 101
      'fred-10-2026-10-13',
      'dart-20261015000001', // 2026-10-15, importance 3
      'calendar-2', // 2026-10-15, importance 3
      'calendar-3', // 2026-10-15, importance 2
    ]);
    const bySource = Object.fromEntries(
      (response.body.sources as { id: string; status: string; count: number }[]).map((s) => [
        s.id,
        s,
      ]),
    );
    expect(Object.keys(bySource)).toEqual(['calendar', 'fred', 'dart', 'sec']);
    expect(bySource.sec).toMatchObject({ status: 'not-applicable', count: 0 });
    expect(bySource.dart).toMatchObject({ status: 'ok', count: 2 });
    expect(response.body).toMatchObject({
      market: 'KR',
      symbol: '005930',
      truncated: false,
      limit: MAX_EVENTS,
    });
    // Every item carries an https source and the fields the chart needs.
    for (const event of response.body.events)
      expect(event).toMatchObject({
        title: expect.any(String),
        kind: expect.stringMatching(/^(rate-decision|earnings|economic-indicator|disclosure)$/),
        market: expect.stringMatching(/^(US|KR)$/),
        source: expect.any(String),
        url: expect.stringMatching(/^https:\/\//),
      });
  });

  it('등록 일정이 같은 시장·날짜·종류의 FRED 발표보다 우선한다', async () => {
    const calendar = await repositoryWith(
      calEvent(1, '2026-09-17', '03:00', '테스트 FOMC 금리 결정', '미국', 3, {
        category: '금리 결정',
      }),
    );
    const fred = {
      upcomingReleases: vi.fn(async () => [
        { releaseId: 101, date: '2026-09-16', indicatorIds: ['us-fed-funds-upper'] },
      ]),
    };
    const response = await request(app(owner, { calendar, fred })).get(query());
    expect(response.body.events.map((e: { id: string }) => e.id)).toEqual(['calendar-1']);
    expect(response.body.events[0]).toMatchObject({
      kind: 'rate-decision',
      market: 'US',
      date: '2026-09-16',
    });
    expect(response.body.sources.find((s: { id: string }) => s.id === 'fred')).toMatchObject({
      status: 'ok',
      count: 0,
    });
  });

  it('FRED 이벤트는 카탈로그의 한국어 제목·중요도·종류를 쓴다', async () => {
    const fred = {
      upcomingReleases: vi.fn(async () => [
        { releaseId: 50, date: '2026-10-02', indicatorIds: ['us-unemployment'] },
        { releaseId: 101, date: '2026-09-16', indicatorIds: ['us-fed-funds-upper'] },
      ]),
    };
    const response = await request(app(owner, { fred })).get(query());
    const [fomc, jobs] = response.body.events;
    expect(fomc).toMatchObject({
      kind: 'rate-decision',
      importance: 3,
      titleLanguage: 'ko',
      origin: 'fred',
      source: 'FRED',
      market: 'US',
    });
    expect(jobs).toMatchObject({ kind: 'economic-indicator', importance: 3, date: '2026-10-02' });
    expect(jobs.url).toBe('https://fred.stlouisfed.org/release?rid=50');
  });

  it('FRED는 120일 이하 창으로 나누어 읽는다', async () => {
    const fred = { upcomingReleases: vi.fn(async () => []) };
    await request(app(owner, { fred })).get(query().replace('2026-09-01', '2025-09-16'));
    const calls = fred.upcomingReleases.mock.calls as unknown as [string, string][];
    expect(calls.length).toBe(4);
    expect(calls[0][0]).toBe('2025-09-16');
    expect(calls.at(-1)![1]).toBe('2026-10-20');
    for (const [from, to] of calls) {
      expect((Date.parse(to) - Date.parse(from)) / 86400000).toBeLessThanOrEqual(120);
    }
    for (let i = 1; i < calls.length; i++) {
      expect((Date.parse(calls[i][0]) - Date.parse(calls[i - 1][1])) / 86400000).toBe(1);
    }
  });

  it('미국 종목은 SEC만 부르고 DART는 해당 없음이다', async () => {
    const dart = { disclosures: vi.fn() };
    const sec = {
      filings: vi.fn(async () => ({
        filings: [filing('0000000001-26-000001', '2026-10-15', { kind: 'earnings' })],
        oldestCovered: '2025-10-01',
        incomplete: false,
        asOf: '2026-10-21T03:00:00.000Z',
      })),
    };
    const response = await request(app(owner, { dart, sec })).get(
      '/api/analysis/events?market=US&symbol=aapl&from=2026-09-01&to=2026-10-20',
    );
    expect(sec.filings).toHaveBeenCalledWith('AAPL', '2026-09-01', '2026-10-20');
    expect(dart.disclosures).not.toHaveBeenCalled();
    const status = Object.fromEntries(response.body.sources.map((s: { id: string }) => [s.id, s]));
    expect(status.dart.status).toBe('not-applicable');
    expect(status.sec).toMatchObject({ status: 'ok', count: 1 });
    expect(response.body.events[0]).toMatchObject({ market: 'US', origin: 'sec' });
  });

  it('최대 300건으로 자르고 truncated를 알린다', async () => {
    const dart = {
      disclosures: vi.fn(async () => ({
        filings: Array.from({ length: 350 }, (_, i) =>
          filing(String(i).padStart(14, '0'), `2026-09-${String((i % 28) + 1).padStart(2, '0')}`),
        ),
        truncated: true,
        asOf: '2026-10-21T03:00:00.000Z',
      })),
    };
    const response = await request(app(owner, { dart })).get(query());
    expect(response.body.events).toHaveLength(MAX_EVENTS);
    expect(response.body.truncated).toBe(true);
    const dates = response.body.events.map((e: { date: string }) => e.date);
    expect([...dates].sort()).toEqual(dates);
    expect(response.body.sources.find((s: { id: string }) => s.id === 'dart')).toMatchObject({
      code: 'INCOMPLETE',
    });
  });
});

describe('소스별 독립 상태', () => {
  it('제공자 미설정이면 그 소스만 unavailable이고 나머지는 그대로 온다', async () => {
    const calendar = await repositoryWith(
      calEvent(3, '2026-10-15', '09:00', '테스트 일정', '한국', 2),
    );
    const response = await request(app(owner, { calendar })).get(query());
    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(1);
    const status = Object.fromEntries(response.body.sources.map((s: { id: string }) => [s.id, s]));
    expect(status.calendar.status).toBe('ok');
    expect(status.fred).toMatchObject({ status: 'unavailable', code: 'FRED_UNAVAILABLE' });
    expect(status.dart).toMatchObject({ status: 'unavailable', code: 'DART_UNAVAILABLE' });
  });

  it('한 소스가 실패해도 응답은 200이고 실패는 캐시하지 않는다', async () => {
    const calendar = await repositoryWith(
      calEvent(3, '2026-10-15', '09:00', '테스트 일정', '한국', 2),
    );
    const dart = {
      disclosures: vi
        .fn()
        .mockRejectedValueOnce(new ProviderError(503, 'PROVIDER_RATE_LIMITED', '한도', 30))
        .mockResolvedValue({
          filings: [filing('20261015000001', '2026-10-15')],
          truncated: false,
          asOf: '2026-10-21T03:00:00.000Z',
        }),
    };
    const server = app(owner, { calendar, dart });
    const first = await request(server).get(query());
    expect(first.status).toBe(200);
    expect(first.body.events.map((e: { id: string }) => e.id)).toEqual(['calendar-3']);
    expect(first.body.sources.find((s: { id: string }) => s.id === 'dart')).toMatchObject({
      status: 'error',
      code: 'PROVIDER_RATE_LIMITED',
      retryAfter: 30,
    });
    const second = await request(server).get(query());
    expect(second.body.events).toHaveLength(2);
    expect(dart.disclosures).toHaveBeenCalledTimes(2);
    // A complete answer is reused.
    await request(server).get(query());
    expect(dart.disclosures).toHaveBeenCalledTimes(2);
  });

  it('등록되지 않은 종목은 no-data, 알 수 없는 오류는 일반 문구로 error다', async () => {
    const dart = {
      disclosures: vi
        .fn()
        .mockRejectedValue(
          new ProviderError(
            404,
            'FUNDAMENTALS_NOT_FOUND',
            '이 종목의 재무 데이터를 찾지 못했습니다.',
          ),
        ),
    };
    const fred = { upcomingReleases: vi.fn().mockRejectedValue(new Error('secret api_key=abc')) };
    const response = await request(app(owner, { dart, fred })).get(query());
    const status = Object.fromEntries(response.body.sources.map((s: { id: string }) => [s.id, s]));
    expect(status.dart.status).toBe('no-data');
    expect(status.fred).toMatchObject({ status: 'error', code: 'EVENTS_SOURCE_FAILED' });
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('등록 일정 저장소가 실패해도 다른 소스는 온다', async () => {
    const calendar = {
      list: vi.fn().mockRejectedValue(new Error('db down')),
      upsert: vi.fn(),
    };
    const dart = {
      disclosures: vi.fn(async () => ({
        filings: [filing('20261015000001', '2026-10-15')],
        truncated: false,
        asOf: '2026-10-21T03:00:00.000Z',
      })),
    };
    const response = await request(app(owner, { calendar, dart })).get(query());
    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(1);
    expect(response.body.sources[0]).toMatchObject({ id: 'calendar', status: 'error' });
  });
});

describe('등록 일정 변환 규칙', () => {
  it('KST 시각을 미국 동부 날짜로 바꾼다(서머타임 포함)', () => {
    expect(kstToUsDate('2026-09-17', '03:00')).toBe('2026-09-16'); // EDT, UTC-4
    expect(kstToUsDate('2026-12-10', '04:00')).toBe('2026-12-09'); // EST, UTC-5
    expect(kstToUsDate('2026-10-13', '21:30')).toBe('2026-10-13'); // 08:30 in New York
    expect(kstToUsDate('2026-10-13', '25:00')).toBeNull();
  });
  it('종류·시장·날짜 규칙', () => {
    const events = calendarToEvents(
      [
        calEvent(1, '2026-10-15', '10:00', '테스트 기준금리 결정', '한국', 3),
        calEvent(2, '2026-10-13', '21:30', 'Test Retail Sales', '미국', 2),
        calEvent(3, '2026-10-14', '09:00', '테스트 기업 실적', '글로벌', 1, { category: '실적' }),
        calEvent(4, '2026-10-14', '09:00', '보도자료', '미국', 3, { eventKind: 'news-release' }),
      ],
      'US',
      '2026-10-01',
      '2026-10-20',
    );
    expect(events.map((e) => [e.id, e.kind, e.market, e.date, e.titleLanguage])).toEqual([
      ['calendar-1', 'rate-decision', 'KR', '2026-10-15', 'ko'],
      ['calendar-2', 'economic-indicator', 'US', '2026-10-13', 'original'],
      ['calendar-3', 'earnings', 'US', '2026-10-13', 'ko'], // 글로벌: the symbol's market, US date
    ]);
  });
});

describe('공시 분류 규칙', () => {
  it('DART: 정기공시·주요사항·잠정실적만, 나머지 거래소공시는 버린다', () => {
    expect(classifyDart('A', '사업보고서 (2025.12)')).toEqual({ kind: 'earnings', importance: 3 });
    expect(classifyDart('A', '분기보고서 (2026.06)')).toEqual({ kind: 'earnings', importance: 2 });
    expect(classifyDart('A', '반기보고서 (2026.06)')).toEqual({ kind: 'earnings', importance: 2 });
    expect(classifyDart('A', '감사보고서')).toEqual({ kind: 'disclosure', importance: 1 });
    expect(classifyDart('B', '주요사항보고서(유상증자결정)')).toEqual({
      kind: 'disclosure',
      importance: 2,
    });
    expect(classifyDart('I', '연결재무제표기준영업(잠정)실적(공정공시)')).toEqual({
      kind: 'earnings',
      importance: 3,
    });
    expect(classifyDart('I', '주식매수선택권부여에관한신고')).toBeNull();
  });
  it('DART list.json 행을 날짜·제목·뷰어 링크로 바꾼다', () => {
    const rows = [
      { rcept_no: '20261015000123', rcept_dt: '20261015', report_nm: '분기보고서 (2026.09)' },
      { rcept_no: '20261016000124', rcept_dt: '20261016', report_nm: '기타 거래소공시' },
    ];
    expect(parseDartList(rows, 'A')[0]).toMatchObject({
      date: '2026-10-15',
      title: '분기보고서 (2026.09)',
      key: '20261015000123',
      url: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261015000123',
    });
    expect(parseDartList(rows, 'I')).toHaveLength(0);
    expect(() => parseDartList([{ rcept_no: 'x', rcept_dt: '1', report_nm: 'a' }], 'A')).toThrow();
    expect(() => parseDartList('nope', 'A')).toThrow();
  });
  it('SEC: 10-K·10-Q·8-K(2.02는 실적)만 쓰고 정정본은 버린다', () => {
    expect(classifySec('10-K', '')).toMatchObject({ kind: 'earnings', importance: 3 });
    expect(classifySec('10-Q', '')).toMatchObject({ kind: 'earnings', importance: 2 });
    expect(classifySec('8-K', '2.02,9.01')).toMatchObject({ kind: 'earnings', importance: 3 });
    expect(classifySec('8-K', '5.02')).toMatchObject({ kind: 'disclosure', importance: 1 });
    expect(classifySec('8-K/A', '2.02')).toBeNull();
    expect(classifySec('4', '')).toBeNull();
  });
  const submissions = (extra: Record<string, unknown> = {}) => ({
    cik: '0001234567',
    filings: {
      recent: {
        accessionNumber: ['0001234567-26-000010', '0001234567-26-000009', '0001234567-26-000008'],
        filingDate: ['2026-10-15', '2026-10-01', '2026-08-01'],
        form: ['8-K', '4', '10-Q'],
        items: ['2.02,9.01', '', ''],
      },
      files: [{ name: 'CIK0001234567-submissions-001.json' }],
      ...extra,
    },
  });
  it('SEC submissions 평행 배열을 읽고 필드가 어긋나면 거부한다', () => {
    const list = parseSecSubmissions(submissions(), 1234567);
    expect(list.map((f) => [f.date, f.kind, f.importance])).toEqual([
      ['2026-10-15', 'earnings', 3],
      ['2026-08-01', 'earnings', 2],
    ]);
    expect(list[0].url).toBe(
      'https://www.sec.gov/Archives/edgar/data/1234567/000123456726000010/0001234567-26-000010-index.htm',
    );
    expect(secRecentCoverage(submissions())).toEqual({ oldest: '2026-08-01', hasOlder: true });
    const broken = submissions();
    (broken.filings.recent as Record<string, unknown>).form = ['8-K'];
    expect(() => parseSecSubmissions(broken, 1234567)).toThrow();
    expect(() => parseSecSubmissions(submissions(), 999)).toThrow();
  });
});

describe('DART·SEC 어댑터의 공시 조회', () => {
  const KEY = 'A1b2C3d4E5f6A1b2C3d4E5f6A1b2C3d4E5f6A1b2';
  const corpXml =
    '<result><list><corp_code>00000001</corp_code><corp_name>합성전자</corp_name><stock_code>000001</stock_code><modify_date>20260101</modify_date></list></result>';
  it('DART는 분류별로 list.json을 읽고 결과를 캐시한다', async () => {
    const seen: URLSearchParams[] = [];
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/corpCode.xml')
        return new Response(
          new Uint8Array(buildZip([{ name: 'CORPCODE.xml', data: Buffer.from(corpXml, 'utf8') }])),
        );
      seen.push(url.searchParams);
      const type = url.searchParams.get('pblntf_ty');
      const rows: Record<string, unknown[]> = {
        A: [
          { rcept_no: '20261015000001', rcept_dt: '20261015', report_nm: '분기보고서 (2026.09)' },
        ],
        B: [],
        I: [
          {
            rcept_no: '20261016000002',
            rcept_dt: '20261016',
            report_nm: '영업(잠정)실적(공정공시)',
          },
          { rcept_no: '20261017000003', rcept_dt: '20261017', report_nm: '풍문또는보도에대한해명' },
        ],
      };
      if (type === 'B') return new Response(JSON.stringify({ status: '013', message: 'raw' }));
      return new Response(
        JSON.stringify({ status: '000', total_page: 1, list: rows[type as string] }),
      );
    }) as unknown as typeof fetch;
    const dart = new DartAdapter({
      apiKey: KEY,
      transport,
      now: () => new Date('2026-10-21T00:00:00Z'),
      limiter: new RateLimiter(0),
    });
    const result = await dart.disclosures('000001', '2026-09-01', '2026-10-20');
    expect(result.filings.map((f) => [f.key, f.kind, f.importance])).toEqual([
      ['20261015000001', 'earnings', 2],
      ['20261016000002', 'earnings', 3],
    ]);
    expect(result.truncated).toBe(false);
    expect(seen.map((s) => s.get('pblntf_ty'))).toEqual(['A', 'B', 'I']);
    expect(seen[0].get('bgn_de')).toBe('20260901');
    expect(seen[0].get('end_de')).toBe('20261020');
    expect(seen[0].get('corp_code')).toBe('00000001');
    const calls = vi.mocked(transport).mock.calls.length;
    await dart.disclosures('000001', '2026-09-01', '2026-10-20');
    expect(vi.mocked(transport).mock.calls.length).toBe(calls);
    await expect(dart.disclosures('bad', '2026-09-01', '2026-10-20')).rejects.toThrow(RangeError);
    await expect(dart.disclosures('999999', '2026-09-01', '2026-10-20')).rejects.toMatchObject({
      code: 'FUNDAMENTALS_NOT_FOUND',
    });
  });

  it('DART는 분류별 쪽 상한에서 멈추고 truncated를 알린다', async () => {
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/corpCode.xml')
        return new Response(
          new Uint8Array(buildZip([{ name: 'CORPCODE.xml', data: Buffer.from(corpXml, 'utf8') }])),
        );
      return new Response(JSON.stringify({ status: '000', total_page: 50, list: [] }));
    }) as unknown as typeof fetch;
    const dart = new DartAdapter({ apiKey: KEY, transport, limiter: new RateLimiter(0) });
    const result = await dart.disclosures('000001', '2026-09-01', '2026-10-20');
    expect(result.truncated).toBe(true);
    // corp list + 3 categories x 3 pages
    expect(vi.mocked(transport).mock.calls.length).toBe(1 + 9);
  });

  it('SEC는 최근 목록을 창으로 거르고 목록이 짧으면 incomplete를 알린다', async () => {
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://www.sec.gov/files/company_tickers.json')
        return new Response(
          JSON.stringify({ 0: { cik_str: 1234567, ticker: 'SYNT', title: 'Synthetic Corp' } }),
        );
      if (url === 'https://data.sec.gov/submissions/CIK0001234567.json')
        return new Response(
          JSON.stringify({
            cik: '0001234567',
            filings: {
              recent: {
                accessionNumber: ['0001234567-26-000010', '0001234567-25-000001'],
                filingDate: ['2026-10-15', '2025-11-01'],
                form: ['10-Q', '10-K'],
              },
              files: [{ name: 'older.json' }],
            },
          }),
        );
      return new Response('unexpected', { status: 500 });
    }) as unknown as typeof fetch;
    const sec = new SecAdapter({
      userAgent: 'Synthetic Test Project test-contact@example.invalid',
      transport,
      now: () => new Date('2026-10-21T00:00:00Z'),
      limiter: new RateLimiter(0),
    });
    const result = await sec.filings('synt', '2025-01-01', '2026-10-20');
    expect(result.filings.map((f) => f.key)).toEqual([
      '0001234567-26-000010',
      '0001234567-25-000001',
    ]);
    expect(result.incomplete).toBe(true);
    expect(result.oldestCovered).toBe('2025-11-01');
    const wide = await sec.filings('SYNT', '2025-11-01', '2026-10-20');
    expect(wide.filings).toHaveLength(2);
    expect(wide.incomplete).toBe(false);
    await expect(sec.filings('NOPE', '2026-01-01', '2026-10-20')).rejects.toMatchObject({
      code: 'FUNDAMENTALS_NOT_FOUND',
    });
  });
});

describe('알고리즘 체결 API', () => {
  const url = '/api/analysis/algorithm-fills?symbol=005930&from=2026-09-01&to=2026-10-20';
  const fill = (extra: Record<string, unknown> = {}) => ({
    id: 'f1',
    algorithmId: 'a1',
    algorithmName: '테스트 알고리즘',
    symbol: '005930',
    side: 'buy',
    mode: 'paper',
    date: '2026-10-05',
    filledAt: '2026-10-05T00:31:00.000Z',
    price: '70000',
    quantity: '3',
    currency: 'KRW',
    ...extra,
  });
  it('저장소가 없으면 미연결이고 빈 목록이다', async () => {
    const response = await request(app(owner)).get(url);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ connected: false, fills: [], symbol: '005930' });
    expect(new NoAlgorithmFills().connected).toBe(false);
  });
  it('저장소가 주는 값을 다시 검증하고 정렬한다', async () => {
    const source: AlgorithmFillSource = {
      connected: true,
      listFills: async () =>
        [
          fill({ id: 'f2', filledAt: '2026-10-06T00:31:00.000Z', side: 'sell', mode: 'live' }),
          fill(),
          fill({ id: 'bad1', price: 'abc' }),
          fill({ id: 'bad2', side: 'hold' }),
          fill({ id: 'bad3', date: '2026-12-01' }),
          fill({ id: 'bad4', symbol: 'AAPL' }),
          { ...fill({ id: 'extra' }), accountNumber: '123' },
        ] as unknown as AlgorithmFill[],
    };
    const response = await request(app(owner, { fills: source })).get(url);
    expect(response.body.connected).toBe(true);
    expect(response.body.fills.map((f: { id: string }) => f.id)).toEqual(['extra', 'f1', 'f2']);
    expect(JSON.stringify(response.body)).not.toContain('accountNumber');
    expect(cleanFills('nope', '005930', '2026-09-01', '2026-10-20')).toEqual([]);
  });
  it('입력 검증과 저장소 오류', async () => {
    const server = app(owner, {
      fills: {
        connected: true,
        listFills: async () => {
          throw new Error('db down');
        },
      },
    });
    expect((await request(server).get(url)).status).toBe(500);
    for (const bad of [
      '/api/analysis/algorithm-fills?symbol=!!&from=2026-09-01&to=2026-10-20',
      '/api/analysis/algorithm-fills?symbol=005930&from=2026-09-01',
      `${url}&x=1`,
    ])
      expect((await request(server).get(bad)).body.error.code).toBe('INVALID_FILLS_QUERY');
  });
});

describe('앱 연결(createApp)', () => {
  const password = 'Test-only lengthy password';
  let store: MemoryStore;
  let ownerId: string;
  beforeEach(async () => {
    store = new MemoryStore();
    const passwordHash = await hashPassword(password);
    ownerId = (
      await store.createUser({
        email: 'owner@example.test',
        passwordHash,
        role: 'member',
        active: true,
        version: 1,
      })
    ).id;
    await store.createUser({
      email: 'member@example.test',
      passwordHash,
      role: 'member',
      active: true,
      version: 1,
    });
  });
  async function login(server: ReturnType<typeof createApp>, email: string) {
    const response = await request(server)
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ email, password });
    return response.headers['set-cookie'][0].split(';')[0] as string;
  }
  const toss = (handler: (path: string) => Response | undefined = () => undefined): TossClient =>
    new TossClient(
      { clientId: 'c', clientSecret: 's', accountSeq: '1', ownerUserId: ownerId },
      new MemoryTokenCache(),
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input).replace('https://openapi.tossinvest.com', '');
        const custom = handler(path);
        if (custom) return custom;
        if (path === '/oauth2/token')
          return Response.json({
            access_token: 'fixture',
            token_type: 'Bearer',
            expires_in: 86400,
          });
        return new Response('unexpected', { status: 500 });
      }) as unknown as typeof fetch,
    );

  it('토스 없이도 소유자는 이벤트를 읽고 다른 계정은 403이다', async () => {
    const calendarRepository = await repositoryWith(
      calEvent(3, '2026-10-15', '09:00', '테스트 일정', '한국', 2),
    );
    const server = createApp({ store, origin, ownerUserId: ownerId, calendarRepository });
    expect((await request(server).get(query())).status).toBe(401);
    const member = await login(server, 'member@example.test');
    expect((await request(server).get(query()).set('Cookie', member)).status).toBe(403);
    const cookie = await login(server, 'owner@example.test');
    const response = await request(server).get(query()).set('Cookie', cookie);
    expect(response.status).toBe(200);
    expect(response.body.events.map((e: { id: string }) => e.id)).toEqual(['calendar-3']);
    const fills = await request(server)
      .get('/api/analysis/algorithm-fills?symbol=005930&from=2026-09-01&to=2026-10-20')
      .set('Cookie', cookie);
    expect(fills.body.connected).toBe(false);
  });

  it('소유자 ID가 없으면 이벤트도 닫힌다', async () => {
    const server = createApp({ store, origin });
    const cookie = await login(server, 'owner@example.test');
    expect((await request(server).get(query()).set('Cookie', cookie)).status).toBe(503);
  });

  it('/api/macro는 소유자 전용으로 마운트되고 미설정이면 503이다', async () => {
    const ecos = {
      observations: vi.fn(async () => [
        { date: '2026-10-12', period: '20261012', value: '1400.5', unit: '원' },
      ]),
    };
    const path = '/api/macro/series?source=ecos&id=kr-usdkrw&from=2026-10-01&to=2026-10-20';
    const configured = createApp({ store, origin, ownerUserId: ownerId, ecos });
    expect((await request(configured).get(path)).status).toBe(401);
    const member = await login(configured, 'member@example.test');
    expect((await request(configured).get(path).set('Cookie', member)).status).toBe(403);
    expect(ecos.observations).not.toHaveBeenCalled();
    const cookie = await login(configured, 'owner@example.test');
    const ok = await request(configured).get(path).set('Cookie', cookie);
    expect(ok.status).toBe(200);
    expect(ok.body.observations).toEqual([{ date: '2026-10-12', value: '1400.5' }]);
    const bare = createApp({ store, origin, ownerUserId: ownerId });
    const cookie2 = await login(bare, 'owner@example.test');
    const missing = await request(bare).get(path).set('Cookie', cookie2);
    expect(missing.status).toBe(503);
    expect(missing.body.error.code).toBe('ECOS_UNAVAILABLE');
  });

  it('시장 지표 일봉: 카탈로그 심볼만, 과거→최신, 소유자만', async () => {
    const bar = (day: string, close: string) => ({
      timestamp: `${day}T00:00:00+09:00`,
      openPrice: close,
      highPrice: close,
      lowPrice: close,
      closePrice: close,
      volume: '0',
    });
    const paths: string[] = [];
    const client = toss((path) => {
      if (path.startsWith('/api/v1/market-indicators/')) {
        paths.push(path);
        return Response.json({
          result: {
            candles: [bar('2026-10-20', '2600.5'), bar('2026-10-19', '2590')],
            nextBefore: '2026-10-18T00:00:00+09:00',
          },
        });
      }
      return undefined;
    });
    const server = createApp({ store, origin, ownerUserId: ownerId, toss: client });
    const url = '/api/market/indicator-candles?symbol=KOSPI&count=2';
    expect((await request(server).get(url)).status).toBe(401);
    const member = await login(server, 'member@example.test');
    expect((await request(server).get(url).set('Cookie', member)).status).toBe(403);
    const cookie = await login(server, 'owner@example.test');
    const response = await request(server).get(url).set('Cookie', cookie);
    expect(response.status).toBe(200);
    expect(response.body.candles.map((c: { close: string }) => c.close)).toEqual([
      '2590',
      '2600.5',
    ]);
    expect(response.body.nextBefore).toBe('2026-10-18T00:00:00+09:00');
    expect(response.body.candles[0]).not.toHaveProperty('currency');
    expect(paths[0]).toContain('/api/v1/market-indicators/KOSPI/candles');
    for (const bad of [
      '/api/market/indicator-candles?symbol=SPX',
      '/api/market/indicator-candles?symbol=KOSPI&count=0',
      '/api/market/indicator-candles?symbol=KOSPI&count=201',
      '/api/market/indicator-candles?symbol=KOSPI&before=garbage',
      '/api/market/indicator-candles?symbol=KOSPI&x=1',
      '/api/market/indicator-candles',
    ])
      expect((await request(server).get(bad).set('Cookie', cookie)).status, bad).toBe(400);
    const noToss = createApp({ store, origin, ownerUserId: ownerId });
    const cookie2 = await login(noToss, 'owner@example.test');
    expect((await request(noToss).get(url).set('Cookie', cookie2)).status).toBe(503);
  });
});
