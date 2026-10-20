import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { paperMetrics } from '../lib/algo';
import {
  currencyOf,
  findLiveOverlap,
  type AlgorithmEvent,
  type AlgorithmRecord,
  type SafeguardSettingsRecord,
} from '../lib/algorithmRecords';
import type { AlgorithmRepository } from './algorithms';
import type { NotificationEvent, NotifyOutcome } from './notify';
import { ownerGate } from './owner';
import type { PaperRepository } from './paper';
import { REASONS } from './trading/reasons';
import {
  RESOLVABLE_STATUSES,
  summarizeLedger,
  type BlockedOrderRecord,
  type LiveOrderRecord,
  type OrderResolution,
  type TradingStatusStore,
} from './trading/stores';
import { describeOrderError, type OrderErrorInfo } from './trading/toss-orders';

/**
 * Owner-only live screen data (stage 7f): everything the live-enable panel and the live ledger
 * need, in one read. Reads only, except two owner actions (no extra authentication by decision):
 * `release-stop` removes one algorithm's automatic stop (a risk increase: announced on Telegram and
 * recorded in the change history), and `resolve` clears an order whose outcome is unconfirmed after
 * the owner checked the broker app (recorded, announced, ledger updated). Neither places, cancels or
 * sends anything to the broker.
 *
 * Nothing here carries an account identifier, a provider response or error text: orders are
 * projected to a fixed set of fields and errors are reduced to a sanitized code plus the Korean
 * sentence derived from it.
 */
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maxOrders = 40;
const maxBlocked = 25;
/**
 * A live job heartbeat older than this means the schedule is (still) paused or broken. The job runs
 * every weekday (holidays included: it records a skipped run), so even a long holiday weekend stays
 * well inside four days.
 */
export const HEARTBEAT_STALE_DAYS = 4;
const failure = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });

export const LIVE_SCHEDULE_PAUSED_TEXT =
  '실전 일정이 아직 꺼져 있어 주문이 나가지 않습니다 — 운영자가 일정을 켜야 합니다.';
export const MANUAL_POSITIONS_TEXT =
  ' 정지해도 보유 종목은 자동으로 팔지 않으니 남은 보유분은 직접 관리하세요.';
export const STOP_REASON_TEXT: Record<string, string> = {
  'loss-limit': `누적 손실이 한도에 닿아 자동 정지되었습니다.${MANUAL_POSITIONS_TEXT}`,
  'order-permission': `증권사가 주문 권한을 거부해(인증·권한 문제) 자동 정지되었습니다.${MANUAL_POSITIONS_TEXT}`,
  'first-order-rejected': `첫 실전 주문이 증권사에 거부되어 자동 정지되었습니다.${MANUAL_POSITIONS_TEXT}`,
  'unconfirmed-order': `접수 여부를 확인하지 못한 주문이 한 세션 넘게 남아 자동 정지되었습니다. 토스증권 앱에서 확인한 뒤 아래에서 그 주문을 정리하세요.${MANUAL_POSITIONS_TEXT}`,
};

export type LiveRouterOptions = {
  repository: AlgorithmRepository;
  paper: Pick<PaperRepository, 'getLedger'>;
  trading: TradingStatusStore;
  ownerUserId: string | undefined;
  notify?: (event: NotificationEvent) => Promise<NotifyOutcome>;
  /** Mirrors the algorithm router's switch, shown so the panel can say live is off. */
  liveEnabled?: boolean;
  /** Mirrors the job's ALGO_AI_ENABLED for AI-method algorithms. */
  aiEnabled?: boolean;
  now?: () => Date;
  newId?: () => string;
};

const sanitizeError = (error: OrderErrorInfo | undefined) =>
  error
    ? {
        code: /^[a-z0-9][a-z0-9-]{0,63}$/.test(String(error.code)) ? error.code : 'unknown',
        message: describeOrderError({
          kind: error.kind === 'network' || error.kind === 'schema' ? error.kind : 'http',
          status: typeof error.status === 'number' ? error.status : null,
          code: /^[a-z0-9][a-z0-9-]{0,63}$/.test(String(error.code)) ? error.code : 'unknown',
        }),
      }
    : null;

