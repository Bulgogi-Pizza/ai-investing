import { ProviderError } from './toss.js';
import { record, schemaInvalid, SingleFlightCache, text, TtlCache } from './fundamentals/shared.js';

/**
 * Owner-only Toss reads for the 종목 분석 tab (stock info, warnings, price limits, sectors, investor
 * trends, order book, trades). Contract: Toss Securities OpenAPI v1.2.24, checked 2026-10-21 KST.
 * Only documented fields are read; anything shaped differently fails with PROVIDER_SCHEMA_INVALID
 * (502). The module is deliberately separate from toss.ts: it only needs `readJson`, the
 * authenticated GET that returns the provider `result` payload.
 */
export type TossReader = { readJson(path: string): Promise<unknown> };

const SOURCE = 'Toss Securities OpenAPI';
const SYMBOL = /^[A-Za-z0-9.\-]{1,30}$/;
const SECTOR_ID = /^[A-Za-z0-9_-]{1,40}$/;
export const MAX_STOCK_LOOKUP = 20;
/** Peers returned for the sector comparison (largest market caps first, the subject excluded). */
export const SECTOR_PEER_CAP = 20;
/** A sector with fewer comparable peers than this is too thin; the next broader sector is used. */
export const SECTOR_MIN_PEERS = 5;
/** Upper bound of `/sectors/{id}/stocks` calls for one sector lookup. */
export const SECTOR_LOOKUP_LIMIT = 60;
export const TREND_COUNT_DEFAULT = 10;
export const TREND_COUNT_MAX = 30;
export const TRADES_COUNT_DEFAULT = 20;
export const TRADES_COUNT_MAX = 50;

export const invalidQuery = () =>
  new ProviderError(400, 'INVALID_ANALYSIS_QUERY', '종목 코드와 조회 조건을 확인하세요.');
export const unsupportedMarket = () =>
  new ProviderError(
    400,
    'UNSUPPORTED_MARKET',
    '이 데이터는 국내 종목만 제공됩니다. 미국 종목은 토스가 제공하지 않습니다.',
  );

/** KRX codes are 6 characters (digits or letters) and always contain a digit; US tickers do not. */
export const isKoreanSymbol = (symbol: string) =>
  /^[0-9A-Za-z]{6}$/.test(symbol) && /[0-9]/.test(symbol);

export function parseSymbol(value: unknown): string | null {
  return typeof value === 'string' && SYMBOL.test(value) ? value : null;
}
export function parseSymbolList(value: unknown, maximum = MAX_STOCK_LOOKUP): string[] | null {
  if (typeof value !== 'string' || value.length > 1000) return null;
  const parts = value.split(',');
  if (parts.length > maximum || parts.some((part) => !SYMBOL.test(part))) return null;
  const seen = new Set<string>();
  return parts.filter((part) => {
    const key = part.toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function parseCount(value: unknown, fallback: number, maximum: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value)) return null;
  const count = Number(value);
  return count >= 1 && count <= maximum ? count : null;
}

function decimal(value: unknown): string {
  const result = text(value, 100);
  if (!/^-?\d+(\.\d+)?$/.test(result)) throw schemaInvalid();
  return result;
}
const nullableDecimal = (value: unknown) =>
  value === null || value === undefined ? null : decimal(value);
function date(value: unknown): string {
  const result = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(result)))
    throw schemaInvalid();
  return result;
}
const nullableDate = (value: unknown) =>
  value === null || value === undefined ? null : date(value);
function dateTime(value: unknown): string {
  const result = text(value, 50);
  if (!Number.isFinite(Date.parse(result))) throw schemaInvalid();
  return result;
}
const nullableDateTime = (value: unknown) =>
  value === null || value === undefined ? null : dateTime(value);
function currency(value: unknown): 'KRW' | 'USD' {
  if (value !== 'KRW' && value !== 'USD') throw schemaInvalid();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw schemaInvalid();
  return value;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw schemaInvalid();
  return value;
}
/** Enum-like code that the spec says clients must tolerate when unknown: kept as a bounded string. */
function code(value: unknown): string {
  const result = text(value, 60);
  if (!/^[A-Z0-9_]+$/.test(result)) throw schemaInvalid();
  return result;
}

