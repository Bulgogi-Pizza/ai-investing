import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app';
import { hashPassword } from '../src/server/auth';
import { MemoryAlgorithmRepository, backtestLimits } from '../src/server/algorithms';
import {
  MemoryNotificationRepository,
  NotificationService,
  TelegramNotifier,
} from '../src/server/notify';
import { MemoryStore } from '../src/server/store';
import { MemoryTokenCache, TossClient } from '../src/server/toss';
import { inputFromTemplate, maxAlgorithms } from '../src/lib/algorithmRecords';

// Synthetic data only; no network. Candles come from a fake Toss transport.
const origin = 'https://invest.example.test';
const password = 'Test-only lengthy password';
const telegramToken = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
let store: MemoryStore;
let ownerId: string;
let repository: MemoryAlgorithmRepository;
let notificationRepository: MemoryNotificationRepository;
let telegram: ReturnType<typeof vi.fn> & typeof fetch;
let candleCalls: string[];
let candleHandler: (url: string) => Response | Promise<Response | undefined> | undefined;

function weekdays(count: number, endDate = '2026-10-16') {
  const dates: string[] = [];
  const d = new Date(`${endDate}T00:00:00Z`);
  while (dates.length < count) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return dates; // newest first, like the provider
}
export function candleBody(count: number, seed = 1, currency = 'KRW', extra: string[] = []) {
  const dates = [...extra, ...weekdays(count)];
  const n = dates.length;
  return {
    result: {
      candles: dates.map((date, index) => {
        const i = n - 1 - index; // chronological position
        const close = 50_000 + i * 60 + Math.sin(i / (5 + seed)) * 2500 * seed;
        return {
          timestamp: `${date}T00:00:00+09:00`,
          openPrice: String(close - 20),
          highPrice: String(close + 300),
          lowPrice: String(close - 300),
          closePrice: String(close),
          volume: '500000',
          currency,
        };
      }),
      nextBefore: null,
    },
  };
}
function transport() {
  return vi.fn(async (url: string | URL | Request) => {
    const path = String(url).replace('https://openapi.tossinvest.com', '');
    if (path === '/oauth2/token')
      return Response.json({ access_token: 'fixture', token_type: 'Bearer', expires_in: 86400 });
    if (path.startsWith('/api/v1/candles')) {
      candleCalls.push(path);
      const custom = await candleHandler(path);
      if (custom) return custom;
      const symbol = new URL(`http://x${path}`).searchParams.get('symbol') ?? '';
      return Response.json(candleBody(200, 1 + (symbol.length % 3)));
    }
    if (path.includes('order')) throw new Error('orders must never be called');
    return new Response('unexpected', { status: 500 });
  }) as unknown as typeof fetch;
}
function appWith(
  options: { toss?: boolean; owner?: boolean; live?: boolean; notifier?: boolean } = {},
) {
  const toss =
    options.toss === false
      ? undefined
      : new TossClient(
          { clientId: 'c', clientSecret: 's', accountSeq: '1', ownerUserId: ownerId },
          new MemoryTokenCache(),
          transport(),
        );
  const notifications = new NotificationService({
    repository: notificationRepository,
    notifier:
      options.notifier === false
        ? undefined
        : new TelegramNotifier({
            botToken: telegramToken,
            chatId: '987654321',
            transport: telegram,
          }),
    appOrigin: origin,
  });
  return createApp({
    store,
    origin,
    toss,
    ownerUserId: options.owner === false ? undefined : ownerId,
    algorithmRepository: repository,
    algorithmLiveEnabled: options.live,
    notificationRepository,
    notifications,
  });
}
async function login(app: ReturnType<typeof createApp>, email = 'owner@example.test') {
  const response = await request(app)
    .post('/api/auth/login')
    .set('Origin', origin)
    .send({ email, password });
  expect(response.status).toBe(200);
  return response.headers['set-cookie'][0].split(';')[0] as string;
}
const write = (
  app: ReturnType<typeof createApp>,
  method: 'post' | 'put' | 'delete',
  path: string,
  cookie: string,
  body?: unknown,
) =>
  request(app)
    [method](path)
    .set('Origin', origin)
    .set('Cookie', cookie)
    .send(body as object);
const algo = (patch: Record<string, unknown> = {}) => ({
  ...inputFromTemplate('momentum', 'KR'),
  name: '모멘텀 A',
  targets: ['005930', '000660'],
  ...patch,
});
async function create(
  app: ReturnType<typeof createApp>,
  cookie: string,
  patch: Record<string, unknown> = {},
) {
  const response = await write(app, 'post', '/api/algorithms', cookie, { algorithm: algo(patch) });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.algorithm as { id: string; version: number; [k: string]: unknown };
}

beforeEach(async () => {
  store = new MemoryStore();
  repository = new MemoryAlgorithmRepository();
  notificationRepository = new MemoryNotificationRepository();
  telegram = vi.fn(
    async () => new Response(JSON.stringify({ ok: true, result: {} })),
  ) as unknown as typeof telegram;
  candleCalls = [];
  candleHandler = () => undefined;
  const passwordHash = await hashPassword(password);
  ownerId = (
    await store.createUser({
      email: 'owner@example.test',
      passwordHash,
      role: 'member',
      active: true,
      version: 1,
    })
  ).id;
  await store.createUser({
    email: 'member@example.test',
    passwordHash,
    role: 'member',
    active: true,
    version: 1,
  });
});

