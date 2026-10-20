import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app';
import { hashPassword } from '../src/server/auth';
import { MemoryStore } from '../src/server/store';
import { MemoryTokenCache, parsePriceSymbols, TossClient } from '../src/server/toss';
import prices from './fixtures/toss-prices.json';
import indicators from './fixtures/toss-market-indicators.json';
import exchangeRate from './fixtures/toss-exchange-rate.json';
import holdings from './fixtures/toss-holdings.json';

// Synthetic fixtures shaped like the official OpenAPI v1.2.24 examples. No network is used.
const origin = 'http://localhost:5173';
const password = 'Test-only lengthy password';
type Handler = (path: string) => Response | undefined;
let store: MemoryStore;
let ownerId: string;
let memberId: string;
let calls: string[];

function transport(override?: Handler) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('https://openapi.tossinvest.com', '');
    calls.push(path);
    const custom = override?.(path);
    if (custom) return custom;
    if (path === '/oauth2/token')
      return Response.json({ access_token: 'fixture', token_type: 'Bearer', expires_in: 86400 });
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fixture');
    if (path.startsWith('/api/v1/prices')) return Response.json(prices);
    if (path.startsWith('/api/v1/market-indicators/prices')) return Response.json(indicators);
    if (path.startsWith('/api/v1/exchange-rate')) return Response.json(exchangeRate);
    if (path === '/api/v1/accounts')
      return Response.json({ result: [{ accountSeq: 1, accountType: 'BROKERAGE' }] });
    if (path === '/api/v1/holdings') return Response.json(holdings);
    return new Response('unexpected', { status: 500 });
  }) as unknown as typeof fetch;
}
function appWith(
  override?: Handler,
  options: { toss?: boolean; ownerUserId?: string | null } = {},
) {
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
    ownerUserId: options.ownerUserId === null ? undefined : (options.ownerUserId ?? ownerId),
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
  memberId = (
    await store.createUser({
      email: 'member@example.test',
      passwordHash,
      role: 'member',
      active: true,
      version: 1,
    })
  ).id;
});
const tossEndpoints = [
  '/api/market/prices?symbols=005930,AAPL',
  '/api/market/indicators',
  '/api/market/candles?symbol=005930',
  '/api/portfolio',
  '/api/recommendations',
];
// Owner-account data that does not call Toss but is still owner-only.
const endpoints = [
  ...tossEndpoints,
  '/api/strategy',
  '/api/calendar/events?from=2026-10-01&to=2026-10-31',
  '/api/news/sources',
];
describe('owner-only market endpoints', () => {
  it('rejects anonymous requests before any provider call', async () => {
    const app = appWith();
    for (const path of endpoints) expect((await request(app).get(path)).status).toBe(401);
    expect(calls).toEqual([]);
  });
  it('rejects a signed-in member with 403 OWNER_REQUIRED and never calls the provider', async () => {
    const app = appWith();
    const cookie = await login(app, 'member@example.test');
    for (const path of endpoints) {
      const response = await request(app).get(path).set('Cookie', cookie);
      expect(response.status, path).toBe(403);
      expect(response.body.error.code, path).toBe('OWNER_REQUIRED');
    }
    expect(calls).toEqual([]);
    expect(memberId).not.toBe(ownerId);
  });
  it('returns 503 TOSS_INTEGRATION_UNAVAILABLE when Toss is not configured', async () => {
    const app = appWith(undefined, { toss: false });
    const cookie = await login(app, 'owner@example.test');
    for (const path of tossEndpoints) {
      const response = await request(app).get(path).set('Cookie', cookie);
      expect(response.status, path).toBe(503);
      expect(response.body.error.code, path).toBe('TOSS_INTEGRATION_UNAVAILABLE');
    }
  });
  it('fails closed when no owner id is configured, even if Toss is configured', async () => {
    const app = appWith(undefined, { ownerUserId: null });
    const cookie = await login(app, 'owner@example.test');
    for (const path of endpoints)
      expect((await request(app).get(path).set('Cookie', cookie)).status, path).toBe(503);
    expect(calls).toEqual([]);
  });
  it('serves normalized prices to the owner and sends only documented requests', async () => {
    const app = appWith();
    const cookie = await login(app, 'owner@example.test');
    const response = await request(app)
      .get('/api/market/prices?symbols=005930,AAPL,005930')
      .set('Cookie', cookie);
    expect(response.status).toBe(200);
    expect(response.body.prices).toEqual([
      {
        symbol: '005930',
        lastPrice: '72000',
        currency: 'KRW',
        timestamp: '2026-10-20T09:30:00.123+09:00',
      },
      {
        symbol: 'AAPL',
        lastPrice: '185.70',
        currency: 'USD',
        timestamp: '2026-10-20T22:30:00.456+09:00',
      },
    ]);
    expect(response.body.source).toBe('Toss Securities OpenAPI');
    expect(Number.isFinite(Date.parse(response.body.asOf))).toBe(true);
    expect(calls).toEqual(['/oauth2/token', '/api/v1/prices?symbols=005930%2CAAPL']);
    await request(app).get('/api/market/prices?symbols=005930,AAPL').set('Cookie', cookie);
    expect(calls).toHaveLength(2);
  });
  it('serves market indicators and USD/KRW to the owner', async () => {
    const app = appWith();
    const cookie = await login(app, 'owner@example.test');
    const response = await request(app).get('/api/market/indicators').set('Cookie', cookie);
    expect(response.status).toBe(200);
    expect(response.body.indicators).toEqual([
      {
        symbol: 'KOSPI',
        name: '코스피',
        kind: 'INDEX',
        unit: 'point',
        lastPrice: '2812.45',
        timestamp: '2026-10-20T15:30:00+09:00',
      },
      {
        symbol: 'KOSDAQ',
        name: '코스닥',
        kind: 'INDEX',
        unit: 'point',
        lastPrice: '845.32',
        timestamp: '2026-10-20T15:30:00+09:00',
      },
      {
        symbol: 'KR_BOND_2Y',
        name: '국채 2년',
        kind: 'BOND',
        unit: 'percent',
        lastPrice: '2.98',
        timestamp: '2026-10-20T15:29:55+09:00',
      },
      {
        symbol: 'KR_BOND_10Y',
        name: '국채 10년',
        kind: 'BOND',
        unit: 'percent',
        lastPrice: '3.25',
        timestamp: null,
      },
    ]);
    expect(response.body.exchangeRate).toEqual({
      baseCurrency: 'USD',
      quoteCurrency: 'KRW',
      midRate: '1375',
      rate: '1380.5',
      rateChangeType: 'UP',
      validFrom: '2026-10-20T09:30:00+09:00',
      validUntil: '2026-10-20T09:31:00+09:00',
    });
    expect(JSON.stringify(response.body)).not.toContain('basisPoint');
    expect(calls).toContain(
      '/api/v1/market-indicators/prices?symbols=KOSPI%2CKOSDAQ%2CKR_BOND_2Y%2CKR_BOND_3Y%2CKR_BOND_5Y%2CKR_BOND_10Y%2CKR_BOND_20Y%2CKR_BOND_30Y',
    );
    expect(calls).toContain('/api/v1/exchange-rate?baseCurrency=USD&quoteCurrency=KRW');
  });
  it('still serves the owner portfolio and candle route behind the same gate', async () => {
    const app = appWith();
    const cookie = await login(app, 'owner@example.test');
    expect((await request(app).get('/api/portfolio').set('Cookie', cookie)).status).toBe(200);
  });
});

