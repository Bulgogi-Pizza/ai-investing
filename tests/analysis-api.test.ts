import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app';
import { hashPassword } from '../src/server/auth';
import { MemoryStore } from '../src/server/store';
import { MemoryTokenCache, TossClient } from '../src/server/toss';
import { chooseSector, SECTOR_PEER_CAP } from '../src/server/toss-analysis';

// Synthetic responses shaped like Toss OpenAPI v1.2.24. No network is used.
const origin = 'http://localhost:5173';
const password = 'Test-only lengthy password';
type Handler = (path: string) => Response | undefined;
let store: MemoryStore;
let ownerId: string;
let calls: string[];

const ok = (result: unknown) => Response.json({ result });
const stock = (symbol: string, extra: Record<string, unknown> = {}) => ({
  symbol,
  name: `종목${symbol}`,
  englishName: `Stock ${symbol}`,
  isinCode: 'KR0000000000',
  market: 'KOSPI',
  securityType: 'STOCK',
  isCommonShare: true,
  status: 'ACTIVE',
  currency: 'KRW',
  listDate: '1975-06-11',
  delistDate: null,
  sharesOutstanding: '5969782550',
  leverageFactor: null,
  koreanMarketDetail: {
    liquidationTrading: false,
    nxtSupported: true,
    krxTradingSuspended: false,
    nxtTradingSuspended: null,
  },
  ...extra,
});
const volume = { buyVolume: '100', sellVolume: '40', netBuyVolume: '60' };