function shapeOrder(o: LiveOrderRecord) {
  return {
    id: o.clientOrderId,
    date: o.dateKey,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    symbol: o.symbol,
    side: o.side,
    quantity: o.quantity,
    price: Number(o.price),
    currency: o.currency,
    status: o.status,
    filledQuantity: o.filledQuantity,
    averageFilledPrice: o.averageFilledPrice ?? null,
    tickCorrected: o.tickCorrected === true,
    /** Outcome unconfirmed: the owner can clear it by hand after checking the broker app. */
    resolvable: RESOLVABLE_STATUSES.includes(o.status),
    error: sanitizeError(o.error),
  };
}
function shapeBlocked(b: BlockedOrderRecord) {
  return {
    id: b.id,
    date: b.dateKey,
    createdAt: b.createdAt,
    symbol: b.symbol,
    side: b.side,
    reasons: b.reasons
      .filter((code) => Object.hasOwn(REASONS, code))
      .map((code) => ({ code, message: REASONS[code] })),
  };
}

export function createLiveRouter(options: LiveRouterOptions) {
  const router = Router();
  const now = options.now ?? (() => new Date());
  const gate = ownerGate(options.ownerUserId);
  const { trading } = options;

  router.get('/api/algorithms/:id/live', gate, async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const record = idPattern.test(id) ? await options.repository.get(id) : null;
    if (!record) return failure(res, 404, 'ALGORITHM_NOT_FOUND', '알고리즘을 찾을 수 없습니다.');
    try {
      const [all, paperLedger, control, stop, accessCheck, heartbeat, orders, blocked] =
        await Promise.all([
          options.repository.list(),
          options.paper.getLedger(id).catch(() => null),
          options.repository.getControl(),
          trading.getAlgorithmStop(id),
          trading.getAccessCheck(),
          trading.getJobHeartbeat(record.market),
          trading.listOrders({ algorithmId: id }),
          trading.listRecentBlocked(id, maxBlocked),
        ]);
      let safeguards: SafeguardSettingsRecord | null = null;
      try {
        safeguards = await options.repository.getSafeguards();
      } catch {
        safeguards = null;
      }
      res.set('Cache-Control', 'no-store');
      res.json(
        shapeLive({
          record,
          all,
          paperLedger,
          emergencyStop: control.emergencyStop,
          stop,
          accessCheck,
          heartbeat,
          orders,
          blocked,
          safeguards,
          liveEnabled: options.liveEnabled !== false,
          aiEnabled: options.aiEnabled === true,
          now: now(),
        }),
      );
    } catch {
      failure(res, 503, 'LIVE_UNAVAILABLE', '실전 운용 상태를 불러오지 못했습니다.');
    }
  });

  router.post(
    '/api/algorithms/:id/live/release-stop',
    gate,
    async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const record = idPattern.test(id) ? await options.repository.get(id) : null;
      if (!record) return failure(res, 404, 'ALGORITHM_NOT_FOUND', '알고리즘을 찾을 수 없습니다.');
      try {
        const stop = await trading.getAlgorithmStop(id);
        if (!stop) return failure(res, 409, 'NOT_STOPPED', '정지된 상태가 아닙니다.');
        await trading.releaseAlgorithmStop(id);
      } catch {
        return failure(
          res,
          503,
          'LIVE_UNAVAILABLE',
          '정지를 해제하지 못했습니다. 다시 시도하세요.',
        );
      }
      const event: AlgorithmEvent = {
        id: (options.newId ?? randomUUID)(),
        at: now().toISOString(),
        kind: 'live-stop-released',
        algorithmId: record.id,
        algorithmName: record.name,
        changes: [{ field: 'liveStop', from: '정지', to: '해제' }],
      };
      try {
        await options.repository.recordEvent(event);
      } catch {
        /* the release itself succeeded; the history row is best effort */
      }
      // A stop released without being noticed would be the worst case: announce it like every other
      // risk increase, and tell the screen exactly what happened to the message.
      let notification: { status: string; failureCode?: string } = {
        status: 'disabled',
        failureCode: 'NOT_CONFIGURED',
      };
      if (options.notify) {
        const outcome = await options.notify({
          kind: 'setting-risk-increase',
          change: 'algorithm-stop-released',
          algorithmName: record.name,
        });
        notification = {
          status: outcome.status,
          ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
        };
      }
      res.json({ released: true, notification });
    },
  );
  const orderIdPattern = /^[a-zA-Z0-9\-_]{1,36}$/;
  const outcomeLabels = {
    filled: '체결',
    canceled: '취소·미체결',
    'not-placed': '접수되지 않음',
  } as const;
  router.post(
    '/api/algorithms/:id/live/orders/:orderId/resolve',
    gate,
    async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const orderId = String(req.params.orderId);
      const record = idPattern.test(id) ? await options.repository.get(id) : null;
      if (!record) return failure(res, 404, 'ALGORITHM_NOT_FOUND', '알고리즘을 찾을 수 없습니다.');
      if (!orderIdPattern.test(orderId))
        return failure(res, 404, 'ORDER_NOT_FOUND', '주문을 찾을 수 없습니다.');
      const body = req.body as Record<string, unknown> | undefined;
      const outcome = body?.outcome;
      let resolution: OrderResolution;
      if (outcome === 'filled') {
        resolution = {
          outcome,
          quantity: body?.quantity as number,
          averagePrice: body?.averagePrice as number,
        };
      } else if (outcome === 'canceled') {
        resolution = {
          outcome,
          ...(body?.quantity === undefined ? {} : { quantity: body.quantity as number }),
          ...(body?.averagePrice === undefined
            ? {}
            : { averagePrice: body.averagePrice as number }),
        };
      } else if (outcome === 'not-placed') resolution = { outcome };
      else
        return failure(
          res,
          400,
          'INVALID_RESOLUTION',
          '정리 결과는 체결, 취소·미체결, 접수되지 않음 중 하나여야 합니다.',
        );
      let resolved: LiveOrderRecord;
      try {
        resolved = await trading.resolveUnconfirmedOrder(id, orderId, resolution);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message === 'Unknown order')
          return failure(res, 404, 'ORDER_NOT_FOUND', '주문을 찾을 수 없습니다.');
        if (message === 'Invalid filled quantity' || message === 'Invalid average price')
          return failure(
            res,
            400,
            'INVALID_RESOLUTION',
            message === 'Invalid average price'
              ? '체결 수량이 있으면 평균 체결가(0보다 큰 숫자)를 입력하세요.'
              : '체결 수량은 주문 수량 이하의 정수여야 합니다(체결이면 1 이상).',
          );
        return failure(
          res,
          409,
          'ORDER_NOT_UNCONFIRMED',
          '접수 여부 미확인 상태의 주문만 정리할 수 있습니다. 화면을 새로고침하세요.',
        );
      }
      const event: AlgorithmEvent = {
        id: (options.newId ?? randomUUID)(),
        at: now().toISOString(),
        kind: 'live-order-resolved',
        algorithmId: record.id,
        algorithmName: record.name,
        changes: [{ field: 'liveOrder', from: '접수 여부 미확인', to: outcomeLabels[outcome] }],
      };
      try {
        await options.repository.recordEvent(event);
      } catch {
        /* the order itself is already updated; the history row is best effort */
      }
      let notification: { status: string; failureCode?: string } = {
        status: 'disabled',
        failureCode: 'NOT_CONFIGURED',
      };
      if (options.notify) {
        const result = await options.notify({
          kind: 'live-order-resolved',
          mode: 'live',
          symbol: resolved.symbol,
          side: resolved.side,
          algorithmName: record.name,
          outcome,
        });
        notification = {
          status: result.status,
          ...(result.failureCode ? { failureCode: result.failureCode } : {}),
        };
      }
      res.json({ resolved: true, status: resolved.status, notification });
    },
  );
  return router;
}

