import type { Page, Route } from '@playwright/test';

/**
 * Stateful synthetic backend for the algorithm screen. Every name, number and notification here
 * is invented test data. It mimics the contract of src/server/algorithms.ts (register it after
 * mockApi so these routes win).
 */
export type AlgoRecord = {
  id: string;
  name: string;
  method: 'formula' | 'ai';
  template: string;
  market: 'KR' | 'US';
  currency: 'KRW' | 'USD';
  targets: string[];
  signals: { id: string; weight: number }[];
  buyThreshold: number;
  sellThreshold: number;
  dualMomentum?: unknown;
  mode: 'simulation' | 'paper' | 'live';
  budget: number | null;
  params: unknown;
  targetsChangedAt: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};
export type Notification = {
  id: string;
  kind: string;
  mode?: 'paper' | 'live';
  createdAt: string;
  status: 'pending' | 'sent' | 'failed' | 'disabled';
  failureCode?: string;
  message: string;
};
export type AlgoMockOptions = {
  algorithms?: AlgoRecord[];
  emergencyStop?: boolean;
  notifications?: Notification[];
  /** Respond to every algorithm endpoint with this status (error-state tests). */
  failListWith?: number;
  ownerOnly?: boolean;
  backtestError?: { status: number; code: string; message: string };
  /** Notification outcome the release request reports. */
  releaseOutcome?: { status: 'sent' | 'failed' | 'disabled'; failureCode?: string };
  saveError?: { status: number; code: string; message: string };
  /** Body of GET /api/algorithms/:id/paper; default is an algorithm without any paper record. */
  paper?: (algorithm: AlgoRecord) => unknown;
  paperError?: { status: number; code: string; message: string };
};

const now = '2026-10-20T03:00:00.000Z';
export const sampleNotifications: Notification[] = [
  {
    id: 'n1',
    kind: 'fill',
    mode: 'paper',
    createdAt: '2026-10-20T00:10:00.000Z',
    status: 'sent',
    message:
      '[모의 운용·가상 체결] 체결 알림\n종목: 005930\n방향: 매수\n알고리즘: 테스트 모멘텀\n화면: https://example.test/algorithms',
  },
  {
    id: 'n2',
    kind: 'order-rejected',
    mode: 'live',
    createdAt: '2026-10-19T00:10:00.000Z',
    status: 'failed',
    failureCode: 'TELEGRAM_TIMEOUT',
    message: '[실전 주문·실제 체결] 주문 거부\n종목: AAPL\n화면: https://example.test/algorithms',
  },
  {
    id: 'n3',
    kind: 'setting-risk-increase',
    createdAt: '2026-10-18T00:10:00.000Z',
    status: 'disabled',
    failureCode: 'NOT_CONFIGURED',
    message: '[위험 증가 설정 변경] 긴급 정지 해제\n화면: https://example.test/algorithms',
  },
];

export const record = (patch: Partial<AlgoRecord> = {}): AlgoRecord => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: '테스트 모멘텀',
  method: 'formula',
  template: 'momentum',
  market: 'KR',
  currency: 'KRW',
  targets: ['005930', '000660'],
  signals: [
    { id: 'trend', weight: 0.4 },
    { id: 'momentum', weight: 0.6 },
  ],
  buyThreshold: 0.3,
  sellThreshold: -0.1,
  mode: 'simulation',
  budget: 10_000_000,
  params: {},
  targetsChangedAt: now,
  createdAt: now,
  updatedAt: now,
  version: 1,
  ...patch,
});

