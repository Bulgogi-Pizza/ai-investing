import { describe, expect, it } from 'vitest';
import {
  candleDate,
  compareSector,
  limitProximity,
  marketCapitalization,
  marketOf,
  NEAR_LIMIT_RATE,
  previousCloseChange,
  stockFlagLabels,
  warningLabel,
} from '../src/lib/analysis';
import {
  formatKrwLarge,
  formatPrice,
  formatSignedPercent,
  formatSignedPrice,
  formatStatementAmount,
  formatUsdLarge,
} from '../src/lib/format';
import { buildChartModel, targetBars, windowBars, type Candle } from '../src/lib/chartData';
import { parseCandlePage, parseCandles } from '../src/features/analysis/candles';
import { ApiError, NoDataError } from '../src/lib/api';

const candle = (timestamp: string, close: number) => ({ timestamp, close });

describe('previousCloseChange (basis: daily candles)', () => {
  const kr = [
    candle('2026-10-16T00:00:00+09:00', 100),
    candle('2026-10-19T00:00:00+09:00', 110),
    candle('2026-10-20T00:00:00+09:00', 112),
  ];
  it("skips today's in-progress candle: the reference is the candle before it", () => {
    const r = previousCloseChange(121, '2026-10-20T09:30:00+09:00', kr);
    expect(r).toMatchObject({
      status: 'ok',
      previousClose: 110,
      previousCloseDate: '2026-10-19',
      basis: 'session-candle-excluded',
    });
    if (r.status === 'ok') {
      expect(r.change).toBeCloseTo(11);
      expect(r.rate).toBeCloseTo(0.1);
    }
  });
  it('uses the latest candle when the price belongs to a later session', () => {
    const r = previousCloseChange(99, '2026-10-21T09:05:00+09:00', kr);
    expect(r).toMatchObject({ status: 'ok', previousClose: 112, basis: 'latest-candle' });
    if (r.status === 'ok') expect(r.rate).toBeCloseTo(-13 / 112);
  });
  it('treats the 24h window of the candle start as the same session (boundaries)', () => {
    const edgeIn = previousCloseChange(120, '2026-10-20T23:59:59+09:00', kr);
    expect(edgeIn).toMatchObject({ status: 'ok', basis: 'session-candle-excluded' });
    const edgeOut = previousCloseChange(120, '2026-10-21T00:00:00+09:00', kr);
    expect(edgeOut).toMatchObject({ status: 'ok', basis: 'latest-candle' });
  });
  it('works across offsets: a US price stamped in KST', () => {
    const us = [candle('2026-10-19T00:00:00-04:00', 230), candle('2026-10-20T00:00:00-04:00', 232)];
    // 2026-10-21 05:00 KST = 2026-10-20 16:00 EDT: still the 10-20 session.
    const r = previousCloseChange(235, '2026-10-21T05:00:00+09:00', us);
    expect(r).toMatchObject({ status: 'ok', previousClose: 230 });
  });
  it('gives no number when the basis cannot be established', () => {
    expect(previousCloseChange(1, '2026-10-20T09:30:00+09:00', [])).toEqual({
      status: 'unavailable',
      reason: 'NO_CANDLES',
    });
    expect(previousCloseChange(1, null, kr)).toEqual({
      status: 'unavailable',
      reason: 'NO_PRICE_TIME',
    });
    expect(previousCloseChange(1, 'garbage', kr)).toEqual({
      status: 'unavailable',
      reason: 'NO_PRICE_TIME',
    });
    // Price older than the latest candle's day.
    expect(previousCloseChange(1, '2026-10-19T15:00:00+09:00', kr)).toEqual({
      status: 'unavailable',
      reason: 'STALE_PRICE',
    });
    // Same session but only one candle: nothing to compare with.
    expect(previousCloseChange(1, '2026-10-20T09:30:00+09:00', [kr[2]])).toEqual({
      status: 'unavailable',
      reason: 'NO_PREVIOUS_CLOSE',
    });
    expect(previousCloseChange(0, '2026-10-20T09:30:00+09:00', kr)).toEqual({
      status: 'unavailable',
      reason: 'INVALID_PRICE',
    });
  });
  it('reads the trading date from a local-midnight stamp and falls back to KST for others', () => {
    expect(candleDate('2026-10-19T00:00:00-04:00')).toBe('2026-10-19');
    expect(candleDate('2026-10-19T00:00:00+09:00')).toBe('2026-10-19');
    expect(candleDate('2026-10-19T00:00:00.000Z')).toBe('2026-10-19');
    expect(candleDate('2026-10-18T15:00:00Z')).toBe('2026-10-19'); // KST midnight written in UTC
  });
});

