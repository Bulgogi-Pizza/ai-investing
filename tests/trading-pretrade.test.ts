import { describe, expect, it } from 'vitest';
import {
  HARD_MAX_ORDER_VALUE_KRW,
  MAX_SELL_TRANCHES,
  fxProblem,
  isAcceptableCorrection,
  krwEquivalentPrice,
  priceLimitProblem,
  verifyCorrectedPrice,
  planSellTranches,
  preTradeCheck,
  type OrderIntent,
  type PreTradeContext,
  type PreTradeDeps,
} from '../src/server/trading/pre-trade';
import { REASONS, type ReasonCode } from '../src/server/trading/reasons';
import { MemoryTradingStore, type PreTradeStore } from '../src/server/trading/stores';
import {
  TossOrderClient,
  type OrderTransport,
  type TransportRequest,
} from '../src/server/trading/toss-orders';
import {
  FakeToss,
  NOW,
  krAlgorithm,
  krFacts,
  sampleStats,
  seedOrder,
  tradingDaysSinceFixture,
} from './support/fake-toss';

const iso = (ms: number) => new Date(ms).toISOString();

function env(overrides: { store?: PreTradeStore } = {}) {
  const fake = new FakeToss();
  fake.priceLimits.set('005930', { upper: '91000', lower: '49000', currency: 'KRW' });
  fake.sellable.set('005930', '1000');
  const memory = new MemoryTradingStore(() => NOW);
  const store: PreTradeStore = overrides.store ?? memory;
  const client = new TossOrderClient(fake, { sleep: async () => undefined });
  const deps: PreTradeDeps = {
    store,
    toss: client,
    now: () => NOW,
    tradingDaysSince: tradingDaysSinceFixture,
  };
  return { fake, memory, store, client, deps };
}

const buyOrder = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  symbol: '005930',
  side: 'buy',
  quantity: 10,
  price: '70000',
  orderType: 'LIMIT',
  timeInForce: 'DAY',
  tranche: 0,
  ...over,
});
const sellOrder = (over: Partial<OrderIntent> = {}) => buyOrder({ side: 'sell', ...over });

function ctx(over: Partial<PreTradeContext> = {}): PreTradeContext {
  return {
    algorithm: krAlgorithm(),
    order: buyOrder(),
    market: krFacts(),
    cumulativePnl: 0,
    expectedProfit: { stats: sampleStats(), score: 0.5 },
    settings: { sellTaxRate: 0.0018 },
    ...over,
  };
}

async function codes(c: PreTradeContext, deps: PreTradeDeps): Promise<ReasonCode[]> {
  const r = await preTradeCheck(c, deps);
  return r.allowed ? [] : r.reasons.map((x) => x.code);
}
async function expectBlocked(c: PreTradeContext, deps: PreTradeDeps, expected: ReasonCode[]) {
  expect(await codes(c, deps)).toEqual(expected);
}
async function expectAllowed(c: PreTradeContext, deps: PreTradeDeps) {
  const r = await preTradeCheck(c, deps);
  expect(r, JSON.stringify(r)).toMatchObject({ allowed: true });
}

/** A held position bought `daysAgoCreated` (ISO date) that is fully filled. */
async function holding(
  store: MemoryTradingStore,
  quantity = 10,
  createdAt = '2026-10-14T01:00:00.000Z',
) {
  await seedOrder(store, { clientOrderId: 'seed-buy', quantity, createdAt }, 'filled');
}

describe('baseline', () => {
  it('a clean KR buy passes and returns the unchanged, frozen order', async () => {
    const { deps } = env();
    const c = ctx();
    const r = await preTradeCheck(c, deps);
    expect(r.allowed).toBe(true);
    if (r.allowed) {
      expect(r.order).toEqual(c.order);
      expect(Object.isFrozen(r.order)).toBe(true);
    }
  });
  it('every reason has a Korean message and a stable upper-case code', () => {
    for (const [code, message] of Object.entries(REASONS)) {
      expect(code).toMatch(/^[A-Z][A-Z_]+$/);
      expect(message).toMatch(/[가-힣]/);
    }
  });
  it('never throws, even when every dependency throws', async () => {
    const boom = () => {
      throw new Error('boom');
    };
    const store: PreTradeStore = {
      getEmergencyStop: async () => false,
      isAlgorithmStopped: boom,
      getDailyCounts: boom,
      listOrders: boom,
    };
    const { deps } = env({ store });
    const toss = new Proxy({}, { get: () => boom }) as unknown as PreTradeDeps['toss'];
    const result = await preTradeCheck(ctx(), { ...deps, toss });
    expect(result.allowed).toBe(false);
    const garbage = await preTradeCheck({} as PreTradeContext, deps);
    expect(garbage.allowed).toBe(false);
  });
});