export function shapeLive(input: {
  record: AlgorithmRecord;
  all: AlgorithmRecord[];
  paperLedger: Awaited<ReturnType<PaperRepository['getLedger']>>;
  emergencyStop: boolean;
  stop: { reason: string; stoppedAt: string | null } | null;
  accessCheck: Awaited<ReturnType<TradingStatusStore['getAccessCheck']>>;
  heartbeat: Awaited<ReturnType<TradingStatusStore['getJobHeartbeat']>>;
  orders: LiveOrderRecord[];
  blocked: BlockedOrderRecord[];
  safeguards: SafeguardSettingsRecord | null;
  liveEnabled: boolean;
  aiEnabled: boolean;
  now: Date;
}) {
  const { record } = input;
  // What stands between this algorithm and being switched live (the server enforces the same rules).
  const blockers: { code: string; message: string }[] = [];
  if (!input.liveEnabled)
    blockers.push({
      code: 'LIVE_NOT_AVAILABLE',
      message: '이 배포에서는 실전 운용을 켤 수 없도록 꺼져 있습니다.',
    });
  if (record.budget === null)
    blockers.push({
      code: 'LIVE_BUDGET_REQUIRED',
      message: `운용 금액 한도(${currencyOf(record.market) === 'KRW' ? '원' : '달러'})를 입력하고 저장해야 합니다.`,
    });
  if (
    record.template !== 'dualMomentum' &&
    record.signals.some((s) => s.id === 'value' && s.weight > 0)
  )
    blockers.push({
      code: 'LIVE_VALUE_SIGNAL_UNSUPPORTED',
      message:
        '가치 신호는 재무 데이터 연결 전이라 실전에서 쓸 수 없습니다. 가중치를 0으로 하세요.',
    });
  const overlap = findLiveOverlap({ id: record.id, targets: record.targets }, input.all);
  if (overlap)
    blockers.push({
      code: 'LIVE_TARGET_OVERLAP',
      message: `실전 알고리즘 "${overlap.name}"이(가) 같은 종목(${overlap.symbols.join(', ')})을 이미 대상으로 하고 있습니다.`,
    });

  const ledger = summarizeLedger(input.orders);
  const positions = [...ledger.positions.values()]
    .filter((p) => p.quantity > 0 || p.pendingSellQuantity > 0)
    .map((p) => ({
      symbol: p.symbol,
      quantity: p.quantity,
      averageCost: p.quantity > 0 ? p.costBasis / p.quantity : null,
      pendingSellQuantity: p.pendingSellQuantity,
      lastBuyDate: p.lastBuyDate,
    }))
    .sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
  const newestFirst = [...input.orders].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.clientOrderId.localeCompare(a.clientOrderId),
  );
  const unconfirmed = input.orders.filter((o) => o.status === 'reserved' || o.status === 'unknown');

  const heartbeatAge = input.heartbeat
    ? (input.now.getTime() - Date.parse(input.heartbeat.at)) / 86_400_000
    : null;
  const schedulePaused = heartbeatAge === null || heartbeatAge > HEARTBEAT_STALE_DAYS;
  const metrics = input.paperLedger ? paperMetrics(input.paperLedger) : null;

  return {
    live: true as const,
    generatedAt: input.now.toISOString(),
    algorithm: {
      id: record.id,
      name: record.name,
      mode: record.mode,
      method: record.method,
      market: record.market,
      currency: record.currency,
      budget: record.budget,
      version: record.version,
    },
    enable: { ready: blockers.length === 0, blockers },
    // The numbers a person needs to decide: how long, how many virtual round trips, what is left
    // after costs, and the worst drawdown. "기록 부족" is explained by the screen from these.
    paperSummary: metrics
      ? {
          since: metrics.since,
          lastRunDate: input.paperLedger!.lastRunDate,
          days: metrics.days,
          roundTrips: metrics.roundTrips,
          netReturn: metrics.netReturn,
          costsTotal: metrics.costs.total,
          maxDrawdown: metrics.maxDrawdown,
          fills: metrics.fills,
          status: input.paperLedger!.status,
          budget: input.paperLedger!.budget,
          // The algorithm's targets, thresholds, weights or sizing changed after the paper run began:
          // the record above is "변경 전 기록" (kept, not reset).
          strategyChangedAfterStart:
            (record.strategyChangedAt ?? record.targetsChangedAt) >
            `${input.paperLedger!.startedOn}T23:59:59`,
          strategyChangedAt: record.strategyChangedAt ?? record.targetsChangedAt,
        }
      : null,
    emergencyStop: input.emergencyStop,
    stop: input.stop
      ? {
          reason: input.stop.reason,
          message: STOP_REASON_TEXT[input.stop.reason] ?? '자동 정지되었습니다.',
          stoppedAt: input.stop.stoppedAt,
        }
      : null,
    accessCheck: input.accessCheck,
    job: {
      market: record.market,
      lastRun: input.heartbeat,
      schedulePaused,
      scheduleNotice: schedulePaused ? LIVE_SCHEDULE_PAUSED_TEXT : null,
    },
    ai: record.method === 'ai' ? { enabled: input.aiEnabled } : null,
    safeguards: input.safeguards,
    ledger: { positions, committed: ledger.committed },
    unconfirmedCount: unconfirmed.length,
    orders: newestFirst.slice(0, maxOrders).map(shapeOrder),
    blocked: input.blocked.slice(0, maxBlocked).map(shapeBlocked),
    notes: [
      '실전 기록은 실제 주문과 실제 체결입니다. 모의(가상) 기록과 섞이지 않습니다.',
      '예상 이익이 왕복 비용보다 크지 않거나 같은 점수 구간의 기록이 부족하면 주문이 나가지 않습니다("기록 부족으로 주문 보류").',
    ],
  };
}
export type LiveResponse = ReturnType<typeof shapeLive>;
