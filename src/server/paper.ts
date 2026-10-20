import { FieldPath, Firestore } from '@google-cloud/firestore';
import { Router, type Request, type Response } from 'express';
import { paperMetrics, type Market, type PaperFill, type PaperLedger } from '../lib/algo';
import type { AlgorithmRecord } from '../lib/algorithmRecords';
import type { AlgorithmRepository } from './algorithms';
import { ownerGate } from './owner';

/**
 * Paper (virtual) trading storage and the owner-only read API (stage 7c). Server-only Firestore
 * collections, no TTL: the track record is the point.
 *
 *   algorithmRuns/{market}_{date}                 one run record per market/session date (dedupe)
 *   paperLedgers/{algorithmId}                    cash, positions, costs, equity curve, shadow samples
 *   paperTrades/{algorithmId}_{date}_{NNN}        one virtual fill each; ids make re-runs idempotent
 *
 * Everything here is virtual. Nothing in this module can place an order.
 */
export type RunStatus = 'running' | 'complete' | 'partial' | 'failed' | 'skipped';
export type AlgorithmRunResult = {
  status: 'applied' | 'skipped' | 'failed';
  /** Upper-snake code (never provider text). */
  code: string | null;
  /** Korean reason shown on screen. */
  reason: string | null;
  fills: number;
  stoppedNow: boolean;
  decisions: { buy: number; sell: number; hold: number };
  rejections: Record<string, number>;
  heldBack: { insufficientHistory: number; expectedBelowCost: number };
  /** Signals not used in this run with the reason ("가치: 재무 연결 전" ...). */
  excludedSignals: string[];
  notes: string[];
};
export type AlgorithmRun = {
  id: string;
  market: Market;
  /** Market-local session date. */
  date: string;
  status: RunStatus;
  trigger: 'scheduler' | 'manual';
  attempts: number;
  startedAt: string;
  finishedAt: string | null;
  sessionOpen: string | null;
  skipCode: string | null;
  results: Record<string, AlgorithmRunResult>;
};
export type PaperTrade = {
  id: string;
  algorithmId: string;
  market: Market;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  /** Fill price (decision price with adverse slippage). */
  price: number;
  referencePrice: number;
  notional: number;
  costs: { commission: number; tax: number; slippage: number };
  score: number | null;
  reasons: string[];
  runId: string;
  /** Market-local session date. */
  date: string;
  createdAt: string;
  /** Marker fields so a virtual fill can never be shown as a real one. */
  mode: 'paper';
  virtual: true;
  targetsChangedAt: string;
};
export type BeginRunResult = {
  state: 'started' | 'complete' | 'running';
  attempts: number;
  /** Results an earlier unfinished attempt of the same run already recorded (kept on restart). */
  previous: Record<string, AlgorithmRunResult>;
};

export const runId = (market: Market, date: string) => `${market}_${date}`;
export const tradeId = (algorithmId: string, date: string, seq: number) =>
  `${algorithmId}_${date}_${String(seq).padStart(3, '0')}`;

export function toTrade(
  fill: PaperFill,
  context: {
    ledger: Pick<PaperLedger, 'algorithmId' | 'market'>;
    runId: string;
    date: string;
    createdAt: string;
    targetsChangedAt: string;
  },
): PaperTrade {
  return {
    id: tradeId(context.ledger.algorithmId, context.date, fill.seq),
    algorithmId: context.ledger.algorithmId,
    market: context.ledger.market,
    symbol: fill.symbol,
    side: fill.side,
    quantity: fill.quantity,
    price: fill.price,
    referencePrice: fill.referencePrice,
    notional: fill.notional,
    costs: { commission: fill.commission, tax: fill.tax, slippage: fill.slippage },
    score: fill.score,
    reasons: fill.reasons,
    runId: context.runId,
    date: context.date,
    createdAt: context.createdAt,
    mode: 'paper',
    virtual: true,
    targetsChangedAt: context.targetsChangedAt,
  };
}

