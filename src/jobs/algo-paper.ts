import { pathToFileURL } from 'node:url';
import { Firestore } from '@google-cloud/firestore';
import {
  buildBucketStats,
  clampScore,
  computeSignalScores,
  costWarnings,
  createPaperLedger,
  defaultMinSamples,
  defaultSafeguards,
  heldTradingDays,
  requiredBars,
  resolveCosts,
  runBacktest,
  runPaperDay,
  supplyScore,
  type CostSettings,
  type DailyBar,
  type ExternalDecision,
  type PaperLedger,
  type PaperQuote,
  type ProfitSample,
  type SignalId,
  type SignalWeight,
  type ValueSnapshot,
} from '../lib/algo/index.js';
import {
  defaultSimulationBudget,
  toDefinition,
  type AlgorithmRecord,
} from '../lib/algorithmRecords.js';
import {
  ALGO_AI_PENDING_CODE,
  ALGO_AI_PENDING_REASON,
  algorithmAiEnabled,
  algorithmDeciderFromEnvironment,
  type AiSignalSummary,
  type AlgorithmDecider,
} from '../server/algorithm-ai.js';
import {
  FirestoreAlgorithmRepository,
  toBars,
  type AlgorithmRepository,
  type CandleRow,
} from '../server/algorithms.js';
import {
  FirestoreNotificationRepository,
  NotificationService,
  notifierFromEnvironment,
  validAppOrigin,
  type NotificationEvent,
} from '../server/notify.js';
import {
  FirestorePaperRepository,
  runId as makeRunId,
  toTrade,
  type AlgorithmRun,
  type AlgorithmRunResult,
  type PaperRepository,
} from '../server/paper.js';
import {
  FirestoreTokenCache,
  ProviderError,
  TossClient,
  type MarketCalendar,
  type MarketCode,
  type TossConfig,
} from '../server/toss.js';
import { DEFAULT_OPEN_WINDOW_MINUTES, selectSessionToTrade } from './algo-session.js';
import { FirestoreSupplySource, type SupplySource } from './algo-paper-sources.js';
import {
  calendarQueryDate,
  loadMarketCalendar,
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

/**
 * Paper (virtual) algorithm run, one invocation per scheduler slot (stage 7c).
 *
 * Every algorithm in "paper" mode for the market is decided on live data and recorded as virtual
 * fills. This module has no order code: it reads quotes and candles, writes Firestore records and
 * sends notifications. A static test (tests/algo-paper-job.test.ts) keeps order endpoints and the
 * trading module out of every `src/jobs/algo-paper*.ts` file.
 */
export const JOB_NAME = 'algo-paper';

/** The subset of the Toss client the job uses, so tests can inject a fake. */
export type PaperToss = CalendarSource & Pick<TossClient, 'dailyCandles' | 'prices'>;

export type PaperJobOptions = {
  market: MarketCode;
  trigger: 'scheduler' | 'manual';
  /** Run only this long after the regular open. */
  openWindowMinutes: number;
  /** Adverse price move on every virtual fill, in basis points. */
  slippageBps: number;
  /** A "running" record older than this is treated as a crashed run. */
  staleRunMs: number;
  /** Minimum delay between provider calls. */
  paceMs: number;
  /** Daily bars to load per symbol (history for the signals and the simulated expected-profit stats). */
  historyBars: number;
  /** A quote older than this is not used. */
  maxQuoteAgeMs: number;
  /** Design 4.2: at most this many orders per day over all algorithms (per market run here). */
  maxOrdersPerDayTotal: number;
  /** Longest Retry-After the job sleeps through once. */
  maxRateLimitWaitSeconds: number;
  /** Minimum samples in a score bucket before its mean return counts as an expected profit. */
  minSamples: number;
};
export const DEFAULT_OPTIONS: PaperJobOptions = {
  market: 'KR',
  trigger: 'scheduler',
  openWindowMinutes: DEFAULT_OPEN_WINDOW_MINUTES,
  slippageBps: 10,
  staleRunMs: 30 * 60 * 1000,
  paceMs: 250,
  historyBars: 500,
  maxQuoteAgeMs: 60_000,
  maxOrdersPerDayTotal: 10,
  maxRateLimitWaitSeconds: 65,
  minSamples: defaultMinSamples,
};

export type PaperJobDependencies = {
  toss: PaperToss;
  paper: PaperRepository;
  algorithms: Pick<AlgorithmRepository, 'list' | 'getControl' | 'getCosts'>;
  /** Stored investor flows; without it the supply signal is excluded. */
  supply?: SupplySource;
  /**
   * Point-in-time value snapshots per symbol. There is no adapter yet, so by default the value
   * signal is disabled and the run says so.
   */
  values?: (market: MarketCode, symbol: string) => Promise<ValueSnapshot[] | null>;
  notify?: (event: NotificationEvent) => Promise<unknown>;
  /** AI-method algorithms run only when `enabled` and a decider exist. */
  ai?: { enabled: boolean; decider?: AlgorithmDecider };
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log: JobLogger;
  options?: Partial<PaperJobOptions>;
};
type Deps = Required<Pick<PaperJobDependencies, 'now' | 'sleep'>> & PaperJobDependencies;

// Failures that will not fix themselves within this run.
export const FATAL_CODES = new Set([
  'PROVIDER_ACCESS_DENIED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_TOKEN_BUSY',
  'PROVIDER_TOKEN_COOLDOWN',
]);
const maxNotes = 12;

const emptyResult = (status: AlgorithmRunResult['status'], code: string | null, reason: string) =>
  ({
    status,
    code,
    reason,
    fills: 0,
    stoppedNow: false,
    decisions: { buy: 0, sell: 0, hold: 0 },
    rejections: {},
    heldBack: { insufficientHistory: 0, expectedBelowCost: 0 },
    excludedSignals: [],
    notes: [],
  }) satisfies AlgorithmRunResult;

export const skipped = (code: string, reason: string) => emptyResult('skipped', code, reason);
export const failed = (code: string, reason: string) => emptyResult('failed', code, reason);

export type DataStore = { bars: Map<string, { need: number; rows: CandleRow[] }> };

/** One provider call with a single bounded wait on a rate limit. Fatal errors propagate. */
export async function providerCall<T>(
  deps: Pick<Deps, 'sleep'>,
  options: Pick<PaperJobOptions, 'paceMs' | 'maxRateLimitWaitSeconds'>,
  fn: () => Promise<T>,
) {
  if (options.paceMs > 0) await deps.sleep(options.paceMs);
  try {
    return await fn();
  } catch (error) {
    const wait = error instanceof ProviderError ? (error.retryAfter ?? 0) : 0;
    if (
      error instanceof ProviderError &&
      error.code === 'PROVIDER_RATE_LIMITED' &&
      wait > 0 &&
      wait <= options.maxRateLimitWaitSeconds
    ) {
      await deps.sleep(wait * 1000);
      return fn();
    }
    throw error;
  }
}

export class AlgorithmFailure extends Error {
  constructor(
    public code: string,
    public reason: string,
  ) {
    super(code);
  }
}

async function loadBars(
  deps: DecisionDeps,
  options: DecisionOptions,
  store: DataStore,
  record: AlgorithmRecord,
  symbol: string,
  need: number,
  session: Session,
  notes: string[],
): Promise<DailyBar[] | null> {
  let cached = store.bars.get(symbol);
  if (!cached || cached.need < need) {
    try {
      const paged = await providerCall(deps, options, () =>
        deps.toss.dailyCandles(symbol, {
          pageSize: 200,
          maxPages: Math.ceil(need / 200) + 1,
          maxCandles: need,
        }),
      );
      cached = { need, rows: paged.candles as unknown as CandleRow[] };
      store.bars.set(symbol, cached);
    } catch (error) {
      const code = safeErrorCode(error);
      if (FATAL_CODES.has(code))
        throw new AlgorithmFailure(code, '토스 API를 사용할 수 없어 판단하지 못했습니다.');
      notes.push(`${symbol}: 일봉을 불러오지 못해 오늘은 판단하지 않았다(${code}).`);
      return null;
    }
  }
  try {
    const dropped: string[] = [];
    const bars = toBars(symbol, cached.rows, record.currency, record.market, deps.now(), dropped);
    return bars.filter((b) => b.date < session.date);
  } catch {
    notes.push(`${symbol}: 일봉 통화나 값이 맞지 않아 오늘은 판단하지 않았다.`);
    return null;
  }
}

/** Closed signal-level round trips of the same algorithm on history before the paper start. */
export function simulatedSamples(
  record: AlgorithmRecord,
  barsBy: Record<string, DailyBar[]>,
  used: SignalWeight[],
  startedOn: string,
  budget: number,
  notes: string[],
): ProfitSample[] {
  try {
    const before: Record<string, DailyBar[]> = {};
    for (const symbol of record.targets) {
      const bars = (barsBy[symbol] ?? []).filter((b) => b.date < startedOn);
      if (bars.length === 0) return [];
      before[symbol] = bars;
    }
    const definition = toDefinition(
      { ...record, signals: record.template === 'dualMomentum' ? record.signals : used },
      record.params,
      budget,
    );
    const result = runBacktest({
      algorithm: definition,
      bars: before,
      // The shadow samples do not depend on orders, so the cheaper research mode is enough here.
      options: { expectedProfit: { mode: 'ignore' } },
    });
    return result.samples.filter((s) => s.closedOn < startedOn);
  } catch {
    notes.push('과거 시뮬레이션 기록을 계산하지 못해 모의 기록만으로 예상 이익을 계산했다.');
    return [];
  }
}

/** What one decision day needs, prepared identically for the paper run and the live run. */
export type DecisionInputs = {
  used: SignalWeight[];
  excluded: string[];
  isDual: boolean;
  definition: ReturnType<typeof toDefinition>;
  barsBy: Record<string, DailyBar[]>;
  quotes: PaperQuote[];
  externalDecisions: Record<string, ExternalDecision> | undefined;
  universe: string[];
};
export type PrepareOutcome = { result: AlgorithmRunResult } | { inputs: DecisionInputs };
export type DecisionDeps = Pick<Deps, 'toss' | 'now' | 'sleep' | 'supply' | 'values' | 'ai'>;
export type DecisionOptions = Pick<
  PaperJobOptions,
  'paceMs' | 'maxRateLimitWaitSeconds' | 'historyBars' | 'maxQuoteAgeMs'
>;

/**
 * Signals available today, daily bars, supply scores, decision-time quotes and (AI method) the
 * model's decisions for one algorithm. Shared by the paper job and the live job so both decide on
 * the same inputs. `held` are the symbols (with their entry date) the algorithm owns besides its
 * targets. Data problems throw AlgorithmFailure; "nothing to do" returns a skipped result.
 */
export async function prepareDecisionInputs(
  deps: DecisionDeps,
  options: DecisionOptions,
  record: AlgorithmRecord,
  context: {
    session: Session;
    calendar: MarketCalendar;
    costs: CostSettings;
    store: DataStore;
  },
  held: Record<string, { entryDate: string }>,
  budget: number,
  notes: string[],
): Promise<PrepareOutcome> {
  const { session } = context;
  const date = session.date;
  const aiMethod = record.method === 'ai';
  const isDual = record.template === 'dualMomentum';
  const excluded: string[] = [];

  // Which signals can be used today.
  let used: SignalWeight[] = [];
  if (!isDual) {
    for (const s of record.signals.filter((x) => x.weight > 0)) {
      if (s.id === 'value' && !deps.values) excluded.push('가치: 재무 데이터 연결 전이라 제외');
      else if (s.id === 'news') excluded.push('뉴스: 점수 규칙이 아직 없어 제외');
      else if (s.id === 'supply' && (record.market !== 'KR' || !deps.supply))
        excluded.push(
          record.market === 'KR'
            ? '수급: 저장된 수급 데이터를 읽을 수 없어 제외'
            : '수급: 미국 종목은 수급 데이터가 없어 제외',
        );
      else used.push({ id: s.id, weight: s.weight });
    }
    if (used.length === 0)
      return {
        result: {
          ...skipped('NO_USABLE_SIGNAL', '오늘 쓸 수 있는 신호가 없습니다.'),
          excludedSignals: excluded,
        },
      };
  }

  const heldSymbols = Object.keys(held);
  const universe = [...new Set([...record.targets, ...heldSymbols])].sort();
  const definition = toDefinition(record, record.params, budget);
  const required = requiredBars(definition);
  const need = Math.max(options.historyBars, required + 30);

  // Daily bars (paged, through yesterday) for the targets and anything still held.
  const barsBy: Record<string, DailyBar[]> = {};
  const loadNotes: string[] = [];
  for (const symbol of universe) {
    const bars = await loadBars(
      deps,
      options,
      context.store,
      record,
      symbol,
      need,
      session,
      loadNotes,
    );
    if (bars) barsBy[symbol] = bars;
  }
  notes.push(...loadNotes);

  // Candle freshness: the last completed bar must be the previous trading day (or later).
  const previous = context.calendar.previousBusinessDay.date;
  const staleCandles = new Set<string>();
  for (const [symbol, bars] of Object.entries(barsBy)) {
    const last = bars[bars.length - 1];
    if (!last || last.date < previous) {
      staleCandles.add(symbol);
      notes.push(`${symbol}: 직전 거래일 일봉이 없어 오늘은 판단하지 않았다.`);
    }
  }

  // Supply scores from stored snapshots (KR only), then the final signal list.
  const supplyScores: Record<string, number | null> = {};
  if (used.some((s) => s.id === 'supply') && deps.supply) {
    for (const symbol of record.targets) {
      const bars = barsBy[symbol];
      if (!bars || bars.length === 0) continue;
      try {
        const dates = bars.slice(-5).map((b) => b.date);
        supplyScores[symbol] = supplyScore(
          await deps.supply.load(record.market, symbol, dates),
          bars,
        );
      } catch {
        supplyScores[symbol] = null;
      }
    }
    const covered = Object.values(supplyScores).filter((v) => v !== null).length;
    if (covered === 0) {
      used = used.filter((s) => s.id !== 'supply');
      excluded.push('수급: 최근 영업일의 저장된 수급 스냅샷이 없어 제외');
      if (used.length === 0)
        return {
          result: {
            ...skipped('NO_USABLE_SIGNAL', '오늘 쓸 수 있는 신호가 없습니다.'),
            excludedSignals: excluded,
            notes,
          },
        };
    } else if (covered < Object.keys(supplyScores).length) {
      notes.push(
        `수급 신호는 ${covered}/${Object.keys(supplyScores).length}개 종목에서만 계산했다.`,
      );
    }
  }
  if (record.market === 'US' && defaultSafeguards('US').maxOrderValue === null)
    notes.push('미국 종목의 1억 원 환산 주문 상한은 환율이 없어 확인하지 않았다.');
  for (const warning of resolveCosts(record.market, context.costs).needsSetup)
    notes.push(costWarnings[warning]);

  // Value snapshots (adapter not wired yet: the dependency is optional).
  const valuesBy: Record<string, ValueSnapshot[] | undefined> = {};
  if (used.some((s) => s.id === 'value') && deps.values) {
    for (const symbol of record.targets)
      valuesBy[symbol] = (await deps.values(record.market, symbol).catch(() => null)) ?? undefined;
  }

  // Decision-time quotes, fetched right before deciding (freshness is measured against now).
  const priced = new Map<string, number>();
  const symbolsToPrice = universe.filter((s) => barsBy[s] && !staleCandles.has(s));
  if (symbolsToPrice.length > 0) {
    let response: Awaited<ReturnType<PaperToss['prices']>> | null = null;
    try {
      response = await providerCall(deps, options, () => deps.toss.prices(symbolsToPrice));
    } catch (error) {
      const code = safeErrorCode(error);
      if (FATAL_CODES.has(code))
        throw new AlgorithmFailure(code, '토스 API를 사용할 수 없어 판단하지 못했습니다.');
      notes.push(`현재가를 불러오지 못했다(${code}).`);
    }
    const at = deps.now().getTime();
    for (const quote of response?.prices ?? []) {
      const price = Number(quote.lastPrice);
      const age = quote.timestamp === null ? Infinity : at - Date.parse(quote.timestamp);
      if (quote.currency !== record.currency || !(price > 0) || !Number.isFinite(price)) {
        notes.push(`${quote.symbol}: 현재가 형식이 맞지 않아 오늘은 판단하지 않았다.`);
      } else if (!(age <= options.maxQuoteAgeMs && age >= -5000)) {
        notes.push(
          `${quote.symbol}: 현재가가 ${Math.round(options.maxQuoteAgeMs / 1000)}초보다 오래되어 오늘은 판단하지 않았다.`,
        );
      } else priced.set(quote.symbol, price);
    }
  }
  if (record.targets.length > 0 && !record.targets.some((s) => priced.has(s)))
    throw new AlgorithmFailure(
      'DATA_UNAVAILABLE',
      '신선한 일봉과 현재가가 있는 대상 종목이 없습니다.',
    );

  const quotes: PaperQuote[] = universe.map((symbol) => ({
    symbol,
    price: priced.get(symbol) ?? null,
    completed: barsBy[symbol] ?? [],
    values: valuesBy[symbol],
    external: supplyScores[symbol] === undefined ? undefined : { supply: supplyScores[symbol] },
  }));

  // AI method: one call per algorithm with a signal summary per symbol.
  let externalDecisions: Record<string, ExternalDecision> | undefined;
  if (aiMethod) {
    const summaries: AiSignalSummary[] = [];
    const ids = used.map((s) => s.id) as SignalId[];
    for (const q of quotes) {
      if (q.price === null || !record.targets.includes(q.symbol)) continue;
      const ledgerPosition = held[q.symbol];
      const signals = isDual
        ? {
            momentum: (() => {
              const lookback = definition.dualMomentum!.lookbackDays;
              const bars = q.completed;
              return bars.length < lookback
                ? null
                : clampScore(
                    (q.price / bars[bars.length - lookback].close - 1) /
                      definition.dualMomentum!.scale,
                  );
            })(),
          }
        : computeSignalScores(
            {
              bars: q.completed,
              price: q.price,
              decisionDate: date,
              values: q.values,
              external: q.external,
            },
            ids,
            record.params,
          );
      summaries.push({
        symbol: q.symbol,
        price: q.price,
        held: !!ledgerPosition,
        heldTradingDays: ledgerPosition
          ? heldTradingDays(q.completed, ledgerPosition.entryDate)
          : null,
        signals,
      });
    }
    if (summaries.length === 0)
      throw new AlgorithmFailure('DATA_UNAVAILABLE', '판단할 수 있는 대상 종목이 없습니다.');
    const answer = await deps.ai!.decider!.decide({
      market: record.market,
      date,
      currency: record.currency,
      symbols: summaries,
    });
    if (answer.status !== 'ready')
      throw new AlgorithmFailure(
        `AI_${answer.code}`,
        'AI 판단을 받지 못해 오늘은 판단하지 않았다.',
      );
    externalDecisions = Object.fromEntries(
      Object.values(answer.decisions).map((d) => [
        d.symbol,
        {
          action: d.decision,
          reasons: d.reasons,
          expectedReturn: (d.expectedReturn.low + d.expectedReturn.high) / 2,
        } satisfies ExternalDecision,
      ]),
    );
  }

  return {
    inputs: { used, excluded, isDual, definition, barsBy, quotes, externalDecisions, universe },
  };
}

async function runAlgorithm(
  deps: Deps,
  options: PaperJobOptions,
  record: AlgorithmRecord,
  context: {
    session: Session;
    calendar: MarketCalendar;
    runId: string;
    costs: CostSettings;
    store: DataStore;
    ordersLeft: () => number;
    countOrders: (n: number) => void;
  },
): Promise<AlgorithmRunResult> {
  const { session, runId } = context;
  const date = session.date;
  const nowIso = () => deps.now().toISOString();
  const aiMethod = record.method === 'ai';

  // Existing ledger decides idempotency and the stopped state.
  const existing = await deps.paper.getLedger(record.id);
  if (existing?.lastRunId === runId)
    return skipped('RUN_ALREADY_APPLIED', '이 실행은 이미 반영되어 다시 계산하지 않았습니다.');
  if (existing?.status === 'stopped')
    return skipped('PAPER_STOPPED', '누적 손실 한도에 닿아 정지된 모의 운용입니다.');
  if (aiMethod && !(deps.ai?.enabled && deps.ai.decider))
    return skipped(ALGO_AI_PENDING_CODE, ALGO_AI_PENDING_REASON);

  const notes: string[] = [];
  const budget = existing?.budget ?? record.budget ?? defaultSimulationBudget[record.currency];
  if (!existing && record.budget === null)
    notes.push(
      `운용 금액이 비어 있어 가상 시작 금액 ${defaultSimulationBudget[record.currency].toLocaleString('en-US')} ${record.currency}을 썼다.`,
    );

  const prepared = await prepareDecisionInputs(
    deps,
    options,
    record,
    context,
    Object.fromEntries(
      Object.values(existing?.positions ?? {}).map((p) => [p.symbol, { entryDate: p.entryDate }]),
    ),
    budget,
    notes,
  );
  if ('result' in prepared) return prepared.result;
  const { used, excluded, definition, barsBy, quotes, externalDecisions } = prepared.inputs;

  const ledger: PaperLedger =
    existing ??
    createPaperLedger({
      algorithmId: record.id,
      market: record.market,
      budget,
      startedOn: date,
      now: nowIso(),
    });
  // Expected profit: walk-forward statistics from simulated history before the paper start plus
  // paper round trips closed before today. The two periods never overlap.
  const simulated = aiMethod
    ? []
    : simulatedSamples(record, barsBy, used, ledger.startedOn, budget, notes);
  const stats = buildBucketStats([...simulated, ...ledger.samples], { asOf: date });

  const step = runPaperDay({
    ledger,
    algorithm: definition,
    usedSignals: used,
    externalDecisions,
    date,
    runId,
    now: nowIso(),
    quotes,
    costs: context.costs,
    safeguards: {
      maxOrdersPerDay: Math.min(
        defaultSafeguards(record.market).maxOrdersPerDay,
        context.ordersLeft(),
      ),
    },
    slippageBps: options.slippageBps,
    stats,
    minSamples: options.minSamples,
  });
  const trades = step.fills.map((fill) =>
    toTrade(fill, {
      ledger: step.ledger,
      runId,
      date,
      createdAt: nowIso(),
      targetsChangedAt: record.targetsChangedAt,
    }),
  );
  await deps.paper.commitDay(step.ledger, trades);
  context.countOrders(step.fills.length);

  // Notifications after the durable write; they never block or undo anything.
  const notify = async (event: NotificationEvent) => {
    try {
      await deps.notify?.(event);
    } catch {
      /* delivery problems are recorded by the notification service itself */
    }
  };
  for (const fill of step.fills)
    await notify({
      kind: 'fill',
      mode: 'paper',
      symbol: fill.symbol,
      side: fill.side,
      status: 'filled',
      algorithmName: record.name,
    });
  if (step.newlyStopped)
    await notify({
      kind: 'algorithm-auto-stop',
      mode: 'paper',
      algorithmName: record.name,
      reason: 'loss-limit',
    });

  const count = (action: 'buy' | 'sell' | 'hold') =>
    step.decisions.filter((d) => d.action === action).length;
  return {
    status: 'applied',
    code: null,
    reason: step.newlyStopped ? '누적 손실 한도에 닿아 정지했습니다.' : null,
    fills: step.fills.length,
    stoppedNow: step.newlyStopped,
    decisions: { buy: count('buy'), sell: count('sell'), hold: count('hold') },
    rejections: Object.fromEntries(Object.entries(step.rejections).map(([k, v]) => [k, v ?? 0])),
    heldBack: step.heldBack,
    excludedSignals: excluded,
    notes: notes.slice(0, maxNotes),
  };
}

function summarize(results: Record<string, AlgorithmRunResult>): AlgorithmRun['status'] {
  const all = Object.values(results);
  const bad = all.filter((r) => r.status === 'failed').length;
  if (bad === 0) return 'complete';
  return bad === all.length ? 'failed' : 'partial';
}

/** One invocation: decide from the calendar whether the market just opened, then run every paper algorithm. */
export async function runAlgoPaper(deps: PaperJobDependencies): Promise<JobOutcome> {
  const options = { ...DEFAULT_OPTIONS, ...deps.options };
  const full: Deps = {
    ...deps,
    now: deps.now ?? (() => new Date()),
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
  const { log, paper } = deps;
  const market = options.market;
  const current = full.now();
  const failureNotice = async () => {
    try {
      await deps.notify?.({ kind: 'job-failure', jobName: JOB_NAME });
    } catch {
      /* the run record and logs already say it failed */
    }
  };

  let calendar: MarketCalendar;
  let session: Session;
  try {
    calendar = await loadMarketCalendar(deps.toss, market, current);
    const decision = selectSessionToTrade(calendar, current, options.openWindowMinutes);
    if (decision.action === 'skip') {
      log.info('market-skipped', { market, code: decision.code });
      if (decision.code === 'MARKET_CLOSED_TODAY') {
        const day = calendarQueryDate(market, current);
        await paper.putSkippedIfAbsent({
          id: makeRunId(market, day),
          market,
          date: day,
          status: 'skipped',
          trigger: options.trigger,
          attempts: 0,
          startedAt: current.toISOString(),
          finishedAt: current.toISOString(),
          sessionOpen: null,
          skipCode: decision.code,
          results: {},
        });
      }
      return 'ok';
    }
    session = decision.session;
  } catch (error) {
    log.error('market-calendar-failed', { market, code: safeErrorCode(error) });
    await failureNotice();
    return 'failed';
  }

  const id = makeRunId(market, session.date);
  const run: AlgorithmRun = {
    id,
    market,
    date: session.date,
    status: 'running',
    trigger: options.trigger,
    attempts: 0,
    startedAt: current.toISOString(),
    finishedAt: null,
    sessionOpen: session.open.toISOString(),
    skipCode: null,
    results: {},
  };
  let begin;
  try {
    begin = await paper.beginRun(run, {
      nowMs: current.getTime(),
      staleAfterMs: options.staleRunMs,
    });
  } catch (error) {
    log.error('run-record-failed', { market, date: session.date, code: safeErrorCode(error) });
    await failureNotice();
    return 'failed';
  }
  if (begin.state !== 'started') {
    log.info('market-skipped', {
      market,
      date: session.date,
      code: begin.state === 'complete' ? 'RUN_ALREADY_COMPLETE' : 'RUN_IN_PROGRESS',
    });
    return 'ok';
  }
  run.attempts = begin.attempts;
  run.results = { ...begin.previous };
  log.info('run-started', { market, date: session.date, trigger: options.trigger });

  try {
    const records = (await deps.algorithms.list()).filter(
      (a) => a.market === market && a.mode === 'paper',
    );
    const costSettings = await deps.algorithms.getCosts();
    const costs: CostSettings = {
      ...(costSettings.commissionRate !== null
        ? { commissionRate: costSettings.commissionRate }
        : {}),
      ...(market === 'KR' && costSettings.sellTaxRate !== null
        ? { sellTaxRate: costSettings.sellTaxRate }
        : {}),
      ...(market === 'US' && costSettings.capitalGainsTax
        ? { capitalGainsTax: costSettings.capitalGainsTax }
        : {}),
    };
    const store: DataStore = { bars: new Map() };
    let orders = 0;
    for (const record of records) {
      let result: AlgorithmRunResult;
      try {
        // The global emergency stop is read before every algorithm, not once per run.
        let stopped: boolean;
        try {
          stopped = (await deps.algorithms.getControl()).emergencyStop;
        } catch {
          result = skipped('CONTROL_UNAVAILABLE', '긴급 정지 상태를 확인하지 못해 건너뛰었습니다.');
          run.results[record.id] = result;
          continue;
        }
        if (stopped) {
          result = skipped('EMERGENCY_STOP', '긴급 정지 중이라 아무것도 하지 않았습니다.');
        } else {
          result = await runAlgorithm(full, options, record, {
            session,
            calendar,
            runId: id,
            costs,
            store,
            ordersLeft: () => Math.max(0, options.maxOrdersPerDayTotal - orders),
            countOrders: (n) => {
              orders += n;
            },
          });
        }
      } catch (error) {
        result =
          error instanceof AlgorithmFailure
            ? failed(error.code, error.reason)
            : failed(safeErrorCode(error), '판단 중 오류가 발생했습니다.');
      }
      // A re-run keeps what an earlier attempt of the same run already applied.
      if (result.code === 'RUN_ALREADY_APPLIED' && run.results[record.id]?.status === 'applied')
        continue;
      run.results[record.id] = result;
      log.info('algorithm-finished', {
        market,
        date: session.date,
        status: result.status,
        ...(result.code && /^[A-Z][A-Z0-9_]{2,63}$/.test(result.code) ? { code: result.code } : {}),
        count: result.fills,
      });
    }
    run.status = summarize(run.results);
  } catch (error) {
    // Only reached for bugs or repository failures outside the per-algorithm guard.
    log.error('run-crashed', { market, date: session.date, code: safeErrorCode(error) });
    run.status = 'failed';
  }
  run.finishedAt = full.now().toISOString();
  try {
    await paper.finishRun(run);
  } catch (error) {
    log.error('run-record-failed', { market, date: session.date, code: safeErrorCode(error) });
    run.status = 'failed';
  }
  log.info('run-finished', {
    market,
    date: session.date,
    status: run.status,
    count: Object.keys(run.results).length,
  });
  if (run.status === 'failed' || run.status === 'partial') await failureNotice();
  return run.status === 'complete' || run.status === 'skipped'
    ? 'ok'
    : run.status === 'partial'
      ? 'partial'
      : 'failed';
}

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export type PaperJobConfiguration = {
  project: string;
  toss: TossConfig;
  options: Partial<PaperJobOptions>;
};
/**
 * Only runs as a Cloud Run Job in an explicit project. ALGO_MARKET (KR or US) is required: the
 * scheduler's two jobs (investing-algo-paper-kr / -us) set it per execution. Optional:
 * ALGO_PAPER_SLIPPAGE_BPS (0-500) and ALGO_OPEN_WINDOW_MINUTES (1-120).
 */
export function jobConfiguration(env: NodeJS.ProcessEnv): PaperJobConfiguration {
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
    !TOSS_OWNER_USER_ID ||
    (env.ALGO_MARKET !== 'KR' && env.ALGO_MARKET !== 'US')
  )
    throw new JobConfigError();
  const options: Partial<PaperJobOptions> = { market: env.ALGO_MARKET };
  if (env.ALGO_PAPER_SLIPPAGE_BPS !== undefined && env.ALGO_PAPER_SLIPPAGE_BPS !== '') {
    const bps = Number(env.ALGO_PAPER_SLIPPAGE_BPS);
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(env.ALGO_PAPER_SLIPPAGE_BPS) || bps > 500)
      throw new JobConfigError();
    options.slippageBps = bps;
  }
  if (env.ALGO_OPEN_WINDOW_MINUTES !== undefined && env.ALGO_OPEN_WINDOW_MINUTES !== '') {
    const minutes = Number(env.ALGO_OPEN_WINDOW_MINUTES);
    if (!/^\d{1,3}$/.test(env.ALGO_OPEN_WINDOW_MINUTES) || minutes < 1 || minutes > 120)
      throw new JobConfigError();
    options.openWindowMinutes = minutes;
    options.trigger = 'manual';
  }
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
      const origin = env.APP_ORIGIN ?? '';
      const notifications = validAppOrigin(origin)
        ? new NotificationService({
            repository: new FirestoreNotificationRepository(db),
            notifier: notifierFromEnvironment(env),
            appOrigin: origin,
          })
        : undefined;
      return await runAlgoPaper({
        toss,
        paper: new FirestorePaperRepository(db),
        algorithms: new FirestoreAlgorithmRepository(db),
        supply: new FirestoreSupplySource(db),
        notify: notifications ? (event) => notifications.notify(event) : undefined,
        // AI cost approval is pending: off unless ALGO_AI_ENABLED is exactly "true".
        ai: { enabled: algorithmAiEnabled(env), decider: algorithmDeciderFromEnvironment(env, db) },
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
