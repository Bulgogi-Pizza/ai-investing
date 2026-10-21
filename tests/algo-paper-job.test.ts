import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { MemorySupplySource } from '../src/jobs/algo-paper-sources';
import {
  JOB_NAME,
  jobConfiguration,
  runAlgoPaper,
  type PaperJobDependencies,
  type PaperToss,
} from '../src/jobs/algo-paper';
import { selectSessionToTrade } from '../src/jobs/algo-session';
import { JobConfigError, createJobLogger } from '../src/jobs/runner';
import { createPaperLedger, defaultSignalParams, type DailyBar } from '../src/lib/algo';
import type { AlgorithmRecord } from '../src/lib/algorithmRecords';
import {
  MemoryFeatureQuota,
  VertexAlgorithmDecider,
  ProviderAlgorithmDecider,
  type AlgorithmDecider,
} from '../src/server/algorithm-ai';
import type { NotificationEvent } from '../src/server/notify';
import { MemoryPaperRepository } from '../src/server/paper';
import { MemorySnapshotRepository } from '../src/server/snapshots';
import {
  ProviderError,
  type MarketCalendar,
  type MarketCode,
  type MarketDay,
  type StockDailyCandle,
} from '../src/server/toss';

// Synthetic data only; no network, no clock, no storage outside memory.
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
// Summer: US open 22:30 KST on the ET date 2026-10-20. Winter: open 23:30 KST on ET date 2026-12-01.
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
const at = (value: string) => new Date(value);
const KR_NOW = at('2026-10-21T09:05:00+09:00');

describe('open-window detection (calendar driven)', () => {
  const decide = (calendar: MarketCalendar, now: string) =>
    selectSessionToTrade(calendar, at(now), 20);
  it('KR: runs from the open until 20 minutes after, not before or later', () => {
    expect(decide(krCalendar(), '2026-10-21T08:59:59+09:00')).toEqual({
      action: 'skip',
      code: 'SESSION_NOT_OPEN_YET',
    });
    expect(decide(krCalendar(), '2026-10-21T09:00:00+09:00').action).toBe('run');
    expect(decide(krCalendar(), '2026-10-21T09:05:00+09:00').action).toBe('run');
    expect(decide(krCalendar(), '2026-10-21T09:20:00+09:00').action).toBe('run');
    expect(decide(krCalendar(), '2026-10-21T09:21:00+09:00')).toEqual({
      action: 'skip',
      code: 'OUTSIDE_OPEN_WINDOW',
    });
  });
  it('holiday: a day without a regular session never runs', () => {
    expect(decide(krCalendar(true), '2026-10-21T09:05:00+09:00')).toEqual({
      action: 'skip',
      code: 'MARKET_CLOSED_TODAY',
    });
    // The provider answering with the next business day instead of the asked date is a holiday too.
    const shifted = {
      ...krCalendar(),
      requestedDate: '2026-10-21',
      today: day('2026-10-22', ['2026-10-22T09:00:00+09:00', '2026-10-22T15:30:00+09:00']),
    };
    expect(decide(shifted, '2026-10-21T09:05:00+09:00').action).toBe('skip');
  });
  it('US summer time: the 22:35 slot runs, the 23:35 slot is outside the window', () => {
    expect(decide(usSummer(), '2026-10-20T22:35:00+09:00').action).toBe('run');
    expect(decide(usSummer(), '2026-10-20T23:35:00+09:00')).toEqual({
      action: 'skip',
      code: 'OUTSIDE_OPEN_WINDOW',
    });
  });
  it('US winter time: the 22:35 slot is before the open, the 23:35 slot runs', () => {
    expect(decide(usWinter(), '2026-12-01T22:35:00+09:00')).toEqual({
      action: 'skip',
      code: 'SESSION_NOT_OPEN_YET',
    });
    expect(decide(usWinter(), '2026-12-01T23:35:00+09:00').action).toBe('run');
  });
  it('a half day follows its own open and never runs after the close', () => {
    const half = usWinter();
    half.today = day('2026-12-01', ['2026-12-01T23:30:00+09:00', '2026-12-02T00:10:00+09:00']);
    expect(decide(half, '2026-12-01T23:35:00+09:00').action).toBe('run');
    expect(selectSessionToTrade(half, at('2026-12-02T00:15:00+09:00'), 120)).toEqual({
      action: 'skip',
      code: 'OUTSIDE_OPEN_WINDOW',
    });
  });
});

