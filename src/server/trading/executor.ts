import { randomUUID } from 'node:crypto';
import type { BucketStats } from '../../lib/algo/index.js';
import type { NotificationEvent } from '../notify.js';
import {
  DEFAULT_MAX_GLOBAL_ORDERS_PER_DAY,
  isAcceptableCorrection,
  planSellTranches,
  preTradeCheck,
  type OrderIntent,
  type PreTradeAlgorithm,
  type PreTradeContext,
  type PreTradeDeps,
  type PreTradeMarketFacts,
  type PreTradeSettings,
} from './pre-trade.js';
import { ROUTINE_HOLD_CODES, type ReasonCode } from './reasons.js';
import {
  ALGORITHM_ID,
  currencyOf,
  kstDateKey,
  type LiveOrderRecord,
  type LiveOrderStatus,
  type ReserveFailure,
  type TradingStore,
} from './stores.js';
import {
  OrderInputError,
  deriveClientOrderId,
  isPermissionError,
  normalizeLimitPrice,
  type OrderErrorInfo,
  type TossOrder,
  type TossOrderReads,
  type TossOrderWrites,
  type TradeSide,
} from './toss-orders.js';
import { defaultSafeguards } from '../../lib/algo/index.js';

/**
 * Live order executor (plan stage 7d). UNWIRED: nothing in app/job code imports this module and
 * nothing schedules it; stage 7e/7f wire it behind the owner-only live switch.
 *
 * Per order: plan (tranches) -> preTradeCheck -> atomic slot reservation (emergency stop re-read
 * inside the transaction) -> place -> record -> notify. A refusal is recorded with its reason
 * codes and never placed. Notifications are best-effort and can never block or fail trading.
 */

export type Decision = {
  symbol: string;
  side: TradeSide;
  quantity: number;
  /** Intended limit price; rounded to the documented scale toward the less aggressive side. */
  price: number | string;
};

/** Facts the run knows. Called per order so that quotes are fresh for each one. */
export interface RunDataProvider {
  marketFacts(symbol: string): Promise<PreTradeMarketFacts>;
  /** Realized + unrealized P&L of the algorithm in its currency. */
  cumulativePnl(): Promise<number | null>;
  /** Buys: score-bucket statistics and today's score. */
  expectedProfit(symbol: string): Promise<{ stats: BucketStats; score: number | null } | null>;
}

export interface TradingNotifier {
  notify(event: NotificationEvent): Promise<void>;
}

export type ExecutorClient = TossOrderWrites &
  Pick<
    TossOrderReads,
    | 'listOrders'
    | 'getOrder'
    | 'getSellableQuantity'
    | 'getBuyingPower'
    | 'getCommissions'
    | 'getStockWarnings'
    | 'getPriceLimits'
  >;

export type ExecutorDeps = {
  client: ExecutorClient;
  store: TradingStore;
  notifier: TradingNotifier;
  now: () => Date;
  tradingDaysSince: PreTradeDeps['tradingDaysSince'];
  settings?: PreTradeSettings;
  /** Display name for notifications; defaults to the algorithm id. */
  algorithmName?: (algorithmId: string) => string;
  newId?: () => string;
};

export type LiveRun = {
  /** Stable per scheduled run; with the algorithm, symbol, side and tranche it fixes clientOrderId. */
  runId: string;
  algorithm: PreTradeAlgorithm;
  decisions: Decision[];
  data: RunDataProvider;
};

export type OrderOutcome = {
  symbol: string;
  side: TradeSide;
  tranche: number;
  status: 'accepted' | 'rejected' | 'unknown' | 'blocked' | 'skipped';
  clientOrderId?: string;
  reasons?: ReasonCode[];
  /** Sanitized provider/transport code. */
  errorCode?: string;
  /** The order was sent but the local record could not be updated afterwards. */
  recordError?: boolean;
};
export type RunReport = {
  runId: string;
  outcomes: OrderOutcome[];
  algorithmStopped: boolean;
  stopReason?: StopReason;
};
export type StopReason = 'loss-limit' | 'order-permission' | 'first-order-rejected';

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Transient: a rate-limit refusal of the first order says nothing about permissions. */
const TRANSIENT_REJECTION_CODES: ReadonlySet<string> = new Set(['rate-limit-exceeded']);
/**
 * Reasons that are routine or already known to the owner (a working order, an emergency stop, a
 * stopped algorithm, "no trade today" holds): recorded in blockedOrders but not notified.
 */
