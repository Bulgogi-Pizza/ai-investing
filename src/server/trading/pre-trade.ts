import {
  checkOrder,
  defaultSafeguards,
  expectedProfit as lookupExpectedProfit,
  maxQuantityBelowValue,
  roundTripCostRate,
  type BucketStats,
  type OrderRejection,
  type Safeguards,
} from '../../lib/algo/index.js';
import { reason, type Reason, type ReasonCode } from './reasons.js';
import { currencyOf, kstDateKey, summarizeLedger, type PreTradeStore } from './stores.js';
import {
  normalizeLimitPrice,
  validSymbolFor,
  type TossOrderReads,
  type TradeMarket,
  type TradeSide,
} from './toss-orders.js';

/**
 * The ONE pre-trade check every live order must pass (plan stage 7d, design section 4 "안전장치"
 * 1-10 and "비용 반영"). UNWIRED: nothing in app/job code imports this module.
 *
 * Properties:
 * - Fail closed: any missing fact, unreadable store/provider or unexpected error is a refusal.
 *   The function never throws.
 * - Fixed order, cheap before remote: shape -> control state (emergency stop, algorithm status,
 *   cumulative loss, daily counts) -> local data and position rules -> remote reads -> a final
 *   fresh re-read of the emergency stop. A stage that produces reasons ends the check, so remote
 *   reads are never spent on an order that is already refused.
 * - It does not mutate the order: the allowed order is exactly the order given (no clamping).
 * - It only reads. Placing the order and consuming the daily slot are the executor's job (the slot
 *   is reserved atomically there, which re-checks the emergency stop inside the transaction).
 */

export type OrderIntent = {
  symbol: string;
  side: TradeSide;
  /** Integer shares >= 1. */
  quantity: number;
  /** Decimal string in the documented price scale (see normalizeLimitPrice). */
  price: string;
  orderType: 'LIMIT';
  timeInForce: 'DAY';
  /** Sell tranche index; 0 for buys and the first sell tranche. */
  tranche: number;
};

export type PreTradeAlgorithm = {
  id: string;
  name: string;
  market: TradeMarket;
  /** Budget in the market currency (KRW for KR, USD for US). No default: null blocks orders. */
  budget: number | null;
  /** Value signal in use: missing financials then block (safeguard 6). */
  usesValueSignal: boolean;
};

export type PreTradeMarketFacts = {
  quote: { price: number; observedAt: string } | null;
  /** Date (YYYY-MM-DD, exchange-local) of the newest completed daily bar. */
  latestDailyBarDate: string | null;
  /** Previous trading day for the market (from the market calendar). */
  expectedDailyBarDate: string;
  /** 20-trading-day average traded value (price * volume) in the market currency. */
  avgTradedValue: number | null;
  financialsPresent: boolean;
  /** KRW per USD (`/exchange-rate` midRate). Required for US orders. */
  fxMidRate: number | null;
};

export type PreTradeSettings = {
  safeguards?: Partial<Safeguards>;
  /** Safeguard 2, global. Default 10. */
  maxGlobalOrdersPerDay?: number;
  /** KR securities transaction tax fraction of sell notional. Required for KR buys. */
  sellTaxRate?: number;
  /** Fraction of the price limits within which an order is refused. Default 0.03. */
  priceLimitBuffer?: number;
  /** Refuse limit prices that are this much worse than the quote. Default 0.03. */
  maxQuoteDeviation?: number;
  /** Extra margin on the FX midRate when converting US orders to KRW for the 1e8 cap. Default 0.02. */
  fxSafetyMargin?: number;
  /** Lower value only: the cap cannot exceed 100,000,000 KRW. */
  maxOrderValueKrw?: number;
  /** Quote age limit in ms. Can only be tightened below 60,000. */
  maxQuoteAgeMs?: number;
  /** Minimum samples per score bucket for the expected-profit rule. Default: library default. */
  minSamples?: number;
};

export type PreTradeContext = {
  algorithm: PreTradeAlgorithm;
  order: OrderIntent;
  market: PreTradeMarketFacts;
  /** Realized + unrealized P&L in the market currency; null blocks orders. */
  cumulativePnl: number | null;
  /** Buys: score-bucket statistics and today's composite score. Null/absent score = "기록 부족". */
  expectedProfit: { stats: BucketStats; score: number | null } | null;
  settings?: PreTradeSettings;
};

