import { Firestore } from '@google-cloud/firestore';
import {
  ALGORITHM_ID,
  NON_TERMINAL_STATUSES,
  applyPatch,
  decideReserve,
  type BlockedOrderRecord,
  type LiveOrderRecord,
  type LiveOrderStatus,
  type OrderPatch,
  type ReserveInput,
  type ReserveResult,
  type TradingStore,
} from './stores.js';

/**
 * Firestore implementation of the trading store (plan stage 7d). UNWIRED. Collections are
 * server-only (the project's Firestore rules deny all client SDK access):
 *   liveOrders/{clientOrderId}              one document per reserved order
 *   tradingControl/emergencyStop            { active: boolean }  (absent = not stopped)
 *   tradingAlgorithmState/{algorithmId}     { stopped: true, reason }
 *   tradingCounters/{dateKey}_global        { count }
 *   tradingCounters/{dateKey}_a_{id}        { count }
 *   blockedOrders/{autoId}                  pre-trade refusals (never counted)
 *
 * `reserveOrder` is ONE transaction that reads the emergency stop, the algorithm state, both
 * counters and the order document, and then writes the counters and the order: the stop flag and
 * the daily counters cannot be raced by another job instance.
 */
const STATUSES: readonly LiveOrderStatus[] = [
  'reserved',
  'accepted',
  'unknown',
  'rejected',
  'partially-filled',
  'filled',
  'canceled',
];

function clean<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Defensive projection: a malformed stored document is an error (callers fail closed). */
export function parseLiveOrder(data: unknown): LiveOrderRecord {
  if (!data || typeof data !== 'object') throw new Error('Invalid stored order');
  const d = data as Record<string, unknown>;
  const text = (k: string) => {
    if (typeof d[k] !== 'string' || !d[k]) throw new Error(`Invalid stored order field ${k}`);
    return d[k] as string;
  };
  const num = (k: string) => {
    if (typeof d[k] !== 'number' || !Number.isFinite(d[k]))
      throw new Error(`Invalid stored order field ${k}`);
    return d[k] as number;
  };
  const status = text('status') as LiveOrderStatus;
  if (!STATUSES.includes(status)) throw new Error('Invalid stored order status');
  if (d.market !== 'KR' && d.market !== 'US') throw new Error('Invalid stored order market');
  if (d.side !== 'buy' && d.side !== 'sell') throw new Error('Invalid stored order side');
  if (d.currency !== 'KRW' && d.currency !== 'USD')
    throw new Error('Invalid stored order currency');
  return clean({
    clientOrderId: text('clientOrderId'),
    wireClientOrderId: typeof d.wireClientOrderId === 'string' ? d.wireClientOrderId : undefined,
    orderId: typeof d.orderId === 'string' ? d.orderId : undefined,
    algorithmId: text('algorithmId'),
    runId: text('runId'),
    market: d.market,
    symbol: text('symbol'),
    side: d.side,
    quantity: num('quantity'),
    price: text('price'),
    currency: d.currency,
    tranche: num('tranche'),
    status,
    dateKey: text('dateKey'),
    createdAt: text('createdAt'),
    updatedAt: text('updatedAt'),
    filledQuantity: num('filledQuantity'),
    averageFilledPrice: typeof d.averageFilledPrice === 'number' ? d.averageFilledPrice : undefined,
    tickCorrected: typeof d.tickCorrected === 'boolean' ? d.tickCorrected : undefined,
    error:
      d.error && typeof d.error === 'object' ? (d.error as LiveOrderRecord['error']) : undefined,
    notifiedStatus: STATUSES.includes(d.notifiedStatus as LiveOrderStatus)
      ? (d.notifiedStatus as LiveOrderStatus)
      : undefined,
  }) as LiveOrderRecord;
}

