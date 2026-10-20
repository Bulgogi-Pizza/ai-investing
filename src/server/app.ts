import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { resolve } from 'node:path';
import {
  createSessionToken,
  hashPassword,
  normalizeEmail,
  sessionHash,
  validCredentials,
  verifyPassword,
} from './auth.js';
import {
  createCalendarRouter,
  MemoryCalendarRepository,
  type CalendarRepository,
} from './calendar.js';
import {
  createMorningRouter,
  MemoryMorningRunRepository,
  type MorningRunRepository,
} from './morning.js';
import { createNewsRouter } from './news.js';
import {
  createAlgorithmsRouter,
  MemoryAlgorithmRepository,
  type AlgorithmRepository,
} from './algorithms.js';
import {
  createNotificationsRouter,
  MemoryNotificationRepository,
  NotificationService,
  validAppOrigin,
  type NotificationRepository,
} from './notify.js';
import { createPaperRouter, MemoryPaperRepository, type PaperRepository } from './paper.js';
import { createLiveRouter } from './live.js';
import { MemoryTradingStore, type TradingStatusStore } from './trading/stores.js';
import { createAnalysisRouter } from './analysis.js';
import { createAnalysisEventsRouter } from './analysis-events.js';
import type { AlgorithmFillSource } from './algorithm-fills.js';
import { createMacroRouter, type EcosAdapter, type FredAdapter } from './macro/index.js';
import { createFundamentalsRouter } from './fundamentals/index.js';
import type { FundamentalsRouterOptions } from './fundamentals/router.js';
import type { DartAdapter } from './fundamentals/dart.js';
import type { SecAdapter } from './fundamentals/sec.js';
import { ownerGate } from './owner.js';
import {
  createSnapshotRouter,
  MemorySnapshotRepository,
  type SnapshotRepository,
} from './snapshots.js';
import type { aiFromEnvironment } from './ai.js';
import { MemoryLoginThrottle, type LoginThrottle } from './login-throttle.js';
import { createRecommendation, validRecommendationQuery } from './recommendations.js';
import { TossAnalysis } from './toss-analysis.js';
import {
  MARKET_INDICATOR_CATALOG,
  ProviderError,
  parsePriceSymbols,
  validBefore,
  type TossClient,
} from './toss.js';
import { MemoryStore, type Store, type Strategy, type User } from './store.js';

