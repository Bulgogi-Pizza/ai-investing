import type { OrderTransport } from '../server/trading/toss-orders.js';
import type { DailyBar } from '../lib/algo/index.js';

/**
 * Fresh market facts for the live job, read through the order transport so nothing is cached: the
 * quote an order is checked against must be the one the broker reports at that moment (design
 * safeguard 6: no order without a quote received within the last minute). Reads only (GET). Every
 * value is parsed strictly; anything malformed is "no data", which makes the pre-trade check refuse.
 */
const DECIMAL = /^\d+(\.\d+)?$/;
const SYMBOL = /^[A-Za-z0-9.\-]{1,30}$/;

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const decimalNumber = (v: unknown): number | null => {
  if (typeof v !== 'string' || v.length > 30 || !DECIMAL.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const timestampText = (v: unknown): string | null =>
  typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null;

export type FreshQuote = { price: number; observedAt: string };

/** GET /api/v1/prices for one symbol. Null on any problem (including a missing timestamp). */
export async function fetchFreshQuote(
  transport: Pick<OrderTransport, 'send'>,
  symbol: string,
  currency: 'KRW' | 'USD',
): Promise<FreshQuote | null> {
  if (!SYMBOL.test(symbol)) return null;
  try {
    const response = await transport.send({
      method: 'GET',
      path: '/api/v1/prices',
      query: { symbols: symbol },
    });
    if (response.status !== 200) return null;
    const result = asRecord(response.body)?.result;
    if (!Array.isArray(result) || result.length !== 1) return null;
    const q = asRecord(result[0]);
    if (!q || typeof q.symbol !== 'string' || q.symbol.toUpperCase() !== symbol.toUpperCase())
      return null;
    if (q.currency !== currency) return null;
    const price = decimalNumber(q.lastPrice);
    const observedAt = timestampText(q.timestamp);
    return price !== null && observedAt !== null ? { price, observedAt } : null;
  } catch {
    return null;
  }
}

export type FreshFx = { midRate: number; observedAt: string };

/**
 * GET /api/v1/exchange-rate (USD -> KRW). `observedAt` is the time the rate is known to have been
 * current: now while the broker says it is within its validity window, otherwise the start of that
 * window (which the pre-trade check then rejects if it is older than its limit).
 */
export async function fetchFreshFx(
  transport: Pick<OrderTransport, 'send'>,
  now: Date,
): Promise<FreshFx | null> {
  try {
    const response = await transport.send({
      method: 'GET',
      path: '/api/v1/exchange-rate',
      query: { baseCurrency: 'USD', quoteCurrency: 'KRW' },
    });
    if (response.status !== 200) return null;
    const r = asRecord(asRecord(response.body)?.result);
    if (!r || r.baseCurrency !== 'USD' || r.quoteCurrency !== 'KRW') return null;
    const midRate = decimalNumber(r.midRate);
    const from = timestampText(r.validFrom);
    const until = timestampText(r.validUntil);
    if (midRate === null || from === null || until === null) return null;
    const t = now.getTime();
    const inWindow = Date.parse(from) <= t && t <= Date.parse(until);
    return { midRate, observedAt: inWindow ? now.toISOString() : from };
  } catch {
    return null;
  }
}

/** Mean traded value (close x volume) of the last `window` completed bars; null when there are fewer. */
export function averageTradedValue(bars: DailyBar[], window = 20): number | null {
  const last = bars.slice(-window);
  if (last.length < window) return null;
  const value = last.reduce((sum, b) => sum + b.close * b.volume, 0) / window;
  return Number.isFinite(value) ? value : null;
}
