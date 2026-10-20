import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  JOB_NAME,
  jobConfiguration,
  runOrderAccessCheck,
  statusOf,
} from '../src/jobs/order-access-check';
import { JobConfigError, createJobLogger } from '../src/jobs/runner';
import { MemoryTradingStore } from '../src/server/trading/stores';
import { TossOrderClient } from '../src/server/trading/toss-orders';
import { FakeToss } from './support/fake-toss';

// Synthetic only: a fake Toss server behind the transport port. Nothing is sent anywhere.
const SECRET_TEXT = 'provider text that must never be stored or logged';
function setup(configure: (fake: FakeToss) => void = () => undefined) {
  const fake = new FakeToss();
  configure(fake);
  const store = new MemoryTradingStore();
  const logs: string[] = [];
  const run = () =>
    runOrderAccessCheck({
      client: new TossOrderClient(fake, { sleep: async () => {} }),
      status: store,
      now: () => new Date('2026-10-21T00:00:00.000Z'),
      log: createJobLogger(JOB_NAME, (line) => logs.push(line)),
    });
  return { fake, store, logs, run };
}

describe('order access check job (read only)', () => {
  it('reads buying power (KRW, USD), commissions and open orders — and sends no POST at all', async () => {
    const { fake, run } = setup();
    await expect(run()).resolves.toBe('ok');
    expect(
      fake.calls.map(
        (c) => `${c.method} ${c.path}${c.query ? `?${new URLSearchParams(c.query)}` : ''}`,
      ),
    ).toEqual([
      'GET /api/v1/buying-power?currency=KRW',
      'GET /api/v1/buying-power?currency=USD',
      'GET /api/v1/commissions',
      'GET /api/v1/orders?status=OPEN',
    ]);
    expect(fake.postCount()).toBe(0);
    expect(fake.orders).toHaveLength(0);
  });
  it('stores only booleans and sanitized codes and logs a status word, counts and codes', async () => {
    const { store, logs, run } = setup();
    await run();
    expect(await store.getAccessCheck()).toEqual({
      checkedAt: '2026-10-21T00:00:00.000Z',
      allOk: true,
      permissionDenied: false,
      probes: {
        buyingPowerKrw: { ok: true },
        buyingPowerUsd: { ok: true },
        commissions: { ok: true },
        openOrders: { ok: true },
      },
    });
    const line = logs.map((l) => JSON.parse(l)).find((l) => l.message === 'access-checked');
    expect(line).toMatchObject({ job: 'order-access-check', status: 'all-ok', ok: 4, failed: 0 });
    // Nothing from a response (amounts, rates, ids) reaches the output.
    expect(logs.join('\n')).not.toMatch(/100000|0\.00015|0\.0025|order-\d/);
  });
  it('a permission refusal is reported as denied with upper-snake codes, exit "failed", and no provider text', async () => {
    const { fake, store, logs, run } = setup((f) => {
      f.getFailures.set('/api/v1/buying-power', { status: 403, code: 'forbidden' });
    });
    await expect(run()).resolves.toBe('failed');
    const stored = await store.getAccessCheck();
    expect(stored).toMatchObject({ allOk: false, permissionDenied: true });
    expect(stored?.probes.buyingPowerKrw).toEqual({ ok: false, code: 'forbidden', status: 403 });
    expect(stored?.probes.commissions).toEqual({ ok: true });
    const line = logs.map((l) => JSON.parse(l)).find((l) => l.message === 'access-checked');
    expect(line).toMatchObject({ status: 'denied', ok: 2, failed: 2, codes: { FORBIDDEN: 2 } });
    expect(JSON.stringify([stored, logs])).not.toContain(SECRET_TEXT);
    expect(fake.postCount()).toBe(0);
  });
  it('a non-permission failure is "failed" (not denied); a malformed answer has its own code', async () => {
    const { store, logs, run } = setup((f) => {
      f.getFailures.set('/api/v1/commissions', { status: 500, code: 'internal-error' });
      f.malformed.add('/api/v1/orders');
    });
    await expect(run()).resolves.toBe('failed');
    const stored = await store.getAccessCheck();
    expect(stored?.permissionDenied).toBe(false);
    expect(stored?.probes.commissions).toMatchObject({ ok: false, code: 'internal-error' });
    expect(stored?.probes.openOrders).toMatchObject({ ok: false, code: 'response-invalid' });
    const line = logs.map((l) => JSON.parse(l)).find((l) => l.message === 'access-checked');
    expect(line).toMatchObject({
      status: 'failed',
      codes: { INTERNAL_ERROR: 1, RESPONSE_INVALID: 1 },
    });
  });
  it('a failing status write is reported as a failed job', async () => {
    const { store, run } = setup();
    vi.spyOn(store, 'putAccessCheck').mockRejectedValue(new Error('storage down'));
    await expect(run()).resolves.toBe('failed');
  });
  it('statusOf copies nothing but the report fields', () => {
    const status = statusOf({
      checkedAt: 'x',
      buyingPowerKrw: { ok: true },
      buyingPowerUsd: { ok: true },
      commissions: { ok: true },
      openOrders: { ok: true },
      allOk: true,
      permissionDenied: false,
      // @ts-expect-error extra data must not be copied through
      secret: 'amount',
    });
    expect(Object.keys(status).sort()).toEqual([
      'allOk',
      'checkedAt',
      'permissionDenied',
      'probes',
    ]);
  });
  it('requires production, a Cloud Run Job, an explicit project and the Toss credentials', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      CLOUD_RUN_JOB: 'investing-order-access-check',
      GOOGLE_CLOUD_PROJECT: 'test-project-1',
      TOSS_CLIENT_ID: 'client',
      TOSS_CLIENT_SECRET: 'secret',
      TOSS_ACCOUNT_SEQ: '123',
      TOSS_OWNER_USER_ID: 'owner',
    };
    expect(jobConfiguration(env).project).toBe('test-project-1');
    for (const patch of [
      { NODE_ENV: 'development' },
      { CLOUD_RUN_JOB: undefined },
      { GOOGLE_CLOUD_PROJECT: undefined },
      { TOSS_CLIENT_ID: undefined },
      { TOSS_ACCOUNT_SEQ: 'abc' },
    ])
      expect(() => jobConfiguration({ ...env, ...patch })).toThrow(JobConfigError);
  });
  it('the job file has no write path (static)', () => {
    const code = readFileSync('src/jobs/order-access-check.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/placeOrder|cancelOrder|POST|TossOrderWrites/);
  });
});
