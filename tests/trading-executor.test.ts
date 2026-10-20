import { describe, expect, it } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';
import type { NotificationEvent } from '../src/server/notify';
import {
  LiveOrderExecutor,
  mapProviderStatus,
  type Decision,
  type LiveRun,
  type RunDataProvider,
} from '../src/server/trading/executor';
import type { PreTradeMarketFacts } from '../src/server/trading/pre-trade';
import { liveAlertEvent } from '../src/server/trading/alerts';
import { FirestoreTradingStore } from '../src/server/trading/firestore-store';
import { MemoryTradingStore, kstDateKey } from '../src/server/trading/stores';
import { FakeFirestore } from './support/fake-firestore';
import { OrderInputError, TossOrderClient } from '../src/server/trading/toss-orders';
import {
  FakeToss,
  NOW,
  krAlgorithm,
  krFacts,
  sampleStats,
  seedOrder,
  tradingDaysSinceFixture,
} from './support/fake-toss';

const SYMBOLS = ['005930', '000660', '035420', '051910'];

function env(opts: { settings?: Record<string, unknown> } = {}) {
  const fake = new FakeToss();
  for (const s of SYMBOLS) {
    fake.priceLimits.set(s, { upper: '91000', lower: '49000', currency: 'KRW' });
    fake.sellable.set(s, '5000');
  }
  fake.now = () => NOW.getTime() + 1000; // broker clock is just after the local reservation
  const store = new MemoryTradingStore(() => NOW);
  const events: NotificationEvent[] = [];
  const client = new TossOrderClient(fake, { sleep: async () => undefined });
  const executor = new LiveOrderExecutor({
    client,
    store,
    notifier: {
      notify: async (e) => {
        events.push(e);
      },
    },
    now: () => NOW,
    tradingDaysSince: tradingDaysSinceFixture,
    settings: { sellTaxRate: 0.0018, ...opts.settings },
    algorithmName: () => 'KR momentum',
    newId: (() => {
      let n = 0;
      return () => `blocked-${++n}`;
    })(),
  });
  return { fake, store, events, client, executor };
}

function provider(
  over: {
    facts?: Partial<PreTradeMarketFacts>;
    pnl?: number | null;
    score?: number | null;
    stats?: ReturnType<typeof sampleStats>;
  } = {},
): RunDataProvider {
  return {
    marketFacts: async () => krFacts(over.facts),
    cumulativePnl: async () => (over.pnl === undefined ? 0 : over.pnl),
    expectedProfit: async () => ({
      stats: over.stats ?? sampleStats(),
      score: over.score === undefined ? 0.5 : over.score,
    }),
  };
}

const buy = (symbol: string, quantity = 10, price: number | string = 70000): Decision => ({
  symbol,
  side: 'buy',
  quantity,
  price,
});
const sell = (symbol: string, quantity: number, price: number | string = 70000): Decision => ({
  symbol,
  side: 'sell',
  quantity,
  price,
});

function run(decisions: Decision[], over: Partial<LiveRun> = {}): LiveRun {
  return {
    runId: 'run-2026-10-21-kr',
    algorithm: krAlgorithm(),
    decisions,
    data: provider(),
    ...over,
  };
}

describe('happy path', () => {
  it('places an accepted order, records the lifecycle, consumes the slot and sends no alert', async () => {
    const { fake, store, events, executor } = env();
    const report = await executor.executeRun(run([buy('005930')]));
    expect(report.outcomes).toMatchObject([{ symbol: '005930', side: 'buy', status: 'accepted' }]);
    expect(report.algorithmStopped).toBe(false);
    expect(fake.placeCount()).toBe(1);
    expect(fake.calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      orderType: 'LIMIT',
      timeInForce: 'DAY',
      quantity: '10',
      price: '70000',
    });
    const [order] = await store.listOrders({ algorithmId: 'algo-1' });
    expect(order).toMatchObject({
      status: 'accepted',
      symbol: '005930',
      quantity: 10,
      price: '70000',
      currency: 'KRW',
      dateKey: kstDateKey(NOW),
    });
    expect(order.orderId).toBe(fake.orders[0].orderId);
    expect(order.clientOrderId).toBe(fake.orders[0].clientOrderId);
    expect(await store.getDailyCounts(kstDateKey(NOW), 'algo-1')).toEqual({
      algorithm: 1,
      global: 1,
    });
    expect(events).toEqual([]);
  });
  it('the record is written before the request is sent (write-ahead)', async () => {
    const { fake, store, executor } = env();
    let statusDuringPlace: string | undefined;
    fake.onCreated = async () => undefined;
    const original = fake.send.bind(fake);
    fake.send = async (r) => {
      if (r.method === 'POST')
        statusDuringPlace = (await store.listOrders({ algorithmId: 'algo-1' }))[0]?.status;
      return original(r);
    };
    await executor.executeRun(run([buy('005930')]));
    expect(statusDuringPlace).toBe('reserved');
  });
  it('rounds the intended price toward the less aggressive side before checking', async () => {
    const { fake, executor } = env();
    await executor.executeRun(run([buy('005930', 10, '70000.8')]));
    expect(fake.calls.find((c) => c.method === 'POST')?.body).toMatchObject({ price: '70000' });
  });
  it('rejects malformed decisions without calling anything', async () => {
    const { fake, store, executor } = env();
    const report = await executor.executeRun(
      run([
        buy('005930', 1.5),
        buy('005930', 10, 'abc'),
        { symbol: '005930', side: 'hold' as never, quantity: 1, price: 1 },
      ]),
    );
    expect(report.outcomes.every((o) => o.status === 'blocked')).toBe(true);
    expect(fake.calls).toHaveLength(0);
    expect(store.listBlocked()).toHaveLength(3);
  });
});

