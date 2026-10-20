import { describe, expect, it } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';
import { FirestoreTradingStore, parseLiveOrder } from '../src/server/trading/firestore-store';
import {
  MemoryTradingStore,
  NON_TERMINAL_STATUSES,
  TERMINAL_STATUSES,
  canTransition,
  decideReserve,
  kstDateKey,
  summarizeLedger,
  symbolLockState,
  type LiveOrderRecord,
  type LiveOrderStatus,
  type TradingStore,
} from '../src/server/trading/stores';
import { FakeFirestore } from './support/fake-firestore';
import { NOW, seedOrder } from './support/fake-toss';

const makeFirestore = () => {
  const db = new FakeFirestore();
  return {
    db,
    store: new FirestoreTradingStore(db as unknown as Firestore, () => NOW),
    stop: (active: unknown) =>
      db.write('algorithmControl/global', { emergencyStop: active } as Record<string, unknown>),
  };
};

const record = (over: Partial<LiveOrderRecord> = {}): LiveOrderRecord => ({
  clientOrderId: 'ai-1',
  algorithmId: 'algo-1',
  runId: 'run-1',
  market: 'KR',
  symbol: '005930',
  side: 'buy',
  quantity: 10,
  price: '70000',
  currency: 'KRW',
  tranche: 0,
  status: 'reserved',
  dateKey: '2026-10-21',
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  filledQuantity: 0,
  ...over,
});
const reserve = (
  store: TradingStore,
  over: Partial<LiveOrderRecord> = {},
  max = { a: 3, g: 10 },
  budget = Number.POSITIVE_INFINITY,
) => store.reserveOrder({ record: record(over), maxPerAlgorithm: max.a, maxGlobal: max.g, budget });

describe('pure helpers', () => {
  it('kstDateKey uses Korea time (UTC+9, no DST)', () => {
    expect(kstDateKey(new Date('2026-10-20T14:59:59Z'))).toBe('2026-10-20');
    expect(kstDateKey(new Date('2026-10-20T15:00:00Z'))).toBe('2026-10-21');
    expect(kstDateKey(new Date('2026-07-01T00:00:00Z'))).toBe('2026-07-01');
  });
  it('decideReserve: duplicate first, then stop flags, symbol lock, limits, then exposure', () => {
    const base = {
      emergencyStop: false,
      algorithmStopped: false,
      algorithmCount: 0,
      globalCount: 0,
      exists: false,
      maxPerAlgorithm: 3,
      maxGlobal: 10,
      symbolLock: 'free' as const,
      side: 'buy' as const,
      quantity: 10,
      notional: 700_000,
      budget: 1_000_000,
      committed: 0,
      ownAvailable: 0,
    };
    expect(decideReserve(base)).toBeNull();
    expect(decideReserve({ ...base, exists: true, emergencyStop: true })).toBe('duplicate');
    expect(decideReserve({ ...base, emergencyStop: true, algorithmStopped: true })).toBe(
      'emergency-stop',
    );
    expect(decideReserve({ ...base, algorithmStopped: true })).toBe('algorithm-stopped');
    expect(decideReserve({ ...base, symbolLock: 'open', algorithmCount: 3 })).toBe('symbol-open');
    expect(decideReserve({ ...base, symbolLock: 'unreconciled' })).toBe('symbol-unreconciled');
    expect(decideReserve({ ...base, algorithmCount: 3 })).toBe('daily-limit-algorithm');
    expect(decideReserve({ ...base, algorithmCount: 2 })).toBeNull();
    expect(decideReserve({ ...base, globalCount: 10 })).toBe('daily-limit-global');
    expect(decideReserve({ ...base, committed: 300_001 })).toBe('budget-exceeded');
    expect(decideReserve({ ...base, committed: 300_000 })).toBeNull();
    expect(decideReserve({ ...base, side: 'sell', ownAvailable: 9 })).toBe('sell-exceeds-owned');
    expect(decideReserve({ ...base, side: 'sell', ownAvailable: 10 })).toBeNull();
  });
  it('symbolLockState: a terminal or missing owner is not a live lock', () => {
    expect(symbolLockState(false, null)).toBe('free');
    expect(symbolLockState(true, 'filled')).toBe('free');
    expect(symbolLockState(true, 'rejected')).toBe('free');
    expect(symbolLockState(true, 'canceled')).toBe('free');
    expect(symbolLockState(true, null)).toBe('unreconciled');
    expect(symbolLockState(true, 'reserved')).toBe('unreconciled');
    expect(symbolLockState(true, 'unknown')).toBe('unreconciled');
    expect(symbolLockState(true, 'accepted')).toBe('open');
    expect(symbolLockState(true, 'partially-filled')).toBe('open');
  });
  it('status lifecycle: terminal states cannot be left; every non-terminal can progress', () => {
    const all: LiveOrderStatus[] = [
      'reserved',
      'accepted',
      'unknown',
      'rejected',
      'partially-filled',
      'filled',
      'canceled',
    ];
    for (const t of TERMINAL_STATUSES)
      for (const to of all) expect(canTransition(t, to), `${t}->${to}`).toBe(t === to);
    expect(NON_TERMINAL_STATUSES).toEqual(['reserved', 'accepted', 'unknown', 'partially-filled']);
    expect(canTransition('reserved', 'accepted')).toBe(true);
    expect(canTransition('reserved', 'filled')).toBe(false); // must be accepted (or adopted) first
    expect(canTransition('accepted', 'reserved')).toBe(false);
    expect(canTransition('partially-filled', 'accepted')).toBe(false);
    expect(canTransition('unknown', 'accepted')).toBe(true);
    expect(canTransition('unknown', 'filled')).toBe(true);
  });
});

