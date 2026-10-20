import { describe, expect, it, vi } from 'vitest';
import {
  MemoryTokenCache,
  TossClient,
  collectCandlePages,
  type DailyCandle,
} from '../src/server/toss';
import {
  candleBar,
  config,
  creditRecord,
  datesBackFrom,
  flow,
  investorRecord,
  krDay,
  krRegular,
  ok,
  programRecord,
  providerError,
  shortRecord,
  tokenResponse,
  usDay,
} from './fixtures/toss-snapshot';

function clientWith(handler: (url: URL) => Response) {
  const transport = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/oauth2/token') return tokenResponse();
    return handler(url);
  }) as unknown as typeof fetch;
  return { client: new TossClient(config, new MemoryTokenCache(), transport), transport };
}
const dataCalls = (transport: typeof fetch) =>
  vi
    .mocked(transport)
    .mock.calls.map((call) => new URL(String(call[0])))
    .filter((url) => url.pathname !== '/oauth2/token');

describe('market calendar adapter (official v1.2.24, checked 2026-10-21)', () => {
  it('reads the KR integrated regular session and treats a holiday as a null session', async () => {
    const { client, transport } = clientWith(() =>
      ok({
        previousBusinessDay: krDay('2026-10-20', krRegular('2026-10-20')),
        today: krDay('2026-10-21', krRegular('2026-10-21')),
        nextBusinessDay: krDay('2026-10-22', null),
      }),
    );
    const calendar = await client.marketCalendar('KR', '2026-10-21');
    expect(dataCalls(transport)[0].pathname).toBe('/api/v1/market-calendar/KR');
    expect(dataCalls(transport)[0].searchParams.get('date')).toBe('2026-10-21');
    expect(calendar.today.regularMarket).toEqual({
      startTime: '2026-10-21T09:00:00+09:00',
      endTime: '2026-10-21T15:30:00+09:00',
    });
    expect(calendar.nextBusinessDay.regularMarket).toBeNull();
    expect(calendar.market).toBe('KR');
  });
  it('reads the US regular session in KST including daylight saving shifts', async () => {
    const summer: [string, string] = ['2026-10-20T22:30:00+09:00', '2026-10-21T05:00:00+09:00'];
    const winter: [string, string] = ['2026-12-01T23:30:00+09:00', '2026-12-02T06:00:00+09:00'];
    const summerClient = clientWith(() =>
      ok({
        previousBusinessDay: usDay('2026-10-19', null),
        today: usDay('2026-10-20', summer),
        nextBusinessDay: usDay('2026-10-21', null),
      }),
    );
    const winterClient = clientWith(() =>
      ok({
        previousBusinessDay: usDay('2026-11-30', null),
        today: usDay('2026-12-01', winter),
        nextBusinessDay: usDay('2026-12-02', null),
      }),
    );
    expect(
      (await summerClient.client.marketCalendar('US', '2026-10-20')).today.regularMarket,
    ).toEqual({ startTime: summer[0], endTime: summer[1] });
    expect(
      (await winterClient.client.marketCalendar('US', '2026-12-01')).today.regularMarket,
    ).toEqual({ startTime: winter[0], endTime: winter[1] });
    expect(dataCalls(summerClient.transport)[0].pathname).toBe('/api/v1/market-calendar/US');
  });
  it('rejects bad input before calling and malformed responses as schema errors', async () => {
    const { client, transport } = clientWith(() => ok({}));
    await expect(client.marketCalendar('JP' as 'KR', '2026-10-21')).rejects.toMatchObject({
      status: 400,
    });
    await expect(client.marketCalendar('KR', '10/21/2026')).rejects.toMatchObject({ status: 400 });
    expect(transport).not.toHaveBeenCalled();
    await expect(client.marketCalendar('KR', '2026-10-21')).rejects.toMatchObject({
      code: 'PROVIDER_SCHEMA_INVALID',
    });
    const inverted = clientWith(() =>
      ok({
        previousBusinessDay: krDay('2026-10-20', null),
        today: krDay('2026-10-21', ['2026-10-21T15:30:00+09:00', '2026-10-21T09:00:00+09:00']),
        nextBusinessDay: krDay('2026-10-22', null),
      }),
    );
    await expect(inverted.client.marketCalendar('KR', '2026-10-21')).rejects.toMatchObject({
      code: 'PROVIDER_SCHEMA_INVALID',
    });
  });
});