export type AppOptions = {
  store?: Store;
  production?: boolean;
  origin?: string;
  staticDirectory?: string;
  toss?: TossClient;
  /** Same TOSS_OWNER_USER_ID the Toss client is bound to. Missing => owner routes fail closed. */
  ownerUserId?: string;
  /** DART / SEC EDGAR adapters from the environment; a missing one answers 503 for its market. */
  dart?: FundamentalsRouterOptions['dart'] & Partial<Pick<DartAdapter, 'disclosures'>>;
  sec?: FundamentalsRouterOptions['sec'] & Partial<Pick<SecAdapter, 'filings'>>;
  /** FRED / ECOS adapters from the environment; a missing one answers 503 (macro routes) or is reported "미연결" (events). */
  fred?: Pick<FredAdapter, 'observations' | 'upcomingReleases'>;
  ecos?: Pick<EcosAdapter, 'observations'>;
  /** Algorithm fills for the chart markers. Defaults to "not connected" until stage 7c writes paperTrades. */
  algorithmFills?: AlgorithmFillSource;
  calendarRepository?: CalendarRepository;
  snapshotRepository?: SnapshotRepository;
  /** Morning calendar job records (the stored brief is read from here). */
  morningRepository?: MorningRunRepository;
  loginThrottle?: LoginThrottle;
  /** Algorithm models, change history, emergency-stop flag and cost settings (owner-only API). */
  algorithmRepository?: AlgorithmRepository;
  /** Live mode can be switched on from the screen (default true). `false` refuses every live save. */
  algorithmLiveEnabled?: boolean;
  /** Live orders, stops and job status for the live panel (owner-only API). Defaults to an empty in-memory store. */
  tradingStore?: TradingStatusStore;
  /** Paper (virtual) ledger, fills and run history for the 모의 운용 section (owner-only API). */
  paperRepository?: PaperRepository;
  /** Mirrors the job's ALGO_AI_ENABLED so the screen can explain idle AI algorithms. */
  algorithmAiEnabled?: boolean;
  notificationRepository?: NotificationRepository;
  notifications?: NotificationService;
  ai?: ReturnType<typeof aiFromEnvironment>;
};
const publicUser = (user: User) => ({ id: user.id, email: user.email, role: user.role });
const failure = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });
function validStrategy(value: unknown): value is Strategy {
  if (!value || typeof value !== 'object') return false;
  const v = value as Strategy;
  const text = (s: unknown, max: number) => typeof s === 'string' && s.length <= max;
  return (
    text(v.name, 100) &&
    v.name.trim().length > 0 &&
    text(v.horizon, 100) &&
    text(v.benchmark, 100) &&
    text(v.notes, 2000) &&
    ['low', 'medium', 'high'].includes(v.riskTolerance) &&
    Array.isArray(v.targetAllocations) &&
    v.targetAllocations.length > 0 &&
    v.targetAllocations.length <= 30 &&
    v.targetAllocations.every(
      (a) =>
        a &&
        text(a.asset, 80) &&
        a.asset.trim().length > 0 &&
        typeof a.percentage === 'number' &&
        Number.isFinite(a.percentage) &&
        a.percentage >= 0 &&
        a.percentage <= 100,
    ) &&
    Math.abs(v.targetAllocations.reduce((s, a) => s + a.percentage, 0) - 100) < 0.01 &&
    new Set(v.targetAllocations.map((a) => a.asset.trim())).size === v.targetAllocations.length
  );
}
export function createApp(options: AppOptions = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const origin =
    options.origin ?? process.env.APP_ORIGIN ?? (production ? '' : 'http://127.0.0.1:5173');
  if (
    !origin ||
    new URL(origin).origin !== origin ||
    (production && !origin.startsWith('https://'))
  )
    throw new Error('Valid APP_ORIGIN required');
  if (production && !options.store) throw new Error('Durable production store required');
  if (production && !options.loginThrottle)
    throw new Error('Shared production login throttle required');
  const loginThrottle = options.loginThrottle ?? new MemoryLoginThrottle();
  const store = options.store ?? new MemoryStore();
  const calendarRepository = options.calendarRepository ?? new MemoryCalendarRepository();
  const algorithmRepository = options.algorithmRepository ?? new MemoryAlgorithmRepository();
  const notificationRepository =
    options.notificationRepository ?? new MemoryNotificationRepository();
  // The service needs an https (or 127.0.0.1) origin for its links; without one nothing is sent.
  const notifications =
    options.notifications ??
    (validAppOrigin(origin)
      ? new NotificationService({ repository: notificationRepository, appOrigin: origin })
      : undefined);
  // Owner-only gates. Authentication has already run; both read the server-side session user.
  // Toss-backed data additionally needs the Toss client; owner-account data needs only the id.
  const ownerAccount = ownerGate(options.ownerUserId);
  const requireOwner = (req: Request, res: Response, next: NextFunction) => {
    if (!options.toss) {
      failure(
        res,
        503,
        'TOSS_INTEGRATION_UNAVAILABLE',
        '토스 API 환경변수와 소유 계정 연결 설정이 필요합니다.',
      );
      return;
    }
    ownerAccount(req, res, next);
  };
  const app = express();
  app.disable('x-powered-by');
  // Cloud Run has one trusted ingress proxy; never trust arbitrary forwarded chains.
  if (production) app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(
    '/api',
    rateLimit({
      windowMs: 60 * 1000,
      limit: 120,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
  );
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api', (req, res, next) => {
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      (req.get('origin') !== origin || req.get('sec-fetch-site') === 'cross-site')
    ) {
      failure(res, 403, 'ORIGIN_DENIED', '허용되지 않은 요청 출처입니다.');
      return;
    }
    next();
  });
  app.post(
    '/api/auth/login',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
    async (req, res) => {
      const { email, password } = req.body ?? {};
      if (!validCredentials(email, password)) {
        failure(res, 401, 'INVALID_CREDENTIALS', '이메일 또는 비밀번호를 확인하세요.');
        return;
      }
      const normalizedEmail = normalizeEmail(email);
      try {
        const attempt = await loginThrottle.consume(
          ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown'),
          normalizedEmail,
        );
        if (!attempt.allowed) {
          res.setHeader('Retry-After', String(attempt.retryAfter));
          failure(
            res,
            429,
            'LOGIN_RATE_LIMITED',
            '로그인 시도 한도에 도달했습니다. 잠시 후 다시 시도하세요.',
          );
          return;
        }
      } catch {
        failure(
          res,
          503,
          'LOGIN_PROTECTION_UNAVAILABLE',
          '로그인 보호 상태를 확인할 수 없습니다. 잠시 후 다시 시도하세요.',
        );
        return;
      }
      const user = await store.findUser(normalizedEmail);
      // Equal-cost verification prevents the account-existence timing distinction.
      const encoded = user?.passwordHash ?? 'scrypt:' + '0'.repeat(64) + ':' + '0'.repeat(128);
      const valid = await verifyPassword(password, encoded);
      if (!user || !user.active || !valid) {
        failure(res, 401, 'INVALID_CREDENTIALS', '이메일 또는 비밀번호를 확인하세요.');
        return;
      }
      const old = req.cookies['folio_session'];
      if (typeof old === 'string') await store.deleteSession(sessionHash(old));
      const token = createSessionToken();
      const maxAge = 8 * 60 * 60 * 1000;
      await store.putSession(sessionHash(token), {
        userId: user.id,
        userVersion: user.version,
        expiresAt: Date.now() + maxAge,
      });
      res.cookie('folio_session', token, {
        httpOnly: true,
        secure: production,
        sameSite: 'strict',
        path: '/',
        maxAge,
      });
      res.json({ user: publicUser(user) });
    },
  );
  app.use('/api', async (req, res, next) => {
    const token = req.cookies['folio_session'];
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      failure(res, 401, 'AUTH_REQUIRED', '로그인이 필요합니다.');
      return;
    }
    const session = await store.getSession(sessionHash(token));
    const user =
      session && session.expiresAt > Date.now() ? await store.getUser(session.userId) : null;
    if (!session || !user?.active || user.version !== session.userVersion) {
      failure(res, 401, 'AUTH_REQUIRED', '로그인이 필요합니다.');
      return;
    }
    res.locals.user = user;
    res.locals.tokenHash = sessionHash(token);
    next();
  });
  app.get('/api/auth/me', (_req, res) => res.json({ user: publicUser(res.locals.user) }));
  app.post('/api/auth/logout', async (_req, res) => {
    await store.deleteSession(res.locals.tokenHash);
    res.clearCookie('folio_session', {
      httpOnly: true,
      secure: production,
      sameSite: 'strict',
      path: '/',
    });
    res.sendStatus(204);
  });
  app.use('/api/admin', (_req, res, next) => {
    if (res.locals.user.role !== 'admin') {
      failure(res, 403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
      return;
    }
    next();
  });
  app.get('/api/admin/users', async (_req, res) =>
    res.json({
      users: (await store.listUsers()).map((user) => ({
        ...publicUser(user),
        active: user.active,
      })),
      limit: 100,
    }),
  );
  app.post('/api/admin/users', async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!validCredentials(email, password)) {
      failure(res, 400, 'INVALID_INPUT', '유효한 이메일과 12자 이상의 비밀번호가 필요합니다.');
      return;
    }
    const normalized = normalizeEmail(email);
    if (await store.findUser(normalized)) {
      failure(res, 409, 'ACCOUNT_EXISTS', '이미 등록된 계정입니다.');
      return;
    }
    const user = await store.createUser({
      email: normalized,
      passwordHash: await hashPassword(password),
      role: 'member',
      active: true,
      version: 1,
    });
    res.status(201).json({ user: publicUser(user) });
  });
  app.post('/api/admin/users/:id/revoke', async (req, res) => {
    if (req.params.id === res.locals.user.id) {
      failure(res, 400, 'SELF_REVOKE_DENIED', '본인 계정은 여기에서 비활성화할 수 없습니다.');
      return;
    }
    if (!(await store.revokeUser(req.params.id))) {
      failure(res, 404, 'NOT_FOUND', '계정을 찾을 수 없습니다.');
      return;
    }
    res.sendStatus(204);
  });
  app.get('/api/strategy', ownerAccount, async (_req, res) =>
    res.json({ strategy: await store.getStrategy(res.locals.user.id) }),
  );
  app.put('/api/strategy', ownerAccount, async (req, res) => {
    const input = req.body?.strategy;
    if (!validStrategy(input)) {
      failure(
        res,
        400,
        'INVALID_STRATEGY',
        '전략과 자산별 비중을 확인하세요. 비중 합계는 100%여야 합니다.',
      );
      return;
    }
    const strategy: Strategy = {
      name: input.name.trim(),
      horizon: input.horizon,
      benchmark: input.benchmark,
      riskTolerance: input.riskTolerance,
      notes: input.notes,
      targetAllocations: input.targetAllocations.map((a) => ({
        asset: a.asset.trim(),
        percentage: a.percentage,
      })),
    };
    await store.putStrategy(res.locals.user.id, strategy);
    res.json({ strategy });
  });
  app.get('/api/portfolio', requireOwner, async (_req, res) => {
    res.json(await options.toss!.portfolio(res.locals.user.id));
  });
  app.get('/api/market/candles', requireOwner, async (req, res) => {
    if (
      typeof req.query.symbol !== 'string' ||
      (req.query.interval !== undefined && typeof req.query.interval !== 'string') ||
      (req.query.count !== undefined &&
        (typeof req.query.count !== 'string' || !/^\d{1,3}$/.test(req.query.count))) ||
      (req.query.before !== undefined &&
        (typeof req.query.before !== 'string' || !validBefore(req.query.before)))
    ) {
      failure(res, 400, 'INVALID_MARKET_QUERY', '잘못된 조회 조건입니다.');
      return;
    }
    res.json(
      await options.toss!.candles(
        req.query.symbol,
        req.query.interval ?? '1d',
        req.query.count === undefined ? 100 : Number(req.query.count),
        req.query.before,
      ),
    );
  });
  app.get('/api/market/prices', requireOwner, async (req, res) => {
    const symbols = parsePriceSymbols(req.query.symbols);
    if (!symbols) {
      failure(res, 400, 'INVALID_MARKET_QUERY', '종목 코드 목록을 확인하세요. 최대 50개입니다.');
      return;
    }
    res.json(await options.toss!.prices(symbols));
  });
  // Toss market-indicator daily candles (KOSPI, KOSDAQ and the KR bond yields) for the chart's
  // comparison overlay. Same shape as /api/market/candles: oldest first, decimal strings.
  app.get('/api/market/indicator-candles', requireOwner, async (req, res) => {
    const { symbol, count, before } = req.query;
    if (
      Object.keys(req.query).some((key) => !['symbol', 'count', 'before'].includes(key)) ||
      typeof symbol !== 'string' ||
      !MARKET_INDICATOR_CATALOG.some((item) => item.symbol === symbol) ||
      (count !== undefined && (typeof count !== 'string' || !/^\d{1,3}$/.test(count))) ||
      (before !== undefined && (typeof before !== 'string' || !validBefore(before)))
    ) {
      failure(res, 400, 'INVALID_MARKET_QUERY', '시장 지표 코드와 조회 조건을 확인하세요.');
      return;
    }
    const wanted = count === undefined ? 200 : Number(count);
    if (wanted < 1 || wanted > 200) {
      failure(res, 400, 'INVALID_MARKET_QUERY', '조회 개수는 1~200입니다.');
      return;
    }
    const page = await options.toss!.marketIndicatorCandlePage(symbol, {
      count: wanted,
      ...(before === undefined ? {} : { before }),
    });
    res.json({
      source: 'Toss Securities OpenAPI',
      asOf: new Date().toISOString(),
      symbol,
      interval: '1d',
      candles: [...page.candles].reverse().map((candle) => ({
        timestamp: candle.timestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      })),
      ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
    });
  });
  app.get('/api/market/indicators', requireOwner, async (_req, res) => {
    res.json(await options.toss!.marketIndicators());
  });
  app.get(
    '/api/recommendations',
    requireOwner,
    rateLimit({
      windowMs: 60000,
      limit: 3,
      keyGenerator: (_req, res) => res.locals.user.id,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
    async (req, res) => {
      const period = req.query.period ?? 'daily';
      const symbol = req.query.symbol ?? '005930';
      if (!validRecommendationQuery(period, symbol)) {
        failure(res, 400, 'INVALID_RECOMMENDATION_QUERY', '추천 기간과 종목을 확인하세요.');
        return;
      }
      const strategy = await store.getStrategy(res.locals.user.id);
      if (!strategy) {
        failure(res, 409, 'STRATEGY_REQUIRED', '추천 전에 내 계정 전략을 저장하세요.');
        return;
      }
      const rules = await createRecommendation({
        userId: res.locals.user.id,
        strategy,
        period,
        symbol: symbol as string,
        toss: options.toss!,
        calendar: calendarRepository,
      });
      res.json(options.ai ? await options.ai.enrich(rules, res.locals.user.id) : rules);
    },
  );
  // Daily snapshot status and target list: owner-only, mounted after authentication.
  app.use(
    createSnapshotRouter({
      repository: options.snapshotRepository ?? new MemorySnapshotRepository(),
      ownerUserId: options.ownerUserId,
    }),
  );
  // Event lines and algorithm fills need only the owner id (not the Toss client), so this router
  // is mounted first and answers /api/analysis/events and /api/analysis/algorithm-fills itself.
  app.use(
    createAnalysisEventsRouter({
      calendar: calendarRepository,
      fred: options.fred,
      dart: options.dart,
      sec: options.sec,
      fills: options.algorithmFills,
      ownerUserId: options.ownerUserId,
    }),
  );
  app.use(
    createAnalysisRouter({
      analysis: options.toss ? new TossAnalysis(options.toss) : undefined,
      gate: requireOwner,
    }),
  );
  // Owner-only: 503 when the owner is unknown, 403 for others; the router re-checks the owner.
  app.use('/api/fundamentals', ownerAccount);
  app.use(
    createFundamentalsRouter({
      dart: options.dart,
      sec: options.sec,
      ownerUserId: options.ownerUserId ?? '',
    }),
  );
  // Owner-only FRED / ECOS reads (series for the comparison overlay, release dates).
  app.use('/api/macro', ownerAccount);
  app.use(
    createMacroRouter({
      fred: options.fred,
      ecos: options.ecos,
      ownerUserId: options.ownerUserId ?? '',
    }),
  );
  app.use(createNewsRouter({ repository: calendarRepository, ownerUserId: options.ownerUserId }));
  app.use(
    createMorningRouter({
      repository: options.morningRepository ?? new MemoryMorningRunRepository(),
      ownerUserId: options.ownerUserId,
    }),
  );
  app.use(
    createCalendarRouter({
      repository: calendarRepository,
      ownerUserId: options.ownerUserId,
    }),
  );
  // Owner-only (after authentication and the origin check above).
  app.use('/api/notifications', ownerAccount);
  app.use(
    createNotificationsRouter({
      repository: notificationRepository,
      ownerUserId: options.ownerUserId ?? '',
    }),
  );
  app.use(
    createAlgorithmsRouter({
      repository: algorithmRepository,
      ownerUserId: options.ownerUserId,
      candles: options.toss
        ? (symbol, interval, count) => options.toss!.candles(symbol, interval, count)
        : undefined,
      notify: notifications ? (event) => notifications.notify(event) : undefined,
      liveEnabled: options.algorithmLiveEnabled,
      alertsConfigured: () => notifications?.configured() === true,
    }),
  );
  const paperRepository = options.paperRepository ?? new MemoryPaperRepository();
  app.use(
    createPaperRouter({
      repository: paperRepository,
      algorithmRepository,
      ownerUserId: options.ownerUserId,
      aiEnabled: options.algorithmAiEnabled,
    }),
  );
  app.use(
    createLiveRouter({
      repository: algorithmRepository,
      paper: options.paperRepository ?? paperRepository,
      trading: options.tradingStore ?? new MemoryTradingStore(),
      ownerUserId: options.ownerUserId,
      notify: notifications ? (event) => notifications.notify(event) : undefined,
      liveEnabled: options.algorithmLiveEnabled,
      aiEnabled: options.algorithmAiEnabled,
    }),
  );
  app.use('/api', (_req, res) => failure(res, 404, 'NOT_FOUND', '요청한 API를 찾을 수 없습니다.'));
  if (options.staticDirectory) {
    const directory = resolve(options.staticDirectory);
    app.use(express.static(directory));
    app.get('/{*splat}', (_req, res, next) =>
      res.sendFile(resolve(directory, 'index.html'), (err) => {
        if (err) next(err);
      }),
    );
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ProviderError) {
      if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      failure(res, error.status, error.code, error.message);
      return;
    }
    const status =
      error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
        ? error.status
        : 500;
    failure(
      res,
      status >= 400 && status < 500 ? status : 500,
      'REQUEST_FAILED',
      '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.',
    );
  });
  return app;
}