describe('summarizeLedger: what the algorithm owns and has committed', () => {
  const o = (over: Partial<LiveOrderRecord>) =>
    record({ status: 'filled', filledQuantity: 10, ...over });
  it('held quantity is filled buys minus filled sells, with average cost', () => {
    const ledger = summarizeLedger([
      o({
        clientOrderId: 'b1',
        quantity: 10,
        filledQuantity: 10,
        price: '100',
        averageFilledPrice: 100,
        createdAt: '2026-10-01T00:00:00Z',
        dateKey: '2026-10-01',
      }),
      o({
        clientOrderId: 'b2',
        quantity: 10,
        filledQuantity: 10,
        price: '120',
        averageFilledPrice: 120,
        createdAt: '2026-10-02T00:00:00Z',
        dateKey: '2026-10-02',
      }),
      o({
        clientOrderId: 's1',
        side: 'sell',
        quantity: 5,
        filledQuantity: 5,
        price: '130',
        createdAt: '2026-10-03T00:00:00Z',
        dateKey: '2026-10-03',
      }),
    ]);
    const p = ledger.positions.get('005930')!;
    expect(p.quantity).toBe(15);
    expect(p.costBasis).toBeCloseTo(1650); // 2200 * 15/20
    expect(p.lastBuyDate).toBe('2026-10-02');
    expect(ledger.committed).toBeCloseTo(1650);
  });
  it('working buys count as committed at their limit price; only the unfilled part', () => {
    const ledger = summarizeLedger([
      record({ clientOrderId: 'w', status: 'accepted', quantity: 10, price: '100' }),
      record({
        clientOrderId: 'p',
        symbol: '000660',
        status: 'partially-filled',
        quantity: 10,
        filledQuantity: 4,
        price: '200',
        averageFilledPrice: 199,
      }),
    ]);
    expect(ledger.committed).toBeCloseTo(1000 + 4 * 199 + 6 * 200);
    expect(ledger.positions.get('000660')!.quantity).toBe(4);
    expect(ledger.positions.get('005930')!.quantity).toBe(0);
  });
  it('rejected orders are ignored; cancelled keep only their fills; unknown buys are committed but not owned', () => {
    const ledger = summarizeLedger([
      record({ clientOrderId: 'r', status: 'rejected' }),
      record({
        clientOrderId: 'c',
        symbol: '000660',
        status: 'canceled',
        quantity: 10,
        filledQuantity: 3,
        price: '100',
      }),
      record({
        clientOrderId: 'u',
        symbol: '035420',
        status: 'unknown',
        quantity: 5,
        price: '100',
      }),
    ]);
    expect(ledger.positions.get('000660')!.quantity).toBe(3);
    expect(ledger.positions.get('035420')!.quantity).toBe(0);
    expect(ledger.committed).toBeCloseTo(300 + 500);
    expect(ledger.positions.has('005930')).toBe(false);
  });
  it('working sells are tracked so the same shares cannot be sold twice', () => {
    const ledger = summarizeLedger([
      record({ clientOrderId: 'b', status: 'filled', filledQuantity: 10 }),
      record({
        clientOrderId: 's',
        side: 'sell',
        status: 'accepted',
        quantity: 6,
        createdAt: '2026-10-22T00:00:00Z',
      }),
    ]);
    expect(ledger.positions.get('005930')).toMatchObject({ quantity: 10, pendingSellQuantity: 6 });
  });
  it('selling more than held never makes the position negative', () => {
    const ledger = summarizeLedger([
      record({ clientOrderId: 'b', status: 'filled', filledQuantity: 2 }),
      record({
        clientOrderId: 's',
        side: 'sell',
        status: 'filled',
        quantity: 5,
        filledQuantity: 5,
        createdAt: '2026-10-22T00:00:00Z',
      }),
    ]);
    expect(ledger.positions.get('005930')).toMatchObject({ quantity: 0, costBasis: 0 });
  });
});