export interface PreTradeDeps {
  store: PreTradeStore;
  toss: Pick<
    TossOrderReads,
    | 'listOrders'
    | 'getSellableQuantity'
    | 'getBuyingPower'
    | 'getCommissions'
    | 'getStockWarnings'
    | 'getPriceLimits'
  >;
  now: () => Date;
  /** Trading days elapsed after `fromDate` (YYYY-MM-DD) up to today; null when unknown. */
  tradingDaysSince: (
    market: TradeMarket,
    fromDate: string,
  ) => number | null | Promise<number | null>;
}

export type PreTradeResult =
  | { allowed: true; order: Readonly<OrderIntent> }
  | {
      allowed: false;
      reasons: Reason[];
      /** True when the cumulative-loss limit was hit: the caller must stop the algorithm. */
      autoStop?: boolean;
    };

// Hard limits that settings may tighten but never loosen (design safeguards 6 and 10).
export const HARD_MAX_ORDER_VALUE_KRW = 100_000_000;
export const HARD_MAX_QUOTE_AGE_MS = 60_000;
export const DEFAULT_MAX_GLOBAL_ORDERS_PER_DAY = 10;
const DEFAULT_PRICE_LIMIT_BUFFER = 0.03;
const DEFAULT_MAX_QUOTE_DEVIATION = 0.03;
const DEFAULT_FX_SAFETY_MARGIN = 0.02;
const FUTURE_QUOTE_TOLERANCE_MS = 5_000;

type ResolvedSettings = {
  safeguards: Safeguards;
  maxGlobalOrdersPerDay: number;
  sellTaxRate: number | undefined;
  priceLimitBuffer: number;
  maxQuoteDeviation: number;
  fxSafetyMargin: number;
  maxQuoteAgeMs: number;
  minSamples: number | undefined;
};

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const positiveInt = (v: unknown): v is number => positive(v) && Number.isInteger(v);

/** Null when any setting is malformed: a NaN threshold would silently disable a safeguard. */
function resolveSettings(
  market: TradeMarket,
  input: PreTradeSettings | undefined,
): ResolvedSettings | null {
  const s = input ?? {};
  const base = defaultSafeguards(market);
  const sg: Safeguards = { ...base, ...s.safeguards };
  if (
    !positiveInt(sg.maxOrdersPerDay) ||
    !Number.isInteger(sg.minHoldingTradingDays) ||
    sg.minHoldingTradingDays < 0 ||
    !(
      typeof sg.lossStopFraction === 'number' &&
      sg.lossStopFraction > 0 &&
      sg.lossStopFraction <= 1
    ) ||
    !positive(sg.liquidityMinAvgValue) ||
    !positiveInt(sg.liquidityWindow)
  )
    return null;
  const maxValue = s.maxOrderValueKrw ?? HARD_MAX_ORDER_VALUE_KRW;
  if (!positive(maxValue)) return null;
  // checkOrder compares quantity * price (we pass the KRW-equivalent price) against this cap.
  sg.maxOrderValue = Math.min(maxValue, HARD_MAX_ORDER_VALUE_KRW);
  const maxGlobal = s.maxGlobalOrdersPerDay ?? DEFAULT_MAX_GLOBAL_ORDERS_PER_DAY;
  const buffer = s.priceLimitBuffer ?? DEFAULT_PRICE_LIMIT_BUFFER;
  const deviation = s.maxQuoteDeviation ?? DEFAULT_MAX_QUOTE_DEVIATION;
  const margin = s.fxSafetyMargin ?? DEFAULT_FX_SAFETY_MARGIN;
  const age = s.maxQuoteAgeMs ?? HARD_MAX_QUOTE_AGE_MS;
  if (
    !positiveInt(maxGlobal) ||
    !(typeof buffer === 'number' && buffer >= 0 && buffer < 1) ||
    !positive(deviation) ||
    !(typeof margin === 'number' && margin >= 0 && margin <= 1) ||
    !positive(age) ||
    (s.sellTaxRate !== undefined &&
      !(typeof s.sellTaxRate === 'number' && s.sellTaxRate >= 0 && s.sellTaxRate < 1)) ||
    (s.minSamples !== undefined && !positiveInt(s.minSamples))
  )
    return null;
  return {
    safeguards: sg,
    maxGlobalOrdersPerDay: maxGlobal,
    sellTaxRate: s.sellTaxRate,
    priceLimitBuffer: buffer,
    maxQuoteDeviation: deviation,
    fxSafetyMargin: margin,
    maxQuoteAgeMs: Math.min(age, HARD_MAX_QUOTE_AGE_MS),
    minSamples: s.minSamples,
  };
}