const SILENT_CODES: readonly ReasonCode[] = [
  ...ROUTINE_HOLD_CODES,
  'EMERGENCY_STOP',
  'ALGORITHM_STOPPED',
  'OPEN_ORDER_EXISTS',
];

const RESERVE_FAILURE_REASON: Record<ReserveFailure, ReasonCode> = {
  'emergency-stop': 'EMERGENCY_STOP',
  'algorithm-stopped': 'ALGORITHM_STOPPED',
  'daily-limit-algorithm': 'DAILY_LIMIT_ALGORITHM',
  'daily-limit-global': 'DAILY_LIMIT_GLOBAL',
  duplicate: 'UNRECONCILED_ORDER',
};

type PlannedOrder = { intent: OrderIntent };

export class LiveOrderExecutor {
  private readonly newId: () => string;
  constructor(private readonly deps: ExecutorDeps) {
    this.newId = deps.newId ?? randomUUID;
  }

  private name(algorithmId: string) {
    return this.deps.algorithmName?.(algorithmId) ?? algorithmId;
  }
  private async notify(event: NotificationEvent) {
    try {
      await this.deps.notifier.notify(event);
    } catch {
      // Delivery problems never block trading; the notifier records its own failures.
    }
  }

  /** Executes the decisions of one run, sequentially and in the given order. */
  async executeRun(run: LiveRun): Promise<RunReport> {
    if (!RUN_ID.test(run.runId) || !ALGORITHM_ID.test(run.algorithm.id))
      throw new Error('Invalid run or algorithm id');
    const report: RunReport = { runId: run.runId, outcomes: [], algorithmStopped: false };
    try {
      await this.reconcile(run.algorithm.id);
    } catch {
      // Unreconciled orders block new ones in the pre-trade check (fail closed).
    }
    for (const decision of run.decisions) {
      const planned = await this.plan(run, decision, report);
      for (const p of planned) {
        if (report.algorithmStopped) {
          report.outcomes.push({
            symbol: p.intent.symbol,
            side: p.intent.side,
            tranche: p.intent.tranche,
            status: 'skipped',
            reasons: ['ALGORITHM_STOPPED'],
          });
          continue;
        }
        report.outcomes.push(await this.executeOne(run, p.intent, report));
      }
    }
    return report;
  }

  /** Turns a decision into order intents. Sells above the value cap are split into tranches. */
  private async plan(run: LiveRun, d: Decision, report: RunReport): Promise<PlannedOrder[]> {
    const market = run.algorithm.market;
    const side = d.side;
    const price =
      side === 'buy' || side === 'sell' ? normalizeLimitPrice(market, side, d.price) : null;
    const base = {
      symbol: d.symbol,
      side,
      orderType: 'LIMIT' as const,
      timeInForce: 'DAY' as const,
    };
    if (price === null || !Number.isSafeInteger(d.quantity) || d.quantity < 1) {
      await this.blocked(
        run,
        { ...base, quantity: d.quantity, price: String(d.price), tranche: 0 },
        ['PRICE_INVALID'],
        false,
      );
      report.outcomes.push({
        symbol: d.symbol,
        side,
        tranche: 0,
        status: 'blocked',
        reasons: ['PRICE_INVALID'],
      });
      return [];
    }
    if (side === 'buy') return [{ intent: { ...base, quantity: d.quantity, price, tranche: 0 } }];
    let fx: number | null = null;
    if (market === 'US') {
      try {
        fx = (await run.data.marketFacts(d.symbol)).fxMidRate;
      } catch {
        fx = null;
      }
    }
    const split = planSellTranches({
      market,
      quantity: d.quantity,
      price,
      fxMidRate: fx,
      settings: this.deps.settings,
    });
    if (split.error) {
      await this.blocked(
        run,
        { ...base, quantity: d.quantity, price, tranche: 0 },
        [split.error],
        false,
      );
      report.outcomes.push({
        symbol: d.symbol,
        side,
        tranche: 0,
        status: 'blocked',
        reasons: [split.error],
      });
      return [];
    }
    return split.tranches.map((quantity, tranche) => ({
      intent: { ...base, quantity, price, tranche },
    }));
  }