// ---------------------------------------------------------------------------
// Job harness.
// ---------------------------------------------------------------------------
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const iso = (offset: number) =>
  new Date(Date.parse('2026-08-22T00:00:00Z') + offset * 86_400_000).toISOString().slice(0, 10);
/** Bars 2026-08-22 .. 2026-10-20 (the day before the KR session), flat at `close`. */
function flatBars(close = 70_000, last = '2026-10-20', count = 60): DailyBar[] {
  const end = Date.parse(`${last}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(end - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return { date, open: close, high: close, low: close, close, volume: 1_000_000 };
  });
}
void iso;
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

const record = (over: Partial<AlgorithmRecord> = {}): AlgorithmRecord => ({
  id: ID1,
  name: '모의 테스트',
  method: 'formula',
  template: 'custom',
  market: 'KR',
  currency: 'KRW',
  targets: ['005930'],
  signals: [{ id: 'momentum', weight: 1 }],
  buyThreshold: 0.4,
  sellThreshold: -0.4,
  mode: 'paper',
  budget: 10_000_000,
  params: { ...structuredClone(defaultSignalParams), momentum: { lookbackDays: 1, scale: 0.1 } },
  targetsChangedAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  version: 1,
  ...over,
});

type Scenario = {
  records?: AlgorithmRecord[];
  calendar?: MarketCalendar;
  market?: MarketCode;
  now?: Date;
  bars?: Record<string, DailyBar[]>;
  prices?: Record<string, number>;
  priceTimestamp?: (now: Date) => string | null;
  emergency?: () => boolean;
  options?: PaperJobDependencies['options'];
  ai?: PaperJobDependencies['ai'];
  supply?: PaperJobDependencies['supply'];
  paper?: MemoryPaperRepository;
  failFinish?: boolean;
};
function harness(s: Scenario = {}) {
  const market = s.market ?? 'KR';
  const currency = market === 'KR' ? 'KRW' : 'USD';
  const paper = s.paper ?? new MemoryPaperRepository();
  if (s.failFinish) {
    const original = paper.finishRun.bind(paper);
    let thrown = false;
    paper.finishRun = async (run) => {
      if (!thrown) {
        thrown = true;
        throw new Error('storage down');
      }
      return original(run);
    };
  }
  const events: NotificationEvent[] = [];
  const logs: string[] = [];
  let now = s.now ?? KR_NOW;
  const bars = s.bars ?? { '005930': flatBars() };
  const prices = s.prices ?? { '005930': 77_000 };
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
          timestamp:
            s.priceTimestamp === undefined
              ? new Date(now.getTime() - 20_000).toISOString()
              : s.priceTimestamp(now),
        })),
    })),
  };
  const algorithms = {
    list: async () => s.records ?? [record()],
    getControl: vi.fn(async () => ({ emergencyStop: s.emergency?.() ?? false, updatedAt: null })),
    getCosts: async () => ({
      commissionRate: 0.001,
      sellTaxRate: 0.002,
      capitalGainsTax: null,
      updatedAt: null,
    }),
  };
  const deps = (): PaperJobDependencies => ({
    toss: toss as unknown as PaperToss,
    paper,
    algorithms,
    supply: s.supply,
    notify: async (event) => {
      events.push(event);
    },
    ai: s.ai,
    now: () => now,
    sleep: async () => {},
    log: createJobLogger(JOB_NAME, (line) => logs.push(line)),
    options: { market, paceMs: 0, minSamples: 1, ...s.options },
  });
  return {
    paper,
    events,
    logs,
    toss,
    algorithms,
    setNow: (value: Date) => {
      now = value;
    },
    run: () => runAlgoPaper(deps()),
  };
}
/** A ledger started earlier with one closed round trip in the top score bucket. */
async function seedLedger(
  paper: MemoryPaperRepository,
  over: { id?: string; budget?: number; grossReturn?: number; startedOn?: string } = {},
) {
  const ledger = createPaperLedger({
    algorithmId: over.id ?? ID1,
    market: 'KR',
    budget: over.budget ?? 10_000_000,
    startedOn: over.startedOn ?? '2026-10-05',
    now: '2026-10-05T00:00:00.000Z',
  });
  ledger.samples.push({
    score: 1,
    grossReturn: over.grossReturn ?? 0.05,
    openedOn: '2026-10-06',
    closedOn: '2026-10-12',
  });
  ledger.lastRunId = 'KR_2026-10-19';
  ledger.lastRunDate = '2026-10-19';
  await paper.commitDay(ledger, []);
  return ledger;
}
const runOf = (paper: MemoryPaperRepository, id = 'KR_2026-10-21') => paper.runs.get(id)!;

describe('algo-paper job: market and dedupe', () => {
  it('skips outside the open window and records nothing', async () => {
    const h = harness({ now: at('2026-10-21T10:00:00+09:00') });
    await expect(h.run()).resolves.toBe('ok');
    expect(h.paper.runs.size).toBe(0);
    expect(h.toss.prices).not.toHaveBeenCalled();
    expect(h.logs.join('\n')).toContain('OUTSIDE_OPEN_WINDOW');
  });

  it('holiday: records a skipped run once and does nothing else', async () => {
    const h = harness({ calendar: krCalendar(true) });
    await expect(h.run()).resolves.toBe('ok');
    expect(runOf(h.paper)).toMatchObject({ status: 'skipped', skipCode: 'MARKET_CLOSED_TODAY' });
    expect(h.toss.prices).not.toHaveBeenCalled();
  });

  it('a second invocation for the same market and date does not run again', async () => {
    const h = harness();
    await seedLedger(h.paper);
    await h.run();
    expect(runOf(h.paper).status).toBe('complete');
    const fills = h.paper.trades.size;
    const calls = h.toss.prices.mock?.calls?.length;
    h.setNow(at('2026-10-21T09:10:00+09:00'));
    await expect(h.run()).resolves.toBe('ok');
    expect(h.paper.trades.size).toBe(fills);
    expect(h.events.filter((e) => e.kind === 'fill')).toHaveLength(1);
    expect(h.toss.prices.mock?.calls?.length).toBe(calls);
    expect(h.logs.join('\n')).toContain('RUN_ALREADY_COMPLETE');
  });

  it('only runs algorithms in paper mode of the job market', async () => {
    const h = harness({
      records: [
        record({ id: ID1, mode: 'simulation' }),
        record({ id: ID2, name: '미국', market: 'US', currency: 'USD', mode: 'paper' }),
      ],
    });
    await h.run();
    expect(runOf(h.paper).results).toEqual({});
    expect(h.paper.ledgers.size).toBe(0);
  });
});

describe('algo-paper job: decisions, fills and costs', () => {
  it('holds back a buy while the expected-profit records are insufficient', async () => {
    const h = harness({ options: { minSamples: 20 } });
    await h.run();
    const result = runOf(h.paper).results[ID1];
    expect(result).toMatchObject({ status: 'applied', fills: 0 });
    expect(result.heldBack.insufficientHistory).toBe(1);
    expect(h.paper.trades.size).toBe(0);
    expect(h.events).toHaveLength(0);
    // The ledger now exists and remembers the run, so the day is not decided twice.
    expect(h.paper.ledgers.get(ID1)?.lastRunId).toBe('KR_2026-10-21');
  });

  it('holds back a buy whose expected profit does not beat the round-trip cost', async () => {
    const h = harness();
    await seedLedger(h.paper, { grossReturn: 0.002 }); // 2 x 0.1% + 0.2% = 0.4% round trip
    await h.run();
    const result = runOf(h.paper).results[ID1];
    expect(result.fills).toBe(0);
    expect(result.heldBack.expectedBelowCost).toBe(1);
  });

  it('buys with slippage and costs recorded, notifies a virtual fill once', async () => {
    const h = harness({ options: { slippageBps: 100 } });
    await seedLedger(h.paper);
    await h.run();
    const [trade] = [...h.paper.trades.values()];
    expect(trade).toMatchObject({
      algorithmId: ID1,
      market: 'KR',
      symbol: '005930',
      side: 'buy',
      referencePrice: 77_000,
      runId: 'KR_2026-10-21',
      date: '2026-10-21',
      mode: 'paper',
      virtual: true,
    });
    expect(trade.price).toBeCloseTo(77_770, 6);
    expect(trade.costs.commission).toBeCloseTo(trade.notional * 0.001, 6);
    expect(trade.costs.tax).toBe(0);
    expect(trade.costs.slippage).toBeCloseTo(trade.quantity * 770, 6);
    expect(trade.score).toBe(1);
    expect(trade.reasons.join(' ')).toContain('매수 기준');
    const ledger = h.paper.ledgers.get(ID1)!;
    expect(ledger.positions['005930'].quantity).toBe(trade.quantity);
    expect(ledger.cash).toBeCloseTo(10_000_000 - trade.notional - trade.costs.commission, 4);
    expect(h.events).toEqual([
      {
        kind: 'fill',
        mode: 'paper',
        symbol: '005930',
        side: 'buy',
        status: 'filled',
        algorithmName: '모의 테스트',
      },
    ]);
    expect(runOf(h.paper).results[ID1]).toMatchObject({ status: 'applied', fills: 1 });
  });

  it('a crash after the write does not duplicate fills or notifications on the retry', async () => {
    const h = harness({ failFinish: true, options: { staleRunMs: 1000 } });
    await seedLedger(h.paper);
    await expect(h.run()).resolves.toBe('failed');
    expect(h.paper.trades.size).toBe(1);
    const cashAfterFirst = h.paper.ledgers.get(ID1)!.cash;
    // The run record stayed "running"; a later invocation inside the window takes it over.
    h.setNow(at('2026-10-21T09:10:00+09:00'));
    await expect(h.run()).resolves.toBe('ok');
    expect(h.paper.trades.size).toBe(1);
    expect(h.paper.ledgers.get(ID1)!.cash).toBe(cashAfterFirst);
    expect(h.events.filter((e) => e.kind === 'fill')).toHaveLength(1);
    expect(runOf(h.paper).attempts).toBe(2);
  });

  it('writes the same fill ids when the same day is committed again', async () => {
    const h = harness();
    await seedLedger(h.paper);
    await h.run();
    const ids = [...h.paper.trades.keys()];
    const ledger = h.paper.ledgers.get(ID1)!;
    // Simulate the crash between "fills written" and "ledger written": same ids come out again.
    await h.paper.commitDay({ ...ledger, lastRunId: 'KR_2026-10-19' }, [
      ...h.paper.trades.values(),
    ]);
    expect([...h.paper.trades.keys()]).toEqual(ids);
  });

  it('drops the value signal with a label and does not trade on it', async () => {
    const h = harness({
      records: [
        record({
          signals: [
            { id: 'momentum', weight: 0.6 },
            { id: 'value', weight: 0.4 },
          ],
        }),
      ],
    });
    await seedLedger(h.paper);
    await h.run();
    const result = runOf(h.paper).results[ID1];
    expect(result.excludedSignals.join(' ')).toContain('가치');
    expect(result.fills).toBe(1);
  });

  it('news is excluded and labeled; an algorithm with only news has nothing to decide on', async () => {
    const h = harness({ records: [record({ signals: [{ id: 'news', weight: 1 }] })] });
    await h.run();
    expect(runOf(h.paper).results[ID1]).toMatchObject({
      status: 'skipped',
      code: 'NO_USABLE_SIGNAL',
    });
    expect(runOf(h.paper).results[ID1].excludedSignals.join(' ')).toContain('뉴스');
    expect(h.paper.ledgers.size).toBe(0);
  });

  it('supply is excluded and labeled without stored snapshots, used when they exist', async () => {
    const records = [
      record({
        signals: [
          { id: 'momentum', weight: 0.5 },
          { id: 'supply', weight: 0.5 },
        ],
      }),
    ];
    const none = harness({ records, supply: new MemorySupplySource(new Map()) });
    await seedLedger(none.paper);
    await none.run();
    expect(runOf(none.paper).results[ID1].excludedSignals.join(' ')).toContain('수급');
    expect(runOf(none.paper).results[ID1].fills).toBe(1);

    const snapshots = new MemorySnapshotRepository();
    const dates = flatBars()
      .slice(-5)
      .map((b) => b.date);
    await snapshots.upsert(
      dates.map((date) => ({
        id: `KR_${date}_005930`,
        kind: 'stock' as const,
        market: 'KR' as const,
        date,
        symbol: '005930',
        observedAt: `${date}T10:00:00.000Z`,
        sections: {
          investorTrading: {
            baseDate: date,
            observedAt: `${date}T10:00:00.000Z`,
            sourceUpdatedAt: null,
            value: {
              foreigner: { buyVolume: '0', sellVolume: '0', netBuyVolume: '100000' },
              institution: { buyVolume: '0', sellVolume: '0', netBuyVolume: '100000' },
            },
          },
        },
      })),
    );
    const some = harness({ records, supply: new MemorySupplySource(snapshots.documents) });
    await seedLedger(some.paper);
    await some.run();
    expect(runOf(some.paper).results[ID1].excludedSignals).toEqual([]);
    expect(runOf(some.paper).results[ID1].fills).toBe(1);
    // Strong net buying (2e5 of 1e6 volume) lifts the composite: score 1 is still capped at 1.
    expect([...some.paper.trades.values()][0].score).toBe(1);
  });

  it('stale quotes, stale candles and missing prices are not traded', async () => {
    const stalePrice = harness({
      priceTimestamp: (now) => new Date(now.getTime() - 120_000).toISOString(),
    });
    await seedLedger(stalePrice.paper);
    await expect(stalePrice.run()).resolves.toBe('failed');
    expect(runOf(stalePrice.paper).results[ID1]).toMatchObject({
      status: 'failed',
      code: 'DATA_UNAVAILABLE',
    });
    expect(stalePrice.paper.trades.size).toBe(0);
    expect(stalePrice.events).toContainEqual({ kind: 'job-failure', jobName: 'algo-paper' });
    // The ledger was not advanced, so the next slot can still decide this day.
    expect(stalePrice.paper.ledgers.get(ID1)!.lastRunId).toBe('KR_2026-10-19');

    const nullTimestamp = harness({ priceTimestamp: () => null });
    await expect(nullTimestamp.run()).resolves.toBe('failed');

    const staleCandles = harness({ bars: { '005930': flatBars(70_000, '2026-10-16') } });
    await expect(staleCandles.run()).resolves.toBe('failed');
    expect(staleCandles.paper.trades.size).toBe(0);
  });

  it('quotes in the wrong currency are rejected', async () => {
    const h = harness({ records: [record()], prices: { '005930': 77_000 } });
    (h.toss.prices as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      prices: [
        {
          symbol: '005930',
          lastPrice: '77000',
          currency: 'USD',
          timestamp: new Date(KR_NOW.getTime() - 5000).toISOString(),
        },
      ],
    }));
    await expect(h.run()).resolves.toBe('failed');
  });
});

describe('algo-paper job: global emergency stop', () => {
  it('records skipped and does nothing when the flag is set', async () => {
    const h = harness({ emergency: () => true });
    await seedLedger(h.paper);
    await expect(h.run()).resolves.toBe('ok');
    expect(runOf(h.paper).results[ID1]).toMatchObject({
      status: 'skipped',
      code: 'EMERGENCY_STOP',
      fills: 0,
    });
    expect(h.paper.trades.size).toBe(0);
    expect(h.toss.prices).not.toHaveBeenCalled();
    expect(h.paper.ledgers.get(ID1)!.lastRunId).toBe('KR_2026-10-19');
  });

  it('is read before each algorithm: a flag set mid-run stops the remaining ones', async () => {
    let reads = 0;
    const h = harness({
      records: [
        record({ id: ID1, name: '첫째' }),
        record({ id: ID2, name: '둘째', targets: ['005930'] }),
      ],
      emergency: () => ++reads > 1,
    });
    await seedLedger(h.paper, { id: ID1 });
    await seedLedger(h.paper, { id: ID2 });
    await h.run();
    expect(runOf(h.paper).results[ID1].status).toBe('applied');
    expect(runOf(h.paper).results[ID2]).toMatchObject({
      status: 'skipped',
      code: 'EMERGENCY_STOP',
    });
    expect(h.algorithms.getControl).toHaveBeenCalledTimes(2);
  });

  it('an unreadable flag fails closed', async () => {
    const h = harness();
    h.algorithms.getControl.mockRejectedValue(new Error('down'));
    await h.run();
    expect(runOf(h.paper).results[ID1]).toMatchObject({
      status: 'skipped',
      code: 'CONTROL_UNAVAILABLE',
    });
  });
});

describe('algo-paper job: cumulative loss stop', () => {
  it('stops the algorithm at -20%, notifies once, and skips later runs', async () => {
    const h = harness({ prices: { '005930': 55_000 } });
    const ledger = await seedLedger(h.paper, { budget: 10_000_000 });
    ledger.cash = 0;
    ledger.positions['005930'] = {
      symbol: '005930',
      quantity: 100,
      entryDate: '2026-10-05',
      entryPrice: 70_000,
      entryCommissionLeft: 0,
      liquidating: false,
      soldQuantity: 0,
      soldNotional: 0,
      realizedNet: 0,
      markPrice: 70_000,
    };
    // 100 shares x 55,000 = 5.5M of a 10M budget: -45%.
    await h.paper.commitDay(ledger, []);
    await h.run();
    const result = runOf(h.paper).results[ID1];
    expect(result).toMatchObject({ status: 'applied', stoppedNow: true, fills: 0 });
    expect(h.paper.ledgers.get(ID1)).toMatchObject({ status: 'stopped', stoppedOn: '2026-10-21' });
    expect(h.events).toEqual([
      {
        kind: 'algorithm-auto-stop',
        mode: 'paper',
        algorithmName: '모의 테스트',
        reason: 'loss-limit',
      },
    ]);
    // Next trading day: nothing more happens and nothing is announced again.
    h.events.length = 0;
    h.setNow(at('2026-10-22T09:05:00+09:00'));
    const next = krCalendar();
    next.requestedDate = '2026-10-22';
    next.previousBusinessDay = day('2026-10-21', [
      '2026-10-21T09:00:00+09:00',
      '2026-10-21T15:30:00+09:00',
    ]);
    next.today = day('2026-10-22', ['2026-10-22T09:00:00+09:00', '2026-10-22T15:30:00+09:00']);
    (h.toss.marketCalendar as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(next);
    await h.run();
    expect(h.paper.runs.get('KR_2026-10-22')!.results[ID1]).toMatchObject({
      status: 'skipped',
      code: 'PAPER_STOPPED',
    });
    expect(h.events).toHaveLength(0);
  });
});

describe('algo-paper job: AI method', () => {
  const aiRecord = record({ method: 'ai', name: 'AI 테스트' });
  const decisionBody = (over: Record<string, unknown> = {}) => ({
    decisions: [
      {
        symbol: '005930',
        decision: 'buy',
        reasons: ['모멘텀 점수가 높다'],
        expectedReturn: { low: 0.01, high: 0.03 },
        ...over,
      },
    ],
  });
  const vertex = (body: unknown, status = 200) =>
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: 'STOP',
                content: {
                  parts: [{ text: typeof body === 'string' ? body : JSON.stringify(body) }],
                },
              },
            ],
          }),
          { status },
        ),
    );
  const decider = (transport: ReturnType<typeof vi.fn>, quota = new MemoryFeatureQuota()) =>
    new VertexAlgorithmDecider(
      { project: 'test-project-1', model: 'gemini-3.8-flash', location: 'global' },
      quota,
      transport as unknown as typeof fetch,
      { getAccessToken: async () => 'fake-token' },
      () => KR_NOW.getTime(),
    );

  it('disabled (the default): skipped with "AI 비용 승인 대기", nothing called, no ledger', async () => {
    const h = harness({ records: [aiRecord] });
    await h.run();
    expect(runOf(h.paper).results[ID1]).toMatchObject({
      status: 'skipped',
      code: 'AI_APPROVAL_PENDING',
      reason: 'AI 비용 승인 대기',
      fills: 0,
    });
    expect(h.toss.prices).not.toHaveBeenCalled();
    expect(h.paper.ledgers.size).toBe(0);
    expect(runOf(h.paper).status).toBe('complete');
  });

  it('enabled flag without a decider stays skipped', async () => {
    const h = harness({ records: [aiRecord], ai: { enabled: true } });
    await h.run();
    expect(runOf(h.paper).results[ID1].code).toBe('AI_APPROVAL_PENDING');
  });

  it('enabled: the model decision is filled with its reasons and expected return', async () => {
    const transport = vertex(decisionBody());
    const h = harness({
      records: [aiRecord],
      ai: { enabled: true, decider: decider(transport) },
    });
    await h.run();
    expect(transport).toHaveBeenCalledTimes(1);
    const [, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    const prompt = sent.contents[0].parts[0].text as string;
    // Signal summary only: no account, quantity, budget or algorithm name goes to the model.
    expect(prompt).toContain('005930');
    expect(prompt).not.toContain('AI 테스트');
    expect(prompt).not.toContain('10000000');
    expect(sent.generationConfig.responseSchema.required).toEqual(['decisions']);
    const [trade] = [...h.paper.trades.values()];
    expect(trade).toMatchObject({ side: 'buy', symbol: '005930', score: null });
    expect(trade.reasons).toEqual(['모멘텀 점수가 높다']);
    expect(runOf(h.paper).results[ID1]).toMatchObject({ status: 'applied', fills: 1 });
  });

  it('enabled: an expected return below the round-trip cost is held back', async () => {
    const h = harness({
      records: [aiRecord],
      ai: {
        enabled: true,
        decider: decider(vertex(decisionBody({ expectedReturn: { low: 0, high: 0.004 } }))),
      },
    });
    await h.run();
    expect(h.paper.trades.size).toBe(0);
    expect(runOf(h.paper).results[ID1].heldBack.expectedBelowCost).toBe(1);
  });

  it.each([
    ['unknown decision value', decisionBody({ decision: 'maybe' })],
    ['extra field', decisionBody({ target: 123 })],
    ['url in reasons', decisionBody({ reasons: ['https://example.test 참고'] })],
    ['long identifier in reasons', decisionBody({ reasons: ['계좌 123456789012 확인'] })],
    ['inverted range', decisionBody({ expectedReturn: { low: 0.05, high: 0.01 } })],
    ['range outside [-1, 1]', decisionBody({ expectedReturn: { low: 0, high: 5 } })],
    ['symbol not requested', decisionBody({ symbol: 'ZZZ999' })],
    ['not json', '미안하지만 매수하세요'],
  ])('rejects invalid model output (%s) and trades nothing', async (_name, body) => {
    const h = harness({
      records: [aiRecord],
      ai: { enabled: true, decider: decider(vertex(body)) },
    });
    await expect(h.run()).resolves.toBe('failed');
    expect(runOf(h.paper).results[ID1]).toMatchObject({
      status: 'failed',
      code: 'AI_OUTPUT_INVALID',
    });
    expect(h.paper.trades.size).toBe(0);
    expect(h.paper.ledgers.size).toBe(0);
  });

  it('feature quota "algorithm": 12 calls per KST day, then QUOTA_EXCEEDED without a call', async () => {
    const transport = vertex(decisionBody());
    const quota = new MemoryFeatureQuota();
    const d = decider(transport, quota);
    const input = {
      market: 'KR' as const,
      date: '2026-10-21',
      currency: 'KRW' as const,
      symbols: [
        {
          symbol: '005930',
          price: 77_000,
          held: false,
          heldTradingDays: null,
          signals: { momentum: 0.9 },
        },
      ],
    };
    for (let i = 0; i < 12; i++) expect((await d.decide(input)).status).toBe('ready');
    expect(await d.decide(input)).toEqual({ status: 'unavailable', code: 'QUOTA_EXCEEDED' });
    expect(transport).toHaveBeenCalledTimes(12);
    // A new KST day has a fresh budget.
    expect(await quota.consume('algorithm', '2026-10-22', 12)).toBe(true);
  });

  it('provider errors and unreadable quota state are reported as unavailable', async () => {
    const down = decider(vertex({}, 500));
    const input = {
      market: 'KR' as const,
      date: '2026-10-21',
      currency: 'KRW' as const,
      symbols: [
        { symbol: '005930', price: 77_000, held: false, heldTradingDays: null, signals: {} },
      ],
    };
    expect(await down.decide(input)).toEqual({ status: 'unavailable', code: 'PROVIDER_ERROR' });
    const badQuota = new VertexAlgorithmDecider(
      { project: 'test-project-1', model: 'gemini-3.8-flash', location: 'global' },
      {
        consume: async () => {
          throw new Error('firestore down');
        },
      },
      vertex(decisionBody()) as unknown as typeof fetch,
      { getAccessToken: async () => 'fake-token' },
    );
    expect(await badQuota.decide(input)).toEqual({
      status: 'unavailable',
      code: 'QUOTA_UNAVAILABLE',
    });
    expect(await decider(vertex(decisionBody())).decide({ ...input, symbols: [] })).toEqual({
      status: 'unavailable',
      code: 'INPUT_INVALID',
    });
  });
});

describe('algo-paper job: configuration and safety', () => {
  const env = {
    NODE_ENV: 'production',
    CLOUD_RUN_JOB: 'investing-algo-paper',
    GOOGLE_CLOUD_PROJECT: 'test-project-1',
    TOSS_CLIENT_ID: 'id',
    TOSS_CLIENT_SECRET: 'secret',
    TOSS_ACCOUNT_SEQ: '123',
    TOSS_OWNER_USER_ID: 'owner',
    ALGO_MARKET: 'US',
  };
  it('requires production, a Cloud Run Job, an explicit project and a valid market', () => {
    expect(jobConfiguration(env).options.market).toBe('US');
    expect(() => jobConfiguration({ ...env, ALGO_MARKET: undefined })).toThrow(JobConfigError);
    expect(() => jobConfiguration({ ...env, ALGO_MARKET: 'JP' })).toThrow(JobConfigError);
    expect(() => jobConfiguration({ ...env, NODE_ENV: 'development' })).toThrow(JobConfigError);
    expect(() => jobConfiguration({ ...env, CLOUD_RUN_JOB: undefined })).toThrow(JobConfigError);
    expect(() => jobConfiguration({ ...env, ALGO_PAPER_SLIPPAGE_BPS: '900' })).toThrow(
      JobConfigError,
    );
    expect(jobConfiguration({ ...env, ALGO_PAPER_SLIPPAGE_BPS: '15' }).options.slippageBps).toBe(
      15,
    );
  });

  it('no order endpoint, order client or trading module appears in src/jobs/algo-paper*.ts', () => {
    const files = readdirSync('src/jobs').filter((f) => /^algo-(paper|session)/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const source = readFileSync(`src/jobs/${file}`, 'utf8');
      expect(source, file).not.toMatch(/['"`/]orders\b/i);
      expect(source, file).not.toMatch(/api\/v1\/orders/i);
      expect(source, file).not.toMatch(/buying-power|sellable-quantity|clientOrderId/i);
      expect(source, file).not.toMatch(/from ['"][^'"]*(trading|order)[^'"]*['"]/i);
      expect(source, file).not.toMatch(/\bmethod:\s*['"](POST|PUT|PATCH|DELETE)['"]/);
    }
    // The server modules it relies on have no order code either.
    for (const file of ['paper.ts', 'algorithm-ai.ts']) {
      const source = readFileSync(`src/server/${file}`, 'utf8');
      expect(source, file).not.toMatch(/api\/v1\/orders|clientOrderId|buying-power/i);
    }
  });

  it('the job exposes no AI switch other than ALGO_AI_ENABLED=true', async () => {
    const mod = await import('../src/server/algorithm-ai');
    expect(mod.algorithmAiEnabled({})).toBe(false);
    expect(mod.algorithmAiEnabled({ ALGO_AI_ENABLED: 'false' })).toBe(false);
    expect(mod.algorithmAiEnabled({ ALGO_AI_ENABLED: '1' })).toBe(false);
    expect(mod.algorithmAiEnabled({ ALGO_AI_ENABLED: 'TRUE' })).toBe(false);
    expect(mod.algorithmAiEnabled({ ALGO_AI_ENABLED: 'true' })).toBe(true);
    const noProject = mod.algorithmDeciderFromEnvironment({ ALGO_AI_ENABLED: 'true' });
    expect(noProject).toBeUndefined();
    const ok = mod.algorithmDeciderFromEnvironment({
      ALGO_AI_ENABLED: 'true',
      GOOGLE_CLOUD_PROJECT: 'test-project-1',
    } as NodeJS.ProcessEnv) as AlgorithmDecider | undefined;
    expect(ok).toBeInstanceOf(ProviderAlgorithmDecider);
    expect((ok as ProviderAlgorithmDecider).model).toBe('Claude Sonnet 5.5');
    expect(
      mod.algorithmDeciderFromEnvironment({ GOOGLE_CLOUD_PROJECT: 'test-project-1' }),
    ).toBeUndefined();
  });
});