describe('pre-trade refusals', () => {
  it('records the reason codes, does not place, and sends one safety-guard alert', async () => {
    const { fake, store, events, executor } = env();
    const report = await executor.executeRun(
      run([buy('005930')], { data: provider({ facts: { avgTradedValue: 1 } }) }),
    );
    expect(report.outcomes).toEqual([
      {
        symbol: '005930',
        side: 'buy',
        tranche: 0,
        status: 'blocked',
        reasons: ['LIQUIDITY_BELOW_MINIMUM'],
      },
    ]);
    expect(fake.calls).toHaveLength(0);
    expect(store.listBlocked()).toMatchObject([
      { reasons: ['LIQUIDITY_BELOW_MINIMUM'], symbol: '005930', algorithmId: 'algo-1' },
    ]);
    expect(await store.getDailyCounts(kstDateKey(NOW), 'algo-1')).toEqual({
      algorithm: 0,
      global: 0,
    }); // refusals use no slot
    expect(events).toEqual([
      {
        kind: 'order-rejected',
        mode: 'live',
        symbol: '005930',
        side: 'buy',
        algorithmName: 'KR momentum',
        reason: 'safety-guard',
      },
    ]);
  });
  it('routine holds ("기록 부족") are recorded but not alerted', async () => {
    const { store, events, executor } = env();
    const report = await executor.executeRun(
      run([buy('005930')], { data: provider({ stats: sampleStats(0.5, 0.05, 3) }) }),
    );
    expect(report.outcomes[0]).toMatchObject({
      status: 'blocked',
      reasons: ['HISTORY_INSUFFICIENT'],
    });
    expect(store.listBlocked()).toHaveLength(1);
    expect(events).toEqual([]);
  });
  it('data provider failures refuse the order instead of guessing', async () => {
    const { fake, executor } = env();
    const data: RunDataProvider = {
      marketFacts: async () => {
        throw new Error('quote service down');
      },
      cumulativePnl: async () => 0,
      expectedProfit: async () => null,
    };
    const report = await executor.executeRun(run([buy('005930')], { data }));
    expect(report.outcomes[0]).toMatchObject({ status: 'blocked' });
    expect(fake.calls).toHaveLength(0);
  });
  it('an unavailable P&L refuses (no auto-stop)', async () => {
    const { executor } = env();
    const report = await executor.executeRun(
      run([buy('005930')], { data: provider({ pnl: null }) }),
    );
    expect(report.outcomes[0]).toMatchObject({ reasons: ['LOSS_UNKNOWN'] });
    expect(report.algorithmStopped).toBe(false);
  });
  it('a failing notifier never blocks trading', async () => {
    const fake = new FakeToss();
    fake.priceLimits.set('005930', { upper: '91000', lower: '49000', currency: 'KRW' });
    const store = new MemoryTradingStore(() => NOW);
    const executor = new LiveOrderExecutor({
      client: new TossOrderClient(fake),
      store,
      notifier: {
        notify: async () => {
          throw new Error('telegram down');
        },
      },
      now: () => NOW,
      tradingDaysSince: tradingDaysSinceFixture,
      settings: { sellTaxRate: 0.0018 },
    });
    fake.postScript = [{ kind: 'status', status: 422, code: 'insufficient-buying-power' }];
    const report = await executor.executeRun(run([buy('005930')]));
    expect(report.outcomes[0].status).toBe('rejected');
  });
});

