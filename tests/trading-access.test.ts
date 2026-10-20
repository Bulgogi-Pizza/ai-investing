import { describe, expect, it } from 'vitest';
import { checkOrderAccess } from '../src/server/trading/access-check';
import {
  TossOrderClient,
  TransportNetworkError,
  type OrderTransport,
  type TransportRequest,
} from '../src/server/trading/toss-orders';
import { FakeToss, NOW } from '../src/server/trading/testing';

const clientFor = (fake: FakeToss) => new TossOrderClient(fake, { sleep: async () => undefined });

describe('checkOrderAccess (read-only permission probe)', () => {
  it('calls only buying-power KRW/USD, commissions and OPEN orders, all GET', async () => {
    const fake = new FakeToss();
    const report = await checkOrderAccess(clientFor(fake), () => NOW);
    expect(fake.calls).toEqual([
      { method: 'GET', path: '/api/v1/buying-power', query: { currency: 'KRW' } },
      { method: 'GET', path: '/api/v1/buying-power', query: { currency: 'USD' } },
      { method: 'GET', path: '/api/v1/commissions' },
      { method: 'GET', path: '/api/v1/orders', query: { status: 'OPEN' } },
    ]);
    expect(report).toEqual({
      checkedAt: NOW.toISOString(),
      buyingPowerKrw: { ok: true },
      buyingPowerUsd: { ok: true },
      commissions: { ok: true },
      openOrders: { ok: true },
      allOk: true,
      permissionDenied: false,
    });
  });

  it('never sends a POST, whatever the answers are', async () => {
    const methods: string[] = [];
    const scenarios: Array<(fake: FakeToss) => void> = [
      () => undefined,
      (f) => f.getFailures.set('/api/v1/commissions', { status: 403, code: 'forbidden' }),
      (f) => f.getFailures.set('/api/v1/orders', { status: 401, code: 'invalid-token' }),
      (f) => f.getFailures.set('/api/v1/buying-power', { status: 500, code: 'internal-error' }),
      (f) => f.malformed.add('/api/v1/orders'),
    ];
    for (const scenario of scenarios) {
      const fake = new FakeToss();
      scenario(fake);
      const spy: OrderTransport = {
        send: async (r: TransportRequest) => {
          methods.push(r.method);
          return fake.send(r);
        },
      };
      await checkOrderAccess(new TossOrderClient(spy));
    }
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set(['GET']));
  });

  it('a transport that refuses POST outright is never asked to POST', async () => {
    const transport: OrderTransport = {
      send: async (r) => {
        if (r.method !== 'GET') throw new Error('POST attempted by the access check');
        return new FakeToss().send(r);
      },
    };
    const report = await checkOrderAccess(new TossOrderClient(transport));
    expect(report.allOk).toBe(true);
  });

  it('reports a permission refusal with sanitized codes and no payload', async () => {
    const fake = new FakeToss();
    fake.getFailures.set('/api/v1/orders', { status: 403, code: 'forbidden' });
    fake.getFailures.set('/api/v1/commissions', { status: 401, code: 'expired-token' });
    const report = await checkOrderAccess(clientFor(fake), () => NOW);
    expect(report).toMatchObject({
      buyingPowerKrw: { ok: true },
      buyingPowerUsd: { ok: true },
      commissions: { ok: false, code: 'expired-token', status: 401 },
      openOrders: { ok: false, code: 'forbidden', status: 403 },
      allOk: false,
      permissionDenied: true,
    });
  });

  it('distinguishes network failures and malformed answers from refusals', async () => {
    const fake = new FakeToss();
    fake.malformed.add('/api/v1/commissions');
    const flaky: OrderTransport = {
      send: async (r) => {
        if (r.query?.currency === 'USD') throw new TransportNetworkError();
        return fake.send(r);
      },
    };
    const report = await checkOrderAccess(new TossOrderClient(flaky));
    expect(report.buyingPowerUsd).toEqual({ ok: false, code: 'network-error', status: null });
    expect(report.commissions).toEqual({ ok: false, code: 'response-invalid', status: null });
    expect(report.allOk).toBe(false);
    expect(report.permissionDenied).toBe(false);
  });

  it('never returns amounts, rates, order data, account ids or raw provider text', async () => {
    const fake = new FakeToss();
    fake.buyingPower.KRW = '123456789';
    fake.buyingPower.USD = '98765.43';
    fake.orders.push({
      orderId: 'secret-order-id',
      clientOrderId: null,
      symbol: '005930',
      side: 'BUY',
      orderType: 'LIMIT',
      timeInForce: 'DAY',
      status: 'PENDING',
      price: '70000',
      quantity: '10',
      currency: 'KRW',
      orderedAt: NOW.toISOString(),
      filledQuantity: '0',
      averageFilledPrice: null,
    });
    const text = JSON.stringify(await checkOrderAccess(clientFor(fake), () => NOW));
    for (const leak of [
      '123456789',
      '98765',
      'secret-order-id',
      '005930',
      '0.00015',
      'req-test-0001',
      'must never be stored',
    ])
      expect(text).not.toContain(leak);
    fake.getFailures.set('/api/v1/commissions', { status: 500, code: 'internal-error' });
    expect(JSON.stringify(await checkOrderAccess(clientFor(fake)))).not.toContain(
      'must never be stored',
    );
  });

  it('an unexpected exception from the api becomes a fixed code, never its message', async () => {
    const report = await checkOrderAccess({
      getBuyingPower: async () => {
        throw new Error('Bearer abc.def account=1234567890');
      },
      getCommissions: async () => [],
      listOrders: async () => ({ orders: [], nextCursor: null, hasNext: false }),
    });
    expect(report.buyingPowerKrw).toEqual({ ok: false, code: 'check-error', status: null });
    expect(JSON.stringify(report)).not.toMatch(/Bearer|1234567890/);
  });

  it('the api parameter type exposes no write method (compile-time guarantee)', () => {
    // If a write method were part of the parameter type this would not compile with only reads.
    const readsOnly = {
      getBuyingPower: async () => ({ currency: 'KRW' as const, cashBuyingPower: '1' }),
      getCommissions: async () => [],
      listOrders: async () => ({ orders: [], nextCursor: null, hasNext: false }),
    };
    return expect(checkOrderAccess(readsOnly)).resolves.toMatchObject({ allOk: true });
  });
});
