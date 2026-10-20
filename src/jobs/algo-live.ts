import { pathToFileURL } from 'node:url';
import { Firestore } from '@google-cloud/firestore';
import {
  addSample,
  buildBucketStats,
  buildLiveDecisions,
  createBucketStats,
  defaultMinSamples,
  type BucketStats,
  type CostSettings,
  type DailyBar,
} from '../lib/algo/index.js';
import type { AlgorithmRecord, SafeguardSettingsRecord } from '../lib/algorithmRecords.js';
import {
  ALGO_AI_PENDING_CODE,
  ALGO_AI_PENDING_REASON,
  algorithmAiEnabled,
  algorithmDeciderFromEnvironment,
  type AlgorithmDecider,
} from '../server/algorithm-ai.js';
import { FirestoreAlgorithmRepository, type AlgorithmRepository } from '../server/algorithms.js';
import {
  FirestoreNotificationRepository,
  NotificationService,
  notifierFromEnvironment,
  validAppOrigin,
  validTelegramConfig,
  type NotificationEvent,
} from '../server/notify.js';
import {
  FirestorePaperRepository,
  type AlgorithmRun,
  type AlgorithmRunResult,
  type PaperRepository,
} from '../server/paper.js';
import { FirestoreTradingStore } from '../server/trading/firestore-store.js';
import {
  LiveOrderExecutor,
  type Decision,
  type ExecutorClient,
  type RunDataProvider,
  type RunReport,
} from '../server/trading/executor.js';
import { FALLBACK_COMMISSION_RATE, liveCumulativePnl } from '../server/trading/ledger-pnl.js';
import type { PreTradeMarketFacts, PreTradeSettings } from '../server/trading/pre-trade.js';
import { summarizeLedger, type TradingStore } from '../server/trading/stores.js';
import {
  TossOrderClient,
  type Commission,
  type OrderTransport,
} from '../server/trading/toss-orders.js';
import { TossOrderTransport } from '../server/trading/toss-transport.js';
import {
  FirestoreTokenCache,
  TossClient,
  type MarketCalendar,
  type MarketCode,
  type TossConfig,
} from '../server/toss.js';
import {
  AlgorithmFailure,
  failed,
  prepareDecisionInputs,
  simulatedSamples,
  skipped,
  type DataStore,
  type PaperToss,
} from './algo-paper.js';
import {
  averageTradedValue,
  fetchFreshFx,
  fetchFreshQuote,
  type FreshFx,
} from './algo-live-data.js';
import { FirestoreSupplySource, type SupplySource } from './algo-paper-sources.js';
import { DEFAULT_OPEN_WINDOW_MINUTES, selectSessionToTrade } from './algo-session.js';
import { loadMarketCalendar, type Session } from './market-session.js';
import {
  JobConfigError,
  runJob,
  safeErrorCode,
  type JobLogger,
  type JobOutcome,
} from './runner.js';

/**
 * Live (real-money) algorithm run, one invocation per scheduler slot (stage 7f).
 *
 * Every algorithm in "live" mode for the market is decided on live data with the SAME engine as the
 * paper job (prepareDecisionInputs + decideSymbols), turned into order intents from the algorithm's
 * own live ledger, and handed to LiveOrderExecutor: pre-trade check -> atomic slot reservation ->
 * place -> record -> notify. Nothing here talks to the order endpoints directly.
 *
 * Fail-closed layers, outermost first:
 *  1. The job refuses to start unless LIVE_TRADING_ENABLED is exactly "true" (a deployment kill
 *     switch that is independent of the screen; only this job's deployment sets it).
 *  2. The Cloud Scheduler triggers are created paused (infra/gcp/jobs-live.tf).
 *  3. The emergency stop is read fresh before every algorithm (and again by the executor before
 *     every order and every retry); a stopped algorithm is skipped.
 *  4. Every order passes the single pre-trade check.
 */
export const JOB_NAME = 'algo-live';

/** Environment variable that must be exactly "true" for this job to do anything. */
export const LIVE_KILL_SWITCH_ENV = 'LIVE_TRADING_ENABLED';

