import type { MarketCode } from '../server/toss.js';
import {
  MAX_SNAPSHOT_TARGETS,
  validTargetSymbol,
  type SnapshotRepository,
} from '../server/snapshots.js';
import { safeErrorCode } from './runner.js';

/**
 * Where the snapshot job gets its symbols. Providers are independent: one failing (for example the
 * holdings call) never hides the others. Algorithm targets (stage 7a) plug in as another provider.
 */
export type TargetSource = 'holdings' | 'list' | 'algorithm';
export type TargetSymbol = { market: MarketCode; symbol: string };
export interface SnapshotTargetProvider {
  readonly name: TargetSource;
  targets(): Promise<TargetSymbol[]>;
}
/** Owner portfolio holdings. Only the symbol and market are read from the portfolio. */
export class HoldingsTargetProvider implements SnapshotTargetProvider {
  readonly name = 'holdings' as const;
  constructor(
    private portfolio: {
      portfolio(userId: string): Promise<{ holdings: { symbol: string; market: MarketCode }[] }>;
    },
    private ownerUserId: string,
  ) {}
  async targets() {
    const result = await this.portfolio.portfolio(this.ownerUserId);
    return result.holdings.map(({ symbol, market }) => ({ market, symbol }));
  }
}
/** Owner-maintained list stored in Firestore `snapshotTargets/{ownerUserId}`. */
export class ListTargetProvider implements SnapshotTargetProvider {
  readonly name = 'list' as const;
  constructor(
    private repository: Pick<SnapshotRepository, 'getTargets'>,
    private ownerUserId: string,
  ) {}
  async targets() {
    return (await this.repository.getTargets(this.ownerUserId))?.targets ?? [];
  }
}
export type CollectedTargets = {
  targets: TargetSymbol[];
  bySource: Record<TargetSource, number>;
  /** Provider name -> sanitized failure code. */
  failures: Partial<Record<TargetSource, string>>;
  invalid: number;
  truncated: boolean;
};
/** Merges the providers' symbols for one market: validated, de-duplicated, capped. */
export async function collectTargets(
  providers: SnapshotTargetProvider[],
  market: MarketCode,
): Promise<CollectedTargets> {
  const merged = new Map<string, TargetSymbol>();
  const bySource: Record<TargetSource, number> = { holdings: 0, list: 0, algorithm: 0 };
  const failures: CollectedTargets['failures'] = {};
  let invalid = 0;
  let truncated = false;
  for (const provider of providers) {
    let found: TargetSymbol[];
    try {
      found = await provider.targets();
    } catch (error) {
      failures[provider.name] = safeErrorCode(error);
      continue;
    }
    for (const target of found) {
      if (target.market !== market) continue;
      if (!validTargetSymbol(target.market, target.symbol)) {
        invalid++;
        continue;
      }
      const key = target.symbol.toUpperCase();
      if (merged.has(key)) continue;
      if (merged.size >= MAX_SNAPSHOT_TARGETS) {
        truncated = true;
        continue;
      }
      merged.set(key, { market, symbol: target.symbol });
      bySource[provider.name]++;
    }
  }
  return { targets: [...merged.values()], bySource, failures, invalid, truncated };
}
