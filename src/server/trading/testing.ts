import { addSample, createBucketStats, type BucketStats } from '../../lib/algo/index.js';
import type { PreTradeAlgorithm, PreTradeMarketFacts } from './pre-trade.js';
import {
  kstDateKey,
  type LiveOrderRecord,
  type LiveOrderStatus,
  type TradingStore,
} from './stores.js';
import {
  TransportNetworkError,
  type OrderTransport,
  type TransportRequest,
  type TransportResponse,
} from './toss-orders.js';

/**
 * TEST SUPPORT ONLY. A fake Toss server behind the `OrderTransport` port, shaped after the
 * official spec v1.2.24 (response envelopes, error codes, idempotency, KR tick-size 400). Tests use
 * it exclusively: no real order is ever placed by anything in this repository's tests. Not
 * imported by production code.
 */
export type FakeOrder = {
  orderId: string;
  clientOrderId: string | null;
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: string;
  timeInForce: string;
  status: string;
  price: string | null;
  quantity: string;
  currency: 'KRW' | 'USD';
  orderedAt: string;
  filledQuantity: string;
  averageFilledPrice: string | null;
};

export type Scripted =
  | { kind: 'network'; thenCreate?: boolean }
  | {
      kind: 'status';
      status: number;
      code: string;
      data?: Record<string, unknown>;
      retryAfter?: number;
    };

export class FakeToss implements OrderTransport {
  /** Every request received, in order. Bodies are the parsed JSON the client sent. */
  readonly calls: TransportRequest[] = [];
  readonly orders: FakeOrder[] = [];
  buyingPower: Record<'KRW' | 'USD', string | null> = { KRW: '100000000', USD: '100000' };
  sellable = new Map<string, string>();
  commissions: Array<Record<string, unknown>> = [
    { marketCountry: 'KR', commissionRate: '0.00015', startDate: null, endDate: null },
    { marketCountry: 'US', commissionRate: '0.0025', startDate: null, endDate: null },
  ];
  warnings = new Map<string, Array<Record<string, unknown>>>();
  priceLimits = new Map<string, { upper: string | null; lower: string | null; currency: string }>();
  /** Scripted responses for POST /orders, consumed one per request. */
  postScript: Scripted[] = [];
  /** Failures for GETs keyed by path. */
  getFailures = new Map<string, { status: number; code: string }>();
  /** Runs after an order is created (used to flip control flags between orders). */
  onCreated?: (order: FakeOrder) => void;
  malformed = new Set<string>();
  now = () => Date.now();
  private seq = 0;
  private readonly idempotency = new Map<string, { at: number; body: string; orderId: string }>();

  /** KR tick: 100 won from 50,000, 10 won below (a stand-in, NOT the real KRX table). */
  tickSize = (price: number) => (price >= 50_000 ? 100 : 10);

  private ok(result: unknown): TransportResponse {
    return { status: 200, body: { result } };
  }
  private fail(
    status: number,
    code: string,
    data?: Record<string, unknown>,
    retryAfter?: number,
  ): TransportResponse {
    return {
      status,
      body: {
        error: {
          requestId: 'req-test-0001',
          code,
          message: 'text that must never be stored',
          ...(data ? { data } : {}),
        },
      },
      ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
    };
  }

  postCount() {
    return this.calls.filter((c) => c.method === 'POST').length;
  }
  placeCount() {
    return this.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/orders').length;
  }

