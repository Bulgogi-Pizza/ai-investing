import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { FinancialStatement } from '../src/lib/valuation';
import { DartAdapter } from '../src/server/fundamentals/dart';
import { createFundamentalsRouter } from '../src/server/fundamentals/router';
import { SecAdapter } from '../src/server/fundamentals/sec';
import { RateLimiter, type FundamentalsResult } from '../src/server/fundamentals/shared';
import { ProviderError } from '../src/server/toss';

const OWNER = 'owner-1';
const KEY = 'A1b2C3d4E5f6A1b2C3d4E5f6A1b2C3d4E5f6A1b2';

function quarter(year: number, q: 1 | 2 | 3 | 4, market: 'KR' | 'US'): FinancialStatement {
  const end = `${year}-${['03-31', '06-30', '09-30', '12-31'][q - 1]}`;
  return {
    market,
    symbol: market === 'KR' ? '000001' : 'SYNT',
    periodType: 'quarter',
    fiscalYear: year,
    fiscalPeriod: `Q${q}` as FinancialStatement['fiscalPeriod'],
    periodEnd: end,
    periodEndAssumed: false,
    filedAt: end.replace(/-\d\d$/, '-28'),
    currency: market === 'KR' ? 'KRW' : 'USD',
    scope: 'consolidated',
    derived: false,
    revenue: '1000',
    operatingIncome: '100',
    netIncome: '50',
    totalAssets: '5000',
    totalLiabilities: '3000',
    totalEquity: '2000',
    sharesOutstanding: '100',
    source: market === 'KR' ? 'DART' : 'SEC EDGAR',
    sourceUrl: 'https://example.invalid/synthetic',
  };
}
function result(market: 'KR' | 'US', symbol: string): FundamentalsResult {
  return {
    market,
    symbol,
    name: 'Synthetic',
    source: market === 'KR' ? 'DART' : 'SEC EDGAR',
    asOf: '2026-10-21T00:00:00.000Z',
    statements: [1, 2, 3, 4].map((q) => quarter(2025, q as 1 | 2 | 3 | 4, market)),
    warnings: [],
  };
}
function stub(market: 'KR' | 'US') {
  return { statements: vi.fn(async (symbol: string) => result(market, symbol)) };
}
type User = { id: string; role?: string; active?: boolean } | null;
function app(
  user: User,
  options: {
    dart?: ReturnType<typeof stub> | DartAdapter;
    sec?: ReturnType<typeof stub> | SecAdapter;
    owner?: string;
  } = {},
) {
  const server = express();
  server.use((_req, res, next) => {
    if (user) res.locals.user = user;
    next();
  });
  server.use(
    createFundamentalsRouter({
      dart: options.dart,
      sec: options.sec,
      ownerUserId: options.owner ?? OWNER,
    }),
  );
  return server;
}
const owner = { id: OWNER, role: 'member', active: true };

describe('재무 API 권한', () => {
  it('비로그인 401, 비활성 401, 소유자가 아니면 403이며 어댑터를 호출하지 않는다', async () => {
    const dart = stub('KR');
    const sec = stub('US');
    const url = '/api/fundamentals?market=KR&symbol=000001';
    expect((await request(app(null, { dart, sec })).get(url)).status).toBe(401);
    expect((await request(app({ ...owner, active: false }, { dart, sec })).get(url)).status).toBe(
      401,
    );
    const other = await request(
      app({ id: 'someone', role: 'admin', active: true }, { dart, sec }),
    ).get(url);
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('OWNER_REQUIRED');
    // an unconfigured owner id never matches
    expect((await request(app(owner, { dart, sec, owner: '' })).get(url)).status).toBe(403);
    expect(dart.statements).not.toHaveBeenCalled();
    expect(sec.statements).not.toHaveBeenCalled();
  });
  it('인증은 입력 검증과 제공자 설정 확인보다 먼저다', async () => {
    const response = await request(app(null)).get('/api/fundamentals?market=XX');
    expect(response.status).toBe(401);
  });
});

describe('재무 API 입력 검증', () => {
  it('엄격하게 market·symbol만 받는다', async () => {
    const dart = stub('KR');
    const sec = stub('US');
    const server = app(owner, { dart, sec });
    for (const query of [
      '',
      '?market=KR',
      '?symbol=000001',
      '?market=kr&symbol=000001',
      '?market=JP&symbol=000001',
      '?market=KR&symbol=00001',
      '?market=KR&symbol=0000001',
      '?market=KR&symbol=00%20001',
      '?market=US&symbol=../etc',
      '?market=US&symbol=TOOLONGSYMBOL',
      '?market=US&symbol=',
      '?market=KR&symbol=000001&extra=1',
      '?market=KR&market=US&symbol=000001',
      '?market=KR&symbol=000001&symbol=000002',
      '?market[a]=KR&symbol=000001',
    ]) {
      const response = await request(server).get(`/api/fundamentals${query}`);
      expect(response.status, query).toBe(400);
      expect(response.body.error.code).toBe('INVALID_FUNDAMENTALS_QUERY');
    }
    expect(dart.statements).not.toHaveBeenCalled();
    expect(sec.statements).not.toHaveBeenCalled();
  });
});