describe('emergency stop is read immediately before each order', () => {
  it('flipping it between two orders of one run: the second is not placed', async () => {
    const { fake, store, executor } = env();
    fake.onCreated = () => store.setEmergencyStop(true); // the operator presses the button after order 1
    const report = await executor.executeRun(run([buy('005930'), buy('000660')]));
    expect(report.outcomes.map((o) => o.status)).toEqual(['accepted', 'blocked']);
    expect(report.outcomes[1].reasons).toEqual(['EMERGENCY_STOP']);
    expect(fake.placeCount()).toBe(1);
    expect(fake.orders.map((o) => o.symbol)).toEqual(['005930']);
  });
  it('a stop set after the pre-trade check but before the reservation is caught inside the reservation', async () => {
    const { fake, executor: _unused, events } = env();
    void _unused;
    void events;
    class RacyStore extends MemoryTradingStore {
      // The pre-trade reads see "not stopped" (stale), the atomic reservation sees the truth.
      override async getEmergencyStop() {
        return false;
      }
    }
    const store = new RacyStore(() => NOW);
    store.setEmergencyStop(true);
    const executor = new LiveOrderExecutor({
      client: new TossOrderClient(fake),
      store,
      notifier: { notify: async () => undefined },
      now: () => NOW,
      tradingDaysSince: tradingDaysSinceFixture,
      settings: { sellTaxRate: 0.0018 },
    });
    const report = await executor.executeRun(run([buy('005930')]));
    expect(report.outcomes[0]).toMatchObject({ status: 'blocked', reasons: ['EMERGENCY_STOP'] });
    expect(fake.placeCount()).toBe(0);
    expect(await store.listOrders({ algorithmId: 'algo-1' })).toEqual([]); // no order, no slot
  });
  it('an already-stopped algorithm places nothing', async () => {
    const { fake, store, executor } = env();
    await store.stopAlgorithm('algo-1', 'loss-limit');
    const report = await executor.executeRun(run([buy('005930')]));
    expect(report.outcomes[0]).toMatchObject({ status: 'blocked', reasons: ['ALGORITHM_STOPPED'] });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('first live order rejected -> stop the algorithm and notify', () => {
  it.each([
    [403, 'forbidden'],
    [401, 'invalid-token'],
  ])(
    'HTTP %i on the first order stops the algorithm and skips the rest of the run',
    async (status, code) => {
      const { fake, store, events, executor } = env();
      fake.postScript = [{ kind: 'status', status, code }];
      const report = await executor.executeRun(run([buy('005930'), buy('000660')]));
      expect(report.outcomes.map((o) => o.status)).toEqual(['rejected', 'skipped']);
      expect(report).toMatchObject({ algorithmStopped: true, stopReason: 'order-permission' });
      expect(await store.isAlgorithmStopped('algo-1')).toBe(true);
      expect(store.stoppedReason('algo-1')).toBe('order-permission');
      expect(fake.placeCount()).toBe(1);
      expect(events).toEqual([
        {
          kind: 'order-rejected',
          mode: 'live',
          symbol: '005930',
          side: 'buy',
          algorithmName: 'KR momentum',
          reason: 'broker-rejected',
        },
        { kind: 'algorithm-auto-stop', mode: 'live', algorithmName: 'KR momentum' },
      ]);
      const [rec] = await store.listOrders({ algorithmId: 'algo-1' });
      expect(rec).toMatchObject({ status: 'rejected', error: { status, code } });
      // the next run places nothing
      const again = await executor.executeRun(run([buy('000660')], { runId: 'run-next' }));
      expect(again.outcomes[0]).toMatchObject({
        status: 'blocked',
        reasons: ['ALGORITHM_STOPPED'],
      });
      expect(fake.placeCount()).toBe(1);
    },
  );
  it('any other definitive refusal of the very first order also stops it', async () => {
    const { fake, executor, store } = env();
    fake.postScript = [{ kind: 'status', status: 422, code: 'prerequisite-required' }];
    const report = await executor.executeRun(run([buy('005930')]));
    expect(report).toMatchObject({ algorithmStopped: true, stopReason: 'first-order-rejected' });
    expect(await store.isAlgorithmStopped('algo-1')).toBe(true);
  });
  it('a rate-limit refusal of the first order is transient and does not stop it', async () => {
    const { fake, executor } = env();
    fake.postScript = Array.from({ length: 3 }, () => ({
      kind: 'status' as const,
      status: 429,
      code: 'rate-limit-exceeded',
    }));
    const report = await executor.executeRun(run([buy('005930')]));
    expect(report.outcomes[0]).toMatchObject({
      status: 'rejected',
      errorCode: 'rate-limit-exceeded',
    });
    expect(report.algorithmStopped).toBe(false);
  });
  it('after an order has been accepted before, an ordinary refusal does not stop the algorithm, a 403 still does', async () => {
    const a = env();
    await seedOrder(a.store, { clientOrderId: 'earlier', symbol: '035420' }, 'filled');
    a.fake.postScript = [{ kind: 'status', status: 422, code: 'insufficient-buying-power' }];
    const ra = await a.executor.executeRun(run([buy('005930')]));
    expect(ra.outcomes[0].status).toBe('rejected');
    expect(ra.algorithmStopped).toBe(false);
    const b = env();
    await seedOrder(b.store, { clientOrderId: 'earlier', symbol: '035420' }, 'filled');
    b.fake.postScript = [{ kind: 'status', status: 403, code: 'forbidden' }];
    const rb = await b.executor.executeRun(run([buy('005930')]));
    expect(rb).toMatchObject({ algorithmStopped: true, stopReason: 'order-permission' });
  });
  it('an order with an unknown outcome is alerted, not treated as rejected, and blocks the symbol', async () => {
    const { fake, store, events, executor } = env();
    fake.postScript = Array.from({ length: 3 }, () => ({ kind: 'network' as const }));
    const report = await executor.executeRun(run([buy('005930')]));
    expect(report.outcomes[0]).toMatchObject({ status: 'unknown', errorCode: 'network-error' });
    expect(report.algorithmStopped).toBe(false);
    expect((await store.listOrders({ algorithmId: 'algo-1' }))[0]).toMatchObject({
      status: 'unknown',
    });
    expect(events).toEqual([{ kind: 'job-failure', jobName: 'live-order-unconfirmed' }]);
    const next = await executor.executeRun(run([buy('005930')], { runId: 'run-next' }));
    expect(next.outcomes[0]).toMatchObject({ status: 'blocked', reasons: ['UNRECONCILED_ORDER'] });
    expect(fake.placeCount()).toBe(3); // three attempts of the first order, nothing since
  });
  it('an unknown order that exists at the broker is adopted by an exact unique OPEN match', async () => {
    const { fake, store, executor } = env();
    fake.postScript = [
      { kind: 'network', thenCreate: true },
      { kind: 'status', status: 500, code: 'internal-error' },
      { kind: 'status', status: 500, code: 'internal-error' },
    ];
    const first = await executor.executeRun(run([buy('005930')]));
    expect(first.outcomes[0].status).toBe('unknown');
    expect(fake.orders).toHaveLength(1);
    const reconciled = await executor.reconcile('algo-1');
    expect(reconciled.updated).toBe(0); // adoption is a status change recorded separately
    const [rec] = await store.listOrders({ algorithmId: 'algo-1' });
    expect(rec).toMatchObject({ status: 'accepted', orderId: fake.orders[0].orderId });
    expect(fake.calls.filter((c) => c.method === 'POST')).toHaveLength(3);
  });
  it('an order that was sent but could not be recorded stays reserved and blocks the next order', async () => {
    const { fake } = env();
    class FlakyStore extends MemoryTradingStore {
      override async updateOrder(): Promise<never> {
        throw new Error('firestore write failed');
      }
    }
    const store = new FlakyStore(() => NOW);
    const executor = new LiveOrderExecutor({
      client: new TossOrderClient(fake),
      store,
      notifier: { notify: async () => undefined },
      now: () => NOW,
      tradingDaysSince: tradingDaysSinceFixture,
      settings: { sellTaxRate: 0.0018 },
    });
    const report = await executor.executeRun(run([buy('005930'), buy('005930')]));
    expect(report.outcomes[0]).toMatchObject({ status: 'accepted', recordError: true });
    expect(report.outcomes[1]).toMatchObject({
      status: 'blocked',
      reasons: ['UNRECONCILED_ORDER'],
    });
    expect(fake.placeCount()).toBe(1);
  });
});

describe('idempotency across reruns', () => {
  it('re-running the same run never places the same order twice', async () => {
    const { fake, executor } = env();
    await executor.executeRun(run([buy('005930')]));
    await executor.executeRun(run([buy('005930')])); // same runId: a crash-restart or double trigger
    expect(fake.placeCount()).toBe(1);
  });
  it('a refused (terminal) order is not re-sent by a rerun either: the reservation is a duplicate', async () => {
    const { fake, store, executor } = env();
    await seedOrder(store, { clientOrderId: 'earlier', symbol: '035420' }, 'filled'); // not the first order
    fake.postScript = [{ kind: 'status', status: 422, code: 'insufficient-buying-power' }];
    await executor.executeRun(run([buy('005930')]));
    const again = await executor.executeRun(run([buy('005930')]));
    expect(again.outcomes[0]).toMatchObject({ status: 'skipped', reasons: ['UNRECONCILED_ORDER'] });
    expect(fake.placeCount()).toBe(1);
  });
  it('the key is deterministic per run, symbol, side and tranche and distinct otherwise', async () => {
    const { fake, executor } = env();
    await executor.executeRun(run([buy('005930'), buy('000660')]));
    const ids = fake.orders.map((o) => o.clientOrderId);
    expect(new Set(ids).size).toBe(2);
    const again = env();
    await again.executor.executeRun(run([buy('005930'), buy('000660')]));
    expect(again.fake.orders.map((o) => o.clientOrderId)).toEqual(ids);
  });
  it('a lost response is retried with the same key and yields exactly one order', async () => {
    const { fake, store, executor } = env();
    fake.postScript = [{ kind: 'network', thenCreate: true }];
    const report = await executor.executeRun(run([buy('005930')]));
    expect(report.outcomes[0].status).toBe('accepted');
    expect(fake.orders).toHaveLength(1);
    expect((await store.listOrders({ algorithmId: 'algo-1' }))[0].orderId).toBe(
      fake.orders[0].orderId,
    );
  });
});

describe('tick-size correction through the executor', () => {
  const limits = { upper: '70000', lower: '40000', currency: 'KRW' };
  const facts = {
    quote: { price: 50_050, observedAt: new Date(NOW.getTime() - 5000).toISOString() },
  };
  it('buy: corrected once to the lower tick, resent under the derived key, recorded', async () => {
    const { fake, store, executor } = env();
    fake.priceLimits.set('005930', limits);
    const report = await executor.executeRun(
      run([buy('005930', 10, 50050)], { data: provider({ facts }) }),
    );
    expect(report.outcomes[0].status).toBe('accepted');
    expect(
      fake.calls.filter((c) => c.method === 'POST').map((c) => (c.body as { price: string }).price),
    ).toEqual(['50050', '50000']);
    const [rec] = await store.listOrders({ algorithmId: 'algo-1' });
    expect(rec).toMatchObject({ price: '50000', tickCorrected: true, status: 'accepted' });
    expect(rec.wireClientOrderId).toBe(`${rec.clientOrderId}-t1`);
  });
  it('is declined when the emergency stop turns on meanwhile', async () => {
    const { fake, store, executor } = env();
    fake.priceLimits.set('005930', limits);
    const original = fake.send.bind(fake);
    let first = true;
    fake.send = async (r) => {
      const response = await original(r);
      if (r.method === 'POST' && first) {
        first = false;
        store.setEmergencyStop(true); // pressed while the first (tick-rejected) request was in flight
      }
      return response;
    };
    const report = await executor.executeRun(
      run([buy('005930', 10, 50050)], { data: provider({ facts }) }),
    );
    expect(report.outcomes[0]).toMatchObject({
      status: 'rejected',
      errorCode: 'tick-correction-declined',
    });
    expect(fake.placeCount()).toBe(1);
  });
  it('a sell correction that would push a tranche over 1e8 KRW is declined', async () => {
    const { fake, store, executor } = env();
    fake.priceLimits.set('005930', { upper: '200000', lower: '40000', currency: 'KRW' });
    fake.sellable.set('005930', '5000');
    await seedOrder(store, { clientOrderId: 'own', quantity: 5000 }, 'filled');
    // 70,050 is off the 100 tick above 50,000; the upper nearest price 70,100 * 1428 > 1e8, while 70,050 * 1428 < 1e8.
    const report = await executor.executeRun(
      run([sell('005930', 1427, 70050)], {
        data: provider({
          facts: {
            quote: { price: 70_050, observedAt: new Date(NOW.getTime() - 1000).toISOString() },
          },
        }),
      }),
    );
    // 1427 * 70,100 = 100,032,700 >= 1e8, so the correction is refused and nothing is resent.
    expect(report.outcomes[0]).toMatchObject({
      status: 'rejected',
      errorCode: 'tick-correction-declined',
    });
    expect(fake.placeCount()).toBe(1);
  });
});

describe('sells: tranche split, min holding, ownership', () => {
  it('splits a sell above the cap into tranches, places the first, holds the others behind the open order', async () => {
    const { fake, store, executor, events } = env();
    await seedOrder(store, { clientOrderId: 'own', quantity: 3000 }, 'filled');
    fake.sellable.set('005930', '3000');
    const report = await executor.executeRun(run([sell('005930', 3000)]));
    expect(report.outcomes.map((o) => [o.tranche, o.status, o.reasons])).toEqual([
      [0, 'accepted', undefined],
      [1, 'blocked', ['OPEN_ORDER_EXISTS']],
      [2, 'blocked', ['OPEN_ORDER_EXISTS']],
    ]);
    expect(fake.orders.map((o) => o.quantity)).toEqual(['1428']);
    expect(store.listBlocked().map((b) => b.tranche)).toEqual([1, 2]);
    expect(events).toEqual([]); // an open order is a routine hold
  });
  it('tranches have distinct deterministic keys', async () => {
    const { fake, store, executor } = env();
    await seedOrder(store, { clientOrderId: 'own', quantity: 3000 }, 'filled');
    fake.sellable.set('005930', '3000');
    // Pretend each tranche fills immediately so the next one is allowed.
    fake.onCreated = (o) => {
      o.status = 'FILLED';
      o.filledQuantity = o.quantity;
      o.averageFilledPrice = '70000';
    };
    const orig = executor.executeRun.bind(executor);
    void orig;
    const report = await executor.executeRun(run([sell('005930', 3000)]));
    expect(report.outcomes[0].status).toBe('accepted');
    const ids = new Set(fake.orders.map((o) => o.clientOrderId));
    expect(ids.size).toBe(fake.orders.length);
  });
  it('a buy above the cap is refused, never split', async () => {
    const { fake, executor } = env();
    const report = await executor.executeRun(
      run([buy('005930', 1429)], { algorithm: krAlgorithm({ budget: 1e12 }) }),
    );
    expect(report.outcomes).toMatchObject([{ status: 'blocked', reasons: ['ORDER_TOO_LARGE'] }]);
    expect(fake.placeCount()).toBe(0);
  });
  it('a sell inside the minimum holding period is held back (routine, not alerted)', async () => {
    const { fake, store, events, executor } = env();
    await seedOrder(
      store,
      { clientOrderId: 'own', quantity: 10, createdAt: '2026-10-16T01:00:00.000Z' },
      'filled',
    );
    const report = await executor.executeRun(run([sell('005930', 10)]));
    expect(report.outcomes[0]).toMatchObject({
      status: 'blocked',
      reasons: ['MIN_HOLDING_PERIOD'],
    });
    expect(fake.calls).toHaveLength(0);
    expect(events).toEqual([]);
  });
  it('never sells shares the algorithm did not buy', async () => {
    const { fake, executor } = env();
    const report = await executor.executeRun(run([sell('005930', 10)]));
    expect(report.outcomes[0]).toMatchObject({ status: 'blocked', reasons: ['SELL_NOT_OWNED'] });
    expect(fake.placeCount()).toBe(0);
  });
});

describe('US: USD only', () => {
  it('uses the USD balance only, rounds the price to cents, never touches KRW cash', async () => {
    const { fake, store, executor } = env({ settings: { sellTaxRate: undefined } });
    fake.priceLimits.set('AAPL', { upper: null, lower: null, currency: 'USD' });
    fake.buyingPower.KRW = '999999999999';
    fake.buyingPower.USD = '10000';
    const facts = {
      quote: { price: 185.5, observedAt: new Date(NOW.getTime() - 3000).toISOString() },
      avgTradedValue: 9e6,
      fxMidRate: 1400,
    };
    const report = await executor.executeRun({
      runId: 'run-us-1',
      algorithm: krAlgorithm({ id: 'algo-us', market: 'US', budget: 5000 }),
      decisions: [buy('AAPL', 5, 185.567)],
      data: provider({ facts }),
    });
    expect(report.outcomes[0].status).toBe('accepted');
    expect(fake.calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      symbol: 'AAPL',
      price: '185.56',
      quantity: '5',
    });
    expect(fake.calls.filter((c) => c.path === '/api/v1/buying-power').map((c) => c.query)).toEqual(
      [{ currency: 'USD' }],
    );
    expect((await store.listOrders({ algorithmId: 'algo-us' }))[0]).toMatchObject({
      market: 'US',
      currency: 'USD',
    });
  });
  it('without enough USD the order is refused (no conversion is attempted)', async () => {
    const { fake, executor } = env({ settings: { sellTaxRate: undefined } });
    fake.priceLimits.set('AAPL', { upper: null, lower: null, currency: 'USD' });
    fake.buyingPower.USD = '100';
    const report = await executor.executeRun({
      runId: 'run-us-2',
      algorithm: krAlgorithm({ id: 'algo-us', market: 'US', budget: 5000 }),
      decisions: [buy('AAPL', 5, 185.5)],
      data: provider({
        facts: {
          quote: { price: 185.5, observedAt: new Date(NOW.getTime() - 3000).toISOString() },
          avgTradedValue: 9e6,
          fxMidRate: 1400,
        },
      }),
    });
    expect(report.outcomes[0]).toMatchObject({
      status: 'blocked',
      reasons: ['BUYING_POWER_INSUFFICIENT'],
    });
    expect(fake.placeCount()).toBe(0);
  });
});

describe('daily counters and loss stop', () => {
  it('3 orders per algorithm per day: the 4th is refused', async () => {
    const { fake, executor } = env();
    const report = await executor.executeRun(run(SYMBOLS.map((s) => buy(s, 1))));
    expect(report.outcomes.map((o) => o.status)).toEqual([
      'accepted',
      'accepted',
      'accepted',
      'blocked',
    ]);
    expect(report.outcomes[3].reasons).toEqual(['DAILY_LIMIT_ALGORITHM']);
    expect(fake.placeCount()).toBe(3);
  });
  it('10 per day across algorithms', async () => {
    const { fake, store, executor } = env();
    for (let i = 0; i < 10; i++)
      await seedOrder(
        store,
        {
          clientOrderId: `other-${i}`,
          algorithmId: `other-${i}`,
          symbol: '035420',
          createdAt: NOW.toISOString(),
        },
        'rejected',
      );
    const report = await executor.executeRun(run([buy('005930')]));
    expect(report.outcomes[0]).toMatchObject({
      status: 'blocked',
      reasons: ['DAILY_LIMIT_GLOBAL'],
    });
    expect(fake.placeCount()).toBe(0);
  });
  it('the loss limit stops the algorithm once, notifies, and skips the rest of the run', async () => {
    const { fake, store, events, executor } = env();
    const report = await executor.executeRun(
      run([buy('005930'), buy('000660')], { data: provider({ pnl: -300_000_000 }) }),
    );
    expect(report.outcomes.map((o) => o.status)).toEqual(['blocked', 'skipped']);
    expect(report).toMatchObject({ algorithmStopped: true, stopReason: 'loss-limit' });
    expect(await store.isAlgorithmStopped('algo-1')).toBe(true);
    expect(events).toEqual([
      {
        kind: 'algorithm-auto-stop',
        mode: 'live',
        algorithmName: 'KR momentum',
        reason: 'loss-limit',
      },
    ]);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('reconciliation and fill notifications', () => {
  it('notifies a partial fill and the final fill once each and updates the record', async () => {
    const { fake, store, events, executor } = env();
    await executor.executeRun(run([buy('005930')]));
    const o = fake.orders[0];
    o.status = 'PARTIAL_FILLED';
    o.filledQuantity = '4';
    o.averageFilledPrice = '70010';
    expect((await executor.reconcile()).updated).toBe(1);
    await executor.reconcile(); // nothing changed: no second alert
    o.status = 'FILLED';
    o.filledQuantity = '10';
    await executor.reconcile();
    await executor.reconcile();
    expect(events.map((e) => e.kind === 'fill' && e.status)).toEqual([
      'partially-filled',
      'filled',
    ]);
    expect(events[0]).toEqual({
      kind: 'fill',
      mode: 'live',
      symbol: '005930',
      side: 'buy',
      status: 'partially-filled',
      algorithmName: 'KR momentum',
    });
    const [rec] = await store.listOrders({ algorithmId: 'algo-1' });
    expect(rec).toMatchObject({ status: 'filled', filledQuantity: 10, notifiedStatus: 'filled' });
  });
  it('a cancelled order (DAY expiry) closes the record without a fill alert and frees the symbol', async () => {
    const { fake, store, events, executor } = env();
    await executor.executeRun(run([buy('005930')]));
    fake.orders[0].status = 'CANCELED';
    await executor.reconcile();
    expect((await store.listOrders({ algorithmId: 'algo-1' }))[0].status).toBe('canceled');
    expect(events).toEqual([]);
    const next = await executor.executeRun(run([buy('005930')], { runId: 'run-next' }));
    expect(next.outcomes[0].status).toBe('accepted');
  });
  it('a failing lookup leaves the order non-terminal (and blocking)', async () => {
    const { fake, store, executor } = env();
    await executor.executeRun(run([buy('005930')]));
    fake.getFailures.set(`/api/v1/orders/${fake.orders[0].orderId}`, {
      status: 500,
      code: 'internal-error',
    });
    await executor.reconcile();
    expect((await store.listOrders({ algorithmId: 'algo-1' }))[0].status).toBe('accepted');
  });
  it('maps provider statuses conservatively', () => {
    expect(mapProviderStatus('FILLED')).toBe('filled');
    expect(mapProviderStatus('PARTIAL_FILLED')).toBe('partially-filled');
    expect(mapProviderStatus('CANCELED')).toBe('canceled');
    expect(mapProviderStatus('REPLACED')).toBe('canceled');
    expect(mapProviderStatus('REJECTED')).toBe('rejected');
    for (const keep of [
      'PENDING',
      'PENDING_CANCEL',
      'PENDING_REPLACE',
      'CANCEL_REJECTED',
      'REPLACE_REJECTED',
      'BRAND_NEW',
    ])
      expect(mapProviderStatus(keep)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Overlapping runs (H1)
// ---------------------------------------------------------------------------
describe('overlapping runs of one algorithm cannot both place an order (H1)', () => {
  /** A store that pretends nobody holds the run lease, so only the reservation guards remain. */
  class NoLeaseStore extends FirestoreTradingStore {
    override async acquireRunLease() {
      return true;
    }
  }
  function twoExecutors(opts: { lease: boolean; algorithm?: ReturnType<typeof krAlgorithm> }) {
    const db = new FakeFirestore();
    const fake = new FakeToss();
    fake.now = () => NOW.getTime() + 1000;
    for (const symbol of SYMBOLS) {
      fake.priceLimits.set(symbol, { upper: '91000', lower: '49000', currency: 'KRW' });
      fake.sellable.set(symbol, '5000');
    }
    const events: unknown[] = [];
    const make = () => {
      const store = opts.lease
        ? new FirestoreTradingStore(db as unknown as Firestore, () => NOW)
        : new NoLeaseStore(db as unknown as Firestore, () => NOW);
      return {
        store,
        executor: new LiveOrderExecutor({
          client: new TossOrderClient(fake, { sleep: async () => undefined }),
          store,
          notifier: { notify: async (e) => void events.push(e) },
          now: () => NOW,
          tradingDaysSince: tradingDaysSinceFixture,
          settings: { sellTaxRate: 0.0018 },
          algorithmName: () => 'KR momentum',
        }),
      };
    };
    return { db, fake, events, a: make(), b: make() };
  }
  const runWith = (runId: string, decisions: Decision[], algorithm = krAlgorithm()) =>
    run(decisions, { runId, algorithm });

  it('buy: two runs with distinct run ids -> one order (run lease)', async () => {
    const { fake, a, b } = twoExecutors({ lease: true });
    const [ra, rb] = await Promise.all([
      a.executor.executeRun(runWith('run-a', [buy('005930')])),
      b.executor.executeRun(runWith('run-b', [buy('005930')])),
    ]);
    expect(fake.placeCount()).toBe(1);
    expect([ra.leaseHeld, rb.leaseHeld].filter(Boolean)).toHaveLength(1);
    const held = ra.leaseHeld ? ra : rb;
    expect(held.outcomes).toEqual([
      {
        symbol: '005930',
        side: 'buy',
        tranche: 0,
        status: 'skipped',
        reasons: ['RUN_IN_PROGRESS'],
      },
    ]);
  });
  it('buy: even with the lease bypassed, the symbol lock inside the reservation allows one order', async () => {
    const { fake, db, a, b } = twoExecutors({ lease: false });
    const [ra, rb] = await Promise.all([
      a.executor.executeRun(runWith('run-a', [buy('005930')])),
      b.executor.executeRun(runWith('run-b', [buy('005930')])),
    ]);
    expect(fake.placeCount()).toBe(1);
    const statuses = [...ra.outcomes, ...rb.outcomes].map((o) => o.status).sort();
    expect(statuses).toEqual(['accepted', 'blocked']);
    const blocked = [...ra.outcomes, ...rb.outcomes].find((o) => o.status === 'blocked')!;
    expect(['OPEN_ORDER_EXISTS', 'UNRECONCILED_ORDER']).toContain(blocked.reasons?.[0]);
    expect([...db.docs.keys()].filter((k) => k.startsWith('liveOrders/'))).toHaveLength(1);
  });
  it('sell: two runs selling the same position -> one order, never a double sell', async () => {
    const { fake, a, b } = twoExecutors({ lease: false });
    await seedOrder(a.store, { clientOrderId: 'own', quantity: 10 }, 'filled');
    const [ra, rb] = await Promise.all([
      a.executor.executeRun(runWith('run-a', [sell('005930', 10)])),
      b.executor.executeRun(runWith('run-b', [sell('005930', 10)])),
    ]);
    expect(fake.placeCount()).toBe(1);
    expect([...ra.outcomes, ...rb.outcomes].map((o) => o.status).sort()).toEqual([
      'accepted',
      'blocked',
    ]);
    expect(fake.orders.map((o) => o.side)).toEqual(['SELL']);
  });
  it('sell: with the lease bypassed and DIFFERENT symbols the owned-quantity check is per symbol', async () => {
    const { fake, a, b } = twoExecutors({ lease: false });
    await seedOrder(a.store, { clientOrderId: 'own-1', quantity: 10, symbol: '005930' }, 'filled');
    await seedOrder(a.store, { clientOrderId: 'own-2', quantity: 10, symbol: '000660' }, 'filled');
    await Promise.all([
      a.executor.executeRun(runWith('run-a', [sell('005930', 10)])),
      b.executor.executeRun(runWith('run-b', [sell('000660', 10)])),
    ]);
    expect(fake.placeCount()).toBe(2); // independent positions are not serialized needlessly
  });
  it('buys on different symbols cannot jointly exceed the budget (re-checked in the transaction)', async () => {
    const { fake, a, b } = twoExecutors({ lease: false });
    const algorithm = krAlgorithm({ budget: 1_000_000 }); // each buy is 700,000
    const [ra, rb] = await Promise.all([
      a.executor.executeRun(runWith('run-a', [buy('005930')], algorithm)),
      b.executor.executeRun(runWith('run-b', [buy('000660')], algorithm)),
    ]);
    expect(fake.placeCount()).toBe(1);
    const blocked = [...ra.outcomes, ...rb.outcomes].find((o) => o.status === 'blocked')!;
    expect(blocked.reasons).toEqual(['BUDGET_EXCEEDED']);
  });
  it('a lease held by another run refuses the whole run without touching the broker', async () => {
    const { fake, store, executor } = env();
    await store.acquireRunLease('algo-1', 'someone-else', 600_000);
    const report = await executor.executeRun(run([buy('005930'), buy('000660')]));
    expect(report.leaseHeld).toBe(true);
    expect(report.outcomes.map((o) => o.status)).toEqual(['skipped', 'skipped']);
    expect(fake.calls).toHaveLength(0);
  });
  it('the same run id may continue after a restart; the lease is released afterwards', async () => {
    const { store, executor } = env();
    await store.acquireRunLease('algo-1', 'run-2026-10-21-kr', 600_000);
    const report = await executor.executeRun(run([buy('005930')]));
    expect(report.leaseHeld).toBeUndefined();
    expect(report.outcomes[0].status).toBe('accepted');
    expect(await store.acquireRunLease('algo-1', 'another-run', 600_000)).toBe(true);
  });
  it('the lease is released even if the run throws', async () => {
    const { store, executor: _e } = env();
    void _e;
    const executor = new LiveOrderExecutor({
      client: new TossOrderClient(new FakeToss()),
      store,
      notifier: { notify: async () => undefined },
      now: () => NOW,
      tradingDaysSince: tradingDaysSinceFixture,
      settings: { sellTaxRate: 0.0018 },
      algorithmName: () => {
        throw new Error('naming exploded');
      },
    });
    await expect(
      executor.executeRun(
        run([buy('005930')], { data: provider({ facts: { avgTradedValue: 1 } }) }),
      ),
    ).rejects.toThrow('naming exploded');
    expect(await store.acquireRunLease('algo-1', 'next-run', 600_000)).toBe(true);
  });
  it('different algorithms do not block each other', async () => {
    const { fake, executor, store } = env();
    await store.acquireRunLease('algo-other', 'run-x', 600_000);
    const report = await executor.executeRun(run([buy('005930')]));
    expect(report.outcomes[0].status).toBe('accepted');
    expect(fake.placeCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ambiguity, stop before retry, local failures
// ---------------------------------------------------------------------------
describe('retries stop when the system is stopped (M2)', () => {
  it('emergency stop flipped during scripted network errors: no resend, outcome unknown', async () => {
    const { fake, store, events, executor } = env();
    fake.postScript = [{ kind: 'network' }, { kind: 'network' }, { kind: 'network' }];
    const original = fake.send.bind(fake);
    fake.send = async (r) => {
      if (r.method === 'POST') store.setEmergencyStop(true); // pressed during the first attempt
      return original(r);
    };
    const report = await executor.executeRun(run([buy('005930')]));
    expect(report.outcomes[0]).toMatchObject({ status: 'unknown', errorCode: 'retry-aborted' });
    expect(fake.placeCount()).toBe(1);
    expect((await store.listOrders({ algorithmId: 'algo-1' }))[0].status).toBe('unknown');
    expect(events).toEqual([{ kind: 'job-failure', jobName: 'live-order-unconfirmed' }]);
  });
  it('an algorithm stopped during the retries also aborts the resend', async () => {
    const { fake, store, executor } = env();
    fake.postScript = [{ kind: 'network' }, { kind: 'network' }];
    const original = fake.send.bind(fake);
    fake.send = async (r) => {
      if (r.method === 'POST') await store.stopAlgorithm('algo-1', 'loss-limit');
      return original(r);
    };
    const report = await executor.executeRun(run([buy('005930')]));
    expect(report.outcomes[0]).toMatchObject({ status: 'unknown', errorCode: 'retry-aborted' });
    expect(fake.placeCount()).toBe(1);
  });
  it('an unreadable stop flag at retry time aborts the resend (fail closed)', async () => {
    const { fake, store, executor } = env();
    fake.postScript = [{ kind: 'network' }, { kind: 'network' }];
    let first = true;
    const original = fake.send.bind(fake);
    fake.send = async (r) => {
      if (r.method === 'POST' && first) {
        first = false;
        store.getEmergencyStop = async () => {
          throw new Error('firestore down');
        };
      }
      return original(r);
    };
    const report = await executor.executeRun(run([buy('005930')]));
    expect(report.outcomes[0]).toMatchObject({ status: 'unknown', errorCode: 'retry-aborted' });
    expect(fake.placeCount()).toBe(1);
  });
  it('without a stop the retries still go out with the same key', async () => {
    const { fake, executor } = env();
    fake.postScript = [{ kind: 'network' }, { kind: 'network' }];
    const report = await executor.executeRun(run([buy('005930')]));
    expect(report.outcomes[0].status).toBe('accepted');
    const posts = fake.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(3);
    expect(
      new Set(posts.map((c) => (c.body as { clientOrderId: string }).clientOrderId)).size,
    ).toBe(1);
  });
});

describe('an ambiguous attempt followed by a 4xx is unknown, not a broker rejection (M1)', () => {
  it.each([401, 403])(
    'network error then HTTP %i: no permission stop, no rejection alert',
    async (status) => {
      const { fake, store, events, executor } = env();
      fake.postScript = [{ kind: 'network' }, { kind: 'status', status, code: 'forbidden' }];
      const report = await executor.executeRun(run([buy('005930'), buy('000660')]));
      expect(report.outcomes[0]).toMatchObject({ status: 'unknown', errorCode: 'forbidden' });
      expect(report.algorithmStopped).toBe(false);
      expect(await store.isAlgorithmStopped('algo-1')).toBe(false);
      expect(events).toEqual([{ kind: 'job-failure', jobName: 'live-order-unconfirmed' }]);
      expect((await store.listOrders({ algorithmId: 'algo-1' }))[0].status).toBe('unknown');
    },
  );
  it('network error then 422 keeps the symbol blocked as unreconciled', async () => {
    const { fake, executor } = env();
    fake.postScript = [
      { kind: 'network' },
      { kind: 'status', status: 422, code: 'insufficient-buying-power' },
    ];
    const first = await executor.executeRun(run([buy('005930')]));
    expect(first.outcomes[0].status).toBe('unknown');
    const next = await executor.executeRun(run([buy('005930')], { runId: 'run-next' }));
    expect(next.outcomes[0]).toMatchObject({ status: 'blocked', reasons: ['UNRECONCILED_ORDER'] });
  });
});

describe('local input failures are not broker rejections (L7)', () => {
  function throwingClient() {
    const fake = new FakeToss();
    for (const s of SYMBOLS)
      fake.priceLimits.set(s, { upper: '91000', lower: '49000', currency: 'KRW' });
    const real = new TossOrderClient(fake);
    return {
      fake,
      client: {
        placeOrder: async () => {
          throw new OrderInputError('price must be in the documented scale');
        },
        cancelOrder: real.cancelOrder.bind(real),
        listOrders: real.listOrders.bind(real),
        getOrder: real.getOrder.bind(real),
        getSellableQuantity: real.getSellableQuantity.bind(real),
        getBuyingPower: real.getBuyingPower.bind(real),
        getCommissions: real.getCommissions.bind(real),
        getStockWarnings: real.getStockWarnings.bind(real),
        getPriceLimits: real.getPriceLimits.bind(real),
      },
    };
  }
  it('records input-invalid, alerts as a job failure, does not stop the algorithm even on the first order', async () => {
    const { client, fake } = throwingClient();
    const store = new MemoryTradingStore(() => NOW);
    const events: unknown[] = [];
    const executor = new LiveOrderExecutor({
      client,
      store,
      notifier: { notify: async (e) => void events.push(e) },
      now: () => NOW,
      tradingDaysSince: tradingDaysSinceFixture,
      settings: { sellTaxRate: 0.0018 },
      algorithmName: () => 'KR momentum',
    });
    const report = await executor.executeRun(run([buy('005930'), buy('000660')]));
    expect(report.algorithmStopped).toBe(false);
    expect(report.outcomes.map((o) => [o.status, o.errorCode])).toEqual([
      ['rejected', 'input-invalid'],
      ['rejected', 'input-invalid'],
    ]);
    expect(await store.isAlgorithmStopped('algo-1')).toBe(false);
    expect(events).toEqual([
      { kind: 'job-failure', jobName: 'live-order-input-invalid' },
      { kind: 'job-failure', jobName: 'live-order-input-invalid' },
    ]);
    const recs = await store.listOrders({ algorithmId: 'algo-1' });
    expect(recs.map((r) => [r.status, r.error?.code])).toEqual([
      ['rejected', 'input-invalid'],
      ['rejected', 'input-invalid'],
    ]);
    expect(fake.placeCount()).toBe(0);
  });
  it('a later genuine first broker order is still watched (the local failure did not count as one)', async () => {
    const { client } = throwingClient();
    const store = new MemoryTradingStore(() => NOW);
    const executor = new LiveOrderExecutor({
      client,
      store,
      notifier: { notify: async () => undefined },
      now: () => NOW,
      tradingDaysSince: tradingDaysSinceFixture,
      settings: { sellTaxRate: 0.0018 },
    });
    await executor.executeRun(run([buy('005930')]));
    const prior = await store.listOrders({ algorithmId: 'algo-1' });
    expect(prior.every((o) => o.status === 'rejected')).toBe(true);
  });
});

describe('tick correction veto in the executor re-checks price limits (L3)', () => {
  it('a correction that would land inside the lower-limit buffer is declined', async () => {
    const { fake, executor } = env();
    // lower * 1.03 = 50,016.8: the original 50,050 passes the check, the corrected 50,000 would not.
    fake.priceLimits.set('005930', { upper: '70000', lower: '48560', currency: 'KRW' });
    const report = await executor.executeRun(
      run([buy('005930', 10, 50050)], {
        data: provider({
          facts: {
            quote: { price: 50_050, observedAt: new Date(NOW.getTime() - 5000).toISOString() },
          },
        }),
      }),
    );
    expect(report.outcomes[0]).toMatchObject({
      status: 'rejected',
      errorCode: 'tick-correction-declined',
    });
    expect(fake.placeCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Reconcile adoption (L1)
// ---------------------------------------------------------------------------
describe('reconcile never adopts an order across algorithms or from before the record (L1)', () => {
  const openOrder = (over: Record<string, unknown> = {}) => ({
    orderId: 'broker-open-1',
    clientOrderId: null,
    symbol: '005930',
    side: 'BUY' as const,
    orderType: 'LIMIT',
    timeInForce: 'DAY',
    status: 'PENDING',
    price: '70000',
    quantity: '10',
    currency: 'KRW' as const,
    orderedAt: new Date(NOW.getTime() + 1000).toISOString(),
    filledQuantity: '0',
    averageFilledPrice: null,
    ...over,
  });
  const seedUnknown = (
    store: MemoryTradingStore,
    id: string,
    algorithmId: string,
    createdAt = NOW.toISOString(),
  ) =>
    seedOrder(
      store,
      { clientOrderId: id, algorithmId, symbol: '005930', createdAt, dateKey: kstDateKey(NOW) },
      'unknown',
    );

  it('a single record with a single matching later OPEN order is adopted (baseline)', async () => {
    const { fake, store, executor } = env();
    await seedUnknown(store, 'u1', 'algo-1');
    fake.orders.push(openOrder());
    await executor.reconcile();
    expect(await store.getOrder('u1')).toMatchObject({
      status: 'accepted',
      orderId: 'broker-open-1',
    });
  });
  it('two algorithms with look-alike unknown records: neither adopts the one broker order', async () => {
    const { fake, store, executor } = env();
    await seedUnknown(store, 'u1', 'algo-1');
    await seedUnknown(store, 'u2', 'algo-2');
    fake.orders.push(openOrder());
    await executor.reconcile('algo-1');
    await executor.reconcile('algo-2');
    await executor.reconcile();
    expect((await store.getOrder('u1'))?.status).toBe('unknown');
    expect((await store.getOrder('u2'))?.status).toBe('unknown');
  });
  it('an order id already claimed by another algorithm is never adopted', async () => {
    const { fake, store, executor } = env();
    await seedOrder(
      store,
      {
        clientOrderId: 'claimed',
        algorithmId: 'algo-2',
        symbol: '005930',
        createdAt: NOW.toISOString(),
        dateKey: kstDateKey(NOW),
      },
      'accepted',
    );
    await store.updateOrder('claimed', { orderId: 'broker-open-1' });
    await seedUnknown(store, 'u1', 'algo-1');
    fake.orders.push(openOrder());
    await executor.reconcile('algo-1');
    expect((await store.getOrder('u1'))?.status).toBe('unknown');
  });
  it('an order placed before the record was created is not adopted', async () => {
    const { fake, store, executor } = env();
    await seedUnknown(store, 'u1', 'algo-1', NOW.toISOString());
    fake.orders.push(openOrder({ orderedAt: new Date(NOW.getTime() - 60_000).toISOString() }));
    await executor.reconcile();
    expect((await store.getOrder('u1'))?.status).toBe('unknown');
  });
  it('differences in symbol, side, quantity, price, type or time-in-force prevent adoption', async () => {
    for (const over of [
      { symbol: '000660' },
      { side: 'SELL' },
      { quantity: '11' },
      { price: '70100' },
      { orderType: 'MARKET', price: null },
      { timeInForce: 'CLS' },
    ]) {
      const { fake, store, executor } = env();
      await seedUnknown(store, 'u1', 'algo-1');
      fake.orders.push(openOrder(over));
      await executor.reconcile();
      expect((await store.getOrder('u1'))?.status, JSON.stringify(over)).toBe('unknown');
    }
  });
  it('two matching broker orders for one record are ambiguous: no adoption', async () => {
    const { fake, store, executor } = env();
    await seedUnknown(store, 'u1', 'algo-1');
    fake.orders.push(openOrder(), openOrder({ orderId: 'broker-open-2' }));
    await executor.reconcile();
    expect((await store.getOrder('u1'))?.status).toBe('unknown');
  });
});

describe('alert mapping lives in one function', () => {
  it('maps every live situation to a notification event without amounts or provider text', () => {
    const base = { symbol: '005930', side: 'buy' as const, algorithmName: 'KR momentum' };
    expect(liveAlertEvent({ type: 'safety-guard-refusal', ...base })).toEqual({
      kind: 'order-rejected',
      mode: 'live',
      reason: 'safety-guard',
      ...base,
    });
    expect(liveAlertEvent({ type: 'broker-rejected', ...base })).toEqual({
      kind: 'order-rejected',
      mode: 'live',
      reason: 'broker-rejected',
      ...base,
    });
    expect(
      liveAlertEvent({ type: 'algorithm-stopped', why: 'loss-limit', algorithmName: 'A' }),
    ).toEqual({
      kind: 'algorithm-auto-stop',
      mode: 'live',
      algorithmName: 'A',
      reason: 'loss-limit',
    });
    expect(
      liveAlertEvent({ type: 'algorithm-stopped', why: 'order-permission', algorithmName: 'A' }),
    ).toEqual({ kind: 'algorithm-auto-stop', mode: 'live', algorithmName: 'A' });
    expect(
      liveAlertEvent({
        type: 'algorithm-stopped',
        why: 'first-order-rejected',
        algorithmName: 'A',
      }),
    ).toEqual({ kind: 'algorithm-auto-stop', mode: 'live', algorithmName: 'A' });
    expect(liveAlertEvent({ type: 'order-unconfirmed' })).toEqual({
      kind: 'job-failure',
      jobName: 'live-order-unconfirmed',
    });
    expect(liveAlertEvent({ type: 'local-input-failure' })).toEqual({
      kind: 'job-failure',
      jobName: 'live-order-input-invalid',
    });
    expect(liveAlertEvent({ type: 'fill', status: 'filled', ...base })).toEqual({
      kind: 'fill',
      mode: 'live',
      status: 'filled',
      ...base,
    });
  });
});
