import { describe, expect, it, vi } from 'vitest';
import {
  JOB_NAME,
  jobConfiguration,
  runDailySnapshot,
  type SnapshotDependencies,
  type SnapshotToss,
} from '../src/jobs/daily-snapshot';
import { createJobLogger } from '../src/jobs/runner';
import { HoldingsTargetProvider, ListTargetProvider } from '../src/jobs/snapshot-targets';
import {
  MemorySnapshotRepository,
  type SnapshotRun,
  type SnapshotTarget,
} from '../src/server/snapshots';
import {
  ProviderError,
  type MarketCalendar,
  type MarketCode,
  type MarketDay,
  type StockDailyCandle,
} from '../src/server/toss';
import { datesBackFrom, flow } from './fixtures/toss-snapshot';

const OWNER = 'owner-fixture';
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
const usCalendar = (): MarketCalendar => ({
  source: 'fixture',
  asOf: '2026-10-21T00:00:00Z',
  market: 'US',
  requestedDate: '2026-10-20',
  previousBusinessDay: day('2026-10-19', [
    '2026-10-19T22:30:00+09:00',
    '2026-10-20T05:00:00+09:00',
  ]),
  today: day('2026-10-20', ['2026-10-20T22:30:00+09:00', '2026-10-21T05:00:00+09:00']),
  nextBusinessDay: day('2026-10-21', ['2026-10-21T22:30:00+09:00', '2026-10-22T05:00:00+09:00']),
});
const KR_NOW = new Date('2026-10-21T16:30:00+09:00');
const US_NOW = new Date('2026-10-21T06:30:00+09:00');
const bar = (date: string, currency: 'KRW' | 'USD'): StockDailyCandle => ({
  timestamp: `${date}T00:00:00+09:00`,
  date,
  open: '100',
  high: '110',
  low: '95',
  close: '105',
  volume: '1000',
  currency,
});
const investor = (date: string) => ({
  date,
  updatedAt: `${date}T19:05:00+09:00`,
  individual: flow(10, 12),
  foreigner: flow(5, 3),
  institution: { ...flow(7, 6), breakdown: null },
  otherCorporation: null,
  foreignerHolding: null,
  cfd: null,
});
type Overrides = Partial<Record<keyof SnapshotToss, (...args: never[]) => unknown>>;
/** Fake provider. `latest` is the newest bar date a symbol returns. */
function fakeToss(overrides: Overrides = {}, latest: Record<string, string> = {}) {
  const dates = (symbol: string, session: string, count: number) =>
    datesBackFrom(latest[symbol] ?? session, count);
  const toss = {
    marketCalendar: vi.fn(async (market: MarketCode) =>
      market === 'KR' ? krCalendar() : usCalendar(),
    ),
    dailyCandlePage: vi.fn(async (symbol: string, options: { count?: number } = {}) => ({
      candles: dates(
        symbol,
        /^\d/.test(symbol) ? '2026-10-21' : '2026-10-20',
        options.count ?? 5,
      ).map((d) => bar(d, /^\d/.test(symbol) ? 'KRW' : 'USD')),
      nextBefore: null,
    })),
    marketIndicatorCandlePage: vi.fn(async (_symbol: string, options: { count?: number } = {}) => ({
      // Market indicators have no currency field in the provider response.
      candles: datesBackFrom('2026-10-21', options.count ?? 5).map((d) => {
        const { currency: _ignored, ...indicatorBar } = bar(d, 'KRW');
        return indicatorBar;
      }),
      nextBefore: null,
    })),
    investorTrading: vi.fn(async (symbol: string, options: { count?: number } = {}) => ({
      symbol,
      records: datesBackFrom('2026-10-21', options.count ?? 5).map(investor),
      nextUntil: null,
    })),
    programTrades: vi.fn(async (symbol: string, options: { count?: number } = {}) => ({
      symbol,
      records: datesBackFrom('2026-10-21', options.count ?? 5).map((date) => ({
        date,
        arbitrage: flow(1, 1),
        nonArbitrage: flow(2, 1),
      })),
      nextUntil: null,
    })),
    shortSelling: vi.fn(async (symbol: string, options: { count?: number } = {}) => ({
      symbol,
      records: datesBackFrom('2026-10-21', options.count ?? 5).map((date) => ({
        date,
        updatedAt: `${date}T19:00:00+09:00`,
        shortSellingVolume: '1',
        shortSellingAmount: '2',
        shortSellingVolumeRate: null,
        shortSellingAmountRate: null,
      })),
      nextUntil: null,
    })),
    creditTrades: vi.fn(async (symbol: string, options: { count?: number } = {}) => ({
      symbol,
      records: datesBackFrom('2026-10-21', options.count ?? 5).map((date) => ({
        date,
        updatedAt: `${date}T06:00:00+09:00`,
        marginLoan: null,
        stockLoan: null,
      })),
      nextUntil: null,
    })),
  };
  for (const [name, fn] of Object.entries(overrides))
    (toss as Record<string, unknown>)[name] = vi.fn(fn as never);
  return toss as unknown as SnapshotToss & typeof toss;
}
function harness(
  options: {
    toss?: ReturnType<typeof fakeToss>;
    holdings?: { symbol: string; market: MarketCode }[] | Error;
    list?: SnapshotTarget[];
    now?: Date;
    syncNews?: SnapshotDependencies['syncNews'];
    repository?: MemorySnapshotRepository;
    options?: SnapshotDependencies['options'];
  } = {},
) {
  const repository = options.repository ?? new MemorySnapshotRepository();
  if (options.list) void repository.putTargets(OWNER, { targets: options.list, updatedAt: 'x' });
  const lines: string[] = [];
  const toss = options.toss ?? fakeToss();
  const sleep = vi.fn(async () => undefined);
  const holdings = options.holdings ?? [{ symbol: '005930', market: 'KR' as const }];
  const portfolio = {
    portfolio: vi.fn(async () => {
      if (holdings instanceof Error) throw holdings;
      return { holdings };
    }),
  };
  const deps = (now: Date): SnapshotDependencies => ({
    toss,
    repository,
    targetProviders: [
      new HoldingsTargetProvider(portfolio, OWNER),
      new ListTargetProvider(repository, OWNER),
    ],
    syncNews: options.syncNews ?? (async () => ({ count: 3, failedSources: 0 })),
    now: () => now,
    sleep,
    log: createJobLogger(JOB_NAME, (line) => lines.push(line)),
    options: { paceMs: 0, ...options.options },
  });
  return {
    repository,
    toss,
    lines,
    sleep,
    portfolio,
    run: (now = options.now ?? KR_NOW) => runDailySnapshot(deps(now)),
  };
}
const kstRun = (repository: MemorySnapshotRepository) =>
  repository.runs.get('KR_2026-10-21') as SnapshotRun;