export function backtestBody() {
  const equityCurve = Array.from({ length: 60 }, (_, i) => ({
    date: `2026-0${7 + Math.floor(i / 25)}-${String((i % 25) + 1).padStart(2, '0')}`,
    equity: 10_000_000 + i * 12_000 + Math.sin(i / 4) * 80_000,
  }));
  return {
    simulation: true,
    generatedAt: now,
    algorithm: {
      id: '11111111-1111-4111-8111-111111111111',
      name: '테스트 모멘텀',
      version: 1,
      targetsChangedAt: now,
    },
    data: {
      source: 'Toss Securities OpenAPI',
      interval: '1d',
      adjusted: true,
      maxBarsPerSymbol: 200,
      barsPerSymbol: { '005930': 200, '000660': 200 },
      start: '2025-12-30',
      end: '2026-10-19',
    },
    currency: 'KRW',
    budget: 10_000_000,
    budgetAssumed: false,
    slippageBps: 0,
    period: { start: '2026-03-20', end: '2026-10-19', tradingDays: 150 },
    metrics: {
      finalEquity: 10_412_000,
      totalReturn: 0.0456,
      netReturn: 0.0412,
      maxDrawdown: 0.0731,
      volatility: 0.1834,
      trades: 8,
      roundTrips: 4,
      winRate: 0.75,
      exposure: 0.52,
      daysInvested: 0.6,
    },
    costs: {
      commission: 5_200,
      transactionTax: 21_000,
      capitalGainsTax: 0,
      total: 26_200,
      capitalGainsTaxByYear: [],
    },
    costSettings: {
      commissionRate: 0.0002,
      sellTaxRate: 0,
      capitalGainsTax: { rate: 0, annualDeduction: 0 },
      needsSetup: ['sellTaxRate'],
    },
    excludedSignals: ['supply', 'news'],
    disabledSignals: [],
    excludedSignalWeightShare: 0,
    expectedProfitMode: 'walk-forward',
    researchOnly: false,
    heldBack: { insufficientHistory: 3, expectedBelowCost: 1 },
    rejections: {},
    stoppedOn: null,
    openPositions: [
      {
        symbol: '005930',
        quantity: 12,
        entryDate: '2026-10-05',
        entryPrice: 70000,
        markPrice: 71000,
      },
    ],
    equityCurve,
    tradeCount: 8,
    tradesTruncated: false,
    trades: [
      {
        date: '2026-04-01',
        symbol: '005930',
        side: 'buy',
        quantity: 10,
        price: 60000,
        notional: 600000,
        commission: 120,
        tax: 0,
        score: 0.4,
      },
      {
        date: '2026-05-01',
        symbol: '005930',
        side: 'sell',
        quantity: 10,
        price: 63000,
        notional: 630000,
        commission: 126,
        tax: 1260,
        score: -0.2,
      },
    ],
    warnings: [
      '설정 필요: 증권거래세율이 입력되지 않아 0으로 계산했다.',
      '수급·뉴스 신호는 과거 시점 데이터가 없어 제외했다.',
      '토스 일봉은 한 번에 최대 200개만 조회한다(과거 페이지 조회는 아직 연결하지 않았다).',
    ],
  };
}