describe('input validation', () => {
  const invalid = [
    '/api/market/prices',
    '/api/market/prices?symbols=',
    '/api/market/prices?symbols=005930,,AAPL',
    '/api/market/prices?symbols=005930,',
    '/api/market/prices?symbols=../../secrets',
    '/api/market/prices?symbols=A%20B',
    '/api/market/prices?symbols=005930&symbols=AAPL',
    '/api/market/prices?symbols[a]=1',
    `/api/market/prices?symbols=${'A'.repeat(31)}`,
    `/api/market/prices?symbols=${Array.from({ length: 51 }, (_, i) => `S${i}`).join(',')}`,
  ];
  it('rejects malformed, oversized and repeated symbol parameters with 400', async () => {
    const app = appWith();
    const cookie = await login(app, 'owner@example.test');
    for (const path of invalid) {
      const response = await request(app).get(path).set('Cookie', cookie);
      expect(response.status, path).toBe(400);
      expect(response.body.error.code).toBe('INVALID_MARKET_QUERY');
    }
    expect(calls).toEqual([]);
  });
  it('parses symbol lists strictly', () => {
    expect(parsePriceSymbols('005930,AAPL,005930')).toEqual(['005930', 'AAPL']);
    expect(parsePriceSymbols('BRK.B,BF-B')).toEqual(['BRK.B', 'BF-B']);
    expect(parsePriceSymbols(undefined)).toBeNull();
    expect(parsePriceSymbols(['A'])).toBeNull();
    expect(parsePriceSymbols('A,,B')).toBeNull();
    expect(parsePriceSymbols(Array(51).fill('A').join(','))).toBeNull();
  });
});