  private async blocked(
    run: LiveRun,
    intent: { symbol: string; side: TradeSide; quantity: number; price: string; tranche: number },
    codes: ReasonCode[],
    notify = true,
  ) {
    const now = this.deps.now();
    try {
      await this.deps.store.recordBlocked({
        id: this.newId(),
        algorithmId: run.algorithm.id,
        runId: run.runId,
        market: run.algorithm.market,
        symbol: intent.symbol,
        side: intent.side,
        quantity: intent.quantity,
        price: intent.price,
        tranche: intent.tranche,
        reasons: codes,
        dateKey: kstDateKey(now),
        createdAt: now.toISOString(),
      });
    } catch {
      // The refusal still stands; only the audit row is missing.
    }
    if (notify && !codes.every((c) => SILENT_CODES.includes(c)))
      await this.notify({
        kind: 'order-rejected',
        mode: 'live',
        symbol: intent.symbol,
        side: intent.side,
        algorithmName: this.name(run.algorithm.id),
        reason: 'safety-guard',
      });
  }

  private async stopAlgorithm(run: LiveRun, report: RunReport, why: StopReason) {
    if (report.algorithmStopped) return;
    report.algorithmStopped = true;
    report.stopReason = why;
    try {
      await this.deps.store.stopAlgorithm(run.algorithm.id, why);
    } catch {
      // Still stopped for the rest of this run; the next pre-trade check also fails closed.
    }
    await this.notify({
      kind: 'algorithm-auto-stop',
      mode: 'live',
      algorithmName: this.name(run.algorithm.id),
      ...(why === 'loss-limit' ? { reason: 'loss-limit' as const } : {}),
    });
  }