describe('daily snapshot job', () => {
  it('stores candles, supply and demand, indicators and news for the KR session and records the run', async () => {
    const h = harness({ list: [{ market: 'KR', symbol: '000660' }] });
    expect(await h.run()).toBe('ok');
    const run = kstRun(h.repository);
    expect(run).toMatchObject({
      status: 'complete',
      market: 'KR',
      date: '2026-10-21',
      attempts: 1,
      trigger: 'scheduler',
      targets: { holdings: 1, list: 1, total: 2 },
    });
    expect(run.steps.candles).toMatchObject({ status: 'OK', ok: 2 });
    expect(run.steps.investorTrading.ok).toBe(2);
    expect(run.steps.indicators).toMatchObject({ status: 'OK', ok: 8 });
    expect(run.steps.news.status).toBe('OK');
    // One document per symbol and trade date over the trailing window of 5.
    const doc = h.repository.documents.get('KR_2026-10-21_005930')!;
    expect(doc).toMatchObject({
      kind: 'stock',
      market: 'KR',
      date: '2026-10-21',
      symbol: '005930',
    });
    expect(Object.keys(doc.sections).sort()).toEqual(
      ['candle', 'creditTrades', 'investorTrading', 'programTrades', 'shortSelling'].sort(),
    );
    expect(doc.sections.candle).toMatchObject({
      baseDate: '2026-10-21',
      observedAt: KR_NOW.toISOString(),
      sourceUpdatedAt: null,
      value: { adjusted: true, currency: 'KRW', close: '105' },
    });
    expect(doc.sections.investorTrading).toMatchObject({
      baseDate: '2026-10-21',
      sourceUpdatedAt: '2026-10-21T19:05:00+09:00',
    });
    expect(h.repository.documents.has('KR_2026-10-17_005930')).toBe(true);
    expect(h.repository.documents.get('INDICATOR_2026-10-21_KOSPI')).toMatchObject({
      kind: 'indicator',
      market: 'KR',
    });
    expect(run.counts.documentsWritten).toBe(5 * 2 + 8 * 5);
  });
  it('is idempotent: a completed day is not repeated and a forced re-run reuses the same document ids', async () => {
    const h = harness();
    await h.run();
    const before = new Map(h.repository.documents);
    const calls = h.toss.dailyCandlePage.mock.calls.length;
    expect(await h.run(new Date(KR_NOW.getTime() + 3600_000))).toBe('ok');
    expect(h.toss.dailyCandlePage.mock.calls.length).toBe(calls);
    expect(h.lines.some((l) => l.includes('RUN_ALREADY_COMPLETE'))).toBe(true);
    const forced = harness({ repository: h.repository, toss: h.toss, options: { force: true } });
    await forced.run();
    expect(h.repository.documents.size).toBe(before.size);
    expect([...h.repository.documents.keys()].sort()).toEqual([...before.keys()].sort());
    expect(kstRun(h.repository).attempts).toBe(2);
  });
  it('skips a holiday without calling the data endpoints and leaves a skipped record once', async () => {
    const toss = fakeToss({
      marketCalendar: async (market: MarketCode) =>
        (market === 'KR' ? krCalendar(true) : usCalendar()) as never,
    } as never);
    const h = harness({ toss });
    expect(await h.run()).toBe('ok');
    expect(toss.dailyCandlePage).not.toHaveBeenCalled();
    expect(toss.marketIndicatorCandlePage).not.toHaveBeenCalled();
    expect(h.repository.documents.size).toBe(0);
    expect(h.repository.runs.get('KR_2026-10-21')).toMatchObject({
      status: 'skipped',
      skipCode: 'MARKET_CLOSED_TODAY',
    });
    await h.run();
    expect(h.repository.runs.size).toBe(1);
  });
  it('lets the job decide the market from the calendar: US slot runs US only, KR slot runs KR only', async () => {
    const h = harness({ holdings: [{ symbol: 'AAPL', market: 'US' }] });
    expect(await h.run(US_NOW)).toBe('ok');
    expect(h.toss.marketCalendar).toHaveBeenCalledWith('US', '2026-10-20');
    expect(h.repository.runs.get('US_2026-10-20')).toMatchObject({
      status: 'complete',
      market: 'US',
      targets: { holdings: 1, total: 1 },
    });
    expect(h.repository.runs.has('KR_2026-10-21')).toBe(false);
    // US symbols get candles only: no KR supply/demand and no KR indicators.
    expect(h.toss.investorTrading).not.toHaveBeenCalled();
    expect(h.toss.marketIndicatorCandlePage).not.toHaveBeenCalled();
    expect(h.repository.documents.has('US_2026-10-20_AAPL')).toBe(true);
    expect(h.repository.documents.get('US_2026-10-20_AAPL')!.sections.candle!.value).toMatchObject({
      currency: 'USD',
    });
  });
  it('keeps what succeeded on partial failure, reports codes, and a re-run fills the gap', async () => {
    let fail = true;
    const toss = fakeToss({
      dailyCandlePage: async (symbol: string, options: { count?: number } = {}) => {
        if (symbol === '000660' && fail)
          throw new ProviderError(502, 'PROVIDER_SCHEMA_INVALID', 'raw SECRET-MARKER text');
        return {
          candles: datesBackFrom('2026-10-21', options.count ?? 5).map((d) => bar(d, 'KRW')),
          nextBefore: null,
        };
      },
    } as never);
    const h = harness({ toss, list: [{ market: 'KR', symbol: '000660' }] });
    expect(await h.run()).toBe('partial');
    let run = kstRun(h.repository);
    expect(run.status).toBe('partial');
    expect(run.steps.candles).toMatchObject({
      status: 'FAILED',
      ok: 1,
      failed: 1,
      codes: { PROVIDER_SCHEMA_INVALID: 1 },
    });
    // The other symbol and the other sections of the failing symbol are kept.
    expect(h.repository.documents.get('KR_2026-10-21_005930')!.sections.candle).toBeDefined();
    const partial = h.repository.documents.get('KR_2026-10-21_000660')!;
    expect(partial.sections.candle).toBeUndefined();
    expect(partial.sections.investorTrading).toBeDefined();
    expect(h.lines.join('\n')).not.toContain('SECRET-MARKER');
    // Second slot: same ids, the candle section arrives, nothing is duplicated.
    fail = false;
    const sizeBefore = h.repository.documents.size;
    expect(await h.run(new Date(KR_NOW.getTime() + 3600_000))).toBe('ok');
    run = kstRun(h.repository);
    expect(run).toMatchObject({ status: 'complete', attempts: 2 });
    expect(h.repository.documents.get('KR_2026-10-21_000660')!.sections.candle).toBeDefined();
    expect(h.repository.documents.size).toBe(sizeBefore);
  });
  it('records no permission for Stock Info 403 without failing the run, and stops asking after two denials', async () => {
    const forbidden = async () => {
      throw new ProviderError(503, 'PROVIDER_FORBIDDEN', '권한 없음');
    };
    const toss = fakeToss({ creditTrades: forbidden } as never);
    const h = harness({
      toss,
      list: [
        { market: 'KR', symbol: '000660' },
        { market: 'KR', symbol: '035420' },
        { market: 'KR', symbol: '051910' },
      ],
    });
    expect(await h.run()).toBe('ok');
    const run = kstRun(h.repository);
    expect(run.status).toBe('complete');
    expect(run.steps.creditTrades).toMatchObject({
      status: 'FORBIDDEN',
      forbidden: 4,
      codes: { PROVIDER_FORBIDDEN: 4 },
    });
    expect(toss.creditTrades).toHaveBeenCalledTimes(2);
    expect(run.steps.candles.status).toBe('OK');
    expect(
      h.repository.documents.get('KR_2026-10-21_005930')!.sections.creditTrades,
    ).toBeUndefined();
    expect(h.repository.documents.get('KR_2026-10-21_005930')!.sections.candle).toBeDefined();
  });
  it('treats a one-business-day lag of KR bond yields as normal but a longer one as stale', async () => {
    const indicatorBars = (latest: (symbol: string) => string) =>
      vi.fn(async (symbol: string, options: { count?: number } = {}) => ({
        candles: datesBackFrom(latest(symbol), options.count ?? 5).map((d) => {
          const { currency: _ignored, ...indicatorBar } = bar(d, 'KRW');
          return indicatorBar;
        }),
        nextBefore: null,
      }));
    // Session is 2026-10-21: indices have it, bonds end on the previous business day.
    const lagged = harness({
      toss: fakeToss({
        marketIndicatorCandlePage: indicatorBars((s) =>
          s.startsWith('KR_BOND') ? '2026-10-20' : '2026-10-21',
        ),
      } as never),
    });
    await lagged.run();
    expect(kstRun(lagged.repository).steps.indicators).toMatchObject({ status: 'OK', ok: 8 });
    // A bond a week behind is still a stale step.
    const old = harness({
      toss: fakeToss({
        marketIndicatorCandlePage: indicatorBars((s) =>
          s === 'KR_BOND_3Y' ? '2026-10-14' : '2026-10-21',
        ),
      } as never),
    });
    await old.run();
    expect(kstRun(old.repository).steps.indicators).toMatchObject({
      status: 'STALE',
      stale: 1,
      codes: { CANDLE_NOT_YET_PUBLISHED: 1 },
    });
  });
  it('flags a missing session bar as stale so the next slot retries, and still stores older bars', async () => {
    const toss = fakeToss({}, { '005930': '2026-10-20' });
    const h = harness({ toss });
    expect(await h.run()).toBe('partial');
    expect(kstRun(h.repository).steps.candles).toMatchObject({
      status: 'STALE',
      stale: 1,
      codes: { CANDLE_NOT_YET_PUBLISHED: 1 },
    });
    expect(h.repository.documents.has('KR_2026-10-20_005930')).toBe(true);
    expect(h.repository.documents.get('KR_2026-10-21_005930')!.sections.candle).toBeUndefined();
  });
  it('stops after a fatal provider error and marks the remaining work skipped', async () => {
    const toss = fakeToss({
      dailyCandlePage: async () => {
        throw new ProviderError(503, 'PROVIDER_ACCESS_DENIED', 'raw');
      },
    } as never);
    const h = harness({ toss, list: [{ market: 'KR', symbol: '000660' }] });
    expect(await h.run()).toBe('failed');
    const run = kstRun(h.repository);
    expect(run.status).toBe('failed');
    expect(toss.dailyCandlePage).toHaveBeenCalledTimes(1);
    expect(toss.investorTrading).not.toHaveBeenCalled();
    expect(run.steps.candles.codes.PROVIDER_ACCESS_DENIED).toBeGreaterThan(0);
  });
  it('waits out a short rate limit once and continues', async () => {
    let calls = 0;
    const toss = fakeToss({
      dailyCandlePage: async (_symbol: string, options: { count?: number } = {}) => {
        if (calls++ === 0) throw new ProviderError(503, 'PROVIDER_RATE_LIMITED', 'raw', 2);
        return {
          candles: datesBackFrom('2026-10-21', options.count ?? 5).map((d) => bar(d, 'KRW')),
          nextBefore: null,
        };
      },
    } as never);
    const h = harness({ toss, options: { paceMs: 0 } });
    expect(await h.run()).toBe('ok');
    expect(h.sleep).toHaveBeenCalledWith(2000);
    expect(toss.dailyCandlePage).toHaveBeenCalledTimes(2);
  });
  it('waits for a token lease held by the service instead of failing the day', async () => {
    let calls = 0;
    const toss = fakeToss({
      dailyCandlePage: async (_symbol: string, options: { count?: number } = {}) => {
        if (calls++ === 0) throw new ProviderError(503, 'PROVIDER_TOKEN_BUSY', 'raw', 60);
        return {
          candles: datesBackFrom('2026-10-21', options.count ?? 5).map((d) => bar(d, 'KRW')),
          nextBefore: null,
        };
      },
    } as never);
    const h = harness({ toss });
    expect(await h.run()).toBe('ok');
    expect(h.sleep).toHaveBeenCalledWith(60_000);
  });
  it('gives up on a long rate limit instead of sleeping through it', async () => {
    const toss = fakeToss({
      dailyCandlePage: async () => {
        throw new ProviderError(503, 'PROVIDER_RATE_LIMITED', 'raw', 900);
      },
    } as never);
    const h = harness({ toss });
    expect(await h.run()).toBe('failed');
    expect(h.sleep).not.toHaveBeenCalledWith(900_000);
  });
  it('uses the other target source when holdings fail and reports it', async () => {
    const h = harness({
      holdings: new ProviderError(503, 'PROVIDER_UNREACHABLE', 'raw'),
      list: [{ market: 'KR', symbol: '000660' }],
    });
    expect(await h.run()).toBe('partial');
    const run = kstRun(h.repository);
    expect(run.targets).toEqual({ holdings: 0, list: 1, total: 1 });
    expect(run.steps.targets).toMatchObject({
      status: 'FAILED',
      codes: { PROVIDER_UNREACHABLE: 1 },
    });
    expect(h.repository.documents.has('KR_2026-10-21_000660')).toBe(true);
  });
  it('de-duplicates holdings and the owner list and ignores symbols of other markets and bad codes', async () => {
    const h = harness({
      holdings: [
        { symbol: '005930', market: 'KR' },
        { symbol: 'AAPL', market: 'US' },
      ],
      list: [
        { market: 'KR', symbol: '005930' },
        { market: 'KR', symbol: 'bad/symbol' as never },
      ],
    });
    await h.run();
    const run = kstRun(h.repository);
    expect(run.targets).toEqual({ holdings: 1, list: 0, total: 1 });
    expect(run.steps.targets).toMatchObject({ skipped: 1, codes: { TARGET_SYMBOL_INVALID: 1 } });
    expect(h.toss.dailyCandlePage).toHaveBeenCalledTimes(1);
  });
  it('treats a news failure as a partial result but keeps market data', async () => {
    const h = harness({ syncNews: async () => ({ count: 0, failedSources: 2 }) });
    expect(await h.run()).toBe('partial');
    expect(kstRun(h.repository).steps.news).toMatchObject({
      status: 'FAILED',
      codes: { NEWS_SOURCE_FAILED: 1 },
    });
    expect(h.repository.documents.size).toBeGreaterThan(0);
    const thrown = harness({
      syncNews: async () => {
        throw new Error('SECRET-MARKER');
      },
    });
    expect(await thrown.run()).toBe('partial');
    expect(thrown.lines.join('\n')).not.toContain('SECRET-MARKER');
  });
  it('does not start a second run while one is in progress but takes over a crashed one', async () => {
    const repository = new MemorySnapshotRepository();
    repository.runs.set('KR_2026-10-21', {
      id: 'KR_2026-10-21',
      market: 'KR',
      date: '2026-10-21',
      status: 'running',
      trigger: 'scheduler',
      attempts: 1,
      startedAt: new Date(KR_NOW.getTime() - 5 * 60_000).toISOString(),
      finishedAt: null,
      sessionClose: null,
      skipCode: null,
      targets: null,
      counts: { symbols: 0, documentsWritten: 0 },
      steps: {},
    });
    const busy = harness({ repository });
    await busy.run();
    expect(busy.toss.dailyCandlePage).not.toHaveBeenCalled();
    expect(busy.lines.some((l) => l.includes('RUN_IN_PROGRESS'))).toBe(true);
    const later = harness({ repository });
    await later.run(new Date(KR_NOW.getTime() + 40 * 60_000));
    expect(kstRun(repository)).toMatchObject({ status: 'complete', attempts: 2 });
  });
  it('survives a calendar failure for one market and reports it', async () => {
    const toss = fakeToss({
      marketCalendar: async (market: MarketCode) => {
        if (market === 'US') throw new ProviderError(503, 'PROVIDER_UNREACHABLE', 'raw');
        return krCalendar() as never;
      },
    } as never);
    const h = harness({ toss });
    expect(await h.run()).toBe('failed');
    expect(kstRun(h.repository).status).toBe('complete');
    expect(h.lines.some((l) => l.includes('market-calendar-failed'))).toBe(true);
  });
  it('stores a store failure as a failed step instead of crashing', async () => {
    const repository = new MemorySnapshotRepository();
    repository.upsert = vi.fn(async () => {
      throw new Error('SECRET-MARKER firestore details');
    });
    const h = harness({ repository });
    expect(await h.run()).toBe('failed');
    expect(kstRun(repository).steps.store.codes).toMatchObject({
      STORE_FAILED: expect.any(Number),
    });
    expect(h.lines.join('\n')).not.toContain('SECRET-MARKER');
  });
});

