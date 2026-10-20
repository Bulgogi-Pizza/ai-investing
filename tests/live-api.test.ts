import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app';
import { hashPassword } from '../src/server/auth';
import { MemoryAlgorithmRepository } from '../src/server/algorithms';
import {
  MemoryNotificationRepository,
  NotificationService,
  TelegramNotifier,
} from '../src/server/notify';
import { MemoryPaperRepository } from '../src/server/paper';
import { MemoryStore } from '../src/server/store';
import { createPaperLedger, defaultSignalParams } from '../src/lib/algo';
import { inputFromTemplate, type AlgorithmRecord } from '../src/lib/algorithmRecords';
import { HEARTBEAT_STALE_DAYS, LIVE_SCHEDULE_PAUSED_TEXT } from '../src/server/live';
import { MemoryTradingStore } from '../src/server/trading/stores';
import { seedOrder } from './support/fake-toss';

// Synthetic data only; no network.
const origin = 'https://invest.example.test';
const password = 'Test-only lengthy password';
const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-21T00:30:00.000Z');
let store: MemoryStore;
let ownerId: string;
let repository: MemoryAlgorithmRepository;
let notifications: MemoryNotificationRepository;
let trading: MemoryTradingStore;
let paper: MemoryPaperRepository;
let telegram: ReturnType<typeof vi.fn> & typeof fetch;

const record = (over: Partial<AlgorithmRecord> = {}): AlgorithmRecord => ({
  ...inputFromTemplate('momentum', 'KR'),
  name: '실전 후보',
  targets: ['005930'],
  signals: [{ id: 'momentum', weight: 1 }],
  mode: 'paper',
  budget: 10_000_000,
  id: ID,
  currency: 'KRW',
  params: structuredClone(defaultSignalParams),
  targetsChangedAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  version: 1,
  ...over,
});
const putAlgorithm = (r: AlgorithmRecord) =>
  repository.mutate(r.id, () => ({
    write: r,
    event: { id: `e-${r.id}`, at: '2026-10-01T00:00:00.000Z', kind: 'created', changes: [] },
  }));

