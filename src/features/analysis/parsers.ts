// Response validators for the 종목 분석 tab. They mirror the server contracts in
// src/server/toss-analysis.ts and src/server/fundamentals/router.ts; anything shaped differently
// becomes a visible error instead of a guessed value.
import { ApiError, NoDataError } from '../../lib/api';
import type { ChartEvent, EventKind, EventOrigin } from '../../lib/chartEvents';
import type { DatedValue, FillInput } from '../../lib/compare';
import type { FinancialStatement, PerShareMetrics } from '../../lib/valuation';

const bad = (text = '응답 형식을 확인하지 못했습니다.') =>
  new ApiError(502, 'INVALID_RESPONSE', text);
const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad();
  return value as Record<string, unknown>;
};
const str = (value: unknown) => {
  if (typeof value !== 'string') throw bad();
  return value;
};
const dec = (value: unknown) => {
  if (typeof value !== 'string' || !Number.isFinite(Number(value))) throw bad();
  return value;
};
const decOrNull = (value: unknown) => (value === null || value === undefined ? null : dec(value));
const strOrNull = (value: unknown) => (value === null || value === undefined ? null : str(value));
const arr = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw bad();
  return value;
};
const when = (value: unknown) => {
  const result = str(value);
  if (!Number.isFinite(Date.parse(result))) throw bad();
  return result;
};
const header = (body: unknown) => {
  const d = obj(body);
  return { d, source: str(d.source), asOf: when(d.asOf) };
};
const cur = (value: unknown): 'KRW' | 'USD' => {
  if (value !== 'KRW' && value !== 'USD') throw bad();
  return value;
};

export type StockInfo = {
  symbol: string;
  name: string;
  englishName: string;
  market: string;
  securityType: string;
  isCommonShare: boolean;
  status: string;
  currency: 'KRW' | 'USD';
  sharesOutstanding: string;
  koreanMarketDetail: {
    liquidationTrading: boolean;
    krxTradingSuspended: boolean;
    nxtTradingSuspended: boolean | null;
  } | null;
};
export type StockLookup = { source: string; asOf: string; stock: StockInfo };
export function parseStockLookup(symbol: string) {
  return (body: unknown): StockLookup => {
    const { d, source, asOf } = header(body);
    const rows = arr(d.stocks).map((raw) => {
      const s = obj(raw);
      const detail = s.koreanMarketDetail;
      const k = detail === null || detail === undefined ? null : obj(detail);
      return {
        symbol: str(s.symbol),
        name: str(s.name),
        englishName: str(s.englishName),
        market: str(s.market),
        securityType: str(s.securityType),
        isCommonShare: s.isCommonShare === true,
        status: str(s.status),
        currency: cur(s.currency),
        sharesOutstanding: dec(s.sharesOutstanding),
        koreanMarketDetail: k && {
          liquidationTrading: k.liquidationTrading === true,
          krxTradingSuspended: k.krxTradingSuspended === true,
          nxtTradingSuspended:
            typeof k.nxtTradingSuspended === 'boolean' ? k.nxtTradingSuspended : null,
        },
      } satisfies StockInfo;
    });
    const stock = rows.find((row) => row.symbol.toUpperCase() === symbol.toUpperCase());
    if (!stock)
      throw new NoDataError('토스에서 이 종목 코드를 찾지 못했습니다. 코드를 확인하세요.');
    return { source, asOf, stock };
  };
}

export type PriceQuote = {
  source: string;
  asOf: string;
  symbol: string;
  lastPrice: number;
  currency: 'KRW' | 'USD';
  timestamp: string | null;
};
export function parsePriceQuote(symbol: string) {
  return (body: unknown): PriceQuote => {
    const { d, source, asOf } = header(body);
    const row = arr(d.prices)
      .map(obj)
      .find((p) => typeof p.symbol === 'string' && p.symbol.toUpperCase() === symbol.toUpperCase());
    if (!row) throw new NoDataError('토스가 이 종목의 현재가를 돌려주지 않았습니다.');
    const price = Number(dec(row.lastPrice));
    if (!(price > 0)) throw bad();
    return {
      source,
      asOf,
      symbol: str(row.symbol),
      lastPrice: price,
      currency: cur(row.currency),
      timestamp: row.timestamp === null || row.timestamp === undefined ? null : when(row.timestamp),
    };
  };
}