describe('재무 API 동작', () => {
  it('KR은 DART, US는 SEC로 보내고 종목 코드를 정규화한다', async () => {
    const dart = stub('KR');
    const sec = stub('US');
    const server = app(owner, { dart, sec });
    const kr = await request(server).get('/api/fundamentals?market=KR&symbol=00000a');
    expect(kr.status).toBe(200);
    expect(dart.statements).toHaveBeenCalledWith('00000A');
    expect(sec.statements).not.toHaveBeenCalled();
    const us = await request(server).get('/api/fundamentals?market=US&symbol=brk.b');
    expect(us.status).toBe(200);
    expect(sec.statements).toHaveBeenCalledWith('BRK-B');
    expect(us.body.source).toBe('SEC EDGAR');
  });
  it('재무제표와 주당 지표(출처·기준일 포함)를 돌려주고 PER·PBR은 돌려주지 않는다', async () => {
    const response = await request(app(owner, { dart: stub('KR') })).get(
      '/api/fundamentals?market=KR&symbol=000001',
    );
    expect(response.status).toBe(200);
    expect(response.body.statements).toHaveLength(4);
    expect(response.body.statements[0]).toMatchObject({
      source: 'DART',
      market: 'KR',
      filedAt: '2025-03-28',
    });
    expect(response.body.perShare.ttm.netIncome).toBe(200);
    expect(response.body.perShare.eps).toMatchObject({
      value: 2,
      reason: null,
      asOf: '2025-12-28',
    });
    expect(response.body.perShare.bps.value).toBe(20);
    expect(response.body.perShare.per).toBeUndefined();
    expect(response.body.notice).toContain('접수일');
  });
  it('제공자가 설정되지 않으면 시장별로 다른 503 코드를 준다', async () => {
    const onlySec = app(owner, { sec: stub('US') });
    const kr = await request(onlySec).get('/api/fundamentals?market=KR&symbol=000001');
    expect(kr.status).toBe(503);
    expect(kr.body.error.code).toBe('DART_UNAVAILABLE');
    const onlyDart = app(owner, { dart: stub('KR') });
    const us = await request(onlyDart).get('/api/fundamentals?market=US&symbol=SYNT');
    expect(us.status).toBe(503);
    expect(us.body.error.code).toBe('SEC_UNAVAILABLE');
    expect((await request(onlyDart).get('/api/fundamentals?market=KR&symbol=000001')).status).toBe(
      200,
    );
  });
  it('제공자 오류는 코드·상태를 유지하고 원문·알 수 없는 오류 내용은 숨긴다', async () => {
    const failing = (error: unknown) => ({ statements: vi.fn(async () => Promise.reject(error)) });
    const get = (dart: ReturnType<typeof failing>) =>
      request(app(owner, { dart })).get('/api/fundamentals?market=KR&symbol=000001');
    const limited = await get(
      failing(new ProviderError(503, 'PROVIDER_RATE_LIMITED', '대기', 120)),
    );
    expect(limited.status).toBe(503);
    expect(limited.headers['retry-after']).toBe('120');
    expect(limited.body.error.code).toBe('PROVIDER_RATE_LIMITED');
    const missing = await get(failing(new ProviderError(404, 'FUNDAMENTALS_NOT_FOUND', '없음')));
    expect(missing.status).toBe(404);
    const unknown = await get(failing(new Error(`secret ${KEY}`)));
    expect(unknown.status).toBe(500);
    expect(JSON.stringify(unknown.body)).not.toContain(KEY);
    expect((await get(failing(new RangeError('INVALID_SYMBOL')))).status).toBe(400);
  });
  it('실제 어댑터가 실패해도 응답에 키·User-Agent·URL이 없다', async () => {
    const leaking = vi.fn(async (input: string | URL | Request) => {
      throw new Error(`boom ${String(input)} ${KEY}`);
    }) as unknown as typeof fetch;
    const dart = new DartAdapter({ apiKey: KEY, transport: leaking, limiter: new RateLimiter(0) });
    const sec = new SecAdapter({
      userAgent: 'Synthetic Test test-contact@example.invalid',
      transport: leaking,
      limiter: new RateLimiter(0),
    });
    const server = app(owner, { dart, sec });
    for (const query of ['market=KR&symbol=000001', 'market=US&symbol=SYNT']) {
      const response = await request(server).get(`/api/fundamentals?${query}`);
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('PROVIDER_UNREACHABLE');
      const body = JSON.stringify(response.body);
      for (const secret of [KEY, 'test-contact', 'opendart', 'data.sec.gov', 'crtfc_key'])
        expect(body).not.toContain(secret);
    }
  });
  it('사용자당 분당 30회로 제한한다', async () => {
    const server = app(owner, { dart: stub('KR') });
    let last = 200;
    for (let i = 0; i < 31; i++)
      last = (await request(server).get('/api/fundamentals?market=KR&symbol=000001')).status;
    expect(last).toBe(429);
  });
});
