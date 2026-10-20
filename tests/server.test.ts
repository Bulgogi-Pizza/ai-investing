import { MemoryLoginThrottle } from '../src/server/login-throttle';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { hashPassword, sessionHash } from '../src/server/auth';
import fixture from './fixtures/toss-holdings.json';
import { TossClient, MemoryTokenCache } from '../src/server/toss';
import { MemoryStore } from '../src/server/store';
const origin = 'http://localhost:5173';
const password = 'Test-only lengthy password';
let store: MemoryStore;
let app: ReturnType<typeof createApp>;
let adminId: string;
let memberId: string;
async function login(email = 'member@example.test') {
  const response = await request(app)
    .post('/api/auth/login')
    .set('Origin', origin)
    .send({ email, password });
  expect(response.status).toBe(200);
  return response.headers['set-cookie'][0].split(';')[0];
}
beforeEach(async () => {
  store = new MemoryStore();
  const passwordHash = await hashPassword(password);
  adminId = (
    await store.createUser({
      email: 'admin@example.test',
      passwordHash,
      role: 'admin',
      active: true,
      version: 1,
    })
  ).id;
  memberId = (
    await store.createUser({
      email: 'member@example.test',
      passwordHash,
      role: 'member',
      active: true,
      version: 1,
    })
  ).id;
  app = createApp({ store, origin, ownerUserId: memberId });
});
describe('server authorization', () => {
  it('exposes health only and denies every anonymous private resource', async () => {
    expect((await request(app).get('/api/health')).status).toBe(200);
    expect((await request(app).get('/')).status).toBe(404);
    for (const path of [
      '/api/auth/me',
      '/api/portfolio',
      '/api/market/candles?symbol=005930',
      '/api/market/prices?symbols=005930',
      '/api/market/indicators',
      '/api/strategy',
      '/api/recommendations',
      '/api/news/sources',
      '/api/admin/news/sync',
      '/api/calendar',
      '/api/admin/users',
    ])
      expect((await request(app).get(path)).status).toBe(401);
    expect(
      (await request(app).get('/api/strategy').set('Cookie', 'folio_session=forged')).status,
    ).toBe(401);
  });
  it('mounts official news behind authentication, origin and administrator checks', async () => {
    expect(
      (await request(app).post('/api/admin/news/sync').set('Origin', origin).send({})).status,
    ).toBe(401);
    const cookie = await login();
    const sources = await request(app).get('/api/news/sources').set('Cookie', cookie);
    expect(sources.status).toBe(200);
    expect(sources.body.sources.map((source: { id: string }) => source.id)).toEqual([
      'fed-press',
      'bok-press',
    ]);
    expect(
      (await request(app).post('/api/admin/news/sync').set('Cookie', cookie).send({})).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/api/admin/news/sync')
          .set('Cookie', cookie)
          .set('Origin', origin)
          .send({})
      ).status,
    ).toBe(403);
    // Admin AND owner: only an admin who is also the configured owner reaches input validation.
    app = createApp({ store, origin, ownerUserId: adminId });
    const admin = await login('admin@example.test');
    expect(
      (
        await request(app)
          .post('/api/admin/news/sync')
          .set('Cookie', admin)
          .set('Origin', origin)
          .send({ sourceIds: ['https://evil.test'] })
      ).status,
    ).toBe(400);
  });
  it('rejects unregistered, inactive and incorrect-password accounts', async () => {
    await store.revokeUser(memberId);
    for (const email of ['absent@example.test', 'member@example.test'])
      expect(
        (await request(app).post('/api/auth/login').set('Origin', origin).send({ email, password }))
          .status,
      ).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .set('Origin', origin)
          .send({ email: 'admin@example.test', password: 'incorrect but lengthy' })
      ).status,
    ).toBe(401);
  });
  it('checks origin on login, logout and strategy writes', async () => {
    expect(
      (await request(app).post('/api/auth/login').send({ email: 'admin@example.test', password }))
        .status,
    ).toBe(403);
    const cookie = await login();
    expect(
      (
        await request(app)
          .post('/api/auth/logout')
          .set('Cookie', cookie)
          .set('Origin', 'https://evil.test')
      ).status,
    ).toBe(403);
    expect((await request(app).put('/api/strategy').set('Cookie', cookie).send({})).status).toBe(
      403,
    );
  });
  it('isolates strategies, validates allocations, and never fabricates provider data', async () => {
    const cookie = await login();
    const strategy = {
      name: '장기 분산',
      horizon: '5년',
      benchmark: 'S&P 500',
      riskTolerance: 'medium',
      targetAllocations: [
        { asset: '주식', percentage: 60 },
        { asset: '채권', percentage: 40 },
      ],
      notes: '분기별 점검',
    };
    const saved = await request(app)
      .put('/api/strategy')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ strategy });
    expect(saved.status).toBe(200);
    expect((await request(app).get('/api/strategy').set('Cookie', cookie)).body.strategy).toEqual(
      strategy,
    );
    const admin = await login('admin@example.test');
    expect((await request(app).get('/api/strategy').set('Cookie', admin)).status).toBe(403);
    expect(await store.getStrategy(adminId)).toBeNull();
    expect(
      (
        await request(app)
          .put('/api/strategy')
          .set('Origin', origin)
          .set('Cookie', cookie)
          .send({
            strategy: { ...strategy, targetAllocations: [{ asset: '주식', percentage: 5 }] },
          })
      ).status,
    ).toBe(400);
    expect((await request(app).get('/api/portfolio').set('Cookie', cookie)).status).toBe(503);
    expect((await request(app).get('/api/recommendations').set('Cookie', cookie)).status).toBe(503);
  });
  it('restricts account creation and invalidates sessions immediately on revocation', async () => {
    const member = await login();
    const admin = await login('admin@example.test');
    expect(
      (
        await request(app)
          .post('/api/admin/users')
          .set('Origin', origin)
          .set('Cookie', member)
          .send({ email: 'new@example.test', password })
      ).status,
    ).toBe(403);
    const created = await request(app)
      .post('/api/admin/users')
      .set('Origin', origin)
      .set('Cookie', admin)
      .send({ email: 'new@example.test', password, role: 'admin' });
    expect(created.status).toBe(201);
    expect(created.body.user.role).toBe('member');
    expect(created.body.user.passwordHash).toBeUndefined();
    const listed = await request(app).get('/api/admin/users').set('Cookie', admin);
    expect(listed.status).toBe(200);
    expect(listed.body.users).toHaveLength(3);
    expect(JSON.stringify(listed.body)).not.toContain('passwordHash');
    expect((await request(app).get('/api/admin/users').set('Cookie', member)).status).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/admin/users/${memberId}/revoke`)
          .set('Origin', origin)
          .set('Cookie', admin)
      ).status,
    ).toBe(204);
    expect((await request(app).get('/api/auth/me').set('Cookie', member)).status).toBe(401);
    expect(
      (
        await request(app)
          .post(`/api/admin/users/${adminId}/revoke`)
          .set('Origin', origin)
          .set('Cookie', admin)
      ).status,
    ).toBe(400);
  });
  it('bounds general API reads and login attempts', async () => {
    for (let i = 0; i < 120; i++) expect((await request(app).get('/api/health')).status).toBe(200);
    expect((await request(app).get('/api/health')).status).toBe(429);
    app = createApp({ store, origin });
    for (let i = 0; i < 10; i++)
      expect(
        (
          await request(app)
            .post('/api/auth/login')
            .set('Origin', origin)
            .send({ email: `missing${i}@example.test`, password })
        ).status,
      ).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .set('Origin', origin)
          .send({ email: 'missing@example.test', password })
      ).status,
    ).toBe(429);
  });
  it('serves sanitized live holdings only to configured owner and protects market API', async () => {
    const transport = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/oauth2/token'))
        return Response.json({ access_token: 'fixture', token_type: 'Bearer', expires_in: 86400 });
      if (String(url).endsWith('/accounts'))
        return Response.json({
          result: [{ accountSeq: 1, accountType: 'BROKERAGE', accountNo: 'sensitive-fixture' }],
        });
      return Response.json(fixture);
    }) as typeof fetch;
    const toss = new TossClient(
      { clientId: 'fixture', clientSecret: 'fixture', accountSeq: '1', ownerUserId: memberId },
      new MemoryTokenCache(),
      transport,
    );
    app = createApp({ store, origin, toss, ownerUserId: memberId });
    expect((await request(app).get('/api/market/candles?symbol=005930')).status).toBe(401);
    const member = await login();
    const owner = await request(app).get('/api/portfolio').set('Cookie', member);
    expect(owner.status).toBe(200);
    expect(owner.body.scope).toBe('stocks-only');
    expect(JSON.stringify(owner.body)).not.toContain('sensitive-fixture');
    const admin = await login('admin@example.test');
    expect((await request(app).get('/api/portfolio').set('Cookie', admin)).status).toBe(403);
    expect(
      (await request(app).get('/api/market/candles?symbol=005930&count=-1').set('Cookie', member))
        .status,
    ).toBe(400);
  });
  it('gates calendar, news and strategy to the owner while admin user management stays admin-only', async () => {
    const calendarEvent = {
      id: 1,
      date: '2026-10-20',
      time: '09:00',
      title: '물가 발표',
      country: '한국',
      category: '물가',
      assets: ['원화'],
      importance: 3,
      description: '설명',
      sourceUrl: 'https://example.com/r',
      sourceName: '출처',
      impactDirection: 'mixed',
      impactHorizon: '1주',
      confidence: 'low',
      factualObservedAt: '2026-10-20T00:00:00Z',
    };
    const reads = [
      '/api/strategy',
      '/api/calendar/events?from=2026-10-01&to=2026-10-31',
      '/api/news/sources',
    ];
    const owner = await login();
    const admin = await login('admin@example.test');
    for (const path of reads) {
      expect((await request(app).get(path).set('Cookie', owner)).status, path).toBe(200);
      const denied = await request(app).get(path).set('Cookie', admin);
      expect(denied.status, path).toBe(403);
      expect(denied.body.error.code).toBe('OWNER_REQUIRED');
      expect((await request(app).get(path)).status).toBe(401);
    }
    const write = (cookie: string, path: string, body: object, method: 'post' | 'put' = 'post') =>
      request(app)[method](path).set('Origin', origin).set('Cookie', cookie).send(body);
    expect(
      (await write(admin, '/api/admin/calendar/events', { events: [calendarEvent] })).body.error
        .code,
    ).toBe('OWNER_REQUIRED');
    expect((await write(admin, '/api/admin/news/sync', {})).status).toBe(403);
    expect((await write(admin, '/api/strategy', { strategy: {} }, 'put')).status).toBe(403);
    expect(
      (await write(owner, '/api/admin/calendar/events', { events: [calendarEvent] })).status,
    ).toBe(403);
    expect((await write(owner, '/api/admin/news/sync', {})).status).toBe(403);
    expect((await request(app).get('/api/admin/users').set('Cookie', admin)).status).toBe(200);
    const unconfigured = createApp({ store, origin });
    for (const path of reads)
      expect((await request(unconfigured).get(path).set('Cookie', admin)).status, path).toBe(503);
  });
  it('rotates existing sessions at login', async () => {
    const first = await login();
    const next = await request(app)
      .post('/api/auth/login')
      .set('Origin', origin)
      .set('Cookie', first)
      .send({ email: 'member@example.test', password });
    expect(next.status).toBe(200);
    expect(next.headers['set-cookie'][0].split(';')[0]).not.toBe(first);
    expect((await request(app).get('/api/auth/me').set('Cookie', first)).status).toBe(401);
  });
  it('destroys logged-out and expired sessions', async () => {
    const cookie = await login();
    expect(
      (await request(app).post('/api/auth/logout').set('Origin', origin).set('Cookie', cookie))
        .status,
    ).toBe(204);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
    const token = 'a'.repeat(43);
    await store.putSession(sessionHash(token), {
      userId: memberId,
      userVersion: 1,
      expiresAt: Date.now() - 1,
    });
    expect(
      (await request(app).get('/api/auth/me').set('Cookie', `folio_session=${token}`)).status,
    ).toBe(401);
  });
  it('requires durable configuration and secure production cookies', async () => {
    expect(() => createApp({ production: true, origin: 'https://invest.example.test' })).toThrow();
    expect(() => createApp({ production: true, store, origin })).toThrow();
    app = createApp({
      production: true,
      store,
      origin: 'https://invest.example.test',
      loginThrottle: new MemoryLoginThrottle(),
    });
    const response = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://invest.example.test')
      .send({ email: 'admin@example.test', password });
    expect(response.status).toBe(200);
    expect(response.headers['set-cookie'][0]).toMatch(/HttpOnly; Secure; SameSite=Strict/);
  });
});
