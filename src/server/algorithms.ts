import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  runBacktest,
  requiredBars,
  defaultSignalParams,
  type BacktestResult,
  type CostSettings,
  type DailyBar,
  type Market,
} from '../lib/algo';
import {
  budgetRaised,
  currencyOf,
  defaultSimulationBudget,
  diffAlgorithm,
  findLiveOverlap,
  maxAlgorithms,
  parseAlgorithmInput,
  parseCostSettings,
  toDefinition,
  type AlgorithmEvent,
  type AlgorithmInput,
  type AlgorithmRecord,
  type Change,
  type CostSettingsRecord,
} from '../lib/algorithmRecords';
import type { NotificationEvent, NotifyOutcome } from './notify';
import { ownerGate } from './owner';

// ---------------------------------------------------------------------------
// Repository. Cross-document rules (limit, unique name, live overlap) run inside the same
// transaction as the write, so concurrent requests cannot slip past them.
// ---------------------------------------------------------------------------
export type Rejection = { status: number; code: string; message: string };
export type MutationPlan =
  | { reject: Rejection }
  | { write: AlgorithmRecord; event: AlgorithmEvent }
  | { remove: string; event: AlgorithmEvent };
export type MutationResult =
  { ok: true; record: AlgorithmRecord | null } | ({ ok: false } & Rejection);
export type ControlState = { emergencyStop: boolean; updatedAt: string | null };
export interface AlgorithmRepository {
  list(): Promise<AlgorithmRecord[]>;
  get(id: string): Promise<AlgorithmRecord | null>;
  /** `plan` sees every algorithm and the targeted one, and must be synchronous and side-effect free. */
  mutate(
    id: string,
    plan: (current: AlgorithmRecord | null, all: AlgorithmRecord[]) => MutationPlan,
  ): Promise<MutationResult>;
  /** Newest first. algorithmEvents is append-only and has no TTL: the change history is kept. */
  listEvents(limit: number): Promise<AlgorithmEvent[]>;
  getControl(): Promise<ControlState>;
  /** Sets the flag and appends `event` atomically; returns the previous value. */
  setControl(emergencyStop: boolean, now: string, event: AlgorithmEvent): Promise<boolean>;
  getCosts(): Promise<CostSettingsRecord>;
  putCosts(costs: CostSettingsRecord, event: AlgorithmEvent): Promise<void>;
}

const emptyCosts: CostSettingsRecord = {
  commissionRate: null,
  sellTaxRate: null,
  capitalGainsTax: null,
  updatedAt: null,
};
/** Firestore rejects `undefined`; drop it from plain data. */
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const byCreated = (a: AlgorithmRecord, b: AlgorithmRecord) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

export class MemoryAlgorithmRepository implements AlgorithmRepository {
  private algorithms = new Map<string, AlgorithmRecord>();
  private events: AlgorithmEvent[] = [];
  private control: ControlState = { emergencyStop: false, updatedAt: null };
  private costs: CostSettingsRecord = structuredClone(emptyCosts);
  async list() {
    return structuredClone([...this.algorithms.values()].sort(byCreated));
  }
  async get(id: string) {
    return structuredClone(this.algorithms.get(id) ?? null);
  }
  async mutate(
    id: string,
    plan: (current: AlgorithmRecord | null, all: AlgorithmRecord[]) => MutationPlan,
  ): Promise<MutationResult> {
    // No await between read and write: atomic within the single-threaded event loop.
    const all = structuredClone([...this.algorithms.values()].sort(byCreated));
    const result = plan(structuredClone(this.algorithms.get(id) ?? null), all);
    if ('reject' in result) return { ok: false, ...result.reject };
    this.events.push(structuredClone(result.event));
    if ('remove' in result) {
      this.algorithms.delete(result.remove);
      return { ok: true, record: null };
    }
    this.algorithms.set(result.write.id, structuredClone(result.write));
    return { ok: true, record: structuredClone(result.write) };
  }
  async listEvents(limit: number) {
    return structuredClone(this.events.slice(-limit).reverse());
  }
  async getControl() {
    return { ...this.control };
  }
  async setControl(emergencyStop: boolean, now: string, event: AlgorithmEvent) {
    const previous = this.control.emergencyStop;
    this.control = { emergencyStop, updatedAt: now };
    this.events.push(structuredClone(event));
    return previous;
  }
  async getCosts() {
    return structuredClone(this.costs);
  }
  async putCosts(costs: CostSettingsRecord, event: AlgorithmEvent) {
    this.costs = structuredClone(costs);
    this.events.push(structuredClone(event));
  }
}

