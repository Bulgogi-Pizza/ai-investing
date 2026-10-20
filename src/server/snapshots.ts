import { Router } from 'express';
import { FieldPath, Firestore } from '@google-cloud/firestore';
import { ownerGate } from './owner.js';

/**
 * Daily snapshot storage (stage 4). Server-only Firestore collections, no TTL: history is the point.
 *
 *   marketSnapshots/{market}_{date}_{SYMBOL}     one document per market/trade date/symbol (stocks)
 *   marketSnapshots/INDICATOR_{date}_{SYMBOL}    one document per KR market indicator and trade date
 *   snapshotRuns/{market}_{date}                 one run record per market/session date
 *   snapshotTargets/{ownerUserId}                owner-maintained extra symbols to snapshot
 *
 * Every section carries `observedAt` (when the job received it) and `baseDate` (the source's own
 * date); sections are replaced wholesale on re-run, never merged field by field.
 */
export type SnapshotMarket = 'KR' | 'US';
export const SNAPSHOT_MARKETS: readonly SnapshotMarket[] = ['KR', 'US'];
export type SectionName =
  'candle' | 'investorTrading' | 'programTrades' | 'shortSelling' | 'creditTrades';
export type SnapshotSection = {
  /** The source's own date for this value (trade date). */
  baseDate: string;
  /** When the job received it (UTC ISO). */
  observedAt: string;
  /** Provider's last update time when it reports one. */
  sourceUpdatedAt: string | null;
  value: Record<string, unknown>;
};
export type SnapshotDocument = {
  id: string;
  kind: 'stock' | 'indicator';
  market: SnapshotMarket;
  date: string;
  symbol: string;
  /** Last write time; each section keeps its own observedAt. */
  observedAt: string;
  sections: Partial<Record<SectionName, SnapshotSection>>;
};
export type StepStatus = 'OK' | 'FORBIDDEN' | 'FAILED' | 'STALE' | 'SKIPPED' | 'EMPTY';
export type StepResult = {
  status: StepStatus;
  ok: number;
  failed: number;
  forbidden: number;
  stale: number;
  empty: number;
  skipped: number;
  /** Sanitized failure codes only, with counts. */
  codes: Record<string, number>;
};
export type RunStatus = 'running' | 'complete' | 'partial' | 'failed' | 'skipped';
export type SnapshotRun = {
  id: string;
  market: SnapshotMarket;
  /** Market-local session date for market runs; the local date of "now" for skipped records. */
  date: string;
  status: RunStatus;
  trigger: 'scheduler' | 'manual';
  attempts: number;
  startedAt: string;
  finishedAt: string | null;
  sessionClose: string | null;
  skipCode: string | null;
  targets: { holdings: number; list: number; total: number } | null;
  counts: { symbols: number; documentsWritten: number };
  steps: Record<string, StepResult>;
};
export type SnapshotTarget = { market: SnapshotMarket; symbol: string };
export type SnapshotTargetList = { targets: SnapshotTarget[]; updatedAt: string };
export type BeginRunResult = {
  state: 'started' | 'complete' | 'running';
  /** Attempt number of the started run (1 for the first try of a market/date). */
  attempts: number;
};
export interface SnapshotRepository {
  /** Idempotent: same document ids replace only the sections present in each write. */
  upsert(documents: SnapshotDocument[]): Promise<void>;
  getRun(id: string): Promise<SnapshotRun | null>;
  /**
   * Starts (or restarts) a run unless it already completed or is being run. A "running" record
   * older than staleAfterMs is a crashed run and may be taken over.
   */
  beginRun(
    run: SnapshotRun,
    options: { nowMs: number; staleAfterMs: number; force: boolean },
  ): Promise<BeginRunResult>;
  finishRun(run: SnapshotRun): Promise<void>;
  putSkippedIfAbsent(run: SnapshotRun): Promise<void>;
  listRuns(market: SnapshotMarket, limit: number): Promise<SnapshotRun[]>;
  getTargets(ownerUserId: string): Promise<SnapshotTargetList | null>;
  putTargets(ownerUserId: string, list: SnapshotTargetList): Promise<void>;
}
export const SECTION_NAMES: readonly SectionName[] = [
  'candle',
  'investorTrading',
  'programTrades',
  'shortSelling',
  'creditTrades',
];
export const snapshotDocumentId = (
  kind: 'stock' | 'indicator',
  market: SnapshotMarket,
  date: string,
  symbol: string,
) => `${kind === 'indicator' ? 'INDICATOR' : market}_${date}_${symbol.toUpperCase()}`;
export const runId = (market: SnapshotMarket, date: string) => `${market}_${date}`;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export class MemorySnapshotRepository implements SnapshotRepository {
  readonly documents = new Map<string, SnapshotDocument>();
  readonly runs = new Map<string, SnapshotRun>();
  readonly targets = new Map<string, SnapshotTargetList>();
  async upsert(documents: SnapshotDocument[]) {
    for (const document of documents) {
      const existing = this.documents.get(document.id);
      this.documents.set(
        document.id,
        plain({
          ...document,
          sections: { ...existing?.sections, ...document.sections },
        }),
      );
    }
  }
  async getRun(id: string) {
    return plain(this.runs.get(id) ?? null);
  }
  async beginRun(
    run: SnapshotRun,
    options: { nowMs: number; staleAfterMs: number; force: boolean },
  ): Promise<BeginRunResult> {
    const existing = this.runs.get(run.id);
    const state = decideBegin(existing ?? null, options);
    const attempts = (existing?.attempts ?? 0) + (state === 'started' ? 1 : 0);
    if (state === 'started') this.runs.set(run.id, plain({ ...run, attempts }));
    return { state, attempts };
  }
  async finishRun(run: SnapshotRun) {
    this.runs.set(run.id, plain(run));
  }
  async putSkippedIfAbsent(run: SnapshotRun) {
    if (!this.runs.has(run.id)) this.runs.set(run.id, plain(run));
  }
  async listRuns(market: SnapshotMarket, limit: number) {
    return plain(
      [...this.runs.values()]
        .filter((run) => run.market === market)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, limit),
    );
  }
  async getTargets(ownerUserId: string) {
    return plain(this.targets.get(ownerUserId) ?? null);
  }
  async putTargets(ownerUserId: string, list: SnapshotTargetList) {
    this.targets.set(ownerUserId, plain(list));
  }
}
function decideBegin(
  existing: SnapshotRun | null,
  options: { nowMs: number; staleAfterMs: number; force: boolean },
): BeginRunResult['state'] {
  if (!existing) return 'started';
  if (existing.status === 'complete' && !options.force) return 'complete';
  if (
    existing.status === 'running' &&
    options.nowMs - Date.parse(existing.startedAt) < options.staleAfterMs
  )
    return 'running';
  return 'started';
}
export class FirestoreSnapshotRepository implements SnapshotRepository {
  constructor(private db = new Firestore()) {}
  async upsert(documents: SnapshotDocument[]) {
    // Firestore batches hold at most 500 writes.
    for (let start = 0; start < documents.length; start += 400) {
      const batch = this.db.batch();
      for (const document of documents.slice(start, start + 400)) {
        const sections = plain(document.sections);
        batch.set(
          this.db.collection('marketSnapshots').doc(document.id),
          {
            kind: document.kind,
            market: document.market,
            date: document.date,
            symbol: document.symbol,
            observedAt: document.observedAt,
            ...sections,
          },
          // Only the sections present are replaced; sections from earlier runs stay.
          {
            mergeFields: [
              'kind',
              'market',
              'date',
              'symbol',
              'observedAt',
              ...Object.keys(sections),
            ],
          },
        );
      }
      await batch.commit();
    }
  }
  async getRun(id: string) {
    const doc = await this.db.collection('snapshotRuns').doc(id).get();
    return doc.exists ? (doc.data() as SnapshotRun) : null;
  }
  async beginRun(
    run: SnapshotRun,
    options: { nowMs: number; staleAfterMs: number; force: boolean },
  ): Promise<BeginRunResult> {
    const ref = this.db.collection('snapshotRuns').doc(run.id);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const existing = snapshot.exists ? (snapshot.data() as SnapshotRun) : null;
      const state = decideBegin(existing, options);
      const attempts = (existing?.attempts ?? 0) + (state === 'started' ? 1 : 0);
      if (state === 'started') tx.set(ref, plain({ ...run, attempts }));
      return { state, attempts };
    });
  }
  async finishRun(run: SnapshotRun) {
    await this.db.collection('snapshotRuns').doc(run.id).set(plain(run));
  }
  async putSkippedIfAbsent(run: SnapshotRun) {
    // create() fails when the document exists, which keeps a completed run record intact.
    try {
      await this.db.collection('snapshotRuns').doc(run.id).create(plain(run));
    } catch {
      /* already recorded */
    }
  }
  async listRuns(market: SnapshotMarket, limit: number) {
    // Document ids start with "{market}_{date}", so an id range needs no composite index.
    const result = await this.db
      .collection('snapshotRuns')
      .where(FieldPath.documentId(), '>=', `${market}_`)
      .where(FieldPath.documentId(), '<', `${market}\``)
      .orderBy(FieldPath.documentId(), 'desc')
      .limit(limit)
      .get();
    return result.docs.map((doc) => doc.data() as SnapshotRun);
  }
  async getTargets(ownerUserId: string) {
    const doc = await this.db.collection('snapshotTargets').doc(ownerUserId).get();
    return doc.exists ? (doc.data() as SnapshotTargetList) : null;
  }
  async putTargets(ownerUserId: string, list: SnapshotTargetList) {
    await this.db.collection('snapshotTargets').doc(ownerUserId).set(plain(list));
  }
}
export const MAX_SNAPSHOT_TARGETS = 100;
const KR_SYMBOL = /^[A-Za-z0-9]{6}$/;
const US_SYMBOL = /^[A-Za-z0-9.\-]{1,30}$/;
export function validTargetSymbol(market: unknown, symbol: unknown): boolean {
  return (
    typeof symbol === 'string' &&
    ((market === 'KR' && KR_SYMBOL.test(symbol)) || (market === 'US' && US_SYMBOL.test(symbol)))
  );
}
/** Returns normalized, de-duplicated targets or null for any malformed input. */
export function parseTargets(value: unknown): SnapshotTarget[] | null {
  if (!Array.isArray(value) || value.length > MAX_SNAPSHOT_TARGETS) return null;
  const seen = new Set<string>();
  const result: SnapshotTarget[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const { market, symbol, ...rest } = item as Record<string, unknown>;
    if (Object.keys(rest).length || !validTargetSymbol(market, symbol)) return null;
    const key = `${market}:${(symbol as string).toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ market: market as SnapshotMarket, symbol: symbol as string });
  }
  return result;
}
const publicStep = (step: StepResult) => ({
  status: step.status,
  ok: step.ok,
  failed: step.failed,
  forbidden: step.forbidden,
  stale: step.stale,
  empty: step.empty,
  skipped: step.skipped,
  codes: step.codes,
});
/** Projection for the owner API: only counts, status codes and times; never provider payloads. */
export function publicRun(run: SnapshotRun) {
  return {
    id: run.id,
    market: run.market,
    date: run.date,
    status: run.status,
    trigger: run.trigger,
    attempts: run.attempts,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    sessionClose: run.sessionClose,
    skipCode: run.skipCode,
    targets: run.targets,
    counts: run.counts,
    steps: Object.fromEntries(Object.entries(run.steps).map(([k, v]) => [k, publicStep(v)])),
  };
}
const RECENT_RUNS = 5;
export function createSnapshotRouter({
  repository,
  ownerUserId,
  now = () => new Date(),
}: {
  repository: SnapshotRepository;
  ownerUserId?: string;
  now?: () => Date;
}) {
  const router = Router();
  const paths = ['/api/snapshots/status', '/api/snapshots/targets'];
  router.use(paths, (_req, res, next) => {
    if (!res.locals.user || res.locals.user.active === false) {
      res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: '로그인이 필요합니다.' } });
      return;
    }
    next();
  });
  // Owner-only; re-checked here so the router stays safe even if mounted elsewhere.
  router.use(paths, ownerGate(ownerUserId));
  router.get('/api/snapshots/status', async (_req, res) => {
    const markets = Object.fromEntries(
      await Promise.all(
        SNAPSHOT_MARKETS.map(async (market) => {
          const runs = (await repository.listRuns(market, RECENT_RUNS)).map(publicRun);
          return [market, { lastRun: runs[0] ?? null, recentRuns: runs }] as const;
        }),
      ),
    );
    res.json({ asOf: now().toISOString(), markets });
  });
  router.get('/api/snapshots/targets', async (_req, res) => {
    const list = await repository.getTargets(res.locals.user.id);
    res.json({ targets: list?.targets ?? [], updatedAt: list?.updatedAt ?? null });
  });
  router.put('/api/snapshots/targets', async (req, res) => {
    const body = req.body ?? {};
    const targets =
      body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1
        ? parseTargets(body.targets)
        : null;
    if (!targets) {
      res.status(400).json({
        error: {
          code: 'INVALID_SNAPSHOT_TARGETS',
          message: `시장(KR/US)과 종목 코드 형식을 확인하세요. 최대 ${MAX_SNAPSHOT_TARGETS}개입니다.`,
        },
      });
      return;
    }
    const list = { targets, updatedAt: now().toISOString() };
    await repository.putTargets(res.locals.user.id, list);
    res.json(list);
  });
  return router;
}