const privatePaths: [string, string][] = [
  ['get', '/api/algorithms'],
  ['post', '/api/algorithms'],
  ['get', '/api/algorithms/00000000-0000-4000-8000-000000000000'],
  ['put', '/api/algorithms/00000000-0000-4000-8000-000000000000'],
  ['delete', '/api/algorithms/00000000-0000-4000-8000-000000000000'],
  ['post', '/api/algorithms/00000000-0000-4000-8000-000000000000/backtest'],
  ['get', '/api/algorithm-events'],
  ['get', '/api/algorithm-control'],
  ['put', '/api/algorithm-control'],
  ['get', '/api/algorithm-settings'],
  ['put', '/api/algorithm-settings'],
  ['get', '/api/notifications'],
];

describe('access control', () => {
  it('rejects anonymous requests and cross-site writes', async () => {
    const app = appWith();
    for (const [method, path] of privatePaths) {
      const response = await request(app)[method as 'get'](path).set('Origin', origin);
      expect(response.status, `${method} ${path}`).toBe(401);
    }
    const cookie = await login(app);
    const crossSite = await request(app)
      .put('/api/algorithm-control')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .send({ emergencyStop: true });
    expect(crossSite.status).toBe(403);
    expect(crossSite.body.error.code).toBe('ORIGIN_DENIED');
    expect((await repository.getControl()).emergencyStop).toBe(false);
  });
  it('rejects a signed-in non-owner with 403 OWNER_REQUIRED and changes nothing', async () => {
    const app = appWith();
    const cookie = await login(app, 'member@example.test');
    for (const [method, path] of privatePaths) {
      const response = await write(app, method as 'post', path, cookie, {});
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(response.body.error.code).toBe('OWNER_REQUIRED');
    }
    expect(await repository.list()).toEqual([]);
    expect(await repository.listEvents(10)).toEqual([]);
  });
  it('fails closed when no owner id is configured', async () => {
    const app = appWith({ owner: false });
    const cookie = await login(app);
    for (const [method, path] of privatePaths) {
      const response = await write(app, method as 'post', path, cookie, {});
      expect(response.status, `${method} ${path}`).toBe(503);
    }
  });
});

