import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JOB_NAME,
  jobConfiguration,
  liveRunId,
  liveTradingEnabled,
  main,
  runAlgoLive,
  type LiveJobDependencies,
  type LiveToss,
} from '../src/jobs/algo-live';
import { EXIT, JobConfigError, createJobLogger } from '../src/jobs/runner';
import { createPaperLedger, defaultSignalParams, type DailyBar } from '../src/lib/algo';
import type { AlgorithmRecord, SafeguardSettingsRecord } from '../src/lib/algorithmRecords';
import { defaultSafeguardSettings } from '../src/lib/algorithmRecords';
import type { AlgorithmDecider } from '../src/server/algorithm-ai';
import type { NotificationEvent } from '../src/server/notify';
import { MemoryPaperRepository } from '../src/server/paper';
import { MemoryTradingStore } from '../src/server/trading/stores';
import { TossOrderClient } from '../src/server/trading/toss-orders';
import {
  ProviderError,
  type MarketCalendar,
  type MarketCode,
  type MarketDay,
  type StockDailyCandle,
} from '../src/server/toss';
import { FakeToss, seedOrder } from './support/fake-toss';

// Synthetic data only. A fake Toss server stands behind the order transport: no network, no clock,
// no storage outside memory, and no real order is ever placed by this file.
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const at = (value: string) => new Date(value);
const KR_NOW = at('2026-10-21T09:05:00+09:00');

const day = (date: string, regular: [string, string] | null): MarketDay => ({
  date,
  regularMarket: regular ? { startTime: regular[0], endTime: regular[1] } : null,
});
const krCalendar = (holiday = false): MarketCalendar => ({
  source: 'fixture',
  asOf: '2026-10-21T00:00:00Z',
  market: 'KR',
  requestedDate: '2026-10-21',
  previousBusinessDay: day('2026-10-20', [
    '2026-10-20T09:00:00+09:00',
    '2026-10-20T15:30:00+09:00',
  ]),
  today: day(
    '2026-10-21',
    holiday ? null : ['2026-10-21T09:00:00+09:00', '2026-10-21T15:30:00+09:00'],
  ),
  nextBusinessDay: day('2026-10-22', ['2026-10-22T09:00:00+09:00', '2026-10-22T15:30:00+09:00']),
});
const usSummer = (): MarketCalendar => ({
  source: 'fixture',
  asOf: '2026-10-20T00:00:00Z',
  market: 'US',
  requestedDate: '2026-10-20',
  previousBusinessDay: day('2026-10-19', [
    '2026-10-19T22:30:00+09:00',
    '2026-10-20T05:00:00+09:00',
  ]),
  today: day('2026-10-20', ['2026-10-20T22:30:00+09:00', '2026-10-21T05:00:00+09:00']),
  nextBusinessDay: day('2026-10-21', ['2026-10-21T22:30:00+09:00', '2026-10-22T05:00:00+09:00']),
});
const usWinter = (): MarketCalendar => ({
  source: 'fixture',
  asOf: '2026-12-01T00:00:00Z',
  market: 'US',
  requestedDate: '2026-12-01',
  previousBusinessDay: day('2026-11-30', [
    '2026-11-30T23:30:00+09:00',
    '2026-12-01T06:00:00+09:00',
  ]),
  today: day('2026-12-01', ['2026-12-01T23:30:00+09:00', '2026-12-02T06:00:00+09:00']),
  nextBusinessDay: day('2026-12-02', ['2026-12-02T23:30:00+09:00', '2026-12-03T06:00:00+09:00']),
});

