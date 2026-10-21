import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app';
import { hashPassword } from '../src/server/auth';
import { MemoryAlgorithmRepository } from '../src/server/algorithms';
import { MemoryStore } from '../src/server/store';
import {
  MemoryNotificationRepository,
  NotificationService,
  TelegramNotifier,
  formatNotification,
  type NotificationEvent,
} from '../src/server/notify';
import {
  BudgetGuard,
  BudgetService,
  MemoryBudgetRepository,
  aiBlockedByBudget,
  authorizePush,
  budgetPushConfigFromEnvironment,
  installBudgetGuard,
  isBudgetStopped,
  parseBudgetMessage,
  type BudgetPushConfig,
  type BudgetUpdate,
  type PushVerifier,
  type VerifiedToken,
} from '../src/server/budget-guard';
import { VertexAiEnricher, type AiRules } from '../src/server/ai';
import { VertexMorningAi } from '../src/server/ai-morning';
import { MemoryFeatureQuota, VertexAlgorithmDecider } from '../src/server/algorithm-ai';
import { gateJob } from '../src/jobs/budget-gate';

// Synthetic data only; no network, no Pub/Sub, no Google certificates. The verifier is injected.
const origin = 'https://invest.example.test';
const audience = 'https://service.example.test';
const serviceAccount = 'investing-budget-push@fixture-project.iam.gserviceaccount.com';
const config: BudgetPushConfig = { audience, serviceAccount, warningRatio: 2 / 3 };
const password = 'Test-only lengthy password';
const telegramToken = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const jwt = `${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;
const OCT = '2026-10-01T07:00:00.000Z';
const NOV = '2026-11-01T07:00:00.000Z';

const goodClaims: VerifiedToken = {
  iss: 'https://accounts.google.com',
  aud: audience,
  email: serviceAccount,
  email_verified: true,
};
const verifierFor =
  (claims: VerifiedToken | null | Error): PushVerifier =>
  async () => {
    if (claims instanceof Error) throw claims;
    return claims;
  };
const body = (
  patch: Record<string, unknown> = {},
  intervalStart = OCT,
  cost = 1000,
  budget = 30000,
) => ({
  message: {
    data: Buffer.from(
      JSON.stringify({
        budgetDisplayName: 'ai-investing-monthly',
        costAmount: cost,
        costIntervalStart: intervalStart,
        budgetAmount: budget,
        budgetAmountType: 'SPECIFIED_AMOUNT',
        currencyCode: 'KRW',
        ...patch,
      }),
    ).toString('base64'),
    messageId: '1',
  },
  subscription: 'projects/p/subscriptions/s',
});
const update = (patch: Partial<BudgetUpdate> = {}): BudgetUpdate => ({
  costAmount: 1000,
  budgetAmount: 30000,
  currency: 'KRW',
  intervalStart: OCT,
  ...patch,
});

describe('budget notification parsing', () => {
  it('accepts the official notification fields and normalizes the interval', () => {
    expect(
      parseBudgetMessage(body({ alertThresholdExceeded: 0.5 }, '2026-10-01T00:00:00Z', 12000.5)),
    ).toEqual({
      costAmount: 12000.5,
      budgetAmount: 30000,
      currency: 'KRW',
      intervalStart: '2026-10-01T00:00:00.000Z',
      thresholdExceeded: 0.5,
    });
    expect(parseBudgetMessage(body())?.thresholdExceeded).toBeUndefined();
  });
  it('rejects anything malformed', () => {
    const bad: unknown[] = [
      null,
      'x',
      [],
      {},
      { message: null },
      { message: { data: 5 } },
      { message: { data: '' } },
      { message: { data: '!!!notbase64!!!' } },
      { message: { data: Buffer.from('not json').toString('base64') } },
      { message: { data: Buffer.from('[]').toString('base64') } },
      { message: { data: 'A'.repeat(9000) } },
      body({ costAmount: '1000' }),
      body({ costAmount: -1 }),
      body({ costAmount: null }),
      body({ budgetAmount: 0 }),
      body({ budgetAmount: 'x' }),
      body({ currencyCode: 'krw' }),
      body({ currencyCode: 'WON1' }),
      body({ costIntervalStart: 'yesterday' }),
      body({ costIntervalStart: 1 }),
      body({ costIntervalStart: '2099-01-01T00:00:00Z' }),
      body({ alertThresholdExceeded: 'high' }),
      body({ alertThresholdExceeded: -1 }),
      body({ budgetAmountType: 3 }),
      body({ budgetDisplayName: {} }),
    ];
    for (const value of bad) expect(parseBudgetMessage(value), JSON.stringify(value)).toBeNull();
  });
});

describe('push configuration', () => {
  it('is off unless both identity values are valid', () => {
    expect(budgetPushConfigFromEnvironment({})).toBeUndefined();
    expect(budgetPushConfigFromEnvironment({ BUDGET_PUSH_AUDIENCE: audience })).toBeUndefined();
    expect(
      budgetPushConfigFromEnvironment({ BUDGET_PUSH_SERVICE_ACCOUNT: serviceAccount }),
    ).toBeUndefined();
    expect(
      budgetPushConfigFromEnvironment({
        BUDGET_PUSH_AUDIENCE: 'http://insecure.example.test',
        BUDGET_PUSH_SERVICE_ACCOUNT: serviceAccount,
      }),
    ).toBeUndefined();
    expect(
      budgetPushConfigFromEnvironment({
        BUDGET_PUSH_AUDIENCE: `${audience}/path`,
        BUDGET_PUSH_SERVICE_ACCOUNT: serviceAccount,
      }),
    ).toBeUndefined();
    expect(
      budgetPushConfigFromEnvironment({
        BUDGET_PUSH_AUDIENCE: audience,
        BUDGET_PUSH_SERVICE_ACCOUNT: 'someone@example.com',
      }),
    ).toBeUndefined();
  });
  it('reads the identity and a warning ratio (default 0.6667, invalid values ignored)', () => {
    const env = { BUDGET_PUSH_AUDIENCE: audience, BUDGET_PUSH_SERVICE_ACCOUNT: serviceAccount };
    expect(budgetPushConfigFromEnvironment(env)).toEqual({
      audience,
      serviceAccount,
      warningRatio: 0.6667,
    });
    expect(
      budgetPushConfigFromEnvironment({ ...env, BUDGET_WARNING_RATIO: '0.5' })?.warningRatio,
    ).toBe(0.5);
    for (const bad of ['0', '1', '1.5', 'abc', '-1'])
      expect(
        budgetPushConfigFromEnvironment({ ...env, BUDGET_WARNING_RATIO: bad })?.warningRatio,
      ).toBe(0.6667);
  });
});

describe('OIDC authorization of a push', () => {
  const ok = (claims: VerifiedToken | null | Error, header: string | undefined = `Bearer ${jwt}`) =>
    authorizePush(header, config, verifierFor(claims));
  it('accepts exactly the expected issuer, audience, e-mail and verified e-mail', async () => {
    expect(await ok(goodClaims)).toBe(true);
    expect(await ok({ ...goodClaims, iss: 'accounts.google.com' })).toBe(true);
    expect(await ok({ ...goodClaims, aud: [audience, 'other'] })).toBe(true);
  });
  it('rejects a missing or malformed bearer header without calling the verifier', async () => {
    const verifier = vi.fn(verifierFor(goodClaims));
    for (const header of [
      undefined,
      '',
      'Bearer',
      `bearer ${jwt}`,
      'Bearer not-a-jwt',
      `Basic ${jwt}`,
    ])
      expect(await authorizePush(header, config, verifier), String(header)).toBe(false);
    expect(verifier).not.toHaveBeenCalled();
  });
  it('rejects an invalid token, wrong issuer, audience or e-mail, and an unverified e-mail', async () => {
    expect(await ok(new Error('bad signature'))).toBe(false);
    expect(await ok(null)).toBe(false);
    expect(await ok({ ...goodClaims, iss: 'https://evil.example' })).toBe(false);
    expect(await ok({ ...goodClaims, iss: undefined })).toBe(false);
    expect(await ok({ ...goodClaims, aud: 'https://other.example.test' })).toBe(false);
    expect(await ok({ ...goodClaims, aud: undefined })).toBe(false);
    expect(
      await ok({ ...goodClaims, email: 'other@fixture-project.iam.gserviceaccount.com' }),
    ).toBe(false);
    expect(await ok({ ...goodClaims, email: undefined })).toBe(false);
    expect(await ok({ ...goodClaims, email_verified: false })).toBe(false);
    expect(await ok({ ...goodClaims, email_verified: undefined })).toBe(false);
  });
  it('asks the verifier for the configured audience only', async () => {
    const verifier = vi.fn(verifierFor(goodClaims));
    await authorizePush(`Bearer ${jwt}`, config, verifier);
    expect(verifier).toHaveBeenCalledWith(jwt, audience);
  });
});

describe('budget service', () => {
  let repository: MemoryBudgetRepository;
  let algorithms: MemoryAlgorithmRepository;
  let events: NotificationEvent[];
  let service: BudgetService;
  let clock: number;
  beforeEach(() => {
    repository = new MemoryBudgetRepository();
    algorithms = new MemoryAlgorithmRepository();
    events = [];
    clock = Date.parse('2026-10-21T01:00:00Z');
    let id = 0;
    service = new BudgetService({
      repository,
      algorithms,
      notify: async (event) => {
        events.push(event);
        return { status: 'sent', recorded: true };
      },
      warningRatio: 2 / 3,
      now: () => new Date(clock),
      newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    });
  });
  const kinds = () => events.map((event) => event.kind);

  it('below the warning ratio only records the state', async () => {
    expect((await service.handle(update({ costAmount: 5000 }))).action).toBe('none');
    expect(kinds()).toEqual([]);
    expect(await repository.get()).toMatchObject({ stopped: false, costAmount: 5000 });
    expect((await algorithms.getControl()).emergencyStop).toBe(false);
  });
  it('warns once per interval at the warning ratio, and again in a new interval', async () => {
    expect((await service.handle(update({ costAmount: 20000 }))).action).toBe('warned');
    expect((await service.handle(update({ costAmount: 22000 }))).action).toBe('none');
    expect((await service.handle(update({ costAmount: 25000 }))).action).toBe('none');
    expect(kinds()).toEqual(['budget-warning']);
    expect((await service.handle(update({ intervalStart: NOV, costAmount: 21000 }))).action).toBe(
      'warned',
    );
    expect(kinds()).toEqual(['budget-warning', 'budget-warning']);
    // A threshold notification at the warning level counts too.
    await service.handle(
      update({ intervalStart: '2026-12-01T07:00:00.000Z', thresholdExceeded: 0.9 }),
    );
    expect(kinds()).toHaveLength(3);
  });
  it('stops at the budget: flag, emergency stop with a history event, one Telegram message', async () => {
    expect((await service.handle(update({ costAmount: 30000 }))).action).toBe('stopped');
    const state = await repository.get();
    expect(state).toMatchObject({
      stopped: true,
      reason: 'budget',
      emergencyStopApplied: true,
      stopNotified: true,
    });
    expect((await algorithms.getControl()).emergencyStop).toBe(true);
    const history = await algorithms.listEvents(10);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ kind: 'budget-stop' });
    // The warning is not sent on top of the stop.
    expect(kinds()).toEqual(['budget-stop']);
  });
  it('also stops on a threshold notification of 100% even when the cost field is lower', async () => {
    expect((await service.handle(update({ costAmount: 100, thresholdExceeded: 1 }))).action).toBe(
      'stopped',
    );
    expect((await service.handle(update({ costAmount: 100, thresholdExceeded: 1 }))).action).toBe(
      'already-stopped',
    );
  });
  it('is idempotent: repeated and late notifications change and send nothing more', async () => {
    await service.handle(update({ costAmount: 31000 }));
    await service.handle(update({ costAmount: 31000 }));
    await service.handle(update({ costAmount: 32000 }));
    await service.handle(update({ costAmount: 29000 }));
    expect(kinds()).toEqual(['budget-stop']);
    expect(await algorithms.listEvents(10)).toHaveLength(1);
    expect(await repository.get()).toMatchObject({ stopped: true, costAmount: 32000 });
  });
  it('ignores a stale notification from an earlier interval', async () => {
    await service.handle(update({ intervalStart: NOV, costAmount: 1000 }));
    expect((await service.handle(update({ intervalStart: OCT, costAmount: 99999 }))).action).toBe(
      'stale',
    );
    expect(kinds()).toEqual([]);
    expect((await repository.get())?.intervalStart).toBe(NOV);
  });
  it('a new interval under budget clears the flag and says so, but never the emergency stop', async () => {
    await service.handle(update({ costAmount: 30000 }));
    expect(kinds()).toEqual(['budget-stop']);
    // Same interval, lower number: still stopped.
    await service.handle(update({ costAmount: 100 }));
    expect((await repository.get())?.stopped).toBe(true);
    expect((await service.handle(update({ intervalStart: NOV, costAmount: 100 }))).action).toBe(
      'resumed',
    );
    expect(await repository.get()).toMatchObject({ stopped: false, reason: null });
    expect(kinds()).toEqual(['budget-stop', 'budget-resumed']);
    expect((await algorithms.getControl()).emergencyStop).toBe(true);
    // The history has no emergency release.
    expect((await algorithms.listEvents(10)).map((e) => e.kind)).toEqual(['budget-stop']);
  });
  it('a new interval that is already over budget stays stopped without a second message', async () => {
    await service.handle(update({ costAmount: 30000 }));
    expect((await service.handle(update({ intervalStart: NOV, costAmount: 35000 }))).action).toBe(
      'already-stopped',
    );
    expect((await repository.get())?.stopped).toBe(true);
    expect(kinds()).toEqual(['budget-stop']);
  });
  it('does not re-set an emergency stop the owner released while the flag stays', async () => {
    await service.handle(update({ costAmount: 30000 }));
    await algorithms.setControl(false, '2026-10-21T02:00:00Z', {
      id: '00000000-0000-4000-8000-0000000000aa',
      at: '2026-10-21T02:00:00Z',
      kind: 'emergency-release',
      changes: [],
    });
    await service.handle(update({ costAmount: 31000 }));
    expect((await algorithms.getControl()).emergencyStop).toBe(false);
    // Jobs, AI and live still honor the flag.
    expect(await isBudgetStopped(new BudgetGuard(repository))).toBe(true);
  });
  it('a failing emergency stop is retried by the next delivery and the message is sent once', async () => {
    const original = algorithms.setControl.bind(algorithms);
    let failures = 1;
    algorithms.setControl = async (...args) => {
      if (failures-- > 0) throw new Error('store down');
      return original(...args);
    };
    await expect(service.handle(update({ costAmount: 30000 }))).rejects.toThrow();
    expect(await repository.get()).toMatchObject({ stopped: true, emergencyStopApplied: false });
    expect(kinds()).toEqual([]);
    expect((await service.handle(update({ costAmount: 30000 }))).action).toBe('already-stopped');
    expect((await algorithms.getControl()).emergencyStop).toBe(true);
    expect(kinds()).toEqual(['budget-stop']);
  });
  it('a failing Telegram delivery never blocks the stop', async () => {
    const failing = new BudgetService({
      repository,
      algorithms,
      notify: async () => {
        throw new Error('telegram down');
      },
    });
    await failing.handle(update({ costAmount: 30000 }));
    expect((await algorithms.getControl()).emergencyStop).toBe(true);
    expect((await repository.get())?.stopped).toBe(true);
  });

  describe('owner release', () => {
    it('does nothing when nothing is stopped', async () => {
      expect((await service.release()).released).toBe(false);
    });
    it('clears the flag for this interval only, records history, keeps the emergency stop', async () => {
      await service.handle(update({ costAmount: 30000 }));
      const result = await service.release();
      expect(result.released).toBe(true);
      expect(result.state).toMatchObject({ stopped: false, releasedIntervalStart: OCT });
      expect((await algorithms.getControl()).emergencyStop).toBe(true);
      expect((await algorithms.listEvents(10)).map((e) => e.kind)).toContain(
        'budget-stop-released',
      );
      // More notifications in the same interval do not stop again; the next interval can.
      expect((await service.handle(update({ costAmount: 40000 }))).action).toBe('suppressed');
      expect((await repository.get())?.stopped).toBe(false);
      expect((await service.handle(update({ intervalStart: NOV, costAmount: 31000 }))).action).toBe(
        'stopped',
      );
    });
  });
});

describe('budget guard cache and AI gate', () => {
  afterEach(() => {
    installBudgetGuard(undefined);
    vi.unstubAllEnvs();
  });
  it('reads the flag at most once a minute and reports unreadable as unknown', async () => {
    let now = 0;
    const get = vi.fn(async () => ({ stopped: true }) as never);
    const guard = new BudgetGuard({ get }, { clock: () => now, ttlMs: 10 * 60_000 });
    expect(await guard.status()).toBe('stopped');
    now = 59_000;
    expect(await guard.status()).toBe('stopped');
    expect(get).toHaveBeenCalledTimes(1);
    now = 61_000;
    await guard.status();
    expect(get).toHaveBeenCalledTimes(2);
    guard.invalidate();
    await guard.status();
    expect(get).toHaveBeenCalledTimes(3);
    const broken = new BudgetGuard(
      {
        get: async () => {
          throw new Error('down');
        },
      },
      { clock: () => now },
    );
    expect(await broken.status()).toBe('unknown');
    expect(await isBudgetStopped(broken)).toBe(false);
    expect(await new BudgetGuard({ get: async () => null }).status()).toBe('running');
  });
  it('AI is blocked unless the flag is readable and clear (fail closed)', async () => {
    const status = (value: 'running' | 'stopped' | 'unknown') => ({ status: async () => value });
    installBudgetGuard(status('running'));
    expect(await aiBlockedByBudget()).toBe(false);
    installBudgetGuard(status('stopped'));
    expect(await aiBlockedByBudget()).toBe(true);
    installBudgetGuard(status('unknown'));
    expect(await aiBlockedByBudget()).toBe(true);
  });
  it('without an installed guard only a production process blocks', async () => {
    expect(await aiBlockedByBudget()).toBe(false);
    vi.stubEnv('NODE_ENV', 'production');
    expect(await aiBlockedByBudget()).toBe(true);
  });

  const stopped = { status: async () => 'stopped' as const };
  it('explanations answer "unavailable / BUDGET_STOPPED" before the cache or quota', async () => {
    installBudgetGuard(stopped);
    const quota = { consume: vi.fn(async () => true) };
    const transport = vi.fn();
    const client = new VertexAiEnricher(
      { project: 'fixture-project', model: 'gemini-3.1-flash-lite', location: 'global' },
      quota,
      transport as unknown as typeof fetch,
      { getAccessToken: async () => 'token' },
    );
    const result = await client.enrich({} as AiRules, 'owner');
    expect(result.ai).toMatchObject({ status: 'unavailable', code: 'BUDGET_STOPPED' });
    expect(quota.consume).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    // Not stopped: the same call passes the gate (and fails later for its own reasons: no valid rules).
    installBudgetGuard({ status: async () => 'running' });
    const open = await client.enrich({} as AiRules, 'owner');
    expect(open.ai).toMatchObject({ status: 'unavailable' });
    expect((open.ai as { code?: string }).code).toBeUndefined();
  });
  it('the morning AI throws BUDGET_STOPPED before the quota is charged', async () => {
    const quota = { consume: vi.fn(async () => false) };
    const transport = vi.fn();
    const ai = new VertexMorningAi(
      { project: 'fixture-project', model: 'gemini-3.1-flash-lite', location: 'global' },
      quota,
      transport as unknown as typeof fetch,
      { getAccessToken: async () => 'token' },
    );
    const input = [
      {
        refId: 'e1',
        date: '2026-10-20',
        title: '미국 소비자물가지수(CPI) 발표',
        importance: 3 as const,
        values: [
          {
            label: '지수',
            actual: '324.368',
            previous: '323.364',
            unit: '지수',
            period: '2026-09-01',
            previousPeriod: '2026-08-01',
          },
        ],
      },
    ];
    installBudgetGuard(stopped);
    await expect(ai.summarize(input)).rejects.toMatchObject({ code: 'BUDGET_STOPPED' });
    await expect(ai.translate([{ refId: 'e1', title: 'Rule approved' }])).rejects.toMatchObject({
      code: 'BUDGET_STOPPED',
    });
    expect(quota.consume).not.toHaveBeenCalled();
    installBudgetGuard({ status: async () => 'unknown' });
    await expect(ai.summarize(input)).rejects.toMatchObject({ code: 'BUDGET_STOPPED' });
    installBudgetGuard({ status: async () => 'running' });
    await expect(ai.summarize(input)).rejects.toMatchObject({ code: 'AI_QUOTA_EXCEEDED' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('the algorithm AI answers BUDGET_STOPPED before the quota is charged', async () => {
    const quota = new MemoryFeatureQuota();
    const consume = vi.spyOn(quota, 'consume');
    const transport = vi.fn();
    const decider = new VertexAlgorithmDecider(
      { project: 'fixture-project', model: 'gemini-3.8-flash', location: 'global' },
      quota,
      transport as unknown as typeof fetch,
      { getAccessToken: async () => 'token' },
    );
    const input = {
      market: 'KR' as const,
      date: '2026-10-21',
      currency: 'KRW' as const,
      symbols: [
        { symbol: '005930', price: 77_000, held: false, heldTradingDays: null, signals: {} },
      ],
    };
    installBudgetGuard(stopped);
    expect(await decider.decide(input)).toEqual({ status: 'unavailable', code: 'BUDGET_STOPPED' });
    installBudgetGuard({ status: async () => 'unknown' });
    expect(await decider.decide(input)).toEqual({ status: 'unavailable', code: 'BUDGET_STOPPED' });
    expect(consume).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('job gate', () => {
  afterEach(() => installBudgetGuard(undefined));
  const logger = () => {
    const lines: { event: string; fields: unknown }[] = [];
    return {
      lines,
      log: {
        info: (event: string, fields?: unknown) => lines.push({ event, fields }),
        warn: (event: string, fields?: unknown) => lines.push({ event, fields }),
        error: (event: string, fields?: unknown) => lines.push({ event, fields }),
      },
    };
  };
  const guardOf = (status: 'running' | 'stopped' | 'unknown') => ({ status: async () => status });
  it('a stopped budget skips the job with a sanitized code and exit OK', async () => {
    const { lines, log } = logger();
    expect(await gateJob(guardOf('stopped'), log, { failClosed: false })).toBe('ok');
    expect(await gateJob(guardOf('stopped'), log, { failClosed: true })).toBe('ok');
    expect(lines.map((l) => l.fields)).toEqual([
      { code: 'BUDGET_STOPPED' },
      { code: 'BUDGET_STOPPED' },
    ]);
  });
  it('an unreadable flag: snapshot, morning and paper jobs run, the live job stops', async () => {
    const open = logger();
    expect(await gateJob(guardOf('unknown'), open.log, { failClosed: false })).toBeUndefined();
    expect(open.lines[0].fields).toEqual({ code: 'BUDGET_UNKNOWN' });
    const closed = logger();
    expect(await gateJob(guardOf('unknown'), closed.log, { failClosed: true })).toBe('failed');
  });
  it('a clear flag lets every job run and installs the guard for the AI gate', async () => {
    const { lines, log } = logger();
    expect(await gateJob(guardOf('running'), log, { failClosed: true })).toBeUndefined();
    expect(lines).toEqual([]);
    expect(await aiBlockedByBudget()).toBe(false);
    expect(await gateJob(guardOf('stopped'), log, { failClosed: false })).toBe('ok');
    expect(await aiBlockedByBudget()).toBe(true);
  });
  it('every job entry calls the gate; only the live job fails closed', () => {
    const jobs: [string, boolean][] = [
      ['daily-snapshot', false],
      ['morning-calendar', false],
      ['algo-paper', false],
      ['algo-live', true],
      ['order-access-check', false],
    ];
    for (const [name, closed] of jobs) {
      const source = readFileSync(`src/jobs/${name}.ts`, 'utf8');
      expect(source, name).toContain(`budgetJobGate(db, log, { failClosed: ${closed} })`);
      // The gate is the first thing that runs once the job's Firestore client exists.
      expect(source, name).toMatch(
        /new Firestore\(\{ projectId: config\.project \}\);\s*try \{\s*const skipped = await budgetJobGate/,
      );
    }
  });
});

describe('notification wording', () => {
  it('has no amounts, digits or account data and names the state only', () => {
    for (const kind of ['budget-warning', 'budget-stop', 'budget-resumed'] as const) {
      const { message } = formatNotification({ kind }, origin);
      expect(message, kind).not.toMatch(/\d{2,}/);
      expect(message, kind).not.toMatch(/원\b/);
      expect(message).toContain(`화면: ${origin}/`);
    }
    expect(formatNotification({ kind: 'budget-stop' }, origin).message).toContain(
      '월 예산 한도 도달',
    );
    expect(formatNotification({ kind: 'budget-warning' }, origin).message).toContain(
      '월 예산 경고',
    );
    expect(
      formatNotification({ kind: 'setting-risk-increase', change: 'budget-stop-released' }, origin)
        .message,
    ).toContain('월 예산 정지 해제');
  });
});

describe('HTTP: webhook and owner API', () => {
  let store: MemoryStore;
  let ownerId: string;
  let budgetRepository: MemoryBudgetRepository;
  let algorithmRepository: MemoryAlgorithmRepository;
  let notificationRepository: MemoryNotificationRepository;
  let telegram: ReturnType<typeof vi.fn> & typeof fetch;
  beforeEach(async () => {
    store = new MemoryStore();
    budgetRepository = new MemoryBudgetRepository();
    algorithmRepository = new MemoryAlgorithmRepository();
    notificationRepository = new MemoryNotificationRepository();
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
      email: 'member@example.test',
      passwordHash,
      role: 'member',
      active: true,
      version: 1,
    });
  });
  const appWith = (
    options: { push?: BudgetPushConfig | null; verifier?: PushVerifier; guard?: BudgetGuard } = {},
  ) =>
    createApp({
      store,
      origin,
      ownerUserId: ownerId,
      algorithmRepository,
      budgetRepository,
      budgetGuard: options.guard,
      budgetPush: options.push === null ? undefined : (options.push ?? config),
      budgetVerifier: options.verifier ?? verifierFor(goodClaims),
      notificationRepository,
      notifications: new NotificationService({
        repository: notificationRepository,
        notifier: new TelegramNotifier({
          botToken: telegramToken,
          chatId: '987654321',
          transport: telegram,
        }),
        appOrigin: origin,
      }),
    });
  const login = async (app: ReturnType<typeof appWith>, email = 'owner@example.test') => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ email, password });
    expect(response.status).toBe(200);
    return response.headers['set-cookie'][0].split(';')[0] as string;
  };
  const push = (app: ReturnType<typeof appWith>, payload: unknown = body()) =>
    request(app)
      .post('/api/internal/budget-alert')
      .set('Authorization', `Bearer ${jwt}`)
      .send(payload as object);

  describe('webhook', () => {
    it('is off (404) when the identity is not configured', async () => {
      const app = appWith({ push: null });
      const response = await push(app, body({ costAmount: 99999 }));
      expect(response.status).toBe(404);
      expect(await budgetRepository.get()).toBeNull();
    });
    it('is reachable without a session or an Origin header, and nothing else under /api is', async () => {
      const app = appWith();
      const accepted = await push(app, body({ costAmount: 30000 }));
      expect(accepted.status).toBe(204);
      expect((await budgetRepository.get())?.stopped).toBe(true);
      expect((await algorithmRepository.getControl()).emergencyStop).toBe(true);
      // Same route family without the OIDC identity or other writes: still gated by session/origin.
      expect((await request(app).post('/api/internal/other').send({})).status).toBe(403);
      expect(
        (await request(app).post('/api/internal/other').set('Origin', origin).send({})).status,
      ).toBe(401);
      expect((await request(app).get('/api/internal/budget-alert')).status).toBe(401);
      expect((await request(app).get('/api/ops/budget')).status).toBe(401);
      expect((await request(app).post('/api/ops/budget/release').send({})).status).toBe(403);
    });
    it('rejects a missing, invalid or mismatching token with one plain 401 and no side effect', async () => {
      const cases: (VerifiedToken | null | Error)[] = [
        new Error('bad'),
        { ...goodClaims, aud: 'https://other.example.test' },
        { ...goodClaims, email: 'x@fixture-project.iam.gserviceaccount.com' },
        { ...goodClaims, iss: 'https://evil.example' },
        { ...goodClaims, email_verified: false },
      ];
      const bodies = new Set<string>();
      for (const claims of cases) {
        const app = appWith({ verifier: verifierFor(claims) });
        const response = await push(app, body({ costAmount: 99999 }));
        expect(response.status).toBe(401);
        bodies.add(JSON.stringify(response.body));
      }
      const app = appWith();
      const missing = await request(app)
        .post('/api/internal/budget-alert')
        .send(body({ costAmount: 99999 }));
      expect(missing.status).toBe(401);
      bodies.add(JSON.stringify(missing.body));
      expect(bodies.size).toBe(1);
      expect(await budgetRepository.get()).toBeNull();
      expect(telegram).not.toHaveBeenCalled();
    });
    it('answers 400 for a malformed message and 204 for a valid one that needs nothing', async () => {
      const app = appWith();
      expect((await push(app, { message: { data: 'bm90IGpzb24=' } })).status).toBe(400);
      expect((await push(app, { nope: 1 })).status).toBe(400);
      expect((await push(app, body({ costAmount: 1 }))).status).toBe(204);
      expect(telegram).not.toHaveBeenCalled();
    });
    it('sends the warning once and the stop message once through Telegram', async () => {
      const app = appWith();
      await push(app, body({}, OCT, 21000));
      await push(app, body({}, OCT, 22000));
      expect(telegram).toHaveBeenCalledTimes(1);
      await push(app, body({}, OCT, 30500));
      await push(app, body({}, OCT, 31000));
      expect(telegram).toHaveBeenCalledTimes(2);
      const sent = (await notificationRepository.listRecent(10)).map((n) => n.kind).sort();
      expect(sent).toEqual(['budget-stop', 'budget-warning']);
      for (const call of telegram.mock.calls) {
        const text = JSON.parse((call[1] as { body: string }).body).text as string;
        expect(text).not.toMatch(/\d{4,}/);
      }
    });
    it('answers 500 (so Pub/Sub retries) when the emergency stop cannot be written', async () => {
      algorithmRepository.setControl = async () => {
        throw new Error('down');
      };
      const app = appWith();
      expect((await push(app, body({ costAmount: 30000 }))).status).toBe(500);
    });
    it('has its own body limit and a rate limit that only counts rejected calls', async () => {
      const app = appWith();
      const big = await push(app, { message: { data: 'A'.repeat(20000) } });
      expect(big.status).toBe(413);
      for (let i = 0; i < 40; i++) expect((await push(app, body())).status).toBe(204);
      const bad = appWith({ verifier: verifierFor(new Error('bad')) });
      const statuses: number[] = [];
      for (let i = 0; i < 25; i++) statuses.push((await push(bad)).status);
      expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
    });
  });

  describe('owner API', () => {
    const post = (
      app: ReturnType<typeof appWith>,
      path: string,
      cookie: string,
      origin_ = origin,
    ) => request(app).post(path).set('Origin', origin_).set('Cookie', cookie).send({});
    it('state is owner-only', async () => {
      const app = appWith();
      expect((await request(app).get('/api/ops/budget')).status).toBe(401);
      const member = await login(app, 'member@example.test');
      expect((await request(app).get('/api/ops/budget').set('Cookie', member)).status).toBe(403);
      const owner = await login(app);
      const response = await request(app).get('/api/ops/budget').set('Cookie', owner);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        budget: { stopped: false, reason: null },
        emergencyStop: false,
        enabled: true,
      });
      const off = appWith({ push: null });
      const offCookie = await login(off);
      expect(
        (await request(off).get('/api/ops/budget').set('Cookie', offCookie)).body.enabled,
      ).toBe(false);
    });
    it('release needs the owner and the same origin, and only works while stopped', async () => {
      const guard = new BudgetGuard(budgetRepository);
      const app = appWith({ guard });
      const owner = await login(app);
      const member = await login(app, 'member@example.test');
      expect((await post(app, '/api/ops/budget/release', member)).status).toBe(403);
      expect(
        (await post(app, '/api/ops/budget/release', owner, 'https://evil.example')).status,
      ).toBe(403);
      expect((await post(app, '/api/ops/budget/release', owner)).status).toBe(409);
      await push(app, body({ costAmount: 30000 }));
      expect(await guard.status()).toBe('stopped');
      const state = await request(app).get('/api/ops/budget').set('Cookie', owner);
      expect(state.body.budget).toMatchObject({ stopped: true, reason: 'budget' });
      expect(state.body.emergencyStop).toBe(true);
      telegram.mockClear();
      const released = await post(app, '/api/ops/budget/release', owner);
      expect(released.status).toBe(200);
      expect(released.body).toMatchObject({
        budget: { stopped: false },
        emergencyStop: true,
        notification: { status: 'sent' },
      });
      // The cache of this instance is dropped at once.
      expect(await guard.status()).toBe('running');
      // One Telegram message, kind setting-risk-increase / budget-stop-released.
      expect(telegram).toHaveBeenCalledTimes(1);
      const text = JSON.parse((telegram.mock.calls[0][1] as { body: string }).body).text as string;
      expect(text).toContain('월 예산 정지 해제');
      const history = (await algorithmRepository.listEvents(10)).map((e) => e.kind);
      expect(history).toContain('budget-stop-released');
      expect(history).not.toContain('emergency-release');
      expect((await algorithmRepository.getControl()).emergencyStop).toBe(true);
      expect((await post(app, '/api/ops/budget/release', owner)).status).toBe(409);
    });
  });
});

describe('Terraform budget stop (static checks)', () => {
  const budget = readFileSync('infra/gcp/budget.tf', 'utf8');
  const main = readFileSync('infra/gcp/main.tf', 'utf8');
  const all = [main, budget].join('\n');
  it('creates the topic, the push subscription with an OIDC token and the dedicated identity', () => {
    expect(main).toContain('"pubsub.googleapis.com"');
    expect(budget).toMatch(
      /resource "google_pubsub_topic" "budget_alerts"[\s\S]*investing-budget-alerts/,
    );
    expect(budget).toContain('resource "google_pubsub_subscription" "budget_push"');
    expect(budget).toContain('push_endpoint = "${var.service_url}/api/internal/budget-alert"');
    expect(budget).toMatch(
      /oidc_token\s*\{[^}]*service_account_email\s*=\s*google_service_account\.budget_push\.email[^}]*audience\s*=\s*var\.service_url/,
    );
    expect(budget).toContain('account_id   = "investing-budget-push"');
    expect(main).toMatch(/all_updates_rule"?\s*\{[\s\S]*?schema_version\s*=\s*"1\.0"/);
    expect(main).toContain('google_pubsub_topic.budget_alerts');
  });
  it('keeps the default e-mail recipients and never disables billing', () => {
    expect(all).not.toContain('disable_default_iam_recipients');
    expect(all).not.toMatch(
      /cloudbilling\.googleapis\.com\/.*disable|billing_enabled|google_billing_project_info|billingEnabled/i,
    );
    expect(all).not.toMatch(/resource "google_billing_account_iam/);
  });
  it('gives the push service account no project roles; only the Pub/Sub agent may mint its token', () => {
    expect(budget).not.toMatch(/google_project_iam_(member|binding)"[^{]*\{[^}]*budget_push/);
    expect(budget).toMatch(
      /resource "google_service_account_iam_member" "pubsub_token_creator"[\s\S]*service_account_id\s*=\s*google_service_account\.budget_push\.name[\s\S]*roles\/iam\.serviceAccountTokenCreator[\s\S]*gcp-sa-pubsub\.iam\.gserviceaccount\.com/,
    );
    expect(budget).not.toContain('roles/owner');
    expect(budget).not.toContain('roles/editor');
  });
  it('the service URL variable has no default value and the deploy sets the two env values', () => {
    expect(budget).toMatch(/variable "service_url"[\s\S]*?default\s*=\s*""/);
    const deploy = readFileSync('.github/workflows/deploy.yml', 'utf8');
    expect(deploy).toContain('BUDGET_PUSH_AUDIENCE=$APP_ORIGIN');
    expect(deploy).toContain(
      'BUDGET_PUSH_SERVICE_ACCOUNT=investing-budget-push@$PROJECT.iam.gserviceaccount.com',
    );
  });
});