export type StockInfo = {
  symbol: string;
  name: string;
  englishName: string;
  market: string;
  securityType: string;
  isCommonShare: boolean;
  status: string;
  currency: 'KRW' | 'USD';
  /** 발행주식수 as a decimal string. */
  sharesOutstanding: string;
  listDate: string | null;
  delistDate: string | null;
  koreanMarketDetail: {
    liquidationTrading: boolean;
    nxtSupported: boolean;
    krxTradingSuspended: boolean;
    nxtTradingSuspended: boolean | null;
  } | null;
};

function normalizeStock(value: unknown): StockInfo {
  const s = record(value);
  const detail = s.koreanMarketDetail;
  let koreanMarketDetail: StockInfo['koreanMarketDetail'] = null;
  if (detail !== null && detail !== undefined) {
    const d = record(detail);
    koreanMarketDetail = {
      liquidationTrading: bool(d.liquidationTrading),
      nxtSupported: bool(d.nxtSupported),
      krxTradingSuspended: bool(d.krxTradingSuspended),
      nxtTradingSuspended:
        d.nxtTradingSuspended === null || d.nxtTradingSuspended === undefined
          ? null
          : bool(d.nxtTradingSuspended),
    };
  }
  return {
    symbol: text(s.symbol, 30),
    name: text(s.name, 200),
    englishName: text(s.englishName, 200),
    market: code(s.market),
    securityType: code(s.securityType),
    isCommonShare: bool(s.isCommonShare),
    status: code(s.status),
    currency: currency(s.currency),
    sharesOutstanding: decimal(s.sharesOutstanding),
    listDate: nullableDate(s.listDate),
    delistDate: nullableDate(s.delistDate),
    koreanMarketDetail,
  };
}

type Volume = { buyVolume: string; sellVolume: string; netBuyVolume: string };
function volume(value: unknown): Volume {
  const v = record(value);
  return {
    buyVolume: decimal(v.buyVolume),
    sellVolume: decimal(v.sellVolume),
    netBuyVolume: decimal(v.netBuyVolume),
  };
}
const nullableVolume = (value: unknown) =>
  value === null || value === undefined ? null : volume(value);

type CreditSide = {
  newQuantity: string;
  returnQuantity: string;
  balanceQuantity: string;
  balanceRate: string;
  tradingRate: string;
};
function creditSide(value: unknown): CreditSide | null {
  if (value === null || value === undefined) return null;
  const c = record(value);
  return {
    newQuantity: decimal(c.newQuantity),
    returnQuantity: decimal(c.returnQuantity),
    balanceQuantity: decimal(c.balanceQuantity),
    balanceRate: decimal(c.balanceRate),
    tradingRate: decimal(c.tradingRate),
  };
}

export type SectorNode = {
  sectorId: string;
  name: string;
  depth: number;
  parentSectorId: string | null;
};
export type SectorMember = {
  symbol: string;
  name: string;
  marketCapitalization: string | null;
  currency: 'KRW' | 'USD';
};

/** Concurrency-limited map that keeps the first error and preserves input order. */
async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

const numericOrder = (a: string, b: string) => {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && x !== y ? x - y : a.localeCompare(b);
};

/**
 * Which matching sector to compare against: the deepest one with at least SECTOR_MIN_PEERS peers
 * (the stock itself does not count), else the match with the most members. Ties at the same depth
 * go to the lowest numeric sectorId; the remaining ties are reported as `others`.
 */
export function chooseSector(
  matches: { node: SectorNode; members: SectorMember[] }[],
  subject: string,
): { node: SectorNode; members: SectorMember[]; others: SectorNode[] } | null {
  if (!matches.length) return null;
  const peerCount = (m: { members: SectorMember[] }) =>
    m.members.filter((x) => x.symbol.toUpperCase() !== subject).length;
  const eligible = matches.filter((m) => peerCount(m) >= SECTOR_MIN_PEERS);
  let pool: typeof matches;
  if (eligible.length) {
    const depth = Math.max(...eligible.map((m) => m.node.depth));
    pool = eligible.filter((m) => m.node.depth === depth);
  } else {
    const most = Math.max(...matches.map((m) => m.members.length));
    pool = matches.filter((m) => m.members.length === most);
  }
  const sorted = [...pool].sort((a, b) => numericOrder(a.node.sectorId, b.node.sectorId));
  return { ...sorted[0], others: sorted.slice(1).map((m) => m.node) };
}

