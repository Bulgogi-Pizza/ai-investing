import {
  decideSymbols,
  type ExternalDecision,
  type PaperQuote,
  type SymbolDecision,
} from './paper';
import type { AlgorithmDefinition, SignalWeight } from './types';

/**
 * Order intents of one live run (stage 7f). The decision engine is the paper day's own
 * (`decideSymbols`), so a live algorithm decides exactly like its paper twin on the same data. This
 * module only turns decisions into order intents from the algorithm's own live ledger. It does not
 * check a single safeguard and places nothing: every intent still has to pass the pre-trade check
 * (src/server/trading/pre-trade.ts) and the atomic reservation in the executor. Pure.
 */
export type LiveDecisionInput = {
  algorithm: AlgorithmDefinition;
  usedSignals: SignalWeight[];
  externalDecisions?: Record<string, ExternalDecision>;
  /** Session date (market-local). */
  date: string;
  quotes: PaperQuote[];
  /**
   * Shares of each symbol the algorithm itself bought and still holds and has not already put into a
   * working sell (from its own live orders; never the account's holdings).
   */
  owned: Record<string, number>;
  /** Budget in the market currency and the part of it already committed (held cost + working buys). */
  budget: number;
  committed: number;
  /** Fraction of notional per side (from the broker's commission schedule); null = unknown. */
  commissionRate: number | null;
};

export type LiveOrderIntent = {
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  /** Decision-time quote; the executor rounds it to the documented price scale (less aggressive side). */
  price: number;
  score: number | null;
  reasons: string[];
};
export type LiveHold = {
  symbol: string;
  action: SymbolDecision['action'];
  score: number | null;
  /** Set when an order was wanted but could not be sized. */
  blockedBy?: 'insufficient-budget' | 'commission-unknown';
};
export type LiveDecisionResult = { orders: LiveOrderIntent[]; decisions: LiveHold[] };

const reasonTexts: Record<string, string> = {
  'buy-threshold': '종합 점수가 매수 기준 이상',
  'sell-threshold': '종합 점수가 매도 기준 이하',
  'target-removed': '대상 종목에서 제외됨',
};

export function buildLiveDecisions(input: LiveDecisionInput): LiveDecisionResult {
  const { algorithm, date } = input;
  const targets = new Set(algorithm.symbols);
  const quotes = [...input.quotes].sort((a, b) =>
    a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0,
  );
  const traded = quotes.filter(
    (q) =>
      q.price !== null &&
      Number.isFinite(q.price) &&
      q.price > 0 &&
      (targets.has(q.symbol) || (input.owned[q.symbol] ?? 0) > 0),
  );
  const { decisions, reasonsOf } = decideSymbols({
    algorithm,
    usedSignals: input.usedSignals,
    externalDecisions: input.externalDecisions,
    date,
    traded,
  });
  const external = input.externalDecisions !== undefined;
  const isDual = algorithm.template === 'dualMomentum';
  const orders: LiveOrderIntent[] = [];
  const holds: LiveHold[] = [];
  const blocked = new Map<string, LiveHold['blockedBy']>();

  // Sells first (they free budget on the next run, never inside this one: the budget is committed
  // until the sell fills). A position is sold whole; the executor splits it below the value cap.
  for (const q of traded) {
    const d = decisions.get(q.symbol)!;
    const owned = input.owned[q.symbol] ?? 0;
    if (d.action !== 'sell' || owned < 1) continue;
    orders.push({
      symbol: q.symbol,
      side: 'sell',
      quantity: Math.floor(owned),
      price: q.price as number,
      score: d.score,
      reasons: reasonsOf.get(q.symbol) ?? [reasonTexts[d.reason] ?? d.reason],
    });
  }

  const buys = traded
    .filter((q) => {
      const d = decisions.get(q.symbol)!;
      return (
        targets.has(q.symbol) &&
        d.action === 'buy' &&
        (external ? true : d.score !== null) &&
        (input.owned[q.symbol] ?? 0) < 1
      );
    })
    .sort(
      (a, b) =>
        (decisions.get(b.symbol)!.score ?? 0) - (decisions.get(a.symbol)!.score ?? 0) ||
        (a.symbol < b.symbol ? -1 : 1),
    );
  const positionBudget =
    input.budget *
    (algorithm.positionFraction ??
      (isDual ? 1 / (algorithm.dualMomentum?.topN ?? 1) : 1 / algorithm.symbols.length));
  let remaining = input.budget - input.committed;
  for (const q of buys) {
    const d = decisions.get(q.symbol)!;
    const price = q.price as number;
    if (input.commissionRate === null || !(input.commissionRate >= 0 && input.commissionRate < 1)) {
      blocked.set(q.symbol, 'commission-unknown');
      continue;
    }
    const quantity = Math.floor(
      Math.min(positionBudget, remaining) / (price * (1 + input.commissionRate)),
    );
    if (quantity < 1) {
      blocked.set(q.symbol, 'insufficient-budget');
      continue;
    }
    remaining -= quantity * price;
    orders.push({
      symbol: q.symbol,
      side: 'buy',
      quantity,
      price,
      score: d.score,
      reasons: reasonsOf.get(q.symbol) ?? [reasonTexts[d.reason] ?? d.reason],
    });
  }

  for (const q of traded) {
    const d = decisions.get(q.symbol)!;
    holds.push({
      symbol: q.symbol,
      action: d.action,
      score: d.score,
      ...(blocked.has(q.symbol) ? { blockedBy: blocked.get(q.symbol) } : {}),
    });
  }
  return { orders, decisions: holds };
}
