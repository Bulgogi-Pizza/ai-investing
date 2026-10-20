import { describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_WINDOW_MS,
  OrderApiError,
  OrderInputError,
  TossOrderClient,
  TransportNetworkError,
  correctedClientOrderId,
  deriveClientOrderId,
  describeOrderError,
  normalizeLimitPrice,
  tickCorrection,
  type OrderTransport,
  type PlaceOrderRequest,
  type TransportRequest,
  type TransportResponse,
} from '../src/server/trading/toss-orders';
import { FakeToss } from '../src/server/trading/testing';

const SECRET_TEXT = 'text that must never be stored';

function setup(options: { now?: () => number } = {}) {
  const fake = new FakeToss();
  const sleeps: number[] = [];
  const client = new TossOrderClient(fake, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: options.now,
  });
  return { fake, client, sleeps };
}

const krBuy = (over: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest => ({
  clientOrderId: 'ai-test-0001',
  market: 'KR',
  symbol: '005930',
  side: 'buy',
  quantity: 10,
  price: '70000',
  ...over,
});

describe('deriveClientOrderId', () => {
  const parts = {
    algorithmId: 'algo-1',
    runId: 'run-2026-10-21',
    symbol: '005930',
    side: 'buy' as const,
    tranche: 0,
  };
  it('is deterministic and uses only allowed characters within 36 characters', () => {
    const id = deriveClientOrderId(parts);
    expect(deriveClientOrderId({ ...parts })).toBe(id);
    expect(id).toMatch(/^[a-zA-Z0-9\-_]{1,36}$/);
    expect(correctedClientOrderId(id)).toMatch(/^[a-zA-Z0-9\-_]{1,36}$/);
  });
  it('changes with every component', () => {
    const base = deriveClientOrderId(parts);
    const variants = [
      { ...parts, algorithmId: 'algo-2' },
      { ...parts, runId: 'run-2026-10-22' },
      { ...parts, symbol: '000660' },
      { ...parts, side: 'sell' as const },
      { ...parts, tranche: 1 },
    ].map(deriveClientOrderId);
    expect(new Set([base, ...variants]).size).toBe(6);
  });
  it('is not ambiguous between components (no delimiter collisions)', () => {
    expect(deriveClientOrderId({ ...parts, algorithmId: 'a', runId: 'b-c' })).not.toBe(
      deriveClientOrderId({ ...parts, algorithmId: 'a-b', runId: 'c' }),
    );
  });
  it('rejects a bad tranche', () => {
    expect(() => deriveClientOrderId({ ...parts, tranche: -1 })).toThrow(OrderInputError);
    expect(() => deriveClientOrderId({ ...parts, tranche: 1.5 })).toThrow(OrderInputError);
  });
});

describe('normalizeLimitPrice', () => {
  it('KR: integer won, rounded toward the less aggressive side', () => {
    expect(normalizeLimitPrice('KR', 'buy', 70000)).toBe('70000');
    expect(normalizeLimitPrice('KR', 'buy', '70000.9')).toBe('70000');
    expect(normalizeLimitPrice('KR', 'sell', '70000.1')).toBe('70001');
    expect(normalizeLimitPrice('KR', 'sell', '70000.0')).toBe('70000');
  });
  it('US: 2 decimals from $1, 4 decimals below $1, never rounding toward a better fill', () => {
    expect(normalizeLimitPrice('US', 'buy', '185.567')).toBe('185.56');
    expect(normalizeLimitPrice('US', 'sell', '185.561')).toBe('185.57');
    expect(normalizeLimitPrice('US', 'buy', '185.5')).toBe('185.5');
    expect(normalizeLimitPrice('US', 'buy', '0.123456')).toBe('0.1234');
    expect(normalizeLimitPrice('US', 'sell', '0.123456')).toBe('0.1235');
    expect(normalizeLimitPrice('US', 'sell', '0.99999')).toBe('1');
    expect(normalizeLimitPrice('US', 'buy', '12')).toBe('12');
  });
  it('refuses non-positive, non-finite, exponent and malformed prices', () => {
    for (const bad of [0, -1, NaN, Infinity, 1e21, '', 'abc', '-5', '1e5', '0.00001'])
      expect(normalizeLimitPrice('US', 'buy', bad as never)).toBeNull();
    expect(normalizeLimitPrice('KR', 'buy', '0.4')).toBeNull();
  });
});

describe('placeOrder request shape', () => {
  it('sends exactly the documented LIMIT + DAY quantity-based fields', async () => {
    const { fake, client } = setup();
    const result = await client.placeOrder(krBuy());
    expect(result).toMatchObject({
      outcome: 'accepted',
      clientOrderId: 'ai-test-0001',
      attempts: 1,
      tickCorrected: false,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({
      method: 'POST',
      path: '/api/v1/orders',
      body: {
        clientOrderId: 'ai-test-0001',
        symbol: '005930',
        side: 'BUY',
        orderType: 'LIMIT',
        timeInForce: 'DAY',
        quantity: '10',
        price: '70000',
      },
    });
  });
  it('never sends amount-based, market, other time-in-force or high-value fields', async () => {
    const { fake, client } = setup();
    await client.placeOrder(krBuy({ side: 'sell' }));
    const body = fake.calls[0].body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['clientOrderId', 'orderType', 'price', 'quantity', 'side', 'symbol', 'timeInForce'].sort(),
    );
    expect(body.side).toBe('SELL');
    expect('confirmHighValueOrder' in body).toBe(false);
    expect('orderAmount' in body).toBe(false);
  });
  it('US order: ticker, USD price', async () => {
    const { fake, client } = setup();
    const r = await client.placeOrder(
      krBuy({ market: 'US', symbol: 'AAPL', price: '185.5', quantity: 3 }),
    );
    expect(r.outcome).toBe('accepted');
    expect(fake.calls[0].body).toMatchObject({ symbol: 'AAPL', price: '185.5', quantity: '3' });
  });
  it.each([
    ['fractional quantity', { quantity: 1.5 }],
    ['zero quantity', { quantity: 0 }],
    ['negative quantity', { quantity: -3 }],
    ['unsafe quantity', { quantity: 2 ** 60 }],
    ['non-normalized KR price', { price: '70000.5' }],
    ['numeric-looking price with exponent', { price: '7e4' }],
    ['zero price', { price: '0' }],
    ['lowercase KR symbol', { symbol: '00593a' }],
    ['5-digit KR symbol', { symbol: '05930' }],
    ['symbol with path characters', { symbol: '../etc' }],
    ['missing client order id', { clientOrderId: '' }],
    ['too long client order id', { clientOrderId: 'a'.repeat(37) }],
    ['client order id with spaces', { clientOrderId: 'bad id' }],
    ['unknown side', { side: 'short' as never }],
    ['unknown market', { market: 'JP' as never }],
  ])('refuses %s before anything is sent', async (_name, over) => {
    const { fake, client } = setup();
    await expect(
      client.placeOrder(krBuy(over as Partial<PlaceOrderRequest>)),
    ).rejects.toBeInstanceOf(OrderInputError);
    expect(fake.calls).toHaveLength(0);
  });
  it('refuses a US price that is not in the documented scale', async () => {
    const { fake, client } = setup();
    await expect(
      client.placeOrder(krBuy({ market: 'US', symbol: 'AAPL', price: '185.567' })),
    ).rejects.toBeInstanceOf(OrderInputError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('idempotent retries', () => {
  it('network errors are retried with the SAME clientOrderId, at most 2 retries', async () => {
    const { fake, client, sleeps } = setup();
    fake.postScript = [{ kind: 'network' }, { kind: 'network' }];
    const result = await client.placeOrder(krBuy());
    expect(result).toMatchObject({ outcome: 'accepted', attempts: 3 });
    const ids = fake.calls.map((c) => (c.body as { clientOrderId: string }).clientOrderId);
    expect(ids).toEqual(['ai-test-0001', 'ai-test-0001', 'ai-test-0001']);
    expect(sleeps).toEqual([500, 1000]);
    expect(fake.orders).toHaveLength(1);
  });
  it('a request whose response was lost is not duplicated by the retry', async () => {
    const { fake, client } = setup();
    fake.postScript = [{ kind: 'network', thenCreate: true }];
    const result = await client.placeOrder(krBuy());
    expect(result).toMatchObject({ outcome: 'accepted', attempts: 2 });
    expect(fake.orders).toHaveLength(1); // the provider replayed the first result for the same key
    expect(fake.placeCount()).toBe(2);
  });
  it('gives up after 3 attempts total and reports the outcome as unknown', async () => {
    const { fake, client } = setup();
    fake.postScript = [
      { kind: 'network' },
      { kind: 'network' },
      { kind: 'network' },
      { kind: 'network' },
    ];
    const result = await client.placeOrder(krBuy());
    expect(result).toMatchObject({
      outcome: 'unknown',
      attempts: 3,
      error: { kind: 'network', code: 'network-error' },
    });
    expect(fake.placeCount()).toBe(3);
    expect(fake.postScript).toHaveLength(1);
  });
  it.each([500, 502, 503])(
    'retries HTTP %i with the same key, then reports unknown',
    async (status) => {
      const { fake, client } = setup();
      fake.postScript = Array.from({ length: 5 }, () => ({
        kind: 'status' as const,
        status,
        code: 'internal-error',
      }));
      const result = await client.placeOrder(krBuy());
      expect(result).toMatchObject({ outcome: 'unknown', attempts: 3 });
      expect(
        new Set(fake.calls.map((c) => (c.body as { clientOrderId: string }).clientOrderId)).size,
      ).toBe(1);
    },
  );
  it('429 is retried (honouring Retry-After, capped) and can succeed', async () => {
    const { fake, client, sleeps } = setup();
    fake.postScript = [{ kind: 'status', status: 429, code: 'rate-limit-exceeded', retryAfter: 2 }];
    const result = await client.placeOrder(krBuy());
    expect(result).toMatchObject({ outcome: 'accepted', attempts: 2 });
    expect(sleeps).toEqual([2000]);
    const capped = setup();
    capped.fake.postScript = [
      { kind: 'status', status: 429, code: 'rate-limit-exceeded', retryAfter: 3600 },
    ];
    await capped.client.placeOrder(krBuy());
    expect(capped.sleeps).toEqual([30_000]);
  });
  it('429 on every attempt proves nothing was created: rejected, not unknown', async () => {
    const { fake, client } = setup();
    fake.postScript = Array.from({ length: 3 }, () => ({
      kind: 'status' as const,
      status: 429,
      code: 'rate-limit-exceeded',
    }));
    const result = await client.placeOrder(krBuy());
    expect(result).toMatchObject({ outcome: 'rejected', attempts: 3, error: { status: 429 } });
  });
  it('429 after an ambiguous attempt stays unknown', async () => {
    const { fake, client } = setup();
    fake.postScript = [
      { kind: 'network' },
      { kind: 'status', status: 429, code: 'rate-limit-exceeded' },
      { kind: 'status', status: 429, code: 'rate-limit-exceeded' },
    ];
    expect(await client.placeOrder(krBuy())).toMatchObject({ outcome: 'unknown' });
  });
  it.each([
    [400, 'invalid-request'],
    [401, 'invalid-token'],
    [403, 'forbidden'],
    [404, 'order-not-found'],
    [409, 'opposite-pending-order-exists'],
    [422, 'insufficient-buying-power'],
    [422, 'stock-restricted'],
  ])('never retries HTTP %i %s', async (status, code) => {
    const { fake, client, sleeps } = setup();
    fake.postScript = [{ kind: 'status', status, code }];
    const result = await client.placeOrder(krBuy());
    expect(result).toMatchObject({ outcome: 'rejected', attempts: 1, error: { status, code } });
    expect(fake.placeCount()).toBe(1);
    expect(sleeps).toEqual([]);
  });
  it('codes that mean an earlier request with this key may exist are unknown, not rejected', async () => {
    for (const [status, code] of [
      [409, 'request-in-progress'],
      [422, 'idempotency-key-conflict'],
    ] as const) {
      const { fake, client } = setup();
      fake.postScript = [{ kind: 'status', status, code }];
      const result = await client.placeOrder(krBuy());
      expect(result.outcome).toBe('unknown');
      expect(fake.placeCount()).toBe(1);
    }
  });
  it('does not retry once the idempotency window is nearly spent', async () => {
    let clock = 1_000_000;
    const { fake, client } = setup({ now: () => clock });
    fake.postScript = [{ kind: 'status', status: 500, code: 'internal-error' }];
    // The first failure arrives after 9 minutes: the key would expire before a retry lands.
    const original = fake.send.bind(fake);
    fake.send = async (r: TransportRequest) => {
      const response = await original(r);
      clock += 9 * 60 * 1000;
      return response;
    };
    const result = await client.placeOrder(krBuy());
    expect(result).toMatchObject({ outcome: 'unknown', attempts: 1 });
    expect(fake.placeCount()).toBe(1);
    expect(IDEMPOTENCY_WINDOW_MS).toBe(600_000);
  });
  it('a transport that throws a non-network error is treated as an unknown outcome with a sanitized code', async () => {
    const transport: OrderTransport = {
      send: async () => {
        throw new Error('Bearer secret-token-abc account 1234567890');
      },
    };
    const client = new TossOrderClient(transport, { sleep: async () => undefined });
    const result = await client.placeOrder(krBuy());
    expect(result.outcome).toBe('unknown');
    expect(JSON.stringify(result)).not.toMatch(/secret|1234567890|Bearer/);
  });
  it('caps retries at 2 even if configured higher', async () => {
    const fake = new FakeToss();
    const client = new TossOrderClient(fake, { maxRetries: 50, sleep: async () => undefined });
    fake.postScript = Array.from({ length: 10 }, () => ({ kind: 'network' as const }));
    await client.placeOrder(krBuy());
    expect(fake.placeCount()).toBe(3);
  });
});

describe('tick-size correction (no hardcoded KRX table)', () => {
  const buy = krBuy({ price: '50050', clientOrderId: 'ai-tick-0001' });
  it('buy: rounds down to the lower nearest price once and resends with a derived key', async () => {
    const { fake, client } = setup();
    const seen: string[] = [];
    const result = await client.placeOrder(buy, {
      onPriceCorrection: (p) => {
        seen.push(p);
        return true;
      },
    });
    expect(seen).toEqual(['50000']);
    expect(result).toMatchObject({
      outcome: 'accepted',
      tickCorrected: true,
      price: '50000',
      clientOrderId: 'ai-tick-0001-t1',
      attempts: 2,
    });
    expect(fake.calls.map((c) => (c.body as { price: string }).price)).toEqual(['50050', '50000']);
    expect(fake.orders).toHaveLength(1);
  });
  it('sell: rounds up to the upper nearest price', async () => {
    const { fake, client } = setup();
    const result = await client.placeOrder(
      { ...buy, side: 'sell' },
      { onPriceCorrection: () => true },
    );
    expect(result).toMatchObject({ outcome: 'accepted', price: '50100', tickCorrected: true });
    expect(fake.orders[0].price).toBe('50100');
  });
  it('is declined without a veto callback or when the veto says no: no resend', async () => {
    const a = setup();
    expect(await a.client.placeOrder(buy)).toMatchObject({
      outcome: 'rejected',
      error: { code: 'tick-correction-declined' },
    });
    expect(a.fake.placeCount()).toBe(1);
    const b = setup();
    expect(await b.client.placeOrder(buy, { onPriceCorrection: async () => false })).toMatchObject({
      outcome: 'rejected',
    });
    expect(b.fake.placeCount()).toBe(1);
    const c = setup();
    expect(
      await c.client.placeOrder(buy, {
        onPriceCorrection: () => {
          throw new Error('boom');
        },
      }),
    ).toMatchObject({ outcome: 'rejected', error: { code: 'tick-correction-declined' } });
    expect(c.fake.placeCount()).toBe(1);
  });
  it('corrects only once: a second tick rejection is final', async () => {
    const { fake, client } = setup();
    fake.tickSize = () => 100; // corrected price still off a (different) tick the second time
    fake.postScript = [
      {
        kind: 'status',
        status: 400,
        code: 'invalid-request',
        data: { field: 'price', tickSize: '100', nearestPrices: ['50000', '50100'] },
      },
      {
        kind: 'status',
        status: 400,
        code: 'invalid-request',
        data: { field: 'price', tickSize: '100', nearestPrices: ['49900', '50000'] },
      },
    ];
    const result = await client.placeOrder(buy, { onPriceCorrection: () => true });
    expect(result.outcome).toBe('rejected');
    expect(fake.placeCount()).toBe(2);
  });
  it('is rejected without a resend when the tick data is missing or inconsistent', async () => {
    const cases: Array<Record<string, unknown> | undefined> = [
      undefined,
      { field: 'price' },
      { field: 'price', tickSize: '100', nearestPrices: ['50000'] },
      { field: 'price', tickSize: '100', nearestPrices: ['50100', '50000'] },
      { field: 'price', tickSize: '100', nearestPrices: ['50060', '50160'] }, // does not bracket 50050
      { field: 'price', tickSize: '10', nearestPrices: ['50000', '50100'] }, // wider than one tick
      { field: 'price', tickSize: '100', nearestPrices: ['50000.5', '50100'] },
      { field: 'quantity', tickSize: '100', nearestPrices: ['50000', '50100'] },
    ];
    for (const data of cases) {
      const { fake, client } = setup();
      fake.postScript = [
        { kind: 'status', status: 400, code: 'invalid-request', ...(data ? { data } : {}) },
      ];
      const result = await client.placeOrder(buy, { onPriceCorrection: () => true });
      expect(result.outcome).toBe('rejected');
      expect(fake.placeCount()).toBe(1);
    }
  });
  it('US orders are never tick-corrected (scale rule is applied before sending)', async () => {
    const { fake, client } = setup();
    fake.postScript = [
      {
        kind: 'status',
        status: 400,
        code: 'invalid-request',
        data: { field: 'price', tickSize: '0.01', nearestPrices: ['185.5', '185.51'] },
      },
    ];
    const result = await client.placeOrder(
      krBuy({ market: 'US', symbol: 'AAPL', price: '185.5' }),
      { onPriceCorrection: () => true },
    );
    expect(result.outcome).toBe('rejected');
    expect(fake.placeCount()).toBe(1);
  });
  it('tickCorrection helper: less aggressive side only', () => {
    const body = (near: string[], tick = '100') => ({
      error: {
        code: 'invalid-request',
        data: { field: 'price', tickSize: tick, nearestPrices: near },
      },
    });
    expect(tickCorrection('KR', 'buy', '50050', body(['50000', '50100']))).toBe('50000');
    expect(tickCorrection('KR', 'sell', '50050', body(['50000', '50100']))).toBe('50100');
    expect(tickCorrection('US', 'buy', '50050', body(['50000', '50100']))).toBeNull();
  });
});

describe('strict response validation and sanitized errors', () => {
  it('a 200 without a valid orderId or with a foreign clientOrderId is unknown (order may exist)', async () => {
    for (const body of [
      { result: {} },
      { result: { orderId: '' } },
      { result: { orderId: 'bad id with spaces', clientOrderId: 'ai-test-0001' } },
      { result: { orderId: 'ok-id', clientOrderId: 'someone-else' } },
      { result: { orderId: 'ok-id' } },
      { result: [] },
      {},
      null,
    ]) {
      const transport: OrderTransport = { send: async () => ({ status: 200, body }) };
      const result = await new TossOrderClient(transport).placeOrder(krBuy());
      expect(result).toMatchObject({ outcome: 'unknown', error: { code: 'response-invalid' } });
    }
  });
  it('statuses outside the documented contract are unknown, not accepted or rejected', async () => {
    for (const status of [201, 204, 302, 0, 1.5]) {
      const transport: OrderTransport = { send: async () => ({ status, body: {} }) };
      expect((await new TossOrderClient(transport).placeOrder(krBuy())).outcome).toBe('unknown');
    }
  });
  it('errors carry only status, a validated code and request id: no message text, data or account ids', async () => {
    const { fake, client } = setup();
    fake.postScript = [
      {
        kind: 'status',
        status: 422,
        code: 'insufficient-buying-power',
        data: { account: '1234567890', note: SECRET_TEXT },
      },
    ];
    const result = await client.placeOrder(krBuy());
    expect(result).toMatchObject({
      outcome: 'rejected',
      error: {
        kind: 'http',
        status: 422,
        code: 'insufficient-buying-power',
        requestId: 'req-test-0001',
      },
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain(SECRET_TEXT);
    expect(text).not.toContain('1234567890');
    expect(Object.keys((result as { error: object }).error).sort()).toEqual([
      'code',
      'kind',
      'requestId',
      'status',
    ]);
  });
  it('rejects hostile or malformed error codes and request ids', async () => {
    const transport: OrderTransport = {
      send: async () => ({
        status: 422,
        body: {
          error: { code: 'Bearer abc <script>', requestId: 'x'.repeat(200), message: SECRET_TEXT },
        },
      }),
    };
    const result = await new TossOrderClient(transport).placeOrder(krBuy());
    expect(result).toMatchObject({ outcome: 'rejected', error: { code: 'http-422' } });
    expect(JSON.stringify(result)).not.toMatch(/script|Bearer|xxxx/);
  });
  it('describeOrderError gives Korean text from the code only', () => {
    expect(
      describeOrderError({ kind: 'http', status: 422, code: 'insufficient-buying-power' }),
    ).toContain('부족');
    expect(describeOrderError({ kind: 'http', status: 418, code: 'teapot' })).toContain('HTTP 418');
    expect(describeOrderError({ kind: 'network', status: null, code: 'weird' })).not.toContain(
      'weird',
    );
  });
});

describe('read endpoints', () => {
  it('lists OPEN orders and parses the documented shape', async () => {
    const { fake, client } = setup();
    await client.placeOrder(krBuy());
    const page = await client.listOrders({ status: 'OPEN', symbol: '005930' });
    expect(page).toMatchObject({ hasNext: false, nextCursor: null });
    expect(page.orders[0]).toMatchObject({
      symbol: '005930',
      side: 'buy',
      status: 'PENDING',
      quantity: '10',
      filledQuantity: '0',
    });
    expect(fake.calls.at(-1)).toEqual({
      method: 'GET',
      path: '/api/v1/orders',
      query: { status: 'OPEN', symbol: '005930' },
    });
  });
  it('OPEN with hasNext=true is not trustworthy', async () => {
    const transport: OrderTransport = {
      send: async () => ({
        status: 200,
        body: { result: { orders: [], nextCursor: 'abc', hasNext: true } },
      }),
    };
    await expect(
      new TossOrderClient(transport).listOrders({ status: 'OPEN' }),
    ).rejects.toBeInstanceOf(OrderApiError);
  });
  it('tolerates unknown status/side codes but not malformed fields', async () => {
    const order = {
      orderId: 'o1',
      symbol: '005930',
      side: 'BUY',
      orderType: 'LIMIT',
      timeInForce: 'DAY',
      status: 'NEW_STATE',
      price: '70000',
      quantity: '1',
      orderAmount: null,
      currency: 'KRW',
      orderedAt: '2026-10-21T09:30:00.000+09:00',
      canceledAt: null,
      execution: {
        filledQuantity: '0',
        averageFilledPrice: null,
        filledAmount: null,
        commission: null,
        tax: null,
        filledAt: null,
        settlementDate: null,
      },
    };
    const ok: OrderTransport = {
      send: async () => ({
        status: 200,
        body: { result: { orders: [order], nextCursor: null, hasNext: false } },
      }),
    };
    expect((await new TossOrderClient(ok).listOrders({ status: 'OPEN' })).orders[0].status).toBe(
      'NEW_STATE',
    );
    for (const mutate of [
      (o: typeof order) => ({ ...o, quantity: 'ten' }),
      (o: typeof order) => ({ ...o, orderedAt: 'yesterday' }),
      (o: typeof order) => ({ ...o, execution: { ...o.execution, filledQuantity: -1 } }),
      (o: typeof order) => ({ ...o, orderId: '' }),
      (o: typeof order) => ({ ...o, symbol: 'a b' }),
      (o: typeof order) => ({ ...o, execution: undefined }),
    ]) {
      const bad: OrderTransport = {
        send: async () => ({
          status: 200,
          body: { result: { orders: [mutate(order)], nextCursor: null, hasNext: false } },
        }),
      };
      await expect(new TossOrderClient(bad).listOrders({ status: 'OPEN' })).rejects.toMatchObject({
        info: { code: 'response-invalid' },
      });
    }
  });
  it('CLOSED accepts limit and cursor; OPEN ignores them', async () => {
    const { fake, client } = setup();
    await client.listOrders({ status: 'CLOSED', limit: 50, cursor: 'abc_-=' });
    await client.listOrders({ status: 'OPEN', limit: 50, cursor: 'abc' });
    expect(fake.calls[0].query).toEqual({ status: 'CLOSED', limit: '50', cursor: 'abc_-=' });
    expect(fake.calls[1].query).toEqual({ status: 'OPEN' });
    await expect(client.listOrders({ status: 'CLOSED', limit: 101 })).rejects.toBeInstanceOf(
      OrderInputError,
    );
  });
  it('getOrder percent-encodes the opaque id and 404 is a sanitized error', async () => {
    const { fake, client } = setup();
    await expect(client.getOrder('missing-id')).rejects.toMatchObject({
      info: { status: 404, code: 'order-not-found' },
    });
    await expect(client.getOrder('../cancel')).rejects.toBeInstanceOf(OrderInputError);
    expect(fake.calls).toHaveLength(1);
  });
  it('buying power, sellable quantity, commissions, warnings and price limits parse and validate', async () => {
    const { fake, client } = setup();
    fake.sellable.set('005930', '12');
    fake.warnings.set('005930', [
      { warningType: 'OVERHEATED', exchange: 'KRX', startDate: '2026-10-01', endDate: null },
    ]);
    fake.priceLimits.set('005930', { upper: '91000', lower: '49000', currency: 'KRW' });
    expect(await client.getBuyingPower('KRW')).toEqual({
      currency: 'KRW',
      cashBuyingPower: '100000000',
    });
    expect(await client.getSellableQuantity('005930')).toEqual({ sellableQuantity: '12' });
    expect((await client.getCommissions())[0]).toMatchObject({
      marketCountry: 'KR',
      commissionRate: '0.00015',
    });
    expect(await client.getStockWarnings('005930')).toEqual([
      { warningType: 'OVERHEATED', exchange: 'KRX', startDate: '2026-10-01', endDate: null },
    ]);
    expect(await client.getPriceLimits('005930')).toMatchObject({
      upperLimitPrice: '91000',
      lowerLimitPrice: '49000',
      currency: 'KRW',
    });
    expect(fake.calls.every((c) => c.method === 'GET')).toBe(true);
  });
  it('rejects malformed read responses', async () => {
    const { fake, client } = setup();
    fake.malformed = new Set([
      '/api/v1/buying-power',
      '/api/v1/commissions',
      '/api/v1/price-limits',
    ]);
    await expect(client.getBuyingPower('KRW')).rejects.toMatchObject({
      info: { code: 'response-invalid' },
    });
    await expect(client.getCommissions()).rejects.toMatchObject({
      info: { code: 'response-invalid' },
    });
    await expect(client.getPriceLimits('005930')).rejects.toMatchObject({
      info: { code: 'response-invalid' },
    });
    const wrongCurrency: OrderTransport = {
      send: async () => ({
        status: 200,
        body: { result: { currency: 'USD', cashBuyingPower: '1' } },
      }),
    };
    await expect(new TossOrderClient(wrongCurrency).getBuyingPower('KRW')).rejects.toMatchObject({
      info: { code: 'response-invalid' },
    });
    const negative: OrderTransport = {
      send: async () => ({
        status: 200,
        body: { result: { currency: 'KRW', cashBuyingPower: '-5' } },
      }),
    };
    await expect(new TossOrderClient(negative).getBuyingPower('KRW')).rejects.toBeInstanceOf(
      OrderApiError,
    );
  });
  it('401/403/429/5xx reads throw sanitized errors and are not retried', async () => {
    for (const [status, code] of [
      [401, 'expired-token'],
      [403, 'forbidden'],
      [429, 'rate-limit-exceeded'],
      [500, 'internal-error'],
    ] as const) {
      const { fake, client } = setup();
      fake.getFailures.set('/api/v1/commissions', { status, code });
      await expect(client.getCommissions()).rejects.toMatchObject({
        info: { status, code, requestId: 'req-test-0001' },
      });
      expect(fake.calls).toHaveLength(1);
    }
  });
  it('a network failure on a read is a sanitized network error', async () => {
    const transport: OrderTransport = {
      send: async () => {
        throw new TransportNetworkError();
      },
    };
    await expect(new TossOrderClient(transport).getCommissions()).rejects.toMatchObject({
      info: { kind: 'network', code: 'network-error' },
    });
  });
  it('cancel posts to the encoded cancel path once, without retries', async () => {
    const { fake, client } = setup();
    const placed = await client.placeOrder(krBuy());
    if (placed.outcome !== 'accepted') throw new Error('setup');
    const cancelled = await client.cancelOrder(placed.orderId);
    expect(cancelled.orderId).toContain(placed.orderId);
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: `/api/v1/orders/${placed.orderId}/cancel`,
    });
    fake.postScript = [{ kind: 'status', status: 500, code: 'internal-error' }];
    await expect(client.cancelOrder(placed.orderId)).rejects.toBeInstanceOf(OrderApiError);
    expect(fake.calls.filter((c) => c.path.endsWith('/cancel'))).toHaveLength(2);
  });
});

// Keep the type imports honest.
export type _Unused = TransportResponse;