export class TossAnalysis {
  private caches = new Map<number, SingleFlightCache<unknown>>();
  constructor(
    private reader: TossReader,
    private clock: () => number = Date.now,
  ) {}
  private async cached<T>(ttlMs: number, key: string, load: () => Promise<T>): Promise<T> {
    let cache = this.caches.get(ttlMs);
    if (!cache) {
      cache = new SingleFlightCache<unknown>(new TtlCache<unknown>(ttlMs, 300, this.clock));
      this.caches.set(ttlMs, cache);
    }
    return (await cache.get(key, load)) as T;
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private async read(path: string, params: Record<string, string> = {}) {
    const query = new URLSearchParams(params).toString();
    return this.reader.readJson(query ? `${path}?${query}` : path);
  }

  /** GET /api/v1/stocks?symbols= (Stock Info). Symbols the provider does not know are omitted. */
  async stocks(symbols: string[]) {
    if (
      !symbols.length ||
      symbols.length > MAX_STOCK_LOOKUP ||
      symbols.some((s) => !SYMBOL.test(s))
    )
      throw invalidQuery();
    const key = symbols.map((s) => s.toUpperCase()).join(',');
    return this.cached(30_000, `stocks:${key}`, async () => {
      const result = list(await this.read('/api/v1/stocks', { symbols: symbols.join(',') }), 200);
      const requested = new Set(symbols.map((s) => s.toUpperCase()));
      const seen = new Set<string>();
      const stocks = result.map((value) => {
        const stock = normalizeStock(value);
        const id = stock.symbol.toUpperCase();
        if (!requested.has(id) || seen.has(id)) throw schemaInvalid();
        seen.add(id);
        return stock;
      });
      return { source: SOURCE, asOf: this.now(), stocks };
    });
  }

  /** GET /api/v1/stocks/{symbol}/warnings: active 매수 유의사항 (empty list is a valid answer). */
  async warnings(symbol: string) {
    if (!SYMBOL.test(symbol)) throw invalidQuery();
    return this.cached(30_000, `warnings:${symbol.toUpperCase()}`, async () => {
      const result = list(await this.read(`/api/v1/stocks/${symbol}/warnings`), 100);
      const warnings = result.map((value) => {
        const w = record(value);
        return {
          warningType: code(w.warningType),
          exchange: w.exchange === null || w.exchange === undefined ? null : text(w.exchange, 30),
          startDate: nullableDate(w.startDate),
          endDate: nullableDate(w.endDate),
        };
      });
      return { source: SOURCE, asOf: this.now(), symbol, warnings };
    });
  }

  /** GET /api/v1/price-limits?symbol= (Market Data). US stocks return null limits. */
  async priceLimits(symbol: string) {
    if (!SYMBOL.test(symbol)) throw invalidQuery();
    return this.cached(15_000, `limits:${symbol.toUpperCase()}`, async () => {
      const r = record(await this.read('/api/v1/price-limits', { symbol }));
      return {
        source: SOURCE,
        asOf: this.now(),
        symbol,
        timestamp: dateTime(r.timestamp),
        upperLimitPrice: nullableDecimal(r.upperLimitPrice),
        lowerLimitPrice: nullableDecimal(r.lowerLimitPrice),
        currency: currency(r.currency),
      };
    });
  }

  private sectors() {
    return this.cached(6 * 3600_000, 'sectors', async () => {
      const result = record(await this.read('/api/v1/sectors'));
      return list(result.sectors, 2000).map((value): SectorNode => {
        const s = record(value);
        const depth = s.depth;
        const id = text(s.sectorId, 40);
        if (!SECTOR_ID.test(id) || typeof depth !== 'number' || ![0, 1, 2].includes(depth))
          throw schemaInvalid();
        return {
          sectorId: id,
          name: text(s.name, 200),
          depth,
          parentSectorId:
            s.parentSectorId === null || s.parentSectorId === undefined
              ? null
              : text(s.parentSectorId, 40),
        };
      });
    });
  }

  private sectorMembers(sectorId: string, market: 'KR' | 'US') {
    return this.cached(3600_000, `sector:${sectorId}:${market}`, async () => {
      const result = record(
        await this.read(`/api/v1/sectors/${sectorId}/stocks`, { marketCountry: market }),
      );
      return list(result.stocks, 5000).map((value): SectorMember => {
        const s = record(value);
        return {
          symbol: text(s.symbol, 30),
          name: text(s.name, 200),
          marketCapitalization: nullableDecimal(s.marketCapitalization),
          currency: currency(s.currency),
        };
      });
    });
  }

  /**
   * The sector the stock belongs to and a capped peer list. Toss has no "sector of a stock" call, so
   * the sector tree is searched top-down: a sector's stock list includes its sub-sectors, so only
   * sectors that contain the stock are opened further. Bounded by SECTOR_LOOKUP_LIMIT calls.
   * A stock can belong to several sectors; the deepest sector with at least SECTOR_MIN_PEERS peers
   * is chosen (otherwise the broadest match) and the others at that depth are listed as `alsoIn`.
   */
  async sectorPeers(symbol: string, market: 'KR' | 'US') {
    if (!SYMBOL.test(symbol) || (market !== 'KR' && market !== 'US')) throw invalidQuery();
    const subject = symbol.toUpperCase();
    return this.cached(300_000, `peers:${market}:${subject}`, async () => {
      const sectors = await this.sectors();
      const byId = new Map(sectors.map((s) => [s.sectorId, s]));
      let lookups = 0;
      let limitReached = false;
      const matches: { node: SectorNode; members: SectorMember[] }[] = [];
      let level = sectors.filter((s) => s.depth === 0);
      while (level.length && !limitReached) {
        const budget = SECTOR_LOOKUP_LIMIT - lookups;
        if (budget <= 0) {
          limitReached = true;
          break;
        }
        const batch = level.slice(0, budget);
        if (batch.length < level.length) limitReached = true;
        lookups += batch.length;
        const lists = await mapLimit(batch, 3, (node) => this.sectorMembers(node.sectorId, market));
        const hits = batch
          .map((node, index) => ({ node, members: lists[index] }))
          .filter(({ members }) => members.some((m) => m.symbol.toUpperCase() === subject));
        matches.push(...hits);
        const hitIds = new Set(hits.map((h) => h.node.sectorId));
        level = sectors.filter((s) => s.parentSectorId !== null && hitIds.has(s.parentSectorId));
      }
      const chosen = chooseSector(matches, subject);
      const common = {
        source: SOURCE,
        asOf: this.now(),
        symbol,
        market,
        peerCap: SECTOR_PEER_CAP,
        lookups,
        lookupLimit: SECTOR_LOOKUP_LIMIT,
        lookupLimitReached: limitReached,
      };
      if (!chosen)
        return {
          ...common,
          sector: null,
          alsoIn: [] as { sectorId: string; name: string }[],
          memberCount: 0,
          peers: [] as SectorMember[],
          peersTruncated: false,
        };
      const path: string[] = [];
      for (
        let node: SectorNode | undefined = chosen.node;
        node && path.length < 4;
        node = node.parentSectorId ? byId.get(node.parentSectorId) : undefined
      )
        path.unshift(node.name);
      const peers = chosen.members.filter((m) => m.symbol.toUpperCase() !== subject);
      return {
        ...common,
        sector: {
          sectorId: chosen.node.sectorId,
          name: chosen.node.name,
          depth: chosen.node.depth,
          path,
        },
        alsoIn: chosen.others.map((o) => ({ sectorId: o.sectorId, name: o.name })),
        memberCount: chosen.members.length,
        // The provider lists stocks by market cap, largest first; the cap keeps the largest peers.
        peers: peers.slice(0, SECTOR_PEER_CAP),
        peersTruncated: peers.length > SECTOR_PEER_CAP,
      };
    });
  }

  private trend<T>(
    kind: string,
    symbol: string,
    count: number,
    map: (record: Record<string, unknown>) => T,
  ) {
    if (!isKoreanSymbol(symbol)) throw unsupportedMarket();
    if (!Number.isInteger(count) || count < 1 || count > TREND_COUNT_MAX) throw invalidQuery();
    return this.cached(60_000, `${kind}:${symbol.toUpperCase()}:${count}`, async () => {
      const result = record(
        await this.read(`/api/v1/stocks/${symbol}/${kind}`, { count: String(count) }),
      );
      const records = list(result.records, 100).map((value) => map(record(value)));
      return { source: SOURCE, asOf: this.now(), symbol, records };
    });
  }

  investorTrading(symbol: string, count = TREND_COUNT_DEFAULT) {
    return this.trend('investor-trading', symbol, count, (r) => {
      const institution = record(r.institution);
      const holding = r.foreignerHolding;
      let foreignerHolding: {
        holdingQuantity: string;
        limitQuantity: string;
        holdingRate: string;
      } | null = null;
      if (holding !== null && holding !== undefined) {
        const h = record(holding);
        foreignerHolding = {
          holdingQuantity: decimal(h.holdingQuantity),
          limitQuantity: decimal(h.limitQuantity),
          holdingRate: decimal(h.holdingRate),
        };
      }
      return {
        date: date(r.date),
        updatedAt: dateTime(r.updatedAt),
        // 개인·기타법인·외국인 보유는 당일 잠정치가 없으면 null이다(스펙).
        individual: nullableVolume(r.individual),
        foreigner: volume(r.foreigner),
        institution: volume(institution),
        otherCorporation: nullableVolume(r.otherCorporation),
        foreignerHolding,
      };
    });
  }
  programTrades(symbol: string, count = TREND_COUNT_DEFAULT) {
    return this.trend('program-trades', symbol, count, (r) => ({
      date: date(r.date),
      arbitrage: volume(r.arbitrage),
      nonArbitrage: volume(r.nonArbitrage),
    }));
  }
  shortSelling(symbol: string, count = TREND_COUNT_DEFAULT) {
    return this.trend('short-selling', symbol, count, (r) => ({
      date: date(r.date),
      updatedAt: dateTime(r.updatedAt),
      shortSellingVolume: decimal(r.shortSellingVolume),
      shortSellingAmount: decimal(r.shortSellingAmount),
      shortSellingVolumeRate: nullableDecimal(r.shortSellingVolumeRate),
      shortSellingAmountRate: nullableDecimal(r.shortSellingAmountRate),
    }));
  }
  creditTrades(symbol: string, count = TREND_COUNT_DEFAULT) {
    return this.trend('credit-trades', symbol, count, (r) => ({
      date: date(r.date),
      updatedAt: dateTime(r.updatedAt),
      marginLoan: creditSide(r.marginLoan),
      stockLoan: creditSide(r.stockLoan),
    }));
  }

  /** GET /api/v1/orderbook?symbol=. Snapshot only; a 2 s cache stops double clicks from hammering. */
  async orderbook(symbol: string) {
    if (!SYMBOL.test(symbol)) throw invalidQuery();
    return this.cached(2_000, `orderbook:${symbol.toUpperCase()}`, async () => {
      const r = record(await this.read('/api/v1/orderbook', { symbol }));
      const levels = (value: unknown) =>
        list(value, 50).map((item) => {
          const l = record(item);
          return { price: decimal(l.price), volume: decimal(l.volume) };
        });
      return {
        source: SOURCE,
        asOf: this.now(),
        symbol,
        timestamp: nullableDateTime(r.timestamp),
        currency: currency(r.currency),
        asks: levels(r.asks),
        bids: levels(r.bids),
      };
    });
  }

  /** GET /api/v1/trades?symbol=&count= (당일 최근 체결, newest first as the provider sends them). */
  async trades(symbol: string, count = TRADES_COUNT_DEFAULT) {
    if (!SYMBOL.test(symbol) || !Number.isInteger(count) || count < 1 || count > TRADES_COUNT_MAX)
      throw invalidQuery();
    return this.cached(2_000, `trades:${symbol.toUpperCase()}:${count}`, async () => {
      const result = list(await this.read('/api/v1/trades', { symbol, count: String(count) }), 50);
      const trades = result.map((value) => {
        const t = record(value);
        return {
          price: decimal(t.price),
          volume: decimal(t.volume),
          timestamp: dateTime(t.timestamp),
          currency: currency(t.currency),
        };
      });
      return { source: SOURCE, asOf: this.now(), symbol, trades };
    });
  }
}
