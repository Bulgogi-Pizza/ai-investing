/**
 * Expected-profit statistics: the average gross return of signal round trips per composite-score
 * bucket. Plain JSON-serializable data so it can be stored and rebuilt "as of" a date.
 */
export type ProfitSample = {
  /** Composite score at the buy signal. */
  score: number;
  /** Gross return of the round trip: exit fill / entry fill - 1 (before commission and tax). */
  grossReturn: number;
  openedOn: string;
  closedOn: string;
};

export type BucketStat = {
  index: number;
  lower: number;
  upper: number;
  count: number;
  sumReturn: number;
  meanReturn: number;
};

export type BucketStats = {
  width: number;
  /** Keyed by bucket index (floor(score / width)). */
  buckets: Record<string, BucketStat>;
};

export const defaultBucketWidth = 0.1;
export const defaultMinSamples = 20;

/** floor(score / width) with a tiny epsilon so 0.3 / 0.1 lands in bucket 3, not 2. Score 1 joins the top bucket. */
export function bucketIndex(score: number, width = defaultBucketWidth): number {
  const top = Math.round(1 / width) - 1;
  return Math.min(Math.floor(score / width + 1e-9), top);
}

export function createBucketStats(width = defaultBucketWidth): BucketStats {
  if (!(width > 0 && width <= 1)) throw new Error('expectedProfit: width must be within (0, 1]');
  return { width, buckets: {} };
}

/** Add one sample in place. */
export function addSample(stats: BucketStats, score: number, grossReturn: number): void {
  const index = bucketIndex(score, stats.width);
  const key = String(index);
  const b =
    stats.buckets[key] ??
    (stats.buckets[key] = {
      index,
      lower: index * stats.width,
      upper: (index + 1) * stats.width,
      count: 0,
      sumReturn: 0,
      meanReturn: 0,
    });
  b.count += 1;
  b.sumReturn += grossReturn;
  b.meanReturn = b.sumReturn / b.count;
}

/**
 * Rebuild the statistics from stored samples. With `asOf`, only samples whose round trip closed
 * strictly before that date count (walk-forward: nothing that was unknown on `asOf`).
 */
export function buildBucketStats(
  samples: ProfitSample[],
  options: { width?: number; asOf?: string } = {},
): BucketStats {
  const stats = createBucketStats(options.width);
  for (const s of samples) {
    if (options.asOf !== undefined && !(s.closedOn < options.asOf)) continue;
    addSample(stats, s.score, s.grossReturn);
  }
  return stats;
}

/**
 * Mean gross return of the bucket containing `score`, or null when the bucket has fewer than
 * `minSamples` samples. Callers must not order on null ("기록 부족으로 주문 보류").
 */
export function expectedProfit(
  stats: BucketStats,
  score: number,
  minSamples = defaultMinSamples,
): number | null {
  const b = stats.buckets[String(bucketIndex(score, stats.width))];
  if (!b || b.count < minSamples) return null;
  return b.meanReturn;
}
