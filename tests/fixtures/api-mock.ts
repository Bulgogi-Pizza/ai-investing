import type { Page, Route } from '@playwright/test';
import {
  analysisReply,
  candlePage,
  eventsReply,
  fillsReply,
  indicatorCandlePage,
  macroSeriesReply,
  quotes,
  type EventsMode,
  type FillsMode,
} from './analysis-mock';

/**
 * Synthetic API for browser tests. Every number, name and event here is invented test data;
 * none of it is a market fact and none of it exists in application code.
 */
export type TestUser = { id: string; email: string; role: 'admin' | 'member' };
export const ownerUser: TestUser = {
  id: 'owner-test',
  email: 'owner@example.test',
  role: 'member',
};
export const memberUser: TestUser = {
  id: 'member-test',
  email: 'member@example.test',
  role: 'member',
};
export const adminUser: TestUser = { id: 'admin-test', email: 'admin@example.test', role: 'admin' };

export type MarketMode = 'ok' | 'not-connected' | 'owner-only' | 'empty' | 'transient';
export type MockOptions = {
  /** Initial session. null means signed out (GET /api/auth/me -> 401). */
  user?: TestUser | null;
  /** Account returned after a successful POST /api/auth/login. */
  loginAs?: TestUser;
  market?: MarketMode;
  events?: unknown[];
  strategy?: unknown;
  insight?: unknown;
  /** 종목 분석 event lines (GET /api/analysis/events). */
  chartEvents?: EventsMode;
  /** Algorithm fill markers (GET /api/analysis/algorithm-fills). Default: not connected. */
  fills?: FillsMode;
  /** ECOS USD/KRW series (GET /api/macro/series). Default: ok. */
  ecos?: 'ok' | 'unavailable' | 'error';
  /** Market-indicator / SPY candle requests that fail with a provider error. */
  compareFail?: ('KOSPI' | 'KOSDAQ' | 'SPY')[];
  /** Monthly budget stop (GET /api/ops/budget). Default: the endpoint answers 404 and no banner shows. */
  budget?: 'running' | 'warned' | 'stopped';
};

export const registeredEvents = [
  event(1, '2026-10-06', '21:30', '테스트 고용 지표', '미국', '고용', ['금리'], 3),
  event(2, '2026-10-13', '21:30', '테스트 소비자물가', '미국', '물가', ['금리'], 3),
  event(3, '2026-10-14', '23:30', '테스트 원유 재고', '미국', '에너지', ['유가'], 2),
  event(4, '2026-10-15', '10:00', '테스트 기준금리 결정', '한국', '통화정책', ['원화', '채권'], 3),
  event(5, '2026-10-20', '09:00', '테스트 생산자물가', '한국', '물가', ['원화'], 2),
  event(6, '2026-10-20', '21:30', '테스트 주택착공', '미국', '경기', ['채권'], 2),
  event(7, '2026-10-22', '21:30', '테스트 실업수당', '미국', '고용', ['금', '달러'], 1),
  event(8, '2026-10-27', '10:00', '테스트 서비스업 생산', '한국', '경기', ['원화'], 1),
];
export function event(
  id: number,
  date: string,
  time: string,
  title: string,
  country: string,
  category: string,
  assets: string[],
  importance: number,
) {
  return {
    id,
    date,
    time,
    title,
    country,
    category,
    assets,
    importance,
    description: '테스트용으로 주입한 일정입니다.',
    sourceUrl: 'https://example.test/release',
    sourceName: '테스트 출처',
    impactDirection: 'mixed',
    impactHorizon: '1주',
    confidence: 'low',
    factualObservedAt: '2026-10-20T00:00:00Z',
  };
}
export function candlesFor(symbol: string, before: string | null = null) {
  return candlePage(symbol, before);
}
export const portfolioBody = {
  source: 'Toss Securities OpenAPI',
  asOf: '2026-10-20T00:00:00Z',
  scope: 'stocks-only',
  totals: {
    KRW: { marketValue: '7200000', purchaseAmount: '6500000', profitLoss: '700000' },
    USD: { marketValue: '1785', purchaseAmount: '1553', profitLoss: '232' },
  },
  holdings: [
    {
      symbol: '005930',
      name: '계약 테스트 종목',
      market: 'KR',
      currency: 'KRW',
      quantity: '100',
      lastPrice: '72000',
      averagePurchasePrice: '68000',
      marketValue: '7200000',
      profitLoss: '700000',
      profitLossRate: '0.1077',
    },
  ],
};
export const indicatorsBody = {
  source: 'Toss Securities OpenAPI',
  asOf: '2026-10-20T01:00:00Z',
  indicators: [
    {
      symbol: 'KOSPI',
      name: '코스피',
      kind: 'INDEX',
      unit: 'point',
      lastPrice: '2812.45',
      timestamp: null,
    },
    {
      symbol: 'KOSDAQ',
      name: '코스닥',
      kind: 'INDEX',
      unit: 'point',
      lastPrice: '845.32',
      timestamp: null,
    },
    {
      symbol: 'KR_BOND_2Y',
      name: '국채 2년',
      kind: 'BOND',
      unit: 'percent',
      lastPrice: '2.98',
      timestamp: null,
    },
    {
      symbol: 'KR_BOND_10Y',
      name: '국채 10년',
      kind: 'BOND',
      unit: 'percent',
      lastPrice: '3.25',
      timestamp: null,
    },
  ],
  exchangeRate: {
    baseCurrency: 'USD',
    quoteCurrency: 'KRW',
    midRate: '1375',
    rate: '1380.5',
    rateChangeType: 'UP',
    validFrom: '2026-10-20T09:30:00+09:00',
    validUntil: '2026-10-20T09:31:00+09:00',
  },
};
export const liveInsight = {
  engine: 'rules-v1',
  dataMode: 'live',
  asOf: '2026-10-20T01:00:00Z',
  period: 'daily',
  symbol: '005930',
  horizon: { tradingDays: 1, calendarDays: 1 },
  strategy: {
    name: '검증용 장기 전략',
    horizon: '5',
    benchmark: 'KOSPI 200',
    riskTolerance: 'medium',
    targetAllocations: [
      { asset: 'stock', percentage: 60 },
      { asset: 'bond', percentage: 30 },
      { asset: 'cash', percentage: 10 },
    ],
    notes: '분산 투자',
  },
  decision: {
    action: 'hold-plan',
    title: '저장된 투자 원칙 점검',
    rationale: '실제 입력 계약을 모사한 응답으로 기간 수익률과 목표 배분을 점검합니다.',
    thresholdPercent: 4,
  },
  metrics: {
    returnPercent: 1.25,
    sma20: 71000,
    rsi14: 58.4,
    latestClose: 72400,
    latestTimestamp: '2026-10-20T00:00:00Z',
  },
  evidence: {
    market: {
      source: 'Toss Securities OpenAPI',
      asOf: '2026-10-20T01:00:00Z',
      candles: [{ timestamp: '2026-10-20T00:00:00Z' }],
    },
    calendar: {
      from: '2026-10-20',
      to: '2026-10-21',
      source: 'admin-curated',
      events: [
        {
          id: 4,
          date: '2026-10-20',
          time: '09:00',
          title: '검증용 등록 경제 일정',
          importance: 3,
          sourceName: '공식 발표 출처',
          sourceUrl: 'https://example.com/release',
          factualObservedAt: '2026-10-20T00:00:00Z',
        },
      ],
      truncated: false,
      coverageWarning: '관리자가 등록한 일정만 포함하며 전체 뉴스가 아닙니다.',
      relevanceRule: '한국 시장 또는 글로벌 일정과 해당 종목 직접 태그',
      excludedCount: 2,
    },
  },
  scenarios: ['목표 비중 유지 후 다음 기간 재점검'],
  risks: ['과거 가격 변화는 미래 수익을 보장하지 않습니다.'],
  stockExposureByCurrency: [
    { currency: 'KRW', holdings: [{ symbol: '005930', weightWithinStocksPercent: 70 }] },
  ],
};

