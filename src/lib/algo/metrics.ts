export const TRADING_DAYS_PER_YEAR = 252;

/** Largest peak-to-trough fall as a non-negative fraction (0.12 = 12%). Input includes the start value. */
export function maxDrawdown(equity: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const e of equity) {
    peak = Math.max(peak, e);
    if (peak > 0) worst = Math.max(worst, (peak - e) / peak);
  }
  return worst;
}

/** Simple daily returns e[i] / e[i-1] - 1 (skips non-positive previous values). */
export function dailyReturns(equity: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++)
    if (equity[i - 1] > 0) out.push(equity[i] / equity[i - 1] - 1);
  return out;
}

/** Annualized volatility: sample standard deviation of daily returns * sqrt(252). Null with < 2 returns. */
export function annualizedVolatility(equity: number[]): number | null {
  const r = dailyReturns(equity);
  if (r.length < 2) return null;
  const m = r.reduce((a, v) => a + v, 0) / r.length;
  const variance = r.reduce((a, v) => a + (v - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}
