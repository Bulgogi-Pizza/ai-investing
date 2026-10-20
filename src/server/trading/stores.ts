import type { OrderErrorInfo, TradeCurrency, TradeMarket, TradeSide } from './toss-orders.js';
import type { ReasonCode } from './reasons.js';

/**
 * Store interfaces for live trading (plan stage 7d) plus the in-memory implementation and the
 * pure ledger arithmetic both implementations share. The Firestore implementation is in
 * firestore-store.ts. UNWIRED: nothing in app/job code imports this module.
 */

export const currencyOf = (market: TradeMarket): TradeCurrency => (market === 'KR' ? 'KRW' : 'USD');

/** KST calendar date (`YYYY-MM-DD`). KST has no daylight saving, so a fixed +9h offset is exact. */
export function kstDateKey(date: Date): string {
  return new Date(date.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Algorithm ids are used in document ids and keys: keep them boring. */
export const ALGORITHM_ID = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// Live order lifecycle.
//   reserved   slot counted and recorded BEFORE the request is sent (write-ahead)
//   accepted   provider returned an orderId
//   rejected   definitive refusal (terminal)
//   unknown    the request may or may not have created an order; blocks new orders for the
//              algorithm+symbol until reconciled
//   partially-filled / filled / canceled   from reconciliation against GET /orders
// ---------------------------------------------------------------------------
export type LiveOrderStatus =
  'reserved' | 'accepted' | 'unknown' | 'rejected' | 'partially-filled' | 'filled' | 'canceled';

export const TERMINAL_STATUSES: readonly LiveOrderStatus[] = ['rejected', 'filled', 'canceled'];
export const NON_TERMINAL_STATUSES: readonly LiveOrderStatus[] = [
  'reserved',
  'accepted',
  'unknown',
  'partially-filled',
];
const TRANSITIONS: Record<LiveOrderStatus, readonly LiveOrderStatus[]> = {
  reserved: ['accepted', 'rejected', 'unknown'],
  unknown: ['accepted', 'rejected', 'partially-filled', 'filled', 'canceled'],
  accepted: ['partially-filled', 'filled', 'canceled', 'rejected'],
  'partially-filled': ['filled', 'canceled', 'rejected'],
  rejected: [],
  filled: [],
  canceled: [],
};
export function canTransition(from: LiveOrderStatus, to: LiveOrderStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export type LiveOrderRecord = {
  /** Deterministic key (see deriveClientOrderId); also the document id. */
  clientOrderId: string;
  /** Key sent on the wire when it differs from `clientOrderId` (tick-corrected resend). */
  wireClientOrderId?: string;
  orderId?: string;
  algorithmId: string;
  runId: string;
  market: TradeMarket;
  symbol: string;
  side: TradeSide;
  quantity: number;
  /** Limit price actually sent (decimal string). */
  price: string;
  currency: TradeCurrency;
  tranche: number;
  status: LiveOrderStatus;
  /** KST date of the reservation; the daily counters key on it. */
  dateKey: string;
  createdAt: string;
  updatedAt: string;
  filledQuantity: number;
  averageFilledPrice?: number | null;
  tickCorrected?: boolean;
  /** Sanitized provider/transport error (never raw text). */
  error?: OrderErrorInfo;
  /** Last status a fill notification was sent for (dedupes notifications). */
  notifiedStatus?: LiveOrderStatus;
};

export type OrderPatch = Partial<
  Pick<
    LiveOrderRecord,
    | 'status'
    | 'orderId'
    | 'wireClientOrderId'
    | 'filledQuantity'
    | 'averageFilledPrice'
    | 'price'
    | 'tickCorrected'
    | 'error'
    | 'notifiedStatus'
  >
>;

export type BlockedOrderRecord = {
  id: string;
  algorithmId: string;
  runId: string;
  market: TradeMarket;
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: string;
  tranche: number;
  reasons: ReasonCode[];
  dateKey: string;
  createdAt: string;
};

export type ReserveInput = {
  record: LiveOrderRecord;
  maxPerAlgorithm: number;
  maxGlobal: number;
  /**
   * The algorithm's budget in its currency. Re-checked inside the reservation transaction against
   * the freshly read ledger (a buy may not push committed exposure past it; a sell may not exceed
   * the shares the algorithm owns and has not already put into a working sell).
   */
  budget: number;
};
export type ReserveFailure =
  | 'emergency-stop'
  | 'algorithm-stopped'
  | 'daily-limit-algorithm'
  | 'daily-limit-global'
  | 'duplicate'
  /** Another order for the same algorithm+symbol is working (lock held). */
  | 'symbol-open'
  /** Another order for the same algorithm+symbol has an unconfirmed outcome (lock held). */
  | 'symbol-unreconciled'
  | 'budget-exceeded'
  | 'sell-exceeds-owned';
export type ReserveResult = { ok: true } | { ok: false; reason: ReserveFailure };

/**
 * Everything the pre-trade check reads. `getEmergencyStop` must always read the source of truth
 * (never a cache): it is consulted before every order.
 */
export interface PreTradeStore {
  getEmergencyStop(): Promise<boolean>;
  isAlgorithmStopped(algorithmId: string): Promise<boolean>;
  getDailyCounts(
    dateKey: string,
    algorithmId: string,
  ): Promise<{ algorithm: number; global: number }>;
  listOrders(filter: { algorithmId: string; symbol?: string }): Promise<LiveOrderRecord[]>;
}

export interface TradingStore extends PreTradeStore, TradingStatusStore {
  stopAlgorithm(algorithmId: string, reason: string): Promise<void>;
  /**
   * Atomically: re-read the emergency stop and the algorithm state, check the daily counters,
   * refuse duplicates, increment both counters and insert the `reserved` record. All or nothing.
   */
  reserveOrder(input: ReserveInput): Promise<ReserveResult>;
  /** Validates the status transition; throws on an illegal one. Returns the updated record. */
  updateOrder(clientOrderId: string, patch: OrderPatch): Promise<LiveOrderRecord>;
  getOrder(clientOrderId: string): Promise<LiveOrderRecord | null>;
  /** All orders that are not terminal, across algorithms (for reconciliation). */
  listNonTerminalOrders(): Promise<LiveOrderRecord[]>;
  recordBlocked(record: BlockedOrderRecord): Promise<void>;
  /**
   * Per-algorithm run lease so two `executeRun` calls cannot overlap. Succeeds when no unexpired
   * lease is held by a different run; the same run id may re-acquire (restart). The lease expires
   * after `ttlMs` so a crashed run cannot block the algorithm forever.
   */
  acquireRunLease(algorithmId: string, runId: string, ttlMs: number): Promise<boolean>;
  /** Releases the lease only if `runId` still holds it. */
  releaseRunLease(algorithmId: string, runId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Status records the screen reads (plan stage 7e/7f). None of them carries an amount, an account
// identifier or provider text.
// ---------------------------------------------------------------------------
export type AlgorithmStop = { reason: string; stoppedAt: string | null };
export type AccessProbeStatus = { ok: boolean; code?: string; status?: number | null };
/** Result of the read-only order-API access check job (booleans and sanitized codes only). */
export type AccessCheckStatus = {
  checkedAt: string;
  allOk: boolean;
  permissionDenied: boolean;
  probes: {
    buyingPowerKrw: AccessProbeStatus;
    buyingPowerUsd: AccessProbeStatus;
    commissions: AccessProbeStatus;
    openOrders: AccessProbeStatus;
  };
};
/**
 * Written by the live job on every scheduled invocation that got past its configuration check
 * (also when the market was closed). The screen uses it to tell "the live schedule is paused"
 * from "the live job ran".
 */
export type LiveJobHeartbeat = {
  market: TradeMarket;
  at: string;
  /** Session date the run was for, when there was one. */
  date: string | null;
  outcome: 'ok' | 'partial' | 'failed' | 'skipped';
  /** Upper-snake skip code ("MARKET_CLOSED_TODAY", ...). */
  code?: string;
};
export const LIVE_JOB_MARKETS: readonly TradeMarket[] = ['KR', 'US'];
export interface TradingStatusStore extends PreTradeStore {
  getAlgorithmStop(algorithmId: string): Promise<AlgorithmStop | null>;
  /** Removes the stop of one algorithm. Returns whether there was one. */
  releaseAlgorithmStop(algorithmId: string): Promise<boolean>;
  /** Newest first. */
  listRecentBlocked(algorithmId: string, limit: number): Promise<BlockedOrderRecord[]>;
  /** Orders of one symbol across algorithms (chart markers), newest first, at most `limit`. */
  listOrdersBySymbol(symbol: string, limit: number): Promise<LiveOrderRecord[]>;
  /**
   * The owner's decision about an order whose outcome is unconfirmed (status `unknown`, or `reserved`
   * after a crash). Validates the transition, updates the order (and so the ledger), releases the
   * symbol lock, and returns the updated record. Throws when the order is not unconfirmed or does
   * not belong to the algorithm.
   */
  resolveUnconfirmedOrder(
    algorithmId: string,
    clientOrderId: string,
    resolution: OrderResolution,
  ): Promise<LiveOrderRecord>;
  getAccessCheck(): Promise<AccessCheckStatus | null>;
  putAccessCheck(status: AccessCheckStatus): Promise<void>;
  getJobHeartbeat(market: TradeMarket): Promise<LiveJobHeartbeat | null>;
  putJobHeartbeat(heartbeat: LiveJobHeartbeat): Promise<void>;
}

/** What the owner found out about an unconfirmed order (checked in the broker app). */
export type OrderResolution =
  | { outcome: 'filled'; quantity: number; averagePrice: number }
  | { outcome: 'canceled'; quantity?: number; averagePrice?: number }
  | { outcome: 'not-placed' };
export const RESOLVABLE_STATUSES: readonly LiveOrderStatus[] = ['unknown', 'reserved'];

/**
 * Validates a resolution against the order and returns the patches to apply in order (each one a
 * legal status transition). `filled` with fewer shares than ordered is recorded as a cancellation
 * that kept the filled part: the unfilled rest is not live any more. Pure.
 */
export function planResolution(order: LiveOrderRecord, resolution: OrderResolution): OrderPatch[] {
  if (!RESOLVABLE_STATUSES.includes(order.status)) throw new Error('Order is not unconfirmed');
  const manual = { code: 'manually-resolved', kind: 'http' as const, status: null };
  const toUnknown: OrderPatch[] = order.status === 'reserved' ? [{ status: 'unknown' }] : [];
  if (resolution.outcome === 'not-placed')
    return [{ status: 'rejected', error: { ...manual, code: 'not-placed' } }];
  const quantity = resolution.quantity ?? 0;
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > order.quantity)
    throw new Error('Invalid filled quantity');
  if (resolution.outcome === 'filled' && quantity < 1) throw new Error('Invalid filled quantity');
  if (quantity > 0) {
    const price = resolution.averagePrice;
    if (typeof price !== 'number' || !Number.isFinite(price) || !(price > 0))
      throw new Error('Invalid average price');
  }
  const fill: OrderPatch =
    quantity > 0
      ? { filledQuantity: quantity, averageFilledPrice: resolution.averagePrice }
      : { filledQuantity: 0 };
  const status: LiveOrderStatus =
    resolution.outcome === 'filled' && quantity === order.quantity ? 'filled' : 'canceled';
  // notifiedStatus: the owner's own alert replaces the automatic fill notification.
  return [...toUnknown, { ...fill, status, error: manual, notifiedStatus: status }];
}

/**
 * Lock state of an (algorithm, symbol) pair, from the order that holds the lock. A lock whose
 * owner is terminal is stale and counts as free; a missing owner is treated as unconfirmed.
 */
export type SymbolLockState = 'free' | 'open' | 'unreconciled';
export function symbolLockState(
  locked: boolean,
  ownerStatus: LiveOrderStatus | null,
): SymbolLockState {
  if (!locked) return 'free';
  if (ownerStatus === null) return 'unreconciled';
  if (TERMINAL_STATUSES.includes(ownerStatus)) return 'free';
  return ownerStatus === 'reserved' || ownerStatus === 'unknown' ? 'unreconciled' : 'open';
}

/**
 * Exposure facts read from the algorithm's own orders inside the reservation: budget used
 * (held cost + working buys) and shares still available to sell for the record's symbol.
 */
export function ledgerFacts(orders: LiveOrderRecord[], symbol: string) {
  const ledger = summarizeLedger(orders);
  const position = ledger.positions.get(symbol);
  return {
    committed: ledger.committed,
    ownAvailable: Math.max(0, (position?.quantity ?? 0) - (position?.pendingSellQuantity ?? 0)),
  };
}

/** The decision both stores share, so the rules exist once. Pure. */
export function decideReserve(facts: {
  emergencyStop: boolean;
  algorithmStopped: boolean;
  algorithmCount: number;
  globalCount: number;
  exists: boolean;
  maxPerAlgorithm: number;
  maxGlobal: number;
  symbolLock: SymbolLockState;
  side: TradeSide;
  quantity: number;
  notional: number;
  budget: number;
  committed: number;
  ownAvailable: number;
}): ReserveFailure | null {
  if (facts.exists) return 'duplicate';
  if (facts.emergencyStop) return 'emergency-stop';
  if (facts.algorithmStopped) return 'algorithm-stopped';
  if (facts.symbolLock === 'unreconciled') return 'symbol-unreconciled';
  if (facts.symbolLock === 'open') return 'symbol-open';
  if (facts.algorithmCount >= facts.maxPerAlgorithm) return 'daily-limit-algorithm';
  if (facts.globalCount >= facts.maxGlobal) return 'daily-limit-global';
  if (facts.side === 'buy' && !(facts.committed + facts.notional <= facts.budget))
    return 'budget-exceeded';
  if (facts.side === 'sell' && facts.quantity > facts.ownAvailable) return 'sell-exceeds-owned';
  return null;
}

export function applyPatch(
  current: LiveOrderRecord,
  patch: OrderPatch,
  now: string,
): LiveOrderRecord {
  if (patch.status !== undefined && !canTransition(current.status, patch.status))
    throw new Error(`Illegal order status transition ${current.status} -> ${patch.status}`);
  const next: LiveOrderRecord = { ...current, updatedAt: now };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Ledger arithmetic: what the algorithm owns and has committed, derived from its own orders.
// ---------------------------------------------------------------------------
export type LedgerPosition = {
  symbol: string;
  /** Filled buys minus filled sells (shares the algorithm itself bought and still holds). */
  quantity: number;
  /** Average-cost basis of the held shares. */
  costBasis: number;
  /** Sell quantity already working (not yet filled) — cannot be sold again. */
  pendingSellQuantity: number;
  /** KST date of the most recent buy that has filled shares or is still working. */
  lastBuyDate: string | null;
};
export type Ledger = {
  positions: Map<string, LedgerPosition>;
  /** Cost of held shares across symbols plus the limit value of working buys. */
  committed: number;
};

const OPEN_STATUSES: readonly LiveOrderStatus[] = [
  'reserved',
  'accepted',
  'unknown',
  'partially-filled',
];

export function summarizeLedger(orders: LiveOrderRecord[]): Ledger {
  const positions = new Map<string, LedgerPosition>();
  let pendingBuyNotional = 0;
  const sorted = [...orders].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.clientOrderId.localeCompare(b.clientOrderId),
  );
  for (const order of sorted) {
    if (order.status === 'rejected') continue;
    const position =
      positions.get(order.symbol) ??
      ({
        symbol: order.symbol,
        quantity: 0,
        costBasis: 0,
        pendingSellQuantity: 0,
        lastBuyDate: null,
      } as LedgerPosition);
    positions.set(order.symbol, position);
    const filled = Math.min(Math.max(order.filledQuantity, 0), order.quantity);
    const working = OPEN_STATUSES.includes(order.status) ? order.quantity - filled : 0;
    const price = Number(order.price);
    if (order.side === 'buy') {
      const fillPrice = order.averageFilledPrice ?? price;
      position.quantity += filled;
      position.costBasis += filled * fillPrice;
      pendingBuyNotional += working * price;
      if (filled > 0 || working > 0)
        position.lastBuyDate =
          position.lastBuyDate === null || order.dateKey > position.lastBuyDate
            ? order.dateKey
            : position.lastBuyDate;
    } else {
      const sold = Math.min(filled, position.quantity);
      if (position.quantity > 0)
        position.costBasis -= position.costBasis * (sold / position.quantity);
      position.quantity -= sold;
      position.pendingSellQuantity += working;
      if (position.quantity === 0) position.costBasis = 0;
    }
  }
  let committed = pendingBuyNotional;
  for (const p of positions.values()) committed += p.costBasis;
  return { positions, committed };
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests and local development).
// ---------------------------------------------------------------------------
/** Newest first by update time, then id (chart markers and screens). */
export const newestOrderFirst = (a: LiveOrderRecord, b: LiveOrderRecord) =>
  b.updatedAt.localeCompare(a.updatedAt) || b.clientOrderId.localeCompare(a.clientOrderId);

export class MemoryTradingStore implements TradingStore {
  private emergencyStop = false;
  private readonly stopped = new Map<string, string>();
  private readonly stoppedAt = new Map<string, string>();
  private accessCheck: AccessCheckStatus | null = null;
  private readonly heartbeats = new Map<TradeMarket, LiveJobHeartbeat>();
  private readonly orders = new Map<string, LiveOrderRecord>();
  private readonly counters = new Map<string, number>();
  private readonly blocked: BlockedOrderRecord[] = [];
  /** `${algorithmId}|${symbol}` -> clientOrderId of the order holding the lock. */
  private readonly symbolLocks = new Map<string, string>();
  private readonly leases = new Map<string, { runId: string; expiresAt: number }>();
  constructor(private readonly clock: () => Date = () => new Date()) {}

  /** Operator/test control. The 7e UI wires its own authenticated writer. */
  setEmergencyStop(value: boolean) {
    this.emergencyStop = value;
  }
  async getEmergencyStop() {
    return this.emergencyStop;
  }
  async isAlgorithmStopped(algorithmId: string) {
    return this.stopped.has(algorithmId);
  }
  stoppedReason(algorithmId: string) {
    return this.stopped.get(algorithmId);
  }
  async stopAlgorithm(algorithmId: string, reason: string) {
    if (!ALGORITHM_ID.test(algorithmId)) throw new Error('Invalid algorithm id');
    if (!this.stopped.has(algorithmId)) {
      this.stopped.set(algorithmId, reason);
      this.stoppedAt.set(algorithmId, this.clock().toISOString());
    }
  }
  async getAlgorithmStop(algorithmId: string) {
    return this.stopped.has(algorithmId)
      ? {
          reason: this.stopped.get(algorithmId)!,
          stoppedAt: this.stoppedAt.get(algorithmId) ?? null,
        }
      : null;
  }
  async releaseAlgorithmStop(algorithmId: string) {
    this.stoppedAt.delete(algorithmId);
    return this.stopped.delete(algorithmId);
  }
  async listRecentBlocked(algorithmId: string, limit: number) {
    return this.blocked
      .filter((b) => b.algorithmId === algorithmId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((b) => structuredClone(b));
  }
  async listOrdersBySymbol(symbol: string, limit: number) {
    return [...this.orders.values()]
      .filter((o) => o.symbol === symbol)
      .sort(newestOrderFirst)
      .slice(0, limit)
      .map((o) => structuredClone(o));
  }
  async resolveUnconfirmedOrder(
    algorithmId: string,
    clientOrderId: string,
    resolution: OrderResolution,
  ) {
    const current = this.orders.get(clientOrderId);
    if (!current || current.algorithmId !== algorithmId) throw new Error('Unknown order');
    let last = structuredClone(current);
    for (const patch of planResolution(current, resolution))
      last = await this.updateOrder(clientOrderId, patch);
    return last;
  }
  async getAccessCheck() {
    return structuredClone(this.accessCheck);
  }
  async putAccessCheck(status: AccessCheckStatus) {
    this.accessCheck = structuredClone(status);
  }
  async getJobHeartbeat(market: TradeMarket) {
    return structuredClone(this.heartbeats.get(market) ?? null);
  }
  async putJobHeartbeat(heartbeat: LiveJobHeartbeat) {
    this.heartbeats.set(heartbeat.market, structuredClone(heartbeat));
  }
  async getDailyCounts(dateKey: string, algorithmId: string) {
    return {
      algorithm: this.counters.get(`${dateKey}|a|${algorithmId}`) ?? 0,
      global: this.counters.get(`${dateKey}|g`) ?? 0,
    };
  }
  async reserveOrder(input: ReserveInput): Promise<ReserveResult> {
    const r = input.record;
    if (!ALGORITHM_ID.test(r.algorithmId) || r.status !== 'reserved')
      throw new Error('Invalid reservation');
    // No await between read and write: atomic on a single-threaded runtime.
    const lockKey = `${r.algorithmId}|${r.symbol}`;
    const owner = this.symbolLocks.get(lockKey);
    const ownerStatus = owner === undefined ? null : (this.orders.get(owner)?.status ?? null);
    const facts = ledgerFacts(
      [...this.orders.values()].filter((o) => o.algorithmId === r.algorithmId),
      r.symbol,
    );
    const failure = decideReserve({
      emergencyStop: this.emergencyStop,
      algorithmStopped: this.stopped.has(r.algorithmId),
      algorithmCount: this.counters.get(`${r.dateKey}|a|${r.algorithmId}`) ?? 0,
      globalCount: this.counters.get(`${r.dateKey}|g`) ?? 0,
      exists: this.orders.has(r.clientOrderId),
      maxPerAlgorithm: input.maxPerAlgorithm,
      maxGlobal: input.maxGlobal,
      symbolLock: symbolLockState(owner !== undefined, ownerStatus),
      side: r.side,
      quantity: r.quantity,
      notional: r.quantity * Number(r.price),
      budget: input.budget,
      committed: facts.committed,
      ownAvailable: facts.ownAvailable,
    });
    if (failure) return { ok: false, reason: failure };
    this.symbolLocks.set(lockKey, r.clientOrderId);
    this.counters.set(
      `${r.dateKey}|a|${r.algorithmId}`,
      (this.counters.get(`${r.dateKey}|a|${r.algorithmId}`) ?? 0) + 1,
    );
    this.counters.set(`${r.dateKey}|g`, (this.counters.get(`${r.dateKey}|g`) ?? 0) + 1);
    this.orders.set(r.clientOrderId, structuredClone(r));
    return { ok: true };
  }
  async updateOrder(clientOrderId: string, patch: OrderPatch) {
    const current = this.orders.get(clientOrderId);
    if (!current) throw new Error('Unknown order');
    const next = applyPatch(current, patch, this.clock().toISOString());
    this.orders.set(clientOrderId, next);
    const lockKey = `${next.algorithmId}|${next.symbol}`;
    if (TERMINAL_STATUSES.includes(next.status) && this.symbolLocks.get(lockKey) === clientOrderId)
      this.symbolLocks.delete(lockKey);
    return structuredClone(next);
  }
  async getOrder(clientOrderId: string) {
    const found = this.orders.get(clientOrderId);
    return found ? structuredClone(found) : null;
  }
  async listOrders(filter: { algorithmId: string; symbol?: string }) {
    return [...this.orders.values()]
      .filter(
        (o) =>
          o.algorithmId === filter.algorithmId && (!filter.symbol || o.symbol === filter.symbol),
      )
      .map((o) => structuredClone(o));
  }
  async listNonTerminalOrders() {
    return [...this.orders.values()]
      .filter((o) => NON_TERMINAL_STATUSES.includes(o.status))
      .map((o) => structuredClone(o));
  }
  async recordBlocked(record: BlockedOrderRecord) {
    this.blocked.push(structuredClone(record));
  }
  listBlocked() {
    return this.blocked.map((b) => structuredClone(b));
  }
  async acquireRunLease(algorithmId: string, runId: string, ttlMs: number) {
    if (!ALGORITHM_ID.test(algorithmId) || !(ttlMs > 0)) throw new Error('Invalid lease');
    const now = this.clock().getTime();
    const held = this.leases.get(algorithmId);
    if (held && held.expiresAt > now && held.runId !== runId) return false;
    this.leases.set(algorithmId, { runId, expiresAt: now + ttlMs });
    return true;
  }
  async releaseRunLease(algorithmId: string, runId: string) {
    if (this.leases.get(algorithmId)?.runId === runId) this.leases.delete(algorithmId);
  }
}
