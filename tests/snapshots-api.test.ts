import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { hashPassword } from '../src/server/auth';
import {
  MemorySnapshotRepository,
  createSnapshotRouter,
  parseTargets,
  publicRun,
  type SnapshotRun,
} from '../src/server/snapshots';
import { MemoryStore } from '../src/server/store';

const origin = 'http://localhost:5173';
const password = 'Test-only lengthy password';
let store: MemoryStore;
let repository: MemorySnapshotRepository;
let ownerId: string;

const run = (market: 'KR' | 'US', date: string, extra: Partial<SnapshotRun> = {}): SnapshotRun => ({
  id: `${market}_${date}`,
  market,
  date,
  status: 'complete',
  trigger: 'scheduler',
  attempts: 1,
  startedAt: `${date}T07:30:00.000Z`,
  finishedAt: `${date}T07:31:00.000Z`,
  sessionClose: `${date}T06:30:00.000Z`,
  skipCode: null,
  targets: { holdings: 1, list: 0, total: 1 },
  counts: { symbols: 1, documentsWritten: 5 },
  steps: {
    candles: {
      status: 'OK',
      ok: 1,
      failed: 0,
      forbidden: 0,
      stale: 0,
      empty: 0,
      skipped: 0,
      codes: {},
    },
  },
  ...extra,
});
const server = () =>
  createApp({ store, origin, ownerUserId: ownerId, snapshotRepository: repository });