  private async executeOne(
    run: LiveRun,
    intent: OrderIntent,
    report: RunReport,
  ): Promise<OrderOutcome> {
    const { algorithm, data } = run;
    const out = (o: Partial<OrderOutcome> & Pick<OrderOutcome, 'status'>): OrderOutcome => ({
      symbol: intent.symbol,
      side: intent.side,
      tranche: intent.tranche,
      ...o,
    });
    const refuse = async (codes: ReasonCode[]) => {
      await this.blocked(run, intent, codes);
      return out({ status: 'blocked', reasons: codes });
    };

    // 1. Facts for this order (fresh per order).
    let facts: PreTradeMarketFacts;
    try {
      facts = await data.marketFacts(intent.symbol);
    } catch {
      return refuse(['INTERNAL_ERROR']);
    }
    let pnl: number | null = null;
    try {
      pnl = await data.cumulativePnl();
    } catch {
      pnl = null;
    }
    let expected: PreTradeContext['expectedProfit'] = null;
    if (intent.side === 'buy') {
      try {
        expected = await data.expectedProfit(intent.symbol);
      } catch {
        expected = null;
      }
    }
    const ctx: PreTradeContext = {
      algorithm,
      order: intent,
      market: facts,
      cumulativePnl: pnl,
      expectedProfit: expected,
      settings: this.deps.settings,
    };

    // 2. The single pre-trade check.
    const checked = await preTradeCheck(ctx, {
      store: this.deps.store,
      toss: this.deps.client,
      now: this.deps.now,
      tradingDaysSince: this.deps.tradingDaysSince,
    });
    if (!checked.allowed) {
      const codes = checked.reasons.map((r) => r.code);
      if (checked.autoStop) {
        await this.blocked(run, intent, codes, false);
        await this.stopAlgorithm(run, report, 'loss-limit');
        return out({ status: 'blocked', reasons: codes });
      }
      return refuse(codes);
    }

    // 3. First live order for this algorithm? (rejection monitoring)
    let firstLiveOrder = false;
    try {
      const prior = await this.deps.store.listOrders({ algorithmId: algorithm.id });
      firstLiveOrder = !prior.some((o) =>
        (['accepted', 'unknown', 'partially-filled', 'filled'] as LiveOrderStatus[]).includes(
          o.status,
        ),
      );
    } catch {
      return refuse(['STORE_UNAVAILABLE']);
    }

    // 4. Atomic slot reservation (write-ahead record; emergency stop re-read inside).
    const now = this.deps.now();
    const clientOrderId = deriveClientOrderId({
      algorithmId: algorithm.id,
      runId: run.runId,
      symbol: intent.symbol,
      side: intent.side,
      tranche: intent.tranche,
    });
    const record: LiveOrderRecord = {
      clientOrderId,
      algorithmId: algorithm.id,
      runId: run.runId,
      market: algorithm.market,
      symbol: intent.symbol,
      side: intent.side,
      quantity: intent.quantity,
      price: intent.price,
      currency: currencyOf(algorithm.market),
      tranche: intent.tranche,
      status: 'reserved',
      dateKey: kstDateKey(now),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      filledQuantity: 0,
    };
    let reservation;
    try {
      reservation = await this.deps.store.reserveOrder({
        record,
        maxPerAlgorithm:
          this.deps.settings?.safeguards?.maxOrdersPerDay ??
          defaultSafeguards(algorithm.market).maxOrdersPerDay,
        maxGlobal: this.deps.settings?.maxGlobalOrdersPerDay ?? DEFAULT_MAX_GLOBAL_ORDERS_PER_DAY,
      });
    } catch {
      return refuse(['STORE_UNAVAILABLE']);
    }
    if (!reservation.ok) {
      const code = RESERVE_FAILURE_REASON[reservation.reason];
      if (reservation.reason === 'duplicate') {
        // A record with this key exists (earlier attempt of this run): never place it again.
        await this.blocked(run, intent, [code], false);
        return out({ status: 'skipped', clientOrderId, reasons: [code] });
      }
      return refuse([code]);
    }

    // 5. Place. The veto re-checks price-dependent rules and the emergency stop for the one
    //    tick-size correction.
    let placed;
    try {
      placed = await this.deps.client.placeOrder(
        {
          clientOrderId,
          market: algorithm.market,
          symbol: intent.symbol,
          side: intent.side,
          quantity: intent.quantity,
          price: intent.price,
        },
        {
          onPriceCorrection: async (corrected) => {
            if (!isAcceptableCorrection(ctx, corrected, this.deps.now())) return false;
            try {
              return !(await this.deps.store.getEmergencyStop());
            } catch {
              return false;
            }
          },
        },
      );
    } catch (error) {
      // OrderInputError: nothing was sent. Anything else: the outcome is unknown.
      const notSent = error instanceof OrderInputError;
      const info: OrderErrorInfo = {
        kind: 'schema',
        status: null,
        code: notSent ? 'input-invalid' : 'response-invalid',
      };
      return this.finish(
        run,
        report,
        record,
        firstLiveOrder,
        notSent ? 'rejected' : 'unknown',
        info,
        {},
      );
    }
    if (placed.outcome === 'accepted')
      return this.finish(run, report, record, firstLiveOrder, 'accepted', undefined, {
        orderId: placed.orderId,
        wireClientOrderId: placed.clientOrderId,
        price: placed.price,
        tickCorrected: placed.tickCorrected,
      });
    return this.finish(run, report, record, firstLiveOrder, placed.outcome, placed.error, {
      wireClientOrderId: placed.clientOrderId,
      price: placed.price,
      tickCorrected: placed.tickCorrected,
    });
  }