function transport(override?: Handler) {
  return vi.fn(async (url: string | URL | Request) => {
    const path = String(url).replace('https://openapi.tossinvest.com', '');
    calls.push(path);
    const custom = override?.(path);
    if (custom) return custom;
    if (path === '/oauth2/token')
      return Response.json({ access_token: 'fixture', token_type: 'Bearer', expires_in: 86400 });
    if (path.startsWith('/api/v1/stocks?')) return ok([stock('005930')]);
    if (path.endsWith('/warnings'))
      return ok([
        {
          warningType: 'INVESTMENT_WARNING',
          exchange: 'KRX',
          startDate: '2026-10-15',
          endDate: null,
        },
        { warningType: 'SOMETHING_NEW', exchange: null, startDate: null, endDate: null },
      ]);
    if (path.startsWith('/api/v1/price-limits'))
      return ok({
        timestamp: '2026-10-20T09:30:00+09:00',
        upperLimitPrice: '71950',
        lowerLimitPrice: '38700',
        currency: 'KRW',
      });
    if (path.includes('/investor-trading'))
      return ok({
        nextUntil: null,
        records: [
          {
            date: '2026-10-20',
            updatedAt: '2026-10-20T08:00:00+09:00',
            individual: null,
            foreigner: volume,
            institution: { ...volume, breakdown: null },
            otherCorporation: null,
            foreignerHolding: null,
            cfd: null,
          },
        ],
      });
    if (path.includes('/program-trades'))
      return ok({
        nextUntil: null,
        records: [{ date: '2026-10-20', arbitrage: volume, nonArbitrage: volume }],
      });
    if (path.includes('/short-selling'))
      return ok({
        nextUntil: null,
        records: [
          {
            date: '2026-10-20',
            updatedAt: '2026-10-20T20:00:00+09:00',
            shortSellingVolume: '10',
            shortSellingAmount: '1000',
            shortSellingVolumeRate: null,
            shortSellingAmountRate: '0.0318',
          },
        ],
      });
    if (path.includes('/credit-trades'))
      return ok({
        nextUntil: null,
        records: [
          {
            date: '2026-10-19',
            updatedAt: '2026-10-20T03:00:00+09:00',
            marginLoan: {
              newQuantity: '1',
              returnQuantity: '2',
              balanceQuantity: '3',
              balanceRate: '0.0042',
              tradingRate: '0.09',
            },
            stockLoan: null,
          },
        ],
      });
    if (path.startsWith('/api/v1/orderbook'))
      return ok({
        timestamp: null,
        currency: 'KRW',
        asks: [{ price: '71300', volume: '10' }],
        bids: [{ price: '71200', volume: '12' }],
      });
    if (path.startsWith('/api/v1/trades'))
      return ok([
        { price: '71250', volume: '3', timestamp: '2026-10-20T11:59:57+09:00', currency: 'KRW' },
      ]);
    if (path.startsWith('/api/v1/candles'))
      return ok({
        candles: [
          {
            timestamp: '2026-10-20T00:00:00+09:00',
            openPrice: '1',
            highPrice: '2',
            lowPrice: '1',
            closePrice: '2',
            volume: '3',
            currency: 'KRW',
          },
        ],
        nextBefore: '2026-10-19T00:00:00+09:00',
      });
    return new Response('unexpected', { status: 500 });
  }) as unknown as typeof fetch;
}
function appWith(override?: Handler, options: { toss?: boolean; dart?: unknown } = {}) {
  const toss =
    options.toss === false
      ? undefined
      : new TossClient(
          { clientId: 'c', clientSecret: 's', accountSeq: '1', ownerUserId: ownerId },
          new MemoryTokenCache(),
          transport(override),
        );
  return createApp({
    store,
    origin,
    toss,
    ownerUserId: ownerId,
    dart: options.dart as never,
  });
}
async function login(app: ReturnType<typeof createApp>, email: string) {
  const response = await request(app)
    .post('/api/auth/login')
    .set('Origin', origin)
    .send({ email, password });
  expect(response.status).toBe(200);
  return response.headers['set-cookie'][0].split(';')[0] as string;
}
beforeEach(async () => {
  calls = [];
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

const endpoints = [
  '/api/analysis/stocks?symbols=005930',
  '/api/analysis/warnings?symbol=005930',
  '/api/analysis/price-limits?symbol=005930',
  '/api/analysis/sector-peers?symbol=005930&market=KR',
  '/api/analysis/investor-trading?symbol=005930',
  '/api/analysis/program-trades?symbol=005930',
  '/api/analysis/short-selling?symbol=005930',
  '/api/analysis/credit-trades?symbol=005930',
  '/api/analysis/orderbook?symbol=005930',
  '/api/analysis/trades?symbol=005930',
  '/api/fundamentals?market=KR&symbol=005930',
];

describe('analysis endpoints: access', () => {
  it('rejects anonymous requests before any provider call', async () => {
    const app = appWith();
    for (const path of endpoints) expect((await request(app).get(path)).status, path).toBe(401);
    expect(calls).toEqual([]);
  });
  it('rejects a member with 403 OWNER_REQUIRED and never calls the provider', async () => {
    const app = appWith();
    const cookie = await login(app, 'member@example.test');
    for (const path of endpoints) {
      const response = await request(app).get(path).set('Cookie', cookie);
      expect(response.status, path).toBe(403);
      expect(response.body.error.code, path).toBe('OWNER_REQUIRED');
    }
    expect(calls).toEqual([]);
  });
  it('answers 503 TOSS_INTEGRATION_UNAVAILABLE without Toss, and fundamentals fail closed', async () => {
    const app = appWith(undefined, { toss: false });
    const cookie = await login(app, 'owner@example.test');
    for (const path of endpoints.slice(0, -1)) {
      const response = await request(app).get(path).set('Cookie', cookie);
      expect(response.status, path).toBe(503);
      expect(response.body.error.code, path).toBe('TOSS_INTEGRATION_UNAVAILABLE');
    }
  });
});

describe('analysis endpoints: validation', () => {
  it('rejects malformed, repeated, unknown and oversized parameters with 400', async () => {
    const app = appWith();
    const cookie = await login(app, 'owner@example.test');
    const bad = [
      '/api/analysis/stocks',
      '/api/analysis/stocks?symbols=a%20b',
      `/api/analysis/stocks?symbols=${Array.from({ length: 21 }, (_, i) => `A${i}`).join(',')}`,
      '/api/analysis/warnings?symbol=../x',
      '/api/analysis/warnings?symbol=A&symbol=B',
      '/api/analysis/warnings?symbol=005930&extra=1',
      '/api/analysis/warnings?symbol[a]=1',
      '/api/analysis/price-limits',
      '/api/analysis/sector-peers?symbol=005930',
      '/api/analysis/sector-peers?symbol=005930&market=JP',
      '/api/analysis/investor-trading?symbol=005930&count=0',
      '/api/analysis/investor-trading?symbol=005930&count=31',
      '/api/analysis/investor-trading?symbol=005930&count=abc',
      '/api/analysis/trades?symbol=005930&count=51',
      '/api/market/candles?symbol=005930&before=yesterday',
      '/api/market/candles?symbol=005930&before=2026-10-19T00:00:00',
    ];
    for (const path of bad) {
      const response = await request(app).get(path).set('Cookie', cookie);
      expect(response.status, path).toBe(400);
    }
    expect(calls.filter((c) => c !== '/oauth2/token')).toEqual([]);
  });
  it('keeps investor, short, credit and program trends to Korean symbols', async () => {
    const app = appWith();
    const cookie = await login(app, 'owner@example.test');
    for (const kind of ['investor-trading', 'program-trades', 'short-selling', 'credit-trades']) {
      const response = await request(app)
        .get(`/api/analysis/${kind}?symbol=AAPL`)
        .set('Cookie', cookie);
      expect(response.status, kind).toBe(400);
      expect(response.body.error.code).toBe('UNSUPPORTED_MARKET');
      expect(response.body.error.message).toContain('미국 종목은 토스가 제공하지 않습니다');
    }
    expect(calls.filter((c) => c !== '/oauth2/token')).toEqual([]);
  });
});

describe('analysis endpoints: normalization', () => {
  it('returns only the documented fields', async () => {
    const app = appWith();
    const cookie = await login(app, 'owner@example.test');
    const get = (path: string) => request(app).get(path).set('Cookie', cookie);
    const stocks = await get('/api/analysis/stocks?symbols=005930');
    expect(stocks.status).toBe(200);
    expect(stocks.body.source).toBe('Toss Securities OpenAPI');
    expect(stocks.body.stocks[0]).toMatchObject({
      symbol: '005930',
      sharesOutstanding: '5969782550',
      market: 'KOSPI',
    });
    expect(stocks.body.stocks[0]).not.toHaveProperty('isinCode');
    const warnings = await get('/api/analysis/warnings?symbol=005930');
    expect(warnings.body.warnings).toEqual([
      {
        warningType: 'INVESTMENT_WARNING',
        exchange: 'KRX',
        startDate: '2026-10-15',
        endDate: null,
      },
      { warningType: 'SOMETHING_NEW', exchange: null, startDate: null, endDate: null },
    ]);
    const limits = await get('/api/analysis/price-limits?symbol=005930');
    expect(limits.body).toMatchObject({
      upperLimitPrice: '71950',
      lowerLimitPrice: '38700',
      currency: 'KRW',
    });
    const investor = await get('/api/analysis/investor-trading?symbol=005930&count=5');
    expect(investor.body.records[0]).toMatchObject({ individual: null, foreignerHolding: null });
    expect(investor.body.records[0].institution).not.toHaveProperty('breakdown');
    expect(calls.some((c) => c.includes('/investor-trading?count=5'))).toBe(true);
    const short = await get('/api/analysis/short-selling?symbol=005930');
    expect(short.body.records[0].shortSellingVolumeRate).toBeNull();
    const credit = await get('/api/analysis/credit-trades?symbol=005930');
    expect(credit.body.records[0].stockLoan).toBeNull();
    const program = await get('/api/analysis/program-trades?symbol=005930');
    expect(program.body.records[0].arbitrage.netBuyVolume).toBe('60');
    const book = await get('/api/analysis/orderbook?symbol=005930');
    expect(book.body).toMatchObject({ timestamp: null, asks: [{ price: '71300', volume: '10' }] });
    const trades = await get('/api/analysis/trades?symbol=005930&count=10');
    expect(trades.body.trades).toHaveLength(1);
    expect(calls.some((c) => c.includes('/api/v1/trades?symbol=005930&count=10'))).toBe(true);
  });
  it('fails with PROVIDER_SCHEMA_INVALID when a response has the wrong shape', async () => {
    const wrong: [string, Response][] = [
      ['/api/analysis/stocks?symbols=005930', ok([{ symbol: '005930' }])],
      ['/api/analysis/stocks?symbols=005930', ok([stock('OTHER')])],
      ['/api/analysis/stocks?symbols=005930', ok({})],
      ['/api/analysis/stocks?symbols=005930', ok([stock('005930', { currency: 'JPY' })])],
      ['/api/analysis/stocks?symbols=005930', ok([stock('005930', { sharesOutstanding: '1e9' })])],
      ['/api/analysis/price-limits?symbol=005930', ok({ timestamp: 'x', currency: 'KRW' })],
      ['/api/analysis/orderbook?symbol=005930', ok({ currency: 'KRW', asks: 'x', bids: [] })],
      ['/api/analysis/trades?symbol=005930', ok({})],
      ['/api/analysis/investor-trading?symbol=005930', ok({ records: [{ date: 'x' }] })],
    ];
    for (const [path, body] of wrong) {
      const app = appWith((p) => (p.startsWith('/api/v1/') ? body.clone() : undefined));
      const cookie = await login(app, 'owner@example.test');
      const response = await request(app).get(path).set('Cookie', cookie);
      expect(response.status, path).toBe(502);
      expect(response.body.error.code).toBe('PROVIDER_SCHEMA_INVALID');
    }
  });
  it('caches a read for a short time and does not cache failures', async () => {
    let fail = true;
    const app = appWith((p) =>
      p.startsWith('/api/v1/price-limits') && fail ? new Response('x', { status: 500 }) : undefined,
    );
    const cookie = await login(app, 'owner@example.test');
    const path = '/api/analysis/price-limits?symbol=005930';
    expect((await request(app).get(path).set('Cookie', cookie)).status).toBe(503);
    fail = false;
    expect((await request(app).get(path).set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).get(path).set('Cookie', cookie)).status).toBe(200);
    expect(calls.filter((c) => c.startsWith('/api/v1/price-limits'))).toHaveLength(2);
  });
});

describe('analysis endpoints: provider errors', () => {
  it('reports a 403 on a data call as TOSS_PERMISSION_DENIED (403), not as a service error', async () => {
    const app = appWith((p) =>
      p.startsWith('/api/v1/stocks?') ? new Response('{}', { status: 403 }) : undefined,
    );
    const cookie = await login(app, 'owner@example.test');
    const response = await request(app)
      .get('/api/analysis/stocks?symbols=005930')
      .set('Cookie', cookie);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('TOSS_PERMISSION_DENIED');
    expect(JSON.stringify(response.body)).not.toContain('fixture');
  });
  it('keeps a 403 on the token call as PROVIDER_ACCESS_DENIED (503)', async () => {
    const app = appWith((p) =>
      p === '/oauth2/token' ? new Response('{}', { status: 403 }) : undefined,
    );
    const cookie = await login(app, 'owner@example.test');
    const response = await request(app)
      .get('/api/analysis/stocks?symbols=005930')
      .set('Cookie', cookie);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('PROVIDER_ACCESS_DENIED');
  });
  it('maps 404 and rate limits like the other market endpoints', async () => {
    const app = appWith((p) =>
      p.includes('/warnings')
        ? new Response('{}', { status: 404 })
        : p.includes('/orderbook')
          ? new Response('{}', { status: 429 })
          : undefined,
    );
    const cookie = await login(app, 'owner@example.test');
    const missing = await request(app)
      .get('/api/analysis/warnings?symbol=ZZZ')
      .set('Cookie', cookie);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('PROVIDER_NOT_FOUND');
    const limited = await request(app)
      .get('/api/analysis/orderbook?symbol=005930')
      .set('Cookie', cookie);
    expect(limited.status).toBe(503);
    expect(limited.body.error.code).toBe('PROVIDER_RATE_LIMITED');
  });
});

describe('sector peers', () => {
  const sectors = [
    { sectorId: '1', name: '기술', depth: 0, parentSectorId: null },
    { sectorId: '2', name: '금융', depth: 0, parentSectorId: null },
    { sectorId: '11', name: '반도체', depth: 1, parentSectorId: '1' },
    { sectorId: '12', name: '소프트웨어', depth: 1, parentSectorId: '1' },
    { sectorId: '111', name: '메모리', depth: 2, parentSectorId: '11' },
    { sectorId: '112', name: '장비', depth: 2, parentSectorId: '11' },
  ];
  const member = (symbol: string, cap: number | null) => ({
    symbol,
    name: `N${symbol}`,
    volume: null,
    tradingAmount: null,
    marketCapitalization: cap === null ? null : String(cap),
    currency: 'KRW',
  });
  const codes = (from: number, n: number) => Array.from({ length: n }, (_, i) => String(from + i));
  const lists: Record<string, string[]> = {
    '1': ['005930', ...codes(200000, 29)],
    '2': codes(300000, 8),
    '11': ['005930', ...codes(200000, 24)],
    '12': codes(250000, 5),
    '111': ['005930', '200000', '200001'], // only 2 peers: too thin
    '112': codes(260000, 4),
  };
  const handler: Handler = (path) => {
    if (path === '/api/v1/sectors') return ok({ sectors });
    const match = /^\/api\/v1\/sectors\/(\d+)\/stocks\?marketCountry=(KR|US)$/.exec(path);
    if (match)
      return ok({
        stocks: (lists[match[1]] ?? []).map((s, i) => member(s, i === 3 ? null : 1e12 - i)),
      });
    return undefined;
  };
  it('opens only the sectors that contain the stock and picks the deepest thick one', async () => {
    const app = appWith(handler);
    const cookie = await login(app, 'owner@example.test');
    const response = await request(app)
      .get('/api/analysis/sector-peers?symbol=005930&market=KR')
      .set('Cookie', cookie);
    expect(response.status).toBe(200);
    // 111 has only 2 peers, so the broader 반도체 (24 peers) is chosen.
    expect(response.body.sector).toMatchObject({
      sectorId: '11',
      depth: 1,
      path: ['기술', '반도체'],
    });
    expect(response.body.memberCount).toBe(25);
    expect(response.body.peers).toHaveLength(SECTOR_PEER_CAP);
    expect(response.body.peersTruncated).toBe(true);
    expect(response.body.peers.some((p: { symbol: string }) => p.symbol === '005930')).toBe(false);
    expect(response.body.peers[2].marketCapitalization).toBeNull();
    const opened = calls
      .filter((c) => c.includes('/stocks?marketCountry'))
      .map((c) => c.split('/')[4]);
    // Level 0 (1, 2), then children of matches only (11, 12), then 11's children (111, 112).
    expect(opened.sort()).toEqual(['1', '11', '111', '112', '12', '2']);
    expect(response.body.lookups).toBe(6);
  });
  it('reports no sector when the stock is in none of them', async () => {
    const app = appWith(handler);
    const cookie = await login(app, 'owner@example.test');
    const response = await request(app)
      .get('/api/analysis/sector-peers?symbol=AAPL&market=US')
      .set('Cookie', cookie);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ sector: null, peers: [], memberCount: 0 });
    expect(response.body.lookups).toBe(2);
  });
  it('chooses by depth, peer count and sector id (pure rule)', () => {
    const node = (sectorId: string, depth: number) => ({
      sectorId,
      name: sectorId,
      depth,
      parentSectorId: null,
    });
    const members = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        symbol: i === 0 ? 'X' : `P${i}`,
        name: 'n',
        marketCapitalization: null,
        currency: 'KRW' as const,
      }));
    const thin = { node: node('3', 2), members: members(3) };
    const mid = { node: node('2', 1), members: members(9) };
    const midTwin = { node: node('10', 1), members: members(9) };
    expect(chooseSector([thin, mid], 'X')?.node.sectorId).toBe('2');
    const twins = chooseSector([midTwin, mid], 'X');
    expect(twins?.node.sectorId).toBe('2'); // numeric order, not string order
    expect(twins?.others.map((o) => o.sectorId)).toEqual(['10']);
    // Nothing thick enough: the match with the most members.
    expect(
      chooseSector([thin, { node: node('4', 0), members: members(4) }], 'X')?.node.sectorId,
    ).toBe('4');
    expect(chooseSector([], 'X')).toBeNull();
  });
  it('stops at the lookup limit and says so', async () => {
    const many = Array.from({ length: 70 }, (_, i) => ({
      sectorId: String(1000 + i),
      name: `S${i}`,
      depth: 0,
      parentSectorId: null,
    }));
    const app = appWith((p) => {
      if (p === '/api/v1/sectors') return ok({ sectors: many });
      if (p.includes('/stocks?marketCountry')) return ok({ stocks: [member('100000', 1)] });
      return undefined;
    });
    const cookie = await login(app, 'owner@example.test');
    const response = await request(app)
      .get('/api/analysis/sector-peers?symbol=ZZZ&market=KR')
      .set('Cookie', cookie);
    expect(response.body.lookupLimitReached).toBe(true);
    expect(response.body.lookups).toBe(60);
  });
});