describe('limitProximity (근접 = within 2 % of the limit price)', () => {
  it('uses a 2 % threshold', () => expect(NEAR_LIMIT_RATE).toBe(0.02));
  it('flags near and reached upper limits', () => {
    expect(limitProximity(98, 100, 70)).toMatchObject({ level: 'upper-near' }); // exactly 2 %
    expect(limitProximity(97.9, 100, 70)).toMatchObject({ level: 'normal' });
    expect(limitProximity(100, 100, 70)).toMatchObject({ level: 'upper-reached' });
    expect(limitProximity(101, 100, 70)).toMatchObject({ level: 'upper-reached' });
  });
  it('flags near and reached lower limits', () => {
    expect(limitProximity(71.3, 100, 70)).toMatchObject({ level: 'lower-near' }); // 1.9 % above 70
    expect(limitProximity(71.5, 100, 70)).toMatchObject({ level: 'normal' });
    expect(limitProximity(70, 100, 70)).toMatchObject({ level: 'lower-reached' });
  });
  it('reports the distances as ratios of the limit price', () => {
    const r = limitProximity(95, 100, 80);
    expect(r).toMatchObject({ status: 'ok', level: 'normal' });
    if (r.status === 'ok') {
      expect(r.toUpper).toBeCloseTo(0.05);
      expect(r.toLower).toBeCloseTo(0.1875);
    }
  });
  it('does not judge without limits or with bad input', () => {
    expect(limitProximity(100, null, null)).toEqual({ status: 'not-provided' });
    expect(limitProximity(100, 0, -1)).toEqual({ status: 'not-provided' });
    expect(limitProximity(0, 100, 80)).toEqual({ status: 'not-provided' });
    expect(limitProximity(99, 100, null)).toMatchObject({ level: 'upper-near', toLower: null });
  });
});

describe('derived values and labels', () => {
  it('market cap is price x shares and never guesses', () => {
    expect(marketCapitalization(71234, 5969782550)).toBe(71234 * 5969782550);
    expect(marketCapitalization(0, 10)).toBeNull();
    expect(marketCapitalization(10, 0)).toBeNull();
    expect(marketCapitalization(NaN, 10)).toBeNull();
  });
  it('maps the Toss market segment, falling back to the currency', () => {
    expect(marketOf('KOSPI')).toBe('KR');
    expect(marketOf('KR_ETC')).toBe('KR');
    expect(marketOf('NASDAQ')).toBe('US');
    expect(marketOf('SOMETHING_NEW', 'KRW')).toBe('KR');
    expect(marketOf(undefined, 'USD')).toBe('US');
    expect(marketOf(undefined, undefined)).toBeNull();
  });
  it('keeps unknown warning codes visible', () => {
    expect(warningLabel('INVESTMENT_WARNING')).toBe('투자경고');
    expect(warningLabel('NEW_KIND')).toBe('유의사항(NEW_KIND)');
    expect(
      stockFlagLabels({
        status: 'ACTIVE',
        koreanMarketDetail: {
          liquidationTrading: true,
          krxTradingSuspended: true,
          nxtTradingSuspended: true,
        },
      }),
    ).toEqual(['KRX 거래정지', 'NXT 거래정지', '정리매매']);
    expect(stockFlagLabels({ status: 'DELISTED', koreanMarketDetail: null })).toEqual(['상장폐지']);
  });
});

describe('sector statistics', () => {
  const peer = (
    symbol: string,
    per: number | null,
    pbr: number | null,
    perReason: string | null = null,
    pbrReason: string | null = null,
  ) => ({
    symbol,
    name: symbol,
    per,
    pbr,
    perReason,
    pbrReason,
  });
  it('averages only the values that exist and reports count and exclusions by reason', () => {
    const result = compareSector([
      peer('A', 10, 1),
      peer('B', 20, 2),
      peer('C', 60, 3),
      peer('D', null, 4, 'NON_POSITIVE_EPS'),
      peer('E', null, null, 'FETCH_FAILED', 'FETCH_FAILED'),
    ]);
    expect(result.peers).toBe(5);
    expect(result.per).toEqual({ count: 3, excluded: 2, mean: 30, median: 20 });
    expect(result.pbr).toEqual({ count: 4, excluded: 1, mean: 2.5, median: 2.5 });
    expect(result.perExclusions).toEqual({ NON_POSITIVE_EPS: 1, FETCH_FAILED: 1 });
    expect(result.pbrExclusions).toEqual({ FETCH_FAILED: 1 });
  });
  it('has no mean or median when nothing is usable', () => {
    const result = compareSector([peer('A', null, null, 'NO_PRICE', 'NO_PRICE')]);
    expect(result.per).toEqual({ count: 0, excluded: 1, mean: null, median: null });
    expect(compareSector([]).per.count).toBe(0);
  });
});

