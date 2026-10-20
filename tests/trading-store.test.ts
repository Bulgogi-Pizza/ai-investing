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
  type LiveOrderRecord,
  type LiveOrderStatus,
  type TradingStore,
} from '../src/server/trading/stores';
import { NOW, seedOrder } from '../src/server/trading/testing';

// ---------------------------------------------------------------------------
// A tiny in-memory Firestore with optimistic transactions (reads are validated at commit and the
// callback is re-run on conflict, like the real client). It rejects `undefined` values the way the
// real client does by default.
// ---------------------------------------------------------------------------
type Stored = { data: Record<string, unknown>; version: number };
class FakeSnapshot {
  constructor(
    readonly exists: boolean,
    private readonly value: Record<string, unknown> | undefined,
    readonly id: string,
  ) {}
  data() {
    return this.value === undefined ? undefined : structuredClone(this.value);
  }
}
function assertNoUndefined(value: unknown, path = ''): void {
  if (value === undefined) throw new Error(`Cannot use undefined as a Firestore value (${path})`);
  if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) assertNoUndefined(v, `${path}.${k}`);
}
class FakeFirestore {
  readonly docs = new Map<string, Stored>();
  transactionRuns = 0;
  collection(name: string) {
    return {
      doc: (id: string) => {
        if (!id || id.includes('/')) throw new Error('Invalid document id');
        return new FakeRef(this, `${name}/${id}`);
      },
      where: (field: string, op: string, value: unknown) => ({
        get: async () => ({
          docs: [...this.docs.entries()]
            .filter(([path]) => path.startsWith(`${name}/`))
            .filter(([, s]) =>
              op === '==' ? s.data[field] === value : (value as unknown[]).includes(s.data[field]),
            )
            .map(([path, s]) => new FakeSnapshot(true, s.data, path.split('/')[1])),
        }),
      }),
    };
  }
  snapshot(path: string) {
    const s = this.docs.get(path);
    return new FakeSnapshot(!!s, s?.data, path.split('/')[1]);
  }
  version(path: string) {
    return this.docs.get(path)?.version ?? 0;
  }
  write(path: string, data: Record<string, unknown>, merge = false, create = false) {
    assertNoUndefined(data, path);
    const current = this.docs.get(path);
    if (create && current) throw new Error('ALREADY_EXISTS');
    this.docs.set(path, {
      data:
        merge && current ? { ...current.data, ...structuredClone(data) } : structuredClone(data),
      version: (current?.version ?? 0) + 1,
    });
  }
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 10; attempt++) {
      this.transactionRuns++;
      const reads = new Map<string, number>();
      const writes: Array<() => void> = [];
      const tx = {
        get: async (ref: FakeRef) => {
          // Read first, then yield: concurrent transactions all see the same starting state.
          reads.set(ref.path, this.version(ref.path));
          const snapshot = this.snapshot(ref.path);
          await new Promise((r) => setTimeout(r, 0));
          return snapshot;
        },
        set: (ref: FakeRef, data: Record<string, unknown>, options?: { merge?: boolean }) => {
          assertNoUndefined(data);
          writes.push(() => this.write(ref.path, data, options?.merge));
        },
        create: (ref: FakeRef, data: Record<string, unknown>) => {
          assertNoUndefined(data);
          writes.push(() => this.write(ref.path, data, false, true));
        },
      };
      const result = await fn(tx);
      if ([...reads].some(([path, v]) => this.version(path) !== v)) continue; // conflict: retry
      writes.forEach((w) => w());
      return result;
    }
    throw new Error('Too much contention');
  }
}
class FakeRef {
  constructor(
    private readonly db: FakeFirestore,
    readonly path: string,
  ) {}
  async get() {
    return this.db.snapshot(this.path);
  }
  async set(data: Record<string, unknown>, options?: { merge?: boolean }) {
    this.db.write(this.path, data, options?.merge);
  }
}

const makeFirestore = () => {
  const db = new FakeFirestore();
  return {
    db,
    store: new FirestoreTradingStore(db as unknown as Firestore, () => NOW),
    stop: (active: unknown) =>
      db.write('tradingControl/emergencyStop', { active } as Record<string, unknown>),
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
const reserve = (store: TradingStore, over: Partial<LiveOrderRecord> = {}, max = { a: 3, g: 10 }) =>
  store.reserveOrder({ record: record(over), maxPerAlgorithm: max.a, maxGlobal: max.g });

describe('pure helpers', () => {
  it('kstDateKey uses Korea time (UTC+9, no DST)', () => {
    expect(kstDateKey(new Date('2026-10-20T14:59:59Z'))).toBe('2026-10-20');
    expect(kstDateKey(new Date('2026-10-20T15:00:00Z'))).toBe('2026-10-21');
    expect(kstDateKey(new Date('2026-07-01T00:00:00Z'))).toBe('2026-07-01');
  });
  it('decideReserve: duplicate first, then stop flags, then limits', () => {
    const base = {
      emergencyStop: false,
      algorithmStopped: false,
      algorithmCount: 0,
      globalCount: 0,
      exists: false,
      maxPerAlgorithm: 3,
      maxGlobal: 10,
    };
    expect(decideReserve(base)).toBeNull();
    expect(decideReserve({ ...base, exists: true, emergencyStop: true })).toBe('duplicate');
    expect(decideReserve({ ...base, emergencyStop: true, algorithmStopped: true })).toBe(
      'emergency-stop',
    );
    expect(decideReserve({ ...base, algorithmStopped: true })).toBe('algorithm-stopped');
    expect(decideReserve({ ...base, algorithmCount: 3 })).toBe('daily-limit-algorithm');
    expect(decideReserve({ ...base, algorithmCount: 2 })).toBeNull();
    expect(decideReserve({ ...base, globalCount: 10 })).toBe('daily-limit-global');
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
  ['MemoryTradingStore', () => new MemoryTradingStore(() => NOW) as TradingStore],
  ['FirestoreTradingStore (fake Firestore)', () => makeFirestore().store as TradingStore],
] as const)('store contract: %s', (name, make) => {
  const build = () => {
    const store = make();
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
      expect(await reserve(store, { clientOrderId: `a-${i}` })).toEqual({ ok: true });
    expect(await reserve(store, { clientOrderId: 'a-3' })).toEqual({
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
      { clientOrderId: 'd', algorithmId: 'algo-2', symbol: '000660' },
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
        reserve(store, { clientOrderId: `c-${i}` }, { a: 2, g: 10 }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });
  it('the stop flag flipped while reservations race is honoured by whoever commits after it', async () => {
    const { db, store } = makeFirestore();
    const first = reserve(store, { clientOrderId: 'one' });
    db.write('tradingControl/emergencyStop', { active: true });
    const second = reserve(store, { clientOrderId: 'two' });
    const [a, b] = await Promise.all([first, second]);
    // Whatever interleaving happened, nothing was reserved after the flag was set.
    expect([a, b].some((r) => !r.ok && r.reason === 'emergency-stop')).toBe(true);
    expect(db.docs.has('liveOrders/two')).toBe(false);
  });
  it('a malformed emergency-stop document fails closed (throws) instead of reading as false', async () => {
    const { db, store } = makeFirestore();
    db.write('tradingControl/emergencyStop', { active: 'yes' });
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