export type Warnings = {
  asOf: string;
  warnings: {
    warningType: string;
    exchange: string | null;
    startDate: string | null;
    endDate: string | null;
  }[];
};
export function parseWarnings(body: unknown): Warnings {
  const { d, asOf } = header(body);
  return {
    asOf,
    warnings: arr(d.warnings).map((raw) => {
      const w = obj(raw);
      return {
        warningType: str(w.warningType),
        exchange: strOrNull(w.exchange),
        startDate: strOrNull(w.startDate),
        endDate: strOrNull(w.endDate),
      };
    }),
  };
}

export type PriceLimits = {
  asOf: string;
  timestamp: string;
  upperLimitPrice: number | null;
  lowerLimitPrice: number | null;
  currency: 'KRW' | 'USD';
};
export function parsePriceLimits(body: unknown): PriceLimits {
  const { d, asOf } = header(body);
  const upper = decOrNull(d.upperLimitPrice);
  const lower = decOrNull(d.lowerLimitPrice);
  return {
    asOf,
    timestamp: when(d.timestamp),
    upperLimitPrice: upper === null ? null : Number(upper),
    lowerLimitPrice: lower === null ? null : Number(lower),
    currency: cur(d.currency),
  };
}

export type Fundamentals = {
  market: 'KR' | 'US';
  symbol: string;
  name: string | null;
  source: string;
  asOf: string;
  statements: FinancialStatement[];
  warnings: string[];
  perShare: PerShareMetrics;
  notice: string;
};
const metric = (value: unknown) => {
  const m = obj(value);
  if (m.value !== null && (typeof m.value !== 'number' || !Number.isFinite(m.value))) throw bad();
  return { value: m.value as number | null, reason: strOrNull(m.reason), asOf: strOrNull(m.asOf) };
};
export function parseFundamentals(body: unknown): Fundamentals {
  const d = obj(body);
  if ((d.market !== 'KR' && d.market !== 'US') || typeof d.symbol !== 'string') throw bad();
  const statements = arr(d.statements).map((raw) => {
    const s = obj(raw);
    if (
      (s.periodType !== 'annual' && s.periodType !== 'quarter') ||
      typeof s.fiscalYear !== 'number' ||
      !['FY', 'Q1', 'Q2', 'Q3', 'Q4'].includes(String(s.fiscalPeriod)) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(str(s.filedAt)) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(str(s.periodEnd)) ||
      typeof s.currency !== 'string'
    )
      throw bad();
    for (const key of [
      'revenue',
      'operatingIncome',
      'netIncome',
      'totalAssets',
      'totalLiabilities',
      'totalEquity',
      'sharesOutstanding',
    ])
      decOrNull(s[key]);
    return s as unknown as FinancialStatement;
  });
  const p = obj(d.perShare);
  const perShare = {
    asOf: strOrNull(p.asOf),
    currency: strOrNull(p.currency),
    ttm: p.ttm === null ? null : (obj(p.ttm) as unknown as PerShareMetrics['ttm']),
    shares: p.shares === null ? null : (obj(p.shares) as unknown as PerShareMetrics['shares']),
    equity: p.equity === null ? null : (obj(p.equity) as unknown as PerShareMetrics['equity']),
    eps: metric(p.eps),
    bps: metric(p.bps),
    roe: metric(p.roe),
  } as PerShareMetrics;
  return {
    market: d.market,
    symbol: d.symbol,
    name: strOrNull(d.name),
    source: str(d.source),
    asOf: when(d.asOf),
    statements,
    warnings: arr(d.warnings).map(str),
    perShare,
    notice: str(d.notice),
  };
}