describe('provider schema validation', () => {
  const owner = async (override: Handler) => {
    const app = appWith(override);
    return { app, cookie: await login(app, 'owner@example.test') };
  };
  const only =
    (prefix: string, body: unknown, status = 200): Handler =>
    (path) =>
      path.startsWith(prefix) ? Response.json(body, { status }) : undefined;
  const priceCases: [string, unknown][] = [
    ['result is not an array', { result: { symbol: '005930' } }],
    ['missing envelope', { items: [] }],
    ['non-decimal price', { result: [{ ...prices.result[0], lastPrice: 'NaN' }] }],
    ['unknown currency', { result: [{ ...prices.result[0], currency: 'EUR' }] }],
    ['unrequested symbol', { result: [{ ...prices.result[0], symbol: 'TSLA' }] }],
    ['bad timestamp', { result: [{ ...prices.result[0], timestamp: 'yesterday' }] }],
    ['too many rows', { result: [prices.result[0], prices.result[1], prices.result[0]] }],
    ['duplicate rows', { result: [prices.result[0], prices.result[0]] }],
  ];
  it.each(priceCases)('prices: %s -> 502 PROVIDER_SCHEMA_INVALID', async (_name, body) => {
    const { app, cookie } = await owner(only('/api/v1/prices', body));
    const response = await request(app)
      .get('/api/market/prices?symbols=005930,AAPL')
      .set('Cookie', cookie);
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('PROVIDER_SCHEMA_INVALID');
  });
  const indicatorCases: [string, Handler][] = [
    [
      'unknown symbol',
      only('/api/v1/market-indicators/prices', { result: [{ symbol: 'SPX', lastPrice: '1' }] }),
    ],
    [
      'non-decimal value',
      only('/api/v1/market-indicators/prices', { result: [{ symbol: 'KOSPI', lastPrice: 'abc' }] }),
    ],
    ['not an array', only('/api/v1/market-indicators/prices', { result: {} })],
    [
      'wrong fx pair',
      only('/api/v1/exchange-rate', { result: { ...exchangeRate.result, baseCurrency: 'KRW' } }),
    ],
    [
      'missing midRate',
      only('/api/v1/exchange-rate', { result: { ...exchangeRate.result, midRate: undefined } }),
    ],
    [
      'bad validFrom',
      only('/api/v1/exchange-rate', { result: { ...exchangeRate.result, validFrom: 'x' } }),
    ],
  ];
  it.each(indicatorCases)('indicators: %s -> 502', async (_name, handler) => {
    const { app, cookie } = await owner(handler);
    const response = await request(app).get('/api/market/indicators').set('Cookie', cookie);
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('PROVIDER_SCHEMA_INVALID');
  });
  it('oversized provider bodies are rejected as invalid', async () => {
    const { app, cookie } = await owner((path) =>
      path.startsWith('/api/v1/prices')
        ? new Response('x'.repeat(4 * 1024 * 1024 + 10), { status: 200 })
        : undefined,
    );
    const response = await request(app)
      .get('/api/market/prices?symbols=005930')
      .set('Cookie', cookie);
    expect(response.status).toBe(502);
  });
  it('maps provider 404 to PROVIDER_NOT_FOUND and hides provider error text', async () => {
    const { app, cookie } = await owner(
      only('/api/v1/prices', { error: { code: 'stock-not-found', message: 'secret detail' } }, 404),
    );
    const response = await request(app)
      .get('/api/market/prices?symbols=ZZZZ')
      .set('Cookie', cookie);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('PROVIDER_NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toContain('secret detail');
  });
  it('maps provider 5xx and access denial to sanitized 503 without raw bodies', async () => {
    const { app, cookie } = await owner(
      only(
        '/api/v1/market-indicators/prices',
        { error: { message: 'private upstream text' } },
        500,
      ),
    );
    const response = await request(app).get('/api/market/indicators').set('Cookie', cookie);
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain('private upstream text');
  });
});
