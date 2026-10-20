import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';
import { FirestoreAlgorithmRepository } from '../src/server/algorithms';
import {
  CombinedAlgorithmFills,
  LiveAlgorithmFills,
  PaperAlgorithmFills,
  type AlgorithmFillSource,
} from '../src/server/algorithm-fills';
import { FirestoreTradingStore, parseAccessCheck } from '../src/server/trading/firestore-store';
import { FALLBACK_COMMISSION_RATE, liveCumulativePnl } from '../src/server/trading/ledger-pnl';
import {
  MemoryTradingStore,
  type AccessCheckStatus,
  type BlockedOrderRecord,
  type LiveJobHeartbeat,
  type LiveOrderRecord,
  type TradingStore,
} from '../src/server/trading/stores';
import { FakeFirestore } from './support/fake-firestore';
import { NOW, seedOrder } from './support/fake-toss';

// Synthetic data only.
const makeFirestore = () => {
  const db = new FakeFirestore();
  return { db, store: new FirestoreTradingStore(db as unknown as Firestore, () => NOW) };
};
const implementations: [string, () => { store: TradingStore; db?: FakeFirestore }][] = [
  ['memory', () => ({ store: new MemoryTradingStore(() => NOW) })],
  ['firestore (fake client)', makeFirestore],
];

const blocked = (over: Partial<BlockedOrderRecord> = {}): BlockedOrderRecord => ({
  id: 'b1',
  algorithmId: 'algo-1',
  runId: 'run-1',
  market: 'KR',
  symbol: '005930',
  side: 'buy',
  quantity: 10,
  price: '70000',
  tranche: 0,
  reasons: ['HISTORY_INSUFFICIENT'],
  dateKey: '2026-10-21',
  createdAt: '2026-10-21T00:05:00.000Z',
  ...over,
});
const access = (over: Partial<AccessCheckStatus> = {}): AccessCheckStatus => ({
  checkedAt: '2026-10-21T00:00:00.000Z',
  allOk: false,
  permissionDenied: true,
  probes: {
    buyingPowerKrw: { ok: true },
    buyingPowerUsd: { ok: false, code: 'forbidden', status: 403 },
    commissions: { ok: true },
    openOrders: { ok: false, code: 'http-500', status: 500 },
  },
  ...over,
});

describe.each(implementations)('trading status store: %s', (_name, make) => {
  it('reports and releases an algorithm stop, once', async () => {
    const { store } = make();
    expect(await store.getAlgorithmStop('algo-1')).toBeNull();
    expect(await store.releaseAlgorithmStop('algo-1')).toBe(false);
    await store.stopAlgorithm('algo-1', 'first-order-rejected');
    expect(await store.getAlgorithmStop('algo-1')).toEqual({
      reason: 'first-order-rejected',
      stoppedAt: NOW.toISOString(),
    });
    expect(await store.isAlgorithmStopped('algo-1')).toBe(true);
    expect(await store.releaseAlgorithmStop('algo-1')).toBe(true);
    expect(await store.isAlgorithmStopped('algo-1')).toBe(false);
    expect(await store.getAlgorithmStop('algo-1')).toBeNull();
    expect(await store.releaseAlgorithmStop('algo-1')).toBe(false);
  });
  it('a released algorithm can place orders again but keeps its history', async () => {
    const { store } = make();
    await seedOrder(store, { clientOrderId: 'ai-1' }, 'filled');
    await store.stopAlgorithm('algo-1', 'loss-limit');
    await store.releaseAlgorithmStop('algo-1');
    expect(await store.listOrders({ algorithmId: 'algo-1' })).toHaveLength(1);
  });
  it('lists the newest blocked orders of one algorithm', async () => {
    const { store } = make();
    await store.recordBlocked(blocked({ id: 'b1', createdAt: '2026-10-21T00:05:00.000Z' }));
    await store.recordBlocked(blocked({ id: 'b2', createdAt: '2026-10-21T00:06:00.000Z' }));
    await store.recordBlocked(blocked({ id: 'b3', algorithmId: 'other' }));
    expect((await store.listRecentBlocked('algo-1', 10)).map((b) => b.id)).toEqual(['b2', 'b1']);
    expect((await store.listRecentBlocked('algo-1', 1)).map((b) => b.id)).toEqual(['b2']);
    expect(await store.listRecentBlocked('nobody', 10)).toEqual([]);
  });
  it('keeps the access check result and the live job heartbeat per market', async () => {
    const { store } = make();
    expect(await store.getAccessCheck()).toBeNull();
    expect(await store.getJobHeartbeat('KR')).toBeNull();
    await store.putAccessCheck(access());
    expect(await store.getAccessCheck()).toEqual(access());
    const beat: LiveJobHeartbeat = {
      market: 'KR',
      at: '2026-10-21T00:05:00.000Z',
      date: '2026-10-21',
      outcome: 'ok',
    };
    await store.putJobHeartbeat(beat);
    await store.putJobHeartbeat({
      market: 'US',
      at: '2026-10-20T13:35:00.000Z',
      date: null,
      outcome: 'skipped',
      code: 'OUTSIDE_OPEN_WINDOW',
    });
    expect(await store.getJobHeartbeat('KR')).toEqual(beat);
    expect(await store.getJobHeartbeat('US')).toMatchObject({ code: 'OUTSIDE_OPEN_WINDOW' });
  });
  it('lists orders of one symbol across algorithms', async () => {
    const { store } = make();
    await seedOrder(store, { clientOrderId: 'ai-1', algorithmId: 'algo-1' }, 'filled');
    await seedOrder(
      store,
      { clientOrderId: 'ai-2', algorithmId: 'algo-2', symbol: '000660' },
      'filled',
    );
    const orders = await store.listOrdersBySymbol('005930', 50);
    expect(orders.map((o) => o.clientOrderId)).toEqual(['ai-1']);
  });
});

