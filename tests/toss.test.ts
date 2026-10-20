import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';
import fixture from './fixtures/toss-holdings.json';
import {
  FirestoreTokenCache,
  MemoryTokenCache,
  normalizeHoldings,
  TossClient,
} from '../src/server/toss';
// Fixture copied from official OpenAPI v1.2.24 withHoldings example, not customer data.
// https://openapi.tossinvest.com/openapi-docs/latest/openapi.json
const config = {
  clientId: 'fixture-client',
  clientSecret: 'fixture-secret',
  accountSeq: '1',
  ownerUserId: 'owner-fixture',
};
function fakeTransport(handler?: (url: string, init?: RequestInit) => Response) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (handler) return handler(path, init);
    if (path.endsWith('/oauth2/token'))
      return Response.json({
        access_token: 'fixture-access-token',
        token_type: 'Bearer',
        expires_in: 86400,
      });
    if (path.endsWith('/accounts'))
      return Response.json({
        result: [{ accountSeq: 1, accountType: 'BROKERAGE', accountNo: 'must-never-leak' }],
      });
    return Response.json(fixture);
  }) as unknown as typeof fetch;
}
describe('official Toss read-only boundary', () => {
  it('normalizes separate currencies and strips raw fields/account identifiers', () => {
    const portfolio = normalizeHoldings({ ...fixture.result, accountNo: 'must-never-leak' });
    expect(portfolio.totals.KRW.marketValue).toBe('7200000');
    expect(portfolio.totals.USD.marketValue).toBe('1785');
    expect(portfolio.holdings[0]).toMatchObject({
      symbol: '005930',
      currency: 'KRW',
      quantity: '100',
      profitLossRate: '0.1077',
    });
    expect(portfolio.scope).toBe('stocks-only');
    expect(JSON.stringify(portfolio)).not.toContain('must-never-leak');
    expect(portfolio.holdings[0]).not.toHaveProperty('cost');
  });
  it('binds provider assets to configured owner before making requests', async () => {
    const transport = fakeTransport();
    const client = new TossClient(config, new MemoryTokenCache(), transport);
    await expect(client.portfolio('another-user')).rejects.toMatchObject({
      status: 403,
      code: 'PORTFOLIO_OWNER_REQUIRED',
    });
    expect(transport).not.toHaveBeenCalled();
  });
  it('uses OAuth form, bearer and account header; deduplicates concurrent reads and token issuance', async () => {
    const transport = fakeTransport();
    const client = new TossClient(config, new MemoryTokenCache(), transport);
    const results = await Promise.all([
      client.portfolio(config.ownerUserId),
      client.portfolio(config.ownerUserId),
    ]);
    expect(results[0]).toEqual(results[1]);
    await client.portfolio(config.ownerUserId);
    const calls = vi.mocked(transport).mock.calls;
    expect(calls).toHaveLength(3);
    const oauth = calls[0][1]!;
    expect(oauth.method).toBe('POST');
    expect(String(oauth.body)).toContain('grant_type=client_credentials');
    expect(String(oauth.body)).toContain('client_secret=fixture-secret');
    const holdings = calls.find((call) => String(call[0]).endsWith('/holdings'))![1]!;
    expect(holdings.headers).toMatchObject({
      Authorization: 'Bearer fixture-access-token',
      'X-Tossinvest-Account': '1',
    });
    expect(JSON.stringify(results)).not.toContain('fixture-secret');
    expect(JSON.stringify(results)).not.toContain('must-never-leak');
  });
  it('uses singleflight token refresh and backs off uncertain issuance without retry', async () => {
    const cache = new MemoryTokenCache();
    const issue = vi.fn(async () => {
      await Promise.resolve();
      return { value: 'fixture', expiresAt: Date.now() + 86400000 };
    });
    await Promise.all([cache.get(issue), cache.get(issue)]);
    expect(issue).toHaveBeenCalledTimes(1);
    const failing = new MemoryTokenCache();
    const fail = vi.fn(async () => {
      throw new Error('network failure');
    });
    await expect(failing.get(fail)).rejects.toThrow();
    await expect(failing.get(fail)).rejects.toMatchObject({ code: 'PROVIDER_TOKEN_COOLDOWN' });
    expect(fail).toHaveBeenCalledTimes(1);
  });
  it('coordinates token lease across separate Firestore cache instances', async () => {
    let state: Record<string, unknown> = {};
    let tail: Promise<unknown> = Promise.resolve();
    const ref = {};
    const db = {
      collection: () => ({ doc: () => ref }),
      runTransaction: (run: (tx: unknown) => Promise<unknown>) => {
        const next = tail.then(() =>
          run({
            get: async () => ({ data: () => ({ ...state }) }),
            set: (_ref: unknown, value: Record<string, unknown>, options?: { merge: boolean }) => {
              state = options?.merge ? { ...state, ...value } : value;
            },
          }),
        );
        tail = next.catch(() => undefined);
        return next;
      },
    } as unknown as Firestore;
    const first = new FirestoreTokenCache(config.clientId, db);
    const second = new FirestoreTokenCache(config.clientId, db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const issue = vi.fn(async () => {
      await gate;
      return { value: 'shared-fixture', expiresAt: Date.now() + 86400000 };
    });
    const pending = first.get(issue);
    const sameInstance = first.get(issue);
    await vi.waitFor(() => expect(issue).toHaveBeenCalledTimes(1));
    await expect(second.get(issue)).rejects.toMatchObject({ code: 'PROVIDER_TOKEN_BUSY' });
    release();
    expect(await pending).toBe('shared-fixture');
    expect(await sameInstance).toBe('shared-fixture');
    expect(await second.get(issue)).toBe('shared-fixture');
    expect(issue).toHaveBeenCalledTimes(1);
  });
  it('sanitizes upstream limits/timeouts and invalid payloads', async () => {
    const limited = new TossClient(
      config,
      new MemoryTokenCache(),
      fakeTransport(
        () => new Response('private failure', { status: 429, headers: { 'Retry-After': '15' } }),
      ),
    );
    await expect(limited.portfolio(config.ownerUserId)).rejects.toMatchObject({
      status: 503,
      code: 'PROVIDER_RATE_LIMITED',
      retryAfter: 15,
    });
    const timedOut = new TossClient(
      config,
      new MemoryTokenCache(),
      vi.fn(async () => {
        throw new Error('private network details');
      }) as unknown as typeof fetch,
    );
    await expect(timedOut.portfolio(config.ownerUserId)).rejects.toMatchObject({
      code: 'PROVIDER_UNREACHABLE',
    });
    expect(() =>
      normalizeHoldings({
        ...fixture.result,
        items: [{ ...fixture.result.items[0], quantity: 'NaN' }],
      }),
    ).toThrow();
  });
  it('validates market query, maps official decimal candles, and returns chronological bars', async () => {
    const transport = fakeTransport((url) =>
      url.endsWith('/oauth2/token')
        ? Response.json({ access_token: 'fixture', token_type: 'Bearer', expires_in: 86400 })
        : Response.json({
            result: {
              candles: ['2026-03-25', '2026-03-24'].map((date) => ({
                timestamp: date + 'T00:00:00+09:00',
                openPrice: '10',
                highPrice: '12',
                lowPrice: '9',
                closePrice: '11',
                volume: '100',
                currency: 'KRW',
              })),
              nextBefore: null,
            },
          }),
    );
    const client = new TossClient(config, new MemoryTokenCache(), transport);
    await expect(client.candles('../../secrets', '1d', 100)).rejects.toMatchObject({ status: 400 });
    await expect(client.candles('005930', '5m', 100)).rejects.toMatchObject({ status: 400 });
    await expect(client.candles('005930', '1d', 201)).rejects.toMatchObject({ status: 400 });
    expect(transport).not.toHaveBeenCalled();
    const data = await client.candles('005930', '1d', 100);
    expect(data.candles[0].timestamp).toContain('2026-03-24');
    expect(data.candles[0].close).toBe('11');
  });
});