export const liveRunId = (market: MarketCode, date: string) => `live_${market}_${date}`;

export type LiveToss = PaperToss;
export type LiveJobOptions = {
  market: MarketCode;
  trigger: 'scheduler' | 'manual';
  openWindowMinutes: number;
  staleRunMs: number;
  paceMs: number;
  historyBars: number;
  maxQuoteAgeMs: number;
  maxRateLimitWaitSeconds: number;
  minSamples: number;
};
export const DEFAULT_LIVE_OPTIONS: LiveJobOptions = {
  market: 'KR',
  trigger: 'scheduler',
  openWindowMinutes: DEFAULT_OPEN_WINDOW_MINUTES,
  staleRunMs: 30 * 60 * 1000,
  paceMs: 250,
  historyBars: 500,
  maxQuoteAgeMs: 60_000,
  maxRateLimitWaitSeconds: 65,
  minSamples: defaultMinSamples,
};

export type LiveJobDependencies = {
  /** Calendar, daily candles and decision-time prices (read only). */
  toss: LiveToss;
  /** Fresh quotes and the exchange rate (GET only); the order client is built on the same port. */
  transport: Pick<OrderTransport, 'send'>;
  /** Order client: reads for the pre-trade check, `placeOrder` for the executor. */
  client: ExecutorClient;
  store: TradingStore;
  paper: Pick<PaperRepository, 'beginRun' | 'finishRun' | 'getLedger'>;
  algorithms: Pick<AlgorithmRepository, 'list' | 'getControl' | 'getCosts' | 'getSafeguards'>;
  supply?: SupplySource;
  notify?: (event: NotificationEvent) => Promise<unknown>;
  /** AI-method algorithms run only when `enabled` and a decider exist. */
  ai?: { enabled: boolean; decider?: AlgorithmDecider };
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log: JobLogger;
  options?: Partial<LiveJobOptions>;
};

const maxNotes = 12;
const emptyHeldBack = { insufficientHistory: 0, expectedBelowCost: 0 };

/** The deployment kill switch. Exact string match: "True", "1" or " true" do not enable anything. */
export const liveTradingEnabled = (env: NodeJS.ProcessEnv) => env[LIVE_KILL_SWITCH_ENV] === 'true';

type Clock = { now: () => Date; sleep: (ms: number) => Promise<void> };

/** Bucket statistics that make the pre-trade rule see exactly the AI model's own expected return. */
function aiBucketStats(expectedReturn: number | null, minSamples: number): BucketStats | null {
  if (expectedReturn === null || !Number.isFinite(expectedReturn)) return null;
  const stats = createBucketStats();
  for (let i = 0; i < minSamples; i++) addSample(stats, AI_SCORE, expectedReturn);
  return stats;
}
const AI_SCORE = 0.5;

function pretradeSettings(
  market: MarketCode,
  safeguards: SafeguardSettingsRecord,
  costs: { sellTaxRate: number | null },
  minSamples: number,
): PreTradeSettings {
  const currency = market === 'KR' ? 'KRW' : 'USD';
  return {
    safeguards: {
      maxOrdersPerDay: safeguards.maxOrdersPerDay,
      minHoldingTradingDays: safeguards.minHoldingTradingDays,
      lossStopFraction: safeguards.lossStopFraction,
      liquidityMinAvgValue: safeguards.liquidityMinAvgValue[currency],
    },
    maxGlobalOrdersPerDay: safeguards.maxGlobalOrdersPerDay,
    // KR needs the transaction tax (missing = no buys); US capital-gains tax is not a per-trade cost.
    ...(market === 'KR' && costs.sellTaxRate !== null ? { sellTaxRate: costs.sellTaxRate } : {}),
    minSamples,
  };
}

/** Highest active broker commission rate for the market, or null when it cannot be determined. */
function commissionRateFor(commissions: Commission[], market: MarketCode, today: string) {
  const rates = commissions
    .filter(
      (c) =>
        c.marketCountry === market &&
        (c.startDate === null || c.startDate <= today) &&
        (c.endDate === null || c.endDate >= today),
    )
    .map((c) => Number(c.commissionRate))
    .filter((r) => Number.isFinite(r) && r >= 0 && r < 1);
  return rates.length ? Math.max(...rates) : null;
}