describe('algorithm CRUD, validation and history', () => {
  it('creates, reads, updates with a version check and deletes; every change is recorded', async () => {
    const app = appWith();
    const cookie = await login(app);
    const created = await create(app, cookie, { budget: 5_000_000 });
    expect(created).toMatchObject({ version: 1, currency: 'KRW', mode: 'simulation' });
    expect(created.params).toBeDefined();
    const list = await request(app).get('/api/algorithms').set('Cookie', cookie);
    expect(list.body).toMatchObject({ limits: { maxAlgorithms }, liveAvailable: true });
    expect(list.body.algorithms).toHaveLength(1);

    const updated = await write(app, 'put', `/api/algorithms/${created.id}`, cookie, {
      version: 1,
      algorithm: algo({ budget: 5_000_000, targets: ['005930', '035420'], mode: 'paper' }),
    });
    expect(updated.status).toBe(200);
    expect(updated.body.algorithm).toMatchObject({ version: 2, mode: 'paper' });
    expect(updated.body.algorithm.targetsChangedAt).not.toBe(created.targetsChangedAt);
    expect(updated.body.notification).toBeUndefined();

    const stale = await write(app, 'put', `/api/algorithms/${created.id}`, cookie, {
      version: 1,
      algorithm: algo(),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const noVersion = await write(app, 'put', `/api/algorithms/${created.id}`, cookie, {
      algorithm: algo(),
    });
    expect(noVersion.status).toBe(400);
    const marketChange = await write(app, 'put', `/api/algorithms/${created.id}`, cookie, {
      version: 2,
      algorithm: algo({ market: 'US' }),
    });
    expect(marketChange.status).toBe(400);

    const events = await request(app).get('/api/algorithm-events').set('Cookie', cookie);
    expect(events.body.events.map((e: { kind: string }) => e.kind)).toEqual(['updated', 'created']);
    expect(
      events.body.events[0].changes.find((c: { field: string }) => c.field === 'targets'),
    ).toMatchObject({
      added: ['035420'],
      removed: ['000660'],
    });
    expect(JSON.stringify(events.body)).not.toMatch(/owner@example|passwordHash/);

    expect((await write(app, 'delete', `/api/algorithms/${created.id}`, cookie)).status).toBe(204);
    expect(
      (await request(app).get(`/api/algorithms/${created.id}`).set('Cookie', cookie)).status,
    ).toBe(404);
    const after = await request(app).get('/api/algorithm-events').set('Cookie', cookie);
    expect(after.body.events[0]).toMatchObject({ kind: 'deleted', algorithmName: '모멘텀 A' });
    expect(after.body.events).toHaveLength(3);
  });
  it('validates input on the server', async () => {
    const app = appWith();
    const cookie = await login(app);
    const bad: Record<string, unknown>[] = [
      { name: '' },
      { targets: ['../x'] },
      { market: 'US', currency: 'KRW' },
      { signals: [{ id: 'trend', weight: -1 }] },
      { buyThreshold: 5 },
      { budget: -5 },
    ];
    for (const patch of bad) {
      const response = await write(app, 'post', '/api/algorithms', cookie, {
        algorithm: algo(patch),
      });
      expect(response.status, JSON.stringify(patch)).toBe(400);
      expect(response.body.error.code).toBe('INVALID_ALGORITHM');
    }
    expect((await write(app, 'post', '/api/algorithms', cookie, {})).status).toBe(400);
    expect(await repository.list()).toEqual([]);
    const tooMany = await write(app, 'post', '/api/algorithms', cookie, {
      algorithm: algo({ targets: Array.from({ length: 31 }, (_, i) => `S${i}`) }),
    });
    expect(tooMany.status).toBe(400);
    expect((await request(app).get('/api/algorithms/not-an-id').set('Cookie', cookie)).status).toBe(
      404,
    );
  });
  it('rejects duplicate names and enforces the algorithm limit', async () => {
    const app = appWith();
    const cookie = await login(app);
    await create(app, cookie);
    const duplicate = await write(app, 'post', '/api/algorithms', cookie, {
      algorithm: algo({ name: '모멘텀 a' }),
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('ALGORITHM_NAME_EXISTS');
    for (let i = 1; i < maxAlgorithms; i++) await create(app, cookie, { name: `알고리즘 ${i}` });
    const over = await write(app, 'post', '/api/algorithms', cookie, {
      algorithm: algo({ name: '하나 더' }),
    });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('ALGORITHM_LIMIT');
  });
});

describe('live switch (stage 7f)', () => {
  const putLive = (
    app: ReturnType<typeof createApp>,
    cookie: string,
    created: { id: string; version: number },
    patch: Record<string, unknown> = {},
    extra: Record<string, unknown> = { liveConfirm: true },
  ) =>
    write(app, 'put', `/api/algorithms/${created.id}`, cookie, {
      version: created.version,
      algorithm: algo({ mode: 'live', budget: 1_000_000, ...patch }),
      ...extra,
    });
  const sentTexts = () =>
    telegram.mock.calls.map((c) => JSON.parse(c[1].body as string).text as string);

  it('a deployment can still switch live off: 403 LIVE_NOT_AVAILABLE and nothing is stored', async () => {
    const app = appWith({ live: false });
    const cookie = await login(app);
    const response = await write(app, 'post', '/api/algorithms', cookie, {
      algorithm: algo({ mode: 'live', budget: 1_000_000 }),
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('LIVE_NOT_AVAILABLE');
    expect(await repository.list()).toEqual([]);
    const created = await create(app, cookie, { mode: 'paper' });
    const upgrade = await putLive(app, cookie, created);
    expect(upgrade.status).toBe(403);
    expect((await repository.get(created.id))?.mode).toBe('paper');
    expect(await notificationRepository.listRecent(10)).toEqual([]);
    expect(
      (await request(app).get('/api/algorithms').set('Cookie', cookie)).body.liveAvailable,
    ).toBe(false);
  });
  it('the gate is gone by default and an algorithm cannot be created directly in live mode', async () => {
    const app = appWith();
    const cookie = await login(app);
    expect(
      (await request(app).get('/api/algorithms').set('Cookie', cookie)).body.liveAvailable,
    ).toBe(true);
    const response = await write(app, 'post', '/api/algorithms', cookie, {
      algorithm: algo({ mode: 'live', budget: 1_000_000 }),
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('LIVE_REQUIRES_EXISTING');
    expect(await repository.list()).toEqual([]);
  });
  it('turning live on needs the explicit confirmation flag, a budget and no value signal', async () => {
    const app = appWith();
    const cookie = await login(app);
    const created = await create(app, cookie, { mode: 'paper' });
    const noConfirm = await putLive(app, cookie, created, {}, {});
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.error.code).toBe('LIVE_CONFIRM_REQUIRED');
    const falsy = await putLive(app, cookie, created, {}, { liveConfirm: 'true' });
    expect(falsy.body.error.code).toBe('LIVE_CONFIRM_REQUIRED');
    const noBudget = await putLive(app, cookie, created, { budget: null });
    expect(noBudget.status).toBe(400);
    expect(noBudget.body.error.code).toBe('LIVE_BUDGET_REQUIRED');
    const value = await putLive(app, cookie, created, {
      signals: [
        { id: 'momentum', weight: 0.5 },
        { id: 'value', weight: 0.5 },
      ],
    });
    expect(value.status).toBe(400);
    expect(value.body.error.code).toBe('LIVE_VALUE_SIGNAL_UNSUPPORTED');
    expect((await repository.get(created.id))?.mode).toBe('paper');
    expect(telegram).not.toHaveBeenCalled();
    // A zero-weight value signal is fine.
    const ok = await putLive(app, cookie, created, {
      signals: [
        { id: 'momentum', weight: 1 },
        { id: 'value', weight: 0 },
      ],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.algorithm.mode).toBe('live');
  });
  it('announces live-enabled on Telegram once, never with an amount, and records the change', async () => {
    const app = appWith();
    const cookie = await login(app);
    const created = await create(app, cookie, { mode: 'paper', budget: 1_000_000 });
    const response = await putLive(app, cookie, created, { budget: 1_000_000 });
    expect(response.status).toBe(200);
    expect(response.body.notification).toEqual({ status: 'sent' });
    expect(response.body.notifications).toEqual([{ change: 'live-enabled', status: 'sent' }]);
    expect(telegram).toHaveBeenCalledTimes(1);
    const [text] = sentTexts();
    expect(text).toContain('실전 매매 켜기');
    expect(text).toContain('모멘텀 A');
    expect(text).not.toMatch(/1000000|1,000,000/);
    const events = await request(app).get('/api/algorithm-events').set('Cookie', cookie);
    expect(events.body.events[0]).toMatchObject({
      kind: 'updated',
      changes: [{ field: 'mode', from: 'paper', to: 'live' }],
    });
    // Saving the live algorithm again (no mode change, same budget) announces nothing more.
    const again = await write(app, 'put', `/api/algorithms/${created.id}`, cookie, {
      version: 2,
      algorithm: algo({ mode: 'live', budget: 1_000_000, name: '모멘텀 A2' }),
    });
    expect(again.status).toBe(200);
    expect(again.body.notification).toBeUndefined();
    expect(telegram).toHaveBeenCalledTimes(1);
  });
  it('enabling live and raising the budget in one save announces both', async () => {
    const app = appWith();
    const cookie = await login(app);
    const created = await create(app, cookie, { mode: 'paper', budget: 500_000 });
    const response = await putLive(app, cookie, created, { budget: 2_000_000 });
    expect(response.body.notifications.map((n: { change: string }) => n.change)).toEqual([
      'live-enabled',
      'budget-raised',
    ]);
    expect(telegram).toHaveBeenCalledTimes(2);
  });
  it('a live algorithm keeps its budget and cannot be deleted; going back to paper is allowed without confirmation', async () => {
    const app = appWith();
    const cookie = await login(app);
    const created = await create(app, cookie, { mode: 'paper' });
    expect((await putLive(app, cookie, created)).status).toBe(200);
    const clear = await write(app, 'put', `/api/algorithms/${created.id}`, cookie, {
      version: 2,
      algorithm: algo({ mode: 'live', budget: null }),
    });
    expect(clear.status).toBe(400);
    expect(clear.body.error.code).toBe('LIVE_BUDGET_REQUIRED');
    const del = await write(app, 'delete', `/api/algorithms/${created.id}`, cookie);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('LIVE_ACTIVE');
    expect(await repository.get(created.id)).not.toBeNull();
    const calls = telegram.mock.calls.length;
    const back = await write(app, 'put', `/api/algorithms/${created.id}`, cookie, {
      version: 2,
      algorithm: algo({ mode: 'paper', budget: 1_000_000 }),
    });
    expect(back.status).toBe(200);
    expect(back.body.algorithm.mode).toBe('paper');
    expect(telegram.mock.calls.length).toBe(calls); // a risk reduction is not announced
    expect((await write(app, 'delete', `/api/algorithms/${created.id}`, cookie)).status).toBe(204);
  });
  it('a failing or missing Telegram never blocks turning live on, and the screen is told', async () => {
    telegram.mockRejectedValue(new Error('network down'));
    let app = appWith();
    let cookie = await login(app);
    let created = await create(app, cookie, { mode: 'paper', name: '실패 알림' });
    let response = await putLive(app, cookie, created, { name: '실패 알림' });
    expect(response.status).toBe(200);
    expect(response.body.notifications[0]).toMatchObject({
      change: 'live-enabled',
      status: 'failed',
    });
  });
  it('without a configured Telegram notifier, turning live on and raising a budget are refused (409)', async () => {
    const app = appWith({ notifier: false });
    const cookie = await login(app);
    const created = await create(app, cookie, {
      mode: 'paper',
      name: '미설정 알림',
      budget: 500_000,
    });
    const live = await putLive(app, cookie, created, { name: '미설정 알림', budget: 500_000 });
    expect(live.status).toBe(409);
    expect(live.body.error.code).toBe('ALERTS_NOT_CONFIGURED');
    expect((await repository.get(created.id))?.mode).toBe('paper');
    const raise = await write(app, 'put', `/api/algorithms/${created.id}`, cookie, {
      version: 1,
      algorithm: algo({ name: '미설정 알림', mode: 'paper', budget: 900_000 }),
    });
    expect(raise.status).toBe(409);
    expect(raise.body.error.code).toBe('ALERTS_NOT_CONFIGURED');
    expect((await repository.get(created.id))?.budget).toBe(500_000);
    // Lowering the budget or changing something harmless is still possible without alerts.
    const lower = await write(app, 'put', `/api/algorithms/${created.id}`, cookie, {
      version: 1,
      algorithm: algo({ name: '미설정 알림', mode: 'paper', budget: 100_000 }),
    });
    expect(lower.status).toBe(200);
  });
  it("announces a change to a live algorithm's targets, thresholds, weights or sizing; other edits stay quiet", async () => {
    const app = appWith();
    const cookie = await login(app);
    const created = await create(app, cookie, { mode: 'paper' });
    expect((await putLive(app, cookie, created)).status).toBe(200);
    telegram.mockClear();
    const edit = (version: number, patch: Record<string, unknown>) =>
      write(app, 'put', `/api/algorithms/${created.id}`, cookie, {
        version,
        algorithm: algo({ mode: 'live', budget: 1_000_000, ...patch }),
      });
    const renamed = await edit(2, { name: '이름만 변경' });
    expect(renamed.body.notifications).toBeUndefined();
    expect(telegram).not.toHaveBeenCalled();
    const retargeted = await edit(3, { name: '이름만 변경', targets: ['005930', '035720'] });
    expect(retargeted.body.notifications).toEqual([
      { change: 'live-strategy-changed', status: 'sent' },
    ]);
    const thresholds = await edit(4, {
      name: '이름만 변경',
      targets: ['005930', '035720'],
      buyThreshold: 0.9,
    });
    expect(thresholds.body.notifications[0].change).toBe('live-strategy-changed');
    expect(telegram).toHaveBeenCalledTimes(2);
    const text = JSON.parse(telegram.mock.calls[0][1].body as string).text as string;
    expect(text).toContain('실전 알고리즘 전략 변경');
    expect(text).not.toMatch(/005930|035720/);
    // A paper algorithm's strategy edit is not announced, and records when the strategy changed.
    const paper = await create(app, cookie, { name: '모의만', mode: 'paper', targets: ['000660'] });
    telegram.mockClear();
    const paperEdit = await write(app, 'put', `/api/algorithms/${paper.id}`, cookie, {
      version: 1,
      algorithm: algo({ name: '모의만', mode: 'paper', targets: ['000660', '051910'] }),
    });
    expect(paperEdit.body.notifications).toBeUndefined();
    expect(paperEdit.body.algorithm.strategyChangedAt).toBeTruthy();
    expect(telegram).not.toHaveBeenCalled();
  });
  it('still enforces that live algorithms never share a target', async () => {
    const app = appWith();
    const cookie = await login(app);
    const a = await create(app, cookie, { name: '실전 A', mode: 'paper', targets: ['005930'] });
    expect((await putLive(app, cookie, a, { name: '실전 A', targets: ['005930'] })).status).toBe(
      200,
    );
    const b = await create(app, cookie, {
      name: '실전 B',
      mode: 'paper',
      targets: ['005930', 'X1'],
    });
    const overlap = await putLive(app, cookie, b, { name: '실전 B', targets: ['005930', 'X1'] });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('LIVE_TARGET_OVERLAP');
    expect(overlap.body.error.message).toContain('실전 A');
    expect(overlap.body.error.message).toContain('005930');
    // Paper algorithms may overlap with everything.
    await create(app, cookie, { name: '모의 C', mode: 'paper', targets: ['005930'] });
    expect((await repository.get(b.id))?.mode).toBe('paper');
  });
});

describe('live safeguard settings', () => {
  const putSafeguards = (
    app: ReturnType<typeof createApp>,
    cookie: string,
    patch: Record<string, unknown> = {},
  ) =>
    write(app, 'put', '/api/algorithm-settings/safeguards', cookie, {
      safeguards: {
        maxOrdersPerDay: 3,
        maxGlobalOrdersPerDay: 10,
        minHoldingTradingDays: 5,
        lossStopFraction: 0.2,
        liquidityMinAvgValue: { KRW: 1_000_000_000, USD: 5_000_000 },
        ...patch,
      },
    });
  const changes = () =>
    telegram.mock.calls.map((c) => JSON.parse(c[1].body as string).text as string);

  it('exposes the design defaults and the fixed hard limits', async () => {
    const app = appWith();
    const cookie = await login(app);
    const body = (await request(app).get('/api/algorithm-settings').set('Cookie', cookie)).body;
    expect(body.safeguards).toEqual({
      maxOrdersPerDay: 3,
      maxGlobalOrdersPerDay: 10,
      minHoldingTradingDays: 5,
      lossStopFraction: 0.2,
      liquidityMinAvgValue: { KRW: 1_000_000_000, USD: 5_000_000 },
      updatedAt: null,
    });
    expect(body.hardLimits).toEqual({ maxOrderValueKrw: 100_000_000, maxQuoteAgeSeconds: 60 });
    expect(body.safeguardsInvalid).toBe(false);
  });
  it('the hard limits cannot be edited: unknown keys are ignored and never stored', async () => {
    const app = appWith();
    const cookie = await login(app);
    const response = await putSafeguards(app, cookie, {
      maxOrderValueKrw: 999_999_999_999,
      maxQuoteAgeSeconds: 3600,
      maxOrderValue: 1,
    });
    expect(response.status).toBe(200);
    expect(response.body.changed).toBe(false);
    const stored = await repository.getSafeguards();
    expect(JSON.stringify(stored)).not.toContain('maxOrderValue');
    expect(JSON.stringify(stored)).not.toContain('maxQuoteAge');
  });
  it.each([
    ['maxOrdersPerDay', { maxOrdersPerDay: 4 }, 'max-orders-raised', '하루 최대 주문 횟수 상향'],
    [
      'maxGlobalOrdersPerDay',
      { maxGlobalOrdersPerDay: 11 },
      'max-orders-raised',
      '하루 최대 주문 횟수 상향',
    ],
    [
      'minHoldingTradingDays',
      { minHoldingTradingDays: 4 },
      'min-holding-lowered',
      '최소 보유 기간 단축',
    ],
    ['lossStopFraction', { lossStopFraction: 0.25 }, 'loss-stop-loosened', '손실 정지 기준 완화'],
    [
      'liquidity KRW',
      { liquidityMinAvgValue: { KRW: 900_000_000, USD: 5_000_000 } },
      'liquidity-lowered',
      '최소 거래대금 기준 하향',
    ],
    [
      'liquidity USD',
      { liquidityMinAvgValue: { KRW: 1_000_000_000, USD: 4_000_000 } },
      'liquidity-lowered',
      '최소 거래대금 기준 하향',
    ],
  ])(
    'raising risk via %s sends one setting-risk-increase alert',
    async (_n, patch, change, text) => {
      const app = appWith();
      const cookie = await login(app);
      const response = await putSafeguards(app, cookie, patch);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.changed).toBe(true);
      expect(response.body.notifications).toEqual([{ change, status: 'sent' }]);
      expect(changes()).toHaveLength(1);
      expect(changes()[0]).toContain(text);
      expect(changes()[0]).not.toMatch(/\d{2,}/); // no numbers: no amounts, rates or counts
      const events = await request(app).get('/api/algorithm-events').set('Cookie', cookie);
      expect(events.body.events[0].kind).toBe('safeguards-updated');
      expect(events.body.events[0].changes[0].field).toBe('safeguards');
    },
  );
  it('tightening announces nothing; several risky changes announce each kind once', async () => {
    const app = appWith();
    const cookie = await login(app);
    const tighter = await putSafeguards(app, cookie, {
      maxOrdersPerDay: 2,
      maxGlobalOrdersPerDay: 5,
      minHoldingTradingDays: 10,
      lossStopFraction: 0.1,
      liquidityMinAvgValue: { KRW: 2_000_000_000, USD: 8_000_000 },
    });
    expect(tighter.body.changed).toBe(true);
    expect(tighter.body.notifications).toEqual([]);
    expect(telegram).not.toHaveBeenCalled();
    // Back to the defaults is relative to the stored (tighter) values: that is risk-increasing.
    const back = await putSafeguards(app, cookie);
    expect(back.body.notifications.map((n: { change: string }) => n.change)).toEqual([
      'max-orders-raised',
      'min-holding-lowered',
      'loss-stop-loosened',
      'liquidity-lowered',
    ]);
    expect(telegram).toHaveBeenCalledTimes(4);
  });
  it('rejects out-of-range or malformed values and stores nothing', async () => {
    const app = appWith();
    const cookie = await login(app);
    for (const patch of [
      { maxOrdersPerDay: 0 },
      { maxOrdersPerDay: 2.5 },
      { maxGlobalOrdersPerDay: 1000 },
      { minHoldingTradingDays: -1 },
      { lossStopFraction: 0 },
      { lossStopFraction: 0.9 },
      { liquidityMinAvgValue: { KRW: 1, USD: 5_000_000 } },
      { liquidityMinAvgValue: { KRW: 1_000_000_000 } },
      { liquidityMinAvgValue: null },
    ]) {
      const response = await putSafeguards(app, cookie, patch);
      expect(response.status, JSON.stringify(patch)).toBe(400);
      expect(response.body.error.code).toBe('INVALID_SAFEGUARDS');
    }
    expect((await repository.getSafeguards()).updatedAt).toBeNull();
    expect(telegram).not.toHaveBeenCalled();
  });
  it('saving over an invalid stored document always writes (repairs), even when the values equal the defaults', async () => {
    const app = appWith();
    const cookie = await login(app);
    vi.spyOn(repository, 'getSafeguards').mockRejectedValueOnce(new Error('malformed'));
    const response = await putSafeguards(app, cookie);
    expect(response.status).toBe(200);
    expect(response.body.changed).toBe(true);
    expect(response.body.notifications).toEqual([]);
    expect((await repository.getSafeguards()).updatedAt).not.toBeNull();
    const events = await request(app).get('/api/algorithm-events').set('Cookie', cookie);
    expect(events.body.events[0].kind).toBe('safeguards-updated');
    // And a repair that RAISES risk compared with the defaults is still announced.
    vi.spyOn(repository, 'getSafeguards').mockRejectedValueOnce(new Error('malformed'));
    const risky = await putSafeguards(app, cookie, { maxOrdersPerDay: 5 });
    expect(risky.body.notifications.map((n: { change: string }) => n.change)).toEqual([
      'max-orders-raised',
    ]);
  });
  it('a non-owner cannot read or change them', async () => {
    const app = appWith({ owner: false });
    const cookie = await login(app);
    expect((await request(app).get('/api/algorithm-settings').set('Cookie', cookie)).status).toBe(
      503,
    );
    expect((await putSafeguards(app, cookie, { maxOrdersPerDay: 9 })).status).toBe(503);
  });
});

describe('emergency stop and risk-increase notifications', () => {
  it('stops immediately without any notification; releasing records and sends a Telegram alert', async () => {
    const app = appWith();
    const cookie = await login(app);
    expect(
      (await request(app).get('/api/algorithm-control').set('Cookie', cookie)).body.control,
    ).toEqual({
      emergencyStop: false,
      updatedAt: null,
    });
    const bad = await write(app, 'put', '/api/algorithm-control', cookie, { emergencyStop: 'yes' });
    expect(bad.status).toBe(400);

    const stop = await write(app, 'put', '/api/algorithm-control', cookie, { emergencyStop: true });
    expect(stop.status).toBe(200);
    expect(stop.body).toMatchObject({ changed: true, control: { emergencyStop: true } });
    expect(stop.body.notification).toBeUndefined();
    expect(telegram).not.toHaveBeenCalled();
    expect((await repository.getControl()).emergencyStop).toBe(true);
    // Idempotent: a second stop changes and announces nothing.
    const again = await write(app, 'put', '/api/algorithm-control', cookie, {
      emergencyStop: true,
    });
    expect(again.body.changed).toBe(false);

    const release = await write(app, 'put', '/api/algorithm-control', cookie, {
      emergencyStop: false,
    });
    expect(release.status).toBe(200);
    expect(release.body.control.emergencyStop).toBe(false);
    expect(release.body.notification).toEqual({ status: 'sent' });
    expect(telegram).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(telegram.mock.calls[0][1].body as string).text as string;
    expect(sent).toContain('긴급 정지 해제');
    expect(sent).toContain('긴급 정지를 누르세요');
    const recorded = await request(app).get('/api/notifications').set('Cookie', cookie);
    expect(recorded.body.notifications).toHaveLength(1);
    expect(recorded.body.notifications[0]).toMatchObject({
      kind: 'setting-risk-increase',
      status: 'sent',
    });
    // Releasing a flag that is already off announces nothing more.
    const idle = await write(app, 'put', '/api/algorithm-control', cookie, {
      emergencyStop: false,
    });
    expect(idle.body.changed).toBe(false);
    expect(telegram).toHaveBeenCalledTimes(1);
    const events = await request(app).get('/api/algorithm-events').set('Cookie', cookie);
    expect(events.body.events.map((e: { kind: string }) => e.kind)).toEqual([
      'emergency-release',
      'emergency-stop',
    ]);
  });
  it('a failing Telegram or a missing bot never blocks the release', async () => {
    telegram.mockRejectedValue(new Error('network down with token details'));
    let app = appWith();
    let cookie = await login(app);
    await write(app, 'put', '/api/algorithm-control', cookie, { emergencyStop: true });
    let release = await write(app, 'put', '/api/algorithm-control', cookie, {
      emergencyStop: false,
    });
    expect(release.status).toBe(200);
    expect(release.body.control.emergencyStop).toBe(false);
    expect(release.body.notification).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(release.body)).not.toContain('token');
    app = appWith({ notifier: false });
    cookie = await login(app);
    await write(app, 'put', '/api/algorithm-control', cookie, { emergencyStop: true });
    release = await write(app, 'put', '/api/algorithm-control', cookie, { emergencyStop: false });
    expect(release.body.notification).toEqual({
      status: 'disabled',
      failureCode: 'NOT_CONFIGURED',
    });
    const list = await request(app).get('/api/notifications').set('Cookie', cookie);
    expect(list.body.notifications.map((n: { status: string }) => n.status)).toContain('disabled');
  });
  it('raising a budget notifies; lowering or keeping it does not', async () => {
    const app = appWith();
    const cookie = await login(app);
    const created = await create(app, cookie, { budget: 1_000_000 });
    const put = (version: number, budget: number | null) =>
      write(app, 'put', `/api/algorithms/${created.id}`, cookie, {
        version,
        algorithm: algo({ budget }),
      });
    const lower = await put(1, 500_000);
    expect(lower.body.notification).toBeUndefined();
    const raise = await put(2, 2_000_000);
    expect(raise.body.notification).toEqual({ status: 'sent' });
    expect(telegram).toHaveBeenCalledTimes(1);
    const text = JSON.parse(telegram.mock.calls[0][1].body as string).text as string;
    expect(text).toContain('운용 금액 한도 상향');
    expect(text).toContain('모멘텀 A');
    expect(text).not.toMatch(/2000000|2,000,000/); // amounts never go into messages
    const same = await put(3, 2_000_000);
    expect(same.body.notification).toBeUndefined();
    expect(telegram).toHaveBeenCalledTimes(1);
  });
});

describe('cost and tax settings', () => {
  it('has no built-in rates, validates input and records the change', async () => {
    const app = appWith();
    const cookie = await login(app);
    const initial = await request(app).get('/api/algorithm-settings').set('Cookie', cookie);
    expect(initial.body.costs).toEqual({
      commissionRate: null,
      sellTaxRate: null,
      capitalGainsTax: null,
      updatedAt: null,
    });
    expect(
      (
        await write(app, 'put', '/api/algorithm-settings', cookie, {
          costs: { commissionRate: 15 },
        })
      ).status,
    ).toBe(400);
    const saved = await write(app, 'put', '/api/algorithm-settings', cookie, {
      costs: { commissionRate: 0.0002, sellTaxRate: 0.002, capitalGainsTax: null },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.costs).toMatchObject({ commissionRate: 0.0002, sellTaxRate: 0.002 });
    const events = await request(app).get('/api/algorithm-events').set('Cookie', cookie);
    expect(events.body.events[0].kind).toBe('costs-updated');
  });
});

describe('backtest', () => {
  const backtest = (app: ReturnType<typeof createApp>, cookie: string, id: string, body = {}) =>
    write(app, 'post', `/api/algorithms/${id}/backtest`, cookie, body);

  it('runs on daily candles, returns a bounded result with every label the screen needs', async () => {
    const app = appWith();
    const cookie = await login(app);
    await write(app, 'put', '/api/algorithm-settings', cookie, {
      costs: { commissionRate: 0.0002, sellTaxRate: 0.002 },
    });
    const a = await create(app, cookie, { budget: 10_000_000 });
    const response = await backtest(app, cookie, a.id);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = response.body;
    expect(body).toMatchObject({
      simulation: true,
      currency: 'KRW',
      budget: 10_000_000,
      budgetAssumed: false,
      excludedSignals: ['supply', 'news'],
      disabledSignals: [],
      data: {
        source: 'Toss Securities OpenAPI',
        interval: '1d',
        adjusted: true,
        maxBarsPerSymbol: 200,
      },
    });
    expect(body.metrics).toHaveProperty('totalReturn');
    expect(body.metrics).toHaveProperty('netReturn');
    expect(body.metrics).toHaveProperty('maxDrawdown');
    expect(body.metrics).toHaveProperty('volatility');
    expect(body.costs).toHaveProperty('commission');
    expect(body.costs).toHaveProperty('transactionTax');
    expect(body.heldBack).toHaveProperty('insufficientHistory');
    expect(body.equityCurve.length).toBeGreaterThan(10);
    expect(body.equityCurve.length).toBeLessThanOrEqual(backtestLimits.maxEquityPoints);
    expect(body.trades.length).toBeLessThanOrEqual(backtestLimits.maxTrades);
    expect(body).not.toHaveProperty('samples');
    expect(body).not.toHaveProperty('decisions');
    expect(body.warnings.join(' ')).toContain('200개');
    expect(body.warnings.join(' ')).toContain('수급·뉴스');
    expect(body.warnings.join(' ')).not.toContain('설정 필요: 매매 수수료율');
    // Provider reads use the documented request: daily, adjusted, at most 200 bars. No order calls.
    expect(candleCalls).toHaveLength(2);
    expect(candleCalls[0]).toMatch(/interval=1d.*count=200.*adjusted=true/);
    expect(candleCalls.some((p) => p.includes('order'))).toBe(false);
  });
  it('flags missing cost settings as 설정 필요 instead of using invented rates', async () => {
    const app = appWith();
    const cookie = await login(app);
    const a = await create(app, cookie, { budget: 10_000_000 });
    const response = await backtest(app, cookie, a.id);
    expect(response.status).toBe(200);
    expect(response.body.costSettings.needsSetup).toEqual(['commissionRate', 'sellTaxRate']);
    expect(response.body.warnings.join(' ')).toContain('설정 필요');
    expect(response.body.costs.total).toBe(0);
  });
  it('disables the value signal with a note, and assumes a labeled budget when none is set', async () => {
    const app = appWith();
    const cookie = await login(app);
    const a = await create(app, cookie, {
      template: 'custom',
      signals: [
        { id: 'trend', weight: 0.5 },
        { id: 'value', weight: 0.5 },
      ],
      buyThreshold: 0.3,
      sellThreshold: -0.3,
    });
    const response = await backtest(app, cookie, a.id);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.disabledSignals).toEqual(['value']);
    expect(response.body.budgetAssumed).toBe(true);
    expect(response.body.warnings.join(' ')).toContain('가치 신호');
    expect(response.body.warnings.join(' ')).toContain('시뮬레이션 기본 금액');
    const onlyValue = await create(app, cookie, {
      name: '가치만',
      template: 'custom',
      signals: [{ id: 'value', weight: 1 }],
    });
    const rejected = await backtest(app, cookie, onlyValue.id);
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('NO_HISTORICAL_SIGNAL');
  });
  it('reports insufficient history for the default 252-day dual momentum (200 bars per page)', async () => {
    const app = appWith();
    const cookie = await login(app);
    const a = await create(app, cookie, {
      ...inputFromTemplate('dualMomentum', 'KR'),
      name: '듀얼',
      targets: ['005930', '000660'],
    });
    const response = await backtest(app, cookie, a.id);
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('INSUFFICIENT_HISTORY');
    expect(response.body.error.message).toContain('lookbackDays');
    const short = await create(app, cookie, {
      ...inputFromTemplate('dualMomentum', 'KR'),
      name: '듀얼 126',
      targets: ['005930', '000660'],
      dualMomentum: { lookbackDays: 126, topN: 1, absoluteThreshold: 0, scale: 0.2 },
    });
    const ok = await backtest(app, cookie, short.id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // The expected-profit rule has no history yet in a 200-bar window: buys are held back, not hidden.
    expect(ok.body.heldBack.insufficientHistory).toBeGreaterThan(0);
    expect(ok.body.metrics.trades).toBe(0);
  });
  it('rejects unknown ids, AI algorithms, missing Toss, too many symbols and bad slippage', async () => {
    const app = appWith();
    const cookie = await login(app);
    expect((await backtest(app, cookie, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await backtest(app, cookie, 'nope')).status).toBe(404);
    const ai = await create(app, cookie, { name: 'AI형', method: 'ai', mode: 'paper' });
    const aiResult = await backtest(app, cookie, ai.id);
    expect(aiResult.status).toBe(400);
    expect(aiResult.body.error.code).toBe('BACKTEST_FORMULA_ONLY');
    const many = await create(app, cookie, {
      name: '많은 종목',
      targets: Array.from({ length: backtestLimits.maxSymbols + 1 }, (_, i) => `S${i}`),
    });
    const tooMany = await backtest(app, cookie, many.id);
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('BACKTEST_TOO_MANY_SYMBOLS');
    const plain = await create(app, cookie, { name: '보통' });
    expect((await backtest(app, cookie, plain.id, { slippageBps: 9999 })).status).toBe(400);
    expect((await backtest(app, cookie, plain.id, { slippageBps: 'x' })).status).toBe(400);
    expect(candleCalls).toEqual([]);
    const noToss = appWith({ toss: false });
    const noTossCookie = await login(noToss);
    const response = await backtest(noToss, noTossCookie, plain.id);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('TOSS_INTEGRATION_UNAVAILABLE');
  });
  it('rejects candles in the wrong currency, drops a bar still forming today and maps provider failures', async () => {
    const app = appWith();
    const cookie = await login(app);
    const a = await create(app, cookie, { budget: 1_000_000, targets: ['005930'] });
    candleHandler = () => Response.json(candleBody(200, 1, 'USD'));
    const mismatch = await backtest(appWith(), cookie, a.id);
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe('CURRENCY_MISMATCH');
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    candleHandler = () => Response.json(candleBody(150, 1, 'KRW', [today]));
    const forming = await backtest(appWith(), cookie, a.id);
    expect(forming.status, JSON.stringify(forming.body)).toBe(200);
    expect(forming.body.warnings.join(' ')).toContain('진행 중');
    expect(forming.body.data.end < today).toBe(true);
    candleHandler = () => new Response('boom', { status: 500 });
    const down = await backtest(appWith(), cookie, a.id);
    expect(down.status).toBe(503);
    expect(JSON.stringify(down.body)).not.toContain('boom');
    candleHandler = () => Response.json(candleBody(200, 1));
    const bad = { ...candleBody(200, 1) };
    bad.result.candles[5].closePrice = '-1';
    candleHandler = () => Response.json(bad);
    expect((await backtest(app, cookie, a.id)).body.error.code).toBe('CANDLE_INVALID');
  });
  it('rate limits per user (6 per minute) and caps concurrent runs', async () => {
    const app = appWith();
    const cookie = await login(app);
    const a = await create(app, cookie, { budget: 1_000_000, targets: ['005930'] });
    for (let i = 0; i < backtestLimits.perMinute; i++)
      expect((await backtest(app, cookie, a.id)).status).toBe(200);
    const limited = await backtest(app, cookie, a.id);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('BACKTEST_RATE_LIMITED');

    // Concurrency cap on a fresh app (fresh limiter): hold two runs inside the provider call.
    const fresh = appWith();
    const freshCookie = await login(fresh);
    const b = await create(fresh, freshCookie, {
      name: '동시 실행',
      budget: 1_000_000,
      targets: ['005930'],
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    candleHandler = async () => {
      await gate;
      return undefined;
    };
    const first = backtest(fresh, freshCookie, b.id).then((r) => r);
    const second = backtest(fresh, freshCookie, b.id).then((r) => r);
    await vi.waitFor(() => expect(candleCalls.length).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 50));
    const third = await backtest(fresh, freshCookie, b.id);
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('BACKTEST_BUSY');
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });
});
