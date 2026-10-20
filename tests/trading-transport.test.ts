import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryTokenCache, ProviderError, TossClient } from '../src/server/toss';
import {
  OrderApiError,
  TossOrderClient,
  TransportNetworkError,
  type OrderErrorInfo,
} from '../src/server/trading/toss-orders';
import { TossOrderTransport, transportAllows } from '../src/server/trading/toss-transport';

// Synthetic only: a fake fetch stands behind TossClient. No network, no real credentials, no order
// is ever placed by this file.
type Call = { url: string; init: RequestInit };
const ACCOUNT = '424242';
const SECRET = 'secret-value-that-must-never-leak';

function setup(
  handler: (url: string, init: RequestInit) => Response | Promise<Response> = () =>
    Response.json({ result: {} }),
) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/oauth2/token'))
      return Response.json({ access_token: 'token-abc', token_type: 'Bearer', expires_in: 86400 });
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  const client = new TossClient(
    { clientId: 'client', clientSecret: SECRET, accountSeq: ACCOUNT, ownerUserId: 'owner' },
    new MemoryTokenCache(),
    fetchMock,
  );
  const transport = new TossOrderTransport(client, { minIntervalMs: 0 });
  return { calls, client, transport, fetchMock };
}

afterEach(() => vi.restoreAllMocks());

