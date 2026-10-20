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
};
export type ReserveFailure =
  | 'emergency-stop'
  | 'algorithm-stopped'
  | 'daily-limit-algorithm'
  | 'daily-limit-global'
  | 'duplicate';
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

export interface TradingStore extends PreTradeStore {
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
}): ReserveFailure | null {
  if (facts.exists) return 'duplicate';
  if (facts.emergencyStop) return 'emergency-stop';
  if (facts.algorithmStopped) return 'algorithm-stopped';
  if (facts.algorithmCount >= facts.maxPerAlgorithm) return 'daily-limit-algorithm';
  if (facts.globalCount >= facts.maxGlobal) return 'daily-limit-global';
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
export class MemoryTradingStore implements TradingStore {
  private emergencyStop = false;
  private readonly stopped = new Map<string, string>();
  private readonly orders = new Map<string, LiveOrderRecord>();
  private readonly counters = new Map<string, number>();
  private readonly blocked: BlockedOrderRecord[] = [];
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
    if (!this.stopped.has(algorithmId)) this.stopped.set(algorithmId, reason);
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
    const failure = decideReserve({
      emergencyStop: this.emergencyStop,
      algorithmStopped: this.stopped.has(r.algorithmId),
      algorithmCount: this.counters.get(`${r.dateKey}|a|${r.algorithmId}`) ?? 0,
      globalCount: this.counters.get(`${r.dateKey}|g`) ?? 0,
      exists: this.orders.has(r.clientOrderId),
      maxPerAlgorithm: input.maxPerAlgorithm,
      maxGlobal: input.maxGlobal,
    });
    if (failure) return { ok: false, reason: failure };
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
}