describe.each([
  ['MemoryTradingStore', (clock: () => Date) => new MemoryTradingStore(clock) as TradingStore],
  [
    'FirestoreTradingStore (fake Firestore)',
    (clock: () => Date) =>
      new FirestoreTradingStore(new FakeFirestore() as unknown as Firestore, clock) as TradingStore,
  ],
] as const)('store contract: %s', (name, make) => {
  let clockNow = NOW;
  const build = () => {
    clockNow = NOW;
    const store = make(() => clockNow);
    const setStop = async (v: boolean) => {
      if (store instanceof MemoryTradingStore) store.setEmergencyStop(v);
      else await (store as FirestoreTradingStore).setEmergencyStop(v);
    };
    return { store, setStop };
  };

  it('reserves a slot: counters, record and duplicate detection', async () => {
    const { store } = build();
    expect(await reserve(store)).toEqual({ ok: true });
    expect(await store.getDailyCounts('2026-10-21', 'algo-1')).toEqual({ algorithm: 1, global: 1 });
    expect(await store.getDailyCounts('2026-10-21', 'algo-2')).toEqual({ algorithm: 0, global: 1 });
    expect(await store.getDailyCounts('2026-10-22', 'algo-1')).toEqual({ algorithm: 0, global: 0 });
    expect(await store.getOrder('ai-1')).toMatchObject({ status: 'reserved', symbol: '005930' });
    expect(await reserve(store)).toEqual({ ok: false, reason: 'duplicate' });
    expect(await store.getDailyCounts('2026-10-21', 'algo-1')).toEqual({ algorithm: 1, global: 1 }); // not consumed twice
  });
  it('enforces the per-algorithm and global daily limits atomically', async () => {
    const { store } = build();
    for (let i = 0; i < 3; i++)
      expect(await reserve(store, { clientOrderId: `a-${i}`, symbol: `S${i}` })).toEqual({
        ok: true,
      });
    expect(await reserve(store, { clientOrderId: 'a-3', symbol: 'S3' })).toEqual({
      ok: false,
      reason: 'daily-limit-algorithm',
    });
    expect(await store.getOrder('a-3')).toBeNull();
    for (let i = 0; i < 7; i++)
      expect(await reserve(store, { clientOrderId: `o-${i}`, algorithmId: `other-${i}` })).toEqual({
        ok: true,
      });
    expect(await reserve(store, { clientOrderId: 'o-7', algorithmId: 'other-7' })).toEqual({
      ok: false,
      reason: 'daily-limit-global',
    });
    expect((await store.getDailyCounts('2026-10-21', 'algo-1')).global).toBe(10);
  });
  it('the emergency stop is read fresh on every call and inside the reservation', async () => {
    const { store, setStop } = build();
    expect(await store.getEmergencyStop()).toBe(false);
    await setStop(true);
    expect(await store.getEmergencyStop()).toBe(true);
    expect(await reserve(store)).toEqual({ ok: false, reason: 'emergency-stop' });
    expect(await store.getDailyCounts('2026-10-21', 'algo-1')).toEqual({ algorithm: 0, global: 0 });
    await setStop(false);
    expect(await store.getEmergencyStop()).toBe(false);
    expect(await reserve(store)).toEqual({ ok: true });
  });
  it('a stopped algorithm cannot reserve; others still can', async () => {
    const { store } = build();
    expect(await store.isAlgorithmStopped('algo-1')).toBe(false);
    await store.stopAlgorithm('algo-1', 'loss-limit');
    expect(await store.isAlgorithmStopped('algo-1')).toBe(true);
    expect(await reserve(store)).toEqual({ ok: false, reason: 'algorithm-stopped' });
    expect(await reserve(store, { clientOrderId: 'x', algorithmId: 'algo-2' })).toEqual({
      ok: true,
    });
  });
  it('rejects unsafe algorithm ids (no path injection)', async () => {
    const { store } = build();
    await expect(store.stopAlgorithm('../x', 'r')).rejects.toThrow();
    await expect(store.stopAlgorithm('a/b', 'r')).rejects.toThrow();
    await expect(reserve(store, { algorithmId: 'a/b' })).rejects.toThrow();
  });
  it('only a reserved record can be reserved', async () => {
    const { store } = build();
    await expect(reserve(store, { status: 'filled' })).rejects.toThrow();
  });
  it('updates follow the lifecycle and illegal transitions throw without changing anything', async () => {
    const { store } = build();
    await reserve(store);
    await expect(store.updateOrder('ai-1', { status: 'filled' })).rejects.toThrow(/transition/);
    const accepted = await store.updateOrder('ai-1', {
      status: 'accepted',
      orderId: 'broker-1',
      wireClientOrderId: 'ai-1-t1',
      price: '69900',
      tickCorrected: true,
    });
    expect(accepted).toMatchObject({
      status: 'accepted',
      orderId: 'broker-1',
      price: '69900',
      tickCorrected: true,
    });
    await store.updateOrder('ai-1', {
      status: 'partially-filled',
      filledQuantity: 4,
      averageFilledPrice: 69900,
    });
    await store.updateOrder('ai-1', { status: 'filled', filledQuantity: 10 });
    await expect(store.updateOrder('ai-1', { status: 'canceled' })).rejects.toThrow(/transition/);
    expect(await store.getOrder('ai-1')).toMatchObject({
      status: 'filled',
      filledQuantity: 10,
      averageFilledPrice: 69900,
    });
    await expect(store.updateOrder('missing', { status: 'accepted' })).rejects.toThrow();
  });
  it('stores a sanitized error and the fill-notification marker', async () => {
    const { store } = build();
    await reserve(store);
    await store.updateOrder('ai-1', {
      status: 'rejected',
      error: { kind: 'http', status: 422, code: 'insufficient-buying-power', requestId: 'req-1' },
    });
    expect(await store.getOrder('ai-1')).toMatchObject({
      error: { code: 'insufficient-buying-power', status: 422 },
    });
    await store.updateOrder('ai-1', { notifiedStatus: 'rejected' }); // same-status patch is allowed
  });
  it('lists by algorithm (and symbol) and lists non-terminal orders across algorithms', async () => {
    const { store } = build();
    await seedOrder(
      store,
      { clientOrderId: 'a', algorithmId: 'algo-1', symbol: '005930' },
      'filled',
    );
    await seedOrder(
      store,
      { clientOrderId: 'b', algorithmId: 'algo-1', symbol: '000660' },
      'accepted',
    );
    await seedOrder(
      store,
      { clientOrderId: 'c', algorithmId: 'algo-2', symbol: '000660' },
      'unknown',
    );
    await seedOrder(
      store,
      { clientOrderId: 'd', algorithmId: 'algo-2', symbol: '035420' },
      'rejected',
    );
    expect(
      (await store.listOrders({ algorithmId: 'algo-1' })).map((x) => x.clientOrderId).sort(),
    ).toEqual(['a', 'b']);
    expect(
      (await store.listOrders({ algorithmId: 'algo-1', symbol: '000660' })).map(
        (x) => x.clientOrderId,
      ),
    ).toEqual(['b']);
    expect((await store.listNonTerminalOrders()).map((x) => x.clientOrderId).sort()).toEqual([
      'b',
      'c',
    ]);
  });
  it('records blocked orders without touching counters', async () => {
    const { store } = build();
    await store.recordBlocked({
      id: 'blocked-1',
      algorithmId: 'algo-1',
      runId: 'r',
      market: 'KR',
      symbol: '005930',
      side: 'buy',
      quantity: 1,
      price: '1',
      tranche: 0,
      reasons: ['LIQUIDITY_BELOW_MINIMUM'],
      dateKey: '2026-10-21',
      createdAt: NOW.toISOString(),
    });
    expect(await store.getDailyCounts('2026-10-21', 'algo-1')).toEqual({ algorithm: 0, global: 0 });
  });
  it('one working order per algorithm+symbol: the lock is held until the order is terminal', async () => {
    const { store } = build();
    expect(await reserve(store, { clientOrderId: 'first' })).toEqual({ ok: true });
    // Reserved but not yet confirmed: unreconciled.
    expect(await reserve(store, { clientOrderId: 'second' })).toEqual({
      ok: false,
      reason: 'symbol-unreconciled',
    });
    await store.updateOrder('first', { status: 'accepted', orderId: 'b-1' });
    expect(await reserve(store, { clientOrderId: 'second' })).toEqual({
      ok: false,
      reason: 'symbol-open',
    });
    await store.updateOrder('first', { status: 'partially-filled', filledQuantity: 3 });
    expect(await reserve(store, { clientOrderId: 'second' })).toEqual({
      ok: false,
      reason: 'symbol-open',
    });
    // Other symbol and other algorithm are independent.
    expect(await reserve(store, { clientOrderId: 'other-symbol', symbol: '000660' })).toEqual({
      ok: true,
    });
    expect(await reserve(store, { clientOrderId: 'other-algo', algorithmId: 'algo-2' })).toEqual({
      ok: true,
    });
    await store.updateOrder('first', { status: 'filled', filledQuantity: 10 });
    expect(await reserve(store, { clientOrderId: 'second', side: 'sell', quantity: 10 })).toEqual({
      ok: true,
    });
  });
  it('an unknown outcome keeps the lock; every terminal status releases it', async () => {
    for (const terminal of ['rejected', 'filled', 'canceled'] as const) {
      const { store } = build();
      await reserve(store, { clientOrderId: 'first' });
      await store.updateOrder('first', { status: 'unknown' });
      expect(await reserve(store, { clientOrderId: 'second' })).toEqual({
        ok: false,
        reason: 'symbol-unreconciled',
      });
      await store.updateOrder('first', { status: terminal });
      expect(await reserve(store, { clientOrderId: 'second' })).toEqual({ ok: true });
    }
  });
  it('the budget is re-checked against the freshly read ledger at reservation time', async () => {
    const { store } = build();
    // 1,000,000 budget; 700,000 already committed to a working buy of another symbol.
    expect(
      await reserve(store, { clientOrderId: 'b1', symbol: 'S1' }, { a: 5, g: 10 }, 1_000_000),
    ).toEqual({ ok: true });
    expect(
      await reserve(store, { clientOrderId: 'b2', symbol: 'S2' }, { a: 5, g: 10 }, 1_000_000),
    ).toEqual({ ok: false, reason: 'budget-exceeded' });
    // A smaller buy still fits (300,000 = 10 * 30,000).
    expect(
      await reserve(
        store,
        { clientOrderId: 'b3', symbol: 'S3', price: '30000' },
        { a: 5, g: 10 },
        1_000_000,
      ),
    ).toEqual({ ok: true });
    // Filled holdings count at cost; a rejected order frees its commitment.
    await store.updateOrder('b1', { status: 'rejected' });
    expect(
      await reserve(store, { clientOrderId: 'b4', symbol: 'S4' }, { a: 5, g: 10 }, 1_000_000),
    ).toEqual({ ok: true });
  });
  it('a sell cannot exceed the shares the algorithm owns, re-read inside the reservation', async () => {
    const { store } = build();
    await reserve(store, { clientOrderId: 'buy' });
    await store.updateOrder('buy', { status: 'accepted', orderId: 'b-1' });
    await store.updateOrder('buy', { status: 'filled', filledQuantity: 10 });
    expect(await reserve(store, { clientOrderId: 's1', side: 'sell', quantity: 11 })).toEqual({
      ok: false,
      reason: 'sell-exceeds-owned',
    });
    expect(
      await reserve(store, { clientOrderId: 's2', side: 'sell', quantity: 4, symbol: '000660' }),
    ).toEqual({ ok: false, reason: 'sell-exceeds-owned' }); // owns nothing of that symbol
    expect(await reserve(store, { clientOrderId: 's3', side: 'sell', quantity: 10 })).toEqual({
      ok: true,
    });
  });
  it('run lease: one run at a time, same run may re-acquire, it expires, release is by owner', async () => {
    const { store } = build();
    const ttl = 600_000;
    expect(await store.acquireRunLease('algo-1', 'run-a', ttl)).toBe(true);
    expect(await store.acquireRunLease('algo-1', 'run-b', ttl)).toBe(false);
    expect(await store.acquireRunLease('algo-1', 'run-a', ttl)).toBe(true); // restart of the same run
    expect(await store.acquireRunLease('algo-2', 'run-b', ttl)).toBe(true); // other algorithms are independent
    await store.releaseRunLease('algo-1', 'run-b'); // not the owner: no effect
    expect(await store.acquireRunLease('algo-1', 'run-b', ttl)).toBe(false);
    await store.releaseRunLease('algo-1', 'run-a');
    expect(await store.acquireRunLease('algo-1', 'run-b', ttl)).toBe(true);
    clockNow = new Date(NOW.getTime() + ttl + 1);
    expect(await store.acquireRunLease('algo-1', 'run-c', ttl)).toBe(true); // b's lease expired
    await expect(store.acquireRunLease('a/b', 'run-a', ttl)).rejects.toThrow();
    await expect(store.acquireRunLease('algo-1', 'run-a', 0)).rejects.toThrow();
  });
  it(`${name}: returned records are copies`, async () => {
    const { store } = build();
    await reserve(store);
    const a = (await store.getOrder('ai-1'))!;
    a.quantity = 999;
    expect((await store.getOrder('ai-1'))!.quantity).toBe(10);
  });
});