export type SectorPeers = {
  asOf: string;
  sector: { sectorId: string; name: string; depth: number; path: string[] } | null;
  alsoIn: { sectorId: string; name: string }[];
  memberCount: number;
  peers: { symbol: string; name: string; marketCapitalization: string | null; currency: string }[];
  peerCap: number;
  peersTruncated: boolean;
  lookups: number;
  lookupLimit: number;
  lookupLimitReached: boolean;
};
export function parseSectorPeers(body: unknown): SectorPeers {
  const { d, asOf } = header(body);
  const sector = d.sector === null ? null : obj(d.sector);
  return {
    asOf,
    sector: sector && {
      sectorId: str(sector.sectorId),
      name: str(sector.name),
      depth: Number(sector.depth),
      path: arr(sector.path).map(str),
    },
    alsoIn: arr(d.alsoIn).map((raw) => {
      const a = obj(raw);
      return { sectorId: str(a.sectorId), name: str(a.name) };
    }),
    memberCount: Number(d.memberCount),
    peers: arr(d.peers).map((raw) => {
      const p = obj(raw);
      return {
        symbol: str(p.symbol),
        name: str(p.name),
        marketCapitalization: decOrNull(p.marketCapitalization),
        currency: str(p.currency),
      };
    }),
    peerCap: Number(d.peerCap),
    peersTruncated: d.peersTruncated === true,
    lookups: Number(d.lookups),
    lookupLimit: Number(d.lookupLimit),
    lookupLimitReached: d.lookupLimitReached === true,
  };
}

type Volume = { buyVolume: string; sellVolume: string; netBuyVolume: string };
const volume = (value: unknown): Volume => {
  const v = obj(value);
  return {
    buyVolume: dec(v.buyVolume),
    sellVolume: dec(v.sellVolume),
    netBuyVolume: dec(v.netBuyVolume),
  };
};
const volumeOrNull = (value: unknown) =>
  value === null || value === undefined ? null : volume(value);
const records = (body: unknown) => {
  const { d, asOf } = header(body);
  return { asOf, rows: arr(d.records).map(obj) };
};
const emptyCheck = <T extends { rows: unknown[] }>(value: T): T => {
  if (!value.rows.length)
    throw new NoDataError('토스가 이 종목의 해당 기간 기록을 돌려주지 않았습니다.');
  return value;
};

export type InvestorRow = {
  date: string;
  updatedAt: string;
  individual: Volume | null;
  foreigner: Volume;
  institution: Volume;
  otherCorporation: Volume | null;
  foreignerHoldingRate: string | null;
};
export function parseInvestorTrading(body: unknown) {
  const { asOf, rows } = records(body);
  return emptyCheck({
    asOf,
    rows: rows.map((r): InvestorRow => ({
      date: str(r.date),
      updatedAt: when(r.updatedAt),
      individual: volumeOrNull(r.individual),
      foreigner: volume(r.foreigner),
      institution: volume(r.institution),
      otherCorporation: volumeOrNull(r.otherCorporation),
      foreignerHoldingRate:
        r.foreignerHolding === null || r.foreignerHolding === undefined
          ? null
          : dec(obj(r.foreignerHolding).holdingRate),
    })),
  });
}
export type ProgramRow = { date: string; arbitrage: Volume; nonArbitrage: Volume };
export function parseProgramTrades(body: unknown) {
  const { asOf, rows } = records(body);
  return emptyCheck({
    asOf,
    rows: rows.map((r): ProgramRow => ({
      date: str(r.date),
      arbitrage: volume(r.arbitrage),
      nonArbitrage: volume(r.nonArbitrage),
    })),
  });
}
export type ShortRow = {
  date: string;
  updatedAt: string;
  shortSellingVolume: string;
  shortSellingAmount: string;
  shortSellingVolumeRate: string | null;
  shortSellingAmountRate: string | null;
};
export function parseShortSelling(body: unknown) {
  const { asOf, rows } = records(body);
  return emptyCheck({
    asOf,
    rows: rows.map((r): ShortRow => ({
      date: str(r.date),
      updatedAt: when(r.updatedAt),
      shortSellingVolume: dec(r.shortSellingVolume),
      shortSellingAmount: dec(r.shortSellingAmount),
      shortSellingVolumeRate: decOrNull(r.shortSellingVolumeRate),
      shortSellingAmountRate: decOrNull(r.shortSellingAmountRate),
    })),
  });
}
type CreditSide = {
  newQuantity: string;
  returnQuantity: string;
  balanceQuantity: string;
  balanceRate: string;
  tradingRate: string;
};
const credit = (value: unknown): CreditSide | null => {
  if (value === null || value === undefined) return null;
  const c = obj(value);
  return {
    newQuantity: dec(c.newQuantity),
    returnQuantity: dec(c.returnQuantity),
    balanceQuantity: dec(c.balanceQuantity),
    balanceRate: dec(c.balanceRate),
    tradingRate: dec(c.tradingRate),
  };
};
export type CreditRow = {
  date: string;
  updatedAt: string;
  marginLoan: CreditSide | null;
  stockLoan: CreditSide | null;
};
export function parseCreditTrades(body: unknown) {
  const { asOf, rows } = records(body);
  return emptyCheck({
    asOf,
    rows: rows.map((r): CreditRow => ({
      date: str(r.date),
      updatedAt: when(r.updatedAt),
      marginLoan: credit(r.marginLoan),
      stockLoan: credit(r.stockLoan),
    })),
  });
}

