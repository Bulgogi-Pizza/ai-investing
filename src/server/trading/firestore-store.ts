import { Firestore } from '@google-cloud/firestore';
import {
  ALGORITHM_ID,
  NON_TERMINAL_STATUSES,
  TERMINAL_STATUSES,
  applyPatch,
  decideReserve,
  ledgerFacts,
  symbolLockState,
  type AccessCheckStatus,
  type AccessProbeStatus,
  type AlgorithmStop,
  type BlockedOrderRecord,
  type LiveJobHeartbeat,
  type LiveOrderRecord,
  type LiveOrderStatus,
  type OrderPatch,
  type ReserveInput,
  type ReserveResult,
  type TradingStore,
} from './stores.js';
import type { TradeMarket } from './toss-orders.js';

/**
 * Firestore implementation of the trading store (plan stage 7d). UNWIRED. Collections are
 * server-only (the project's Firestore rules deny all client SDK access):
 *   liveOrders/{clientOrderId}              one document per reserved order
 *   algorithmControl/global                 { emergencyStop: boolean, updatedAt }  (absent = not
 *                                           stopped). The SAME document the screen's emergency-stop
 *                                           button writes (AlgorithmRepository.setControl) and the
 *                                           paper job reads: there is exactly one flag.
 *   tradingAlgorithmState/{algorithmId}     { stopped: true, reason, stoppedAt }
 *   tradingStatus/accessCheck               result of the read-only access check job
 *   tradingStatus/liveJob_{KR|US}           heartbeat of the live job (see LiveJobHeartbeat)
 *   tradingCounters/{dateKey}_global        { count }
 *   tradingCounters/{dateKey}_a_{id}        { count }
 *   tradingSymbolLocks/{algorithmId}_{symbol}  { clientOrderId }  held from reservation until the
 *                                           order is terminal (one working order per algorithm+symbol)
 *   tradingRunLeases/{algorithmId}          { runId, expiresAt }  one executeRun at a time
 *   blockedOrders/{autoId}                  pre-trade refusals (never counted)
 *
 * `reserveOrder` is ONE transaction that reads the emergency stop, the algorithm state, both
 * counters, the order document, the symbol lock (and its owner) and the algorithm's orders, and
 * then writes the counters, the lock and the order: the stop flag, the daily counters, the
 * one-order-per-symbol rule, the budget and the sellable quantity cannot be raced by another job
 * instance, even one with a different run id.
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

const marketKey = (market: TradeMarket) => {
  if (market !== 'KR' && market !== 'US') throw new Error('Invalid market');
  return market;
};

const SAFE_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OUTCOMES = ['ok', 'partial', 'failed', 'skipped'] as const;
const PROBES = ['buyingPowerKrw', 'buyingPowerUsd', 'commissions', 'openOrders'] as const;

function parseProbe(value: unknown): AccessProbeStatus | null {
  if (!value || typeof value !== 'object') return null;
  const d = value as Record<string, unknown>;
  if (typeof d.ok !== 'boolean') return null;
  return {
    ok: d.ok,
    ...(typeof d.code === 'string' && SAFE_CODE.test(d.code) ? { code: d.code } : {}),
    ...(typeof d.status === 'number' && Number.isInteger(d.status) ? { status: d.status } : {}),
  };
}
/** Defensive projection of the access-check status document; null when it is not usable. */
export function parseAccessCheck(data: unknown): AccessCheckStatus | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const probes = d.probes as Record<string, unknown> | undefined;
  if (
    typeof d.checkedAt !== 'string' ||
    !Number.isFinite(Date.parse(d.checkedAt)) ||
    typeof d.allOk !== 'boolean' ||
    typeof d.permissionDenied !== 'boolean' ||
    !probes ||
    typeof probes !== 'object'
  )
    return null;
  const parsed: Record<string, AccessProbeStatus> = {};
  for (const key of PROBES) {
    const probe = parseProbe(probes[key]);
    if (!probe) return null;
    parsed[key] = probe;
  }
  return {
    checkedAt: d.checkedAt,
    allOk: d.allOk,
    permissionDenied: d.permissionDenied,
    probes: parsed as AccessCheckStatus['probes'],
  };
}
function parseHeartbeat(data: unknown, market: TradeMarket): LiveJobHeartbeat | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (
    d.market !== market ||
    typeof d.at !== 'string' ||
    !Number.isFinite(Date.parse(d.at)) ||
    !OUTCOMES.includes(d.outcome as (typeof OUTCOMES)[number])
  )
    return null;
  return {
    market,
    at: d.at,
    date: typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : null,
    outcome: d.outcome as LiveJobHeartbeat['outcome'],
    ...(typeof d.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(d.code)
      ? { code: d.code }
      : {}),
  };
}
function parseBlocked(data: unknown): BlockedOrderRecord | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (
    typeof d.id !== 'string' ||
    typeof d.algorithmId !== 'string' ||
    typeof d.runId !== 'string' ||
    (d.market !== 'KR' && d.market !== 'US') ||
    typeof d.symbol !== 'string' ||
    (d.side !== 'buy' && d.side !== 'sell') ||
    typeof d.quantity !== 'number' ||
    typeof d.price !== 'string' ||
    typeof d.tranche !== 'number' ||
    !Array.isArray(d.reasons) ||
    typeof d.dateKey !== 'string' ||
    typeof d.createdAt !== 'string'
  )
    return null;
  return {
    id: d.id,
    algorithmId: d.algorithmId,
    runId: d.runId,
    market: d.market,
    symbol: d.symbol,
    side: d.side,
    quantity: d.quantity,
    price: d.price,
    tranche: d.tranche,
    reasons: d.reasons.filter(
      (r): r is BlockedOrderRecord['reasons'][number] => typeof r === 'string',
    ),
    dateKey: d.dateKey,
    createdAt: d.createdAt,
  };
}