describe('order shape (LIMIT + DAY, integer, valid price)', () => {
  it.each([
    ['market order', { orderType: 'MARKET' }, ['ORDER_NOT_LIMIT_DAY']],
    ['closing order', { timeInForce: 'CLS' }, ['ORDER_NOT_LIMIT_DAY']],
    ['fractional quantity', { quantity: 1.5 }, ['QUANTITY_NOT_INTEGER']],
    ['zero quantity', { quantity: 0 }, ['QUANTITY_NOT_INTEGER']],
    ['price off the documented scale', { price: '70000.5' }, ['PRICE_INVALID']],
    ['non-string price', { price: 70000 }, ['PRICE_INVALID']],
    ['bad symbol', { symbol: 'samsung' }, ['ORDER_INVALID']],
    ['bad side', { side: 'short' }, ['ORDER_INVALID', 'PRICE_INVALID']],
  ])('blocks %s', async (_n, over, expected) => {
    const { deps, fake } = env();
    await expectBlocked(ctx({ order: buyOrder(over as never) }), deps, expected as ReasonCode[]);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('check ordering: control state first, local before remote, remote last', () => {
  it('the emergency stop wins over every other failure and nothing remote is read', async () => {
    const { deps, memory, fake } = env();
    memory.setEmergencyStop(true);
    const c = ctx({
      market: krFacts({ quote: null, latestDailyBarDate: null }),
      cumulativePnl: null,
    });
    const r = await preTradeCheck(c, deps);
    expect(r).toMatchObject({ allowed: false });
    if (!r.allowed) expect(r.reasons[0].code).toBe('EMERGENCY_STOP');
    expect(fake.calls).toHaveLength(0);
  });
  it('a local data failure means no remote read at all', async () => {
    const { deps, fake } = env();
    await expectBlocked(ctx({ market: krFacts({ avgTradedValue: 1 }) }), deps, [
      'LIQUIDITY_BELOW_MINIMUM',
    ]);
    expect(fake.calls).toHaveLength(0);
  });
  it('remote reads run in a fixed order and stop at the first refusal', async () => {
    const { deps, fake } = env();
    fake.warnings.set('005930', [
      { warningType: 'INVESTMENT_WARNING', exchange: null, startDate: null, endDate: null },
    ]);
    await expectBlocked(ctx(), deps, ['STOCK_WARNING']);
    expect(fake.calls.map((c) => c.path)).toEqual([
      '/api/v1/orders',
      '/api/v1/stocks/005930/warnings',
    ]);
  });
  it('a passing buy reads open orders, warnings, price limits, commissions, buying power in order', async () => {
    const { deps, fake } = env();
    await expectAllowed(ctx(), deps);
    expect(fake.calls.map((c) => c.path)).toEqual([
      '/api/v1/orders',
      '/api/v1/stocks/005930/warnings',
      '/api/v1/price-limits',
      '/api/v1/commissions',
      '/api/v1/buying-power',
    ]);
    expect(fake.calls.every((c) => c.method === 'GET')).toBe(true);
  });
  it('re-reads the emergency stop after the slow remote reads (fresh, not cached)', async () => {
    const { deps, memory } = env();
    let reads = 0;
    const store: PreTradeStore = {
      getEmergencyStop: async () => {
        reads++;
        return reads >= 2;
      },
      isAlgorithmStopped: (id) => memory.isAlgorithmStopped(id),
      getDailyCounts: (d, a) => memory.getDailyCounts(d, a),
      listOrders: (f) => memory.listOrders(f),
    };
    await expectBlocked(ctx(), { ...deps, store }, ['EMERGENCY_STOP']);
    expect(reads).toBe(2);
  });
  it('an unreadable emergency stop blocks (fail closed)', async () => {
    const { deps, memory } = env();
    const store: PreTradeStore = {
      getEmergencyStop: async () => {
        throw new Error('firestore down');
      },
      isAlgorithmStopped: (id) => memory.isAlgorithmStopped(id),
      getDailyCounts: (d, a) => memory.getDailyCounts(d, a),
      listOrders: (f) => memory.listOrders(f),
    };
    await expectBlocked(ctx(), { ...deps, store }, ['EMERGENCY_STOP_UNREADABLE']);
  });
});

describe('safeguard 1: budget per algorithm and currency', () => {
  it('no budget set blocks every order', async () => {
    const { deps } = env();
    await expectBlocked(ctx({ algorithm: krAlgorithm({ budget: null }) }), deps, [
      'BUDGET_NOT_SET',
    ]);
    await expectBlocked(ctx({ algorithm: krAlgorithm({ budget: 0 }) }), deps, ['BUDGET_NOT_SET']);
  });
  it('blocks a buy that would exceed the budget, passes one within it', async () => {
    const { deps } = env();
    // 10 shares * 70,000 = 700,000
    await expectBlocked(ctx({ algorithm: krAlgorithm({ budget: 699_999 }) }), deps, [
      'BUDGET_EXCEEDED',
    ]);
    await expectAllowed(ctx({ algorithm: krAlgorithm({ budget: 700_000 }) }), deps);
  });
  it('counts what is already committed: held cost basis and working buys', async () => {
    const { deps, memory } = env();
    await holding(memory, 10); // cost 700,000
    await seedOrder(
      memory,
      { clientOrderId: 'working', symbol: '000660', quantity: 5, price: '100000' },
      'accepted',
    ); // 500,000
    const algorithm = krAlgorithm({ budget: 1_899_999 });
    await expectBlocked(ctx({ algorithm }), deps, ['BUDGET_EXCEEDED']);
    await expectAllowed(ctx({ algorithm: krAlgorithm({ budget: 1_900_000 }) }), deps);
  });
  it('a US order is budgeted in USD', async () => {
    const { deps, fake } = env();
    fake.priceLimits.set('AAPL', { upper: null, lower: null, currency: 'USD' });
    fake.buyingPower.USD = '10000';
    const base = ctx({
      algorithm: krAlgorithm({ market: 'US', budget: 1000 }),
      order: buyOrder({ symbol: 'AAPL', quantity: 5, price: '185.5' }),
      market: krFacts({
        quote: { price: 185.5, observedAt: iso(NOW.getTime() - 5000) },
        avgTradedValue: 9_000_000,
        fxMidRate: 1400,
      }),
      settings: {},
    });
    // 5 * 185.5 = 927.5 USD
    await expectAllowed(base, deps);
    await expectBlocked({ ...base, algorithm: krAlgorithm({ market: 'US', budget: 927 }) }, deps, [
      'BUDGET_EXCEEDED',
    ]);
  });
});

describe('safeguard 2: daily order counts and minimum holding', () => {
  it('algorithm limit: 3 per day blocks the 4th, 2 still pass', async () => {
    const { deps, memory } = env();
    const today = NOW.toISOString();
    for (const [i, symbol] of ['000660', '035420'].entries())
      await seedOrder(
        memory,
        { clientOrderId: `today-${i}`, symbol, createdAt: today },
        'rejected',
      );
    await expectAllowed(ctx(), deps);
    await seedOrder(
      memory,
      { clientOrderId: 'today-2', symbol: '051910', createdAt: today },
      'rejected',
    );
    await expectBlocked(ctx(), deps, ['DAILY_LIMIT_ALGORITHM']);
  });
  it('orders of earlier days do not count', async () => {
    const { deps, memory } = env();
    for (let i = 0; i < 5; i++)
      await seedOrder(
        memory,
        { clientOrderId: `old-${i}`, symbol: '000660', createdAt: '2026-10-20T01:00:00.000Z' },
        'rejected',
      );
    await expectAllowed(ctx(), deps);
  });
  it('global limit: 10 per day across algorithms', async () => {
    const { deps, memory } = env();
    for (let i = 0; i < 9; i++)
      await seedOrder(
        memory,
        {
          clientOrderId: `g-${i}`,
          algorithmId: `other-${i}`,
          symbol: '000660',
          createdAt: NOW.toISOString(),
        },
        'rejected',
      );
    await expectAllowed(ctx(), deps);
    await seedOrder(
      memory,
      {
        clientOrderId: 'g-9',
        algorithmId: 'other-9',
        symbol: '000660',
        createdAt: NOW.toISOString(),
      },
      'rejected',
    );
    await expectBlocked(ctx(), deps, ['DAILY_LIMIT_GLOBAL']);
  });
  it('both limits are reported together when both are hit', async () => {
    const { deps, memory } = env();
    for (let i = 0; i < 10; i++)
      await seedOrder(
        memory,
        { clientOrderId: `b-${i}`, symbol: '000660', createdAt: NOW.toISOString() },
        'rejected',
      );
    await expectBlocked(ctx(), deps, ['DAILY_LIMIT_ALGORITHM', 'DAILY_LIMIT_GLOBAL']);
  });
  it('minimum holding: no sell before 5 trading days, sell at 5', async () => {
    const { deps, memory } = env();
    await holding(memory, 10, '2026-10-15T01:00:00.000Z'); // Thu: 4 trading days to Wed 21
    await expectBlocked(ctx({ order: sellOrder(), expectedProfit: null }), deps, [
      'MIN_HOLDING_PERIOD',
    ]);
    const second = env();
    await holding(second.memory, 10, '2026-10-14T01:00:00.000Z'); // Wed: 5 trading days
    await expectAllowed(ctx({ order: sellOrder(), expectedProfit: null }), second.deps);
  });
  it('an unknown trading-day count blocks the sell (fail closed)', async () => {
    const { deps, memory } = env();
    await holding(memory);
    await expectBlocked(
      ctx({ order: sellOrder(), expectedProfit: null }),
      { ...deps, tradingDaysSince: () => null },
      ['MIN_HOLDING_PERIOD'],
    );
    await expectBlocked(
      ctx({ order: sellOrder(), expectedProfit: null }),
      {
        ...deps,
        tradingDaysSince: () => {
          throw new Error('calendar');
        },
      },
      ['MIN_HOLDING_PERIOD'],
    );
  });
});

describe('safeguard 3: no duplicate orders', () => {
  it('a working order of the same algorithm and symbol in the store blocks', async () => {
    const { deps, memory } = env();
    await seedOrder(memory, { clientOrderId: 'o1' }, 'accepted');
    await expectBlocked(ctx(), deps, ['OPEN_ORDER_EXISTS']);
  });
  it('a partially filled order also counts as open', async () => {
    const { deps, memory } = env();
    await seedOrder(memory, { clientOrderId: 'o1', filledQuantity: 3 }, 'partially-filled');
    await expectBlocked(ctx(), deps, ['OPEN_ORDER_EXISTS']);
  });
  it('an order with an unknown outcome, or one reserved but never confirmed, blocks as unreconciled', async () => {
    for (const status of ['unknown', 'reserved'] as const) {
      const { deps, memory } = env();
      await seedOrder(memory, { clientOrderId: 'o1' }, status);
      await expectBlocked(ctx(), deps, ['UNRECONCILED_ORDER']);
    }
  });
  it('terminal orders and other symbols do not block', async () => {
    const { deps, memory } = env();
    await seedOrder(memory, { clientOrderId: 'o1', quantity: 10 }, 'canceled');
    await seedOrder(memory, { clientOrderId: 'o2' }, 'rejected');
    await seedOrder(memory, { clientOrderId: 'o3', symbol: '000660' }, 'accepted');
    await expectAllowed(ctx(), deps);
  });
  it('an OPEN order on the account for the symbol (from the provider) blocks, whoever placed it', async () => {
    const { deps, fake } = env();
    fake.orders.push({
      orderId: 'manual-1',
      clientOrderId: null,
      symbol: '005930',
      side: 'SELL',
      orderType: 'LIMIT',
      timeInForce: 'DAY',
      status: 'PENDING',
      price: '80000',
      quantity: '1',
      currency: 'KRW',
      orderedAt: iso(NOW.getTime()),
      filledQuantity: '0',
      averageFilledPrice: null,
    });
    await expectBlocked(ctx(), deps, ['OPEN_ORDER_EXISTS']);
  });
  it('an OPEN order on another symbol does not block; a failed lookup does', async () => {
    const { deps, fake } = env();
    fake.orders.push({
      orderId: 'manual-2',
      clientOrderId: null,
      symbol: '000660',
      side: 'BUY',
      orderType: 'LIMIT',
      timeInForce: 'DAY',
      status: 'PENDING',
      price: '80000',
      quantity: '1',
      currency: 'KRW',
      orderedAt: iso(NOW.getTime()),
      filledQuantity: '0',
      averageFilledPrice: null,
    });
    await expectAllowed(ctx(), deps);
    fake.getFailures.set('/api/v1/orders', { status: 500, code: 'internal-error' });
    await expectBlocked(ctx(), deps, ['OPEN_ORDERS_UNAVAILABLE']);
    fake.getFailures.delete('/api/v1/orders');
    fake.malformed.add('/api/v1/orders');
    await expectBlocked(ctx(), deps, ['OPEN_ORDERS_UNAVAILABLE']);
  });
});

describe('safeguard 4: cumulative loss limit', () => {
  it('at -20% of the budget the order is refused and the algorithm must stop', async () => {
    const { deps } = env();
    const algorithm = krAlgorithm({ budget: 10_000_000 });
    const r = await preTradeCheck(ctx({ algorithm, cumulativePnl: -2_000_000 }), deps);
    expect(r).toMatchObject({ allowed: false, autoStop: true });
    if (!r.allowed) expect(r.reasons.map((x) => x.code)).toEqual(['LOSS_LIMIT_REACHED']);
  });
  it('just above the limit passes; gains pass', async () => {
    const { deps } = env();
    const algorithm = krAlgorithm({ budget: 10_000_000 });
    await expectAllowed(ctx({ algorithm, cumulativePnl: -1_999_999 }), deps);
    await expectAllowed(ctx({ algorithm, cumulativePnl: 5_000_000 }), deps);
  });
  it('an unknown or non-finite P&L blocks without an auto-stop', async () => {
    const { deps } = env();
    for (const pnl of [null, NaN, Infinity]) {
      const r = await preTradeCheck(ctx({ cumulativePnl: pnl as never }), deps);
      expect(r).toEqual({
        allowed: false,
        reasons: [{ code: 'LOSS_UNKNOWN', message: REASONS.LOSS_UNKNOWN }],
      });
    }
  });
  it('sells are blocked too once the loss limit is hit (a stopped algorithm places nothing)', async () => {
    const { deps, memory } = env();
    await holding(memory);
    const r = await preTradeCheck(
      ctx({ order: sellOrder(), expectedProfit: null, cumulativePnl: -1e12 }),
      deps,
    );
    expect(r).toMatchObject({ allowed: false, autoStop: true });
  });
  it('a stopped algorithm is blocked', async () => {
    const { deps, memory } = env();
    await memory.stopAlgorithm('algo-1', 'loss-limit');
    await expectBlocked(ctx(), deps, ['ALGORITHM_STOPPED']);
  });
  it('a configurable fraction is honoured', async () => {
    const { deps } = env();
    const algorithm = krAlgorithm({ budget: 1000 });
    await expectBlocked(
      ctx({
        algorithm,
        cumulativePnl: -100,
        settings: { sellTaxRate: 0.0018, safeguards: { lossStopFraction: 0.1 } },
      }),
      deps,
      ['LOSS_LIMIT_REACHED'],
    );
  });
});

describe('safeguard 5: global emergency stop', () => {
  it('blocks buys and sells alike', async () => {
    const { deps, memory } = env();
    await holding(memory);
    memory.setEmergencyStop(true);
    await expectBlocked(ctx(), deps, ['EMERGENCY_STOP']);
    await expectBlocked(ctx({ order: sellOrder(), expectedProfit: null }), deps, [
      'EMERGENCY_STOP',
    ]);
    memory.setEmergencyStop(false);
    await expectAllowed(ctx(), deps);
  });
});

describe('safeguard 6: data freshness', () => {
  it('requires the previous trading day daily bar', async () => {
    const { deps } = env();
    await expectBlocked(ctx({ market: krFacts({ latestDailyBarDate: null }) }), deps, [
      'DAILY_BAR_MISSING',
    ]);
    await expectBlocked(ctx({ market: krFacts({ latestDailyBarDate: '2026-10-19' }) }), deps, [
      'DAILY_BAR_MISSING',
    ]);
    await expectBlocked(ctx({ market: krFacts({ latestDailyBarDate: 'yesterday' }) }), deps, [
      'DAILY_BAR_MISSING',
    ]);
    await expectAllowed(ctx({ market: krFacts({ latestDailyBarDate: '2026-10-21' }) }), deps); // a newer bar is fine
  });
  it('requires a quote observed within 60 seconds', async () => {
    const { deps } = env();
    const at = (ms: number) =>
      krFacts({ quote: { price: 70_000, observedAt: iso(NOW.getTime() - ms) } });
    await expectAllowed(ctx({ market: at(60_000) }), deps);
    await expectBlocked(ctx({ market: at(60_001) }), deps, ['QUOTE_STALE']);
    await expectBlocked(ctx({ market: at(-30_000) }), deps, ['QUOTE_STALE']); // from the future
    await expectBlocked(ctx({ market: krFacts({ quote: null }) }), deps, ['QUOTE_MISSING']);
    await expectBlocked(
      ctx({ market: krFacts({ quote: { price: 0, observedAt: iso(NOW.getTime()) } }) }),
      deps,
      ['QUOTE_MISSING'],
    );
    await expectBlocked(
      ctx({ market: krFacts({ quote: { price: 70_000, observedAt: 'soon' } }) }),
      deps,
      ['QUOTE_MISSING'],
    );
  });
  it('the quote age limit can be tightened but never loosened beyond 60 seconds', async () => {
    const { deps } = env();
    const market = krFacts({ quote: { price: 70_000, observedAt: iso(NOW.getTime() - 30_000) } });
    await expectBlocked(
      ctx({ market, settings: { sellTaxRate: 0.0018, maxQuoteAgeMs: 10_000 } }),
      deps,
      ['QUOTE_STALE'],
    );
    const old = krFacts({ quote: { price: 70_000, observedAt: iso(NOW.getTime() - 120_000) } });
    await expectBlocked(
      ctx({ market: old, settings: { sellTaxRate: 0.0018, maxQuoteAgeMs: 600_000 } }),
      deps,
      ['QUOTE_STALE'],
    );
  });
  it('financials are required only when the algorithm uses the value signal', async () => {
    const { deps } = env();
    const market = krFacts({ financialsPresent: false });
    await expectAllowed(ctx({ market }), deps);
    await expectBlocked(ctx({ market, algorithm: krAlgorithm({ usesValueSignal: true }) }), deps, [
      'FINANCIALS_MISSING',
    ]);
    await expectAllowed(ctx({ algorithm: krAlgorithm({ usesValueSignal: true }) }), deps);
  });
  it('refuses a limit price much worse than the quote, but not one that merely cannot fill', async () => {
    const { deps, memory } = env();
    await expectBlocked(ctx({ order: buyOrder({ price: '72200' }) }), deps, [
      'PRICE_FAR_FROM_QUOTE',
    ]); // +3.14%
    await expectAllowed(ctx({ order: buyOrder({ price: '72100' }) }), deps);
    await expectAllowed(ctx({ order: buyOrder({ price: '60000' }) }), deps); // far below: harmless for a buy
    await holding(memory);
    await expectBlocked(ctx({ order: sellOrder({ price: '67800' }), expectedProfit: null }), deps, [
      'PRICE_FAR_FROM_QUOTE',
    ]);
    await expectAllowed(ctx({ order: sellOrder({ price: '75000' }), expectedProfit: null }), deps);
  });
});

describe('safeguard 7: sell only what the algorithm owns, and no more than is sellable', () => {
  it('nothing owned -> blocked even if the account holds shares', async () => {
    const { deps, fake } = env();
    fake.sellable.set('005930', '500'); // the owner holds shares of their own
    await expectBlocked(ctx({ order: sellOrder(), expectedProfit: null }), deps, [
      'SELL_NOT_OWNED',
    ]);
  });
  it('quantity above the algorithm-owned quantity is refused, not clamped', async () => {
    const { deps, memory } = env();
    await holding(memory, 10);
    await expectBlocked(ctx({ order: sellOrder({ quantity: 11 }), expectedProfit: null }), deps, [
      'SELL_EXCEEDS_OWNED',
    ]);
    await expectAllowed(ctx({ order: sellOrder({ quantity: 10 }), expectedProfit: null }), deps);
  });
  it('while a sell of the position is working, another sell is refused (open-order rule)', async () => {
    const { deps, memory } = env();
    await holding(memory, 10);
    await seedOrder(
      memory,
      { clientOrderId: 'sell-1', side: 'sell', quantity: 6, createdAt: '2026-10-20T01:00:00.000Z' },
      'accepted',
    );
    await expectBlocked(ctx({ order: sellOrder({ quantity: 4 }), expectedProfit: null }), deps, [
      'OPEN_ORDER_EXISTS',
    ]);
  });
  it('quantity above the broker sellable quantity is refused', async () => {
    const { deps, memory, fake } = env();
    await holding(memory, 10);
    fake.sellable.set('005930', '9');
    await expectBlocked(ctx({ order: sellOrder({ quantity: 10 }), expectedProfit: null }), deps, [
      'SELL_EXCEEDS_SELLABLE',
    ]);
    fake.sellable.set('005930', '10.7'); // fractional US-style values are floored
    await expectAllowed(ctx({ order: sellOrder({ quantity: 10 }), expectedProfit: null }), deps);
    fake.getFailures.set('/api/v1/sellable-quantity', { status: 500, code: 'internal-error' });
    await expectBlocked(ctx({ order: sellOrder({ quantity: 10 }), expectedProfit: null }), deps, [
      'SELLABLE_UNAVAILABLE',
    ]);
  });
  it('a sell does not require history, buying power or commissions', async () => {
    const { deps, memory, fake } = env();
    await holding(memory, 10);
    fake.getFailures.set('/api/v1/commissions', { status: 500, code: 'internal-error' });
    fake.getFailures.set('/api/v1/buying-power', { status: 500, code: 'internal-error' });
    await expectAllowed(ctx({ order: sellOrder(), expectedProfit: null, settings: {} }), deps);
    expect(fake.calls.map((c) => c.path)).not.toContain('/api/v1/buying-power');
  });
});

describe('safeguard 8: limit orders, liquidity', () => {
  it('liquidity: 1e9 KRW average traded value for KR buys', async () => {
    const { deps } = env();
    await expectBlocked(ctx({ market: krFacts({ avgTradedValue: 999_999_999 }) }), deps, [
      'LIQUIDITY_BELOW_MINIMUM',
    ]);
    await expectAllowed(ctx({ market: krFacts({ avgTradedValue: 1_000_000_000 }) }), deps);
    await expectBlocked(ctx({ market: krFacts({ avgTradedValue: null }) }), deps, [
      'LIQUIDITY_BELOW_MINIMUM',
    ]);
  });
  it('liquidity: 5e6 USD for US buys', async () => {
    const { deps, fake } = env();
    fake.priceLimits.set('AAPL', { upper: null, lower: null, currency: 'USD' });
    const us = (avg: number) =>
      ctx({
        algorithm: krAlgorithm({ market: 'US' }),
        order: buyOrder({ symbol: 'AAPL', quantity: 5, price: '185.5' }),
        market: krFacts({
          quote: { price: 185.5, observedAt: iso(NOW.getTime() - 1000) },
          avgTradedValue: avg,
          fxMidRate: 1400,
        }),
        settings: {},
      });
    await expectBlocked(us(4_999_999), deps, ['LIQUIDITY_BELOW_MINIMUM']);
    await expectAllowed(us(5_000_000), deps);
  });
  it('an exit is never blocked for illiquidity (positions must stay closable)', async () => {
    const { deps, memory } = env();
    await holding(memory);
    await expectAllowed(
      ctx({ order: sellOrder(), expectedProfit: null, market: krFacts({ avgTradedValue: 1 }) }),
      deps,
    );
  });
  it('the 20-day window and thresholds can be tightened by settings but a NaN threshold is refused', async () => {
    const { deps } = env();
    await expectBlocked(
      ctx({
        settings: { sellTaxRate: 0.0018, safeguards: { liquidityMinAvgValue: 6_000_000_000 } },
      }),
      deps,
      ['LIQUIDITY_BELOW_MINIMUM'],
    );
    for (const bad of [
      { lossStopFraction: NaN },
      { maxOrdersPerDay: 0 },
      { liquidityMinAvgValue: -1 },
      { minHoldingTradingDays: 1.5 },
    ])
      await expectBlocked(ctx({ settings: { sellTaxRate: 0.0018, safeguards: bad } }), deps, [
        'SETTINGS_INVALID',
      ]);
    await expectBlocked(ctx({ settings: { sellTaxRate: 5 } }), deps, ['SETTINGS_INVALID']);
    await expectBlocked(
      ctx({ settings: { sellTaxRate: 0.0018, maxGlobalOrdersPerDay: 0 } }),
      deps,
      ['SETTINGS_INVALID'],
    );
  });
});

describe('safeguard 9: warnings', () => {
  it.each([
    'LIQUIDATION_TRADING',
    'OVERHEATED',
    'INVESTMENT_WARNING',
    'INVESTMENT_RISK',
    'VI_STATIC',
    'VI_DYNAMIC',
    'VI_STATIC_AND_DYNAMIC',
    'STOCK_WARRANTS',
    'SOMETHING_NEW',
  ])('blocks an active %s warning', async (warningType) => {
    const { deps, fake } = env();
    fake.warnings.set('005930', [
      { warningType, exchange: 'KRX', startDate: '2026-10-01', endDate: '2026-10-31' },
    ]);
    await expectBlocked(ctx(), deps, ['STOCK_WARNING']);
  });
  it('blocks sells too (fail closed)', async () => {
    const { deps, fake, memory } = env();
    await holding(memory);
    fake.warnings.set('005930', [
      { warningType: 'INVESTMENT_RISK', exchange: null, startDate: null, endDate: null },
    ]);
    await expectBlocked(ctx({ order: sellOrder(), expectedProfit: null }), deps, ['STOCK_WARNING']);
  });
  it('ignores warnings that ended or have not started (KST date)', async () => {
    const { deps, fake } = env();
    fake.warnings.set('005930', [
      { warningType: 'OVERHEATED', exchange: null, startDate: '2026-09-01', endDate: '2026-10-20' },
      { warningType: 'OVERHEATED', exchange: null, startDate: '2026-10-22', endDate: null },
    ]);
    await expectAllowed(ctx(), deps);
    fake.warnings.set('005930', [
      { warningType: 'OVERHEATED', exchange: null, startDate: '2026-10-21', endDate: '2026-10-21' },
    ]);
    await expectBlocked(ctx(), deps, ['STOCK_WARNING']);
  });
  it('an unavailable or malformed warnings answer blocks', async () => {
    const { deps, fake } = env();
    fake.getFailures.set('/api/v1/stocks/005930/warnings', { status: 403, code: 'forbidden' });
    await expectBlocked(ctx(), deps, ['WARNINGS_UNAVAILABLE']);
    fake.getFailures.clear();
    fake.malformed.add('/api/v1/stocks/005930/warnings');
    await expectBlocked(ctx(), deps, ['WARNINGS_UNAVAILABLE']);
  });
  it('near price limits: refused within 3% of the upper or lower limit, or outside the range', async () => {
    const { deps, fake } = env();
    fake.priceLimits.set('005930', { upper: '91000', lower: '49000', currency: 'KRW' });
    const q = (price: number) =>
      krFacts({ quote: { price, observedAt: iso(NOW.getTime() - 1000) } });
    const at = (price: string) => ctx({ order: buyOrder({ price }), market: q(Number(price)) });
    await expectAllowed(at('88200'), deps); // 91000 * 0.97 = 88270 -> 88200 is below
    await expectBlocked(at('88300'), deps, ['NEAR_PRICE_LIMIT']);
    await expectAllowed(at('50500'), deps); // 49000 * 1.03 = 50470
    await expectBlocked(at('50400'), deps, ['NEAR_PRICE_LIMIT']);
    await expectBlocked(at('95000'), deps, ['NEAR_PRICE_LIMIT']);
  });
  it('price limit data: KR needs it, US has none, a currency mismatch or failure blocks', async () => {
    const { deps, fake } = env();
    fake.priceLimits.set('005930', { upper: null, lower: null, currency: 'KRW' });
    await expectBlocked(ctx(), deps, ['PRICE_LIMITS_UNAVAILABLE']);
    fake.priceLimits.set('005930', { upper: '91000', lower: '49000', currency: 'USD' });
    await expectBlocked(ctx(), deps, ['PRICE_LIMITS_UNAVAILABLE']);
    fake.priceLimits.set('005930', { upper: '91000', lower: '49000', currency: 'KRW' });
    fake.getFailures.set('/api/v1/price-limits', { status: 500, code: 'internal-error' });
    await expectBlocked(ctx(), deps, ['PRICE_LIMITS_UNAVAILABLE']);
  });
});

describe('safeguard 10: orders of 1e8 KRW or more are never placed', () => {
  const big = (quantity: number) =>
    ctx({ algorithm: krAlgorithm({ budget: 1e12 }), order: buyOrder({ quantity }) });
  it('KR buy: 100,000,000 and above is refused; just below passes', async () => {
    const { deps, fake } = env();
    fake.buyingPower.KRW = '1000000000000';
    await expectAllowed(big(1428), deps); // 99,960,000
    await expectBlocked(big(1429), deps, ['ORDER_TOO_LARGE']); // 100,030,000
    await expectBlocked(
      ctx({
        algorithm: krAlgorithm({ budget: 1e12 }),
        order: buyOrder({ quantity: 1000, price: '100000' }),
        market: krFacts({ quote: { price: 100_000, observedAt: iso(NOW.getTime() - 1000) } }),
      }),
      deps,
      ['ORDER_TOO_LARGE'],
    ); // exactly 1e8
  });
  it('the cap cannot be raised by settings, only lowered', async () => {
    const { deps, fake } = env();
    fake.buyingPower.KRW = '1000000000000';
    await expectBlocked(
      { ...big(1429), settings: { sellTaxRate: 0.0018, maxOrderValueKrw: 5e8 } },
      deps,
      ['ORDER_TOO_LARGE'],
    );
    await expectBlocked(
      { ...big(100), settings: { sellTaxRate: 0.0018, maxOrderValueKrw: 5_000_000 } },
      deps,
      ['ORDER_TOO_LARGE'],
    ); // 7,000,000 > 5,000,000
    expect(HARD_MAX_ORDER_VALUE_KRW).toBe(100_000_000);
  });
  it('US orders are converted to KRW with the midRate plus a safety margin', async () => {
    const { deps, fake } = env();
    fake.priceLimits.set('AAPL', { upper: null, lower: null, currency: 'USD' });
    fake.buyingPower.USD = '10000000';
    const us = (quantity: number, fx: number | null = 1400) =>
      ctx({
        algorithm: krAlgorithm({ market: 'US', budget: 1e9 }),
        order: buyOrder({ symbol: 'AAPL', quantity, price: '100' }),
        market: krFacts({
          quote: { price: 100, observedAt: iso(NOW.getTime() - 1000) },
          avgTradedValue: 9e9,
          fxMidRate: fx,
        }),
        settings: {},
      });
    // 700 * 100 * 1400 = 98.0M raw, 99.96M with the 2% margin: passes. 705 -> 98.7M raw but 100.67M with margin.
    await expectAllowed(us(700), deps);
    await expectBlocked(us(705), deps, ['ORDER_TOO_LARGE']);
    await expectBlocked(us(1, null), deps, ['FX_RATE_MISSING']);
    await expectBlocked(us(1, 0), deps, ['FX_RATE_MISSING']);
  });
  it('krwEquivalentPrice and planSellTranches', () => {
    expect(krwEquivalentPrice('KR', 70000, null)).toBe(70000);
    expect(krwEquivalentPrice('US', 100, null)).toBeNull();
    expect(krwEquivalentPrice('US', 100, 1400, 0.02)).toBeCloseTo(142_800);
    // KR sell of 3000 shares at 70,000: 1428 per tranche stays below 1e8.
    expect(
      planSellTranches({ market: 'KR', quantity: 3000, price: '70000', fxMidRate: null }),
    ).toEqual({ tranches: [1428, 1428, 144] });
    expect(
      planSellTranches({ market: 'KR', quantity: 10, price: '70000', fxMidRate: null }),
    ).toEqual({ tranches: [10] });
    expect(
      planSellTranches({ market: 'KR', quantity: 1, price: '100000000', fxMidRate: null }),
    ).toMatchObject({ error: 'ORDER_TOO_LARGE' });
    expect(
      planSellTranches({ market: 'US', quantity: 10, price: '100', fxMidRate: null }),
    ).toMatchObject({ error: 'FX_RATE_MISSING' });
    expect(
      planSellTranches({ market: 'KR', quantity: 0, price: '70000', fxMidRate: null }),
    ).toMatchObject({ error: 'ORDER_INVALID' });
    const split = planSellTranches({
      market: 'KR',
      quantity: 5000,
      price: '70000',
      fxMidRate: null,
    });
    expect(split.tranches.reduce((a, b) => a + b, 0)).toBe(5000);
    expect(split.tranches.every((q) => q * 70000 < 100_000_000)).toBe(true);
    const us = planSellTranches({ market: 'US', quantity: 2000, price: '100', fxMidRate: 1400 });
    expect(us.tranches.reduce((a, b) => a + b, 0)).toBe(2000);
    expect(us.tranches.every((q) => q * 100 * 1400 * 1.02 < 100_000_000)).toBe(true);
  });
  it('each tranche is checked separately (a tranche order passes where the whole would not)', async () => {
    const { deps, memory, fake } = env();
    await holding(memory, 3000);
    fake.sellable.set('005930', '3000');
    const sell = (quantity: number) =>
      ctx({ order: sellOrder({ quantity }), expectedProfit: null });
    await expectBlocked(sell(3000), deps, ['ORDER_TOO_LARGE']);
    await expectAllowed(sell(1428), deps);
  });
  it('isAcceptableCorrection: less aggressive only, scale-valid, value-capped', () => {
    const buy = ctx({
      order: buyOrder({ price: '50050' }),
      market: krFacts({ quote: { price: 50_050, observedAt: iso(NOW.getTime()) } }),
    });
    expect(isAcceptableCorrection(buy, '50000', NOW)).toBe(true);
    expect(isAcceptableCorrection(buy, '50100', NOW)).toBe(false); // buying higher is more aggressive
    expect(isAcceptableCorrection(buy, '50000.5', NOW)).toBe(false);
    const sell = ctx({ order: sellOrder({ price: '50050' }) });
    expect(isAcceptableCorrection(sell, '50100', NOW)).toBe(true);
    expect(isAcceptableCorrection(sell, '50000', NOW)).toBe(false);
    // A higher sell price can push a tranche over the cap: refused.
    const edge = ctx({ order: sellOrder({ quantity: 1428, price: '70000' }) });
    expect(isAcceptableCorrection(edge, '70100', NOW)).toBe(false); // 1428 * 70100 = 100,102,800
    expect(isAcceptableCorrection(edge, '70000', NOW)).toBe(true);
  });
});

describe('buying power (KRW, or USD cash only for US — no FX)', () => {
  it('KR: needs KRW cash for notional plus commission', async () => {
    const { deps, fake } = env();
    fake.buyingPower.KRW = '700000';
    await expectBlocked(ctx(), deps, ['BUYING_POWER_INSUFFICIENT']); // 700,000 + commission > 700,000
    fake.buyingPower.KRW = '700106';
    await expectAllowed(ctx(), deps);
    fake.buyingPower.KRW = '700104';
    await expectBlocked(ctx(), deps, ['BUYING_POWER_INSUFFICIENT']);
  });
  it('US: only the USD balance is read and used; plenty of KRW does not help', async () => {
    const { deps, fake } = env();
    fake.priceLimits.set('AAPL', { upper: null, lower: null, currency: 'USD' });
    fake.buyingPower.KRW = '999999999999';
    fake.buyingPower.USD = '900';
    const us = ctx({
      algorithm: krAlgorithm({ market: 'US', budget: 100000 }),
      order: buyOrder({ symbol: 'AAPL', quantity: 5, price: '185.5' }), // 927.5 USD
      market: krFacts({
        quote: { price: 185.5, observedAt: iso(NOW.getTime() - 1000) },
        avgTradedValue: 9e6,
        fxMidRate: 1400,
      }),
      settings: {},
    });
    await expectBlocked(us, deps, ['BUYING_POWER_INSUFFICIENT']);
    const bp = fake.calls.filter((c) => c.path === '/api/v1/buying-power');
    expect(bp.map((c) => c.query)).toEqual([{ currency: 'USD' }]);
    fake.buyingPower.USD = '1000';
    await expectAllowed(us, deps);
    expect(
      fake.calls
        .filter((c) => c.path === '/api/v1/buying-power')
        .every((c) => c.query?.currency === 'USD'),
    ).toBe(true);
  });
  it('an unavailable answer blocks', async () => {
    const { deps, fake } = env();
    fake.getFailures.set('/api/v1/buying-power', { status: 403, code: 'forbidden' });
    await expectBlocked(ctx(), deps, ['BUYING_POWER_UNAVAILABLE']);
  });
});

describe('cost rule: expected profit must exceed the round-trip cost, with enough history', () => {
  it('passes when the expected gross return beats commission both ways plus sell tax', async () => {
    const { deps } = env();
    await expectAllowed(
      ctx({ expectedProfit: { stats: sampleStats(0.5, 0.05), score: 0.5 } }),
      deps,
    );
  });
  it('blocks when it does not: 2 * 0.015% + 0.18% = 0.21%', async () => {
    const { deps } = env();
    await expectBlocked(
      ctx({ expectedProfit: { stats: sampleStats(0.5, 0.002), score: 0.5 } }),
      deps,
      ['EXPECTED_PROFIT_BELOW_COST'],
    );
    await expectAllowed(
      ctx({ expectedProfit: { stats: sampleStats(0.5, 0.0022), score: 0.5 } }),
      deps,
    );
  });
  it('holds with "기록 부족" when the bucket has fewer than minSamples samples', async () => {
    const { deps } = env();
    await expectBlocked(
      ctx({ expectedProfit: { stats: sampleStats(0.5, 0.05, 19), score: 0.5 } }),
      deps,
      ['HISTORY_INSUFFICIENT'],
    );
    await expectAllowed(
      ctx({ expectedProfit: { stats: sampleStats(0.5, 0.05, 20), score: 0.5 } }),
      deps,
    );
    await expectBlocked(
      ctx({
        expectedProfit: { stats: sampleStats(0.5, 0.05, 25), score: 0.5 },
        settings: { sellTaxRate: 0.0018, minSamples: 30 },
      }),
      deps,
      ['HISTORY_INSUFFICIENT'],
    );
    expect(REASONS.HISTORY_INSUFFICIENT).toBe('기록 부족으로 주문 보류');
  });
  it('holds when there is no statistics, no score, or the score lands in an empty bucket', async () => {
    const { deps } = env();
    await expectBlocked(ctx({ expectedProfit: null }), deps, ['HISTORY_INSUFFICIENT']);
    await expectBlocked(ctx({ expectedProfit: { stats: sampleStats(), score: null } }), deps, [
      'HISTORY_INSUFFICIENT',
    ]);
    await expectBlocked(
      ctx({ expectedProfit: { stats: sampleStats(0.5, 0.05), score: -0.7 } }),
      deps,
      ['HISTORY_INSUFFICIENT'],
    );
  });
  it('a missing sell-tax setting (KR) or commission entry blocks instead of assuming zero', async () => {
    const { deps, fake } = env();
    await expectBlocked(ctx({ settings: {} }), deps, ['COST_SETTINGS_MISSING']);
    fake.commissions = [
      { marketCountry: 'US', commissionRate: '0.0025', startDate: null, endDate: null },
    ];
    await expectBlocked(ctx(), deps, ['COST_SETTINGS_MISSING']);
    fake.commissions = [
      { marketCountry: 'KR', commissionRate: '0.00015', startDate: '2027-01-01', endDate: null },
    ];
    await expectBlocked(ctx(), deps, ['COST_SETTINGS_MISSING']);
    fake.getFailures.set('/api/v1/commissions', { status: 500, code: 'internal-error' });
    await expectBlocked(ctx(), deps, ['COMMISSIONS_UNAVAILABLE']);
  });
  it('uses the dearest active commission entry when several apply', async () => {
    const { deps, fake } = env();
    fake.commissions = [
      { marketCountry: 'KR', commissionRate: '0.00015', startDate: null, endDate: null },
      { marketCountry: 'KR', commissionRate: '0.002', startDate: '2026-10-01', endDate: null },
    ];
    // round trip = 0.004 + 0.0018 = 0.0058
    await expectBlocked(
      ctx({ expectedProfit: { stats: sampleStats(0.5, 0.005), score: 0.5 } }),
      deps,
      ['EXPECTED_PROFIT_BELOW_COST'],
    );
  });
});

describe('FX sanity for US orders (M3)', () => {
  const usCtx = (
    facts: Parameters<typeof krFacts>[0],
    settings: PreTradeContext['settings'] = {},
  ) =>
    ctx({
      algorithm: krAlgorithm({ market: 'US', budget: 1e9 }),
      order: buyOrder({ symbol: 'AAPL', quantity: 5, price: '100' }),
      market: krFacts({
        quote: { price: 100, observedAt: iso(NOW.getTime() - 1000) },
        avgTradedValue: 9e9,
        fxMidRate: 1400,
        ...facts,
      }),
      settings,
    });
  const usEnv = () => {
    const e = env();
    e.fake.priceLimits.set('AAPL', { upper: null, lower: null, currency: 'USD' });
    e.fake.buyingPower.USD = '1000000';
    return e;
  };
  const ago = (hours: number) => iso(NOW.getTime() - hours * 3_600_000);

  it('a plausible, fresh rate passes', async () => {
    const { deps } = usEnv();
    await expectAllowed(usCtx({}), deps);
    await expectAllowed(usCtx({ fxMidRate: 300 }), deps);
    await expectAllowed(usCtx({ fxMidRate: 5000 }), deps);
  });
  it.each([0.0014, 1.4, 14, 299.99, 5000.01, 1_400_000, Number.MAX_VALUE])(
    'rate %s is outside the plausible band: FX_RATE_INVALID',
    async (rate) => {
      const { deps, fake } = usEnv();
      await expectBlocked(usCtx({ fxMidRate: rate }), deps, ['FX_RATE_INVALID']);
      expect(fake.calls).toHaveLength(0);
    },
  );
  it.each([null, 0, -1400, NaN, Infinity])('rate %s is missing: FX_RATE_MISSING', async (rate) => {
    const { deps } = usEnv();
    await expectBlocked(usCtx({ fxMidRate: rate as never }), deps, ['FX_RATE_MISSING']);
  });
  it('a rate older than 6 hours (or without a timestamp, or from the future) is FX_RATE_STALE', async () => {
    const { deps } = usEnv();
    await expectAllowed(usCtx({ fxObservedAt: ago(6) }), deps);
    await expectBlocked(usCtx({ fxObservedAt: iso(NOW.getTime() - 6 * 3_600_000 - 1) }), deps, [
      'FX_RATE_STALE',
    ]);
    await expectBlocked(usCtx({ fxObservedAt: null }), deps, ['FX_RATE_STALE']);
    await expectBlocked(usCtx({ fxObservedAt: undefined }), deps, ['FX_RATE_STALE']);
    await expectBlocked(usCtx({ fxObservedAt: 'recently' }), deps, ['FX_RATE_STALE']);
    await expectBlocked(usCtx({ fxObservedAt: iso(NOW.getTime() + 3_600_000) }), deps, [
      'FX_RATE_STALE',
    ]);
  });
  it('band and age are configurable', async () => {
    const { deps } = usEnv();
    await expectBlocked(usCtx({ fxMidRate: 1400 }, { fxBand: { min: 1000, max: 1300 } }), deps, [
      'FX_RATE_INVALID',
    ]);
    await expectAllowed(usCtx({ fxMidRate: 1400 }, { fxBand: { min: 1000, max: 1500 } }), deps);
    await expectBlocked(usCtx({ fxObservedAt: ago(2) }, { maxFxAgeHours: 1 }), deps, [
      'FX_RATE_STALE',
    ]);
    await expectAllowed(usCtx({ fxObservedAt: ago(10) }, { maxFxAgeHours: 12 }), deps);
    for (const bad of [
      { min: 0, max: 10 },
      { min: 10, max: 10 },
      { min: 10, max: 5 },
      { min: NaN, max: 5 },
    ])
      await expectBlocked(usCtx({}, { fxBand: bad }), deps, ['SETTINGS_INVALID']);
    await expectBlocked(usCtx({}, { maxFxAgeHours: 0 }), deps, ['SETTINGS_INVALID']);
  });
  it('KR orders do not look at FX at all', async () => {
    const { deps } = env();
    await expectAllowed(ctx({ market: krFacts({ fxMidRate: null, fxObservedAt: null }) }), deps);
  });
  it('fxProblem, krwEquivalentPrice and planSellTranches share the band', () => {
    const settings = { fxBand: { min: 300, max: 5000 }, maxFxAgeMs: 6 * 3_600_000 };
    expect(fxProblem({ fxMidRate: 1400, fxObservedAt: ago(1) }, settings, NOW)).toBeNull();
    expect(fxProblem({ fxMidRate: 14, fxObservedAt: ago(1) }, settings, NOW)).toBe(
      'FX_RATE_INVALID',
    );
    expect(krwEquivalentPrice('US', 100, 14)).toBeNull();
    expect(krwEquivalentPrice('US', 100, 99_999)).toBeNull();
    expect(krwEquivalentPrice('US', 100, 1400, 0, { min: 1000, max: 2000 })).toBeCloseTo(140_000);
    expect(
      planSellTranches({ market: 'US', quantity: 10, price: '100', fxMidRate: 14 }),
    ).toMatchObject({ error: 'FX_RATE_INVALID' });
    expect(
      planSellTranches({
        market: 'US',
        quantity: 10,
        price: '100',
        fxMidRate: 14,
        settings: { fxBand: { min: 10, max: 20 } },
      }),
    ).toMatchObject({ tranches: [10] });
  });
  it('a mis-scaled rate cannot slip a huge order under the 1e8 cap', async () => {
    const { deps } = usEnv();
    // 14 instead of 1400: 70,000 shares of a $100 stock would be ~99M "KRW" at the wrong rate.
    await expectBlocked(usCtx({ fxMidRate: 14 }), deps, ['FX_RATE_INVALID']);
  });
});

describe('open-order guard trusts the symbol-filtered list (L2)', () => {
  const transportReturning = (fake: FakeToss, orders: unknown[]): OrderTransport => ({
    send: async (r: TransportRequest) =>
      r.path === '/api/v1/orders'
        ? { status: 200, body: { result: { orders, nextCursor: null, hasNext: false } } }
        : fake.send(r),
  });
  const order = (symbol: string) => ({
    orderId: 'o1',
    symbol,
    side: 'BUY',
    orderType: 'LIMIT',
    timeInForce: 'DAY',
    status: 'PENDING',
    price: '80000',
    quantity: '1',
    orderAmount: null,
    currency: 'KRW',
    orderedAt: iso(NOW.getTime()),
    canceledAt: null,
    execution: {
      filledQuantity: '0',
      averageFilledPrice: null,
      filledAmount: null,
      commission: null,
      tax: null,
      filledAt: null,
      settlementDate: null,
    },
  });
  it.each(['005930', ' 005930', '005930 ', '5930', 'samsung', 'AAPL'])(
    'any listed order blocks, whatever its symbol spelling (%j)',
    async (symbol) => {
      const e = env();
      const deps = {
        ...e.deps,
        toss: new TossOrderClient(transportReturning(e.fake, [order(symbol)])),
      };
      // Symbols with spaces are not valid provider symbols; the list itself is then invalid and blocks too.
      const result = await codes(ctx(), deps);
      expect(result).toHaveLength(1);
      expect(['OPEN_ORDER_EXISTS', 'OPEN_ORDERS_UNAVAILABLE']).toContain(result[0]);
    },
  );
  it('a lowercase spelling of the same symbol blocks', async () => {
    const e = env();
    e.fake.priceLimits.set('AAPL', { upper: null, lower: null, currency: 'USD' });
    const deps = {
      ...e.deps,
      toss: new TossOrderClient(transportReturning(e.fake, [order('aapl')])),
    };
    const us = ctx({
      algorithm: krAlgorithm({ market: 'US', budget: 1e9 }),
      order: buyOrder({ symbol: 'AAPL', quantity: 5, price: '100' }),
      market: krFacts({
        quote: { price: 100, observedAt: iso(NOW.getTime() - 1000) },
        avgTradedValue: 9e9,
        fxMidRate: 1400,
      }),
      settings: {},
    });
    await expectBlocked(us, deps, ['OPEN_ORDER_EXISTS']);
  });
  it('an empty list does not block', async () => {
    const e = env();
    const deps = { ...e.deps, toss: new TossOrderClient(transportReturning(e.fake, [])) };
    await expectAllowed(ctx(), deps);
  });
});

describe('tick-correction veto re-checks price limits and stop state (L3)', () => {
  const buy50050 = (lower: string) => ({
    c: ctx({
      order: buyOrder({ price: '50050' }),
      market: krFacts({ quote: { price: 50_050, observedAt: iso(NOW.getTime() - 1000) } }),
    }),
    lower,
  });
  it('accepts a correction that stays clear of the limits and refuses one that crosses the buffer', async () => {
    const ok = env();
    ok.fake.priceLimits.set('005930', { upper: '70000', lower: '40000', currency: 'KRW' });
    expect(await verifyCorrectedPrice(buy50050('').c, '50000', ok.deps)).toBe(true);
    // lower * 1.03 = 50,016.8: the original 50,050 is clear of it, the corrected 50,000 is not.
    const near = env();
    near.fake.priceLimits.set('005930', { upper: '70000', lower: '48560', currency: 'KRW' });
    expect(await preTradeCheck(buy50050('').c, near.deps)).toMatchObject({ allowed: true });
    expect(await verifyCorrectedPrice(buy50050('').c, '50000', near.deps)).toBe(false);
  });
  it('re-reads emergency stop and algorithm state; read failures refuse', async () => {
    const a = env();
    a.fake.priceLimits.set('005930', { upper: '70000', lower: '40000', currency: 'KRW' });
    a.memory.setEmergencyStop(true);
    expect(await verifyCorrectedPrice(buy50050('').c, '50000', a.deps)).toBe(false);
    const b = env();
    b.fake.priceLimits.set('005930', { upper: '70000', lower: '40000', currency: 'KRW' });
    await b.memory.stopAlgorithm('algo-1', 'x');
    expect(await verifyCorrectedPrice(buy50050('').c, '50000', b.deps)).toBe(false);
    const c = env();
    c.fake.priceLimits.set('005930', { upper: '70000', lower: '40000', currency: 'KRW' });
    c.fake.getFailures.set('/api/v1/price-limits', { status: 500, code: 'internal-error' });
    expect(await verifyCorrectedPrice(buy50050('').c, '50000', c.deps)).toBe(false);
    const d = env();
    d.fake.priceLimits.set('005930', { upper: '70000', lower: '40000', currency: 'KRW' });
    const throwing = {
      ...d.deps,
      store: {
        ...d.deps.store,
        getEmergencyStop: async () => {
          throw new Error('down');
        },
      } as PreTradeStore,
    };
    expect(await verifyCorrectedPrice(buy50050('').c, '50000', throwing)).toBe(false);
  });
  it('still refuses wrong-direction, off-scale and over-cap corrections', async () => {
    const e = env();
    e.fake.priceLimits.set('005930', { upper: '200000', lower: '40000', currency: 'KRW' });
    const c = buy50050('').c;
    expect(await verifyCorrectedPrice(c, '50100', e.deps)).toBe(false);
    expect(await verifyCorrectedPrice(c, '50000.5', e.deps)).toBe(false);
    const sell = ctx({
      order: sellOrder({ quantity: 1427, price: '70050' }),
      market: krFacts({ quote: { price: 70_050, observedAt: iso(NOW.getTime() - 1000) } }),
    });
    expect(await verifyCorrectedPrice(sell, '70100', e.deps)).toBe(false);
  });
  it('priceLimitProblem unit behaviour', () => {
    const limits = { upperLimitPrice: '91000', lowerLimitPrice: '49000', currency: 'KRW' };
    expect(priceLimitProblem('KR', 'KRW', 70000, limits, 0.03)).toBeNull();
    expect(priceLimitProblem('KR', 'KRW', 88_300, limits, 0.03)).toBe('NEAR_PRICE_LIMIT');
    expect(priceLimitProblem('KR', 'KRW', 50_400, limits, 0.03)).toBe('NEAR_PRICE_LIMIT');
    expect(priceLimitProblem('KR', 'USD', 70000, limits, 0.03)).toBe('PRICE_LIMITS_UNAVAILABLE');
    expect(
      priceLimitProblem(
        'KR',
        'KRW',
        70000,
        { ...limits, upperLimitPrice: null, lowerLimitPrice: null },
        0.03,
      ),
    ).toBe('PRICE_LIMITS_UNAVAILABLE');
    expect(
      priceLimitProblem(
        'US',
        'USD',
        100,
        { upperLimitPrice: null, lowerLimitPrice: null, currency: 'USD' },
        0.03,
      ),
    ).toBeNull();
    expect(priceLimitProblem('KR', 'KRW', 70000, { ...limits, upperLimitPrice: 'x' }, 0.03)).toBe(
      'PRICE_LIMITS_UNAVAILABLE',
    );
  });
});

describe('tranche count cap (L5)', () => {
  it('up to 50 tranches are planned, more are refused', () => {
    expect(MAX_SELL_TRANCHES).toBe(50);
    const at = (quantity: number) =>
      planSellTranches({ market: 'KR', quantity, price: '70000', fxMidRate: null });
    // 1428 shares per tranche at 70,000 KRW.
    const fifty = at(1428 * 50);
    expect(fifty.tranches).toHaveLength(50);
    expect(fifty.tranches.every((q) => q === 1428)).toBe(true);
    expect(at(1428 * 50 + 1)).toMatchObject({ tranches: [], error: 'ORDER_TOO_LARGE' });
    expect(at(1428 * 50 - 1).tranches).toHaveLength(50);
    expect(at(1428 * 49 + 1).tranches).toHaveLength(50);
  });
  it('applies to US sells too', () => {
    const r = planSellTranches({
      market: 'US',
      quantity: 1_000_000,
      price: '100',
      fxMidRate: 1400,
    });
    expect(r).toMatchObject({ tranches: [], error: 'ORDER_TOO_LARGE' });
  });
});