function summarizeReport(
  report: RunReport,
  decisions: { buy: number; sell: number; hold: number },
  notes: string[],
  excluded: string[],
): AlgorithmRunResult {
  const rejections: Record<string, number> = {};
  const heldBack = { ...emptyHeldBack };
  const bump = (code: string) => {
    rejections[code] = (rejections[code] ?? 0) + 1;
  };
  let accepted = 0;
  let unknown = 0;
  for (const o of report.outcomes) {
    if (o.status === 'accepted') accepted++;
    else if (o.status === 'unknown') {
      unknown++;
      bump('ORDER_UNCONFIRMED');
    } else if (o.status === 'rejected') bump('BROKER_REJECTED');
    else
      for (const code of o.reasons ?? []) {
        bump(code);
        if (code === 'HISTORY_INSUFFICIENT') heldBack.insufficientHistory++;
        if (code === 'EXPECTED_PROFIT_BELOW_COST') heldBack.expectedBelowCost++;
      }
  }
  const text = [...notes];
  if (unknown > 0)
    text.push(
      `주문 ${unknown}건은 접수 여부를 확인하지 못했습니다. 토스증권 앱에서 주문 내역을 확인하세요.`,
    );
  if (report.algorithmStopped)
    text.push(
      report.stopReason === 'loss-limit'
        ? '누적 손실 한도에 닿아 알고리즘을 정지했습니다.'
        : '주문 거부로 알고리즘을 정지했습니다.',
    );
  return {
    status: report.leaseHeld ? 'skipped' : 'applied',
    code: report.leaseHeld ? 'RUN_IN_PROGRESS' : null,
    reason: report.leaseHeld
      ? '같은 알고리즘의 다른 실행이 진행 중입니다.'
      : report.algorithmStopped
        ? '알고리즘이 정지되었습니다.'
        : null,
    fills: accepted,
    stoppedNow: report.algorithmStopped,
    decisions,
    rejections,
    heldBack,
    excludedSignals: excluded,
    notes: text.slice(0, maxNotes),
  };
}

type RunContext = {
  session: Session;
  calendar: MarketCalendar;
  runId: string;
  costs: CostSettings;
  rawSellTaxRate: number | null;
  safeguards: SafeguardSettingsRecord;
  commissionRate: number | null;
  dataStore: DataStore;
};

