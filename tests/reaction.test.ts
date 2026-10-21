import { describe, expect, it, vi } from 'vitest';
import type { EconomicEvent, EventReaction } from '../src/server/calendar';
import { cleanEvent } from '../src/server/calendar';
import {
  ReactionCalculator,
  expectedAssets,
  krCloseInstant,
  mergeReactions,
  pickWindow,
  reactionChange,
  reactionIsSmall,
  reactionSettled,
  releaseInstant,
  usCloseInstant,
  type Bar,
  type ReactionToss,
} from '../src/server/reaction';

const kst = (date: string, time: string) => Date.parse(`${date}T${time}:00+09:00`);
const NOW = kst('2026-10-27', '09:00');
const bar = (date: string, close: number): Bar => ({ date, close });
// Trading days: Mon 19, Tue 20, Wed 21, Thu 22, Fri 23, Mon 26 (no weekend bars).
const DAYS = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26'];
const series = (start: number, step: number): Bar[] =>
  DAYS.map((date, index) => bar(date, start + step * index));

describe('세션 종가 시각', () => {
  it('한국 15:30 KST, 미국 16:00 뉴욕(서머타임 반영)', () => {
    expect(krCloseInstant('2026-10-20')).toBe(Date.parse('2026-10-20T06:30:00Z'));
    // EDT in October (UTC-4), EST in December (UTC-5).
    expect(usCloseInstant('2026-10-20')).toBe(Date.parse('2026-10-20T20:00:00Z'));
    expect(usCloseInstant('2026-12-15')).toBe(Date.parse('2026-12-15T21:00:00Z'));
    // Around the change (2026-11-01 is the first Sunday of November).
    expect(usCloseInstant('2026-10-30')).toBe(Date.parse('2026-10-30T20:00:00Z'));
    expect(usCloseInstant('2026-11-02')).toBe(Date.parse('2026-11-02T21:00:00Z'));
  });
  it('발표 시각이 없으면 반응을 계산하지 않는다', () => {
    expect(releaseInstant({ date: '2026-10-20', time: '' })).toBeNull();
    expect(releaseInstant({ date: '2026-10-20', time: '10:00' })).toBe(kst('2026-10-20', '10:00'));
  });
});