const errorBody = (code: string, message: string) => ({ error: { code, message } });
/** Fixed KST noon on the reference day so calendar defaults and dates are deterministic. */
export const fixedNow = new Date('2026-10-20T03:00:00Z');

export async function mockApi(page: Page, options: MockOptions = {}) {
  const market = options.market ?? 'ok';
  const state = {
    user: options.user === undefined ? ownerUser : options.user,
    /** While true every market request fails with a transient provider error. */
    failing: market === 'transient',
    budget: options.budget ?? 'running',
  };
  const requests: string[] = [];
  await page.clock.setFixedTime(fixedNow);
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    requests.push(`${method} ${path}${url.search}`);
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/api/auth/me')
      return state.user
        ? json({ user: state.user })
        : json(errorBody('AUTH_REQUIRED', '로그인이 필요합니다.'), 401);
    if (path === '/api/auth/login' && method === 'POST') {
      state.user = options.loginAs ?? options.user ?? ownerUser;
      return json({ user: state.user });
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      state.user = null;
      return route.fulfill({ status: 204 });
    }
    if (!state.user) return json(errorBody('AUTH_REQUIRED', '로그인이 필요합니다.'), 401);
    if (
      market === 'owner-only' &&
      ['/api/calendar/events', '/api/news/sources', '/api/strategy'].includes(path)
    )
      return json(errorBody('OWNER_REQUIRED', '소유자 계정 전용 기능입니다.'), 403);
    if (path === '/api/ops/budget' && options.budget) {
      const stopped = state.budget === 'stopped';
      return json({
        budget: {
          stopped,
          reason: stopped ? 'budget' : null,
          costAmount: null,
          budgetAmount: null,
          currency: null,
          intervalStart: null,
          warned: state.budget === 'warned',
          stoppedAt: stopped ? '2026-10-20T01:00:00Z' : null,
          releasedAt: null,
          lastMessageAt: '2026-10-20T00:30:00Z',
          updatedAt: null,
        },
        emergencyStop: true,
        enabled: true,
      });
    }
    if (path === '/api/ops/budget/release' && method === 'POST' && options.budget) {
      state.budget = 'running';
      return json({ notification: { status: 'sent' } });
    }
    if (path === '/api/calendar/events')
      return json({ events: options.events ?? registeredEvents, truncated: false });
    if (path === '/api/news/sources') return json({ sources: [], warnings: [] });
    if (path === '/api/strategy')
      return method === 'PUT'
        ? json({ strategy: route.request().postDataJSON().strategy })
        : json({ strategy: options.strategy ?? null });
    if (path === '/api/macro/series') {
      if (options.ecos === 'unavailable')
        return json(
          errorBody('ECOS_UNAVAILABLE', '한국 경제지표(한국은행 ECOS)가 설정되지 않았습니다.'),
          503,
        );
      if (options.ecos === 'error')
        return json(
          errorBody('PROVIDER_UNAVAILABLE', '거시 지표 제공자 서비스를 사용할 수 없습니다.'),
          503,
        );
      const reply = macroSeriesReply(url.searchParams);
      return json(reply.body, reply.status);
    }
    if (path === '/api/admin/users') return json({ users: [{ ...adminUser, active: true }] });
    const marketPaths = [
      '/api/market/candles',
      '/api/market/indicator-candles',
      '/api/market/prices',
      '/api/market/indicators',
      '/api/portfolio',
      '/api/recommendations',
      '/api/fundamentals',
    ];
    const isAnalysis = path.startsWith('/api/analysis/');
    if (!marketPaths.includes(path) && !isAnalysis)
      return json(errorBody('NOT_FOUND', '요청한 API를 찾을 수 없습니다.'), 404);
    if (market === 'not-connected')
      return json(
        errorBody(
          'TOSS_INTEGRATION_UNAVAILABLE',
          '토스 API 환경변수와 소유 계정 연결 설정이 필요합니다.',
        ),
        503,
      );
    if (market === 'owner-only')
      return json(errorBody('OWNER_REQUIRED', '소유자 계정 전용 기능입니다.'), 403);
    if (state.failing)
      return json(
        errorBody('PROVIDER_UNAVAILABLE', '제공자 인증·허용 IP·서비스 상태를 확인하세요.'),
        503,
      );
    const empty = market === 'empty';
    if (path === '/api/market/indicator-candles') {
      const symbol = url.searchParams.get('symbol') ?? '';
      if (options.compareFail?.includes(symbol as 'KOSPI'))
        return json(errorBody('PROVIDER_UNAVAILABLE', '제공자 서비스를 사용할 수 없습니다.'), 503);
      return json(indicatorCandlePage(symbol, url.searchParams.get('before')));
    }
    if (path === '/api/market/candles') {
      if (url.searchParams.get('symbol') === 'SPY' && options.compareFail?.includes('SPY'))
        return json(errorBody('PROVIDER_UNAVAILABLE', '제공자 서비스를 사용할 수 없습니다.'), 503);
      const symbol = url.searchParams.get('symbol') ?? '';
      const page = candlesFor(symbol, url.searchParams.get('before'));
      return json(empty ? { ...page, candles: [] } : page);
    }
    if (path === '/api/market/prices') {
      const wanted = (url.searchParams.get('symbols') ?? '').split(',');
      return json({
        source: 'Toss Securities OpenAPI',
        asOf: '2026-10-20T01:00:00Z',
        prices: empty
          ? []
          : wanted.filter((s) => quotes[s]).map((symbol) => ({ symbol, ...quotes[symbol] })),
      });
    }
    if (path === '/api/analysis/events') {
      const reply = eventsReply(url.searchParams, options.chartEvents ?? 'ok');
      return json(reply.body, reply.status);
    }
    if (path === '/api/analysis/algorithm-fills') {
      const reply = fillsReply(url.searchParams, options.fills ?? 'unconnected');
      return json(reply.body, reply.status);
    }
    if (path === '/api/fundamentals' || isAnalysis) {
      if (empty && path !== '/api/analysis/sector-peers')
        return json(errorBody('PROVIDER_NOT_FOUND', '제공자에 해당 종목 데이터가 없습니다.'), 404);
      const reply = analysisReply(path, url.searchParams);
      if (!reply) return json(errorBody('NOT_FOUND', '요청한 API를 찾을 수 없습니다.'), 404);
      return json(reply.body, reply.status);
    }
    if (path === '/api/market/indicators') return json(indicatorsBody);
    if (path === '/api/portfolio')
      return json(empty ? { ...portfolioBody, holdings: [] } : portfolioBody);
    if (empty)
      return json(errorBody('PROVIDER_NOT_FOUND', '제공자에 해당 종목 데이터가 없습니다.'), 404);
    const period = url.searchParams.get('period') ?? 'daily';
    return json(
      options.insight ?? {
        ...liveInsight,
        period,
        horizon: {
          tradingDays: period === 'weekly' ? 5 : 1,
          calendarDays: period === 'weekly' ? 7 : 1,
        },
      },
    );
  });
  return { requests, state };
}
export const forbiddenText = [
  '합성 데모',
  '합성 예시',
  'DEMO',
  '예시 시세',
  '둘러보기',
  '데모 워크스페이스',
  '샘플 시세',
  '미국 대형주 ETF',
  '예시 데이터',
];
