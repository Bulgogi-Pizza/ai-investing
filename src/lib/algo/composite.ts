import { clampScore } from './signals';
import type {
  AlgorithmDefinition,
  Decision,
  DualMomentumParams,
  SignalId,
  SignalWeight,
} from './types';

export type CompositeResult = {
  /** Weighted mean over the available signals; null when insufficient. */
  score: number | null;
  totalWeight: number;
  nullWeight: number;
  insufficient: boolean;
};

/**
 * Weighted sum renormalized over the non-null signals:
 * score = sum(w_i * s_i) / sum(w_i) over signals with a score. When the weight carried by null
 * (or missing) signals is more than half of the configured weight, there is not enough data and
 * the score is null. Exactly half is still allowed.
 */
export function compositeScore(
  weights: SignalWeight[],
  scores: Partial<Record<SignalId, number | null>>,
): CompositeResult {
  let total = 0;
  let nullWeight = 0;
  let weighted = 0;
  let usedWeight = 0;
  for (const { id, weight } of weights) {
    if (!(weight > 0)) continue;
    total += weight;
    const s = scores[id];
    if (s === null || s === undefined) {
      nullWeight += weight;
      continue;
    }
    weighted += weight * s;
    usedWeight += weight;
  }
  if (total <= 0 || nullWeight > total / 2 || usedWeight <= 0)
    return { score: null, totalWeight: total, nullWeight, insufficient: true };
  return { score: weighted / usedWeight, totalWeight: total, nullWeight, insufficient: false };
}

/** Formula decision: composite score against the buy/sell thresholds (buy when score >= buy). */
export function decideFormula(
  algorithm: Pick<AlgorithmDefinition, 'signals' | 'buyThreshold' | 'sellThreshold'>,
  scores: Partial<Record<SignalId, number | null>>,
): Decision {
  const signals: Decision['signals'] = {};
  for (const { id, weight } of algorithm.signals) {
    signals[id] = { score: scores[id] ?? null, weight };
  }
  const c = compositeScore(algorithm.signals, scores);
  if (c.insufficient || c.score === null)
    return { action: 'hold', score: null, reason: 'insufficient-data', signals };
  if (c.score >= algorithm.buyThreshold)
    return { action: 'buy', score: c.score, reason: 'buy-threshold', signals };
  if (c.score <= algorithm.sellThreshold)
    return { action: 'sell', score: c.score, reason: 'sell-threshold', signals };
  return { action: 'hold', score: c.score, reason: 'between-thresholds', signals };
}

/**
 * Dual momentum across the target list. `returns` are the N-day returns per symbol (null =
 * insufficient data). Relative momentum: rank symbols with data by return (descending, ties by
 * symbol); only the best `topN` may be held. Absolute momentum: the return must exceed
 * `absoluteThreshold`. A symbol that passes both gets 'buy' with score clamp(ret / scale) in
 * (0, 1]; one failing the absolute test gets 'sell' with score min(0, clamp(ret / scale)); one
 * that only fails the rank gets 'sell' with score 0 (rotate out). Symbols without data hold with
 * 'insufficient-data'. "Sell" is a no-op for symbols that are not held.
 */
export function decideDualMomentum(
  returns: Record<string, number | null>,
  p: DualMomentumParams,
): Record<string, Decision> {
  const ranked = Object.entries(returns)
    .filter((e): e is [string, number] => e[1] !== null)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const rank = new Map(ranked.map(([symbol], i) => [symbol, i + 1]));
  const out: Record<string, Decision> = {};
  for (const symbol of Object.keys(returns)) {
    const ret = returns[symbol];
    const r = rank.get(symbol) ?? null;
    if (ret === null || r === null) {
      out[symbol] = {
        action: 'hold',
        score: null,
        reason: 'insufficient-data',
        signals: {},
        detail: { momentumReturn: null, rank: null },
      };
      continue;
    }
    const raw = clampScore(ret / p.scale);
    const detail = { momentumReturn: ret, rank: r };
    if (!(ret > p.absoluteThreshold)) {
      out[symbol] = {
        action: 'sell',
        score: Math.min(0, raw),
        reason: 'absolute-momentum',
        signals: {},
        detail,
      };
    } else if (r > p.topN) {
      out[symbol] = {
        action: 'sell',
        score: 0,
        reason: 'relative-momentum',
        signals: {},
        detail,
      };
    } else {
      out[symbol] = {
        action: 'buy',
        score: raw,
        reason: 'dual-momentum-pass',
        signals: {},
        detail,
      };
    }
  }
  return out;
}