export class FirestoreAlgorithmRepository implements AlgorithmRepository {
  constructor(private db = new Firestore()) {}
  private algorithms() {
    return this.db.collection('algorithms');
  }
  private events() {
    return this.db.collection('algorithmEvents');
  }
  private controlRef() {
    return this.db.collection('algorithmControl').doc('global');
  }
  private costsRef() {
    return this.db.collection('algorithmSettings').doc('costs');
  }
  async list() {
    const snapshot = await this.algorithms()
      .limit(maxAlgorithms * 2)
      .get();
    return snapshot.docs.map((doc) => doc.data() as AlgorithmRecord).sort(byCreated);
  }
  async get(id: string) {
    const doc = await this.algorithms().doc(id).get();
    return doc.exists ? (doc.data() as AlgorithmRecord) : null;
  }
  async mutate(
    id: string,
    plan: (current: AlgorithmRecord | null, all: AlgorithmRecord[]) => MutationPlan,
  ): Promise<MutationResult> {
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(this.algorithms().limit(maxAlgorithms * 2));
      const all = snapshot.docs.map((doc) => doc.data() as AlgorithmRecord).sort(byCreated);
      const current = all.find((a) => a.id === id) ?? null;
      const result = plan(current, all);
      if ('reject' in result) return { ok: false as const, ...result.reject };
      tx.create(this.events().doc(result.event.id), clean(result.event));
      if ('remove' in result) {
        tx.delete(this.algorithms().doc(result.remove));
        return { ok: true as const, record: null };
      }
      tx.set(this.algorithms().doc(result.write.id), clean(result.write));
      return { ok: true as const, record: result.write };
    });
  }
  async listEvents(limit: number) {
    const snapshot = await this.events().orderBy('at', 'desc').limit(limit).get();
    return snapshot.docs.map((doc) => doc.data() as AlgorithmEvent);
  }
  async getControl() {
    const data = (await this.controlRef().get()).data();
    return {
      emergencyStop: data?.emergencyStop === true,
      updatedAt: typeof data?.updatedAt === 'string' ? data.updatedAt : null,
    };
  }
  async setControl(emergencyStop: boolean, now: string, event: AlgorithmEvent) {
    return this.db.runTransaction(async (tx) => {
      const previous = (await tx.get(this.controlRef())).data()?.emergencyStop === true;
      tx.set(this.controlRef(), { emergencyStop, updatedAt: now });
      tx.create(this.events().doc(event.id), clean(event));
      return previous;
    });
  }
  async getCosts() {
    const data = (await this.costsRef().get()).data();
    if (!data) return structuredClone(emptyCosts);
    return {
      commissionRate: typeof data.commissionRate === 'number' ? data.commissionRate : null,
      sellTaxRate: typeof data.sellTaxRate === 'number' ? data.sellTaxRate : null,
      capitalGainsTax: data.capitalGainsTax ?? null,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
    } as CostSettingsRecord;
  }
  async putCosts(costs: CostSettingsRecord, event: AlgorithmEvent) {
    const batch = this.db.batch();
    batch.set(this.costsRef(), clean(costs));
    batch.create(this.events().doc(event.id), clean(event));
    await batch.commit();
  }
}

// ---------------------------------------------------------------------------
// Backtest data and limits.
// ---------------------------------------------------------------------------
export type CandleRow = {
  timestamp: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  currency: string;
};
export type CandleSource = (
  symbol: string,
  interval: '1d',
  count: number,
) => Promise<{ candles: CandleRow[]; source?: string; adjusted?: boolean }>;

