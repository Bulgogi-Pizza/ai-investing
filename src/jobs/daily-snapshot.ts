import { pathToFileURL } from 'node:url';
import { Firestore } from '@google-cloud/firestore';
import { FirestoreCalendarRepository } from '../server/calendar.js';
import { syncOfficialNews } from '../server/news.js';
import {
  FirestoreSnapshotRepository,
  SECTION_NAMES,
  runId,
  snapshotDocumentId,
  type SectionName,
  type SnapshotDocument,
  type SnapshotRepository,
  type SnapshotRun,
  type SnapshotSection,
  type StepResult,
} from '../server/snapshots.js';
import {
  FirestoreTokenCache,
  MARKET_INDICATOR_CATALOG,
  PROVIDER_FORBIDDEN,
  ProviderError,
  TossClient,
  type DailyCandle,
  type MarketCode,
  type StockDailyCandle,
  type TossConfig,
} from '../server/toss.js';
import {
  calendarQueryDate,
  loadMarketCalendar,
  selectSessionToSnapshot,
  type CalendarSource,
  type Session,
} from './market-session.js';
import {
  JobConfigError,
  runJob,
  safeErrorCode,
  type JobLogger,
  type JobOutcome,
} from './runner.js';
import {
  HoldingsTargetProvider,
  ListTargetProvider,
  collectTargets,
  type SnapshotTargetProvider,
} from './snapshot-targets.js';

export const JOB_NAME = 'daily-snapshot';
/** The subset of the Toss client the job uses, so tests can inject a fake. */
export type SnapshotToss = CalendarSource &
  Pick<
    TossClient,
    | 'dailyCandlePage'
    | 'marketIndicatorCandlePage'
    | 'investorTrading'
    | 'programTrades'
    | 'shortSelling'
    | 'creditTrades'
  >;
export type SnapshotOptions = {
  markets: MarketCode[];
  trigger: 'scheduler' | 'manual';
  /** Re-run a market/date that already completed. */
  force: boolean;
  /** Only this market-local session date (manual backfill). */
  date?: string;
  /** Trailing rows requested per series, so a missed day or a late-finalized row heals itself. */
  window: number;
  /** Minimum delay between provider calls (rate limits are unknown; be conservative). */
  paceMs: number;
  /** A "running" record older than this is treated as a crashed run. */
  staleRunMs: number;
  /** Longest Retry-After (or token lease wait) the job sleeps through before giving up. */
  maxRateLimitWaitSeconds: number;
  /** Stop calling the provider after this many consecutive failures. */
  maxConsecutiveFailures: number;
};
export const DEFAULT_OPTIONS: SnapshotOptions = {
  markets: ['KR', 'US'],
  trigger: 'scheduler',
  force: false,
  window: 5,
  paceMs: 250,
  staleRunMs: 30 * 60 * 1000,
  maxRateLimitWaitSeconds: 65,
  maxConsecutiveFailures: 5,
};
export type SnapshotDependencies = {
  toss: SnapshotToss;
  repository: SnapshotRepository;
  targetProviders: SnapshotTargetProvider[];
  /** Official news sync; returns how many records were stored and how many sources failed. */
  syncNews?: () => Promise<{ count: number; failedSources: number }>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log: JobLogger;
  options?: Partial<SnapshotOptions>;
};
// A provider outage or a revoked key will not fix itself within one run: stop and say so.
const FATAL_CODES = new Set([
  'PROVIDER_ACCESS_DENIED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_TOKEN_BUSY',
  'PROVIDER_TOKEN_COOLDOWN',
]);
// Worth waiting for once or twice: a rate limit, or another instance holding the 60 s token lease.
const WAIT_AND_RETRY_CODES = new Set(['PROVIDER_RATE_LIMITED', 'PROVIDER_TOKEN_BUSY']);
// Per-symbol outcomes that say nothing about the provider's health.
const SYMBOL_LEVEL_CODES = new Set([PROVIDER_FORBIDDEN, 'PROVIDER_NOT_FOUND']);
const emptyStep = (): StepResult => ({
  status: 'OK',
  ok: 0,
  failed: 0,
  forbidden: 0,
  stale: 0,
  empty: 0,
  skipped: 0,
  codes: {},
});
type Tally = 'ok' | 'failed' | 'forbidden' | 'stale' | 'empty' | 'skipped';
function tally(steps: Record<string, StepResult>, step: string, kind: Tally, code?: string) {
  const result = (steps[step] ??= emptyStep());
  result[kind]++;
  if (code) result.codes[code] = (result.codes[code] ?? 0) + 1;
  result.status = stepStatus(result);
}
function stepStatus(step: StepResult): StepResult['status'] {
  if (step.failed) return 'FAILED';
  if (step.stale) return 'STALE';
  if (step.forbidden) return 'FORBIDDEN';
  if (step.skipped && !step.ok) return 'SKIPPED';
  if (!step.ok && step.empty) return 'EMPTY';
  return 'OK';
}
/** `skipped` means the call was not made because an earlier fatal error stopped the run. */
type CallResult<T> = { ok: true; value: T } | { ok: false; code: string; skipped: boolean };
/** Paces provider calls, honors short Retry-After waits and stops after fatal errors. */
class Remote {
  private abortCode: string | null = null;
  private consecutiveFailures = 0;
  private calls = 0;
  constructor(
    private options: SnapshotOptions,
    private sleep: (ms: number) => Promise<void>,
  ) {}
  async call<T>(fn: () => Promise<T>): Promise<CallResult<T>> {
    if (this.abortCode) return { ok: false, code: this.abortCode, skipped: true };
    if (this.calls++ > 0 && this.options.paceMs > 0) await this.sleep(this.options.paceMs);
    for (let attempt = 0; ; attempt++) {
      try {
        const value = await fn();
        this.consecutiveFailures = 0;
        return { ok: true, value };
      } catch (error) {
        const code = safeErrorCode(error);
        const wait = error instanceof ProviderError ? (error.retryAfter ?? 0) : 0;
        if (
          WAIT_AND_RETRY_CODES.has(code) &&
          attempt < 2 &&
          wait > 0 &&
          wait <= this.options.maxRateLimitWaitSeconds
        ) {
          await this.sleep(wait * 1000);
          continue;
        }
        if (SYMBOL_LEVEL_CODES.has(code)) {
          this.consecutiveFailures = 0;
        } else if (
          FATAL_CODES.has(code) ||
          ++this.consecutiveFailures >= this.options.maxConsecutiveFailures
        ) {
          this.abortCode = FATAL_CODES.has(code) ? code : 'REPEATED_PROVIDER_FAILURES';
        }
        return { ok: false, code, skipped: false };
      }
    }
  }
}
type Row = { date: string; sourceUpdatedAt: string | null; value: Record<string, unknown> };
const candleRows = (candles: (DailyCandle | StockDailyCandle)[], session: Session, extra: object) =>
  candles
    // Rows after the session date cannot belong to this run.
    .filter((c) => c.date <= session.date)
    .map<Row>((c) => ({
      date: c.date,
      sourceUpdatedAt: null,
      value: {
        timestamp: c.timestamp,
        ...extra,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        ...('currency' in c ? { currency: c.currency } : {}),
      },
    }));