async function runLiveAlgorithm(
  deps: LiveJobDependencies & Clock,
  options: LiveJobOptions,
  record: AlgorithmRecord,
  context: RunContext,
): Promise<AlgorithmRunResult> {
  const { session, calendar } = context;
  const date = session.date;
  const aiMethod = record.method === 'ai';

  // Gates that make the algorithm do nothing today. Each is read fresh for THIS algorithm.
  try {
    if ((await deps.algorithms.getControl()).emergencyStop)
      return skipped('EMERGENCY_STOP', '긴급 정지 중이라 아무것도 하지 않았습니다.');
  } catch {
    return skipped('CONTROL_UNAVAILABLE', '긴급 정지 상태를 확인하지 못해 건너뛰었습니다.');
  }
  try {
    if (await deps.store.isAlgorithmStopped(record.id))
      return skipped(
        'ALGORITHM_STOPPED',
        '정지된 알고리즘입니다. 화면에서 정지를 해제하기 전에는 주문하지 않습니다.',
      );
  } catch {
    return skipped('STORE_UNAVAILABLE', '정지 상태를 확인하지 못해 건너뛰었습니다.');
  }
  if (record.budget === null || !(record.budget > 0))
    return skipped('BUDGET_NOT_SET', '운용 금액 한도가 없어 주문하지 않습니다.');
  const budget = record.budget;
  if (
    record.template !== 'dualMomentum' &&
    record.signals.some((s) => s.id === 'value' && s.weight > 0)
  )
    return skipped(
      'FINANCIALS_MISSING',
      '가치 신호는 재무 데이터 연결 전이라 실전에서 쓸 수 없어 주문하지 않습니다.',
    );
  if (aiMethod && !(deps.ai?.enabled && deps.ai.decider))
    return skipped(ALGO_AI_PENDING_CODE, ALGO_AI_PENDING_REASON);

  const notes: string[] = [];
  if (context.rawSellTaxRate === null && record.market === 'KR')
    notes.push('증권거래세율 설정이 없어 국내 매수는 하지 않습니다(설정 필요).');
  if (context.commissionRate === null)
    notes.push('증권사 수수료율을 확인하지 못해 매수는 하지 않습니다.');

  // The algorithm's own live ledger (after reconciliation): what it owns and has committed.
  const ledger = summarizeLedger(await deps.store.listOrders({ algorithmId: record.id }));
  const held: Record<string, { entryDate: string }> = {};
  const owned: Record<string, number> = {};
  for (const p of ledger.positions.values()) {
    if (p.quantity > 0 || p.pendingSellQuantity > 0)
      held[p.symbol] = { entryDate: p.lastBuyDate ?? date };
    const available = Math.max(0, Math.floor(p.quantity - p.pendingSellQuantity));
    if (available > 0) owned[p.symbol] = available;
  }

  const prepared = await prepareDecisionInputs(
    deps,
    options,
    record,
    { session, calendar, costs: context.costs, store: context.dataStore },
    held,
    budget,
    notes,
  );
  if ('result' in prepared) return prepared.result;
  const { used, excluded, definition, barsBy, quotes, externalDecisions } = prepared.inputs;
  // The paper-only reminder about a missing FX rate does not apply: live orders are checked with it.
  for (let i = notes.length - 1; i >= 0; i--)
    if (notes[i].startsWith('미국 종목의 1억 원 환산')) notes.splice(i, 1);

  const built = buildLiveDecisions({
    algorithm: definition,
    usedSignals: used,
    externalDecisions,
    date,
    quotes,
    owned,
    budget,
    committed: ledger.committed,
    commissionRate: context.commissionRate,
  });
  const counts = { buy: 0, sell: 0, hold: 0 };
  for (const d of built.decisions) counts[d.action]++;
  for (const d of built.decisions)
    if (d.blockedBy === 'insufficient-budget')
      notes.push(`${d.symbol}: 운용 금액 한도가 남지 않아 매수하지 않았다.`);

  // Expected-profit statistics: simulated history before the paper start plus paper round trips
  // closed before today (the same walk-forward rule as the paper job). No record = no buy.
  const paperLedger = await deps.paper.getLedger(record.id).catch(() => null);
  const simulated = aiMethod
    ? []
    : simulatedSamples(record, barsBy, used, paperLedger?.startedOn ?? date, budget, notes);
  const stats = buildBucketStats([...simulated, ...(paperLedger?.samples ?? [])], { asOf: date });

  // Marks for the cumulative-loss check: today's decision quote, else the last completed close.
  const marks: Record<string, number | undefined> = {};
  for (const q of quotes) marks[q.symbol] = q.price ?? q.completed[q.completed.length - 1]?.close;
  const scoreOf = new Map(built.decisions.map((d) => [d.symbol, d.score]));
  const pnlCosts = {
    commissionRate: context.commissionRate ?? FALLBACK_COMMISSION_RATE,
    sellTaxRate: record.market === 'KR' ? (context.rawSellTaxRate ?? 0) : 0,
  };

  const currency = record.currency;
  let fxCache: { at: number; value: FreshFx | null } | null = null;
  const tradingDates = [
    ...new Set(Object.values(barsBy).flatMap((bars: DailyBar[]) => bars.map((b) => b.date))),
  ].sort();
  const data: RunDataProvider = {
    async marketFacts(symbol): Promise<PreTradeMarketFacts> {
      const quote = await fetchFreshQuote(deps.transport, symbol, currency);
      const bars = barsBy[symbol] ?? [];
      let fx: FreshFx | null = null;
      if (record.market === 'US') {
        const t = deps.now().getTime();
        if (!fxCache || t - fxCache.at > 60_000)
          fxCache = { at: t, value: await fetchFreshFx(deps.transport, deps.now()) };
        fx = fxCache.value;
      }
      return {
        quote,
        latestDailyBarDate: bars.length ? bars[bars.length - 1].date : null,
        expectedDailyBarDate: calendar.previousBusinessDay.date,
        avgTradedValue: averageTradedValue(bars),
        // Value-signal algorithms never reach this point (see the gates above).
        financialsPresent: false,
        fxMidRate: fx?.midRate ?? null,
        fxObservedAt: fx?.observedAt ?? null,
      };
    },
    async cumulativePnl() {
      return liveCumulativePnl(
        await deps.store.listOrders({ algorithmId: record.id }),
        marks,
        pnlCosts,
      );
    },
    async expectedProfit(symbol) {
      if (aiMethod) {
        const bucket = aiBucketStats(
          externalDecisions?.[symbol]?.expectedReturn ?? null,
          options.minSamples,
        );
        return bucket ? { stats: bucket, score: AI_SCORE } : null;
      }
      return { stats, score: scoreOf.get(symbol) ?? null };
    },
  };

  // Order intents: the quote price is the limit price (never more aggressive than the market).
  const decisions: Decision[] = built.orders.map((o) => ({
    symbol: o.symbol,
    side: o.side,
    quantity: o.quantity,
    price: o.price,
  }));
  const executor = new LiveOrderExecutor({
    client: deps.client,
    store: deps.store,
    notifier: {
      async notify(event) {
        await deps.notify?.(event);
      },
    },
    now: deps.now,
    // Trading days elapsed since `fromDate` for this algorithm's market: completed sessions after
    // it, plus today (the same count the paper run and the simulation use for the minimum holding).
    tradingDaysSince: (_market, fromDate) =>
      tradingDates.length === 0 ? null : 1 + tradingDates.filter((d) => d > fromDate).length,
    settings: pretradeSettings(
      record.market,
      context.safeguards,
      { sellTaxRate: context.rawSellTaxRate },
      options.minSamples,
    ),
    algorithmName: () => record.name,
  });
  const report = await executor.executeRun({
    runId: context.runId,
    algorithm: {
      id: record.id,
      name: record.name,
      market: record.market,
      budget,
      // Value-signal algorithms are refused above, so the financials rule can never be needed here.
      usesValueSignal: false,
    },
    decisions,
    data,
  });
  return summarizeReport(report, counts, notes, excluded);
}