export const backtestLimits = {
  /** One Toss page. A `before` page parameter is not wired in this stage, so history is capped here. */
  maxBars: 200,
  maxSymbols: 10,
  /** A simulation needs at least this many days beyond the warm-up to say anything. */
  minSimulatedDays: 20,
  perMinute: 6,
  concurrent: 2,
  fetchTimeoutMs: 25_000,
  totalTimeoutMs: 30_000,
  maxEquityPoints: 120,
  maxTrades: 100,
} as const;

const marketZone: Record<Market, string> = { KR: 'Asia/Seoul', US: 'America/New_York' };
function todayIn(zone: string, now: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
const bad = (status: number, code: string, message: string): Rejection => ({
  status,
  code,
  message,
});
export class BacktestInputError extends Error {
  constructor(public rejection: Rejection) {
    super(rejection.code);
  }
}
/**
 * Provider candles -> engine bars. The date is the date part of the provider timestamp as sent
 * (its own offset); this has not been verified against live data and is recorded in the docs.
 */
export function toBars(
  symbol: string,
  rows: CandleRow[],
  currency: 'KRW' | 'USD',
  market: Market,
  now: Date,
  notes: string[],
): DailyBar[] {
  const bars = new Map<string, DailyBar>();
  for (const row of rows) {
    if (row.currency !== currency)
      throw new BacktestInputError(
        bad(
          422,
          'CURRENCY_MISMATCH',
          `종목 ${symbol}의 캔들 통화(${String(row.currency).slice(0, 5)})가 알고리즘 통화(${currency})와 다릅니다. 시장 설정과 종목을 확인하세요.`,
        ),
      );
    const date = String(row.timestamp).slice(0, 10);
    const bar = {
      date,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    };
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      ![bar.open, bar.high, bar.low, bar.close].every((v) => Number.isFinite(v) && v > 0) ||
      !Number.isFinite(bar.volume) ||
      bar.volume < 0
    )
      throw new BacktestInputError(
        bad(422, 'CANDLE_INVALID', `종목 ${symbol}의 일봉에 사용할 수 없는 값이 있습니다.`),
      );
    bars.set(date, bar);
  }
  let sorted = [...bars.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const today = todayIn(marketZone[market], now);
  const before = sorted.length;
  // A bar dated today may still be forming; the engine treats every bar as completed.
  sorted = sorted.filter((b) => b.date < today);
  if (sorted.length < before)
    notes.push(`${symbol}: 오늘(${today}) 날짜의 진행 중일 수 있는 일봉은 제외했다.`);
  return sorted;
}

function downsample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.round((i * (items.length - 1)) / (max - 1))]);
  return out;
}