export class FirestoreTradingStore implements TradingStore {
  constructor(
    private readonly db: Firestore = new Firestore(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private control() {
    return this.db.collection('algorithmControl').doc('global');
  }
  private statusRef(name: string) {
    return this.db.collection('tradingStatus').doc(name);
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
  private lockRef(algorithmId: string, symbol: string) {
    if (!ALGORITHM_ID.test(algorithmId)) throw new Error('Invalid algorithm id');
    if (!/^[A-Za-z0-9.\-]{1,30}$/.test(symbol) || /^\.+$/.test(symbol))
      throw new Error('Invalid symbol');
    return this.db.collection('tradingSymbolLocks').doc(`${algorithmId}_${symbol}`);
  }
  private leaseRef(algorithmId: string) {
    if (!ALGORITHM_ID.test(algorithmId)) throw new Error('Invalid algorithm id');
    return this.db.collection('tradingRunLeases').doc(algorithmId);
  }
  private orderRef(clientOrderId: string) {
    if (!/^[a-zA-Z0-9\-_]{1,36}$/.test(clientOrderId)) throw new Error('Invalid client order id');
    return this.db.collection('liveOrders').doc(clientOrderId);
  }

  /** Operator/test control. The screen writes the same document through AlgorithmRepository. */
  async setEmergencyStop(active: boolean) {
    await this.control().set({ emergencyStop: active, updatedAt: this.clock().toISOString() });
  }

  /**
   * Always a fresh server read: never cached. A missing document means "not stopped"; a document
   * whose flag is not a boolean throws (the callers refuse to trade on any read problem).
   */
  async getEmergencyStop() {
    const snapshot = await this.control().get();
    if (!snapshot.exists) return false;
    const flag = snapshot.data()?.emergencyStop;
    if (typeof flag !== 'boolean') throw new Error('Invalid emergency stop document');
    return flag;
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
    const lock = this.lockRef(r.algorithmId, r.symbol);
    const algorithmOrders = this.db
      .collection('liveOrders')
      .where('algorithmId', '==', r.algorithmId);
    return this.db.runTransaction(async (tx) => {
      // All reads first, then all writes (Firestore transaction rule).
      const [c, s, a, g, o, l, mine] = await Promise.all([
        tx.get(control),
        tx.get(state),
        tx.get(algorithmCounter),
        tx.get(globalCounter),
        tx.get(order),
        tx.get(lock),
        tx.get(algorithmOrders),
      ]);
      const active = c.exists ? c.data()?.emergencyStop : false;
      if (typeof active !== 'boolean') throw new Error('Invalid emergency stop document');
      const count = (snap: typeof a) =>
        snap.exists && typeof snap.data()?.count === 'number' ? (snap.data()!.count as number) : 0;
      const algorithmCount = count(a);
      const globalCount = count(g);
      let ownerStatus: LiveOrderStatus | null = null;
      if (l.exists) {
        const ownerId = l.data()?.clientOrderId;
        if (typeof ownerId === 'string') {
          const owner = await tx.get(this.orderRef(ownerId));
          if (owner.exists) ownerStatus = parseLiveOrder(owner.data()).status;
        }
      }
      const facts = ledgerFacts(
        mine.docs.map((d) => parseLiveOrder(d.data())),
        r.symbol,
      );
      const failure = decideReserve({
        emergencyStop: active,
        algorithmStopped: s.exists,
        algorithmCount,
        globalCount,
        exists: o.exists,
        maxPerAlgorithm: input.maxPerAlgorithm,
        maxGlobal: input.maxGlobal,
        symbolLock: symbolLockState(l.exists, ownerStatus),
        side: r.side,
        quantity: r.quantity,
        notional: r.quantity * Number(r.price),
        budget: input.budget,
        committed: facts.committed,
        ownAvailable: facts.ownAvailable,
      });
      if (failure) return { ok: false as const, reason: failure };
      tx.set(algorithmCounter, { count: algorithmCount + 1, dateKey: r.dateKey });
      tx.set(globalCounter, { count: globalCount + 1, dateKey: r.dateKey });
      tx.set(lock, { clientOrderId: r.clientOrderId, createdAt: r.createdAt });
      tx.create(order, clean({ ...r }));
      return { ok: true as const };
    });
  }

  async updateOrder(clientOrderId: string, patch: OrderPatch) {
    const ref = this.orderRef(clientOrderId);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) throw new Error('Unknown order');
      const current = parseLiveOrder(snapshot.data());
      const lock = this.lockRef(current.algorithmId, current.symbol);
      const lockSnapshot = await tx.get(lock);
      const next = applyPatch(current, patch, this.clock().toISOString());
      tx.set(ref, clean({ ...next }));
      // A terminal order releases its (algorithm, symbol) lock in the same transaction.
      if (
        TERMINAL_STATUSES.includes(next.status) &&
        lockSnapshot.exists &&
        lockSnapshot.data()?.clientOrderId === clientOrderId
      )
        tx.delete(lock);
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
  async getAlgorithmStop(algorithmId: string): Promise<AlgorithmStop | null> {
    const snapshot = await this.algorithmState(algorithmId).get();
    if (!snapshot.exists) return null;
    const d = snapshot.data() ?? {};
    return {
      reason: typeof d.reason === 'string' ? d.reason.slice(0, 64) : 'unknown',
      stoppedAt: typeof d.stoppedAt === 'string' ? d.stoppedAt : null,
    };
  }
  async releaseAlgorithmStop(algorithmId: string) {
    const ref = this.algorithmState(algorithmId);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      tx.delete(ref);
      return true;
    });
  }
  async listRecentBlocked(algorithmId: string, limit: number) {
    if (!ALGORITHM_ID.test(algorithmId)) throw new Error('Invalid algorithm id');
    const result = await this.db
      .collection('blockedOrders')
      .where('algorithmId', '==', algorithmId)
      .get();
    return result.docs
      .map((d) => parseBlocked(d.data()))
      .filter((b): b is BlockedOrderRecord => b !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  async listOrdersBySymbol(symbol: string, limit: number) {
    if (!/^[A-Za-z0-9.\-]{1,30}$/.test(symbol) || /^\.+$/.test(symbol))
      throw new Error('Invalid symbol');
    // Equality filter only (single-field index); a symbol has few live orders.
    const result = await this.db.collection('liveOrders').where('symbol', '==', symbol).get();
    return result.docs.map((d) => parseLiveOrder(d.data())).slice(0, limit);
  }
  async getAccessCheck(): Promise<AccessCheckStatus | null> {
    const snapshot = await this.statusRef('accessCheck').get();
    return snapshot.exists ? parseAccessCheck(snapshot.data()) : null;
  }
  async putAccessCheck(status: AccessCheckStatus) {
    await this.statusRef('accessCheck').set(clean({ ...status }));
  }
  async getJobHeartbeat(market: TradeMarket): Promise<LiveJobHeartbeat | null> {
    const snapshot = await this.statusRef(`liveJob_${marketKey(market)}`).get();
    return snapshot.exists ? parseHeartbeat(snapshot.data(), market) : null;
  }
  async putJobHeartbeat(heartbeat: LiveJobHeartbeat) {
    await this.statusRef(`liveJob_${marketKey(heartbeat.market)}`).set(clean({ ...heartbeat }));
  }
  async acquireRunLease(algorithmId: string, runId: string, ttlMs: number) {
    if (!(ttlMs > 0) || !/^[A-Za-z0-9_-]{1,64}$/.test(runId)) throw new Error('Invalid lease');
    const ref = this.leaseRef(algorithmId);
    const now = this.clock().getTime();
    return this.db.runTransaction(async (tx) => {
      const held = (await tx.get(ref)).data();
      if (
        held &&
        typeof held.expiresAt === 'number' &&
        held.expiresAt > now &&
        held.runId !== runId
      )
        return false;
      tx.set(ref, { runId, expiresAt: now + ttlMs });
      return true;
    });
  }
  async releaseRunLease(algorithmId: string, runId: string) {
    const ref = this.leaseRef(algorithmId);
    await this.db.runTransaction(async (tx) => {
      const held = (await tx.get(ref)).data();
      if (held?.runId === runId) tx.delete(ref);
    });
  }
}