describe('formatting', () => {
  it('formats prices, signed changes and large amounts', () => {
    expect(formatPrice(71234, 'KRW')).toBe('71,234원');
    expect(formatPrice('236', 'USD')).toBe('$236.00');
    expect(formatSignedPrice(-3286, 'KRW')).toBe('-3,286원');
    expect(formatSignedPrice(1.24, 'USD')).toBe('+$1.24');
    expect(formatSignedPercent(-0.0441)).toBe('-4.41%');
    expect(formatSignedPercent(0)).toBe('0.00%');
    expect(formatKrwLarge(425251490166700)).toBe('425조 2,514억 원');
    expect(formatKrwLarge(5e8)).toBe('5억 원');
    expect(formatUsdLarge(3.54e12)).toBe('$3.54T');
    expect(formatStatementAmount('300000000000', 'KRW')).toBe('3,000');
    expect(formatStatementAmount('2500000', 'USD')).toBe('2.5');
    expect(formatStatementAmount(null, 'KRW')).toBe('—');
  });
});

const days = (n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const close = 100 + (i % 10);
    const date = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    return {
      timestamp: `${date}T00:00:00+09:00`,
      date,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
    };
  });

describe('chart model', () => {
  it('cuts the window after computing indicators on the whole history', () => {
    const model = buildChartModel(days(300), new Set(['sma', 'rsi']), '1개월');
    expect(model.rows).toHaveLength(21);
    expect(model.rows[0].sma).not.toBeNull(); // warm-up was spent before the window
    expect(model.rows[0].rsi).not.toBeNull();
    expect(model.rows[0].ema).toBeNull(); // not selected: nothing computed
  });
  it('adds 26 future positions with the cloud only for Ichimoku', () => {
    const model = buildChartModel(days(200), new Set(['ichimoku']), '3개월');
    expect(model.futureRows).toBe(26);
    expect(model.rows).toHaveLength(63 + 26);
    const future = model.rows.slice(-26);
    expect(future.every((r) => r.future && r.close === null && r.tenkan === null)).toBe(true);
    expect(future.every((r) => r.senkouA !== null && r.senkouB !== null)).toBe(true);
    expect(future[0].label).toBe('+1봉');
    expect(future.at(-1)!.label).toBe('+26봉');
    expect(model.rows.some((r) => r.cloudUp || r.cloudDown)).toBe(true);
    expect(buildChartModel(days(200), new Set(['sma']), '3개월').futureRows).toBe(0);
  });
  it('shows what exists when the history is shorter than the window', () => {
    const model = buildChartModel(days(30), new Set(['sma']), '1년');
    expect(model.shownBars).toBe(30);
    expect(model.requestedBars).toBe(252);
    expect(model.rows.slice(0, 19).every((r) => r.sma === null)).toBe(true); // warm-up stays null
  });
  it('anchors the daily VWAP at the first displayed bar and fits Fibonacci to the window', () => {
    const model = buildChartModel(days(100), new Set(['vwap', 'fibonacci']), '1개월');
    expect(model.rows[0].vwap).toBeCloseTo(109); // typical price of the first displayed bar
    expect(model.fibonacci?.levels).toHaveLength(7);
    expect(model.fibonacci!.high).toBe(110);
  });
  it('pages: bars needed per window are capped at 5 pages', () => {
    expect(windowBars('3개월')).toBe(63);
    expect(targetBars('3개월')).toBe(63 + 120);
    expect(targetBars('3년')).toBe(876);
    expect(targetBars('3년')).toBeLessThanOrEqual(1000);
  });
});

describe('candle page parsing', () => {
  const row = {
    timestamp: '2026-10-20T00:00:00+09:00',
    open: '1',
    high: '2',
    low: '1',
    close: '2',
    volume: '5',
    currency: 'KRW',
  };
  const base = { source: 'Toss', asOf: '2026-10-20T00:00:00Z' };
  it('accepts an older empty page but rejects an empty first page', () => {
    expect(parseCandlePage({ ...base, candles: [] }).candles).toEqual([]);
    expect(() => parseCandles({ ...base, candles: [] })).toThrow(NoDataError);
  });
  it('keeps the cursor and rejects malformed values', () => {
    const page = parseCandlePage({
      ...base,
      candles: [row],
      nextBefore: '2026-10-19T00:00:00+09:00',
    });
    expect(page.nextBefore).toBe('2026-10-19T00:00:00+09:00');
    expect(page.candles[0]).toMatchObject({ date: '2026-10-20', close: 2, volume: 5 });
    expect(parseCandlePage({ ...base, candles: [row] }).nextBefore).toBeNull();
    for (const bad of [
      { ...row, close: '0' },
      { ...row, high: 'x' },
      { ...row, volume: '-1' },
      { ...row, timestamp: 'x' },
    ])
      expect(() => parseCandlePage({ ...base, candles: [bad] })).toThrow(ApiError);
    expect(() => parseCandlePage({ ...base, candles: [row], nextBefore: 5 })).toThrow(ApiError);
  });
});