function flatBars(close: number, last: string, count = 60): DailyBar[] {
  const end = Date.parse(`${last}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(end - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return { date, open: close, high: close, low: close, close, volume: 1_000_000 };
  });
}
const candleOf = (b: DailyBar, currency: 'KRW' | 'USD'): StockDailyCandle => ({
  timestamp: `${b.date}T00:00:00+09:00`,
  date: b.date,
  open: String(b.open),
  high: String(b.high),
  low: String(b.low),
  close: String(b.close),
  volume: String(b.volume),
  currency,
});

const krRecord = (over: Partial<AlgorithmRecord> = {}): AlgorithmRecord => ({
  id: ID1,
  name: '실전 테스트',
  method: 'formula',
  template: 'custom',
  market: 'KR',
  currency: 'KRW',
  targets: ['005930'],
  signals: [{ id: 'momentum', weight: 1 }],
  buyThreshold: 0.4,
  sellThreshold: -0.4,
  mode: 'live',
  budget: 10_000_000,
  params: { ...structuredClone(defaultSignalParams), momentum: { lookbackDays: 1, scale: 0.1 } },
  targetsChangedAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  version: 1,
  ...over,
});
const usRecord = (over: Partial<AlgorithmRecord> = {}): AlgorithmRecord =>
  krRecord({
    market: 'US',
    currency: 'USD',
    targets: ['AAPL'],
    budget: 10_000,
    name: '미국 실전',
    ...over,
  });

type Scenario = {
  records?: AlgorithmRecord[];
  calendar?: MarketCalendar;
  market?: MarketCode;
  now?: Date;
  bars?: Record<string, DailyBar[]>;
  /** Decision-time prices (the Toss client's cached /prices) and fresh order-time quotes. */
  prices?: Record<string, number>;
  freshQuotes?: Record<string, { price: string; timestamp?: string | null }>;
  sellTaxRate?: number | null;
  paperLedger?: boolean;
  ai?: LiveJobDependencies['ai'];
  safeguards?: Partial<SafeguardSettingsRecord>;
  failSafeguards?: boolean;
  failControl?: boolean;
  notifyThrows?: boolean;
  noPaperHistory?: boolean;
  budget?: 'running' | 'stopped' | 'unknown';
};
function harness(s: Scenario = {}) {
  const market = s.market ?? 'KR';
  const currency = market === 'KR' ? 'KRW' : 'USD';
  let now = s.now ?? KR_NOW;
  const store = new MemoryTradingStore(() => now);
  const paper = new MemoryPaperRepository();
  const fake = new FakeToss();
  fake.now = () => now.getTime();
  const bars = s.bars ?? { '005930': flatBars(70_000, '2026-10-20') };
  const prices = s.prices ?? { '005930': 77_000 };
  for (const symbol of Object.keys(prices)) {
    fake.quotes.set(symbol, { price: String(prices[symbol]) });
    fake.priceLimits.set(
      symbol,
      market === 'KR'
        ? { upper: '200000', lower: '10000', currency: 'KRW' }
        : { upper: null, lower: null, currency: 'USD' },
    );
    fake.sellable.set(symbol, '1000');
  }
  for (const [symbol, quote] of Object.entries(s.freshQuotes ?? {})) fake.quotes.set(symbol, quote);
  const events: NotificationEvent[] = [];
  const logs: string[] = [];
  const toss = {
    marketCalendar: vi.fn(async () => s.calendar ?? krCalendar()),
    dailyCandles: vi.fn(async (symbol: string) => {
      const series = bars[symbol];
      if (!series) throw new ProviderError(404, 'PROVIDER_NOT_FOUND', 'x');
      return {
        candles: [...series].reverse().map((b) => candleOf(b, currency)),
        pages: 1,
        stopReason: 'EXHAUSTED' as const,
        complete: true,
      };
    }),
    prices: vi.fn(async (symbols: string[]) => ({
      source: 'fixture',
      asOf: now.toISOString(),
      prices: symbols
        .filter((symbol) => prices[symbol] !== undefined)
        .map((symbol) => ({
          symbol,
          lastPrice: String(prices[symbol]),
          currency: currency as 'KRW' | 'USD',
          timestamp: new Date(now.getTime() - 5_000).toISOString(),
        })),
    })),
  };
  const algorithms = {
    list: async () => s.records ?? [krRecord()],
    get: async (id: string) => (s.records ?? [krRecord()]).find((r) => r.id === id) ?? null,
    // The one emergency-stop flag: the same value the order path reads from its store.
    getControl: vi.fn(async () => {
      if (s.failControl) throw new Error('control unreadable');
      return { emergencyStop: await store.getEmergencyStop(), updatedAt: null };
    }),
    getCosts: async () => ({
      commissionRate: null,
      sellTaxRate: s.sellTaxRate === undefined ? 0.002 : s.sellTaxRate,
      capitalGainsTax: null,
      updatedAt: null,
    }),
    getSafeguards: async (): Promise<SafeguardSettingsRecord> => {
      if (s.failSafeguards) throw new Error('settings unreadable');
      return { ...structuredClone(defaultSafeguardSettings), updatedAt: null, ...s.safeguards };
    },
  };
  const client = new TossOrderClient(fake, { sleep: async () => {}, now: () => now.getTime() });
  const deps = (): LiveJobDependencies => ({
    toss: toss as unknown as LiveToss,
    transport: fake,
    client,
    store,
    paper,
    algorithms,
    notify: async (event) => {
      if (s.notifyThrows) throw new Error('telegram down');
      events.push(event);
    },
    ai: s.ai,
    ...(s.budget ? { budget: async () => s.budget! } : {}),
    now: () => now,
    sleep: async () => {},
    log: createJobLogger(JOB_NAME, (line) => logs.push(line)),
    options: { market, paceMs: 0, minSamples: 1 },
  });
  return {
    store,
    paper,
    fake,
    events,
    logs,
    toss,
    algorithms,
    setNow: (value: Date) => {
      now = value;
    },
    run: () => runAlgoLive(deps()),
    /** A paper ledger with one closed round trip in the top score bucket (the "record"). */
    seedPaperRecord: async (id = ID1, grossReturn = 0.05) => {
      const ledger = createPaperLedger({
        algorithmId: id,
        market,
        budget: 10_000_000,
        startedOn: '2026-10-05',
        now: '2026-10-05T00:00:00.000Z',
      });
      ledger.samples.push({
        score: 1,
        grossReturn,
        openedOn: '2026-10-06',
        closedOn: '2026-10-12',
      });
      await paper.commitDay(ledger, []);
    },
  };
}
const orderPosts = (fake: FakeToss) =>
  fake.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/orders');

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
describe('configuration and the deployment kill switch', () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    CLOUD_RUN_JOB: 'investing-algo-live',
    GOOGLE_CLOUD_PROJECT: 'test-project-1',
    TOSS_CLIENT_ID: 'client',
    TOSS_CLIENT_SECRET: 'secret',
    TOSS_ACCOUNT_SEQ: '123',
    TOSS_OWNER_USER_ID: 'owner',
    ALGO_MARKET: 'KR',
    LIVE_TRADING_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
    TELEGRAM_CHAT_ID: '987654321',
    APP_ORIGIN: 'https://invest.example.test',
  };
  it('accepts a complete production configuration', () => {
    expect(jobConfiguration(env).options).toEqual({ market: 'KR' });
    expect(jobConfiguration({ ...env, ALGO_MARKET: 'US' }).options.market).toBe('US');
  });
  it.each([
    ['unset', undefined],
    ['false', 'false'],
    ['empty', ''],
    ['True', 'True'],
    ['TRUE', 'TRUE'],
    ['1', '1'],
    ['yes', 'yes'],
    ['leading space', ' true'],
    ['trailing space', 'true '],
  ])('refuses to run when LIVE_TRADING_ENABLED is %s', (_name, value) => {
    expect(() => jobConfiguration({ ...env, LIVE_TRADING_ENABLED: value })).toThrow(JobConfigError);
    expect(liveTradingEnabled({ LIVE_TRADING_ENABLED: value })).toBe(false);
  });
  it('the flag alone is not enough: production, a Cloud Run Job, a project, Toss, a market and Telegram', () => {
    expect(liveTradingEnabled({ LIVE_TRADING_ENABLED: 'true' })).toBe(true);
    for (const patch of [
      { NODE_ENV: 'development' },
      { CLOUD_RUN_JOB: undefined },
      { GOOGLE_CLOUD_PROJECT: undefined },
      { GOOGLE_CLOUD_PROJECT: 'X' },
      { TOSS_CLIENT_ID: undefined },
      { TOSS_ACCOUNT_SEQ: 'abc' },
      { TOSS_OWNER_USER_ID: undefined },
      { ALGO_MARKET: undefined },
      { ALGO_MARKET: 'JP' },
      { TELEGRAM_BOT_TOKEN: undefined },
      { TELEGRAM_BOT_TOKEN: 'not-a-token' },
      { TELEGRAM_CHAT_ID: undefined },
      { APP_ORIGIN: undefined },
      { APP_ORIGIN: 'http://insecure.example.test' },
    ])
      expect(() => jobConfiguration({ ...env, ...patch }), JSON.stringify(patch)).toThrow(
        JobConfigError,
      );
  });
  it('has no environment switch for the open window or any safeguard', () => {
    const config = jobConfiguration({
      ...env,
      ALGO_OPEN_WINDOW_MINUTES: '120',
      ALGO_PAPER_SLIPPAGE_BPS: '5',
      ALGO_MAX_ORDERS: '99',
    });
    expect(config.options).toEqual({ market: 'KR' });
  });
  it('main() exits with the configuration code without touching the network or Firestore when the switch is off', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(String(line));
    });
    for (const value of [undefined, 'false', 'True']) {
      const code = await main({ ...env, LIVE_TRADING_ENABLED: value });
      expect(code).toBe(EXIT.CONFIG);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('JOB_CONFIG_INVALID');
    log.mockRestore();
  });
});

// ---------------------------------------------------------------------------
describe('algo-live job: the order path with a fake Toss server', () => {
  it('decides like the paper job and places exactly one LIMIT + DAY order through the executor', async () => {
    const h = harness();
    await h.seedPaperRecord();
    await expect(h.run()).resolves.toBe('ok');
    const posts = orderPosts(h.fake);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({
      clientOrderId: expect.stringMatching(/^ai-[0-9a-f]{28}$/),
      symbol: '005930',
      side: 'BUY',
      orderType: 'LIMIT',
      timeInForce: 'DAY',
      quantity: '129', // 10,000,000 / (77,000 * 1.00015)
      price: '77000',
    });
    // The only write that ever reached the transport is the order creation.
    expect(h.fake.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    const [order] = await h.store.listOrders({ algorithmId: ID1 });
    expect(order).toMatchObject({ status: 'accepted', side: 'buy', quantity: 129, market: 'KR' });
    const run = h.paper.runs.get(liveRunId('KR', '2026-10-21'))!;
    expect(run).toMatchObject({ status: 'complete', market: 'KR', date: '2026-10-21' });
    expect(run.results[ID1]).toMatchObject({ status: 'applied', fills: 1 });
    expect(await h.store.getJobHeartbeat('KR')).toMatchObject({
      market: 'KR',
      outcome: 'ok',
      date: '2026-10-21',
    });
    // Order-time facts were read fresh from the broker, uncached.
    expect(h.fake.calls.some((c) => c.path === '/api/v1/prices')).toBe(true);
    expect(h.fake.calls.some((c) => c.path === '/api/v1/commissions')).toBe(true);
    // Logs carry no symbol, amount or id.
    const logs = h.logs.join('\n');
    expect(logs).not.toMatch(/005930|77000|129|ai-[0-9a-f]{8}|order-1/);
  });

  it('runs only live algorithms of its own market', async () => {
    const h = harness({
      records: [
        krRecord({ id: ID1, mode: 'paper', name: '모의' }),
        krRecord({ id: ID2, mode: 'simulation', name: '시뮬', targets: ['000660'] }),
        usRecord({ id: '33333333-3333-4333-8333-333333333333' }),
      ],
    });
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(h.paper.runs.get(liveRunId('KR', '2026-10-21'))?.results).toEqual({});
  });

  it('holds the order when there is no record: 기록 부족으로 주문 보류', async () => {
    const h = harness();
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    const blocked = h.store.listBlocked();
    expect(blocked).toHaveLength(1);
    expect(blocked[0].reasons).toEqual(['HISTORY_INSUFFICIENT']);
    const result = h.paper.runs.get(liveRunId('KR', '2026-10-21'))!.results[ID1];
    expect(result.heldBack.insufficientHistory).toBe(1);
    expect(result.rejections).toEqual({ HISTORY_INSUFFICIENT: 1 });
    expect(h.events).toEqual([]); // a routine hold is not an alert
  });

  it('holds the order when the expected profit does not beat the round-trip cost', async () => {
    const h = harness();
    await h.seedPaperRecord(ID1, 0.001);
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(h.store.listBlocked()[0].reasons).toEqual(['EXPECTED_PROFIT_BELOW_COST']);
  });

  it('stays out of the window: no broker call at all and a skipped heartbeat', async () => {
    const h = harness({ now: at('2026-10-21T10:00:00+09:00') });
    await expect(h.run()).resolves.toBe('ok');
    expect(h.fake.calls).toHaveLength(0);
    expect(h.toss.prices).not.toHaveBeenCalled();
    expect(await h.store.getJobHeartbeat('KR')).toMatchObject({
      outcome: 'skipped',
      code: 'OUTSIDE_OPEN_WINDOW',
    });
    expect(h.paper.runs.size).toBe(0);
  });

  it('a holiday places nothing', async () => {
    const h = harness({ calendar: krCalendar(true) });
    await h.run();
    expect(h.fake.calls).toHaveLength(0);
    expect(await h.store.getJobHeartbeat('KR')).toMatchObject({ code: 'MARKET_CLOSED_TODAY' });
  });

  it('a second invocation for the same market and date neither reconciles nor orders again', async () => {
    const h = harness();
    await h.seedPaperRecord();
    await h.run();
    const calls = h.fake.calls.length;
    h.setNow(at('2026-10-21T09:10:00+09:00'));
    await expect(h.run()).resolves.toBe('ok');
    expect(h.fake.calls.length).toBe(calls);
    expect(orderPosts(h.fake)).toHaveLength(1);
    expect(await h.store.getJobHeartbeat('KR')).toMatchObject({ code: 'RUN_ALREADY_COMPLETE' });
  });

  it('a calendar failure is a failed run with a job-failure alert and no order', async () => {
    const h = harness();
    h.toss.marketCalendar.mockRejectedValueOnce(
      new ProviderError(503, 'PROVIDER_UNAVAILABLE', 'x'),
    );
    await expect(h.run()).resolves.toBe('failed');
    expect(h.fake.calls).toHaveLength(0);
    expect(h.events).toEqual([{ kind: 'job-failure', jobName: 'algo-live' }]);
    expect(await h.store.getJobHeartbeat('KR')).toMatchObject({ outcome: 'failed' });
  });

  it('a failing notifier never blocks trading', async () => {
    const h = harness({ notifyThrows: true });
    await h.seedPaperRecord();
    await expect(h.run()).resolves.toBe('ok');
    expect(orderPosts(h.fake)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('algo-live job: US sessions and daylight saving time', () => {
  const usEnv = (calendar: MarketCalendar, now: string) =>
    harness({
      market: 'US',
      calendar,
      now: at(now),
      records: [usRecord()],
      bars: {
        AAPL: flatBars(200, calendar.previousBusinessDay.date),
      },
      prices: { AAPL: 220 },
    });
  it('summer: the 22:35 slot orders in USD, the 23:35 slot finds nothing to do', async () => {
    const early = usEnv(usSummer(), '2026-10-20T22:35:00+09:00');
    await early.seedPaperRecord(ID1);
    await expect(early.run()).resolves.toBe('ok');
    const [post] = orderPosts(early.fake);
    expect(post.body).toMatchObject({
      symbol: 'AAPL',
      side: 'BUY',
      price: '220',
      quantity: '45', // 10,000 / (220 * 1.0025)
    });
    expect(early.fake.calls.some((c) => c.path === '/api/v1/exchange-rate')).toBe(true);
    // Only the account's dollars are checked (no currency conversion anywhere).
    const power = early.fake.calls.filter((c) => c.path === '/api/v1/buying-power');
    expect(power.every((c) => c.query?.currency === 'USD')).toBe(true);
    const late = usEnv(usSummer(), '2026-10-20T23:35:00+09:00');
    await late.seedPaperRecord(ID1);
    await expect(late.run()).resolves.toBe('ok');
    expect(late.fake.calls).toHaveLength(0);
    expect(await late.store.getJobHeartbeat('US')).toMatchObject({ code: 'OUTSIDE_OPEN_WINDOW' });
  });
  it('winter: the 22:35 slot is before the open, the 23:35 slot orders', async () => {
    const early = usEnv(usWinter(), '2026-12-01T22:35:00+09:00');
    await early.seedPaperRecord(ID1);
    await early.run();
    expect(early.fake.calls).toHaveLength(0);
    expect(await early.store.getJobHeartbeat('US')).toMatchObject({
      code: 'SESSION_NOT_OPEN_YET',
    });
    const late = usEnv(usWinter(), '2026-12-01T23:35:00+09:00');
    await late.seedPaperRecord(ID1);
    await late.run();
    expect(orderPosts(late.fake)).toHaveLength(1);
    expect(late.paper.runs.has(liveRunId('US', '2026-12-01'))).toBe(true);
  });
  it('without a usable exchange rate a US order is held (no 1e8 cap check without it)', async () => {
    const h = usEnv(usSummer(), '2026-10-20T22:35:00+09:00');
    await h.seedPaperRecord(ID1);
    h.fake.fx = null;
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(h.store.listBlocked()[0].reasons).toEqual(['FX_RATE_MISSING']);
  });
  it('an exchange rate outside the plausible band is refused', async () => {
    const h = usEnv(usSummer(), '2026-10-20T22:35:00+09:00');
    await h.seedPaperRecord(ID1);
    h.fake.fx = { midRate: '14' };
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(h.store.listBlocked()[0].reasons).toEqual(['FX_RATE_INVALID']);
  });
  it('a stale exchange rate (validity window long over) is refused', async () => {
    const h = usEnv(usSummer(), '2026-10-20T22:35:00+09:00');
    await h.seedPaperRecord(ID1);
    h.fake.fx = {
      midRate: '1400',
      validFrom: '2026-10-19T00:00:00.000Z',
      validUntil: '2026-10-19T06:00:00.000Z',
    };
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(h.store.listBlocked()[0].reasons).toEqual(['FX_RATE_STALE']);
  });
});

// ---------------------------------------------------------------------------
describe('algo-live job: emergency stop and algorithm state', () => {
  it('an emergency stop before the run skips every algorithm and reaches no order endpoint', async () => {
    const h = harness();
    await h.seedPaperRecord();
    h.store.setEmergencyStop(true);
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(h.toss.prices).not.toHaveBeenCalled();
    const result = h.paper.runs.get(liveRunId('KR', '2026-10-21'))!.results[ID1];
    expect(result).toMatchObject({ status: 'skipped', code: 'EMERGENCY_STOP' });
  });

  it('an emergency stop pressed after the first order stops the rest of the same run', async () => {
    const h = harness({
      records: [krRecord({ targets: ['005930', '000660'] })],
      bars: {
        '005930': flatBars(70_000, '2026-10-20'),
        '000660': flatBars(70_000, '2026-10-20'),
      },
      prices: { '005930': 77_000, '000660': 77_000 },
    });
    await h.seedPaperRecord();
    h.fake.onCreated = () => h.store.setEmergencyStop(true); // pressed right after the first order
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(1);
    const blocked = h.store.listBlocked();
    expect(blocked).toHaveLength(1);
    expect(blocked[0].reasons).toContain('EMERGENCY_STOP');
    // The pre-trade check reads it fresh: the second order never got a reservation.
    expect(await h.store.listOrders({ algorithmId: ID1 })).toHaveLength(1);
  });

  it('the stop is read again for every algorithm, not once per run', async () => {
    const h = harness({
      records: [
        krRecord({ id: ID1, name: 'A' }),
        krRecord({ id: ID2, name: 'B', targets: ['000660'] }),
      ],
      bars: {
        '005930': flatBars(70_000, '2026-10-20'),
        '000660': flatBars(70_000, '2026-10-20'),
      },
      prices: { '005930': 77_000, '000660': 77_000 },
    });
    await h.seedPaperRecord(ID1);
    await h.seedPaperRecord(ID2);
    h.fake.onCreated = () => h.store.setEmergencyStop(true);
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(1);
    const results = h.paper.runs.get(liveRunId('KR', '2026-10-21'))!.results;
    expect(results[ID1].status).toBe('applied');
    expect(results[ID2]).toMatchObject({ status: 'skipped', code: 'EMERGENCY_STOP' });
    expect(h.algorithms.getControl.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('an unreadable emergency stop means nothing is ordered', async () => {
    const h = harness({ failControl: true });
    await h.seedPaperRecord();
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(h.paper.runs.get(liveRunId('KR', '2026-10-21'))!.results[ID1]).toMatchObject({
      code: 'CONTROL_UNAVAILABLE',
    });
  });

  it('a stopped algorithm is skipped until the stop is released', async () => {
    const h = harness();
    await h.seedPaperRecord();
    await h.store.stopAlgorithm(ID1, 'loss-limit');
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(h.paper.runs.get(liveRunId('KR', '2026-10-21'))!.results[ID1]).toMatchObject({
      code: 'ALGORITHM_STOPPED',
    });
  });

  it('missing safeguard settings fail the algorithm closed', async () => {
    const h = harness({ failSafeguards: true });
    await h.seedPaperRecord();
    await expect(h.run()).resolves.toBe('failed');
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(h.events).toContainEqual({ kind: 'job-failure', jobName: 'algo-live' });
  });

  it('uses the stored safeguard settings, e.g. a lower daily order limit', async () => {
    const h = harness({
      records: [krRecord({ targets: ['005930', '000660'] })],
      bars: {
        '005930': flatBars(70_000, '2026-10-20'),
        '000660': flatBars(70_000, '2026-10-20'),
      },
      prices: { '005930': 77_000, '000660': 77_000 },
      safeguards: { maxOrdersPerDay: 1 },
    });
    await h.seedPaperRecord();
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(1);
    expect(h.store.listBlocked()[0].reasons).toEqual(['DAILY_LIMIT_ALGORITHM']);
  });

  it('a run lease held by another run blocks all orders of that algorithm', async () => {
    const h = harness();
    await h.seedPaperRecord();
    expect(await h.store.acquireRunLease(ID1, 'someone-else', 600_000)).toBe(true);
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(h.paper.runs.get(liveRunId('KR', '2026-10-21'))!.results[ID1]).toMatchObject({
      status: 'skipped',
      code: 'RUN_IN_PROGRESS',
    });
  });
});

// ---------------------------------------------------------------------------
describe('algo-live job: requirements before any order', () => {
  it.each([
    ['no budget', { budget: null }, 'BUDGET_NOT_SET'],
    [
      'a value signal',
      {
        signals: [
          { id: 'momentum' as const, weight: 0.5 },
          { id: 'value' as const, weight: 0.5 },
        ],
      },
      'FINANCIALS_MISSING',
    ],
  ])('%s: skipped, nothing reaches the broker', async (_name, patch, code) => {
    const h = harness({ records: [krRecord(patch)] });
    await h.seedPaperRecord();
    await h.run();
    expect(h.fake.calls.filter((c) => c.path !== '/api/v1/commissions')).toHaveLength(0);
    expect(h.paper.runs.get(liveRunId('KR', '2026-10-21'))!.results[ID1]).toMatchObject({
      status: 'skipped',
      code,
    });
  });

  it('without the Korean transaction-tax setting a buy is not ordered', async () => {
    const h = harness({ sellTaxRate: null });
    await h.seedPaperRecord();
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(h.store.listBlocked()[0].reasons).toEqual(['COST_SETTINGS_MISSING']);
    const notes = h.paper.runs.get(liveRunId('KR', '2026-10-21'))!.results[ID1].notes.join(' ');
    expect(notes).toContain('증권거래세율');
  });

  it('a quote older than a minute is refused at order time', async () => {
    const h = harness({
      freshQuotes: { '005930': { price: '77000', timestamp: '2026-10-21T00:03:00.000Z' } },
    });
    await h.seedPaperRecord();
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(h.store.listBlocked()[0].reasons).toEqual(['QUOTE_STALE']);
  });

  it('a missing daily bar for the previous trading day holds the symbol (not even decided)', async () => {
    const h = harness({ bars: { '005930': flatBars(70_000, '2026-10-16') } });
    await h.seedPaperRecord();
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(h.paper.runs.get(liveRunId('KR', '2026-10-21'))!.results[ID1].status).toBe('failed');
  });

  it('a liquidity floor above the stock average blocks the buy', async () => {
    const h = harness({ safeguards: { liquidityMinAvgValue: { KRW: 1e12, USD: 5e6 } } });
    await h.seedPaperRecord();
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(h.store.listBlocked()[0].reasons).toEqual(['LIQUIDITY_BELOW_MINIMUM']);
  });

  it('a stock warning and an open order each block the order', async () => {
    const warned = harness();
    await warned.seedPaperRecord();
    warned.fake.warnings.set('005930', [
      { warningType: 'INVESTMENT_WARNING', exchange: null, startDate: null, endDate: null },
    ]);
    await warned.run();
    expect(orderPosts(warned.fake)).toHaveLength(0);
    expect(warned.store.listBlocked()[0].reasons).toEqual(['STOCK_WARNING']);
  });

  it('insufficient buying power holds the order (the account is never topped up)', async () => {
    const h = harness();
    await h.seedPaperRecord();
    h.fake.buyingPower.KRW = '1000';
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(h.store.listBlocked()[0].reasons).toEqual(['BUYING_POWER_INSUFFICIENT']);
  });
});

// ---------------------------------------------------------------------------
describe('algo-live job: AI-method algorithms', () => {
  const ai = (calls: { n: number }): AlgorithmDecider => ({
    async decide(input) {
      calls.n++;
      return {
        status: 'ready',
        model: 'test-model',
        decisions: Object.fromEntries(
          input.symbols.map((s) => [
            s.symbol,
            {
              symbol: s.symbol,
              decision: 'buy' as const,
              reasons: ['테스트 근거'],
              expectedReturn: { low: 0.04, high: 0.06 },
            },
          ]),
        ),
      };
    },
  });
  it('is idle without ALGO_AI_ENABLED: no price read, no AI call, no order', async () => {
    const calls = { n: 0 };
    for (const aiOptions of [undefined, { enabled: false, decider: ai(calls) }]) {
      const h = harness({ records: [krRecord({ method: 'ai' })], ai: aiOptions });
      await h.run();
      expect(h.fake.calls.filter((c) => c.path !== '/api/v1/commissions')).toHaveLength(0);
      expect(h.toss.prices).not.toHaveBeenCalled();
      expect(h.paper.runs.get(liveRunId('KR', '2026-10-21'))!.results[ID1]).toMatchObject({
        status: 'skipped',
        code: 'AI_APPROVAL_PENDING',
      });
    }
    expect(calls.n).toBe(0);
  });
  it('when enabled it uses the model decision and its expected return for the cost rule', async () => {
    const calls = { n: 0 };
    const h = harness({
      records: [krRecord({ method: 'ai' })],
      ai: { enabled: true, decider: ai(calls) },
    });
    await h.run();
    expect(calls.n).toBe(1);
    expect(orderPosts(h.fake)).toHaveLength(1);
  });
  it('an expected return below the round-trip cost is held', async () => {
    const calls = { n: 0 };
    const low: AlgorithmDecider = {
      async decide(input) {
        calls.n++;
        return {
          status: 'ready',
          model: 'm',
          decisions: {
            [input.symbols[0].symbol]: {
              symbol: input.symbols[0].symbol,
              decision: 'buy',
              reasons: ['x'],
              expectedReturn: { low: 0, high: 0.002 },
            },
          },
        };
      },
    };
    const h = harness({
      records: [krRecord({ method: 'ai' })],
      ai: { enabled: true, decider: low },
    });
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(h.store.listBlocked()[0].reasons).toEqual(['EXPECTED_PROFIT_BELOW_COST']);
  });
});

// ---------------------------------------------------------------------------
describe('algo-live job: reconcile before the run', () => {
  it('reconciles earlier orders first, so a filled buy counts as owned and is not bought again', async () => {
    const h = harness();
    await h.seedPaperRecord();
    await seedOrder(
      h.store,
      {
        clientOrderId: 'ai-earlier',
        algorithmId: ID1,
        quantity: 20,
        price: '70000',
        createdAt: '2026-10-20T01:00:00.000Z',
      },
      'accepted',
    );
    const [seeded] = await h.store.listOrders({ algorithmId: ID1 });
    h.fake.orders.push({
      orderId: seeded.orderId!,
      clientOrderId: null,
      symbol: '005930',
      side: 'BUY',
      orderType: 'LIMIT',
      timeInForce: 'DAY',
      status: 'FILLED',
      price: '70000',
      quantity: '20',
      currency: 'KRW',
      orderedAt: '2026-10-20T01:00:00.000Z',
      filledQuantity: '20',
      averageFilledPrice: '69900',
    });
    await h.run();
    // The very first broker call is the reconciliation read, before any quote or order.
    expect(h.fake.calls[0].path).toBe(`/api/v1/orders/${encodeURIComponent(seeded.orderId!)}`);
    const reconciled = await h.store.getOrder('ai-earlier');
    expect(reconciled).toMatchObject({ status: 'filled', filledQuantity: 20 });
    expect(orderPosts(h.fake)).toHaveLength(0); // already owned: no second buy
    expect(h.events).toContainEqual({
      kind: 'fill',
      mode: 'live',
      symbol: '005930',
      side: 'buy',
      status: 'filled',
      algorithmName: '실전 테스트',
    });
  });

  it('a reconcile failure never lets a new order through for an unconfirmed symbol', async () => {
    const h = harness();
    await h.seedPaperRecord();
    await seedOrder(
      h.store,
      { clientOrderId: 'ai-unknown', algorithmId: ID1, createdAt: '2026-10-20T01:00:00.000Z' },
      'unknown',
    );
    h.fake.getFailures.set('/api/v1/orders', { status: 500, code: 'internal-error' });
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(await h.store.getOrder('ai-unknown')).toMatchObject({ status: 'unknown' });
  });

  it('a working order from an earlier day keeps its symbol blocked', async () => {
    const h = harness();
    await h.seedPaperRecord();
    await seedOrder(
      h.store,
      { clientOrderId: 'ai-open', algorithmId: ID1, createdAt: '2026-10-20T01:00:00.000Z' },
      'accepted',
    );
    const [seeded] = await h.store.listOrders({ algorithmId: ID1 });
    h.fake.orders.push({
      orderId: seeded.orderId!,
      clientOrderId: null,
      symbol: '005930',
      side: 'BUY',
      orderType: 'LIMIT',
      timeInForce: 'DAY',
      status: 'PENDING',
      price: '70000',
      quantity: '10',
      currency: 'KRW',
      orderedAt: '2026-10-20T01:00:00.000Z',
      filledQuantity: '0',
      averageFilledPrice: null,
    });
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('algo-live job: first-order rejection, permission stop and unconfirmed orders', () => {
  it('the first live order being refused stops the algorithm and notifies; the next day does nothing', async () => {
    const h = harness();
    await h.seedPaperRecord();
    h.fake.postScript = [{ kind: 'status', status: 422, code: 'account-restricted' }];
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(1);
    expect(await h.store.isAlgorithmStopped(ID1)).toBe(true);
    expect(h.store.stoppedReason(ID1)).toBe('first-order-rejected');
    expect(h.events).toEqual([
      {
        kind: 'order-rejected',
        mode: 'live',
        symbol: '005930',
        side: 'buy',
        algorithmName: '실전 테스트',
        reason: 'broker-rejected',
      },
      {
        kind: 'algorithm-auto-stop',
        mode: 'live',
        algorithmName: '실전 테스트',
        reason: 'first-order-rejected',
      },
    ]);
    expect(h.paper.runs.get(liveRunId('KR', '2026-10-21'))!.results[ID1]).toMatchObject({
      status: 'applied',
      stoppedNow: true,
    });
    // Next trading day: skipped before any broker call.
    const calls = h.fake.calls.length;
    h.setNow(at('2026-10-22T09:05:00+09:00'));
    h.toss.marketCalendar.mockResolvedValue({
      ...krCalendar(),
      requestedDate: '2026-10-22',
      previousBusinessDay: day('2026-10-21', [
        '2026-10-21T09:00:00+09:00',
        '2026-10-21T15:30:00+09:00',
      ]),
      today: day('2026-10-22', ['2026-10-22T09:00:00+09:00', '2026-10-22T15:30:00+09:00']),
    });
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(1);
    expect(h.paper.runs.get(liveRunId('KR', '2026-10-22'))!.results[ID1]).toMatchObject({
      code: 'ALGORITHM_STOPPED',
    });
    // Only the reconcile read (of nothing) may have happened.
    expect(h.fake.calls.length).toBeLessThanOrEqual(calls + 1);
  });

  it.each([401, 403])(
    'HTTP %i on the order is a permission stop with its own reason',
    async (status) => {
      const h = harness();
      await h.seedPaperRecord();
      h.fake.postScript = [{ kind: 'status', status, code: 'forbidden' }];
      await h.run();
      expect(await h.store.isAlgorithmStopped(ID1)).toBe(true);
      expect(h.store.stoppedReason(ID1)).toBe('order-permission');
      expect(h.events.at(-1)).toEqual({
        kind: 'algorithm-auto-stop',
        mode: 'live',
        algorithmName: '실전 테스트',
        reason: 'order-permission',
      });
    },
  );

  it('a lost answer is "unconfirmed": alerted, recorded, and the symbol stays blocked on the next run', async () => {
    const h = harness();
    await h.seedPaperRecord();
    h.fake.postScript = Array.from({ length: 3 }, () => ({ kind: 'network' as const }));
    await h.run();
    const [order] = await h.store.listOrders({ algorithmId: ID1 });
    expect(order.status).toBe('unknown');
    expect(h.events).toEqual([
      {
        kind: 'live-order-unconfirmed',
        mode: 'live',
        symbol: '005930',
        side: 'buy',
        algorithmName: '실전 테스트',
      },
    ]);
    expect(await h.store.isAlgorithmStopped(ID1)).toBe(false);
    const result = h.paper.runs.get(liveRunId('KR', '2026-10-21'))!.results[ID1];
    expect(result.rejections).toEqual({ ORDER_UNCONFIRMED: 1 });
    expect(result.notes.join(' ')).toContain('접수 여부를 확인하지 못했습니다');
  });

  it('a rate-limit refusal of the first order is transient: no stop', async () => {
    const h = harness();
    await h.seedPaperRecord();
    h.fake.postScript = Array.from({ length: 3 }, () => ({
      kind: 'status' as const,
      status: 429,
      code: 'rate-limit-exceeded',
      retryAfter: 1,
    }));
    await h.run();
    expect(await h.store.isAlgorithmStopped(ID1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('algo-live job: selling only what the algorithm bought', () => {
  const heldEnv = (buyDate: string, price = 63_000) => {
    const h = harness({ prices: { '005930': price } });
    return { h, buyDate };
  };
  it('sells the algorithm-owned shares after the minimum holding period', async () => {
    const { h } = heldEnv('2026-10-10');
    await h.seedPaperRecord();
    await seedOrder(h.store, {
      clientOrderId: 'ai-bought',
      algorithmId: ID1,
      quantity: 10,
      price: '70000',
      createdAt: '2026-10-10T01:00:00.000Z',
    });
    await h.run();
    const [post] = orderPosts(h.fake);
    expect(post.body).toMatchObject({
      symbol: '005930',
      side: 'SELL',
      quantity: '10',
      price: '63000',
    });
  });
  it('never sells more than it owns and protects direct holdings (the sellable quantity is not the cap)', async () => {
    const { h } = heldEnv('2026-10-10');
    h.fake.sellable.set('005930', '5000'); // the account holds many more shares in total
    await h.seedPaperRecord();
    await seedOrder(h.store, {
      clientOrderId: 'ai-bought',
      algorithmId: ID1,
      quantity: 10,
      price: '70000',
      createdAt: '2026-10-10T01:00:00.000Z',
    });
    await h.run();
    expect(orderPosts(h.fake).map((p) => p.body?.quantity)).toEqual(['10']);
  });
  it('keeps a young position despite a sell signal (minimum holding period)', async () => {
    const { h } = heldEnv('2026-10-19');
    await h.seedPaperRecord();
    await seedOrder(h.store, {
      clientOrderId: 'ai-bought',
      algorithmId: ID1,
      quantity: 10,
      price: '70000',
      createdAt: '2026-10-19T01:00:00.000Z',
    });
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(h.store.listBlocked()[0].reasons).toEqual(['MIN_HOLDING_PERIOD']);
  });
  it('a cumulative loss at the limit stops the algorithm instead of ordering', async () => {
    const { h } = heldEnv('2026-10-10', 40_000);
    await h.seedPaperRecord();
    await seedOrder(h.store, {
      clientOrderId: 'ai-bought',
      algorithmId: ID1,
      quantity: 100,
      price: '70000',
      createdAt: '2026-10-10T01:00:00.000Z',
    });
    // 100 shares bought at 70,000 and worth 40,000 now: -3,000,000 of a 10,000,000 budget (-30%).
    h.fake.sellable.set('005930', '100');
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(await h.store.isAlgorithmStopped(ID1)).toBe(true);
    expect(h.store.stoppedReason(ID1)).toBe('loss-limit');
    expect(h.events.at(-1)).toMatchObject({ kind: 'algorithm-auto-stop', reason: 'loss-limit' });
  });
});

// ---------------------------------------------------------------------------
describe('algo-live job: unconfirmed orders (lost answers)', () => {
  const unknownOrder = {
    clientOrderId: 'ai-lost',
    algorithmId: ID1,
    quantity: 20,
    price: '70000',
    createdAt: '2026-10-20T01:00:00.000Z',
  };
  const closedFill = (over: Record<string, unknown> = {}) => ({
    orderId: 'broker-1',
    clientOrderId: null,
    symbol: '005930',
    side: 'BUY' as const,
    orderType: 'LIMIT',
    timeInForce: 'DAY',
    status: 'FILLED',
    price: '70000',
    quantity: '20',
    currency: 'KRW' as const,
    orderedAt: '2026-10-20T01:00:05.000Z',
    filledQuantity: '20',
    averageFilledPrice: '69900',
    ...over,
  });

  it('adopts an exact unique CLOSED match: an unknown order that actually filled becomes a position', async () => {
    const h = harness();
    await h.seedPaperRecord();
    await seedOrder(h.store, unknownOrder, 'unknown');
    h.fake.orders.push(closedFill());
    await h.run();
    const closedCall = h.fake.calls.find(
      (c) => c.path === '/api/v1/orders' && c.query?.status === 'CLOSED',
    );
    expect(closedCall?.query).toMatchObject({ status: 'CLOSED', symbol: '005930', limit: '100' });
    expect(await h.store.getOrder('ai-lost')).toMatchObject({
      status: 'filled',
      orderId: 'broker-1',
      filledQuantity: 20,
      averageFilledPrice: 69_900,
    });
    expect(await h.store.isAlgorithmStopped(ID1)).toBe(false);
    expect(orderPosts(h.fake)).toHaveLength(0); // now owned: no second buy
    expect(h.events).toContainEqual(expect.objectContaining({ kind: 'fill', status: 'filled' }));
  });
  it('adopts a CLOSED cancellation (an expired DAY order) so the symbol is free again', async () => {
    const h = harness();
    await h.seedPaperRecord();
    await seedOrder(h.store, unknownOrder, 'unknown');
    h.fake.orders.push(
      closedFill({ status: 'CANCELED', filledQuantity: '0', averageFilledPrice: null }),
    );
    await h.run();
    expect(await h.store.getOrder('ai-lost')).toMatchObject({
      status: 'canceled',
      filledQuantity: 0,
    });
    expect(orderPosts(h.fake)).toHaveLength(1); // the symbol is unlocked: today's buy goes out
  });
  it('never adopts an ambiguous or look-alike match', async () => {
    for (const orders of [
      [closedFill(), closedFill({ orderId: 'broker-2' })], // two identical candidates
      [closedFill({ orderedAt: '2026-10-19T23:00:00.000Z' })], // placed before the record existed
      [closedFill({ quantity: '21' })],
      [closedFill({ price: '70100' })],
      [closedFill({ side: 'SELL' as const })],
    ]) {
      const h = harness();
      await h.seedPaperRecord();
      await seedOrder(h.store, unknownOrder, 'unknown');
      for (const o of orders) h.fake.orders.push(o);
      await h.run();
      expect((await h.store.getOrder('ai-lost'))?.status).toBe('unknown');
    }
  });
  it('an unknown order older than one session stops the algorithm with its own reason and alert', async () => {
    const h = harness();
    await h.seedPaperRecord();
    await seedOrder(h.store, unknownOrder, 'unknown');
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(await h.store.isAlgorithmStopped(ID1)).toBe(true);
    expect(h.store.stoppedReason(ID1)).toBe('unconfirmed-order');
    expect(h.events).toEqual([
      {
        kind: 'algorithm-auto-stop',
        mode: 'live',
        algorithmName: '실전 테스트',
        reason: 'unconfirmed-order',
      },
    ]);
    expect(h.paper.runs.get(liveRunId('KR', '2026-10-21'))!.results[ID1]).toMatchObject({
      code: 'UNCONFIRMED_ORDER_STOP',
      stoppedNow: true,
    });
  });
  it('an unknown order from today only blocks its symbol (no stop yet)', async () => {
    const h = harness();
    await h.seedPaperRecord();
    await seedOrder(h.store, { ...unknownOrder, createdAt: '2026-10-21T00:01:00.000Z' }, 'unknown');
    await h.run();
    expect(await h.store.isAlgorithmStopped(ID1)).toBe(false);
    expect(orderPosts(h.fake)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('algo-live job: loss stop every run, marks and per-order guard', () => {
  // A huge scale keeps the score near zero: the algorithm only holds.
  const holder = (over: Partial<AlgorithmRecord> = {}) =>
    krRecord({
      params: { ...structuredClone(defaultSignalParams), momentum: { lookbackDays: 1, scale: 10 } },
      ...over,
    });
  const held = {
    clientOrderId: 'ai-held',
    algorithmId: ID1,
    quantity: 100,
    price: '70000',
    createdAt: '2026-10-10T01:00:00.000Z',
  };

  it('stops and alerts at the loss limit even when there is no intent at all', async () => {
    const h = harness({ records: [holder()], prices: { '005930': 40_000 } });
    await h.seedPaperRecord();
    await seedOrder(h.store, held);
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(await h.store.isAlgorithmStopped(ID1)).toBe(true);
    expect(h.store.stoppedReason(ID1)).toBe('loss-limit');
    expect(h.events).toEqual([
      {
        kind: 'algorithm-auto-stop',
        mode: 'live',
        algorithmName: '실전 테스트',
        reason: 'loss-limit',
      },
    ]);
    expect(h.paper.runs.get(liveRunId('KR', '2026-10-21'))!.results[ID1]).toMatchObject({
      code: 'LOSS_LIMIT_STOP',
      stoppedNow: true,
    });
    // Stopped means stopped: nothing was sold to "get out".
    expect(h.fake.calls.some((c) => c.method === 'POST')).toBe(false);
  });
  it('a loss inside the limit does not stop it', async () => {
    const h = harness({ records: [holder()], prices: { '005930': 60_000 } });
    await h.seedPaperRecord();
    await seedOrder(h.store, held);
    await h.run();
    expect(await h.store.isAlgorithmStopped(ID1)).toBe(false);
  });
  it('an unmarkable held symbol means no stop, no order and a note (never a stale close as mark)', async () => {
    const h = harness({
      records: [krRecord({ targets: ['005930'] })],
      bars: {
        '005930': flatBars(70_000, '2026-10-20'),
        // The old close of the held symbol would show a huge PROFIT if it were used as a mark.
        '000660': flatBars(1, '2026-10-20'),
      },
      prices: { '005930': 77_000 },
    });
    await h.seedPaperRecord();
    await seedOrder(h.store, { ...held, symbol: '000660' });
    await h.run();
    expect(await h.store.isAlgorithmStopped(ID1)).toBe(false);
    expect(orderPosts(h.fake)).toHaveLength(0); // P&L unknown -> LOSS_UNKNOWN for the buy
    expect(h.store.listBlocked().some((b) => b.reasons.includes('LOSS_UNKNOWN'))).toBe(true);
    const notes = h.paper.runs.get(liveRunId('KR', '2026-10-21'))!.results[ID1].notes.join(' ');
    expect(notes).toContain('평가가격을 확인하지 못해');
  });
  it('marks a held symbol with the quote taken now', async () => {
    const h = harness({ records: [holder()], prices: { '005930': 60_000 } });
    await h.seedPaperRecord();
    await seedOrder(h.store, held);
    // The broker quote at order time shows a deep loss although the decision quote did not.
    h.fake.quotes.set('005930', { price: '40000' });
    await h.run();
    expect(h.store.stoppedReason(ID1)).toBe('loss-limit');
  });

  const two = () => ({
    bars: {
      '005930': flatBars(70_000, '2026-10-20'),
      '000660': flatBars(70_000, '2026-10-20'),
    },
    prices: { '005930': 77_000, '000660': 77_000 },
  });
  it('re-reads the algorithm before each order: switched to paper mid-run, the next order is refused', async () => {
    const record = krRecord({ targets: ['005930', '000660'] });
    const h = harness({ records: [record], ...two() });
    await h.seedPaperRecord();
    h.fake.onCreated = () => {
      record.mode = 'paper';
    };
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(1);
    expect(h.store.listBlocked().map((b) => b.reasons)).toEqual([['ALGORITHM_NOT_LIVE']]);
    expect(h.events).toEqual([]); // routine refusals are not alerts
  });
  it('stops ordering after the session window ends, even inside one run', async () => {
    const h = harness({ records: [krRecord({ targets: ['005930', '000660'] })], ...two() });
    await h.seedPaperRecord();
    h.fake.onCreated = () => h.setNow(at('2026-10-21T10:00:00+09:00'));
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(1);
    expect(h.store.listBlocked().map((b) => b.reasons)).toEqual([['RUN_WINDOW_CLOSED']]);
  });
  it('the close of the session also ends ordering', async () => {
    const h = harness({ records: [krRecord({ targets: ['005930', '000660'] })], ...two() });
    await h.seedPaperRecord();
    h.fake.onCreated = () => h.setNow(at('2026-10-21T15:31:00+09:00'));
    await h.run();
    expect(h.store.listBlocked().map((b) => b.reasons)).toEqual([['RUN_WINDOW_CLOSED']]);
  });
});

describe('algo-live job: unreadable control state is a failure, not a quiet skip', () => {
  it('reports the run as failed and raises the job-failure alert (emergency stop unreadable)', async () => {
    const h = harness({ failControl: true });
    await h.seedPaperRecord();
    await expect(h.run()).resolves.toBe('failed');
    expect(h.paper.runs.get(liveRunId('KR', '2026-10-21'))!.results[ID1]).toMatchObject({
      status: 'failed',
      code: 'CONTROL_UNAVAILABLE',
    });
    expect(h.events).toContainEqual({ kind: 'job-failure', jobName: 'algo-live' });
    expect(await h.store.getJobHeartbeat('KR')).toMatchObject({ outcome: 'failed' });
  });
  it('reports the run as failed when the algorithm stop state is unreadable', async () => {
    const h = harness();
    await h.seedPaperRecord();
    vi.spyOn(h.store, 'isAlgorithmStopped').mockRejectedValue(new Error('down'));
    await expect(h.run()).resolves.toBe('failed');
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(h.events).toContainEqual({ kind: 'job-failure', jobName: 'algo-live' });
  });
});

// ---------------------------------------------------------------------------
describe('algo-live job: monthly budget stop (docs/operations/budget.md)', () => {
  /** A buy that rests at the broker and has filled since: the books must still catch up. */
  async function restingFilledBuy(h: ReturnType<typeof harness>) {
    await seedOrder(
      h.store,
      {
        clientOrderId: 'ai-earlier',
        algorithmId: ID1,
        quantity: 20,
        price: '70000',
        createdAt: '2026-10-20T01:00:00.000Z',
      },
      'accepted',
    );
    const [seeded] = await h.store.listOrders({ algorithmId: ID1 });
    h.fake.orders.push({
      orderId: seeded.orderId!,
      clientOrderId: null,
      symbol: '005930',
      side: 'BUY',
      orderType: 'LIMIT',
      timeInForce: 'DAY',
      status: 'FILLED',
      price: '70000',
      quantity: '20',
      currency: 'KRW',
      orderedAt: '2026-10-20T01:00:00.000Z',
      filledQuantity: '20',
      averageFilledPrice: '69900',
    });
  }
  const fillNotice = {
    kind: 'fill',
    mode: 'live',
    symbol: '005930',
    side: 'buy',
    status: 'filled',
    algorithmName: '실전 테스트',
  };

  it('stopped: still reconciles the resting order (ledger + fill notice) but decides and orders nothing', async () => {
    const h = harness({ budget: 'stopped' });
    await h.seedPaperRecord();
    await restingFilledBuy(h);
    expect(await h.run()).toBe('ok');
    expect(await h.store.getOrder('ai-earlier')).toMatchObject({
      status: 'filled',
      filledQuantity: 20,
    });
    expect(h.events).toContainEqual(fillNotice);
    expect(h.events.map((e) => e.kind)).not.toContain('job-failure');
    expect(orderPosts(h.fake)).toHaveLength(0);
    // No decision work at all: no calendar, price or daily-bar read, no run record.
    expect(h.toss.marketCalendar).not.toHaveBeenCalled();
    expect(h.toss.prices).not.toHaveBeenCalled();
    expect(h.toss.dailyCandles).not.toHaveBeenCalled();
    expect(await h.paper.listRuns('KR', 10)).toEqual([]);
    expect(await h.store.getJobHeartbeat('KR')).toMatchObject({
      outcome: 'skipped',
      code: 'BUDGET_STOPPED',
    });
    expect(h.logs.some((line) => line.includes('BUDGET_STOPPED'))).toBe(true);
  });

  it('unknown: reconciles, raises a job-failure notice, fails the run and still orders nothing', async () => {
    const h = harness({ budget: 'unknown' });
    await h.seedPaperRecord();
    await restingFilledBuy(h);
    expect(await h.run()).toBe('failed');
    expect(await h.store.getOrder('ai-earlier')).toMatchObject({ status: 'filled' });
    expect(h.events).toContainEqual(fillNotice);
    expect(h.events).toContainEqual({ kind: 'job-failure', jobName: JOB_NAME });
    expect(orderPosts(h.fake)).toHaveLength(0);
    expect(h.toss.marketCalendar).not.toHaveBeenCalled();
    expect(await h.store.getJobHeartbeat('KR')).toMatchObject({
      outcome: 'failed',
      code: 'BUDGET_UNKNOWN',
    });
  });

  it('a reconcile failure while stopped is logged and never turns into an order', async () => {
    const h = harness({ budget: 'stopped' });
    await h.seedPaperRecord();
    await restingFilledBuy(h);
    h.fake.orders.length = 0; // the broker no longer knows the order
    expect(await h.run()).toBe('ok');
    expect(orderPosts(h.fake)).toHaveLength(0);
  });

  it('running (or no budget wiring) trades as before', async () => {
    const h = harness({ budget: 'running' });
    await h.seedPaperRecord();
    await h.run();
    expect(orderPosts(h.fake)).toHaveLength(1);
  });
});
