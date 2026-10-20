import { summarizeLedger, type LiveOrderRecord } from './stores.js';

/**
 * Cumulative profit and loss of one live algorithm, from its own orders only (design safeguard 4:
 * realized + unrealized). Pure.
 *
 * Realized part: sell proceeds minus buy cost of every FILLED quantity, at the average fill price
 * the reconciliation stored (the limit price when none was reported). Unrealized part: the shares
 * still held, valued at the given marks. Commission and the sell tax are estimated from the rates
 * passed in: the order record keeps no per-fill fees, and an estimate that is a little too high only
 * stops a losing algorithm a little earlier. Working (unfilled) quantities count for nothing.
 *
 * Returns null when a held symbol has no mark: the pre-trade check treats an unknown P&L as a
 * refusal (fail closed).
 */
export type PnlCosts = { commissionRate: number; sellTaxRate: number };
/** Used when the broker's commission schedule could not be read: deliberately high. */
export const FALLBACK_COMMISSION_RATE = 0.005;

export function liveCumulativePnl(
  orders: LiveOrderRecord[],
  marks: Readonly<Record<string, number | undefined>>,
  costs: PnlCosts,
): number | null {
  let cash = 0;
  for (const order of orders) {
    if (order.status === 'rejected') continue;
    const filled = Math.min(Math.max(order.filledQuantity, 0), order.quantity);
    if (!(filled > 0)) continue;
    const price = order.averageFilledPrice ?? Number(order.price);
    if (!Number.isFinite(price) || price <= 0) return null;
    const notional = filled * price;
    const commission = notional * costs.commissionRate;
    cash +=
      order.side === 'buy'
        ? -notional - commission
        : notional - commission - notional * costs.sellTaxRate;
  }
  let value = 0;
  for (const position of summarizeLedger(orders).positions.values()) {
    if (!(position.quantity > 0)) continue;
    const mark = marks[position.symbol];
    if (typeof mark !== 'number' || !Number.isFinite(mark) || mark <= 0) return null;
    value += position.quantity * mark;
  }
  return cash + value;
}