/**
 * Price expressed in KRW for the 1e8 cap: KR as is; US times the FX midRate plus a safety margin
 * (Toss converts at its own rate). Null when a US order has no usable rate.
 */
export function krwEquivalentPrice(
  market: TradeMarket,
  price: number,
  fxMidRate: number | null,
  fxSafetyMargin = DEFAULT_FX_SAFETY_MARGIN,
): number | null {
  if (market === 'KR') return price;
  if (!positive(fxMidRate)) return null;
  return price * fxMidRate * (1 + fxSafetyMargin);
}

/**
 * Splits a sell into tranches whose KRW-equivalent value stays strictly below the 1e8 cap
 * (safeguard 10: sells are split, buys are refused). Each tranche is a separate order with its own
 * pre-trade check. `error` is set when even one share is too large or the inputs are unusable.
 */
export function planSellTranches(input: {
  market: TradeMarket;
  quantity: number;
  price: string;
  fxMidRate: number | null;
  settings?: Pick<PreTradeSettings, 'fxSafetyMargin' | 'maxOrderValueKrw'>;
}): { tranches: number[]; error?: undefined } | { tranches: []; error: ReasonCode } {
  const price = Number(input.price);
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || !positive(price))
    return { tranches: [], error: 'ORDER_INVALID' };
  const margin = input.settings?.fxSafetyMargin ?? DEFAULT_FX_SAFETY_MARGIN;
  const krw = krwEquivalentPrice(input.market, price, input.fxMidRate, margin);
  if (krw === null) return { tranches: [], error: 'FX_RATE_MISSING' };
  const cap = Math.min(
    input.settings?.maxOrderValueKrw ?? HARD_MAX_ORDER_VALUE_KRW,
    HARD_MAX_ORDER_VALUE_KRW,
  );
  const max = maxQuantityBelowValue(krw, cap);
  if (max < 1) return { tranches: [], error: 'ORDER_TOO_LARGE' };
  const tranches: number[] = [];
  for (let left = input.quantity; left > 0; left -= max) tranches.push(Math.min(left, max));
  return { tranches };
}

