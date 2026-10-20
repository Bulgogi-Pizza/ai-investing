import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createRecommendation } from '../src/server/recommendations';
import { MemoryCalendarRepository, type EconomicEvent } from '../src/server/calendar';
import { MemoryStore, type Strategy } from '../src/server/store';
import { ProviderError, type TossClient, type PortfolioResponse } from '../src/server/toss';
import { createApp } from '../src/server/app';
import { hashPassword } from '../src/server/auth';
const now = new Date('2026-10-20T03:00:00Z');
const strategy: Strategy = {
  name: '장기 분산',
  horizon: '5년',
  benchmark: 'KOSPI',
  riskTolerance: 'medium',
  targetAllocations: [{ asset: '주식', percentage: 100 }],
  notes: '분기 점검',
};
const portfolio: PortfolioResponse = {
  source: 'fixture-provider',
  asOf: now.toISOString(),
  scope: 'stocks-only',
  totals: {
    KRW: { marketValue: '1000', purchaseAmount: '900', profitLoss: '100' },
    USD: { marketValue: '100', purchaseAmount: '90', profitLoss: '10' },
  },
  holdings: [
    {
      symbol: '005930',
      name: 'fixture',
      market: 'KR',
      currency: 'KRW',
      quantity: '10',
      lastPrice: '100',
      averagePurchasePrice: '90',
      marketValue: '1000',
      profitLoss: '100',
      profitLossRate: '0.1',
    },
    {
      symbol: 'AAPL',
      name: 'fixture',
      market: 'US',
      currency: 'USD',
      quantity: '1',
      lastPrice: '100',
      averagePurchasePrice: '90',
      marketValue: '100',
      profitLoss: '10',
      profitLossRate: '0.1',
    },
  ],
};
function provider(closes = Array(90).fill(100) as number[], end = now) {
  return {
    portfolio: vi.fn(async (userId: string) => {
      if (userId !== 'owner')
        throw new ProviderError(403, 'PORTFOLIO_OWNER_REQUIRED', 'owner only');
      return portfolio;
    }),
    candles: vi.fn(async () => ({
      source: 'fixture-provider',
      asOf: end.toISOString(),
      symbol: '005930',
      interval: '1d',
      adjusted: true,
      candles: closes.map((close, index) => ({
        timestamp: new Date(end.getTime() - (closes.length - 1 - index) * 86400000).toISOString(),
        open: String(close),
        high: String(close),
        low: String(close),
        close: String(close),
        volume: '100',
        currency: 'KRW',
      })),
    })),
  };
}
function run(
  toss = provider(),
  period: 'daily' | 'weekly' | 'monthly' = 'daily',
  saved = strategy,
  calendar = new MemoryCalendarRepository(),
) {
  return createRecommendation({
    userId: 'owner',
    strategy: saved,
    period,
    symbol: '005930',
    toss,
    calendar,
    now,
  });
}
const event: EconomicEvent = {
  id: 1,
  date: '2026-10-21',
  time: '12:00',
  title: '실등록 fixture 일정',
  country: '한국',
  category: '금리',
  assets: ['주식'],
  importance: 3,
  description: 'Fixture only',
  sourceName: 'fixture',
  sourceUrl: 'https://example.test/source',
  impactDirection: 'unknown',
  impactHorizon: '1일',
  confidence: 'low',
  factualObservedAt: now.toISOString(),
};
describe('actual-input rule recommendations', () => {
  it('computes observed horizon returns, SMA20 and RSI14 without confidence fabrication', async () => {
    const closes = Array.from({ length: 90 }, (_, index) => 100 + index);
    const toss = provider(closes);
    const result = await run(toss, 'monthly');
    expect(result.engine).toBe('rules-v1');
    expect(result.dataMode).toBe('live');
    expect(result.metrics.returnPercent).toBeCloseTo((189 / 169 - 1) * 100);
    expect(result.metrics.sma20).toBe(179.5);
    expect(result.metrics.rsi14).toBe(100);
    expect(result.decision.action).toBe('review-risk');
    expect(result.evidence.market.candles).toHaveLength(90);
    expect(toss.candles).toHaveBeenCalledWith('005930', '1d', 90);
    expect(result).not.toHaveProperty('confidence');
    expect(result.strategy).toEqual(strategy);
  });
  it('applies risk profile thresholds and handles flat/declining series', async () => {
    for (const [riskTolerance, expected] of [
      ['low', 2],
      ['medium', 4],
      ['high', 6],
    ] as const) {
      const result = await run(provider(), 'daily', { ...strategy, riskTolerance });
      expect(result.decision.thresholdPercent).toBe(expected);
      expect(result.decision.action).toBe('hold-plan');
      expect(result.metrics.rsi14).toBe(50);
    }
    const decline = Array(90).fill(100);
    decline[89] = 97;
    const low = await run(provider(decline), 'daily', { ...strategy, riskTolerance: 'low' });
    const high = await run(provider(decline), 'daily', { ...strategy, riskTolerance: 'high' });
    expect(low.decision.action).toBe('review-risk');
    expect(high.decision.action).toBe('hold-plan');
    const result = await run(provider(Array.from({ length: 90 }, (_, i) => 200 - i)), 'weekly');
    expect(result.metrics.rsi14).toBe(0);
    expect(result.decision.action).toBe('review-risk');
  });
  it('uses KST future curated events, source links and explicit coverage gaps', async () => {
    const calendar = new MemoryCalendarRepository();
    await calendar.upsert(
      [
        event,
        { ...event, id: 2, date: '2026-10-20', time: '10:00' },
        { ...event, id: 3, date: '2026-11-25' },
      ],
      'admin',
    );
    const result = await run(provider(), 'daily', strategy, calendar);
    expect(result.evidence.calendar.from).toBe('2026-10-20');
    expect(result.evidence.calendar.to).toBe('2026-10-21');
    expect(result.evidence.calendar.events.map((e) => e.id)).toEqual([1]);
    expect(result.evidence.calendar.events[0].sourceUrl).toBe(event.sourceUrl);
    expect(result.decision.action).toBe('review-risk');
    expect(result.evidence.calendar.coverageWarning).toContain('전체 금융 뉴스');
    const empty = await run();
    expect(empty.evidence.calendar.events).toEqual([]);
    expect(empty.evidence.calendar.coverageWarning).toContain('위험이 없다는 뜻이 아닙니다');
  });
  it('excludes unrelated market events and malformed stored records before changing decisions', async () => {
    const calendar = new MemoryCalendarRepository();
    await calendar.upsert(
      [
        { ...event, country: '미국' },
        { ...event, id: 2, date: '2026-99-99' },
        { ...event, id: 3, sourceUrl: 'javascript:bad' },
      ],
      'admin',
    );
    const result = await run(provider(), 'daily', strategy, calendar);
    expect(result.decision.action).toBe('hold-plan');
    expect(result.evidence.calendar.events).toEqual([]);
    expect(result.evidence.calendar.excludedCount).toBe(2);
    expect(result.evidence.calendar.relevanceRule).toContain('같은 시장');
    await calendar.upsert(
      [
        { ...event, id: 4, country: '미국', assets: ['005930'] },
        { ...event, id: 5, country: '글로벌' },
      ],
      'admin',
    );
    const relevant = await run(provider(), 'daily', strategy, calendar);
    expect(relevant.evidence.calendar.events.map((item) => item.id)).toEqual([4, 5]);
    expect(relevant.decision.action).toBe('review-risk');
  });
  it('keeps recent published news separate from upcoming events without heuristic action flips', async () => {
    const calendar = new MemoryCalendarRepository();
    await calendar.upsert(
      [
        {
          ...event,
          id: 30,
          eventKind: 'news-release',
          date: '2026-10-19',
          time: '15:00',
          country: '미국',
        },
        { ...event, id: 31, eventKind: 'news-release', date: '2026-10-20', time: '11:00' },
        { ...event, id: 32, eventKind: 'news-release', date: '2026-10-20', time: '13:00' },
        { ...event, id: 33, date: '2026-10-20', time: '11:00' },
        { ...event, id: 34, eventKind: 'news-release', date: '2026-10-19', time: '11:00' },
        {
          ...event,
          id: 36,
          eventKind: 'news-release',
          date: '2026-10-19',
          time: '15:00',
          country: '글로벌',
        },
      ],
      'admin',
    );
    const daily = await run(provider(), 'daily', strategy, calendar);
    expect(daily.evidence.calendar.events).toEqual([]);
    expect(daily.evidence.news.events.map((item) => item.id)).toEqual([31, 36]);
    expect(daily.evidence.news.events.every((item) => item.eventKind === 'news-release')).toBe(
      true,
    );
    expect(daily.evidence.news.excludedCount).toBe(1);
    expect(daily.evidence.news.coverageWarning).toContain('미래 지표 발표 일정이 아니며');
    expect(daily.decision.action).toBe('hold-plan');
    expect(daily.decision.rationale).toContain('최근 공개 보도자료 2건');
    const weekly = await run(provider(), 'weekly', strategy, calendar);
    expect(weekly.evidence.news.events.map((item) => item.id)).toEqual([31, 36, 34]);
    expect(weekly.decision.action).toBe('hold-plan');
  });
  it('keeps KRW and USD stock weights separate and never claims total allocation', async () => {
    const result = await run();
    expect(
      result.stockExposureByCurrency.map((group) => group.holdings[0].weightWithinStocksPercent),
    ).toEqual([100, 100]);
    expect(result.risks.join(' ')).toContain('전체 자산 배분');
  });
  it('rejects non-owner, invalid period, stale, malformed and insufficient candles without fallback', async () => {
    const toss = provider();
    await expect(
      createRecommendation({
        userId: 'other',
        strategy,
        period: 'daily',
        symbol: '005930',
        toss,
        calendar: new MemoryCalendarRepository(),
        now,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(toss.candles).not.toHaveBeenCalled();
    await expect(
      createRecommendation({
        userId: 'owner',
        strategy,
        period: 'bad' as 'daily',
        symbol: '005930',
        toss,
        calendar: new MemoryCalendarRepository(),
        now,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(run(provider(Array(20).fill(100)))).rejects.toMatchObject({
      code: 'INSUFFICIENT_MARKET_DATA',
    });
    await expect(
      run(provider(Array(90).fill(100), new Date('2026-09-01T00:00:00Z'))),
    ).rejects.toMatchObject({ code: 'STALE_MARKET_DATA' });
    const values = Array(90).fill(100);
    values[88] = NaN;
    await expect(run(provider(values))).rejects.toMatchObject({ code: 'INSUFFICIENT_MARKET_DATA' });
  });
  it('enforces HTTP authentication, saved strategy and per-user three-per-minute budget', async () => {
    const store = new MemoryStore();
    const password = 'fixture password at least twelve';
    const user = await store.createUser({
      email: 'fixture@example.test',
      passwordHash: await hashPassword(password),
      role: 'member',
      active: true,
      version: 1,
    });
    const toss = provider();
    toss.portfolio = vi.fn(async () => portfolio);
    // Route uses real current time; fixture latest timestamp must use current clock.
    const current = provider(Array(90).fill(100), new Date());
    toss.candles = current.candles;
    const app = createApp({
      store,
      origin: 'http://127.0.0.1:5173',
      toss: toss as unknown as TossClient,
    });
    expect((await request(app).get('/api/recommendations')).status).toBe(401);
    const login = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://127.0.0.1:5173')
      .send({ email: user.email, password });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    expect(
      (await request(app).get('/api/recommendations?period=invalid').set('Cookie', cookie)).status,
    ).toBe(400);
    expect((await request(app).get('/api/recommendations').set('Cookie', cookie)).status).toBe(409);
    await store.putStrategy(user.id, strategy);
    expect((await request(app).get('/api/recommendations').set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).get('/api/recommendations').set('Cookie', cookie)).status).toBe(429);
  });
});