describe('candle paging', () => {
  it('forwards the before cursor unchanged and returns nextBefore', async () => {
    const app = appWith();
    const cookie = await login(app, 'owner@example.test');
    const before = '2026-10-19T00:00:00+09:00';
    const response = await request(app)
      .get(`/api/market/candles?symbol=005930&count=200&before=${encodeURIComponent(before)}`)
      .set('Cookie', cookie);
    expect(response.status).toBe(200);
    expect(response.body.nextBefore).toBe('2026-10-19T00:00:00+09:00');
    const call = calls.find((c) => c.startsWith('/api/v1/candles'))!;
    // `+` must reach the provider percent-encoded (spec).
    expect(call).toContain('before=2026-10-19T00%3A00%3A00%2B09%3A00');
    expect(call).toContain('count=200');
  });
});

describe('fundamentals mount', () => {
  it('answers 503 DART_UNAVAILABLE / SEC_UNAVAILABLE without adapters', async () => {
    const app = appWith();
    const cookie = await login(app, 'owner@example.test');
    const kr = await request(app)
      .get('/api/fundamentals?market=KR&symbol=005930')
      .set('Cookie', cookie);
    expect(kr.status).toBe(503);
    expect(kr.body.error.code).toBe('DART_UNAVAILABLE');
    const us = await request(app)
      .get('/api/fundamentals?market=US&symbol=AAPL')
      .set('Cookie', cookie);
    expect(us.body.error.code).toBe('SEC_UNAVAILABLE');
  });
  it('serves the adapter result with per-share metrics for the owner', async () => {
    const dart = {
      statements: vi.fn(async (symbol: string) => ({
        market: 'KR' as const,
        symbol,
        name: '테스트',
        source: 'DART' as const,
        asOf: '2026-10-20T03:00:00Z',
        statements: [],
        warnings: [],
      })),
    };
    const app = appWith(undefined, { dart });
    const cookie = await login(app, 'owner@example.test');
    const response = await request(app)
      .get('/api/fundamentals?market=KR&symbol=005930')
      .set('Cookie', cookie);
    expect(response.status).toBe(200);
    expect(response.body.perShare.eps).toMatchObject({ value: null, reason: 'NO_STATEMENTS' });
    expect(dart.statements).toHaveBeenCalledWith('005930');
  });
});
