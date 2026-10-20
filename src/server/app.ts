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
import { createNewsRouter } from './news.js';
import type { aiFromEnvironment } from './ai.js';
import { MemoryLoginThrottle, type LoginThrottle } from './login-throttle.js';
import { createRecommendation, validRecommendationQuery } from './recommendations.js';
import { ProviderError, type TossClient } from './toss.js';
import { MemoryStore, type Store, type Strategy, type User } from './store.js';

export type AppOptions = {
  store?: Store;
  production?: boolean;
  origin?: string;
  staticDirectory?: string;
  toss?: TossClient;
  calendarRepository?: CalendarRepository;
  loginThrottle?: LoginThrottle;
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
  app.get('/api/strategy', async (_req, res) =>
    res.json({ strategy: await store.getStrategy(res.locals.user.id) }),
  );
  app.put('/api/strategy', async (req, res) => {
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
  app.get('/api/portfolio', async (_req, res) => {
    if (!options.toss) {
      failure(
        res,
        503,
        'TOSS_INTEGRATION_UNAVAILABLE',
        '토스 API 환경변수와 소유 계정 연결 설정이 필요합니다.',
      );
      return;
    }
    res.json(await options.toss.portfolio(res.locals.user.id));
  });
  app.get('/api/market/candles', async (req, res) => {
    if (!options.toss) {
      failure(res, 503, 'TOSS_INTEGRATION_UNAVAILABLE', '토스 API 연결 설정이 필요합니다.');
      return;
    }
    if (
      typeof req.query.symbol !== 'string' ||
      (req.query.interval !== undefined && typeof req.query.interval !== 'string') ||
      (req.query.count !== undefined &&
        (typeof req.query.count !== 'string' || !/^\d{1,3}$/.test(req.query.count)))
    ) {
      failure(res, 400, 'INVALID_MARKET_QUERY', '잘못된 조회 조건입니다.');
      return;
    }
    res.json(
      await options.toss.candles(
        req.query.symbol,
        req.query.interval ?? '1d',
        req.query.count === undefined ? 100 : Number(req.query.count),
      ),
    );
  });
  app.get(
    '/api/recommendations',
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
      if (!options.toss) {
        failure(res, 503, 'TOSS_INTEGRATION_UNAVAILABLE', '토스 API 연결 설정이 필요합니다.');
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
        toss: options.toss,
        calendar: calendarRepository,
      });
      res.json(options.ai ? await options.ai.enrich(rules, res.locals.user.id) : rules);
    },
  );
  app.use(createNewsRouter({ repository: calendarRepository }));
  app.use(
    createCalendarRouter({
      repository: calendarRepository,
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