describe('FirestoreTradingStore specifics', () => {
  it('concurrent reservations cannot exceed the global limit (transactional counters)', async () => {
    const { db, store } = makeFirestore();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        store.reserveOrder({
          record: record({ clientOrderId: `c-${i}`, algorithmId: `alg-${i}` }),
          maxPerAlgorithm: 3,
          maxGlobal: 3,
          budget: Number.POSITIVE_INFINITY,
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(
      results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'daily-limit-global'),
    ).toBe(true);
    expect(db.docs.get('tradingCounters/2026-10-21_global')?.data.count).toBe(3);
    expect(db.transactionRuns).toBeGreaterThan(6); // conflicts were retried
  });
  it('concurrent reservations cannot exceed the per-algorithm limit', async () => {
    const { store } = makeFirestore();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        reserve(store, { clientOrderId: `c-${i}`, symbol: `S${i}` }, { a: 2, g: 10 }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });
  it('the stop flag flipped while reservations race is honoured by whoever commits after it', async () => {
    const { db, store } = makeFirestore();
    const first = reserve(store, { clientOrderId: 'one' });
    db.write('algorithmControl/global', { emergencyStop: true });
    const second = reserve(store, { clientOrderId: 'two', symbol: 'S2' });
    const [a, b] = await Promise.all([first, second]);
    // Whatever interleaving happened, nothing was reserved after the flag was set.
    expect([a, b].some((r) => !r.ok && r.reason === 'emergency-stop')).toBe(true);
    expect(db.docs.has('liveOrders/two')).toBe(false);
  });
  it('two reservations racing for the same algorithm+symbol: exactly one succeeds', async () => {
    const { db, store } = makeFirestore();
    const results = await Promise.all([
      reserve(store, { clientOrderId: 'run-a-order' }),
      reserve(store, { clientOrderId: 'run-b-order' }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ reason: 'symbol-unreconciled' });
    expect([...db.docs.keys()].filter((k) => k.startsWith('liveOrders/'))).toHaveLength(1);
    expect(db.docs.get('tradingCounters/2026-10-21_global')?.data.count).toBe(1);
  });
  it('racing buys on different symbols cannot jointly exceed the budget', async () => {
    const { store } = makeFirestore();
    const results = await Promise.all(
      ['S1', 'S2', 'S3'].map((symbol, i) =>
        reserve(store, { clientOrderId: `b-${i}`, symbol }, { a: 5, g: 10 }, 1_000_000),
      ),
    );
    // 700,000 each: only one fits in 1,000,000.
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'budget-exceeded')).toBe(
      true,
    );
  });
  it('the lock document is removed by the terminal transition in the same transaction', async () => {
    const { db, store } = makeFirestore();
    await reserve(store, { clientOrderId: 'first' });
    expect(db.docs.has('tradingSymbolLocks/algo-1_005930')).toBe(true);
    await store.updateOrder('first', { status: 'accepted', orderId: 'b-1' });
    expect(db.docs.has('tradingSymbolLocks/algo-1_005930')).toBe(true);
    await store.updateOrder('first', { status: 'canceled' });
    expect(db.docs.has('tradingSymbolLocks/algo-1_005930')).toBe(false);
  });
  it('a stale lock whose owner is terminal does not block (and is replaced)', async () => {
    const { db, store } = makeFirestore();
    await reserve(store, { clientOrderId: 'first' });
    await store.updateOrder('first', { status: 'rejected' });
    db.write('tradingSymbolLocks/algo-1_005930', { clientOrderId: 'first' });
    expect(await reserve(store, { clientOrderId: 'second' })).toEqual({ ok: true });
    expect(db.docs.get('tradingSymbolLocks/algo-1_005930')?.data.clientOrderId).toBe('second');
  });
  it('a lock whose owner document is missing is treated as unreconciled', async () => {
    const { db, store } = makeFirestore();
    db.write('tradingSymbolLocks/algo-1_005930', { clientOrderId: 'ghost' });
    expect(await reserve(store)).toEqual({ ok: false, reason: 'symbol-unreconciled' });
  });
  it('lock and lease document ids are validated', async () => {
    const { store } = makeFirestore();
    await expect(reserve(store, { symbol: '..' })).rejects.toThrow();
    await expect(reserve(store, { symbol: 'a/b' })).rejects.toThrow();
    await expect(store.acquireRunLease('../x', 'run', 1000)).rejects.toThrow();
  });
  it('a malformed emergency-stop document fails closed (throws) instead of reading as false', async () => {
    const { db, store } = makeFirestore();
    db.write('algorithmControl/global', { emergencyStop: 'yes' });
    await expect(store.getEmergencyStop()).rejects.toThrow();
    await expect(reserve(store)).rejects.toThrow();
  });
  it('a corrupted stored order is an error, not a silently wrong value', async () => {
    const { db, store } = makeFirestore();
    db.write('liveOrders/bad', { clientOrderId: 'bad', status: 'weird' });
    await expect(store.getOrder('bad')).rejects.toThrow();
    expect(() => parseLiveOrder({ ...record(), market: 'JP' })).toThrow();
    expect(() => parseLiveOrder({ ...record(), side: 'hold' })).toThrow();
    expect(() => parseLiveOrder({ ...record(), quantity: 'ten' })).toThrow();
    expect(parseLiveOrder(record())).toMatchObject({ clientOrderId: 'ai-1' });
  });
  it('document ids are validated before use', async () => {
    const { store } = makeFirestore();
    await expect(store.getOrder('../x')).rejects.toThrow();
    await expect(store.getDailyCounts('tomorrow', 'algo-1')).rejects.toThrow();
  });
  it('writes no undefined values (Firestore would reject them)', async () => {
    const { db, store } = makeFirestore();
    await reserve(store);
    await store.updateOrder('ai-1', { status: 'accepted', orderId: 'b-1' });
    expect(JSON.stringify(db.docs.get('liveOrders/ai-1')?.data)).not.toContain('undefined');
  });
});