export type BacktestResponse = ReturnType<typeof shapeBacktest>;
function shapeBacktest(
  result: BacktestResult,
  context: {
    record: AlgorithmRecord;
    budgetAssumed: boolean;
    disabledSignals: string[];
    barCounts: Record<string, number>;
    range: { start: string; end: string };
    slippageBps: number;
    notes: string[];
    now: Date;
  },
) {
  const warnings = [...result.warnings];
  warnings.push(
    `토스 일봉은 한 번에 최대 ${backtestLimits.maxBars}개만 조회한다(과거 페이지 조회는 아직 연결하지 않았다). 이 결과는 약 ${Math.round(backtestLimits.maxBars / 21)}개월 이내 구간만 반영하므로 장기 성과를 대표하지 않는다.`,
  );
  if (context.disabledSignals.includes('value'))
    warnings.push('가치 신호는 재무 데이터를 연결하기 전이라 제외하고 나머지 신호만으로 계산했다.');
  if (context.budgetAssumed)
    warnings.push(
      `운용 금액이 비어 있어 시뮬레이션 기본 금액 ${defaultSimulationBudget[result.currency].toLocaleString('ko-KR')} ${result.currency}을 가정했다.`,
    );
  warnings.push(...context.notes);
  return {
    simulation: true as const,
    generatedAt: context.now.toISOString(),
    algorithm: {
      id: context.record.id,
      name: context.record.name,
      version: context.record.version,
      targetsChangedAt: context.record.targetsChangedAt,
    },
    data: {
      source: 'Toss Securities OpenAPI',
      interval: '1d' as const,
      adjusted: true,
      maxBarsPerSymbol: backtestLimits.maxBars,
      barsPerSymbol: context.barCounts,
      start: context.range.start,
      end: context.range.end,
    },
    currency: result.currency,
    budget: result.budget,
    budgetAssumed: context.budgetAssumed,
    slippageBps: context.slippageBps,
    period: result.period,
    metrics: result.metrics,
    costs: result.costs,
    costSettings: result.costSettings,
    excludedSignals: result.excludedSignals,
    disabledSignals: context.disabledSignals,
    excludedSignalWeightShare: result.excludedSignalWeightShare,
    expectedProfitMode: result.expectedProfitMode,
    researchOnly: result.researchOnly,
    heldBack: result.heldBack,
    rejections: result.rejections,
    stoppedOn: result.stoppedOn,
    openPositions: result.openPositions,
    equityCurve: downsample(result.equityCurve, backtestLimits.maxEquityPoints).map((p) => ({
      date: p.date,
      equity: p.equity,
    })),
    tradeCount: result.trades.length,
    tradesTruncated: result.trades.length > backtestLimits.maxTrades,
    trades: result.trades.slice(-backtestLimits.maxTrades),
    warnings,
  };
}

/** Per-call timeout for provider reads; the provider adapter has its own 8 s request timeout. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new BacktestInputError(
                bad(
                  504,
                  'BACKTEST_TIMEOUT',
                  '시세 조회 시간이 초과되었습니다. 잠시 후 다시 시도하세요.',
                ),
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Router.
// ---------------------------------------------------------------------------
export type AlgorithmsRouterOptions = {
  repository: AlgorithmRepository;
  ownerUserId: string | undefined;
  /** Daily candle reader (the Toss adapter). Missing => backtests answer 503. */
  candles?: CandleSource;
  notify?: (event: NotificationEvent) => Promise<NotifyOutcome>;
  /**
   * Live mode stays unavailable until the order stages (7d-7f) exist. Production never sets this;
   * it exists so the live-overlap rule can be tested end to end.
   */
  liveEnabled?: boolean;
  now?: () => Date;
  newId?: () => string;
};

const failure = (res: Response, rejection: Rejection) =>
  res
    .status(rejection.status)
    .json({ error: { code: rejection.code, message: rejection.message } });
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const liveRejection = bad(
  403,
  'LIVE_NOT_AVAILABLE',
  '실전 운용은 주문 기능 단계(7d–7f) 이후에 켤 수 있습니다.',
);
const outcomeBody = (outcome: NotifyOutcome | undefined) =>
  outcome
    ? {
        status: outcome.status,
        ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
      }
    : { status: 'disabled' as const, failureCode: 'NOT_CONFIGURED' as const };