export class FirestoreTradingStore implements TradingStore {
  constructor(
    private readonly db: Firestore = new Firestore(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private control() {
    return this.db.collection('tradingControl').doc('emergencyStop');
  }
  private algorithmState(id: string) {
    if (!ALGORITHM_ID.test(id)) throw new Error('Invalid algorithm id');
    return this.db.collection('tradingAlgorithmState').doc(id);
  }
  private counter(dateKey: string, algorithmId?: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error('Invalid date key');
    if (algorithmId === undefined)
      return this.db.collection('tradingCounters').doc(`${dateKey}_global`);
    if (!ALGORITHM_ID.test(algorithmId)) throw new Error('Invalid algorithm id');
    return this.db.collection('tradingCounters').doc(`${dateKey}_a_${algorithmId}`);
  }
  private orderRef(clientOrderId: string) {
    if (!/^[a-zA-Z0-9\-_]{1,36}$/.test(clientOrderId)) throw new Error('Invalid client order id');
    return this.db.collection('liveOrders').doc(clientOrderId);
  }

  /** Operator/test control. The 7e screen wires its own authenticated writer and notification. */
  async setEmergencyStop(active: boolean) {
    await this.control().set({ active, updatedAt: this.clock().toISOString() });
  }

  /** Always a fresh server read: never cached. A missing document means "not stopped". */
  async getEmergencyStop() {
    const snapshot = await this.control().get();
    if (!snapshot.exists) return false;
    const active = snapshot.data()?.active;
    if (typeof active !== 'boolean') throw new Error('Invalid emergency stop document');
    return active;
  }
  async isAlgorithmStopped(algorithmId: string) {
    return (await this.algorithmState(algorithmId).get()).exists;
  }
  async stopAlgorithm(algorithmId: string, reason: string) {
    await this.algorithmState(algorithmId).set(
      { stopped: true, reason: reason.slice(0, 64), stoppedAt: this.clock().toISOString() },
      { merge: true },
    );
  }
  async getDailyCounts(dateKey: string, algorithmId: string) {
    const [a, g] = await Promise.all([
      this.counter(dateKey, algorithmId).get(),
      this.counter(dateKey).get(),
    ]);
    const count = (s: { exists: boolean; data(): Record<string, unknown> | undefined }) =>
      s.exists && typeof s.data()?.count === 'number' ? (s.data()!.count as number) : 0;
    return { algorithm: count(a), global: count(g) };
  }

  async reserveOrder(input: ReserveInput): Promise<ReserveResult> {
    const r = input.record;
    if (r.status !== 'reserved') throw new Error('Invalid reservation');
    const control = this.control();
    const state = this.algorithmState(r.algorithmId);
    const algorithmCounter = this.counter(r.dateKey, r.algorithmId);
    const globalCounter = this.counter(r.dateKey);
    const order = this.orderRef(r.clientOrderId);
    return this.db.runTransaction(async (tx) => {
      // All reads first, then all writes (Firestore transaction rule).
      const [c, s, a, g, o] = await Promise.all([
        tx.get(control),
        tx.get(state),
        tx.get(algorithmCounter),
        tx.get(globalCounter),
        tx.get(order),
      ]);
      const active = c.exists ? c.data()?.active : false;
      if (typeof active !== 'boolean') throw new Error('Invalid emergency stop document');
      const count = (snap: typeof a) =>
        snap.exists && typeof snap.data()?.count === 'number' ? (snap.data()!.count as number) : 0;
      const algorithmCount = count(a);
      const globalCount = count(g);
      const failure = decideReserve({
        emergencyStop: active,
        algorithmStopped: s.exists,
        algorithmCount,
        globalCount,
        exists: o.exists,
        maxPerAlgorithm: input.maxPerAlgorithm,
        maxGlobal: input.maxGlobal,
      });
      if (failure) return { ok: false as const, reason: failure };
      tx.set(algorithmCounter, { count: algorithmCount + 1, dateKey: r.dateKey });
      tx.set(globalCounter, { count: globalCount + 1, dateKey: r.dateKey });
      tx.create(order, clean({ ...r }));
      return { ok: true as const };
    });
  }

  async updateOrder(clientOrderId: string, patch: OrderPatch) {
    const ref = this.orderRef(clientOrderId);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) throw new Error('Unknown order');
      const next = applyPatch(parseLiveOrder(snapshot.data()), patch, this.clock().toISOString());
      tx.set(ref, clean({ ...next }));
      return next;
    });
  }
  async getOrder(clientOrderId: string) {
    const snapshot = await this.orderRef(clientOrderId).get();
    return snapshot.exists ? parseLiveOrder(snapshot.data()) : null;
  }
  async listOrders(filter: { algorithmId: string; symbol?: string }) {
    if (!ALGORITHM_ID.test(filter.algorithmId)) throw new Error('Invalid algorithm id');
    const result = await this.db
      .collection('liveOrders')
      .where('algorithmId', '==', filter.algorithmId)
      .get();
    return result.docs
      .map((d) => parseLiveOrder(d.data()))
      .filter((o) => !filter.symbol || o.symbol === filter.symbol);
  }
  async listNonTerminalOrders() {
    const result = await this.db
      .collection('liveOrders')
      .where('status', 'in', [...NON_TERMINAL_STATUSES])
      .get();
    return result.docs.map((d) => parseLiveOrder(d.data()));
  }
  async recordBlocked(record: BlockedOrderRecord) {
    await this.db
      .collection('blockedOrders')
      .doc(record.id)
      .set(clean({ ...record }));
  }
}