describe('TossClient.authorizedRequest', () => {
  it('uses the fixed host, bearer token, account header, a timeout and redirect: error', async () => {
    const { client, calls } = setup();
    const response = await client.authorizedRequest({
      method: 'GET',
      path: '/api/v1/buying-power',
      query: { currency: 'KRW' },
    });
    expect(response).toEqual({ status: 200, body: { result: {} }, retryAfterSeconds: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://openapi.tossinvest.com/api/v1/buying-power?currency=KRW');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.redirect).toBe('error');
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].init.headers).toMatchObject({
      Authorization: 'Bearer token-abc',
      'X-Tossinvest-Account': ACCOUNT,
    });
    expect(calls[0].init.body).toBeUndefined();
  });
  it('sends a JSON body for POST only', async () => {
    const { client, calls } = setup();
    await client.authorizedRequest({
      method: 'POST',
      path: '/api/v1/orders',
      body: { a: '1' },
    });
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe('{"a":"1"}');
    expect(calls[0].init.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });
  it('returns HTTP error statuses WITH the parsed body instead of throwing', async () => {
    const { client } = setup(() =>
      Response.json(
        { error: { code: 'invalid-request', data: { field: 'price', tickSize: '100' } } },
        { status: 400 },
      ),
    );
    const response = await client.authorizedRequest({ method: 'GET', path: '/api/v1/orders' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'invalid-request', data: { field: 'price', tickSize: '100' } },
    });
  });
  it('parses Retry-After on 429 and never starts a cooldown or retries', async () => {
    const { client, fetchMock } = setup(
      () =>
        new Response('{"error":{"code":"rate-limit-exceeded"}}', {
          status: 429,
          headers: { 'Retry-After': '7' },
        }),
    );
    const first = await client.authorizedRequest({ method: 'GET', path: '/api/v1/orders' });
    expect(first).toMatchObject({ status: 429, retryAfterSeconds: 7 });
    // No shared cooldown: the next call goes out again (the order client decides about retries).
    await client.authorizedRequest({ method: 'GET', path: '/api/v1/orders' });
    expect(
      (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => !String(c[0]).endsWith('/oauth2/token'),
      ),
    ).toHaveLength(2);
  });
  it('a non-JSON or empty body is undefined, a missing Retry-After is null', async () => {
    const { client } = setup(() => new Response('<html>gateway</html>', { status: 502 }));
    expect(await client.authorizedRequest({ method: 'GET', path: '/api/v1/orders' })).toEqual({
      status: 502,
      body: undefined,
      retryAfterSeconds: null,
    });
    const empty = setup(() => new Response(null, { status: 204 }));
    expect(await empty.client.authorizedRequest({ method: 'GET', path: '/api/v1/orders' })).toEqual(
      { status: 204, body: undefined, retryAfterSeconds: null },
    );
  });
  it('refuses malformed paths before any request (and before a token is requested)', async () => {
    const { client, fetchMock } = setup();
    for (const path of [
      '/oauth2/token',
      '/api/v2/orders',
      'api/v1/orders',
      '/api/v1/../orders',
      '/api/v1/orders?x=1',
      '/api/v1/orders#x',
      '//evil.example/api/v1/orders',
      '/api/v1/',
    ])
      await expect(client.authorizedRequest({ method: 'GET', path })).rejects.toBeInstanceOf(
        ProviderError,
      );
    await expect(
      client.authorizedRequest({ method: 'GET', path: '/api/v1/orders', body: { a: 1 } }),
    ).rejects.toBeInstanceOf(ProviderError);
    await expect(
      client.authorizedRequest({ method: 'DELETE' as 'GET', path: '/api/v1/orders' }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('a connection failure throws a fixed message without the URL, token or secret', async () => {
    const { client } = setup(() => {
      throw new Error(
        `connect ECONNRESET https://openapi.tossinvest.com Bearer token-abc ${SECRET}`,
      );
    });
    const error = await client
      .authorizedRequest({ method: 'GET', path: '/api/v1/orders' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    const text = `${(error as Error).message} ${(error as ProviderError).code}`;
    expect(text).not.toMatch(/token-abc|openapi|ECONNRESET/);
    expect(text).not.toContain(SECRET);
  });
  it('a response over the size cap is refused', async () => {
    const { client } = setup(() => new Response('x'.repeat(5000), { status: 200 }));
    await expect(
      client.authorizedRequest({ method: 'GET', path: '/api/v1/orders' }, { maxBytes: 1024 }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('TossOrderTransport', () => {
  it('allows exactly the reads and the order creation the live flow needs', () => {
    const get = (path: string, extra: object = {}) =>
      transportAllows({ method: 'GET', path, ...extra });
    for (const path of [
      '/api/v1/orders',
      '/api/v1/orders/abc-123',
      '/api/v1/buying-power',
      '/api/v1/sellable-quantity',
      '/api/v1/commissions',
      '/api/v1/stocks/005930/warnings',
      '/api/v1/price-limits',
      '/api/v1/exchange-rate',
      '/api/v1/prices',
    ])
      expect(get(path), path).toBe(true);
    expect(transportAllows({ method: 'POST', path: '/api/v1/orders', body: {} })).toBe(true);
    // Not allowed: cancel, any other POST, other reads, the token endpoint, traversal, bodies on GET.
    expect(transportAllows({ method: 'POST', path: '/api/v1/orders/abc/cancel' })).toBe(false);
    expect(transportAllows({ method: 'POST', path: '/api/v1/buying-power' })).toBe(false);
    expect(transportAllows({ method: 'POST', path: '/api/v1/orders', query: { a: '1' } })).toBe(
      false,
    );
    for (const path of [
      '/oauth2/token',
      '/api/v1/accounts',
      '/api/v1/holdings',
      '/api/v1/orders/../accounts',
      '/api/v1/orders/a/b',
      '/api/v1/stocks/../warnings',
      '/api/v1/orders/',
    ])
      expect(get(path), path).toBe(false);
    expect(get('/api/v1/orders', { body: { a: 1 } })).toBe(false);
    expect(transportAllows({ method: 'PUT' as 'GET', path: '/api/v1/orders' })).toBe(false);
  });
  it('a refused request throws before any network or token use', async () => {
    const { transport, fetchMock } = setup();
    await expect(
      transport.send({ method: 'POST', path: '/api/v1/orders/abc/cancel' }),
    ).rejects.toBeInstanceOf(TransportNetworkError);
    await expect(
      transport.send({ method: 'GET', path: '/api/v1/accounts' }),
    ).rejects.toBeInstanceOf(TransportNetworkError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('returns error responses with the body intact (the order client needs documented error fields)', async () => {
    const { transport } = setup(() =>
      Response.json(
        {
          error: {
            requestId: 'req-1',
            code: 'invalid-request',
            message: 'text',
            data: { field: 'price', tickSize: '100', nearestPrices: ['69900', '70000'] },
          },
        },
        { status: 400 },
      ),
    );
    const response = await transport.send({
      method: 'POST',
      path: '/api/v1/orders',
      body: { clientOrderId: 'ai-1' },
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: 'invalid-request', data: { tickSize: '100' } },
    });
  });
  it('does not retry on its own: one fetch per send, for a 500, a 429 and a network failure', async () => {
    for (const make of [
      () => new Response('{"error":{"code":"internal-error"}}', { status: 500 }),
      () => new Response('{"error":{"code":"rate-limit-exceeded"}}', { status: 429 }),
    ]) {
      const { transport, calls } = setup(make);
      const response = await transport.send({ method: 'GET', path: '/api/v1/orders' });
      expect([500, 429]).toContain(response.status);
      expect(calls).toHaveLength(1);
    }
    const failing = setup(() => {
      throw new Error('socket hang up');
    });
    await expect(
      failing.transport.send({ method: 'POST', path: '/api/v1/orders', body: {} }),
    ).rejects.toBeInstanceOf(TransportNetworkError);
    expect(failing.calls).toHaveLength(1);
  });
  it('the order client reads the tick-size error data THROUGH the transport and resends once', async () => {
    let attempt = 0;
    const { client, calls } = setup((_url, init) => {
      attempt++;
      const body = JSON.parse(String(init.body)) as { clientOrderId: string; price: string };
      if (attempt === 1)
        return Response.json(
          {
            error: {
              code: 'invalid-request',
              data: { field: 'price', tickSize: '100', nearestPrices: ['69900', '70000'] },
            },
          },
          { status: 400 },
        );
      return Response.json({ result: { orderId: 'order-1', clientOrderId: body.clientOrderId } });
    });
    const orders = new TossOrderClient(new TossOrderTransport(client, { minIntervalMs: 0 }), {
      sleep: async () => {},
    });
    const result = await orders.placeOrder(
      {
        clientOrderId: 'ai-test',
        market: 'KR',
        symbol: '005930',
        side: 'buy',
        quantity: 3,
        price: '69950',
      },
      { onPriceCorrection: () => true },
    );
    expect(result).toMatchObject({ outcome: 'accepted', tickCorrected: true, price: '69900' });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1].init.body))).toMatchObject({ price: '69900' });
  });
  it('maps a network failure to an unknown outcome and a 403 to a sanitized refusal', async () => {
    const down = setup(() => {
      throw new Error(`boom ${SECRET}`);
    });
    const orders = new TossOrderClient(down.transport, { sleep: async () => {}, maxRetries: 0 });
    const unknown = await orders.placeOrder({
      clientOrderId: 'ai-net',
      market: 'KR',
      symbol: '005930',
      side: 'buy',
      quantity: 1,
      price: '70000',
    });
    expect(unknown).toMatchObject({ outcome: 'unknown', error: { code: 'network-error' } });
    expect(JSON.stringify(unknown)).not.toContain(SECRET);
    const denied = setup(() =>
      Response.json({ error: { code: 'forbidden', message: `text ${SECRET}` } }, { status: 403 }),
    );
    const refused = await new TossOrderClient(denied.transport).placeOrder({
      clientOrderId: 'ai-403',
      market: 'KR',
      symbol: '005930',
      side: 'buy',
      quantity: 1,
      price: '70000',
    });
    expect(refused).toMatchObject({
      outcome: 'rejected',
      error: { status: 403, code: 'forbidden' },
    });
    expect(JSON.stringify(refused)).not.toContain(SECRET);
  });
  it('a failing read becomes a sanitized OrderApiError with no URL, header or account id', async () => {
    const { transport } = setup(() => {
      throw new Error(`fetch failed https://openapi.tossinvest.com ${ACCOUNT} Bearer token-abc`);
    });
    const error = (await new TossOrderClient(transport)
      .getBuyingPower('KRW')
      .catch((e: unknown) => e)) as OrderApiError;
    expect(error).toBeInstanceOf(OrderApiError);
    const info: OrderErrorInfo = error.info;
    expect(JSON.stringify([error.message, info])).not.toMatch(
      new RegExp(`token-abc|openapi|${ACCOUNT}`),
    );
  });
  it('never logs a body, header, token or account id', async () => {
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
    ];
    const { transport } = setup(() =>
      Response.json({ error: { code: 'forbidden' } }, { status: 403 }),
    );
    await transport.send({ method: 'POST', path: '/api/v1/orders', body: { symbol: '005930' } });
    const down = setup(() => {
      throw new Error('x');
    });
    await down.transport.send({ method: 'GET', path: '/api/v1/orders' }).catch(() => undefined);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
  it('keeps a minimum interval between calls', async () => {
    let now = 1000;
    const sleeps: number[] = [];
    const { client } = setup();
    const transport = new TossOrderTransport(client, {
      minIntervalMs: 120,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    await transport.send({ method: 'GET', path: '/api/v1/orders' });
    now += 20;
    await transport.send({ method: 'GET', path: '/api/v1/orders' });
    expect(sleeps).toEqual([100]);
  });
});