async function login(app: ReturnType<typeof createApp>, email: string) {
  const response = await request(app)
    .post('/api/auth/login')
    .set('Origin', origin)
    .send({ email, password });
  expect(response.status).toBe(200);
  return response.headers['set-cookie'][0].split(';')[0] as string;
}
beforeEach(async () => {
  store = new MemoryStore();
  repository = new MemorySnapshotRepository();
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

describe('GET /api/snapshots/status (mounted in the app after authentication)', () => {
  it('requires login, owner and a configured owner id', async () => {
    const app = server();
    expect((await request(app).get('/api/snapshots/status')).status).toBe(401);
    const member = await login(app, 'member@example.test');
    const denied = await request(app).get('/api/snapshots/status').set('Cookie', member);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('OWNER_REQUIRED');
    const unconfigured = createApp({ store, origin, snapshotRepository: repository });
    const ownerCookie = await login(unconfigured, 'owner@example.test');
    const closed = await request(unconfigured)
      .get('/api/snapshots/status')
      .set('Cookie', ownerCookie);
    expect(closed.status).toBe(503);
    expect(closed.body.error.code).toBe('TOSS_INTEGRATION_UNAVAILABLE');
  });
  it('shows the latest runs per market with counts and status codes only', async () => {
    await repository.finishRun(run('KR', '2026-10-20'));
    await repository.finishRun(
      run('KR', '2026-10-21', {
        status: 'partial',
        steps: {
          candles: {
            status: 'FAILED',
            ok: 0,
            failed: 1,
            forbidden: 0,
            stale: 0,
            empty: 0,
            skipped: 0,
            codes: { PROVIDER_SCHEMA_INVALID: 1 },
          },
          creditTrades: {
            status: 'FORBIDDEN',
            ok: 0,
            failed: 0,
            forbidden: 2,
            stale: 0,
            empty: 0,
            skipped: 0,
            codes: { PROVIDER_FORBIDDEN: 2 },
          },
        },
      }),
    );
    await repository.finishRun(run('US', '2026-10-20'));
    const app = server();
    const cookie = await login(app, 'owner@example.test');
    const response = await request(app).get('/api/snapshots/status').set('Cookie', cookie);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.markets.KR.lastRun).toMatchObject({
      date: '2026-10-21',
      status: 'partial',
      steps: {
        candles: { status: 'FAILED', codes: { PROVIDER_SCHEMA_INVALID: 1 } },
        creditTrades: { status: 'FORBIDDEN', forbidden: 2 },
      },
    });
    expect(response.body.markets.KR.recentRuns.map((r: { date: string }) => r.date)).toEqual([
      '2026-10-21',
      '2026-10-20',
    ]);
    expect(response.body.markets.US.lastRun.date).toBe('2026-10-20');
  });
  it('returns nulls before the first run and never exposes unlisted run fields', async () => {
    const app = server();
    const cookie = await login(app, 'owner@example.test');
    const empty = await request(app).get('/api/snapshots/status').set('Cookie', cookie);
    expect(empty.body.markets).toMatchObject({
      KR: { lastRun: null, recentRuns: [] },
      US: { lastRun: null, recentRuns: [] },
    });
    const leaky = { ...run('KR', '2026-10-21'), internalNote: 'must-never-leak' } as SnapshotRun;
    expect(JSON.stringify(publicRun(leaky))).not.toContain('must-never-leak');
  });
});

describe('owner snapshot target list', () => {
  it('is owner-only for read and write', async () => {
    const app = server();
    expect((await request(app).get('/api/snapshots/targets')).status).toBe(401);
    const member = await login(app, 'member@example.test');
    expect((await request(app).get('/api/snapshots/targets').set('Cookie', member)).status).toBe(
      403,
    );
    expect(
      (
        await request(app)
          .put('/api/snapshots/targets')
          .set('Cookie', member)
          .set('Origin', origin)
          .send({ targets: [{ market: 'KR', symbol: '005930' }] })
      ).status,
    ).toBe(403);
    expect(repository.targets.size).toBe(0);
  });
  it('stores a validated, de-duplicated list under the owner id', async () => {
    const app = server();
    const cookie = await login(app, 'owner@example.test');
    const empty = await request(app).get('/api/snapshots/targets').set('Cookie', cookie);
    expect(empty.body).toEqual({ targets: [], updatedAt: null });
    const saved = await request(app)
      .put('/api/snapshots/targets')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .send({
        targets: [
          { market: 'KR', symbol: '005930' },
          { market: 'US', symbol: 'BRK.B' },
          { market: 'US', symbol: 'brk.b' },
        ],
      });
    expect(saved.status).toBe(200);
    expect(saved.body.targets).toEqual([
      { market: 'KR', symbol: '005930' },
      { market: 'US', symbol: 'BRK.B' },
    ]);
    expect(repository.targets.get(ownerId)?.targets).toHaveLength(2);
    const read = await request(app).get('/api/snapshots/targets').set('Cookie', cookie);
    expect(read.body.targets).toHaveLength(2);
  });
  it('rejects malformed lists and cross-site writes', async () => {
    const app = server();
    const cookie = await login(app, 'owner@example.test');
    const put = (body: unknown, requestOrigin = origin) =>
      request(app)
        .put('/api/snapshots/targets')
        .set('Cookie', cookie)
        .set('Origin', requestOrigin)
        .send(body as object);
    for (const bad of [
      {},
      { targets: 'x' },
      { targets: [{ market: 'JP', symbol: '005930' }] },
      { targets: [{ market: 'KR', symbol: 'AAPL' }] },
      { targets: [{ market: 'KR', symbol: '../etc' }] },
      { targets: [{ market: 'US', symbol: 'AAPL', extra: 1 }] },
      { targets: [{ market: 'KR', symbol: '005930' }], extra: true },
      { targets: Array.from({ length: 101 }, (_, i) => ({ market: 'US', symbol: `T${i}` })) },
    ])
      expect((await put(bad)).status).toBe(400);
    expect((await put({ targets: [] }, 'https://evil.example')).status).toBe(403);
    expect(repository.targets.size).toBe(0);
  });
});

describe('router factory', () => {
  it('re-checks login and owner when mounted on its own', async () => {
    const bare = (user?: object, ownerUserId: string | null = 'owner') => {
      const app = express();
      app.use((_req, res, next) => {
        if (user) res.locals.user = user;
        next();
      });
      app.use(createSnapshotRouter({ repository, ownerUserId: ownerUserId ?? undefined }));
      return app;
    };
    expect((await request(bare()).get('/api/snapshots/status')).status).toBe(401);
    expect(
      (await request(bare({ id: 'x', active: true })).get('/api/snapshots/status')).status,
    ).toBe(403);
    expect(
      (await request(bare({ id: 'owner', active: false })).get('/api/snapshots/status')).status,
    ).toBe(401);
    expect(
      (await request(bare({ id: 'owner', active: true }, null)).get('/api/snapshots/status'))
        .status,
    ).toBe(503);
    expect(
      (await request(bare({ id: 'owner', active: true })).get('/api/snapshots/status')).status,
    ).toBe(200);
  });
  it('parses targets strictly', () => {
    expect(parseTargets([])).toEqual([]);
    expect(parseTargets([{ market: 'KR', symbol: '0101N0' }])).toHaveLength(1);
    expect(parseTargets(null)).toBeNull();
    expect(parseTargets([null])).toBeNull();
  });
});