describe('발표 전 마지막 종가 vs 발표 후 첫 종가', () => {
  const bars = series(100, 1);
  it('한국 발표: 15:30 이전이면 같은 세션, 이후면 다음 세션', () => {
    expect(pickWindow(bars, 'KR', kst('2026-10-20', '10:00'), NOW)).toEqual({
      from: bar('2026-10-19', 100),
      to: bar('2026-10-20', 101),
    });
    expect(pickWindow(bars, 'KR', kst('2026-10-20', '15:29'), NOW)?.to.date).toBe('2026-10-20');
    // Exactly at the close: that session's close is "before".
    expect(pickWindow(bars, 'KR', kst('2026-10-20', '15:30'), NOW)).toEqual({
      from: bar('2026-10-20', 101),
      to: bar('2026-10-21', 102),
    });
    expect(pickWindow(bars, 'KR', kst('2026-10-20', '18:00'), NOW)?.from.date).toBe('2026-10-20');
    expect(pickWindow(bars, 'KR', kst('2026-10-20', '18:00'), NOW)?.to.date).toBe('2026-10-21');
  });
  it('주말·휴일 발표는 다음 거래일 종가를 쓴다', () => {
    expect(pickWindow(bars, 'KR', kst('2026-10-24', '10:00'), NOW)).toEqual({
      from: bar('2026-10-23', 104),
      to: bar('2026-10-26', 105),
    });
  });
  it('미국 발표(KST 새벽): SPY는 다음 미국 세션 종가, 한국 자산은 다음 한국 세션 종가', () => {
    // Fed statement 2026-10-22 03:00 KST = 2026-10-21 14:00 EDT.
    const release = kst('2026-10-22', '03:00');
    expect(pickWindow(bars, 'US', release, NOW)).toEqual({
      from: bar('2026-10-20', 101),
      to: bar('2026-10-21', 102),
    });
    expect(pickWindow(bars, 'KR', release, NOW)).toEqual({
      from: bar('2026-10-21', 102),
      to: bar('2026-10-22', 103),
    });
    // After the US close (21:00 EDT = 10:00 KST next day): next US session.
    const late = kst('2026-10-22', '10:00');
    expect(pickWindow(bars, 'US', late, NOW)).toEqual({
      from: bar('2026-10-21', 102),
      to: bar('2026-10-22', 103),
    });
  });
  it('아직 끝나지 않았거나 막 끝난 종가는 쓰지 않는다', () => {
    const release = kst('2026-10-21', '10:00');
    // 15:40 KST: the bar of the day exists but settled 10 minutes ago only.
    expect(pickWindow(bars, 'KR', release, kst('2026-10-21', '15:40'))).toBeNull();
    expect(pickWindow(bars, 'KR', release, kst('2026-10-21', '16:01'))?.to.date).toBe('2026-10-21');
  });
  it('자료 공백(7일 넘게 떨어진 종가)과 한쪽 부재는 계산하지 않는다', () => {
    expect(
      pickWindow(
        [bar('2026-10-01', 100), bar('2026-10-26', 105)],
        'KR',
        kst('2026-10-15', '10:00'),
        NOW,
      ),
    ).toBeNull();
    expect(pickWindow([bar('2026-10-19', 100)], 'KR', kst('2026-10-20', '10:00'), NOW)).toBeNull();
    expect(pickWindow([bar('2026-10-21', 100)], 'KR', kst('2026-10-20', '10:00'), NOW)).toBeNull();
    expect(pickWindow([], 'KR', kst('2026-10-20', '10:00'), NOW)).toBeNull();
  });
});

