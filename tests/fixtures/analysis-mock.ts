/**
 * Synthetic responses for the 종목 분석 tab. Every company, number and sector here is invented
 * test data in the shape of the application API; none of it is a market fact.
 */
export type MockReply = { status: number; body: unknown };
const asOf = '2026-10-20T03:00:00Z';
const source = 'Toss Securities OpenAPI';

export const isKorean = (symbol: string) => /^[0-9A-Z]{6}$/.test(symbol) && /\d/.test(symbol);
const dateOf = (offsetDays: number) =>
  new Date(Date.UTC(2026, 9, 20) + offsetDays * 86400000).toISOString().slice(0, 10);

/** 600 synthetic daily candles ending on `lastDate`, served 200 per page like the real API. */
export function candlePage(symbol: string, before: string | null, count = 200) {
  const usd = !isKorean(symbol);
  const total = 600;
  const lastOffset = usd ? -1 : 0; // US: latest candle is the previous session; KR: today
  const offset = usd ? '-04:00' : '+09:00';
  const all = Array.from({ length: total }, (_, i) => {
    const day = i - (total - 1) + lastOffset; // days relative to 2026-10-20
    const base = usd ? 150 + i * 0.1 + (i % 9) : 50000 + i * 40 + (i % 9) * 150;
    const close = usd ? base : Math.round(base);
    const high = usd ? close + 2 : close + 400;
    const low = usd ? close - 2 : close - 400;
    const f = (n: number) => (usd ? n.toFixed(2) : String(n));
    return {
      timestamp: `${dateOf(day)}T00:00:00${offset}`,
      openPrice: f(close - (usd ? 0.5 : 100)),
      highPrice: f(high),
      lowPrice: f(low),
      closePrice: f(usd && i === total - 1 ? 234.76 : close),
      volume: String(100000 + (i % 13) * 5000),
      currency: usd ? 'USD' : 'KRW',
    };
  });
  let end = all.length;
  if (before) {
    const cut = Date.parse(before);
    end = all.filter((c) => Date.parse(c.timestamp) <= cut).length;
  }
  const slice = all.slice(Math.max(0, end - count), end);
  const hasOlder = end - count > 0;
  const nextBefore = hasOlder ? all[end - count - 1].timestamp : null;
  return {
    source: 'Test quote provider',
    asOf,
    symbol,
    interval: '1d',
    adjusted: true,
    candles: slice.map((c) => ({
      timestamp: c.timestamp,
      open: c.openPrice,
      high: c.highPrice,
      low: c.lowPrice,
      close: c.closePrice,
      volume: c.volume,
      currency: c.currency,
    })),
    ...(nextBefore ? { nextBefore } : {}),
  };
}

export const quotes: Record<
  string,
  { lastPrice: string; currency: string; timestamp: string | null }
> = {
  '005930': { lastPrice: '71234', currency: 'KRW', timestamp: '2026-10-20T09:30:00+09:00' },
  AAPL: { lastPrice: '236.00', currency: 'USD', timestamp: '2026-10-20T09:30:00-04:00' },
  '000660': { lastPrice: '131000', currency: 'KRW', timestamp: '2026-10-20T09:30:00+09:00' },
  // Peers of the synthetic sector: prices chosen so PER = price / 1,000 (EPS below) is 10..60.
  '100001': { lastPrice: '10000', currency: 'KRW', timestamp: '2026-10-20T09:30:00+09:00' },
  '100002': { lastPrice: '20000', currency: 'KRW', timestamp: '2026-10-20T09:30:00+09:00' },
  '100003': { lastPrice: '30000', currency: 'KRW', timestamp: '2026-10-20T09:30:00+09:00' },
  '100004': { lastPrice: '40000', currency: 'KRW', timestamp: '2026-10-20T09:30:00+09:00' },
  '100005': { lastPrice: '50000', currency: 'KRW', timestamp: '2026-10-20T09:30:00+09:00' },
  '100006': { lastPrice: '60000', currency: 'KRW', timestamp: '2026-10-20T09:30:00+09:00' },
};

const stockRows: Record<string, unknown> = {
  '005930': {
    symbol: '005930',
    name: '테스트전자',
    englishName: 'Test Electronics',
    market: 'KOSPI',
    securityType: 'STOCK',
    isCommonShare: true,
    status: 'ACTIVE',
    currency: 'KRW',
    sharesOutstanding: '5969782550',
    koreanMarketDetail: {
      liquidationTrading: false,
      nxtSupported: true,
      krxTradingSuspended: false,
      nxtTradingSuspended: false,
    },
  },
  AAPL: {
    symbol: 'AAPL',
    name: '테스트애플',
    englishName: 'Test Apple Inc.',
    market: 'NASDAQ',
    securityType: 'STOCK',
    isCommonShare: true,
    status: 'ACTIVE',
    currency: 'USD',
    sharesOutstanding: '15000000000',
    koreanMarketDetail: null,
  },
};