type Dated = { date: string };
const seriesRows = <T extends Dated & { updatedAt?: string }>(records: T[], session: Session) =>
  records
    .filter((r) => r.date <= session.date)
    .map<Row>(({ date, updatedAt, ...value }) => ({
      date,
      sourceUpdatedAt: updatedAt ?? null,
      value: value as Record<string, unknown>,
    }));
/** Groups section rows by trade date into one document per date (idempotent ids). */
function buildDocuments(
  base: Pick<SnapshotDocument, 'kind' | 'market' | 'symbol'>,
  sections: Partial<Record<SectionName, Row[]>>,
  observedAt: string,
): SnapshotDocument[] {
  const byDate = new Map<string, SnapshotDocument>();
  for (const name of SECTION_NAMES) {
    for (const row of sections[name] ?? []) {
      let document = byDate.get(row.date);
      if (!document) {
        document = {
          id: snapshotDocumentId(base.kind, base.market, row.date, base.symbol),
          ...base,
          date: row.date,
          observedAt,
          sections: {},
        };
        byDate.set(row.date, document);
      }
      const section: SnapshotSection = {
        baseDate: row.date,
        observedAt,
        sourceUpdatedAt: row.sourceUpdatedAt,
        value: row.value,
      };
      document.sections[name] = section;
    }
  }
  return [...byDate.values()];
}
const latestDate = (rows: Row[]) =>
  rows.reduce((max, row) => (row.date > max ? row.date : max), '');
