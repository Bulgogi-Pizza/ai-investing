import { clampScore } from './signals';
import type { DailyBar } from './types';

/**
 * Supply (수급) signal for live and paper decisions. There is no point-in-time history for it, so
 * the backtester never uses it; the daily snapshot job stores the investor flows going forward and
 * the paper job reads them back.
 *
 * Heuristic (proposal, documented in docs/implementation/algorithm.md): over the last `days`
 * completed trading days, net buying of foreigners plus institutions as a share of traded volume,
 * mapped so that `scale` of volume maps to +-1. It needs `minDays` of those days to have stored
 * flows; otherwise the signal is null (and the algorithm labels it "excluded").
 */
export type InvestorFlowDay = {
  date: string;
  /** Net buy volume (shares), foreigners. */
  foreignerNet: number;
  /** Net buy volume (shares), institutions. */
  institutionNet: number;
};

export type SupplyParams = { days: number; minDays: number; scale: number };
export const defaultSupplyParams: SupplyParams = { days: 5, minDays: 3, scale: 0.05 };

/** Completed bars only (oldest first); flows may cover any dates. */
export function supplyScore(
  flows: InvestorFlowDay[],
  bars: DailyBar[],
  p: SupplyParams = defaultSupplyParams,
): number | null {
  const window = bars.slice(Math.max(0, bars.length - p.days));
  const byDate = new Map(flows.map((f) => [f.date, f]));
  let net = 0;
  let volume = 0;
  let matched = 0;
  for (const bar of window) {
    const flow = byDate.get(bar.date);
    if (!flow || !Number.isFinite(flow.foreignerNet) || !Number.isFinite(flow.institutionNet))
      continue;
    net += flow.foreignerNet + flow.institutionNet;
    volume += bar.volume;
    matched++;
  }
  if (matched < p.minDays || !(volume > 0)) return null;
  return clampScore(net / volume / p.scale);
}