describe('log hygiene', () => {
  it('writes only job, step, counts and codes: no tokens, account ids or provider bodies', async () => {
    const toss = fakeToss({
      investorTrading: async () => {
        throw new ProviderError(503, 'PROVIDER_UNAVAILABLE', 'raw body with Bearer abc.def.ghi');
      },
    } as never);
    const h = harness({ toss });
    await h.run();
    const text = h.lines.join('\n');
    for (const secret of ['Bearer', 'abc.def', 'fixture-secret', 'accountSeq', OWNER, '005930'])
      expect(text).not.toContain(secret);
    for (const line of h.lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.job).toBe('daily-snapshot');
      expect(Object.keys(parsed).every((key) => /^[a-zA-Z]+$/.test(key))).toBe(true);
    }
    expect(text).toContain('PROVIDER_UNAVAILABLE');
  });
});

describe('job configuration', () => {
  const env = {
    NODE_ENV: 'production',
    CLOUD_RUN_JOB: 'investing-daily-snapshot',
    GOOGLE_CLOUD_PROJECT: 'my-project-123',
    TOSS_CLIENT_ID: 'id',
    TOSS_CLIENT_SECRET: 'secret',
    TOSS_ACCOUNT_SEQ: '12345',
    TOSS_OWNER_USER_ID: OWNER,
  };
  it('requires production, a Cloud Run Job, an explicit project and the Toss settings', () => {
    expect(jobConfiguration(env).options).toEqual({});
    for (const broken of [
      { NODE_ENV: 'development' },
      { CLOUD_RUN_JOB: '' },
      { GOOGLE_CLOUD_PROJECT: '' },
      { GOOGLE_CLOUD_PROJECT: 'Bad Project' },
      { TOSS_CLIENT_SECRET: '' },
      { TOSS_ACCOUNT_SEQ: 'abc' },
      { TOSS_OWNER_USER_ID: '' },
    ])
      expect(() => jobConfiguration({ ...env, ...broken })).toThrow('JOB_CONFIG_INVALID');
  });
  it('accepts manual overrides only in a strict form', () => {
    expect(
      jobConfiguration({
        ...env,
        SNAPSHOT_MARKETS: 'KR',
        SNAPSHOT_DATE: '2026-10-21',
        SNAPSHOT_FORCE: '1',
      }).options,
    ).toEqual({ markets: ['KR'], date: '2026-10-21', force: true, trigger: 'manual' });
    for (const bad of [
      { SNAPSHOT_MARKETS: 'KR,JP' },
      { SNAPSHOT_MARKETS: 'KR,KR' },
      { SNAPSHOT_DATE: '21-10-2026' },
      { SNAPSHOT_FORCE: 'yes' },
    ])
      expect(() => jobConfiguration({ ...env, ...bad })).toThrow();
  });
});