const REJECTION_TO_REASON: Record<OrderRejection, ReasonCode> = {
  'invalid-quantity': 'QUANTITY_NOT_INTEGER',
  'loss-stop': 'LOSS_LIMIT_REACHED',
  'not-owned': 'SELL_NOT_OWNED',
  'min-holding-period': 'MIN_HOLDING_PERIOD',
  liquidity: 'LIQUIDITY_BELOW_MINIMUM',
  'insufficient-history': 'HISTORY_INSUFFICIENT',
  'expected-profit-below-cost': 'EXPECTED_PROFIT_BELOW_COST',
  'max-orders-per-day': 'DAILY_LIMIT_ALGORITHM',
  'order-too-large': 'ORDER_TOO_LARGE',
  'insufficient-budget': 'BUDGET_EXCEEDED',
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateShape(ctx: PreTradeContext): Reason[] {
  const out: Reason[] = [];
  const { algorithm: a, order: o } = ctx;
  if (!a || !o || (a.market !== 'KR' && a.market !== 'US')) return [reason('ORDER_INVALID')];
  if (o.orderType !== 'LIMIT' || o.timeInForce !== 'DAY') out.push(reason('ORDER_NOT_LIMIT_DAY'));
  if ((o.side !== 'buy' && o.side !== 'sell') || !validSymbolFor(a.market, o.symbol))
    out.push(reason('ORDER_INVALID'));
  if (!Number.isSafeInteger(o.quantity) || o.quantity < 1) out.push(reason('QUANTITY_NOT_INTEGER'));
  if (
    typeof o.price !== 'string' ||
    (o.side === 'buy' || o.side === 'sell'
      ? normalizeLimitPrice(a.market, o.side, o.price) !== o.price
      : true)
  )
    out.push(reason('PRICE_INVALID'));
  if (!Number.isInteger(o.tranche) || o.tranche < 0) out.push(reason('ORDER_INVALID'));
  return out;
}

function isActive(range: { startDate: string | null; endDate: string | null }, today: string) {
  return (
    (range.startDate === null || range.startDate <= today) &&
    (range.endDate === null || range.endDate >= today)
  );
}

/** Evaluates the order once and returns every reason of the first stage that fails. */
export async function preTradeCheck(
  ctx: PreTradeContext,
  deps: PreTradeDeps,
): Promise<PreTradeResult> {
  try {
    return await evaluate(ctx, deps);
  } catch {
    // Anything unexpected (including a thrown dependency) is a refusal, never a pass.
    return { allowed: false, reasons: [reason('INTERNAL_ERROR')] };
  }
}

function refuse(reasons: Reason[], autoStop = false): PreTradeResult {
  return autoStop ? { allowed: false, reasons, autoStop: true } : { allowed: false, reasons };
}

async function evaluate(ctx: PreTradeContext, deps: PreTradeDeps): Promise<PreTradeResult> {
  // -- Stage 1: shape ---------------------------------------------------------------------------
  const shape = validateShape(ctx);
  if (shape.length) return refuse(shape);
  const { algorithm, order, market: facts } = ctx;
  const market = algorithm.market;
  const settings = resolveSettings(market, ctx.settings);
  if (!settings) return refuse([reason('SETTINGS_INVALID')]);
  const sg = settings.safeguards;
  const now = deps.now();
  const today = kstDateKey(now);
  const price = Number(order.price);
  const currency = currencyOf(market);

  // -- Stage 2: control state (store) ------------------------------------------------------------
  const stage2: Reason[] = [];
  let autoStop = false;
  let emergency: boolean;
  try {
    emergency = await deps.store.getEmergencyStop();
  } catch {
    return refuse([reason('EMERGENCY_STOP_UNREADABLE')]);
  }
  if (emergency) stage2.push(reason('EMERGENCY_STOP'));
  try {
    if (await deps.store.isAlgorithmStopped(algorithm.id)) stage2.push(reason('ALGORITHM_STOPPED'));
  } catch {
    stage2.push(reason('STORE_UNAVAILABLE'));
  }
  if (!positive(algorithm.budget)) stage2.push(reason('BUDGET_NOT_SET'));
  else if (typeof ctx.cumulativePnl !== 'number' || !Number.isFinite(ctx.cumulativePnl))
    stage2.push(reason('LOSS_UNKNOWN'));
  else if (ctx.cumulativePnl <= -sg.lossStopFraction * algorithm.budget) {
    stage2.push(reason('LOSS_LIMIT_REACHED'));
    autoStop = true;
  }
  let algorithmOrdersToday = 0;
  try {
    const counts = await deps.store.getDailyCounts(today, algorithm.id);
    algorithmOrdersToday = counts.algorithm;
    if (counts.algorithm >= sg.maxOrdersPerDay) stage2.push(reason('DAILY_LIMIT_ALGORITHM'));
    if (counts.global >= settings.maxGlobalOrdersPerDay) stage2.push(reason('DAILY_LIMIT_GLOBAL'));
  } catch {
    stage2.push(reason('STORE_UNAVAILABLE'));
  }
  if (stage2.length) return refuse(stage2, autoStop);

  // -- Stage 3: local data and position rules -----------------------------------------------------
  const stage3: Reason[] = [];
  const quote = facts.quote;
  if (!quote || !positive(quote.price) || !Number.isFinite(Date.parse(quote.observedAt))) {
    stage3.push(reason('QUOTE_MISSING'));
  } else {
    const age = now.getTime() - Date.parse(quote.observedAt);
    if (age > settings.maxQuoteAgeMs || age < -FUTURE_QUOTE_TOLERANCE_MS)
      stage3.push(reason('QUOTE_STALE'));
    // Only the unfavourable direction is refused: a far-away limit that cannot fill early is
    // harmless, a limit that pays/sells much worse than the market is not.
    const worse =
      order.side === 'buy'
        ? price > quote.price * (1 + settings.maxQuoteDeviation)
        : price < quote.price * (1 - settings.maxQuoteDeviation);
    if (worse) stage3.push(reason('PRICE_FAR_FROM_QUOTE'));
  }
  if (
    typeof facts.latestDailyBarDate !== 'string' ||
    !DATE.test(facts.latestDailyBarDate) ||
    !DATE.test(facts.expectedDailyBarDate) ||
    facts.latestDailyBarDate < facts.expectedDailyBarDate
  )
    stage3.push(reason('DAILY_BAR_MISSING'));
  if (algorithm.usesValueSignal && facts.financialsPresent !== true)
    stage3.push(reason('FINANCIALS_MISSING'));
  const krwPrice = krwEquivalentPrice(market, price, facts.fxMidRate, settings.fxSafetyMargin);
  if (krwPrice === null) stage3.push(reason('FX_RATE_MISSING'));

  // Positions and working orders come from the store (the algorithm's own ledger).
  let ownAvailable = 0;
  let lastBuyDate: string | null = null;
  let committed = 0;
  try {
    const orders = await deps.store.listOrders({ algorithmId: algorithm.id });
    const ledger = summarizeLedger(orders);
    committed = ledger.committed;
    const position = ledger.positions.get(order.symbol);
    ownAvailable = Math.max(0, (position?.quantity ?? 0) - (position?.pendingSellQuantity ?? 0));
    lastBuyDate = position?.lastBuyDate ?? null;
    const sameSymbol = orders.filter((o) => o.symbol === order.symbol);
    if (sameSymbol.some((o) => o.status === 'reserved' || o.status === 'unknown'))
      stage3.push(reason('UNRECONCILED_ORDER'));
    else if (sameSymbol.some((o) => o.status === 'accepted' || o.status === 'partially-filled'))
      stage3.push(reason('OPEN_ORDER_EXISTS'));
  } catch {
    stage3.push(reason('STORE_UNAVAILABLE'));
  }

  if (
    order.side === 'buy' &&
    positive(algorithm.budget) &&
    committed + order.quantity * price > algorithm.budget
  )
    stage3.push(reason('BUDGET_EXCEEDED'));

  if (stage3.length) return refuse(stage3);

  let heldTradingDays: number | null = null;
  if (order.side === 'sell' && lastBuyDate !== null) {
    try {
      heldTradingDays = await deps.tradingDaysSince(market, lastBuyDate);
    } catch {
      heldTradingDays = null;
    }
  }
  // Reused rule set (src/lib/algo/safeguards.ts): quantity, sell ownership and minimum holding,
  // buy liquidity, per-algorithm daily count and the order value cap. Loss stop, emergency stop,
  // global count, algorithm status and budget were handled above (checkOrder has no input for
  // them). Expected profit is enforced in the second call after the commission rate is known.
  const core = (expected: { enforce: boolean; expected: number | null; roundTripCost: number }) =>
    checkOrder({
      side: order.side,
      quantity: order.quantity,
      price: krwPrice!,
      ordersToday: algorithmOrdersToday,
      stopped: false,
      ownQuantity: ownAvailable,
      heldTradingDays,
      avgTradedValue: facts.avgTradedValue,
      expectedProfit: expected,
      safeguards: sg,
    });
  const first = core({ enforce: false, expected: null, roundTripCost: 0 });
  if (!first.ok) return refuse([reason(REJECTION_TO_REASON[first.reason])]);
  // checkOrder clamps an oversized sell; this check refuses instead so the order is never altered.
  if (first.clamped) return refuse([reason('SELL_EXCEEDS_OWNED')]);

  // -- Stage 4: remote reads (sequential; stop at the first refusal) -----------------------------
  const remote = async (): Promise<Reason[]> => {
    try {
      const open = await deps.toss.listOrders({ status: 'OPEN', symbol: order.symbol });
      if (open.orders.some((o) => o.symbol === order.symbol)) return [reason('OPEN_ORDER_EXISTS')];
    } catch {
      return [reason('OPEN_ORDERS_UNAVAILABLE')];
    }
    try {
      const warnings = await deps.toss.getStockWarnings(order.symbol);
      // Every warning type blocks (unknown types too): the official enum is not exhaustive for us.
      if (warnings.some((w) => isActive(w, today))) return [reason('STOCK_WARNING')];
    } catch {
      return [reason('WARNINGS_UNAVAILABLE')];
    }
    try {
      const limits = await deps.toss.getPriceLimits(order.symbol);
      if (limits.currency !== currency) return [reason('PRICE_LIMITS_UNAVAILABLE')];
      const upper = limits.upperLimitPrice === null ? null : Number(limits.upperLimitPrice);
      const lower = limits.lowerLimitPrice === null ? null : Number(limits.lowerLimitPrice);
      // US has no price limits (both null). A KR symbol without limits cannot be verified.
      if (market === 'KR' && upper === null && lower === null)
        return [reason('PRICE_LIMITS_UNAVAILABLE')];
      const buffer = settings.priceLimitBuffer;
      if (
        (upper !== null && price >= upper * (1 - buffer)) ||
        (lower !== null && price <= lower * (1 + buffer))
      )
        return [reason('NEAR_PRICE_LIMIT')];
    } catch {
      return [reason('PRICE_LIMITS_UNAVAILABLE')];
    }
    if (order.side === 'sell') {
      try {
        const sellable = Math.floor(
          Number((await deps.toss.getSellableQuantity(order.symbol)).sellableQuantity),
        );
        if (!Number.isFinite(sellable)) return [reason('SELLABLE_UNAVAILABLE')];
        if (order.quantity > sellable) return [reason('SELL_EXCEEDS_SELLABLE')];
      } catch {
        return [reason('SELLABLE_UNAVAILABLE')];
      }
      return [];
    }
    // Buy: costs, expected profit, then buying power.
    let commissionRate: number;
    try {
      const rates = (await deps.toss.getCommissions())
        .filter((c) => c.marketCountry === market && isActive(c, today))
        .map((c) => Number(c.commissionRate))
        .filter((r) => Number.isFinite(r) && r >= 0 && r < 1);
      if (!rates.length) return [reason('COST_SETTINGS_MISSING')];
      commissionRate = Math.max(...rates); // several active entries: assume the dearest.
    } catch {
      return [reason('COMMISSIONS_UNAVAILABLE')];
    }
    const sellTax = market === 'KR' ? settings.sellTaxRate : (settings.sellTaxRate ?? 0);
    if (sellTax === undefined) return [reason('COST_SETTINGS_MISSING')];
    const ep = ctx.expectedProfit;
    const expected =
      ep && typeof ep.score === 'number' && Number.isFinite(ep.score)
        ? lookupExpectedProfit(ep.stats, ep.score, settings.minSamples)
        : null;
    const second = core({
      enforce: true,
      expected,
      roundTripCost: roundTripCostRate({ commissionRate, sellTaxRate: sellTax }),
    });
    if (!second.ok) return [reason(REJECTION_TO_REASON[second.reason])];
    try {
      const power = await deps.toss.getBuyingPower(currency);
      const cash = Number(power.cashBuyingPower);
      // KR: KRW cash. US: USD cash only (no FX: the algorithm never converts currency).
      if (power.currency !== currency || !Number.isFinite(cash))
        return [reason('BUYING_POWER_UNAVAILABLE')];
      if (cash < order.quantity * price * (1 + commissionRate))
        return [reason('BUYING_POWER_INSUFFICIENT')];
    } catch {
      return [reason('BUYING_POWER_UNAVAILABLE')];
    }
    return [];
  };
  const stage4 = await remote();
  if (stage4.length) return refuse(stage4);

  // -- Final: fresh emergency-stop re-read after the (slow) remote reads --------------------------
  try {
    if (await deps.store.getEmergencyStop()) return refuse([reason('EMERGENCY_STOP')]);
  } catch {
    return refuse([reason('EMERGENCY_STOP_UNREADABLE')]);
  }
  return { allowed: true, order: Object.freeze({ ...order }) };
}

/**
 * Re-validates the single tick-size price correction (a less aggressive price) against the pieces
 * of the check that depend on price: the order value cap, the quote deviation and the price scale.
 * Pure. Used as the veto for TossOrderClient.placeOrder's `onPriceCorrection`.
 */
export function isAcceptableCorrection(
  ctx: PreTradeContext,
  correctedPrice: string,
  now: Date,
): boolean {
  const { algorithm, order, market: facts } = ctx;
  const settings = resolveSettings(algorithm.market, ctx.settings);
  const corrected = Number(correctedPrice);
  const original = Number(order.price);
  if (!settings || !positive(corrected) || !positive(original)) return false;
  if (normalizeLimitPrice(algorithm.market, order.side, correctedPrice) !== correctedPrice)
    return false;
  // Less aggressive only (buy lower, sell higher); the quote checks of the original order still hold.
  if (order.side === 'buy' ? corrected > original : corrected < original) return false;
  const krw = krwEquivalentPrice(
    algorithm.market,
    corrected,
    facts.fxMidRate,
    settings.fxSafetyMargin,
  );
  if (krw === null) return false;
  return (
    order.quantity <=
    maxQuantityBelowValue(krw, settings.safeguards.maxOrderValue ?? HARD_MAX_ORDER_VALUE_KRW)
  );
}