export function createAlgorithmsRouter(options: AlgorithmsRouterOptions) {
  const { repository } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const router = Router();
  const gate = ownerGate(options.ownerUserId);
  const paths = [
    '/api/algorithms',
    '/api/algorithm-events',
    '/api/algorithm-control',
    '/api/algorithm-settings',
  ];
  // Authentication (and the origin check for writes) already ran in app.ts before this router.
  router.use(paths, gate);
  const notify = async (event: NotificationEvent) =>
    outcomeBody(options.notify ? await options.notify(event) : undefined);
  const event = (
    kind: AlgorithmEvent['kind'],
    changes: Change[],
    algorithm?: Pick<AlgorithmRecord, 'id' | 'name'>,
  ): AlgorithmEvent => ({
    id: newId(),
    at: now().toISOString(),
    kind,
    ...(algorithm ? { algorithmId: algorithm.id, algorithmName: algorithm.name } : {}),
    changes,
  });
  const inputOf = (record: AlgorithmRecord): AlgorithmInput => ({
    name: record.name,
    method: record.method,
    template: record.template,
    market: record.market,
    targets: record.targets,
    signals: record.signals,
    buyThreshold: record.buyThreshold,
    sellThreshold: record.sellThreshold,
    ...(record.dualMomentum ? { dualMomentum: record.dualMomentum } : {}),
    mode: record.mode,
    budget: record.budget,
  });
  /** Rules that need every algorithm: unique name and the live overlap rule. */
  const crossRules = (
    input: AlgorithmInput,
    id: string,
    all: AlgorithmRecord[],
  ): Rejection | null => {
    const lower = input.name.toLowerCase();
    if (all.some((a) => a.id !== id && a.name.toLowerCase() === lower))
      return bad(409, 'ALGORITHM_NAME_EXISTS', '같은 이름의 알고리즘이 이미 있습니다.');
    if (input.mode === 'live') {
      const overlap = findLiveOverlap({ id, targets: input.targets }, all);
      if (overlap)
        return bad(
          409,
          'LIVE_TARGET_OVERLAP',
          `실전 알고리즘 "${overlap.name}"이(가) 같은 종목(${overlap.symbols.join(', ')})을 이미 대상으로 하고 있습니다. 실전 알고리즘끼리는 대상 종목이 겹칠 수 없습니다.`,
        );
    }
    return null;
  };
  /** Body must carry `algorithm`; live is refused before anything else is looked at. */
  const readInput = (req: Request, res: Response): AlgorithmInput | null => {
    const raw = req.body?.algorithm;
    if (raw && typeof raw === 'object' && raw.mode === 'live' && !options.liveEnabled) {
      failure(res, liveRejection);
      return null;
    }
    const parsed = parseAlgorithmInput(raw);
    if (!parsed.ok) {
      failure(res, bad(400, 'INVALID_ALGORITHM', parsed.message));
      return null;
    }
    return parsed.value;
  };

  router.get('/api/algorithms', async (_req, res) => {
    res.json({
      algorithms: await repository.list(),
      limits: { maxAlgorithms },
      liveAvailable: options.liveEnabled === true,
    });
  });

  router.post('/api/algorithms', async (req, res) => {
    const input = readInput(req, res);
    if (!input) return;
    const timestamp = now().toISOString();
    const id = newId();
    const result = await repository.mutate(id, (_current, all) => {
      if (all.length >= maxAlgorithms)
        return {
          reject: bad(
            409,
            'ALGORITHM_LIMIT',
            `알고리즘은 최대 ${maxAlgorithms}개까지 만들 수 있습니다.`,
          ),
        };
      const rejected = crossRules(input, id, all);
      if (rejected) return { reject: rejected };
      const record: AlgorithmRecord = {
        ...input,
        id,
        currency: currencyOf(input.market),
        params: structuredClone(defaultSignalParams),
        targetsChangedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
        version: 1,
      };
      return { write: record, event: event('created', diffAlgorithm(null, input), record) };
    });
    if (!result.ok) return failure(res, result);
    res.status(201).json({ algorithm: result.record });
  });

  router.get('/api/algorithms/:id', async (req, res) => {
    const record = idPattern.test(req.params.id) ? await repository.get(req.params.id) : null;
    if (!record)
      return failure(res, bad(404, 'ALGORITHM_NOT_FOUND', '알고리즘을 찾을 수 없습니다.'));
    res.json({ algorithm: record });
  });

  router.put('/api/algorithms/:id', async (req, res) => {
    const id = req.params.id;
    if (!idPattern.test(id))
      return failure(res, bad(404, 'ALGORITHM_NOT_FOUND', '알고리즘을 찾을 수 없습니다.'));
    const expected = req.body?.version;
    if (!Number.isInteger(expected))
      return failure(res, bad(400, 'INVALID_ALGORITHM', '수정할 버전(version)이 필요합니다.'));
    const input = readInput(req, res);
    if (!input) return;
    const timestamp = now().toISOString();
    let raised = false;
    const result = await repository.mutate(id, (current, all) => {
      if (!current)
        return { reject: bad(404, 'ALGORITHM_NOT_FOUND', '알고리즘을 찾을 수 없습니다.') };
      if (current.version !== expected)
        return {
          reject: bad(
            409,
            'VERSION_CONFLICT',
            '다른 곳에서 먼저 수정되었습니다. 새로 불러온 뒤 다시 수정하세요.',
          ),
        };
      if (input.market !== current.market)
        return {
          reject: bad(
            400,
            'INVALID_ALGORITHM',
            '시장은 만든 뒤에 바꿀 수 없습니다. 새 알고리즘을 만드세요.',
          ),
        };
      const rejected = crossRules(input, id, all);
      if (rejected) return { reject: rejected };
      const changes = diffAlgorithm(inputOf(current), input);
      raised = budgetRaised(inputOf(current), input);
      const targetsChanged = changes.some((c) => c.field === 'targets');
      const record: AlgorithmRecord = {
        ...current,
        ...input,
        ...(input.dualMomentum ? {} : { dualMomentum: undefined }),
        id,
        currency: current.currency,
        params: current.params,
        targetsChangedAt: targetsChanged ? timestamp : current.targetsChangedAt,
        updatedAt: timestamp,
        version: current.version + 1,
      };
      return { write: record, event: event('updated', changes, record) };
    });
    if (!result.ok) return failure(res, result);
    const notification = raised
      ? await notify({
          kind: 'setting-risk-increase',
          change: 'budget-raised',
          algorithmName: result.record!.name,
        })
      : undefined;
    res.json({ algorithm: result.record, ...(notification ? { notification } : {}) });
  });

  router.delete('/api/algorithms/:id', async (req, res) => {
    const id = req.params.id;
    if (!idPattern.test(id))
      return failure(res, bad(404, 'ALGORITHM_NOT_FOUND', '알고리즘을 찾을 수 없습니다.'));
    const result = await repository.mutate(id, (current) =>
      current
        ? { remove: id, event: event('deleted', [], current) }
        : { reject: bad(404, 'ALGORITHM_NOT_FOUND', '알고리즘을 찾을 수 없습니다.') },
    );
    if (!result.ok) return failure(res, result);
    res.sendStatus(204);
  });

  router.get('/api/algorithm-events', async (req, res) => {
    const raw = req.query.limit;
    if (
      Object.keys(req.query).some((k) => k !== 'limit') ||
      (raw !== undefined &&
        (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 100))
    )
      return failure(res, bad(400, 'INVALID_QUERY', 'limit은 1~100 사이 정수로 입력하세요.'));
    const limit = raw === undefined ? 30 : Number(raw);
    res.json({ events: await repository.listEvents(limit), limit });
  });

  router.get('/api/algorithm-control', async (_req, res) => {
    res.json({ control: await repository.getControl() });
  });

  router.put('/api/algorithm-control', async (req, res) => {
    const wanted = req.body?.emergencyStop;
    if (typeof wanted !== 'boolean')
      return failure(
        res,
        bad(400, 'INVALID_CONTROL', 'emergencyStop은 true 또는 false여야 합니다.'),
      );
    const timestamp = now().toISOString();
    const current = await repository.getControl();
    if (current.emergencyStop === wanted) {
      // Idempotent: nothing changes, nothing is recorded, nothing is announced.
      res.json({ control: current, changed: false });
      return;
    }
    // Stopping is a risk reduction: immediate, no checks. Releasing is announced (no extra auth).
    const previous = await repository.setControl(
      wanted,
      timestamp,
      event(wanted ? 'emergency-stop' : 'emergency-release', [
        { field: 'emergencyStop', from: String(!wanted), to: String(wanted) },
      ]),
    );
    const control = { emergencyStop: wanted, updatedAt: timestamp };
    if (wanted || !previous) {
      res.json({ control, changed: true });
      return;
    }
    const notification = await notify({
      kind: 'setting-risk-increase',
      change: 'emergency-stop-released',
    });
    res.json({ control, changed: true, notification });
  });

  router.get('/api/algorithm-settings', async (_req, res) => {
    res.json({ costs: await repository.getCosts() });
  });

  router.put('/api/algorithm-settings', async (req, res) => {
    const parsed = parseCostSettings(req.body?.costs);
    if (!parsed.ok) return failure(res, bad(400, 'INVALID_COSTS', parsed.message));
    const costs: CostSettingsRecord = { ...parsed.value, updatedAt: now().toISOString() };
    const before = await repository.getCosts();
    const changes: Change[] = [];
    const show = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
    for (const key of ['commissionRate', 'sellTaxRate', 'capitalGainsTax'] as const)
      if (show(before[key]) !== show(costs[key]))
        changes.push({
          field: 'costs',
          from: `${key}: ${show(before[key])}`,
          to: `${key}: ${show(costs[key])}`,
        });
    await repository.putCosts(costs, event('costs-updated', changes));
    res.json({ costs });
  });

  // -------------------------------------------------------------------------
  // Backtest: server side only, owner only, rate limited, capped, no orders of any kind.
  // -------------------------------------------------------------------------
  let running = 0;
  router.post(
    '/api/algorithms/:id/backtest',
    rateLimit({
      windowMs: 60_000,
      limit: backtestLimits.perMinute,
      keyGenerator: (_req, res) => res.locals.user.id,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) =>
        failure(
          res,
          bad(429, 'BACKTEST_RATE_LIMITED', '시뮬레이션 요청이 많습니다. 잠시 후 다시 실행하세요.'),
        ),
    }),
    async (req, res) => {
      const id = String(req.params.id);
      const record = idPattern.test(id) ? await repository.get(id) : null;
      if (!record)
        return failure(res, bad(404, 'ALGORITHM_NOT_FOUND', '알고리즘을 찾을 수 없습니다.'));
      if (record.method !== 'formula')
        return failure(
          res,
          bad(
            400,
            'BACKTEST_FORMULA_ONLY',
            'AI형은 과거 시뮬레이션을 지원하지 않습니다. AI 모델이 과거 결과를 이미 알고 있어 수익률이 부풀려지기 때문입니다.',
          ),
        );
      if (!options.candles)
        return failure(
          res,
          bad(
            503,
            'TOSS_INTEGRATION_UNAVAILABLE',
            '토스 API 환경변수와 소유 계정 연결 설정이 필요합니다.',
          ),
        );
      if (record.targets.length > backtestLimits.maxSymbols)
        return failure(
          res,
          bad(
            400,
            'BACKTEST_TOO_MANY_SYMBOLS',
            `시뮬레이션은 대상 종목 ${backtestLimits.maxSymbols}개까지 지원합니다. 현재 ${record.targets.length}개입니다.`,
          ),
        );
      const slippage = req.body?.slippageBps ?? 0;
      if (
        typeof slippage !== 'number' ||
        !Number.isFinite(slippage) ||
        slippage < 0 ||
        slippage > 500
      )
        return failure(res, bad(400, 'INVALID_BACKTEST', '슬리피지는 0~500bp 사이여야 합니다.'));
      if (running >= backtestLimits.concurrent) {
        res.setHeader('Retry-After', '5');
        return failure(
          res,
          bad(429, 'BACKTEST_BUSY', '다른 시뮬레이션이 실행 중입니다. 잠시 후 다시 실행하세요.'),
        );
      }
      running++;
      const started = Date.now();
      try {
        const clock = now();
        const notes: string[] = [];
        const candles = options.candles;
        const barsBy: Record<string, DailyBar[]> = {};
        // Sequential reads: gentle on the provider rate limit, bounded by maxSymbols x timeout.
        await withDeadline(
          (async () => {
            for (const symbol of record.targets) {
              const response = await candles(symbol, '1d', backtestLimits.maxBars);
              barsBy[symbol] = toBars(
                symbol,
                response.candles,
                record.currency,
                record.market,
                clock,
                notes,
              );
            }
          })(),
          backtestLimits.fetchTimeoutMs,
        );
        const definitionSignals = record.signals.filter((s) => s.id !== 'value');
        const droppedValue = record.signals.filter((s) => s.id === 'value' && s.weight > 0);
        const disabledSignals = droppedValue.length > 0 ? ['value'] : [];
        const definition = toDefinition(
          { ...inputOf(record), signals: definitionSignals },
          record.params,
          defaultSimulationBudget[record.currency],
        );
        const needed = requiredBars(definition);
        const longest = Math.max(...Object.values(barsBy).map((b) => b.length));
        if (longest < needed + backtestLimits.minSimulatedDays) {
          const dual = record.template === 'dualMomentum';
          return failure(
            res,
            bad(
              422,
              'INSUFFICIENT_HISTORY',
              `받은 일봉은 최대 ${longest}개인데 신호 계산에 ${needed}개와 시뮬레이션 ${backtestLimits.minSimulatedDays}일이 더 필요합니다.${
                dual
                  ? ' 듀얼 모멘텀은 수익률 기간(lookbackDays)을 줄여 다시 시도하세요(예: 126).'
                  : ''
              }`,
            ),
          );
        }
        if (record.template !== 'dualMomentum' && definition.signals.every((s) => s.weight <= 0))
          return failure(
            res,
            bad(
              422,
              'NO_HISTORICAL_SIGNAL',
              '시뮬레이션에 쓸 수 있는 신호가 없습니다. 가치·수급·뉴스 신호는 과거 시점 데이터가 없어 제외됩니다. 추세·모멘텀·평균회귀 신호를 추가하세요.',
            ),
          );
        const costs = await repository.getCosts();
        const costInput: CostSettings = {
          ...(costs.commissionRate !== null ? { commissionRate: costs.commissionRate } : {}),
          ...(record.market === 'KR' && costs.sellTaxRate !== null
            ? { sellTaxRate: costs.sellTaxRate }
            : {}),
          ...(record.market === 'US' && costs.capitalGainsTax
            ? { capitalGainsTax: costs.capitalGainsTax }
            : {}),
        };
        const missing = Object.entries(barsBy).filter(([, b]) => b.length < needed + 1);
        if (missing.length > 0)
          notes.push(
            `일봉이 부족한 종목(${missing.map(([s]) => s).join(', ')})은 신호를 계산할 수 없어 판단에서 제외된다.`,
          );
        let result: BacktestResult;
        try {
          result = runBacktest({
            algorithm: definition,
            bars: barsBy,
            options: { costs: costInput, slippageBps: slippage },
          });
        } catch (error) {
          return failure(
            res,
            bad(
              422,
              'BACKTEST_INPUT_INVALID',
              `시뮬레이션을 실행할 수 없습니다. (${error instanceof Error ? error.message.slice(0, 200) : '입력 오류'})`,
            ),
          );
        }
        if (Date.now() - started > backtestLimits.totalTimeoutMs)
          return failure(
            res,
            bad(504, 'BACKTEST_TIMEOUT', '시뮬레이션 시간이 초과되어 결과를 버렸습니다.'),
          );
        const dates = Object.values(barsBy)
          .flatMap((b) => b.map((x) => x.date))
          .sort();
        res.json(
          shapeBacktest(result, {
            record,
            budgetAssumed: record.budget === null,
            disabledSignals,
            barCounts: Object.fromEntries(Object.entries(barsBy).map(([s, b]) => [s, b.length])),
            range: { start: dates[0], end: dates[dates.length - 1] },
            slippageBps: slippage,
            notes,
            now: clock,
          }),
        );
      } catch (error) {
        if (error instanceof BacktestInputError) return failure(res, error.rejection);
        throw error;
      } finally {
        running--;
      }
    },
  );
  return router;
}