export interface PaperRepository {
  /** Starts (or restarts) a run unless it already completed or is being run. */
  beginRun(
    run: AlgorithmRun,
    options: { nowMs: number; staleAfterMs: number },
  ): Promise<BeginRunResult>;
  finishRun(run: AlgorithmRun): Promise<void>;
  putSkippedIfAbsent(run: AlgorithmRun): Promise<void>;
  listRuns(market: Market, limit: number): Promise<AlgorithmRun[]>;
  getLedger(algorithmId: string): Promise<PaperLedger | null>;
  /** Writes the fills and then the ledger. Fill ids are deterministic, so a retry is idempotent. */
  commitDay(ledger: PaperLedger, trades: PaperTrade[]): Promise<void>;
  /** Newest first. */
  listTrades(algorithmId: string, limit: number): Promise<PaperTrade[]>;
  /** Newest first. */
  listTradesBySymbol(symbol: string, limit: number): Promise<PaperTrade[]>;
}

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function decideBegin(
  existing: AlgorithmRun | null,
  options: { nowMs: number; staleAfterMs: number },
): BeginRunResult['state'] {
  if (!existing) return 'started';
  if (existing.status === 'complete') return 'complete';
  if (
    existing.status === 'running' &&
    options.nowMs - Date.parse(existing.startedAt) < options.staleAfterMs
  )
    return 'running';
  return 'started';
}
const newestFirst = (a: PaperTrade, b: PaperTrade) =>
  b.date.localeCompare(a.date) || b.id.localeCompare(a.id);

export class MemoryPaperRepository implements PaperRepository {
  readonly runs = new Map<string, AlgorithmRun>();
  readonly ledgers = new Map<string, PaperLedger>();
  readonly trades = new Map<string, PaperTrade>();
  async beginRun(run: AlgorithmRun, options: { nowMs: number; staleAfterMs: number }) {
    const existing = this.runs.get(run.id) ?? null;
    const state = decideBegin(existing, options);
    const attempts = (existing?.attempts ?? 0) + (state === 'started' ? 1 : 0);
    const previous = plain(existing?.results ?? {});
    if (state === 'started')
      this.runs.set(run.id, plain({ ...run, attempts, results: { ...previous, ...run.results } }));
    return { state, attempts, previous };
  }
  async finishRun(run: AlgorithmRun) {
    this.runs.set(run.id, plain(run));
  }
  async putSkippedIfAbsent(run: AlgorithmRun) {
    if (!this.runs.has(run.id)) this.runs.set(run.id, plain(run));
  }
  async listRuns(market: Market, limit: number) {
    return plain(
      [...this.runs.values()]
        .filter((run) => run.market === market)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, limit),
    );
  }
  async getLedger(algorithmId: string) {
    return plain(this.ledgers.get(algorithmId) ?? null);
  }
  async commitDay(ledger: PaperLedger, trades: PaperTrade[]) {
    for (const trade of trades) this.trades.set(trade.id, plain(trade));
    this.ledgers.set(ledger.algorithmId, plain(ledger));
  }
  async listTrades(algorithmId: string, limit: number) {
    return plain(
      [...this.trades.values()]
        .filter((t) => t.algorithmId === algorithmId)
        .sort(newestFirst)
        .slice(0, limit),
    );
  }
  async listTradesBySymbol(symbol: string, limit: number) {
    return plain(
      [...this.trades.values()]
        .filter((t) => t.symbol === symbol)
        .sort(newestFirst)
        .slice(0, limit),
    );
  }
}