describe('단위: 지수·SPY는 %, 국채는 %p, 환율은 원과 %', () => {
  it('변화량 계산', () => {
    expect(reactionChange('KOSPI', 2500, 2512.5)).toEqual({ change: 0.5, unit: '%' });
    expect(reactionChange('SPY', 500, 495)).toEqual({ change: -1, unit: '%' });
    // A yield move is a difference in percentage points, never a ratio.
    expect(reactionChange('KR_BOND_3Y', 3.0, 3.015)).toEqual({ change: 0.015, unit: '%p' });
    expect(reactionChange('KR_BOND_10Y', 3.5, 3.4)).toEqual({ change: -0.1, unit: '%p' });
    expect(reactionChange('USDKRW', 1400, 1403.2)).toEqual({
      change: 3.2,
      unit: '원',
      changePercent: 0.23,
    });
    expect(reactionChange('KOSPI', 0, 1)).toBeNull();
    expect(reactionChange('KOSPI', Number.NaN, 1)).toBeNull();
  });
  it('작은 반응 기준: 지수 0.5% 미만, 국채 0.05%p 미만, 대표 지수가 있어야 한다', () => {
    const row = (
      asset: EventReaction['asset'],
      change: number,
      unit: EventReaction['unit'],
      changePercent?: number,
    ): EventReaction => ({
      asset,
      from: { date: '2026-10-19', value: 1 },
      to: { date: '2026-10-20', value: 1 },
      change,
      unit,
      ...(changePercent === undefined ? {} : { changePercent }),
      source: 's',
    });
    const small = [
      row('KOSPI', 0.3, '%'),
      row('KR_BOND_3Y', 0.04, '%p'),
      row('USDKRW', 2, '원', 0.15),
    ];
    expect(reactionIsSmall(small, '한국')).toBe(true);
    expect(reactionIsSmall([row('KOSPI', -0.5, '%')], '한국')).toBe(false);
    expect(reactionIsSmall([row('KOSPI', 0.1, '%'), row('KR_BOND_10Y', 0.05, '%p')], '한국')).toBe(
      false,
    );
    expect(reactionIsSmall([row('KOSPI', 0.1, '%'), row('USDKRW', 8, '원', 0.6)], '한국')).toBe(
      false,
    );
    // No lead index measured: not small (KOSPI for Korean releases, SPY otherwise).
    expect(reactionIsSmall([row('KR_BOND_3Y', 0.01, '%p')], '한국')).toBe(false);
    expect(reactionIsSmall([row('KOSPI', 0.1, '%')], '미국')).toBe(false);
    expect(reactionIsSmall([row('SPY', 0.1, '%'), row('KOSPI', 0.2, '%')], '미국')).toBe(true);
    expect(reactionIsSmall([], '한국')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Calculator with a fake Toss client.
// ---------------------------------------------------------------------------
const candle = (date: string, close: number) => ({
  timestamp: `${date}T00:00:00+09:00`,
  date,
  open: String(close),
  high: String(close),
  low: String(close),
  close: String(close),
  volume: '0',
});
const page = (bars: Bar[]) => ({
  candles: [...bars].reverse().map((b) => candle(b.date, b.close)),
  nextBefore: null,
});
function fakeToss(overrides: Partial<Record<string, Bar[] | Error>> = {}) {
  const data: Record<string, Bar[] | Error> = {
    KOSPI: series(2500, 10),
    KOSDAQ: series(800, 2),
    KR_BOND_3Y: series(3.0, 0.01),
    KR_BOND_10Y: series(3.4, 0.02),
    SPY: series(500, 1),
    ...overrides,
  };
  const read = async (symbol: string) => {
    const value = data[symbol];
    if (value instanceof Error) throw value;
    return page(value ?? []);
  };
  const rates: Record<string, string> = {
    '2026-10-19T06:30:00.000Z': '1400',
    '2026-10-20T06:30:00.000Z': '1403.2',
    '2026-10-21T06:30:00.000Z': '1401',
    '2026-10-22T06:30:00.000Z': '1399',
  };
  const toss = {
    marketIndicatorCandlePage: vi.fn(async (symbol: string) => read(symbol)),
    dailyCandlePage: vi.fn(async (symbol: string) => ({
      candles: (await read(symbol)).candles.map((c) => ({ ...c, currency: 'USD' as const })),
      nextBefore: null,
    })),
    exchangeRateAt: vi.fn(async (dateTime: string) => {
      const mid = rates[dateTime];
      if (!mid) throw new Error('no rate');
      const at = Date.parse(dateTime);
      return {
        midRate: mid,
        validFrom: new Date(at - 3600_000).toISOString(),
        validUntil: new Date(at + 3600_000).toISOString(),
      };
    }),
  };
  return toss;
}
const event = (over: Partial<EconomicEvent> = {}): EconomicEvent =>
  cleanEvent({
    id: 1,
    eventKind: 'news-release',
    date: '2026-10-20',
    time: '10:00',
    title: '테스트 발표',
    country: '한국',
    category: '공식 보도자료·기관발표',
    assets: ['시장전반'],
    importance: 1,
    description: 'x',
    sourceUrl: 'https://www.bok.or.kr/a',
    sourceName: '한국은행 공식 보도자료',
    impactDirection: 'unknown',
    impactHorizon: 'x',
    confidence: 'low',
    factualObservedAt: '2026-10-21T00:00:00Z',
    ...over,
  })!;
const calculator = (toss: ReturnType<typeof fakeToss>, now = NOW, extra = {}) =>
  new ReactionCalculator(toss as unknown as ReactionToss, { now: () => now, ...extra });

describe('ReactionCalculator', () => {
  it('한국 발표(10:00): 전 날 종가 → 당일 종가, 단위 구분, 환율은 같은 두 종가 시각의 매매기준율', async () => {
    const toss = fakeToss();
    const calc = calculator(toss);
    await calc.load('2026-10-10', new Set(['한국']));
    const { rows, codes } = await calc.forEvent(event());
    const byAsset = Object.fromEntries(rows.map((row) => [row.asset, row]));
    expect(Object.keys(byAsset)).toEqual([
      'KOSPI',
      'KOSDAQ',
      'KR_BOND_3Y',
      'KR_BOND_10Y',
      'USDKRW',
    ]);
    expect(byAsset.KOSPI).toMatchObject({
      from: { date: '2026-10-19', value: 2500 },
      to: { date: '2026-10-20', value: 2510 },
      change: 0.4,
      unit: '%',
      source: '토스증권 OpenAPI 시장 지표(일봉 종가)',
    });
    expect(byAsset.KR_BOND_3Y).toMatchObject({ change: 0.01, unit: '%p' });
    expect(byAsset.KR_BOND_10Y).toMatchObject({ change: 0.02, unit: '%p' });
    expect(byAsset.USDKRW).toMatchObject({
      from: { date: '2026-10-19', value: 1400 },
      to: { date: '2026-10-20', value: 1403.2 },
      change: 3.2,
      unit: '원',
      changePercent: 0.23,
      source: '토스증권 OpenAPI 환율(매매기준율)',
    });
    expect(codes).toEqual([]);
    // 한국 발표에는 SPY를 계산하지 않고 SPY 캔들도 받지 않는다.
    expect(byAsset.SPY).toBeUndefined();
    expect(toss.dailyCandlePage).not.toHaveBeenCalled();
    // The rate is read at the two KR closes (15:30 KST) with the documented dateTime query.
    expect(toss.exchangeRateAt.mock.calls.map((call) => call[0])).toEqual([
      '2026-10-19T06:30:00.000Z',
      '2026-10-20T06:30:00.000Z',
    ]);
  });
  it('미국 발표: SPY(ETF 기준 표기)는 미국 세션, 한국 자산은 다음 한국 세션', async () => {
    const toss = fakeToss();
    const calc = calculator(toss);
    await calc.load('2026-10-10', new Set(['미국']));
    const us = event({
      country: '미국',
      date: '2026-10-22',
      time: '03:00',
      title: 'Fed statement',
    });
    const { rows } = await calc.forEvent(us);
    const byAsset = Object.fromEntries(rows.map((row) => [row.asset, row]));
    expect(byAsset.SPY).toMatchObject({
      from: { date: '2026-10-20', value: 501 },
      to: { date: '2026-10-21', value: 502 },
      unit: '%',
      source: 'SPY ETF 기준 · 토스증권 OpenAPI(일봉 종가)',
    });
    expect(byAsset.KOSPI).toMatchObject({
      from: { date: '2026-10-21', value: 2520 },
      to: { date: '2026-10-22', value: 2530 },
    });
    expect(byAsset.USDKRW).toMatchObject({
      from: { date: '2026-10-21', value: 1401 },
      to: { date: '2026-10-22', value: 1399 },
      change: -2,
    });
    expect(toss.dailyCandlePage).toHaveBeenCalledWith('SPY', expect.anything());
  });
  it('자료가 없는 자산은 빠지고 추정하지 않는다', async () => {
    const calc = calculator(
      fakeToss({ KR_BOND_10Y: new Error('boom'), KOSDAQ: [bar('2026-10-19', 800)] }),
    );
    await calc.load('2026-10-10', new Set(['한국']));
    const { rows, codes } = await calc.forEvent(event());
    expect(rows.map((row) => row.asset)).toEqual(['KOSPI', 'KR_BOND_3Y', 'USDKRW']);
    expect(codes).toEqual(
      expect.arrayContaining(['REACTION_SERIES_MISSING', 'REACTION_DATA_PENDING']),
    );
    expect(calc.codes.get('REACTION_SERIES_FAILED')).toBe(1);
  });
  it('환율 조회 실패·유효 구간 밖·예산 초과는 환율만 뺀다', async () => {
    const failing = fakeToss();
    failing.exchangeRateAt.mockRejectedValue(new Error('x'));
    const a = calculator(failing);
    await a.load('2026-10-10', new Set(['한국']));
    const resultA = await a.forEvent(event());
    expect(resultA.rows.map((row) => row.asset)).not.toContain('USDKRW');
    expect(resultA.codes).toContain('FX_UNAVAILABLE');
    // A rate whose validity window does not contain the instant is not that moment's rate.
    const stale = fakeToss();
    stale.exchangeRateAt.mockImplementation(async () => ({
      midRate: '1400',
      validFrom: '2026-01-01T00:00:00Z',
      validUntil: '2026-01-02T00:00:00Z',
    }));
    const b = calculator(stale);
    await b.load('2026-10-10', new Set(['한국']));
    expect((await b.forEvent(event())).rows.map((row) => row.asset)).not.toContain('USDKRW');
    expect(b.codes.get('FX_NOT_IN_EFFECT')).toBeGreaterThan(0);
    const budget = fakeToss();
    const c = calculator(budget, NOW, { fxBudget: 1 });
    await c.load('2026-10-10', new Set(['한국']));
    expect((await c.forEvent(event())).rows.map((row) => row.asset)).not.toContain('USDKRW');
    expect(budget.exchangeRateAt).toHaveBeenCalledTimes(1);
    expect(c.codes.get('FX_BUDGET_EXHAUSTED')).toBe(1);
  });
  it('같은 시각의 환율은 한 번만 조회한다', async () => {
    const toss = fakeToss();
    const calc = calculator(toss);
    await calc.load('2026-10-10', new Set(['한국']));
    await calc.forEvent(event());
    await calc.forEvent(event({ id: 2, time: '11:00' }));
    expect(toss.exchangeRateAt).toHaveBeenCalledTimes(2);
  });
  it('시각 미확인 이벤트와 종가가 아직 없는 이벤트', async () => {
    const calc = calculator(fakeToss());
    await calc.load('2026-10-10', new Set(['한국']));
    expect(await calc.forEvent(event({ time: '' }))).toEqual({
      rows: [],
      codes: ['RELEASE_TIME_UNKNOWN'],
    });
    const future = await calc.forEvent(event({ date: '2026-10-27', time: '08:00' }));
    expect(future.rows).toEqual([]);
    expect(future.codes).toContain('REACTION_DATA_PENDING');
  });
});

describe('병합과 확정', () => {
  const row = (asset: EventReaction['asset'], change: number): EventReaction => ({
    asset,
    from: { date: '2026-10-19', value: 1 },
    to: { date: '2026-10-20', value: 2 },
    change,
    unit: '%',
    source: 's',
  });
  it('새 값이 같은 자산을 바꾸고 없는 자산은 남긴다(널로 덮지 않는다)', () => {
    const merged = mergeReactions(
      [row('KOSPI', 1), row('SPY', 2)],
      [row('KOSPI', 3), row('KOSDAQ', 4)],
    );
    expect(merged.map((r) => [r.asset, r.change])).toEqual([
      ['SPY', 2],
      ['KOSPI', 3],
      ['KOSDAQ', 4],
    ]);
    expect(mergeReactions(undefined, [])).toEqual([]);
  });
  it('모두 있거나 3일이 지나면 더 바뀌지 않는다', () => {
    const e = event();
    const all = expectedAssets('한국').map((asset) => row(asset, 0));
    expect(reactionSettled(e, '2026-10-21', all)).toBe(true);
    expect(reactionSettled(e, '2026-10-21', all.slice(1))).toBe(false);
    expect(reactionSettled(e, '2026-10-23', [])).toBe(false);
    expect(reactionSettled(e, '2026-10-23', all.slice(1))).toBe(false);
    expect(reactionSettled(e, '2026-10-24', [])).toBe(true);
    expect(expectedAssets('미국')).toContain('SPY');
    expect(expectedAssets('한국')).not.toContain('SPY');
  });
});