/** Synthetic paper (virtual) record: every number is invented test data. */
export function paperBody(algorithm: AlgoRecord, patch: Record<string, unknown> = {}) {
  const equityCurve = Array.from({ length: 12 }, (_, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, '0')}`,
    equity: 10_000_000 + i * 9_000 - (i > 8 ? 60_000 : 0),
  }));
  return {
    virtual: true,
    generatedAt: now,
    algorithm: {
      id: algorithm.id,
      name: algorithm.name,
      mode: algorithm.mode,
      method: algorithm.method,
      market: algorithm.market,
      currency: algorithm.currency,
      targetsChangedAt: algorithm.targetsChangedAt,
    },
    ai: algorithm.method === 'ai' ? { enabled: false, message: 'AI 비용 승인 대기' } : null,
    ledger: {
      status: 'running',
      startedOn: '2026-10-01',
      stoppedOn: null,
      stoppedReason: null,
      budget: 10_000_000,
      cash: 3_200_000,
      lastRunDate: '2026-10-12',
      positions: [
        {
          symbol: '005930',
          quantity: 90,
          entryDate: '2026-10-05',
          entryPrice: 75_500,
          markPrice: 78_000,
          unrealizedPnl: 225_000,
          unrealizedReturn: 0.0331,
        },
      ],
    },
    metrics: {
      since: '2026-10-01',
      days: 12,
      equity: 10_048_000,
      totalReturn: 0.0061,
      netReturn: 0.0048,
      costs: {
        commission: 13_600,
        transactionTax: 0,
        capitalGainsTax: 0,
        total: 13_600,
        slippage: 6_800,
      },
      maxDrawdown: 0.0062,
      volatility: 0.0912,
      fills: 3,
      roundTrips: 1,
      winRate: 1,
      realizedPnl: 41_000,
      unrealizedPnl: 225_000,
    },
    equityCurve,
    trades: [
      {
        id: `${algorithm.id}_2026-10-05_001`,
        date: '2026-10-05',
        symbol: '005930',
        side: 'buy',
        quantity: 90,
        price: 75_500,
        notional: 6_795_000,
        costs: { commission: 6_795, tax: 0, slippage: 3_400 },
        score: 0.62,
        reasons: ['종합 점수가 매수 기준 이상', '종합 점수 0.62'],
        createdAt: '2026-10-05T00:05:01.000Z',
      },
    ],
    runs: [
      {
        id: 'KR_2026-10-12',
        date: '2026-10-12',
        market: 'KR',
        status: 'complete',
        startedAt: '2026-10-12T00:05:00.000Z',
        result: {
          status: 'applied',
          code: null,
          reason: null,
          fills: 0,
          stoppedNow: false,
          decisions: { buy: 0, sell: 0, hold: 2 },
          rejections: {},
          heldBack: { insufficientHistory: 2, expectedBelowCost: 0 },
          excludedSignals: ['가치: 재무 데이터 연결 전이라 제외'],
          notes: [],
        },
      },
      {
        id: 'KR_2026-10-08',
        date: '2026-10-08',
        market: 'KR',
        status: 'complete',
        startedAt: '2026-10-08T00:05:00.000Z',
        result: {
          status: 'skipped',
          code: 'EMERGENCY_STOP',
          reason: '긴급 정지 중이라 아무것도 하지 않았습니다.',
          fills: 0,
          stoppedNow: false,
          decisions: { buy: 0, sell: 0, hold: 0 },
          rejections: {},
          heldBack: { insufficientHistory: 0, expectedBelowCost: 0 },
          excludedSignals: [],
          notes: [],
        },
      },
    ],
    notes: [
      '모의 운용은 가상 기록입니다. 실제 주문이나 체결이 아니며 실제 계좌에 영향이 없습니다.',
    ],
    ...patch,
  };
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });

export async function mockAlgorithmApi(page: Page, options: AlgoMockOptions = {}) {
  const state = {
    algorithms: [...(options.algorithms ?? [])],
    events: [] as unknown[],
    emergencyStop: options.emergencyStop ?? false,
    controlUpdatedAt: null as string | null,
    notifications: [...(options.notifications ?? sampleNotifications)],
    costs: {
      commissionRate: null,
      sellTaxRate: null,
      capitalGainsTax: null,
      updatedAt: null,
    } as Record<string, unknown>,
    failList: options.failListWith,
    counter: 0,
  };
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const event = (kind: string, algorithm?: AlgoRecord, changes: unknown[] = []) =>
    state.events.unshift({
      id: `e${++state.counter}`,
      at: `2026-10-20T03:0${Math.min(state.counter, 9)}:00.000Z`,
      kind,
      ...(algorithm ? { algorithmId: algorithm.id, algorithmName: algorithm.name } : {}),
      changes,
    });
  await page.route(
    /\/api\/(algorithms|algorithm-[a-z]+|notifications)(\/|\?|$)/,
    async (route: Route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const method = route.request().method();
      const body =
        method === 'GET' || method === 'DELETE' ? undefined : route.request().postDataJSON();
      requests.push({ method, path, body });
      const json = (data: unknown, status = 200) => route.fulfill({ status, json: data });
      if (options.ownerOnly)
        return json(errorBody('OWNER_REQUIRED', '소유자 계정 전용 기능입니다.'), 403);
      if (path === '/api/notifications')
        return json({ notifications: state.notifications, limit: 20 });
      if (path === '/api/algorithm-control') {
        if (method === 'PUT') {
          const wanted = body.emergencyStop as boolean;
          const release = state.emergencyStop && !wanted;
          state.emergencyStop = wanted;
          state.controlUpdatedAt = now;
          event(wanted ? 'emergency-stop' : 'emergency-release', undefined, [
            { field: 'emergencyStop', from: String(!wanted), to: String(wanted) },
          ]);
          let notification: unknown;
          if (release) {
            notification = options.releaseOutcome ?? { status: 'sent' };
            state.notifications.unshift({
              id: `n${++state.counter + 100}`,
              kind: 'setting-risk-increase',
              createdAt: now,
              status: (notification as { status: Notification['status'] }).status,
              message:
                '[위험 증가 설정 변경] 긴급 정지 해제\n화면: https://example.test/algorithms',
            });
          }
          return json({
            control: { emergencyStop: wanted, updatedAt: now },
            changed: true,
            ...(notification ? { notification } : {}),
          });
        }
        return json({
          control: { emergencyStop: state.emergencyStop, updatedAt: state.controlUpdatedAt },
        });
      }
      if (path === '/api/algorithm-settings') {
        if (method === 'PUT') {
          state.costs = { ...body.costs, updatedAt: now };
          event('costs-updated', undefined, [{ field: 'costs', from: 'a', to: 'b' }]);
        }
        return json({ costs: state.costs });
      }
      if (path === '/api/algorithm-events') return json({ events: state.events, limit: 50 });
      if (state.failList)
        return json(
          errorBody('REQUEST_FAILED', '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.'),
          state.failList,
        );
      if (path === '/api/algorithms') {
        if (method === 'GET')
          return json({
            algorithms: state.algorithms,
            limits: { maxAlgorithms: 20 },
            liveAvailable: false,
          });
        if (options.saveError)
          return json(
            errorBody(options.saveError.code, options.saveError.message),
            options.saveError.status,
          );
        const created = record({
          ...body.algorithm,
          id: `22222222-2222-4222-8222-22222222222${state.algorithms.length}`,
          currency: body.algorithm.market === 'KR' ? 'KRW' : 'USD',
          version: 1,
        });
        state.algorithms.push(created);
        event('created', created, [{ field: 'targets', added: created.targets, removed: [] }]);
        return json({ algorithm: created }, 201);
      }
      const match = path.match(/^\/api\/algorithms\/([^/]+)(\/backtest|\/paper)?$/);
      if (match) {
        const index = state.algorithms.findIndex((a) => a.id === match[1]);
        if (index < 0)
          return json(errorBody('ALGORITHM_NOT_FOUND', '알고리즘을 찾을 수 없습니다.'), 404);
        if (match[2] === '/paper') {
          if (options.paperError)
            return json(
              errorBody(options.paperError.code, options.paperError.message),
              options.paperError.status,
            );
          const algorithm = state.algorithms[index];
          return json(
            options.paper
              ? options.paper(algorithm)
              : paperBody(algorithm, {
                  ledger: null,
                  metrics: null,
                  equityCurve: [],
                  trades: [],
                  runs: [],
                }),
          );
        }
        if (match[2]) {
          if (options.backtestError)
            return json(
              errorBody(options.backtestError.code, options.backtestError.message),
              options.backtestError.status,
            );
          return json(backtestBody());
        }
        if (method === 'DELETE') {
          const [removed] = state.algorithms.splice(index, 1);
          event('deleted', removed);
          return route.fulfill({ status: 204 });
        }
        if (method === 'PUT') {
          if (options.saveError)
            return json(
              errorBody(options.saveError.code, options.saveError.message),
              options.saveError.status,
            );
          const before = state.algorithms[index];
          const updated = {
            ...before,
            ...body.algorithm,
            version: before.version + 1,
            updatedAt: now,
          };
          state.algorithms[index] = updated;
          event('updated', updated, [{ field: 'mode', from: before.mode, to: updated.mode }]);
          return json({ algorithm: updated });
        }
        return json({ algorithm: state.algorithms[index] });
      }
      return json(errorBody('NOT_FOUND', '요청한 API를 찾을 수 없습니다.'), 404);
    },
  );
  return { state, requests };
}