  private async finish(
    run: LiveRun,
    report: RunReport,
    record: LiveOrderRecord,
    firstLiveOrder: boolean,
    status: 'accepted' | 'rejected' | 'unknown',
    error: OrderErrorInfo | undefined,
    extra: {
      orderId?: string;
      wireClientOrderId?: string;
      price?: string;
      tickCorrected?: boolean;
    },
  ): Promise<OrderOutcome> {
    const outcome: OrderOutcome = {
      symbol: record.symbol,
      side: record.side,
      tranche: record.tranche,
      status,
      clientOrderId: record.clientOrderId,
      ...(error ? { errorCode: error.code } : {}),
    };
    try {
      await this.deps.store.updateOrder(record.clientOrderId, {
        status,
        ...(error ? { error } : {}),
        ...(extra.orderId ? { orderId: extra.orderId } : {}),
        ...(extra.wireClientOrderId && extra.wireClientOrderId !== record.clientOrderId
          ? { wireClientOrderId: extra.wireClientOrderId }
          : {}),
        ...(extra.price && extra.price !== record.price ? { price: extra.price } : {}),
        ...(extra.tickCorrected ? { tickCorrected: true } : {}),
      });
    } catch {
      // The order was (maybe) sent; the 'reserved' record stays and blocks new orders.
      outcome.recordError = true;
    }
    if (status === 'rejected') {
      await this.notify({
        kind: 'order-rejected',
        mode: 'live',
        symbol: record.symbol,
        side: record.side,
        algorithmName: this.name(run.algorithm.id),
        reason: 'broker-rejected',
      });
      // Design 주문 권한 확인 3: permission refusals always stop the algorithm; the first live
      // order being refused for any non-transient reason stops it too (7f first-order watch).
      if (error && isPermissionError(error))
        await this.stopAlgorithm(run, report, 'order-permission');
      else if (firstLiveOrder && error && !TRANSIENT_REJECTION_CODES.has(error.code))
        await this.stopAlgorithm(run, report, 'first-order-rejected');
    } else if (status === 'unknown') {
      // No dedicated event kind exists for "sent but unconfirmed"; surface it as a job failure.
      await this.notify({ kind: 'job-failure', jobName: 'live-order-unconfirmed' });
    }
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Reconciliation: read-only against the provider (GET only). Updates statuses and sends one
  // fill notification per newly filled/partially filled order.
  // -------------------------------------------------------------------------
  async reconcile(algorithmId?: string): Promise<{ updated: number }> {
    const all = await this.deps.store.listNonTerminalOrders();
    const orders = algorithmId ? all.filter((o) => o.algorithmId === algorithmId) : all;
    let updated = 0;
    let openList: TossOrder[] | null = null;
    for (const order of orders) {
      try {
        let providerOrder: TossOrder | null = null;
        if (order.orderId) {
          providerOrder = await this.deps.client.getOrder(order.orderId);
        } else {
          // No orderId (unknown/reserved): adopt only an exact, unique match among OPEN orders.
          openList ??= (await this.deps.client.listOrders({ status: 'OPEN' })).orders;
          const claimed = new Set(orders.map((o) => o.orderId).filter(Boolean));
          const matches = openList.filter(
            (t) =>
              !claimed.has(t.orderId) &&
              t.symbol === order.symbol &&
              t.side === order.side &&
              Number(t.quantity) === order.quantity &&
              t.price !== null &&
              Number(t.price) === Number(order.price) &&
              t.orderType === 'LIMIT' &&
              t.timeInForce === 'DAY',
          );
          if (matches.length !== 1) continue;
          providerOrder = matches[0];
          await this.deps.store.updateOrder(order.clientOrderId, {
            status: 'accepted',
            orderId: providerOrder.orderId,
          });
          order.status = 'accepted';
          order.orderId = providerOrder.orderId;
        }
        const next = mapProviderStatus(providerOrder.status);
        const filled = Number(providerOrder.filledQuantity);
        if (!Number.isFinite(filled)) continue;
        const avg =
          providerOrder.averageFilledPrice === null
            ? null
            : Number(providerOrder.averageFilledPrice);
        if (next === null && filled === order.filledQuantity) continue;
        const status: LiveOrderStatus = next ?? order.status;
        const saved = await this.deps.store.updateOrder(order.clientOrderId, {
          status,
          filledQuantity: filled,
          averageFilledPrice: avg,
        });
        updated++;
        if (
          (saved.status === 'filled' || saved.status === 'partially-filled') &&
          saved.notifiedStatus !== saved.status
        ) {
          await this.notify({
            kind: 'fill',
            mode: 'live',
            symbol: saved.symbol,
            side: saved.side,
            status: saved.status,
            algorithmName: this.name(saved.algorithmId),
          });
          await this.deps.store.updateOrder(saved.clientOrderId, { notifiedStatus: saved.status });
        }
      } catch {
        // One order failing to reconcile never blocks the others; it stays non-terminal.
      }
    }
    return { updated };
  }
}

/** Provider status -> local status; null keeps the current status (still working). */
export function mapProviderStatus(status: string): LiveOrderStatus | null {
  switch (status) {
    case 'FILLED':
      return 'filled';
    case 'PARTIAL_FILLED':
      return 'partially-filled';
    case 'CANCELED':
    case 'REPLACED':
      return 'canceled';
    case 'REJECTED':
      return 'rejected';
    default:
      // PENDING, PENDING_CANCEL, PENDING_REPLACE, *_REJECTED (the original order returns to its
      // previous state) and unknown codes: keep what we have.
      return null;
  }
}