function appWith(options: { owner?: boolean; notifier?: boolean; liveEnabled?: boolean } = {}) {
  const service = new NotificationService({
    repository: notifications,
    notifier:
      options.notifier === false
        ? undefined
        : new TelegramNotifier({
            botToken: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
            chatId: '987654321',
            transport: telegram,
          }),
    appOrigin: origin,
  });
  return createApp({
    store,
    origin,
    ownerUserId: options.owner === false ? undefined : ownerId,
    algorithmRepository: repository,
    paperRepository: paper,
    tradingStore: trading,
    notificationRepository: notifications,
    notifications: service,
    algorithmLiveEnabled: options.liveEnabled,
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
const get = (app: ReturnType<typeof createApp>, cookie: string, id = ID) =>
  request(app).get(`/api/algorithms/${id}/live`).set('Cookie', cookie);
const release = (app: ReturnType<typeof createApp>, cookie: string, id = ID) =>
  request(app)
    .post(`/api/algorithms/${id}/live/release-stop`)
    .set('Origin', origin)
    .set('Cookie', cookie)
    .send({});

beforeEach(async () => {
  store = new MemoryStore();
  repository = new MemoryAlgorithmRepository();
  notifications = new MemoryNotificationRepository();
  trading = new MemoryTradingStore(() => NOW);
  paper = new MemoryPaperRepository();
  telegram = vi.fn(
    async () => new Response(JSON.stringify({ ok: true, result: {} })),
  ) as unknown as typeof telegram;
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
    email: 'other@example.test',
    passwordHash,
    role: 'member',
    active: true,
    version: 1,
  });
  await putAlgorithm(record());
});

describe('GET /api/algorithms/:id/live', () => {
  it('shows what stands between a paper algorithm and live, and the schedule notice when nothing ran yet', async () => {
    const app = appWith();
    const body = (await get(app, await login(app))).body;
    expect(body).toMatchObject({
      live: true,
      algorithm: { id: ID, mode: 'paper', market: 'KR', currency: 'KRW', budget: 10_000_000 },
      enable: { ready: true, blockers: [] },
      paperSummary: null,
      emergencyStop: false,
      stop: null,
      accessCheck: null,
      job: {
        market: 'KR',
        lastRun: null,
        schedulePaused: true,
        scheduleNotice: LIVE_SCHEDULE_PAUSED_TEXT,
      },
      ledger: { positions: [], committed: 0 },
      unconfirmedCount: 0,
      orders: [],
      blocked: [],
    });
    expect(LIVE_SCHEDULE_PAUSED_TEXT).toBe(
      '실전 일정이 아직 꺼져 있어 주문이 나가지 않습니다 — 운영자가 일정을 켜야 합니다.',
    );
    expect(body.notes.join(' ')).toContain('기록 부족으로 주문 보류');
  });

  it('lists every blocker: no budget, a value signal, an overlapping live algorithm, live switched off', async () => {
    await putAlgorithm(
      record({
        budget: null,
        signals: [
          { id: 'momentum', weight: 0.5 },
          { id: 'value', weight: 0.5 },
        ],
      }),
    );
    await putAlgorithm(record({ id: ID2, name: '다른 실전', mode: 'live', targets: ['005930'] }));
    const app = appWith({ liveEnabled: false });
    const body = (await get(app, await login(app))).body;
    expect(body.enable.ready).toBe(false);
    expect(body.enable.blockers.map((b: { code: string }) => b.code).sort()).toEqual([
      'LIVE_BUDGET_REQUIRED',
      'LIVE_NOT_AVAILABLE',
      'LIVE_TARGET_OVERLAP',
      'LIVE_VALUE_SIGNAL_UNSUPPORTED',
    ]);
  });

  it('summarizes the paper record: period, virtual round trips, net return after costs, drawdown', async () => {
    const ledger = createPaperLedger({
      algorithmId: ID,
      market: 'KR',
      budget: 10_000_000,
      startedOn: '2026-10-01',
      now: '2026-10-01T00:00:00.000Z',
    });
    ledger.equityCurve = [
      { date: '2026-10-02', equity: 10_100_000, cash: 10_100_000, positionValue: 0 },
      { date: '2026-10-03', equity: 9_900_000, cash: 9_900_000, positionValue: 0 },
    ];
    ledger.totals.roundTrips = 3;
    ledger.totals.fills = 6;
    ledger.lastRunDate = '2026-10-20';
    await paper.commitDay(ledger, []);
    const app = appWith();
    const { paperSummary } = (await get(app, await login(app))).body;
    expect(paperSummary).toMatchObject({
      since: '2026-10-01',
      lastRunDate: '2026-10-20',
      days: 2,
      roundTrips: 3,
      fills: 6,
      status: 'running',
    });
    expect(paperSummary.netReturn).toBeCloseTo(-0.01, 6);
    expect(paperSummary.maxDrawdown).toBeGreaterThan(0);
  });

  it('reports the access check: all ok, partly failed, never any provider text', async () => {
    await trading.putAccessCheck({
      checkedAt: '2026-10-21T00:00:00.000Z',
      allOk: false,
      permissionDenied: true,
      probes: {
        buyingPowerKrw: { ok: true },
        buyingPowerUsd: { ok: false, code: 'forbidden', status: 403 },
        commissions: { ok: true },
        openOrders: { ok: true },
      },
    });
    const app = appWith();
    const body = (await get(app, await login(app))).body;
    expect(body.accessCheck).toMatchObject({ allOk: false, permissionDenied: true });
    expect(body.accessCheck.probes.buyingPowerUsd).toEqual({
      ok: false,
      code: 'forbidden',
      status: 403,
    });
  });

  it('the schedule notice disappears once the live job ran recently, and returns when it is stale', async () => {
    const app = appWith();
    const cookie = await login(app);
    await trading.putJobHeartbeat({
      market: 'KR',
      at: new Date().toISOString(),
      date: '2026-10-21',
      outcome: 'ok',
    });
    let body = (await get(app, cookie)).body;
    expect(body.job).toMatchObject({ schedulePaused: false, scheduleNotice: null });
    expect(body.job.lastRun).toMatchObject({ outcome: 'ok' });
    await trading.putJobHeartbeat({
      market: 'KR',
      at: new Date(Date.now() - (HEARTBEAT_STALE_DAYS + 1) * 86_400_000).toISOString(),
      date: null,
      outcome: 'ok',
    });
    body = (await get(app, cookie)).body;
    expect(body.job.schedulePaused).toBe(true);
    // The other market's heartbeat does not count.
    await trading.putJobHeartbeat({
      market: 'US',
      at: new Date().toISOString(),
      date: null,
      outcome: 'ok',
    });
    expect((await get(app, cookie)).body.job.schedulePaused).toBe(true);
  });

  it('shows live orders with 실제 data only: fills, statuses, sanitized errors, blocked reasons, positions', async () => {
    await putAlgorithm(record({ mode: 'live' }));
    await seedOrder(
      trading,
      {
        clientOrderId: 'ai-1',
        algorithmId: ID,
        quantity: 10,
        filledQuantity: 10,
        averageFilledPrice: 69_900,
        createdAt: '2026-10-10T01:00:00.000Z',
      },
      'filled',
    );
    await seedOrder(
      trading,
      {
        clientOrderId: 'ai-2',
        algorithmId: ID,
        symbol: '000660',
        createdAt: '2026-10-11T01:00:00.000Z',
      },
      'unknown',
    );
    await trading.updateOrder('ai-2', {
      error: { kind: 'network', status: null, code: 'network-error' },
    });
    await seedOrder(
      trading,
      {
        clientOrderId: 'ai-3',
        algorithmId: ID,
        symbol: '035720',
        createdAt: '2026-10-12T01:00:00.000Z',
      },
      'rejected',
    );
    await trading.updateOrder('ai-3', {
      error: {
        kind: 'http',
        status: 403,
        code: 'forbidden',
        // @ts-expect-error provider text must never be shown even if a record carried it
        message: 'provider text with Bearer token',
      },
    });
    await trading.recordBlocked({
      id: 'b1',
      algorithmId: ID,
      runId: 'run-1',
      market: 'KR',
      symbol: '005930',
      side: 'buy',
      quantity: 1,
      price: '70000',
      tranche: 0,
      reasons: ['HISTORY_INSUFFICIENT', 'NOT_A_REASON' as never],
      dateKey: '2026-10-21',
      createdAt: '2026-10-21T00:05:00.000Z',
    });
    const app = appWith();
    const body = (await get(app, await login(app))).body;
    expect(body.algorithm.mode).toBe('live');
    expect(body.orders.map((o: { id: string }) => o.id)).toEqual(['ai-3', 'ai-2', 'ai-1']);
    expect(body.orders[2]).toMatchObject({
      symbol: '005930',
      side: 'buy',
      quantity: 10,
      filledQuantity: 10,
      averageFilledPrice: 69_900,
      status: 'filled',
      error: null,
    });
    expect(body.orders[1]).toMatchObject({
      status: 'unknown',
      error: { code: 'network-error' },
    });
    expect(body.orders[0].error).toMatchObject({ code: 'forbidden' });
    expect(JSON.stringify(body)).not.toMatch(/Bearer|provider text/);
    expect(body.unconfirmedCount).toBe(1);
    expect(body.ledger.positions).toEqual([
      expect.objectContaining({ symbol: '005930', quantity: 10, averageCost: 69_900 }),
    ]);
    expect(body.blocked).toEqual([
      expect.objectContaining({
        symbol: '005930',
        reasons: [{ code: 'HISTORY_INSUFFICIENT', message: '기록 부족으로 주문 보류' }],
      }),
    ]);
    // Nothing that identifies the account or the broker order ever appears.
    expect(JSON.stringify(body)).not.toMatch(/orderId|seed-ai|accountSeq|wireClientOrderId/);
  });

  it('shows an automatic stop with its reason, and the emergency stop', async () => {
    await trading.stopAlgorithm(ID, 'first-order-rejected');
    await repository.setControl(true, NOW.toISOString(), {
      id: 'e1',
      at: NOW.toISOString(),
      kind: 'emergency-stop',
      changes: [],
    });
    const app = appWith();
    const body = (await get(app, await login(app))).body;
    expect(body.emergencyStop).toBe(true);
    expect(body.stop).toMatchObject({
      reason: 'first-order-rejected',
      message: '첫 실전 주문이 증권사에 거부되어 자동 정지되었습니다.',
    });
  });

  it('is owner only and answers 404 for an unknown algorithm', async () => {
    const app = appWith();
    const owner = await login(app);
    expect((await get(app, owner, 'not-an-id')).status).toBe(404);
    expect((await get(app, owner, ID2)).status).toBe(404);
    expect((await get(app, await login(app, 'other@example.test'))).status).toBe(403);
    expect((await request(app).get(`/api/algorithms/${ID}/live`)).status).toBe(401);
    const unknownOwner = appWith({ owner: false });
    expect((await get(unknownOwner, await login(unknownOwner))).status).toBe(503);
  });

  it('answers 503 without details when the store fails', async () => {
    vi.spyOn(trading, 'getAccessCheck').mockRejectedValue(new Error('secret failure detail'));
    const app = appWith();
    const response = await get(app, await login(app));
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain('secret failure detail');
  });
});

describe('POST /api/algorithms/:id/live/release-stop', () => {
  it('releases an automatic stop, records it in the history and announces it on Telegram', async () => {
    await trading.stopAlgorithm(ID, 'loss-limit');
    const app = appWith();
    const cookie = await login(app);
    const response = await release(app, cookie);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ released: true, notification: { status: 'sent' } });
    expect(await trading.isAlgorithmStopped(ID)).toBe(false);
    const text = JSON.parse(telegram.mock.calls[0][1].body as string).text as string;
    expect(text).toContain('알고리즘 자동 정지 해제');
    expect(text).toContain('실전 후보');
    expect(text).toContain('긴급 정지를 누르세요');
    const events = await request(app).get('/api/algorithm-events').set('Cookie', cookie);
    expect(events.body.events[0]).toMatchObject({
      kind: 'live-stop-released',
      algorithmId: ID,
      changes: [{ field: 'liveStop' }],
    });
    // Nothing left to release.
    const again = await release(app, cookie);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('NOT_STOPPED');
    expect(telegram).toHaveBeenCalledTimes(1);
  });
  it('a failing or missing Telegram never blocks the release and is reported exactly', async () => {
    await trading.stopAlgorithm(ID, 'order-permission');
    telegram.mockRejectedValue(new Error('network down'));
    let app = appWith();
    let response = await release(app, await login(app));
    expect(response.status).toBe(200);
    expect(response.body.notification).toMatchObject({ status: 'failed' });
    expect(await trading.isAlgorithmStopped(ID)).toBe(false);
    await trading.stopAlgorithm(ID, 'order-permission');
    app = appWith({ notifier: false });
    response = await release(app, await login(app));
    expect(response.body.notification).toEqual({
      status: 'disabled',
      failureCode: 'NOT_CONFIGURED',
    });
  });
  it('is owner only, validates the id and does not touch other algorithms', async () => {
    await trading.stopAlgorithm(ID, 'loss-limit');
    await putAlgorithm(record({ id: ID2, name: '다른 알고리즘', targets: ['000660'] }));
    await trading.stopAlgorithm(ID2, 'loss-limit');
    const app = appWith();
    const owner = await login(app);
    expect((await release(app, await login(app, 'other@example.test'))).status).toBe(403);
    expect((await release(app, owner, 'not-an-id')).status).toBe(404);
    expect((await release(app, owner)).status).toBe(200);
    expect(await trading.isAlgorithmStopped(ID2)).toBe(true);
    // A write needs the app origin like every other write.
    const noOrigin = await request(app)
      .post(`/api/algorithms/${ID2}/live/release-stop`)
      .set('Cookie', owner)
      .send({});
    expect(noOrigin.status).toBe(403);
    expect(await trading.isAlgorithmStopped(ID2)).toBe(true);
  });
});