async function runMarket(
  market: MarketCode,
  session: Session,
  deps: Required<Pick<SnapshotDependencies, 'now' | 'sleep'>> & SnapshotDependencies,
  options: SnapshotOptions,
  run: SnapshotRun,
): Promise<void> {
  const { toss, repository, log } = deps;
  const remote = new Remote(options, deps.sleep);
  const steps = run.steps;
  const window = options.window;
  // 1. targets
  const collected = await collectTargets(deps.targetProviders, market);
  steps.targets = emptyStep();
  steps.targets.ok = collected.targets.length;
  for (const name of ['holdings', 'list', 'algorithm'] as const) {
    const code = collected.failures[name];
    if (code) tally(steps, 'targets', 'failed', code);
  }
  if (collected.invalid) tally(steps, 'targets', 'skipped', 'TARGET_SYMBOL_INVALID');
  if (collected.truncated) tally(steps, 'targets', 'skipped', 'TARGETS_TRUNCATED');
  steps.targets.status = stepStatus(steps.targets);
  run.targets = {
    holdings: collected.bySource.holdings,
    list: collected.bySource.list,
    total: collected.targets.length,
  };
  run.counts.symbols = collected.targets.length;
  // A key without permission fails every symbol the same way: after two denials in a row (and no
  // success in between) stop asking for that section and record "forbidden" for the rest.
  const denials = new Map<SectionName, number>();
  const store = async (documents: SnapshotDocument[]) => {
    if (!documents.length) return;
    try {
      await repository.upsert(documents);
      run.counts.documentsWritten += documents.length;
      tally(steps, 'store', 'ok');
    } catch {
      tally(steps, 'store', 'failed', 'STORE_FAILED');
    }
  };
  // 2. per-symbol sections; whatever succeeded for a symbol is stored even if another section failed
  for (const target of collected.targets) {
    const rows: Partial<Record<SectionName, Row[]>> = {};
    const fetchSection = async <T>(
      section: SectionName,
      stepName: string,
      fetch: () => Promise<T>,
      toRows: (value: T) => Row[],
    ) => {
      if ((denials.get(section) ?? 0) >= 2)
        return tally(steps, stepName, 'forbidden', PROVIDER_FORBIDDEN);
      const result = await remote.call(fetch);
      if (!result.ok) {
        if (result.code === PROVIDER_FORBIDDEN) {
          denials.set(section, (denials.get(section) ?? 0) + 1);
          return tally(steps, stepName, 'forbidden', PROVIDER_FORBIDDEN);
        }
        return result.skipped
          ? tally(steps, stepName, 'skipped', result.code)
          : tally(steps, stepName, 'failed', result.code);
      }
      denials.set(section, 0);
      const sectionRows = toRows(result.value);
      if (!sectionRows.length) return tally(steps, stepName, 'empty');
      rows[section] = sectionRows;
      // The session's own bar is the proof the end-of-day data has settled.
      if (section === 'candle' && latestDate(sectionRows) < session.date)
        return tally(steps, stepName, 'stale', 'CANDLE_NOT_YET_PUBLISHED');
      tally(steps, stepName, 'ok');
    };
    await fetchSection(
      'candle',
      'candles',
      () => toss.dailyCandlePage(target.symbol, { count: window }),
      (page) => candleRows(page.candles, session, { adjusted: true }),
    );
    if (market === 'KR') {
      const query = { count: window };
      await fetchSection(
        'investorTrading',
        'investorTrading',
        () => toss.investorTrading(target.symbol, query),
        (r) => seriesRows(r.records, session),
      );
      await fetchSection(
        'programTrades',
        'programTrades',
        () => toss.programTrades(target.symbol, query),
        (r) => seriesRows(r.records, session),
      );
      await fetchSection(
        'shortSelling',
        'shortSelling',
        () => toss.shortSelling(target.symbol, query),
        (r) => seriesRows(r.records, session),
      );
      await fetchSection(
        'creditTrades',
        'creditTrades',
        () => toss.creditTrades(target.symbol, query),
        (r) => seriesRows(r.records, session),
      );
    }
    await store(
      buildDocuments(
        { kind: 'stock', market, symbol: target.symbol },
        rows,
        deps.now().toISOString(),
      ),
    );
  }
  // 3. KR market indicators (KOSPI, KOSDAQ, KR government bonds)
  if (market === 'KR') {
    for (const indicator of MARKET_INDICATOR_CATALOG) {
      const result = await remote.call(() =>
        toss.marketIndicatorCandlePage(indicator.symbol, { count: window }),
      );
      if (!result.ok) {
        result.skipped
          ? tally(steps, 'indicators', 'skipped', result.code)
          : tally(steps, 'indicators', 'failed', result.code);
        continue;
      }
      const sectionRows = candleRows(result.value.candles, session, { unit: indicator.unit });
      if (!sectionRows.length) {
        tally(steps, 'indicators', 'empty');
        continue;
      }
      const latest = latestDate(sectionRows);
      // Korean government bond yields are published one business day later (observed 2026-10-21:
      // KOSPI had the session bar, every KR_BOND_* still ended a day earlier). The trailing window
      // stores that bar on the next run, so a lag of up to one business day (<= 4 calendar days to
      // cover weekends and a holiday) is the normal state for bonds, not a stale step.
      const bondLagOk = indicator.kind === 'BOND' && calendarDaysBetween(latest, session.date) <= 4;
      if (latest < session.date && !bondLagOk)
        tally(steps, 'indicators', 'stale', 'CANDLE_NOT_YET_PUBLISHED');
      else tally(steps, 'indicators', 'ok');
      await store(
        buildDocuments(
          { kind: 'indicator', market: 'KR', symbol: indicator.symbol },
          { candle: sectionRows },
          deps.now().toISOString(),
        ),
      );
    }
  }
  // 4. official news (fixed RSS sources) so news accumulates daily
  if (deps.syncNews) {
    try {
      const news = await deps.syncNews();
      if (news.failedSources) tally(steps, 'news', 'failed', 'NEWS_SOURCE_FAILED');
      else tally(steps, 'news', 'ok');
    } catch {
      tally(steps, 'news', 'failed', 'NEWS_SYNC_FAILED');
    }
  }
  for (const [step, result] of Object.entries(steps)) {
    log.info('step-finished', {
      market,
      date: session.date,
      step,
      status: result.status,
      ok: result.ok,
      failed: result.failed,
      forbidden: result.forbidden,
      stale: result.stale,
      empty: result.empty,
      skipped: result.skipped,
      codes: result.codes,
    });
  }
}
function finalStatus(run: SnapshotRun): 'complete' | 'partial' | 'failed' {
  const steps = Object.values(run.steps);
  // Forbidden and empty are known data conditions; failed, stale and skipped-by-abort are not.
  const incomplete = steps.some((step) => step.failed || step.stale || step.skipped);
  if (!incomplete) return 'complete';
  return run.counts.documentsWritten > 0 ? 'partial' : 'failed';
}
/** Whole calendar days from `from` to `to` (both YYYY-MM-DD). */
function calendarDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}
/** One job invocation: decide per market from the calendar, snapshot what closed, record the run. */
export async function runDailySnapshot(deps: SnapshotDependencies): Promise<JobOutcome> {
  const options = { ...DEFAULT_OPTIONS, ...deps.options };
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const full = { ...deps, now, sleep };
  const { log, repository } = deps;
  let worst: JobOutcome = 'ok';
  const escalate = (outcome: JobOutcome) => {
    if (outcome === 'failed' || (outcome === 'partial' && worst === 'ok')) worst = outcome;
  };
  for (const market of options.markets) {
    const current = now();
    let session: Session;
    try {
      const calendar = await loadMarketCalendar(deps.toss, market, current, options.date);
      const decision = selectSessionToSnapshot(calendar, current, undefined, options.date);
      if (decision.action === 'skip') {
        log.info('market-skipped', { market, code: decision.code });
        if (decision.code === 'MARKET_CLOSED_TODAY') {
          const date = calendarQueryDate(market, current);
          await repository.putSkippedIfAbsent(skippedRun(market, date, decision.code, current));
        }
        continue;
      }
      session = decision.session;
    } catch (error) {
      log.error('market-calendar-failed', { market, code: safeErrorCode(error) });
      escalate('failed');
      continue;
    }
    const id = runId(market, session.date);
    const run: SnapshotRun = {
      id,
      market,
      date: session.date,
      status: 'running',
      trigger: options.trigger,
      attempts: 0,
      startedAt: current.toISOString(),
      finishedAt: null,
      sessionClose: session.close.toISOString(),
      skipCode: null,
      targets: null,
      counts: { symbols: 0, documentsWritten: 0 },
      steps: {},
    };
    let begin;
    try {
      begin = await repository.beginRun(run, {
        nowMs: current.getTime(),
        staleAfterMs: options.staleRunMs,
        force: options.force,
      });
    } catch (error) {
      log.error('run-record-failed', { market, date: session.date, code: safeErrorCode(error) });
      escalate('failed');
      continue;
    }
    if (begin.state !== 'started') {
      log.info('market-skipped', {
        market,
        date: session.date,
        code: begin.state === 'complete' ? 'RUN_ALREADY_COMPLETE' : 'RUN_IN_PROGRESS',
      });
      continue;
    }
    run.attempts = begin.attempts;
    log.info('run-started', { market, date: session.date, trigger: options.trigger });
    try {
      await runMarket(market, session, full, options, run);
      run.status = finalStatus(run);
    } catch (error) {
      // Only reached for bugs or repository failures outside the guarded steps.
      log.error('run-crashed', { market, date: session.date, code: safeErrorCode(error) });
      run.status = run.counts.documentsWritten > 0 ? 'partial' : 'failed';
    }
    run.finishedAt = now().toISOString();
    try {
      await repository.finishRun(run);
    } catch (error) {
      log.error('run-record-failed', { market, date: session.date, code: safeErrorCode(error) });
      escalate('failed');
    }
    log.info('run-finished', {
      market,
      date: session.date,
      status: run.status,
      symbols: run.counts.symbols,
      written: run.counts.documentsWritten,
    });
    escalate(run.status === 'complete' ? 'ok' : run.status === 'partial' ? 'partial' : 'failed');
  }
  return worst;
}
function skippedRun(market: MarketCode, date: string, code: string, at: Date): SnapshotRun {
  return {
    id: runId(market, date),
    market,
    date,
    status: 'skipped',
    trigger: 'scheduler',
    attempts: 0,
    startedAt: at.toISOString(),
    finishedAt: at.toISOString(),
    sessionClose: null,
    skipCode: code,
    targets: null,
    counts: { symbols: 0, documentsWritten: 0 },
    steps: {},
  };
}
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export type JobConfiguration = {
  project: string;
  toss: TossConfig;
  options: Partial<SnapshotOptions>;
};
/**
 * Only runs as a Cloud Run Job in an explicit project. Manual runs set SNAPSHOT_MARKETS, SNAPSHOT_DATE
 * and/or SNAPSHOT_FORCE on a single execution (gcloud run jobs execute --update-env-vars).
 */
