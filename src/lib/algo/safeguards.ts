import type { Market } from './types';

/**
 * Safeguard settings mirroring docs/planning/next-phase-design.md section 4 (numbers refer to
 * the "안전장치" list). Defaults are the 2026-10-21 decisions.
 */
export type Safeguards = {
  /** 2. Orders per algorithm per day. */
  maxOrdersPerDay: number;
  /** 2. A position cannot be sold before this many trading days have passed since the buy. */
  minHoldingTradingDays: number;
  /** 4. Cumulative loss (realized + unrealized) at this fraction of the budget stops the run. */
  lossStopFraction: number;
  /** 8. Minimum average traded value (price * volume) over the liquidity window. */
  liquidityMinAvgValue: number;
  liquidityWindow: number;
  /**
   * 10. Orders at or above this notional are never placed (the broker's high-value confirmation flag is never set):
   * buys are rejected, sells are split into tranches below it.
   * KR default 100,000,000 KRW. US has no default here because it needs an FX rate; pass the
   * USD equivalent when known (null = not checked, flagged as a warning by the backtester).
   */
  maxOrderValue: number | null;
};

export function defaultSafeguards(market: Market): Safeguards {
  return {
    maxOrdersPerDay: 3,
    minHoldingTradingDays: 5,
    lossStopFraction: 0.2,
    liquidityMinAvgValue: market === 'KR' ? 1e9 : 5e6,
    liquidityWindow: 20,
    maxOrderValue: market === 'KR' ? 100_000_000 : null,
  };
}

/** Largest integer quantity whose notional (quantity * price) stays strictly below `cap`. */
export function maxQuantityBelowValue(price: number, cap: number): number {
  const q = Math.ceil(cap / price) - 1;
  return q >= 0 ? q : 0;
}

export type OrderRejection =
  | 'invalid-quantity'
  | 'loss-stop'
  | 'not-owned'
  | 'min-holding-period'
  | 'liquidity'
  | 'insufficient-history'
  | 'expected-profit-below-cost'
  | 'max-orders-per-day'
  | 'order-too-large'
  | 'insufficient-budget';

export type OrderCheckInput = {
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  /** Orders already accepted for this algorithm today. */
  ordersToday: number;
  /** True once the cumulative-loss stop has triggered. */
  stopped: boolean;
  /** Shares this algorithm bought and still holds (sell cap, 7). */
  ownQuantity: number;
  /** Trading days since the position was opened (sells). */
  heldTradingDays: number | null;
  /** Average traded value over the liquidity window; null when history is too short (buys). */
  avgTradedValue: number | null;
  /** Expected-profit rule for buys: `enforce` false for the labeled research mode. */
  expectedProfit: { enforce: boolean; expected: number | null; roundTripCost: number };
  safeguards: Safeguards;
};

export type OrderCheckResult =
  { ok: true; quantity: number; clamped: boolean } | { ok: false; reason: OrderRejection };

/**
 * The single pre-trade check. Pure: the caller supplies every fact. Checks run in a fixed order
 * (first failure wins): quantity, loss stop, side-specific rules, per-day order limit, order
 * value cap. A sell larger than the own quantity is clamped to it (7).
 */
export function checkOrder(i: OrderCheckInput): OrderCheckResult {
  const s = i.safeguards;
  if (!Number.isInteger(i.quantity) || i.quantity < 1)
    return { ok: false, reason: 'invalid-quantity' };
  if (i.stopped) return { ok: false, reason: 'loss-stop' };
  let quantity = i.quantity;
  let clamped = false;
  if (i.side === 'sell') {
    if (i.ownQuantity < 1) return { ok: false, reason: 'not-owned' };
    if ((i.heldTradingDays ?? 0) < s.minHoldingTradingDays)
      return { ok: false, reason: 'min-holding-period' };
    if (quantity > i.ownQuantity) {
      quantity = i.ownQuantity;
      clamped = true;
    }
  } else {
    if (i.avgTradedValue === null || i.avgTradedValue < s.liquidityMinAvgValue)
      return { ok: false, reason: 'liquidity' };
    const e = i.expectedProfit;
    if (e.enforce) {
      if (e.expected === null) return { ok: false, reason: 'insufficient-history' };
      if (!(e.expected > e.roundTripCost))
        return { ok: false, reason: 'expected-profit-below-cost' };
    }
  }
  if (i.ordersToday >= s.maxOrdersPerDay) return { ok: false, reason: 'max-orders-per-day' };
  if (s.maxOrderValue !== null && quantity * i.price >= s.maxOrderValue)
    return { ok: false, reason: 'order-too-large' };
  return { ok: true, quantity, clamped };
}