describe('KR supply and demand adapters', () => {
  it('normalizes provisional and final investor-trading records and drops undocumented fields', async () => {
    const { client, transport } = clientWith(() =>
      ok({
        records: [
          { ...investorRecord('2026-10-21', false), accountNo: 'must-never-leak' },
          investorRecord('2026-10-20', true),
        ],
        nextUntil: '2026-10-19',
      }),
    );
    const result = await client.investorTrading('005930', { count: 2, until: '2026-10-21' });
    const call = dataCalls(transport)[0];
    expect(call.pathname).toBe('/api/v1/stocks/005930/investor-trading');
    expect(call.searchParams.get('count')).toBe('2');
    expect(call.searchParams.get('until')).toBe('2026-10-21');
    expect(result.nextUntil).toBe('2026-10-19');
    // Provisional same-day record: individual, breakdown and holding are null, not invented.
    expect(result.records[0]).toMatchObject({
      date: '2026-10-21',
      individual: null,
      otherCorporation: null,
      foreignerHolding: null,
      institution: { breakdown: null, netBuyVolume: '100' },
    });
    expect(result.records[1].institution.breakdown?.pensionFund).toEqual(flow(100, 50));
    expect(result.records[1].foreignerHolding?.holdingRate).toBe('0.5089');
    expect(JSON.stringify(result)).not.toContain('must-never-leak');
  });
  it('normalizes program, short-selling (nullable rates) and credit (nullable sides) series', async () => {
    const { client } = clientWith((url) =>
      ok({
        records: url.pathname.endsWith('program-trades')
          ? [programRecord('2026-10-21')]
          : url.pathname.endsWith('short-selling')
            ? [shortRecord('2026-10-21')]
            : [creditRecord('2026-10-21')],
        nextUntil: null,
      }),
    );
    expect((await client.programTrades('005930')).records[0].nonArbitrage.netBuyVolume).toBe('-10');
    const short = (await client.shortSelling('005930')).records[0];
    expect(short.shortSellingVolumeRate).toBe('0.01234');
    expect(short.shortSellingAmountRate).toBeNull();
    const credit = (await client.creditTrades('005930')).records[0];
    expect(credit.marginLoan?.balanceRate).toBe('0.0042');
    expect(credit.stockLoan).toBeNull();
  });
  it('maps 403 on Stock Info endpoints to PROVIDER_FORBIDDEN, distinct from access denied', async () => {
    const { client } = clientWith(() => providerError(403, 'forbidden'));
    for (const call of [
      () => client.investorTrading('005930'),
      () => client.programTrades('005930'),
      () => client.shortSelling('005930'),
      () => client.creditTrades('005930'),
    ])
      await expect(call()).rejects.toMatchObject({ code: 'PROVIDER_FORBIDDEN' });
    // Non-Stock-Info endpoints keep the credential/IP meaning, and the raw body is never exposed.
    const other = clientWith(() => providerError(403, 'forbidden'));
    const failure = await other.client.dailyCandlePage('005930').catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'PROVIDER_ACCESS_DENIED' });
    expect(JSON.stringify(failure)).not.toContain('raw provider text');
    expect(String((failure as Error).message)).not.toContain('raw provider text');
  });
  it('keeps 401 as access denied even on Stock Info endpoints', async () => {
    const { client } = clientWith(() => providerError(401, 'unauthorized'));
    await expect(client.investorTrading('005930')).rejects.toMatchObject({
      code: 'PROVIDER_ACCESS_DENIED',
    });
  });
  it('validates KR-only symbols, count and date before any request', async () => {
    const { client, transport } = clientWith(() => ok({ records: [] }));
    await expect(client.investorTrading('AAPL')).rejects.toMatchObject({ status: 400 });
    await expect(client.investorTrading('../../x')).rejects.toMatchObject({ status: 400 });
    await expect(client.investorTrading('005930', { count: 101 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(client.shortSelling('005930', { until: '2026-1-1' })).rejects.toMatchObject({
      status: 400,
    });
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects non-decimal numbers, bad dates and oversized record lists', async () => {
    const bad = clientWith(() =>
      ok({ records: [{ ...programRecord('2026-10-21'), arbitrage: flow(1, 1) }, { date: 'x' }] }),
    );
    await expect(bad.client.programTrades('005930')).rejects.toMatchObject({
      code: 'PROVIDER_SCHEMA_INVALID',
    });
    const nan = clientWith(() =>
      ok({
        records: [{ ...shortRecord('2026-10-21'), shortSellingVolume: 'NaN' }],
      }),
    );
    await expect(nan.client.shortSelling('005930')).rejects.toMatchObject({
      code: 'PROVIDER_SCHEMA_INVALID',
    });
    const huge = clientWith(() =>
      ok({ records: Array.from({ length: 101 }, () => programRecord('2026-10-21')) }),
    );
    await expect(huge.client.programTrades('005930')).rejects.toMatchObject({
      code: 'PROVIDER_SCHEMA_INVALID',
    });
  });
});

describe('daily candle paging', () => {
  it('requests adjusted daily bars, encodes before and keeps provider currency', async () => {
    const { client, transport } = clientWith(() =>
      ok({ candles: [candleBar('2026-10-21', 'KRW')], nextBefore: '2026-10-20T00:00:00+09:00' }),
    );
    const page = await client.dailyCandlePage('005930', {
      count: 5,
      before: '2026-10-21T00:00:00+09:00',
    });
    const call = dataCalls(transport)[0];
    expect(call.searchParams.get('interval')).toBe('1d');
    expect(call.searchParams.get('adjusted')).toBe('true');
    expect(call.searchParams.get('before')).toBe('2026-10-21T00:00:00+09:00');
    expect(String(vi.mocked(transport).mock.calls.at(-1)![0])).toContain('%2B09%3A00');
    expect(page.candles[0]).toMatchObject({ date: '2026-10-21', currency: 'KRW', close: '105' });
    expect(page.nextBefore).toBe('2026-10-20T00:00:00+09:00');
  });
  it('rejects unknown currency and invalid inputs', async () => {
    const bad = clientWith(() =>
      ok({ candles: [{ ...candleBar('2026-10-21'), currency: 'EUR' }], nextBefore: null }),
    );
    await expect(bad.client.dailyCandlePage('005930')).rejects.toMatchObject({
      code: 'PROVIDER_SCHEMA_INVALID',
    });
    await expect(bad.client.dailyCandlePage('../x')).rejects.toMatchObject({ status: 400 });
    await expect(bad.client.dailyCandlePage('005930', { count: 201 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      bad.client.dailyCandlePage('005930', { before: 'not-a-date' }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('pages until the provider reports no more data', async () => {
    const days = datesBackFrom('2026-10-21', 5);
    const { client, transport } = clientWith((url) => {
      const before = url.searchParams.get('before');
      const start = before ? days.findIndex((d) => `${d}T00:00:00+09:00` === before) : 0;
      const page = days.slice(start, start + 2);
      const rest = days[start + 2];
      return ok({
        candles: page.map((d) => candleBar(d, 'KRW')),
        nextBefore: rest ? `${rest}T00:00:00+09:00` : null,
      });
    });
    const result = await client.dailyCandles('005930', { pageSize: 2, maxPages: 10 });
    expect(result.stopReason).toBe('EXHAUSTED');
    expect(result.complete).toBe(true);
    expect(result.pages).toBe(3);
    expect(result.candles.map((c) => c.date)).toEqual(days);
    expect(dataCalls(transport)).toHaveLength(3);
  });
  it('stops at max pages and says the result is incomplete', async () => {
    let page = 0;
    const { client, transport } = clientWith(() => {
      page++;
      const d = datesBackFrom('2026-10-21', 100)[page * 2];
      return ok({
        candles: [candleBar(datesBackFrom('2026-10-21', 100)[page * 2 - 1], 'KRW')],
        nextBefore: `${d}T00:00:00+09:00`,
      });
    });
    const result = await client.dailyCandles('005930', { maxPages: 3, pageSize: 1 });
    expect(result.stopReason).toBe('MAX_PAGES');
    expect(result.complete).toBe(false);
    expect(dataCalls(transport)).toHaveLength(3);
  });
});

describe('collectCandlePages stop conditions', () => {
  const bar = (date: string): DailyCandle => ({
    timestamp: `${date}T00:00:00+09:00`,
    date,
    open: '1',
    high: '2',
    low: '1',
    close: '2',
    volume: '3',
  });
  it('stops when the cursor does not advance (duplicate page)', async () => {
    const fetchPage = vi.fn(async () => ({
      candles: [bar('2026-10-21')],
      nextBefore: '2026-10-20T00:00:00+09:00',
    }));
    const result = await collectCandlePages(fetchPage, { maxPages: 10 });
    expect(result.stopReason).toBe('CURSOR_STALLED');
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
  it('stops when nextBefore is not older than the cursor just used', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        candles: [bar('2026-10-21')],
        nextBefore: '2026-10-20T00:00:00+09:00',
      })
      .mockResolvedValueOnce({
        candles: [bar('2026-10-20')],
        nextBefore: '2026-10-21T00:00:00+09:00',
      });
    expect((await collectCandlePages(fetchPage, { maxPages: 10 })).stopReason).toBe(
      'CURSOR_STALLED',
    );
  });
  it('stops on an empty page that still names a cursor, and on the requested start date', async () => {
    const empty = vi.fn(async () => ({ candles: [], nextBefore: '2026-10-20T00:00:00+09:00' }));
    expect((await collectCandlePages(empty)).stopReason).toBe('EMPTY_PAGE');
    const dated = vi.fn(async () => ({
      candles: [bar('2026-10-21'), bar('2026-10-20'), bar('2026-10-19')],
      nextBefore: '2026-10-18T00:00:00+09:00',
    }));
    const reached = await collectCandlePages(dated, { stopAtDate: '2026-10-20' });
    expect(reached.stopReason).toBe('REACHED_DATE');
    expect(reached.complete).toBe(true);
  });
  it('caps pages at the framework maximum even when asked for more', async () => {
    let n = 0;
    const fetchPage = vi.fn(async () => {
      n++;
      const day = datesBackFrom('2026-12-31', 400)[n];
      return {
        candles: [bar(day)],
        nextBefore: `${datesBackFrom('2026-12-31', 400)[n + 1]}T00:00:00+09:00`,
      };
    });
    const result = await collectCandlePages(fetchPage, { maxPages: 1000 });
    expect(result.stopReason).toBe('MAX_PAGES');
    expect(fetchPage).toHaveBeenCalledTimes(20);
  });
});

describe('market indicator candles', () => {
  it('reads daily bars for catalog symbols only and returns no currency field', async () => {
    const { client, transport } = clientWith(() =>
      ok({ candles: [candleBar('2026-10-21')], nextBefore: null }),
    );
    const page = await client.marketIndicatorCandlePage('KOSPI', { count: 5 });
    const call = dataCalls(transport)[0];
    expect(call.pathname).toBe('/api/v1/market-indicators/KOSPI/candles');
    expect(call.searchParams.get('interval')).toBe('1d');
    expect(page.candles[0]).toMatchObject({ date: '2026-10-21', close: '105' });
    expect(page.candles[0]).not.toHaveProperty('currency');
    await expect(client.marketIndicatorCandlePage('SPX')).rejects.toMatchObject({ status: 400 });
    await expect(
      client.marketIndicatorCandlePage('KR_BOND_10Y', { count: 0 }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('pages indicator history with the same stop conditions', async () => {
    const { client } = clientWith(() =>
      ok({ candles: [candleBar('2026-10-21')], nextBefore: '2026-10-20T00:00:00+09:00' }),
    );
    const result = await client.marketIndicatorDailyCandles('KOSDAQ', { maxPages: 5 });
    expect(result.stopReason).toBe('CURSOR_STALLED');
  });
});