export class FirestorePaperRepository implements PaperRepository {
  constructor(private db = new Firestore()) {}
  async beginRun(run: AlgorithmRun, options: { nowMs: number; staleAfterMs: number }) {
    const ref = this.db.collection('algorithmRuns').doc(run.id);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const existing = snapshot.exists ? (snapshot.data() as AlgorithmRun) : null;
      const state = decideBegin(existing, options);
      const attempts = (existing?.attempts ?? 0) + (state === 'started' ? 1 : 0);
      const previous = plain(existing?.results ?? {});
      if (state === 'started')
        tx.set(ref, plain({ ...run, attempts, results: { ...previous, ...run.results } }));
      return { state, attempts, previous };
    });
  }
  async finishRun(run: AlgorithmRun) {
    await this.db.collection('algorithmRuns').doc(run.id).set(plain(run));
  }
  async putSkippedIfAbsent(run: AlgorithmRun) {
    // create() fails when the document exists, which keeps a completed run record intact.
    try {
      await this.db.collection('algorithmRuns').doc(run.id).create(plain(run));
    } catch {
      /* already recorded */
    }
  }
  async listRuns(market: Market, limit: number) {
    // Document ids start with "{market}_{date}", so an id range needs no composite index.
    const result = await this.db
      .collection('algorithmRuns')
      .where(FieldPath.documentId(), '>=', `${market}_`)
      .where(FieldPath.documentId(), '<', `${market}\``)
      .orderBy(FieldPath.documentId(), 'desc')
      .limit(limit)
      .get();
    return result.docs.map((doc) => doc.data() as AlgorithmRun);
  }
  async getLedger(algorithmId: string) {
    const doc = await this.db.collection('paperLedgers').doc(algorithmId).get();
    return doc.exists ? (doc.data() as PaperLedger) : null;
  }
  async commitDay(ledger: PaperLedger, trades: PaperTrade[]) {
    // Fills first, ledger last: a crash in between leaves the ledger without this run's id, so the
    // retry writes the same fill documents again and then the ledger.
    for (let start = 0; start < trades.length; start += 400) {
      const batch = this.db.batch();
      for (const trade of trades.slice(start, start + 400))
        batch.set(this.db.collection('paperTrades').doc(trade.id), plain(trade));
      await batch.commit();
    }
    await this.db.collection('paperLedgers').doc(ledger.algorithmId).set(plain(ledger));
  }
  async listTrades(algorithmId: string, limit: number) {
    // Ids start with "{algorithmId}_{date}_", so the id range is the algorithm's fills, newest last.
    const result = await this.db
      .collection('paperTrades')
      .where(FieldPath.documentId(), '>=', `${algorithmId}_`)
      .where(FieldPath.documentId(), '<', `${algorithmId}\``)
      .orderBy(FieldPath.documentId(), 'desc')
      .limit(limit)
      .get();
    return result.docs.map((doc) => doc.data() as PaperTrade);
  }
  async listTradesBySymbol(symbol: string, limit: number) {
    // Equality filter only (single-field index); sorted here. A symbol has few paper fills.
    const result = await this.db
      .collection('paperTrades')
      .where('symbol', '==', symbol)
      .limit(Math.max(limit, 1000))
      .get();
    return result.docs
      .map((doc) => doc.data() as PaperTrade)
      .sort(newestFirst)
      .slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Chart marker reader ("내 매매" on the analysis chart, stage 5e/7f).
// ---------------------------------------------------------------------------
export type ChartFill = {
  /** Market-local trade date (YYYY-MM-DD) the marker belongs to. */
  date: string;
  /** UTC ISO time the virtual fill was recorded. */
  at: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  algorithmId: string;
  /** Always 'paper' until live orders exist; live fills will use the same shape with 'live'. */
  mode: 'paper' | 'live';
};
const SYMBOL = /^[A-Za-z0-9][A-Za-z0-9.-]{0,11}$/;
export const maxChartFills = 200;
/**
 * Fills of one symbol for the chart's own-trade markers, newest first. An invalid symbol or a
 * storage failure returns [] (the chart simply shows no markers).
 */
export async function listFills(repository: PaperRepository, symbol: string): Promise<ChartFill[]> {
  if (typeof symbol !== 'string' || !SYMBOL.test(symbol)) return [];
  try {
    const trades = await repository.listTradesBySymbol(symbol.toUpperCase(), maxChartFills);
    return trades.map((t) => ({
      date: t.date,
      at: t.createdAt,
      side: t.side,
      quantity: t.quantity,
      price: t.price,
      algorithmId: t.algorithmId,
      mode: t.mode,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Router: GET /api/algorithms/:id/paper (owner only).
// ---------------------------------------------------------------------------
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maxTrades = 50;
const maxRuns = 20;
const maxEquityPoints = 120;
const failure = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });
function downsample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.round((i * (items.length - 1)) / (max - 1))]);
  return out;
}

export const AI_PENDING_MESSAGE = 'AI 비용 승인 대기';

export function shapePaper(input: {
  record: AlgorithmRecord;
  ledger: PaperLedger | null;
  trades: PaperTrade[];
  runs: AlgorithmRun[];
  aiEnabled: boolean;
  now: Date;
}) {
  const { record, ledger } = input;
  const notes: string[] = [
    '모의 운용은 가상 기록입니다. 실제 주문이나 체결이 아니며 실제 계좌에 영향이 없습니다.',
  ];
  if (record.method === 'ai' && !input.aiEnabled)
    notes.push(`AI형 알고리즘은 ${AI_PENDING_MESSAGE} 상태라 모의 판단도 하지 않습니다.`);
  if (record.mode !== 'paper')
    notes.push(
      ledger
        ? '현재 모드가 모의가 아니라서 새 판단은 하지 않습니다. 아래는 이전 기록입니다.'
        : '모드를 "모의"로 저장하면 다음 개장 직후부터 매일 가상 판단을 기록합니다.',
    );
  if (ledger && record.targetsChangedAt > `${ledger.startedOn}T23:59:59`)
    notes.push(
      `대상 종목이 ${record.targetsChangedAt.slice(0, 10)}에 바뀌었습니다. 그 이후 성과는 이전 성과와 구분해서 보세요.`,
    );
  if (ledger && record.budget !== null && record.budget !== ledger.budget)
    notes.push('운용 금액을 바꿨지만 모의 운용의 가상 시작 금액은 처음 값 그대로입니다.');
  return {
    virtual: true as const,
    generatedAt: input.now.toISOString(),
    algorithm: {
      id: record.id,
      name: record.name,
      mode: record.mode,
      method: record.method,
      market: record.market,
      currency: record.currency,
      targetsChangedAt: record.targetsChangedAt,
    },
    ai: record.method === 'ai' ? { enabled: input.aiEnabled, message: AI_PENDING_MESSAGE } : null,
    ledger: ledger
      ? {
          status: ledger.status,
          startedOn: ledger.startedOn,
          stoppedOn: ledger.stoppedOn,
          stoppedReason: ledger.stoppedReason,
          budget: ledger.budget,
          cash: ledger.cash,
          lastRunDate: ledger.lastRunDate,
          positions: Object.values(ledger.positions)
            .map((p) => ({
              symbol: p.symbol,
              quantity: p.quantity,
              entryDate: p.entryDate,
              entryPrice: p.entryPrice,
              markPrice: p.markPrice,
              unrealizedPnl: p.quantity * (p.markPrice - p.entryPrice),
              unrealizedReturn: p.entryPrice > 0 ? p.markPrice / p.entryPrice - 1 : null,
            }))
            .sort((a, b) => (a.symbol < b.symbol ? -1 : 1)),
        }
      : null,
    metrics: ledger ? paperMetrics(ledger) : null,
    equityCurve: ledger
      ? downsample(ledger.equityCurve, maxEquityPoints).map((p) => ({
          date: p.date,
          equity: p.equity,
        }))
      : [],
    trades: input.trades.slice(0, maxTrades).map((t) => ({
      id: t.id,
      date: t.date,
      symbol: t.symbol,
      side: t.side,
      quantity: t.quantity,
      price: t.price,
      notional: t.notional,
      costs: t.costs,
      score: t.score,
      reasons: t.reasons,
      createdAt: t.createdAt,
    })),
    runs: input.runs
      .filter((run) => run.results[record.id])
      .slice(0, maxRuns)
      .map((run) => ({
        id: run.id,
        date: run.date,
        market: run.market,
        status: run.status,
        startedAt: run.startedAt,
        result: run.results[record.id],
      })),
    notes,
  };
}
export type PaperResponse = ReturnType<typeof shapePaper>;

export type PaperRouterOptions = {
  repository: PaperRepository;
  algorithmRepository: AlgorithmRepository;
  ownerUserId: string | undefined;
  /** Mirrors the job's ALGO_AI_ENABLED so the screen can say why AI algorithms are idle. */
  aiEnabled?: boolean;
  now?: () => Date;
};

export function createPaperRouter(options: PaperRouterOptions) {
  const router = Router();
  const now = options.now ?? (() => new Date());
  const gate = ownerGate(options.ownerUserId);
  // Authentication (and the origin check) already ran in app.ts before this router.
  router.get('/api/algorithms/:id/paper', gate, async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const record = idPattern.test(id) ? await options.algorithmRepository.get(id) : null;
    if (!record) return failure(res, 404, 'ALGORITHM_NOT_FOUND', '알고리즘을 찾을 수 없습니다.');
    try {
      const [ledger, trades, runs] = await Promise.all([
        options.repository.getLedger(id),
        options.repository.listTrades(id, maxTrades),
        options.repository.listRuns(record.market, 40),
      ]);
      res.set('Cache-Control', 'no-store');
      res.json(
        shapePaper({
          record,
          ledger,
          trades,
          runs,
          aiEnabled: options.aiEnabled === true,
          now: now(),
        }),
      );
    } catch {
      failure(res, 503, 'PAPER_UNAVAILABLE', '모의 운용 기록을 불러오지 못했습니다.');
    }
  });
  return router;
}