export const fundamentalsFor = (market: 'KR' | 'US', symbol: string) => {
  const kr = market === 'KR';
  const c = kr ? 'KRW' : 'USD';
  const unit = kr ? 1e8 : 1e6; // fixture amounts are written in 억 원 / 백만 달러
  const amount = (n: number) => String(n * unit);
  const statement = (
    periodType: 'annual' | 'quarter',
    fiscalYear: number,
    fiscalPeriod: string,
    periodEnd: string,
    filedAt: string,
    n: number,
    derived = false,
  ) => ({
    market,
    symbol,
    periodType,
    fiscalYear,
    fiscalPeriod,
    periodEnd,
    periodEndAssumed: false,
    filedAt,
    currency: c,
    scope: kr ? 'consolidated' : null,
    derived,
    revenue: amount(1000 * n),
    operatingIncome: amount(100 * n),
    netIncome: amount(80 * n),
    totalAssets: amount(5000 * n),
    totalLiabilities: amount(2000 * n),
    totalEquity: amount(3000 * n),
    sharesOutstanding: '1000',
    source: kr ? 'DART' : 'SEC EDGAR',
    sourceUrl: kr
      ? `https://dart.example.test/viewer?rcpNo=2026${fiscalYear}${n}`
      : 'https://data.sec.example.test/companyfacts/CIK0000000001.json',
  });
  const peerNumber = Number(symbol.slice(-1));
  const eps = symbol === '100003' ? -500 : symbol.startsWith('1000') ? 1000 : kr ? 4000 : 4;
  return {
    market,
    symbol,
    name: kr ? '테스트전자' : 'Test Apple Inc.',
    source: kr ? 'DART' : 'SEC EDGAR',
    asOf,
    statements: [
      statement('annual', 2025, 'FY', '2025-12-31', '2026-03-10', 30),
      statement('annual', 2024, 'FY', '2024-12-31', '2025-03-11', 26),
      statement('annual', 2023, 'FY', '2023-12-31', '2024-03-12', 22),
      statement('quarter', 2026, 'Q2', '2026-06-30', '2026-08-14', 8),
      statement('quarter', 2026, 'Q1', '2026-03-31', '2026-05-15', 7),
      statement('quarter', 2025, 'Q4', '2025-12-31', '2026-03-10', 9, true),
    ],
    warnings: [],
    perShare: {
      asOf: '2026-08-14',
      currency: c,
      ttm: {
        netIncome: 4e12,
        periodEnd: '2026-06-30',
        fiscalYear: 2026,
        fiscalPeriod: 'Q2',
        basis: 'four-quarters',
      },
      shares: { value: 1000, periodEnd: '2026-06-30' },
      equity: { value: 5e13, periodEnd: '2026-06-30' },
      eps: { value: eps, reason: null, asOf: '2026-08-14' },
      bps: {
        value: symbol.startsWith('1000') ? 5000 + peerNumber * 1000 : kr ? 50000 : 50,
        reason: null,
        asOf: '2026-08-14',
      },
      roe: { value: 0.0912, reason: null, asOf: '2026-08-14' },
    },
    notice: '공시 기준 재무제표와 파생 지표입니다.',
  };
};

const investor = Array.from({ length: 5 }, (_, i) => ({
  date: dateOf(-i),
  updatedAt: '2026-10-20T08:00:00+09:00',
  individual:
    i === 0 ? null : { buyVolume: '900000', sellVolume: '1000000', netBuyVolume: '-100000' },
  foreigner: { buyVolume: '1200000', sellVolume: '800000', netBuyVolume: '400000' },
  institution: { buyVolume: '500000', sellVolume: '800000', netBuyVolume: '-300000' },
  otherCorporation: i === 0 ? null : { buyVolume: '10000', sellVolume: '10000', netBuyVolume: '0' },
  foreignerHolding:
    i === 0
      ? null
      : { holdingQuantity: '3000000000', limitQuantity: '5969782550', holdingRate: '0.5089' },
}));

export const peerList = [1, 2, 3, 4, 5, 6].map((n) => ({
  symbol: `10000${n}`,
  name: `테스트동종${n}`,
  marketCapitalization: String((7 - n) * 1e12),
  currency: 'KRW',
}));