function summarize(results: Record<string, AlgorithmRunResult>): AlgorithmRun['status'] {
  const all = Object.values(results);
  const bad = all.filter((r) => r.status === 'failed').length;
  if (bad === 0) return 'complete';
  return bad === all.length ? 'failed' : 'partial';
}

/** One invocation: decide from the calendar whether the market just opened, then run every live algorithm. */
export async function runAlgoLive(deps: LiveJobDependencies): Promise<JobOutcome> {
  const options = { ...DEFAULT_LIVE_OPTIONS, ...deps.options };
  const full = {
    ...deps,
    now: deps.now ?? (() => new Date()),
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
  const { log, store } = deps;
  const market = options.market;
  const current = full.now();
  const failureNotice = async () => {
    try {
      await deps.notify?.({ kind: 'job-failure', jobName: JOB_NAME });
    } catch {
      /* the run record and logs already say it failed */
    }
  };
  /** The screen tells "schedule paused" from "job ran" by this record; it never carries amounts. */
  const heartbeat = async (
    outcome: 'ok' | 'partial' | 'failed' | 'skipped',
    date: string | null,
    code?: string,
  ) => {
    try {
      await store.putJobHeartbeat({
        market,
        at: full.now().toISOString(),
        date,
        outcome,
        ...(code && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? { code } : {}),
      });
    } catch {
      log.warn('heartbeat-failed', { market });
    }
  };

  let calendar: MarketCalendar;
  let session: Session;
  try {
    calendar = await loadMarketCalendar(deps.toss, market, current);
    const decision = selectSessionToTrade(calendar, current, options.openWindowMinutes);
    if (decision.action === 'skip') {
      log.info('market-skipped', { market, code: decision.code });
      await heartbeat('skipped', null, decision.code);
      return 'ok';
    }
    session = decision.session;
  } catch (error) {
    log.error('market-calendar-failed', { market, code: safeErrorCode(error) });
    await heartbeat('failed', null, 'CALENDAR_FAILED');
    await failureNotice();
    return 'failed';
  }

  const id = liveRunId(market, session.date);
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
    begin = await deps.paper.beginRun(run, {
      nowMs: current.getTime(),
      staleAfterMs: options.staleRunMs,
    });
  } catch (error) {
    log.error('run-record-failed', { market, date: session.date, code: safeErrorCode(error) });
    await heartbeat('failed', session.date, 'RUN_RECORD_FAILED');
    await failureNotice();
    return 'failed';
  }
  if (begin.state !== 'started') {
    const code = begin.state === 'complete' ? 'RUN_ALREADY_COMPLETE' : 'RUN_IN_PROGRESS';
    log.info('market-skipped', { market, date: session.date, code });
    await heartbeat('skipped', session.date, code);
    return 'ok';
  }
  run.attempts = begin.attempts;
  run.results = { ...begin.previous };
  log.info('run-started', { market, date: session.date, trigger: options.trigger });

  try {
    // Reconcile every non-terminal live order first: fills change what each algorithm owns, and the
    // executor reconciles again per algorithm. Failures leave orders non-terminal, which blocks
    // new orders for that symbol (fail closed).
    const all = await deps.algorithms.list();
    const names = new Map(all.map((a) => [a.id, a.name]));
    const reconciler = new LiveOrderExecutor({
      client: deps.client,
      store,
      notifier: { notify: async (event) => void (await deps.notify?.(event)) },
      now: full.now,
      tradingDaysSince: () => null,
      algorithmName: (id) => names.get(id) ?? '(삭제된 알고리즘)',
    });
    try {
      const { updated } = await reconciler.reconcile();
      log.info('reconciled', { market, count: updated });
    } catch {
      log.warn('reconcile-failed', { market });
    }

    const records = all.filter((a) => a.market === market && a.mode === 'live');
    if (records.length === 0) log.info('no-live-algorithms', { market });
    let safeguards: SafeguardSettingsRecord | null = null;
    let settingsFailed = false;
    let rawCosts: Awaited<ReturnType<LiveJobDependencies['algorithms']['getCosts']>> | null = null;
    if (records.length > 0) {
      try {
        safeguards = await deps.algorithms.getSafeguards();
        rawCosts = await deps.algorithms.getCosts();
      } catch {
        settingsFailed = true;
      }
    }
    let commissionRate: number | null = null;
    if (records.length > 0 && !settingsFailed) {
      try {
        commissionRate = commissionRateFor(
          await deps.client.getCommissions(),
          market,
          full.now().toISOString().slice(0, 10),
        );
      } catch {
        commissionRate = null;
      }
    }
    const dataStore: DataStore = { bars: new Map() };
    for (const record of records) {
      let result: AlgorithmRunResult;
      try {
        if (run.results[record.id]?.status === 'applied') continue; // an earlier attempt finished it
        if (settingsFailed || !safeguards || !rawCosts) {
          result = failed(
            'SETTINGS_UNAVAILABLE',
            '안전장치·비용 설정을 읽지 못해 주문하지 않았습니다.',
          );
        } else {
          // The commission rate is the broker's own schedule, not the manual setting.
          const costs: CostSettings = {
            ...(commissionRate !== null ? { commissionRate } : {}),
            ...(market === 'KR' && rawCosts.sellTaxRate !== null
              ? { sellTaxRate: rawCosts.sellTaxRate }
              : {}),
            ...(market === 'US' && rawCosts.capitalGainsTax
              ? { capitalGainsTax: rawCosts.capitalGainsTax }
              : {}),
          };
          result = await runLiveAlgorithm(full, options, record, {
            session,
            calendar,
            runId: id,
            costs,
            rawSellTaxRate: market === 'KR' ? rawCosts.sellTaxRate : null,
            safeguards,
            commissionRate,
            dataStore,
          });
        }
      } catch (error) {
        result =
          error instanceof AlgorithmFailure
            ? failed(error.code, error.reason)
            : failed(safeErrorCode(error), '판단 중 오류가 발생했습니다.');
      }
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
    await deps.paper.finishRun(run);
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
  const outcome: JobOutcome =
    run.status === 'complete' || run.status === 'skipped'
      ? 'ok'
      : run.status === 'partial'
        ? 'partial'
        : 'failed';
  await heartbeat(outcome, session.date);
  if (run.status === 'failed' || run.status === 'partial') await failureNotice();
  return outcome;
}

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export type LiveJobConfiguration = {
  project: string;
  toss: TossConfig;
  options: Partial<LiveJobOptions>;
};
/**
 * Only runs as a Cloud Run Job in an explicit project, only when LIVE_TRADING_ENABLED is exactly
 * "true", and only with Telegram alerts configured. ALGO_MARKET (KR or US) is required: the scheduler's two jobs set it per execution. There
 * is deliberately no way to widen the open window or change a safeguard from the environment.
 */
export function jobConfiguration(env: NodeJS.ProcessEnv): LiveJobConfiguration {
  const project = env.GOOGLE_CLOUD_PROJECT;
  const { TOSS_CLIENT_ID, TOSS_CLIENT_SECRET, TOSS_ACCOUNT_SEQ, TOSS_OWNER_USER_ID } = env;
  if (
    !liveTradingEnabled(env) ||
    env.NODE_ENV !== 'production' ||
    !env.CLOUD_RUN_JOB ||
    !project ||
    !PROJECT.test(project) ||
    !TOSS_CLIENT_ID ||
    !TOSS_CLIENT_SECRET ||
    !TOSS_ACCOUNT_SEQ ||
    !/^\d{1,15}$/.test(TOSS_ACCOUNT_SEQ) ||
    !TOSS_OWNER_USER_ID ||
    (env.ALGO_MARKET !== 'KR' && env.ALGO_MARKET !== 'US') ||
    // Real orders are never placed unobserved: working Telegram alerts and the app origin for their
    // links are required, not optional. (A delivery failure at run time still never blocks trading,
    // and is recorded; a missing configuration is caught here.)
    !validTelegramConfig(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID) ||
    !validAppOrigin(env.APP_ORIGIN)
  )
    throw new JobConfigError();
  return {
    project,
    toss: {
      clientId: TOSS_CLIENT_ID,
      clientSecret: TOSS_CLIENT_SECRET,
      accountSeq: TOSS_ACCOUNT_SEQ,
      ownerUserId: TOSS_OWNER_USER_ID,
    },
    options: { market: env.ALGO_MARKET },
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env) {
  return runJob(JOB_NAME, async ({ log }) => {
    const config = jobConfiguration(env);
    const db = new Firestore({ projectId: config.project });
    try {
      const toss = new TossClient(config.toss, new FirestoreTokenCache(config.toss.clientId, db));
      const transport = new TossOrderTransport(toss);
      const origin = env.APP_ORIGIN ?? '';
      const notifications = validAppOrigin(origin)
        ? new NotificationService({
            repository: new FirestoreNotificationRepository(db),
            notifier: notifierFromEnvironment(env),
            appOrigin: origin,
          })
        : undefined;
      return await runAlgoLive({
        toss,
        transport,
        client: new TossOrderClient(transport),
        store: new FirestoreTradingStore(db),
        paper: new FirestorePaperRepository(db),
        algorithms: new FirestoreAlgorithmRepository(db),
        supply: new FirestoreSupplySource(db),
        notify: notifications ? (event) => notifications.notify(event) : undefined,
        // AI cost approval is pending: off unless ALGO_AI_ENABLED is exactly "true" (the deployment keeps it false).
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
