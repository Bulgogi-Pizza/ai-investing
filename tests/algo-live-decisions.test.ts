import { describe, expect, it } from 'vitest';
import {
  buildLiveDecisions,
  createAlgorithm,
  createPaperLedger,
  runPaperDay,
  buildBucketStats,
  type AlgorithmDefinition,
  type DailyBar,
  type LiveDecisionInput,
  type PaperQuote,
} from '../src/lib/algo';

// Synthetic data only. The live order intents come from the paper day's own decision engine.
const bars = (close: number, count = 10, end = '2026-10-20'): DailyBar[] => {
  const last = Date.parse(`${end}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => ({
    date: new Date(last - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1e6,
  }));
};
const algorithm = (symbols: string[], over: Parameters<typeof createAlgorithm>[2] = {}) =>
  createAlgorithm(
    'custom',
    { name: 'x', market: 'KR', symbols, budget: 10_000_000 },
    {
      signals: [{ id: 'momentum', weight: 1 }],
      buyThreshold: 0.4,
      sellThreshold: -0.4,
      params: { momentum: { lookbackDays: 1, scale: 0.1 } },
      ...over,
    },
  );
const quote = (symbol: string, price: number | null, close = 100): PaperQuote => ({
  symbol,
  price,
  completed: bars(close),
});
const input = (over: Partial<LiveDecisionInput> = {}): LiveDecisionInput => ({
  algorithm: algorithm(['AAA']),
  usedSignals: [{ id: 'momentum', weight: 1 }],
  date: '2026-10-21',
  quotes: [quote('AAA', 110)],
  owned: {},
  budget: 10_000_000,
  committed: 0,
  commissionRate: 0.001,
  ...over,
});

describe('buildLiveDecisions', () => {
  it('buys with a budget-sized quantity at the quote price when the score reaches the threshold', () => {
    const { orders, decisions } = buildLiveDecisions(input());
    // 10,000,000 / (110 * 1.001) = 90,818 shares.
    expect(orders).toEqual([
      {
        symbol: 'AAA',
        side: 'buy',
        quantity: 90_818,
        price: 110,
        score: 1,
        reasons: expect.arrayContaining(['종합 점수가 매수 기준 이상']),
      },
    ]);
    expect(decisions).toEqual([{ symbol: 'AAA', action: 'buy', score: 1 }]);
  });
  it('splits the budget by the number of targets and never exceeds what is left of it', () => {
    const { orders } = buildLiveDecisions(
      input({
        algorithm: algorithm(['AAA', 'BBB']),
        quotes: [quote('AAA', 110), quote('BBB', 110)],
        committed: 7_000_000,
      }),
    );
    // Half the budget per target would be 5,000,000, but only 3,000,000 is left.
    expect(orders).toHaveLength(2);
    const [first, second] = orders;
    expect(first.quantity * first.price).toBeLessThanOrEqual(3_000_000);
    expect(first.quantity).toBe(Math.floor(3_000_000 / (110 * 1.001)));
    // The second order sees what the first already used: nothing sizable is left.
    expect(first.quantity * first.price + second.quantity * second.price).toBeLessThanOrEqual(
      3_000_000,
    );
  });
  it('orders the buys by score, then symbol', () => {
    const algo = algorithm(['AAA', 'BBB', 'CCC'], { positionFraction: 0.2 });
    const { orders } = buildLiveDecisions(
      input({
        algorithm: algo,
        quotes: [quote('AAA', 105), quote('BBB', 115), quote('CCC', 115)],
      }),
    );
    expect(orders.map((o) => o.symbol)).toEqual(['BBB', 'CCC', 'AAA']);
  });
  it('reports an unaffordable buy instead of ordering one share too many', () => {
    const { orders, decisions } = buildLiveDecisions(input({ committed: 10_000_000 }));
    expect(orders).toEqual([]);
    expect(decisions[0]).toMatchObject({ action: 'buy', blockedBy: 'insufficient-budget' });
  });
  it('does not buy when the broker commission schedule is unknown', () => {
    const { orders, decisions } = buildLiveDecisions(input({ commissionRate: null }));
    expect(orders).toEqual([]);
    expect(decisions[0].blockedBy).toBe('commission-unknown');
  });
  it('sells exactly what the algorithm owns when the score falls to the sell threshold', () => {
    const { orders } = buildLiveDecisions(
      input({ quotes: [quote('AAA', 90)], owned: { AAA: 37 } }),
    );
    expect(orders).toEqual([
      expect.objectContaining({ symbol: 'AAA', side: 'sell', quantity: 37, price: 90 }),
    ]);
  });
  it('does not sell shares it does not own and does not buy more of a symbol it owns', () => {
    expect(buildLiveDecisions(input({ quotes: [quote('AAA', 90)] })).orders).toEqual([]);
    expect(buildLiveDecisions(input({ owned: { AAA: 5 } })).orders).toEqual([]);
  });
  it('sells a held symbol that left the target list', () => {
    const { orders } = buildLiveDecisions(
      input({
        algorithm: algorithm(['BBB']),
        quotes: [quote('AAA', 100), quote('BBB', 100)],
        owned: { AAA: 8 },
      }),
    );
    expect(orders).toEqual([
      expect.objectContaining({
        symbol: 'AAA',
        side: 'sell',
        quantity: 8,
        reasons: ['대상 종목에서 제외됨'],
      }),
    ]);
  });
  it('ignores symbols without a fresh quote', () => {
    const { orders, decisions } = buildLiveDecisions(
      input({ quotes: [quote('AAA', null), quote('BBB', 0)], owned: { AAA: 5 } }),
    );
    expect(orders).toEqual([]);
    expect(decisions).toEqual([]);
  });
  it('holds between the thresholds', () => {
    const { orders, decisions } = buildLiveDecisions(input({ quotes: [quote('AAA', 101)] }));
    expect(orders).toEqual([]);
    expect(decisions[0].action).toBe('hold');
  });
  it('takes AI decisions as given, including targets removed from the list', () => {
    const { orders } = buildLiveDecisions(
      input({
        externalDecisions: {
          AAA: { action: 'buy', reasons: ['모델 판단'], expectedReturn: 0.05 },
        },
        quotes: [quote('AAA', 100)],
      }),
    );
    expect(orders).toEqual([
      expect.objectContaining({ symbol: 'AAA', side: 'buy', score: null, reasons: ['모델 판단'] }),
    ]);
    const none = buildLiveDecisions(input({ externalDecisions: {}, quotes: [quote('AAA', 100)] }));
    expect(none.orders).toEqual([]); // no answer for a symbol = hold
  });
});

describe('a live run decides like its paper twin on the same data', () => {
  const dates = (n: number) => bars(1, n).map((b) => b.date);
  void dates;
  it.each([
    ['rising', 110],
    ['falling', 90],
    ['flat', 100],
  ])('same actions as runPaperDay when the price is %s', (_name, price) => {
    const algo: AlgorithmDefinition = algorithm(['AAA', 'BBB']);
    const quotes = [quote('AAA', price), quote('BBB', 100)];
    const ledger = createPaperLedger({
      algorithmId: 'x',
      market: 'KR',
      budget: 10_000_000,
      startedOn: '2026-10-01',
      now: '2026-10-01T00:00:00.000Z',
    });
    const paper = runPaperDay({
      ledger,
      algorithm: algo,
      usedSignals: algo.signals,
      date: '2026-10-21',
      runId: 'r',
      now: '2026-10-21T00:05:00.000Z',
      quotes,
      safeguards: { liquidityWindow: 1, liquidityMinAvgValue: 0 },
      stats: buildBucketStats([{ score: 1, grossReturn: 0.5, openedOn: 'a', closedOn: 'b' }]),
      minSamples: 1,
    });
    const live = buildLiveDecisions(input({ algorithm: algo, quotes }));
    expect(live.decisions.map((d) => [d.symbol, d.action])).toEqual(
      paper.decisions.map((d) => [d.symbol, d.action]),
    );
    expect(live.orders.map((o) => [o.symbol, o.side]).sort()).toEqual(
      paper.fills.map((f) => [f.symbol, f.side]).sort(),
    );
  });
});