/** Reply for an analysis/fundamentals path, or null when the path is not one of them. */
export function analysisReply(path: string, params: URLSearchParams): MockReply | null {
  const symbol = (params.get('symbol') ?? '').toUpperCase();
  const ok = (body: unknown): MockReply => ({ status: 200, body });
  if (path === '/api/analysis/stocks') {
    const wanted = (params.get('symbols') ?? '').toUpperCase().split(',');
    return ok({
      source,
      asOf,
      stocks: wanted.flatMap((s) => (stockRows[s] ? [stockRows[s]] : [])),
    });
  }
  if (path === '/api/analysis/warnings')
    return ok({
      source,
      asOf,
      symbol,
      warnings:
        symbol === '005930'
          ? [
              {
                warningType: 'INVESTMENT_WARNING',
                exchange: 'KRX',
                startDate: '2026-10-15',
                endDate: null,
              },
            ]
          : [],
    });
  if (path === '/api/analysis/price-limits')
    return ok({
      source,
      asOf,
      symbol,
      timestamp: '2026-10-20T09:30:00+09:00',
      // 5 % under the limit for 005930 would not be near; 71,234 is 1.0 % below 71,950.
      upperLimitPrice: symbol === '005930' ? '71950' : null,
      lowerLimitPrice: symbol === '005930' ? '38700' : null,
      currency: isKorean(symbol) ? 'KRW' : 'USD',
    });
  if (path === '/api/fundamentals') {
    const market = params.get('market') as 'KR' | 'US';
    const s = (params.get('symbol') ?? '').toUpperCase();
    if (s === '100004')
      return {
        status: 404,
        body: {
          error: {
            code: 'FUNDAMENTALS_NOT_FOUND',
            message: '이 종목의 재무 데이터를 찾지 못했습니다.',
          },
        },
      };
    return ok(fundamentalsFor(market, s));
  }
  if (path === '/api/analysis/sector-peers')
    return ok({
      source,
      asOf,
      symbol,
      market: params.get('market'),
      sector: {
        sectorId: '1203',
        name: '테스트 반도체',
        depth: 2,
        path: ['테스트 기술', '테스트 반도체'],
      },
      alsoIn: [],
      memberCount: 7,
      peers: peerList,
      peerCap: 20,
      peersTruncated: false,
      lookups: 4,
      lookupLimit: 60,
      lookupLimitReached: false,
    });
  if (path === '/api/analysis/investor-trading')
    return ok({ source, asOf, symbol, records: investor });
  if (path === '/api/analysis/program-trades')
    return ok({
      source,
      asOf,
      symbol,
      records: investor.slice(0, 3).map((r) => ({
        date: r.date,
        arbitrage: { buyVolume: '1000', sellVolume: '400', netBuyVolume: '600' },
        nonArbitrage: { buyVolume: '2000', sellVolume: '2600', netBuyVolume: '-600' },
      })),
    });
  if (path === '/api/analysis/short-selling')
    return ok({
      source,
      asOf,
      symbol,
      records: investor.slice(0, 3).map((r, i) => ({
        date: r.date,
        updatedAt: r.updatedAt,
        shortSellingVolume: '123456',
        shortSellingAmount: '8800000000',
        shortSellingVolumeRate: i === 0 ? null : '0.03215',
        shortSellingAmountRate: i === 0 ? null : '0.0318',
      })),
    });
  if (path === '/api/analysis/credit-trades')
    return ok({
      source,
      asOf,
      symbol,
      records: investor.slice(0, 3).map((r, i) => ({
        date: r.date,
        updatedAt: r.updatedAt,
        marginLoan: {
          newQuantity: '1000',
          returnQuantity: '900',
          balanceQuantity: '500000',
          balanceRate: '0.0042',
          tradingRate: '0.09',
        },
        stockLoan:
          i === 1
            ? null
            : {
                newQuantity: '10',
                returnQuantity: '5',
                balanceQuantity: '7000',
                balanceRate: '0.0001',
                tradingRate: '0.001',
              },
      })),
    });
  if (path === '/api/analysis/orderbook')
    return ok({
      source,
      asOf,
      symbol,
      timestamp: '2026-10-20T11:59:58+09:00',
      currency: isKorean(symbol) ? 'KRW' : 'USD',
      asks: [
        { price: '71300', volume: '1200' },
        { price: '71400', volume: '800' },
      ],
      bids: [
        { price: '71200', volume: '1500' },
        { price: '71100', volume: '900' },
      ],
    });
  if (path === '/api/analysis/trades')
    return ok({
      source,
      asOf,
      symbol,
      trades: [
        { price: '71250', volume: '30', timestamp: '2026-10-20T11:59:57+09:00', currency: 'KRW' },
        { price: '71200', volume: '12', timestamp: '2026-10-20T11:59:55+09:00', currency: 'KRW' },
      ],
    });
  return null;
}