export function jobConfiguration(env: NodeJS.ProcessEnv): JobConfiguration {
  const project = env.GOOGLE_CLOUD_PROJECT;
  const { TOSS_CLIENT_ID, TOSS_CLIENT_SECRET, TOSS_ACCOUNT_SEQ, TOSS_OWNER_USER_ID } = env;
  if (
    env.NODE_ENV !== 'production' ||
    !env.CLOUD_RUN_JOB ||
    !project ||
    !PROJECT.test(project) ||
    !TOSS_CLIENT_ID ||
    !TOSS_CLIENT_SECRET ||
    !TOSS_ACCOUNT_SEQ ||
    !/^\d{1,15}$/.test(TOSS_ACCOUNT_SEQ) ||
    !TOSS_OWNER_USER_ID
  )
    throw new JobConfigError();
  const options: Partial<SnapshotOptions> = {};
  if (env.SNAPSHOT_MARKETS) {
    const markets = env.SNAPSHOT_MARKETS.split(',').map((m) => m.trim());
    if (
      !markets.length ||
      markets.some((m) => m !== 'KR' && m !== 'US') ||
      new Set(markets).size !== markets.length
    )
      throw new JobConfigError();
    options.markets = markets as MarketCode[];
  }
  if (env.SNAPSHOT_DATE) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(env.SNAPSHOT_DATE)) throw new JobConfigError();
    options.date = env.SNAPSHOT_DATE;
  }
  if (env.SNAPSHOT_FORCE) {
    if (env.SNAPSHOT_FORCE !== '1') throw new JobConfigError();
    options.force = true;
  }
  if (options.markets || options.date || options.force) options.trigger = 'manual';
  return {
    project,
    toss: {
      clientId: TOSS_CLIENT_ID,
      clientSecret: TOSS_CLIENT_SECRET,
      accountSeq: TOSS_ACCOUNT_SEQ,
      ownerUserId: TOSS_OWNER_USER_ID,
    },
    options,
  };
}
export async function main(env: NodeJS.ProcessEnv = process.env) {
  return runJob(JOB_NAME, async ({ log }) => {
    const config = jobConfiguration(env);
    const db = new Firestore({ projectId: config.project });
    try {
      const toss = new TossClient(config.toss, new FirestoreTokenCache(config.toss.clientId, db));
      const repository = new FirestoreSnapshotRepository(db);
      const calendar = new FirestoreCalendarRepository(db);
      return await runDailySnapshot({
        toss,
        repository,
        targetProviders: [
          new HoldingsTargetProvider(toss, config.toss.ownerUserId),
          new ListTargetProvider(repository, config.toss.ownerUserId),
        ],
        syncNews: async () => {
          const result = await syncOfficialNews(calendar, { authorId: 'daily-snapshot-job' });
          return {
            count: result.count,
            failedSources: result.sources.filter((source) => source.status === 'failed').length,
          };
        },
        log,
        options: config.options,
      });
    } finally {
      await db.terminate();
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