describe('Firestore trading store: stored documents are parsed defensively', () => {
  it('ignores a malformed access check or heartbeat instead of trusting it', async () => {
    const { db, store } = makeFirestore();
    db.write('tradingStatus/accessCheck', { allOk: 'yes' });
    expect(await store.getAccessCheck()).toBeNull();
    db.write('tradingStatus/liveJob_KR', { market: 'US', at: 'x', outcome: 'ok' });
    expect(await store.getJobHeartbeat('KR')).toBeNull();
    expect(parseAccessCheck({ ...access(), probes: { ...access().probes, commissions: 1 } })).toBe(
      null,
    );
    // Unsafe codes are dropped rather than echoed.
    const parsed = parseAccessCheck({
      ...access(),
      probes: {
        ...access().probes,
        buyingPowerUsd: { ok: false, code: 'Bearer abc <script>', status: 403 },
      },
    });
    expect(parsed?.probes.buyingPowerUsd).toEqual({ ok: false, status: 403 });
  });
  it('rejects a path-like symbol or market', async () => {
    const { store } = makeFirestore();
    await expect(store.listOrdersBySymbol('../x', 5)).rejects.toThrow();
    await expect(store.getJobHeartbeat('KR/../x' as never)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('one emergency-stop flag for the screen and the order path', () => {
  const event = (id: string, kind: 'emergency-stop' | 'emergency-release') => ({
    id,
    at: NOW.toISOString(),
    kind,
    changes: [],
  });
  it('the screen button (AlgorithmRepository.setControl) is what the order store reads', async () => {
    const db = new FakeFirestore();
    const screen = new FirestoreAlgorithmRepository(db as unknown as Firestore);
    const orders = new FirestoreTradingStore(db as unknown as Firestore, () => NOW);
    expect(await orders.getEmergencyStop()).toBe(false);
    await screen.setControl(true, NOW.toISOString(), event('e1', 'emergency-stop'));
    expect(await orders.getEmergencyStop()).toBe(true);
    // And the reservation inside the order transaction refuses.
    const record: LiveOrderRecord = {
      clientOrderId: 'ai-1',
      algorithmId: 'algo-1',
      runId: 'run-1',
      market: 'KR',
      symbol: '005930',
      side: 'buy',
      quantity: 1,
      price: '70000',
      currency: 'KRW',
      tranche: 0,
      status: 'reserved',
      dateKey: '2026-10-21',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      filledQuantity: 0,
    };
    expect(
      await orders.reserveOrder({ record, maxPerAlgorithm: 3, maxGlobal: 10, budget: 1e9 }),
    ).toEqual({ ok: false, reason: 'emergency-stop' });
    await screen.setControl(false, NOW.toISOString(), event('e2', 'emergency-release'));
    expect(await orders.getEmergencyStop()).toBe(false);
    expect(
      await orders.reserveOrder({ record, maxPerAlgorithm: 3, maxGlobal: 10, budget: 1e9 }),
    ).toEqual({ ok: true });
  });
  it('the order store itself writes the same document the screen reads', async () => {
    const db = new FakeFirestore();
    const screen = new FirestoreAlgorithmRepository(db as unknown as Firestore);
    const orders = new FirestoreTradingStore(db as unknown as Firestore, () => NOW);
    await orders.setEmergencyStop(true);
    expect((await screen.getControl()).emergencyStop).toBe(true);
  });
  it('both modules name the same collection and document, and nothing names the old one', () => {
    const algorithms = readFileSync('src/server/algorithms.ts', 'utf8');
    const store = readFileSync('src/server/trading/firestore-store.ts', 'utf8');
    for (const text of [algorithms, store]) {
      expect(text).toMatch(/collection\('algorithmControl'\)\.doc\('global'\)/);
      expect(text).not.toContain('tradingControl');
    }
  });
});

// ---------------------------------------------------------------------------
describe('chart markers: live (실제) and paper (가상) fills', () => {
  const liveOrder = (over: Record<string, unknown> = {}) => ({
    clientOrderId: 'ai-1',
    algorithmId: 'a1',
    market: 'KR' as const,
    symbol: '005930',
    side: 'buy' as const,
    status: 'filled',
    price: '70000',
    filledQuantity: 12,
    averageFilledPrice: 69_900 as number | null,
    dateKey: '2026-10-19',
    updatedAt: '2026-10-19T00:30:00.000Z',
    ...over,
  });
  it('draws filled quantity at the average fill price, labelled live; unfilled orders are not fills', async () => {
    const source = new LiveAlgorithmFills(
      {
        listOrdersBySymbol: async () => [
          liveOrder(),
          liveOrder({ clientOrderId: 'ai-2', status: 'accepted', filledQuantity: 0 }),
          liveOrder({
            clientOrderId: 'ai-3',
            status: 'canceled',
            filledQuantity: 4,
            averageFilledPrice: null,
            side: 'sell',
          }),
          liveOrder({ clientOrderId: 'ai-4', dateKey: '2026-09-01' }),
          liveOrder({ clientOrderId: 'ai-5', market: 'US', symbol: 'AAPL', price: '101.25' }),
        ],
      },
      { list: async () => [{ id: 'a1', name: '모멘텀 A' }] },
    );
    const fills = await source.listFills('005930', '2026-10-01', '2026-10-31');
    expect(source.connected).toBe(true);
    expect(fills.map((f) => [f.id, f.mode, f.side, f.price, f.quantity, f.currency])).toEqual([
      ['ai-1', 'live', 'buy', '69900', '12', 'KRW'],
      ['ai-3', 'live', 'sell', '70000', '4', 'KRW'],
      ['ai-5', 'live', 'buy', '69900', '12', 'USD'],
    ]);
    expect(fills[0]).toMatchObject({ algorithmName: '모멘텀 A', date: '2026-10-19' });
  });
  it('combines paper and live fills, and a failing source does not hide the other', async () => {
    const paper = new PaperAlgorithmFills(
      {
        listTradesBySymbol: async () => [
          {
            id: 't1',
            algorithmId: 'a1',
            market: 'KR',
            symbol: '005930',
            side: 'buy',
            quantity: 3,
            price: 70_100,
            date: '2026-10-20',
            createdAt: '2026-10-20T00:05:00.000Z',
            mode: 'paper',
          },
        ],
      },
      { list: async () => [{ id: 'a1', name: '모멘텀 A' }] },
    );
    const live = new LiveAlgorithmFills(
      { listOrdersBySymbol: async () => [liveOrder()] },
      { list: async () => [{ id: 'a1', name: '모멘텀 A' }] },
    );
    const both = await new CombinedAlgorithmFills([paper, live]).listFills(
      '005930',
      '2026-10-01',
      '2026-10-31',
    );
    expect(both.map((f) => f.mode).sort()).toEqual(['live', 'paper']);
    const broken: AlgorithmFillSource = {
      connected: true,
      listFills: async () => {
        throw new Error('storage down');
      },
    };
    const partial = await new CombinedAlgorithmFills([broken, live]).listFills(
      '005930',
      '2026-10-01',
      '2026-10-31',
    );
    expect(partial.map((f) => f.mode)).toEqual(['live']);
  });
});

// ---------------------------------------------------------------------------
describe('live cumulative P&L (realized + unrealized, from the algorithm own orders)', () => {
  const order = (over: Partial<LiveOrderRecord>): LiveOrderRecord => ({
    clientOrderId: `ai-${Math.random()}`,
    algorithmId: 'algo-1',
    runId: 'run-1',
    market: 'KR',
    symbol: '005930',
    side: 'buy',
    quantity: 10,
    price: '70000',
    currency: 'KRW',
    tranche: 0,
    status: 'filled',
    dateKey: '2026-10-10',
    createdAt: '2026-10-10T01:00:00.000Z',
    updatedAt: '2026-10-10T01:00:00.000Z',
    filledQuantity: 10,
    ...over,
  });
  const free = { commissionRate: 0, sellTaxRate: 0 };
  it('is zero without orders and values what is held at the marks', () => {
    expect(liveCumulativePnl([], {}, free)).toBe(0);
    expect(liveCumulativePnl([order({})], { '005930': 77_000 }, free)).toBe(70_000);
    expect(liveCumulativePnl([order({})], { '005930': 63_000 }, free)).toBe(-70_000);
  });
  it('uses the average fill price, not the limit price', () => {
    expect(
      liveCumulativePnl([order({ averageFilledPrice: 69_000 })], { '005930': 70_000 }, free),
    ).toBe(10_000);
  });
  it('realized gains after a full round trip need no mark', () => {
    const orders = [
      order({ createdAt: '2026-10-10T01:00:00.000Z' }),
      order({
        side: 'sell',
        price: '75000',
        averageFilledPrice: 75_000,
        createdAt: '2026-10-17T01:00:00.000Z',
      }),
    ];
    expect(liveCumulativePnl(orders, {}, free)).toBe(50_000);
  });
  it('subtracts estimated commission on both sides and the sell tax', () => {
    const orders = [
      order({}),
      order({ side: 'sell', price: '75000', createdAt: '2026-10-17T01:00:00.000Z' }),
    ];
    // gross +50,000; commission 0.1% of 700,000 and of 750,000; tax 0.2% of 750,000.
    const pnl = liveCumulativePnl(orders, {}, { commissionRate: 0.001, sellTaxRate: 0.002 });
    expect(pnl).toBeCloseTo(50_000 - 700 - 750 - 1_500, 6);
  });
  it('counts only filled quantity: partial fills yes, working and rejected orders no', () => {
    const orders = [
      order({ status: 'partially-filled', filledQuantity: 4 }),
      order({ status: 'accepted', filledQuantity: 0, symbol: '000660' }),
      order({ status: 'rejected', filledQuantity: 0, symbol: '035720' }),
    ];
    expect(liveCumulativePnl(orders, { '005930': 71_000 }, free)).toBe(4_000);
  });
  it('is unknown (null) when a held symbol has no usable mark: the pre-trade check then refuses', () => {
    expect(liveCumulativePnl([order({})], {}, free)).toBeNull();
    expect(liveCumulativePnl([order({})], { '005930': 0 }, free)).toBeNull();
    expect(liveCumulativePnl([order({})], { '005930': Number.NaN }, free)).toBeNull();
    expect(liveCumulativePnl([order({ price: 'abc' })], { '005930': 1 }, free)).toBeNull();
  });
  it('the fallback commission is deliberately high', () => {
    expect(FALLBACK_COMMISSION_RATE).toBeGreaterThanOrEqual(0.003);
  });
});