export type Orderbook = {
  asOf: string;
  timestamp: string | null;
  currency: 'KRW' | 'USD';
  asks: { price: string; volume: string }[];
  bids: { price: string; volume: string }[];
};
export function parseOrderbook(body: unknown): Orderbook {
  const { d, asOf } = header(body);
  const levels = (value: unknown) =>
    arr(value).map((raw) => {
      const l = obj(raw);
      return { price: dec(l.price), volume: dec(l.volume) };
    });
  const asks = levels(d.asks);
  const bids = levels(d.bids);
  if (!asks.length && !bids.length) throw new NoDataError('토스가 호가를 돌려주지 않았습니다.');
  return {
    asOf,
    timestamp: d.timestamp === null || d.timestamp === undefined ? null : when(d.timestamp),
    currency: cur(d.currency),
    asks,
    bids,
  };
}
export type Trades = {
  asOf: string;
  trades: { price: string; volume: string; timestamp: string; currency: 'KRW' | 'USD' }[];
};
export function parseTrades(body: unknown): Trades {
  const { d, asOf } = header(body);
  const trades = arr(d.trades).map((raw) => {
    const t = obj(raw);
    return {
      price: dec(t.price),
      volume: dec(t.volume),
      timestamp: when(t.timestamp),
      currency: cur(t.currency),
    };
  });
  if (!trades.length) throw new NoDataError('토스가 당일 체결 내역을 돌려주지 않았습니다.');
  return { asOf, trades };
}

// ---- Event lines, comparison series, own trades (stages 5d, 5e) -------------------------------