  async send(request: TransportRequest): Promise<TransportResponse> {
    this.calls.push(structuredClone(request));
    if (request.method === 'POST') return this.post(request);
    const failure = this.getFailures.get(request.path);
    if (failure) return this.fail(failure.status, failure.code);
    if (this.malformed.has(request.path)) return this.ok({ unexpected: true });
    const q = request.query ?? {};
    switch (true) {
      case request.path === '/api/v1/orders': {
        const open = ['PENDING', 'PARTIAL_FILLED', 'PENDING_CANCEL', 'PENDING_REPLACE'];
        const list = this.orders
          .filter((o) => (q.status === 'OPEN' ? open.includes(o.status) : !open.includes(o.status)))
          .filter((o) => !q.symbol || o.symbol === q.symbol)
          .map((o) => this.view(o));
        return this.ok({ orders: list, nextCursor: null, hasNext: false });
      }
      case request.path.startsWith('/api/v1/orders/'): {
        const id = decodeURIComponent(request.path.split('/')[4]);
        const found = this.orders.find((o) => o.orderId === id);
        return found ? this.ok(this.view(found)) : this.fail(404, 'order-not-found');
      }
      case request.path === '/api/v1/buying-power': {
        const cash = this.buyingPower[q.currency as 'KRW' | 'USD'];
        return cash === null || cash === undefined
          ? this.fail(400, 'invalid-request')
          : this.ok({ currency: q.currency, cashBuyingPower: cash });
      }
      case request.path === '/api/v1/sellable-quantity':
        return this.ok({ sellableQuantity: this.sellable.get(q.symbol) ?? '0' });
      case request.path === '/api/v1/commissions':
        return this.ok(this.commissions);
      case request.path.endsWith('/warnings'):
        return this.ok(this.warnings.get(request.path.split('/')[4]) ?? []);
      case request.path === '/api/v1/price-limits': {
        const l = this.priceLimits.get(q.symbol);
        return this.ok({
          timestamp: new Date(this.now()).toISOString(),
          upperLimitPrice: l?.upper ?? null,
          lowerLimitPrice: l?.lower ?? null,
          currency: l?.currency ?? 'KRW',
        });
      }
      default:
        return this.fail(404, 'not-found');
    }
  }

  private view(o: FakeOrder) {
    return {
      orderId: o.orderId,
      symbol: o.symbol,
      side: o.side,
      orderType: o.orderType,
      timeInForce: o.timeInForce,
      status: o.status,
      price: o.price,
      quantity: o.quantity,
      orderAmount: null,
      currency: o.currency,
      orderedAt: o.orderedAt,
      canceledAt: null,
      execution: {
        filledQuantity: o.filledQuantity,
        averageFilledPrice: o.averageFilledPrice,
        filledAmount: null,
        commission: null,
        tax: null,
        filledAt: null,
        settlementDate: null,
      },
    };
  }

  private create(body: Record<string, unknown>): FakeOrder {
    const order: FakeOrder = {
      orderId: `order-${++this.seq}-fake_token`,
      clientOrderId: (body.clientOrderId as string) ?? null,
      symbol: body.symbol as string,
      side: body.side as 'BUY' | 'SELL',
      orderType: body.orderType as string,
      timeInForce: body.timeInForce as string,
      status: 'PENDING',
      price: (body.price as string) ?? null,
      quantity: body.quantity as string,
      currency: /^[0-9A-Z]{6}$/.test(body.symbol as string) ? 'KRW' : 'USD',
      orderedAt: new Date(this.now()).toISOString(),
      filledQuantity: '0',
      averageFilledPrice: null,
    };
    this.orders.push(order);
    this.onCreated?.(order);
    return order;
  }

  private post(request: TransportRequest): TransportResponse {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const scripted = this.postScript.shift();
    if (scripted?.kind === 'network') {
      if (scripted.thenCreate) this.acceptIdempotent(body);
      throw new TransportNetworkError();
    }
    if (scripted?.kind === 'status')
      return this.fail(scripted.status, scripted.code, scripted.data, scripted.retryAfter);

    if (request.path.endsWith('/cancel')) {
      const id = decodeURIComponent(request.path.split('/')[4]);
      const found = this.orders.find((o) => o.orderId === id);
      if (!found) return this.fail(404, 'order-not-found');
      if (found.status === 'FILLED') return this.fail(409, 'already-filled');
      found.status = 'CANCELED';
      return this.ok({ orderId: `${id}-cx` });
    }

    // Documented validation (a subset sufficient for the tests).
    const allowed = new Set([
      'clientOrderId',
      'symbol',
      'side',
      'orderType',
      'timeInForce',
      'quantity',
      'price',
    ]);
    if (Object.keys(body).some((k) => !allowed.has(k))) return this.fail(400, 'invalid-request');
    if (body.orderType !== 'LIMIT')
      return this.fail(400, 'invalid-request', {
        field: 'orderType',
        allowedValues: ['LIMIT', 'MARKET'],
      });
    if (typeof body.quantity !== 'string' || !/^\d+$/.test(body.quantity) || body.quantity === '0')
      return this.fail(400, 'invalid-request', { field: 'quantity' });
    if (typeof body.price !== 'string' || !/^\d+(\.\d+)?$/.test(body.price))
      return this.fail(400, 'invalid-request', { field: 'price' });
    const isKr = /^[0-9A-Z]{6}$/.test(String(body.symbol));
    if (isKr) {
      const price = Number(body.price);
      const tick = this.tickSize(price);
      if (!Number.isInteger(price) || price % tick !== 0) {
        const lower = Math.floor(price / tick) * tick;
        return this.fail(400, 'invalid-request', {
          field: 'price',
          tickSize: String(tick),
          nearestPrices: [String(lower), String(lower + tick)],
        });
      }
    }
    return this.acceptIdempotent(body);
  }