export type EventSourceReport = {
  id: 'calendar' | 'fred' | 'dart' | 'sec';
  name: string;
  status: 'ok' | 'unavailable' | 'error' | 'no-data' | 'not-applicable';
  count: number;
  asOf: string | null;
  code?: string;
  message?: string;
  retryAfter?: number;
};
export type EventsResponse = {
  asOf: string;
  from: string;
  to: string;
  events: ChartEvent[];
  truncated: boolean;
  sources: EventSourceReport[];
  notice: string;
};
const kinds: EventKind[] = ['rate-decision', 'earnings', 'economic-indicator', 'disclosure'];
const origins: EventOrigin[] = ['calendar', 'fred', 'dart', 'sec'];
const day = (value: unknown) => {
  const result = str(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw bad();
  return result;
};
/** `GET /api/analysis/events`. Items that do not match the contract make the whole response invalid. */
export function parseEvents(body: unknown): EventsResponse {
  const d = obj(body);
  const asOf = when(d.asOf);
  const events = arr(d.events).map((raw): ChartEvent => {
    const e = obj(raw);
    const importance = e.importance;
    if (importance !== 1 && importance !== 2 && importance !== 3) throw bad();
    if (!kinds.includes(e.kind as EventKind)) throw bad();
    if (e.market !== 'US' && e.market !== 'KR') throw bad();
    if (!origins.includes(e.origin as EventOrigin)) throw bad();
    return {
      id: str(e.id),
      date: day(e.date),
      title: str(e.title),
      titleLanguage: e.titleLanguage === 'original' ? 'original' : 'ko',
      kind: e.kind as EventKind,
      importance,
      market: e.market,
      source: str(e.source),
      url: str(e.url),
      origin: e.origin as EventOrigin,
    };
  });
  const sources = arr(d.sources).map((raw): EventSourceReport => {
    const s = obj(raw);
    const status = s.status;
    if (
      status !== 'ok' &&
      status !== 'unavailable' &&
      status !== 'error' &&
      status !== 'no-data' &&
      status !== 'not-applicable'
    )
      throw bad();
    if (!origins.includes(s.id as EventOrigin)) throw bad();
    return {
      id: s.id as EventSourceReport['id'],
      name: str(s.name),
      status,
      count: typeof s.count === 'number' ? s.count : 0,
      asOf: strOrNull(s.asOf),
      ...(typeof s.code === 'string' ? { code: s.code } : {}),
      ...(typeof s.message === 'string' ? { message: s.message } : {}),
      ...(typeof s.retryAfter === 'number' ? { retryAfter: s.retryAfter } : {}),
    };
  });
  return {
    asOf,
    from: day(d.from),
    to: day(d.to),
    events,
    truncated: d.truncated === true,
    sources,
    notice: typeof d.notice === 'string' ? d.notice : '',
  };
}

export type FillsResponse = {
  asOf: string;
  connected: boolean;
  fills: (FillInput & { filledAt: string })[];
  notice: string;
};
/** `GET /api/analysis/algorithm-fills`. */
export function parseFills(body: unknown): FillsResponse {
  const d = obj(body);
  const fills = arr(d.fills).map((raw): FillsResponse['fills'][number] => {
    const f = obj(raw);
    if (f.side !== 'buy' && f.side !== 'sell') throw bad();
    if (f.mode !== 'paper' && f.mode !== 'live') throw bad();
    return {
      id: str(f.id),
      algorithmName: str(f.algorithmName),
      side: f.side,
      mode: f.mode,
      date: day(f.date),
      filledAt: when(f.filledAt),
      price: dec(f.price),
      quantity: dec(f.quantity),
      currency: cur(f.currency),
    };
  });
  return {
    asOf: when(d.asOf),
    connected: d.connected === true,
    fills,
    notice: typeof d.notice === 'string' ? d.notice : '',
  };
}

export type HoldingCost = {
  asOf: string;
  source: string;
  /** Matching holding of the symbol, or null when the owner does not hold it. */
  holding: {
    currency: 'KRW' | 'USD';
    quantity: string;
    averagePurchasePrice: number | null;
  } | null;
};
/** `GET /api/portfolio`, reduced to the one holding of `symbol` (case-insensitive). */
export function parseHoldingCost(symbol: string) {
  return (body: unknown): HoldingCost => {
    const { d, source, asOf } = header(body);
    const match = arr(d.holdings)
      .map(obj)
      .find((h) => str(h.symbol).toUpperCase() === symbol.toUpperCase());
    if (!match) return { asOf, source, holding: null };
    const average = decOrNull(match.averagePurchasePrice);
    return {
      asOf,
      source,
      holding: {
        currency: cur(match.currency),
        quantity: dec(match.quantity),
        averagePurchasePrice: average === null || !(Number(average) > 0) ? null : Number(average),
      },
    };
  };
}

export type MacroSeries = {
  source: string;
  sourceName: string;
  titleKo: string;
  asOf: string;
  points: DatedValue[];
};
/** `GET /api/macro/series`; missing values (null) are skipped, never filled. */
export function parseMacroSeries(body: unknown): MacroSeries {
  const d = obj(body);
  const points: DatedValue[] = [];
  for (const raw of arr(d.observations)) {
    const o = obj(raw);
    const value = decOrNull(o.value);
    if (value !== null) points.push({ date: day(o.date), value: Number(value) });
  }
  if (!points.length) throw new NoDataError('??湲곌컙???쒓났?먭? ?뚮젮以 媛믪씠 ?놁뒿?덈떎.');
  return {
    source: str(d.source),
    sourceName: str(d.sourceName),
    titleKo: str(d.titleKo),
    asOf: when(d.asOf),
    points,
  };
}