  private acceptIdempotent(body: Record<string, unknown>): TransportResponse {
    const key = body.clientOrderId as string | undefined;
    const fingerprint = JSON.stringify(body);
    if (key) {
      const prior = this.idempotency.get(key);
      if (prior && this.now() - prior.at < 10 * 60 * 1000) {
        if (prior.body !== fingerprint) return this.fail(422, 'idempotency-key-conflict');
        return this.ok({ orderId: prior.orderId, clientOrderId: key });
      }
    }
    const order = this.create(body);
    if (key)
      this.idempotency.set(key, { at: this.now(), body: fingerprint, orderId: order.orderId });
    return this.ok({ orderId: order.orderId, clientOrderId: order.clientOrderId });
  }
}

// ---------------------------------------------------------------------------
// Shared fixtures.
// ---------------------------------------------------------------------------
/** Wednesday 2026-10-21 09:30 KST. */
export const NOW = new Date('2026-10-21T00:30:00.000Z');

/** Bucket statistics where `score` has `n` samples with mean gross return `meanReturn`. */
export function sampleStats(score = 0.5, meanReturn = 0.05, n = 25): BucketStats {
  const stats = createBucketStats();
  for (let i = 0; i < n; i++) addSample(stats, score, meanReturn);
  return stats;
}

export function krAlgorithm(overrides: Partial<PreTradeAlgorithm> = {}): PreTradeAlgorithm {
  return {
    id: 'algo-1',
    name: 'KR momentum',
    market: 'KR',
    budget: 1_000_000_000,
    usesValueSignal: false,
    ...overrides,
  };
}

export function krFacts(overrides: Partial<PreTradeMarketFacts> = {}): PreTradeMarketFacts {
  return {
    quote: { price: 70_000, observedAt: new Date(NOW.getTime() - 10_000).toISOString() },
    latestDailyBarDate: '2026-10-20',
    expectedDailyBarDate: '2026-10-20',
    avgTradedValue: 5_000_000_000,
    financialsPresent: true,
    fxMidRate: null,
    ...overrides,
  };
}

/** Weekdays strictly after `from` up to and including `to` (no holiday calendar in tests). */
export function weekdaysBetween(from: string, to: string): number {
  let count = 0;
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`) + 86_400_000; t <= end; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}
export const tradingDaysSinceFixture = (_market: string, from: string) =>
  weekdaysBetween(from, kstDateKey(NOW));

/**
 * Inserts an order record in a given lifecycle state through the store's own API (so the same
 * transition rules apply). Counters move only for the record's `dateKey`, so seed prior days to
 * keep today's counts untouched.
 */
export async function seedOrder(
  store: TradingStore,
  input: Partial<LiveOrderRecord> & { clientOrderId: string },
  target: LiveOrderStatus = 'filled',
): Promise<void> {
  const created = input.createdAt ?? '2026-10-14T01:00:00.000Z';
  const record: LiveOrderRecord = {
    algorithmId: 'algo-1',
    runId: 'seed-run',
    market: 'KR',
    symbol: '005930',
    side: 'buy',
    quantity: 10,
    price: '70000',
    currency: 'KRW',
    tranche: 0,
    dateKey: kstDateKey(new Date(created)),
    createdAt: created,
    updatedAt: created,
    filledQuantity: 0,
    ...input,
    status: 'reserved',
  };
  const reserved = await store.reserveOrder({ record, maxPerAlgorithm: 1000, maxGlobal: 1000 });
  if (!reserved.ok) throw new Error(`seed failed: ${reserved.reason}`);
  if (target === 'reserved') return;
  if (target === 'unknown' || target === 'rejected') {
    await store.updateOrder(record.clientOrderId, { status: target });
    return;
  }
  await store.updateOrder(record.clientOrderId, {
    status: 'accepted',
    orderId: `seed-${record.clientOrderId}`,
  });
  if (target === 'accepted') return;
  const filled = input.filledQuantity ?? (target === 'filled' ? record.quantity : 0);
  await store.updateOrder(record.clientOrderId, { status: target, filledQuantity: filled });
}
