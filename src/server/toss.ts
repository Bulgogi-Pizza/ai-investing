import { createHash, randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';

const BASE = 'https://openapi.tossinvest.com';
export class ProviderError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter?: number,
    /** HTTP status the provider sent when it refused the call (401/403); never provider text. */
    public upstreamStatus?: number,
  ) {
    super(message);
  }
}
type Token = { value: string; expiresAt: number };
export interface TokenCache {
  get(issue: () => Promise<Token>): Promise<string>;
}
export class MemoryTokenCache implements TokenCache {
  private token?: Token;
  private pending?: Promise<Token>;
  private blockedUntil = 0;
  async get(issue: () => Promise<Token>) {
    if (this.token && this.token.expiresAt > Date.now() + 60000) return this.token.value;
    if (this.blockedUntil > Date.now())
      throw new ProviderError(503, 'PROVIDER_TOKEN_COOLDOWN', '인증 재시도 대기 중입니다.', 60);
    if (!this.pending)
      this.pending = issue()
        .then((token) => {
          this.token = token;
          return token;
        })
        .catch((error) => {
          this.blockedUntil = Date.now() + 60000;
          throw error;
        })
        .finally(() => {
          this.pending = undefined;
        });
    return (await this.pending).value;
  }
}
// Shared lease prevents token issuance races across Cloud Run instances/revisions.
// This server-only collection contains bearer credentials: deny all client SDK access.
export class FirestoreTokenCache implements TokenCache {
  private pending?: Promise<string>;
  private ref;
  constructor(
    clientId: string,
    private db = new Firestore(),
  ) {
    this.ref = db
      .collection('providerTokens')
      .doc(createHash('sha256').update(clientId).digest('hex'));
  }
  get(issue: () => Promise<Token>) {
    if (!this.pending)
      this.pending = this.acquire(issue).finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async acquire(issue: () => Promise<Token>) {
    const owner = randomUUID();
    const cached = await this.db.runTransaction(async (tx) => {
      const state = (await tx.get(this.ref)).data();
      if (typeof state?.value === 'string' && state.expiresAt > Date.now() + 60000)
        return state.value as string;
      if (state?.leaseUntil > Date.now())
        throw new ProviderError(503, 'PROVIDER_TOKEN_BUSY', '인증 갱신 대기 중입니다.', 60);
      tx.set(this.ref, { leaseOwner: owner, leaseUntil: Date.now() + 60000 }, { merge: true });
      return null;
    });
    if (cached) return cached;
    // An uncertain/failed issuance keeps its lease for 60s; never issue automatic retries.
    const token = await issue();
    await this.db.runTransaction(async (tx) => {
      const state = (await tx.get(this.ref)).data();
      if (state?.leaseOwner !== owner || state.leaseUntil <= Date.now())
        throw new ProviderError(503, 'PROVIDER_TOKEN_BUSY', '인증 갱신 대기 중입니다.', 60);
      tx.set(this.ref, { ...token, leaseUntil: 0, leaseOwner: '' });
    });
    return token.value;
  }
}
export type TossConfig = {
  clientId: string;
  clientSecret: string;
  accountSeq: string;
  ownerUserId: string;
};
export type NormalizedHolding = {
  symbol: string;
  name: string;
  market: 'KR' | 'US';
  currency: 'KRW' | 'USD';
  quantity: string;
  lastPrice: string;
  averagePurchasePrice: string;
  marketValue: string;
  profitLoss: string;
  profitLossRate: string;
};
export type PortfolioResponse = {
  source: string;
  asOf: string;
  scope: 'stocks-only';
  totals: Record<
    'KRW' | 'USD',
    { marketValue: string | null; purchaseAmount: string | null; profitLoss: string | null }
  >;
  holdings: NormalizedHolding[];
};
const invalid = () =>
  new ProviderError(502, 'PROVIDER_SCHEMA_INVALID', '제공자 응답 형식을 확인하지 못했습니다.');
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 200): string {
  if (typeof value !== 'string' || value.length > max) throw invalid();
  return value;
}
function decimal(value: unknown): string {
  const result = text(value, 100);
  if (!/^-?\d+(\.\d+)?$/.test(result)) throw invalid();
  return result;
}
function nullableDecimal(value: unknown) {
  return value === null ? null : decimal(value);
}
export function normalizeHoldings(value: unknown): PortfolioResponse {
  const v = record(value);
  if (!Array.isArray(v.items) || v.items.length > 10000) throw invalid();
  const purchase = record(v.totalPurchaseAmount);
  const amounts = record(record(v.marketValue).amount);
  const profits = record(record(v.profitLoss).amount);
  const total = (currency: string) => ({
    marketValue: nullableDecimal(amounts[currency]),
    purchaseAmount: nullableDecimal(purchase[currency]),
    profitLoss: nullableDecimal(profits[currency]),
  });
  const holdings = v.items.map((item) => {
    const h = record(item);
    if (
      !['KR', 'US'].includes(h.marketCountry as string) ||
      !['KRW', 'USD'].includes(h.currency as string)
    )
      throw invalid();
    return {
      symbol: text(h.symbol, 30),
      name: text(h.name),
      market: h.marketCountry as 'KR' | 'US',
      currency: h.currency as 'KRW' | 'USD',
      quantity: decimal(h.quantity),
      lastPrice: decimal(h.lastPrice),
      averagePurchasePrice: decimal(h.averagePurchasePrice),
      marketValue: decimal(record(h.marketValue).amount),
      profitLoss: decimal(record(h.profitLoss).amount),
      profitLossRate: decimal(record(h.profitLoss).rate),
    };
  });
  return {
    source: 'Toss Securities OpenAPI',
    asOf: new Date().toISOString(),
    scope: 'stocks-only',
    totals: { KRW: total('krw'), USD: total('usd') },
    holdings,
  };
}
// Symbol catalog of GET /api/v1/market-indicators/prices (official spec v1.2.24).
export const MARKET_INDICATOR_CATALOG = [
  { symbol: 'KOSPI', name: '코스피', kind: 'INDEX', unit: 'point' },
  { symbol: 'KOSDAQ', name: '코스닥', kind: 'INDEX', unit: 'point' },
  { symbol: 'KR_BOND_2Y', name: '국채 2년', kind: 'BOND', unit: 'percent' },
  { symbol: 'KR_BOND_3Y', name: '국채 3년', kind: 'BOND', unit: 'percent' },
  { symbol: 'KR_BOND_5Y', name: '국채 5년', kind: 'BOND', unit: 'percent' },
  { symbol: 'KR_BOND_10Y', name: '국채 10년', kind: 'BOND', unit: 'percent' },
  { symbol: 'KR_BOND_20Y', name: '국채 20년', kind: 'BOND', unit: 'percent' },
  { symbol: 'KR_BOND_30Y', name: '국채 30년', kind: 'BOND', unit: 'percent' },
] as const;
export const MAX_PRICE_SYMBOLS = 50;
const SYMBOL = /^[A-Za-z0-9.\-]{1,30}$/;
/** Returns de-duplicated symbols, or null for any malformed or oversized input. */
export function parsePriceSymbols(value: unknown): string[] | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  const parts = value.split(',');
  if (parts.length > MAX_PRICE_SYMBOLS || parts.some((part) => !SYMBOL.test(part))) return null;
  // Case-insensitive de-duplication keeps the first spelling; the provider is case-insensitive.
  const seen = new Set<string>();
  return parts.filter((part) => {
    const key = part.toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function nullableTimestamp(value: unknown) {
  if (value === null || value === undefined) return null;
  const result = text(value, 50);
  if (!Number.isFinite(Date.parse(result))) throw invalid();
  return result;
}
function timestamp(value: unknown) {
  const result = text(value, 50);
  if (!Number.isFinite(Date.parse(result))) throw invalid();
  return result;
}
// ---- Snapshot adapters (stage 4). Official spec v1.2.24, checked 2026-10-21 KST. ----
// Only documented fields are read; any other shape fails with PROVIDER_SCHEMA_INVALID.
export const PROVIDER_FORBIDDEN = 'PROVIDER_FORBIDDEN';
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const KR_SYMBOL = /^[A-Za-z0-9]{6}$/;
function dateOnly(value: unknown) {
  const result = text(value, 10);
  if (!DATE_ONLY.test(result) || !Number.isFinite(Date.parse(result + 'T00:00:00Z')))
    throw invalid();
  return result;
}
function optionalDecimal(value: unknown) {
  return value === null || value === undefined ? null : decimal(value);
}
export type MarketCode = 'KR' | 'US';
export type MarketSessionWindow = { startTime: string; endTime: string };
export type MarketDay = { date: string; regularMarket: MarketSessionWindow | null };
export type MarketCalendar = {
  source: string;
  asOf: string;
  market: MarketCode;
  requestedDate: string;
  previousBusinessDay: MarketDay;
  today: MarketDay;
  nextBusinessDay: MarketDay;
};
function sessionWindow(value: unknown): MarketSessionWindow | null {
  if (value === null || value === undefined) return null;
  const s = record(value);
  const startTime = timestamp(s.startTime);
  const endTime = timestamp(s.endTime);
  if (Date.parse(endTime) <= Date.parse(startTime)) throw invalid();
  return { startTime, endTime };
}
/** KR: integrated (KRX+NXT) union regular session, null when both are closed. US: regularMarket. */
export function normalizeMarketDay(market: MarketCode, value: unknown): MarketDay {
  const day = record(value);
  const date = dateOnly(day.date);
  if (market === 'US') return { date, regularMarket: sessionWindow(day.regularMarket) };
  const integrated =
    day.integrated === null || day.integrated === undefined ? null : record(day.integrated);
  return { date, regularMarket: integrated ? sessionWindow(integrated.regularMarket) : null };
}
export type Flow = { buyVolume: string; sellVolume: string; netBuyVolume: string };
function flow(value: unknown): Flow {
  const f = record(value);
  return {
    buyVolume: decimal(f.buyVolume),
    sellVolume: decimal(f.sellVolume),
    netBuyVolume: decimal(f.netBuyVolume),
  };
}
function nullableFlow(value: unknown): Flow | null {
  return value === null || value === undefined ? null : flow(value);
}
const INSTITUTION_BREAKDOWN = [
  'financialInvestment',
  'insurance',
  'trust',
  'privateEquityFund',
  'bank',
  'otherFinancialInstitution',
  'pensionFund',
] as const;
export type InvestorTradingRecord = {
  date: string;
  updatedAt: string;
  individual: Flow | null;
  foreigner: Flow;
  institution: Flow & { breakdown: Record<(typeof INSTITUTION_BREAKDOWN)[number], Flow> | null };
  otherCorporation: Flow | null;
  foreignerHolding: { holdingQuantity: string; limitQuantity: string; holdingRate: string } | null;
  cfd: {
    buyBalanceQuantity: string;
    buyBalanceRate: string;
    sellBalanceQuantity: string;
    sellBalanceRate: string;
  } | null;
};
export function normalizeInvestorTradingRecord(value: unknown): InvestorTradingRecord {
  const r = record(value);
  const institution = record(r.institution);
  let breakdown: InvestorTradingRecord['institution']['breakdown'] = null;
  if (institution.breakdown !== null && institution.breakdown !== undefined) {
    const b = record(institution.breakdown);
    breakdown = Object.fromEntries(
      INSTITUTION_BREAKDOWN.map((key) => [key, flow(b[key])]),
    ) as NonNullable<InvestorTradingRecord['institution']['breakdown']>;
  }
  let foreignerHolding: InvestorTradingRecord['foreignerHolding'] = null;
  if (r.foreignerHolding !== null && r.foreignerHolding !== undefined) {
    const h = record(r.foreignerHolding);
    foreignerHolding = {
      holdingQuantity: decimal(h.holdingQuantity),
      limitQuantity: decimal(h.limitQuantity),
      holdingRate: decimal(h.holdingRate),
    };
  }
  let cfd: InvestorTradingRecord['cfd'] = null;
  if (r.cfd !== null && r.cfd !== undefined) {
    const c = record(r.cfd);
    cfd = {
      buyBalanceQuantity: decimal(c.buyBalanceQuantity),
      buyBalanceRate: decimal(c.buyBalanceRate),
      sellBalanceQuantity: decimal(c.sellBalanceQuantity),
      sellBalanceRate: decimal(c.sellBalanceRate),
    };
  }
  return {
    date: dateOnly(r.date),
    updatedAt: timestamp(r.updatedAt),
    individual: nullableFlow(r.individual),
    foreigner: flow(r.foreigner),
    institution: { ...flow(institution), breakdown },
    otherCorporation: nullableFlow(r.otherCorporation),
    foreignerHolding,
    cfd,
  };
}
export type ProgramTradeRecord = { date: string; arbitrage: Flow; nonArbitrage: Flow };
export function normalizeProgramTradeRecord(value: unknown): ProgramTradeRecord {
  const r = record(value);
  return {
    date: dateOnly(r.date),
    arbitrage: flow(r.arbitrage),
    nonArbitrage: flow(r.nonArbitrage),
  };
}
export type ShortSellingRecord = {
  date: string;
  updatedAt: string;
  shortSellingVolume: string;
  shortSellingAmount: string;
  shortSellingVolumeRate: string | null;
  shortSellingAmountRate: string | null;
};
export function normalizeShortSellingRecord(value: unknown): ShortSellingRecord {
  const r = record(value);
  return {
    date: dateOnly(r.date),
    updatedAt: timestamp(r.updatedAt),
    shortSellingVolume: decimal(r.shortSellingVolume),
    shortSellingAmount: decimal(r.shortSellingAmount),
    shortSellingVolumeRate: optionalDecimal(r.shortSellingVolumeRate),
    shortSellingAmountRate: optionalDecimal(r.shortSellingAmountRate),
  };
}
export type CreditSide = {
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
export type CreditTradeRecord = {
  date: string;
  updatedAt: string;
  marginLoan: CreditSide | null;
  stockLoan: CreditSide | null;
};
export function normalizeCreditTradeRecord(value: unknown): CreditTradeRecord {
  const r = record(value);
  return {
    date: dateOnly(r.date),
    updatedAt: timestamp(r.updatedAt),
    marginLoan: creditSide(r.marginLoan),
    stockLoan: creditSide(r.stockLoan),
  };
}
export type DailyCandle = {
  timestamp: string;
  /** Local trade date: the date part of the provider timestamp (1d bars are fixed at local midnight). */
  date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
};
export type StockDailyCandle = DailyCandle & { currency: 'KRW' | 'USD' };
function dailyBar(value: unknown): DailyCandle {
  const c = record(value);
  const stamp = timestamp(c.timestamp);
  return {
    timestamp: stamp,
    date: dateOnly(stamp.slice(0, 10)),
    open: decimal(c.openPrice),
    high: decimal(c.highPrice),
    low: decimal(c.lowPrice),
    close: decimal(c.closePrice),
    volume: decimal(c.volume),
  };
}
export type CandlePage<T extends DailyCandle> = {
  /** Newest first, exactly as the provider orders them. */
  candles: T[];
  nextBefore: string | null;
};
export type PagedCandles<T extends DailyCandle> = {
  /** Newest first, de-duplicated by timestamp. */
  candles: T[];
  pages: number;
  /** EXHAUSTED and REACHED_DATE are complete; the others stopped early and say why. */
  stopReason: 'EXHAUSTED' | 'REACHED_DATE' | 'MAX_PAGES' | 'EMPTY_PAGE' | 'CURSOR_STALLED';
  complete: boolean;
};
export const MAX_CANDLE_PAGES = 20;
/** Pure paging loop (before/nextBefore) so every stop condition is testable without HTTP. */
export async function collectCandlePages<T extends DailyCandle>(
  fetchPage: (before: string | undefined) => Promise<CandlePage<T>>,
  options: { maxPages?: number; stopAtDate?: string; maxCandles?: number } = {},
): Promise<PagedCandles<T>> {
  const maxPages = Math.min(Math.max(options.maxPages ?? 5, 1), MAX_CANDLE_PAGES);
  const maxCandles = options.maxCandles ?? 5000;
  const seen = new Map<string, T>();
  let before: string | undefined;
  let pages = 0;
  const finish = (stopReason: PagedCandles<T>['stopReason']): PagedCandles<T> => ({
    candles: [...seen.values()].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)),
    pages,
    stopReason,
    complete: stopReason === 'EXHAUSTED' || stopReason === 'REACHED_DATE',
  });
  while (pages < maxPages) {
    const page = await fetchPage(before);
    pages++;
    if (page.candles.length === 0)
      return finish(page.nextBefore === null ? 'EXHAUSTED' : 'EMPTY_PAGE');
    const sizeBefore = seen.size;
    for (const candle of page.candles) seen.set(candle.timestamp, candle);
    // A page that adds nothing new means the cursor is not advancing.
    if (seen.size === sizeBefore) return finish('CURSOR_STALLED');
    if (options.stopAtDate && page.candles.some((candle) => candle.date <= options.stopAtDate!))
      return finish('REACHED_DATE');
    if (page.nextBefore === null) return finish('EXHAUSTED');
    // before is inclusive: the next cursor must be strictly older than the one just used.
    if (before !== undefined && Date.parse(page.nextBefore) >= Date.parse(before))
      return finish('CURSOR_STALLED');
    if (seen.size >= maxCandles) return finish('MAX_PAGES');
    before = page.nextBefore;
  }
  return finish('MAX_PAGES');
}
export type CandlesResult = {
  source: string;
  asOf: string;
  symbol: string;
  interval: string;
  adjusted: boolean;
  candles: {
    timestamp: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
    currency: string;
  }[];
  /** Cursor for the next (older) page; null on the last page. Pass it back as `before`. */
  nextBefore?: string | null;
};
/** ISO-8601 date-time with a zone designator, as the candles `before` cursor must be. */
export function validBefore(value: string): boolean {
  return (
    value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
export class TossClient {
  private cooldownUntil = 0;
  private reads = new Map<string, { expiresAt: number; value: unknown }>();
  private pending = new Map<string, Promise<unknown>>();
  constructor(
    private config: TossConfig,
    private tokens: TokenCache,
    private transport: typeof fetch = fetch,
  ) {
    if (
      !config.clientId ||
      !config.clientSecret ||
      !/^\d{1,15}$/.test(config.accountSeq) ||
      !config.ownerUserId
    )
      throw new Error('Invalid Toss configuration');
  }
  private async request(
    path: string,
    init: RequestInit = {},
    options: { forbiddenCode?: string } = {},
  ) {
    if (this.cooldownUntil > Date.now())
      throw new ProviderError(
        503,
        'PROVIDER_RATE_LIMITED',
        '제공자 요청 한도로 잠시 대기해야 합니다.',
        Math.ceil((this.cooldownUntil - Date.now()) / 1000),
      );
    let response: Response;
    try {
      response = await this.transport(BASE + path, {
        ...init,
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
    } catch {
      throw new ProviderError(503, 'PROVIDER_UNREACHABLE', '금융 제공자에 연결할 수 없습니다.');
    }
    if (!response.ok) {
      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        this.cooldownUntil =
          Date.now() +
          (Number.isInteger(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 60) * 1000;
        throw new ProviderError(
          503,
          'PROVIDER_RATE_LIMITED',
          '제공자 요청 한도로 잠시 대기해야 합니다.',
          Number.isInteger(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 60,
        );
      }
      if (response.status === 404)
        throw new ProviderError(
          404,
          'PROVIDER_NOT_FOUND',
          '제공자에 해당 종목 또는 지표 데이터가 없습니다.',
        );
      // Stock Info endpoints define 403 "insufficient permission" separately from bad credentials
      // or a non-allowlisted IP, so callers can record "no permission" instead of failing.
      if (response.status === 403 && options.forbiddenCode)
        throw new ProviderError(
          503,
          options.forbiddenCode,
          '토스 Open API 권한이 없는 데이터입니다. 키 권한 범위를 확인하세요.',
        );
      throw new ProviderError(
        503,
        response.status === 401 || response.status === 403
          ? 'PROVIDER_ACCESS_DENIED'
          : 'PROVIDER_UNAVAILABLE',
        '제공자 인증·허용 IP·서비스 상태를 확인하세요.',
        undefined,
        response.status === 401 || response.status === 403 ? response.status : undefined,
      );
    }
    try {
      const reader = response.body?.getReader();
      if (!reader) throw invalid();
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          throw invalid();
        }
        chunks.push(value);
      }
      return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      throw invalid();
    }
  }
  private async bearer() {
    return this.tokens.get(async () => {
      const result = await this.request('/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
      });
      if (
        typeof result.access_token !== 'string' ||
        !result.access_token ||
        result.access_token.length > 16384 ||
        result.token_type !== 'Bearer' ||
        typeof result.expires_in !== 'number' ||
        !Number.isInteger(result.expires_in) ||
        result.expires_in <= 60 ||
        result.expires_in > 604800
      )
        throw invalid();
      return { value: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };
    });
  }
  private async get(path: string, account = false, options: { forbiddenCode?: string } = {}) {
    return (
      await this.request(
        path,
        {
          headers: {
            Authorization: `Bearer ${await this.bearer()}`,
            ...(account ? { 'X-Tossinvest-Account': this.config.accountSeq } : {}),
          },
        },
        options,
      )
    ).result;
  }
  /**
   * Authenticated GET for server modules that normalize their own responses (toss-analysis.ts).
   * Returns the provider `result` payload untouched. A 403 on the data call (not on the token
   * call) means the Open API key lacks permission for that group: it is reported separately as
   * TOSS_PERMISSION_DENIED so the screen can say so instead of "service error".
   */
  async readJson(path: string): Promise<unknown> {
    const authorization = `Bearer ${await this.bearer()}`;
    try {
      return (await this.request(path, { headers: { Authorization: authorization } })).result;
    } catch (error) {
      if (error instanceof ProviderError && error.upstreamStatus === 403)
        throw new ProviderError(
          403,
          'TOSS_PERMISSION_DENIED',
          '토스 Open API 키에 이 데이터를 조회할 권한이 없습니다. 토스증권 Open API 권한 설정을 확인하세요.',
        );
      throw error;
    }
  }
  /**
   * Raw authenticated request for the order transport (src/server/trading/toss-transport.ts).
   * Unlike `request`, it returns HTTP error statuses WITH their parsed body (the order client reads
   * documented error fields such as the tick-size `data`), never retries, never touches the shared
   * rate-limit cooldown and has no cache. Fixed host, bearer + account header, timeout,
   * `redirect: 'error'` and a response-size cap. Network failures, timeouts and oversized bodies
   * throw a ProviderError whose message is a fixed text: no URL, header or body ever reaches an error
   * or a log. A failure to obtain a token also throws (nothing was sent).
   */
  async authorizedRequest(
    request: {
      method: 'GET' | 'POST';
      /** Absolute API path below `/api/v1/`; the query string is passed separately. */
      path: string;
      query?: Record<string, string>;
      body?: Record<string, unknown>;
    },
    options: { timeoutMs?: number; maxBytes?: number } = {},
  ): Promise<{ status: number; body: unknown; retryAfterSeconds: number | null }> {
    if (
      (request.method !== 'GET' && request.method !== 'POST') ||
      !/^\/api\/v1\/[A-Za-z0-9_\-./=~%]{1,200}$/.test(request.path) ||
      request.path.split('/').some((segment) => segment === '.' || segment === '..') ||
      /%(?:2e|2f|5c|00)/i.test(request.path) ||
      (request.method === 'GET' && request.body !== undefined)
    )
      throw new ProviderError(
        400,
        'INVALID_PROVIDER_REQUEST',
        '제공자 요청 형식이 올바르지 않습니다.',
      );
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 8000, 1000), 30_000);
    const maxBytes = Math.min(Math.max(options.maxBytes ?? 1024 * 1024, 1024), 4 * 1024 * 1024);
    const query = request.query ? `?${new URLSearchParams(request.query)}` : '';
    const token = await this.bearer();
    let response: Response;
    try {
      response = await this.transport(BASE + request.path + query, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Tossinvest-Account': this.config.accountSeq,
          ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch {
      throw new ProviderError(503, 'PROVIDER_UNREACHABLE', '금융 제공자에 연결할 수 없습니다.');
    }
    let text = '';
    try {
      const reader = response.body?.getReader();
      if (reader) {
        let size = 0;
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            throw invalid();
          }
          chunks.push(value);
        }
        text = Buffer.concat(chunks).toString('utf8');
      }
    } catch {
      throw new ProviderError(503, 'PROVIDER_RESPONSE_INVALID', '제공자 응답을 읽지 못했습니다.');
    }
    let body: unknown;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    const retryAfter = response.headers.get('retry-after');
    return {
      status: response.status,
      body,
      retryAfterSeconds:
        retryAfter !== null && /^\d{1,6}$/.test(retryAfter)
          ? Math.min(Number(retryAfter), 3600)
          : null,
    };
  }
  private async cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    const cached = this.reads.get(key);
    if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.value) as T;
    let pending = this.pending.get(key);
    if (!pending) {
      if (this.pending.size >= 32)
        throw new ProviderError(
          503,
          'PROVIDER_BUSY',
          '조회 요청이 많습니다. 잠시 후 시도하세요.',
          30,
        );
      pending = read()
        .then((value) => {
          if (this.reads.size >= 100) this.reads.delete(this.reads.keys().next().value!);
          this.reads.set(key, { value, expiresAt: Date.now() + 30000 });
          return value;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return structuredClone(await pending) as T;
  }
  // Setup job only: share the production bearer lease and never expose raw account data.
  async discoverBrokerageAccountSeq(): Promise<string> {
    const accounts = await this.get('/api/v1/accounts');
    if (!Array.isArray(accounts) || accounts.length > 1000) throw invalid();
    const brokerage = accounts.filter((value) => record(value).accountType === 'BROKERAGE');
    if (brokerage.length !== 1)
      throw new ProviderError(
        503,
        brokerage.length === 0
          ? 'PROVIDER_ACCOUNT_UNAVAILABLE'
          : 'PROVIDER_ACCOUNT_SELECTION_REQUIRED',
        '자동 연결할 단일 거래 계좌를 확인하지 못했습니다.',
      );
    const seq = record(brokerage[0]).accountSeq;
    // Official schema is integer/int64. Reject lossy JS numbers and unexpected strings.
    if (
      typeof seq !== 'number' ||
      !Number.isSafeInteger(seq) ||
      seq <= 0 ||
      String(seq).length > 15
    )
      throw invalid();
    return String(seq);
  }
  async portfolio(userId: string) {
    if (userId !== this.config.ownerUserId)
      throw new ProviderError(403, 'PORTFOLIO_OWNER_REQUIRED', '이 계정에 연결된 자산이 없습니다.');
    return this.cached('portfolio', async () => {
      const accounts = await this.get('/api/v1/accounts');
      if (
        !Array.isArray(accounts) ||
        !accounts.some((a) => {
          const account = record(a);
          return (
            String(account.accountSeq) === this.config.accountSeq &&
            account.accountType === 'BROKERAGE'
          );
        })
      )
        throw new ProviderError(
          503,
          'PROVIDER_ACCOUNT_UNAVAILABLE',
          '연결된 거래 계좌를 확인하세요.',
        );
      return normalizeHoldings(await this.get('/api/v1/holdings', true));
    });
  }
  async candles(symbol: string, interval: string, count: number, before?: string) {
    if (
      !/^[A-Za-z0-9.\-]{1,30}$/.test(symbol) ||
      !['1m', '1d'].includes(interval) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 200 ||
      (before !== undefined && !validBefore(before))
    )
      throw new ProviderError(400, 'INVALID_MARKET_QUERY', '종목·주기·조회 개수를 확인하세요.');
    const query = new URLSearchParams({ symbol, interval, count: String(count), adjusted: 'true' });
    // Spec: `before` is the inclusive upper bound; pass the previous page's nextBefore unchanged.
    if (before !== undefined) query.set('before', before);
    return this.cached(`candles:${query}`, async (): Promise<CandlesResult> => {
      const result = record(await this.get(`/api/v1/candles?${query}`));
      if (!Array.isArray(result.candles) || result.candles.length > 200) throw invalid();
      const candles = result.candles.map((value) => {
        const c = record(value);
        const timestamp = text(c.timestamp, 50);
        if (
          !Number.isFinite(Date.parse(timestamp)) ||
          !['KRW', 'USD'].includes(c.currency as string)
        )
          throw invalid();
        return {
          timestamp,
          open: decimal(c.openPrice),
          high: decimal(c.highPrice),
          low: decimal(c.lowPrice),
          close: decimal(c.closePrice),
          volume: decimal(c.volume),
          currency: c.currency as string,
        };
      });
      return {
        source: 'Toss Securities OpenAPI',
        asOf: new Date().toISOString(),
        symbol,
        interval,
        adjusted: true,
        candles: candles.reverse(),
        nextBefore: nullableTimestamp(result.nextBefore),
      };
    });
  }
  async prices(symbols: string[]) {
    if (
      !symbols.length ||
      symbols.length > MAX_PRICE_SYMBOLS ||
      symbols.some((symbol) => !SYMBOL.test(symbol))
    )
      throw new ProviderError(400, 'INVALID_MARKET_QUERY', '종목 코드 목록을 확인하세요.');
    const requested = parsePriceSymbols(symbols.join(','))!;
    const query = new URLSearchParams({ symbols: requested.join(',') });
    return this.cached(`prices:${query}`, async () => {
      const result = await this.get(`/api/v1/prices?${query}`);
      if (!Array.isArray(result) || result.length > requested.length) throw invalid();
      const known = new Set(requested.map((symbol) => symbol.toUpperCase()));
      const seen = new Set<string>();
      const prices = result.map((value) => {
        const p = record(value);
        const symbol = text(p.symbol, 30);
        if (
          !known.has(symbol.toUpperCase()) ||
          seen.has(symbol.toUpperCase()) ||
          !SYMBOL.test(symbol)
        )
          throw invalid();
        seen.add(symbol.toUpperCase());
        if (!['KRW', 'USD'].includes(p.currency as string)) throw invalid();
        return {
          symbol,
          lastPrice: decimal(p.lastPrice),
          currency: p.currency as 'KRW' | 'USD',
          timestamp: nullableTimestamp(p.timestamp),
        };
      });
      return { source: 'Toss Securities OpenAPI', asOf: new Date().toISOString(), prices };
    });
  }
  /** GET /api/v1/market-calendar/{KR|US}?date= (Market Info, MARKET_INFO). Times are KST ISO strings. */
  async marketCalendar(market: MarketCode, date: string): Promise<MarketCalendar> {
    if (!['KR', 'US'].includes(market) || !DATE_ONLY.test(date))
      throw new ProviderError(400, 'INVALID_MARKET_QUERY', '시장과 날짜를 확인하세요.');
    return this.cached(`market-calendar:${market}:${date}`, async () => {
      const result = record(
        await this.get(`/api/v1/market-calendar/${market}?${new URLSearchParams({ date })}`),
      );
      return {
        source: 'Toss Securities OpenAPI',
        asOf: new Date().toISOString(),
        market,
        requestedDate: date,
        previousBusinessDay: normalizeMarketDay(market, result.previousBusinessDay),
        today: normalizeMarketDay(market, result.today),
        nextBusinessDay: normalizeMarketDay(market, result.nextBusinessDay),
      };
    });
  }
  /** One page of GET /api/v1/candles (interval 1d, adjusted). Not cached; newest bar first. */
  async dailyCandlePage(
    symbol: string,
    options: { count?: number; before?: string } = {},
  ): Promise<CandlePage<StockDailyCandle>> {
    const count = options.count ?? 200;
    if (
      !SYMBOL.test(symbol) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 200 ||
      (options.before !== undefined && !Number.isFinite(Date.parse(options.before)))
    )
      throw new ProviderError(
        400,
        'INVALID_MARKET_QUERY',
        '종목·조회 개수·기준 시각을 확인하세요.',
      );
    const query = new URLSearchParams({
      symbol,
      interval: '1d',
      count: String(count),
      adjusted: 'true',
    });
    if (options.before !== undefined) query.set('before', options.before);
    const result = record(await this.get(`/api/v1/candles?${query}`));
    if (!Array.isArray(result.candles) || result.candles.length > 200) throw invalid();
    return {
      candles: result.candles.map((value) => {
        const bar = dailyBar(value);
        const currency = record(value).currency;
        if (currency !== 'KRW' && currency !== 'USD') throw invalid();
        return { ...bar, currency };
      }),
      nextBefore: nullableTimestamp(result.nextBefore),
    };
  }
  /** Daily bars across `before`/`nextBefore` pages with explicit stop conditions (max pages etc.). */
  dailyCandles(
    symbol: string,
    options: {
      maxPages?: number;
      pageSize?: number;
      stopAtDate?: string;
      maxCandles?: number;
    } = {},
  ) {
    return collectCandlePages(
      (before) => this.dailyCandlePage(symbol, { count: options.pageSize ?? 200, before }),
      options,
    );
  }
  /** One page of GET /api/v1/market-indicators/{symbol}/candles (MARKET_INDICATOR_CHART), 1d only. */
  async marketIndicatorCandlePage(
    symbol: string,
    options: { count?: number; before?: string } = {},
  ): Promise<CandlePage<DailyCandle>> {
    const count = options.count ?? 200;
    if (
      !MARKET_INDICATOR_CATALOG.some((item) => item.symbol === symbol) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 200 ||
      (options.before !== undefined && !Number.isFinite(Date.parse(options.before)))
    )
      throw new ProviderError(
        400,
        'INVALID_MARKET_QUERY',
        '지표·조회 개수·기준 시각을 확인하세요.',
      );
    const query = new URLSearchParams({ interval: '1d', count: String(count) });
    if (options.before !== undefined) query.set('before', options.before);
    const result = record(await this.get(`/api/v1/market-indicators/${symbol}/candles?${query}`));
    if (!Array.isArray(result.candles) || result.candles.length > 200) throw invalid();
    return {
      candles: result.candles.map(dailyBar),
      nextBefore: nullableTimestamp(result.nextBefore),
    };
  }
  marketIndicatorDailyCandles(
    symbol: string,
    options: {
      maxPages?: number;
      pageSize?: number;
      stopAtDate?: string;
      maxCandles?: number;
    } = {},
  ) {
    return collectCandlePages(
      (before) =>
        this.marketIndicatorCandlePage(symbol, { count: options.pageSize ?? 200, before }),
      options,
    );
  }
  // KR supply/demand series (Stock Info, STOCK_TRADING_TREND). 403 means "no permission".
  private async tradingSeries<T extends { date: string }>(
    path: 'investor-trading' | 'program-trades' | 'short-selling' | 'credit-trades',
    symbol: string,
    options: { count?: number; until?: string },
    normalize: (value: unknown) => T,
  ) {
    const count = options.count ?? 5;
    if (
      !KR_SYMBOL.test(symbol) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 100 ||
      (options.until !== undefined && !DATE_ONLY.test(options.until))
    )
      throw new ProviderError(
        400,
        'INVALID_MARKET_QUERY',
        '국내 종목 코드·조회 수·기준일을 확인하세요.',
      );
    const query = new URLSearchParams({ count: String(count) });
    if (options.until !== undefined) query.set('until', options.until);
    const result = record(
      await this.get(`/api/v1/stocks/${symbol}/${path}?${query}`, false, {
        forbiddenCode: PROVIDER_FORBIDDEN,
      }),
    );
    if (!Array.isArray(result.records) || result.records.length > 100) throw invalid();
    const records = result.records.map(normalize);
    return {
      source: 'Toss Securities OpenAPI',
      asOf: new Date().toISOString(),
      symbol,
      /** Newest first. */
      records,
      nextUntil:
        result.nextUntil === null || result.nextUntil === undefined
          ? null
          : dateOnly(result.nextUntil),
    };
  }
  investorTrading(symbol: string, options: { count?: number; until?: string } = {}) {
    return this.tradingSeries('investor-trading', symbol, options, normalizeInvestorTradingRecord);
  }
  programTrades(symbol: string, options: { count?: number; until?: string } = {}) {
    return this.tradingSeries('program-trades', symbol, options, normalizeProgramTradeRecord);
  }
  shortSelling(symbol: string, options: { count?: number; until?: string } = {}) {
    return this.tradingSeries('short-selling', symbol, options, normalizeShortSellingRecord);
  }
  creditTrades(symbol: string, options: { count?: number; until?: string } = {}) {
    return this.tradingSeries('credit-trades', symbol, options, normalizeCreditTradeRecord);
  }
  async marketIndicators() {
    const query = new URLSearchParams({
      symbols: MARKET_INDICATOR_CATALOG.map((item) => item.symbol).join(','),
    });
    return this.cached('market-indicators', async () => {
      const [prices, fx] = await Promise.all([
        this.get(`/api/v1/market-indicators/prices?${query}`),
        this.get(
          `/api/v1/exchange-rate?${new URLSearchParams({ baseCurrency: 'USD', quoteCurrency: 'KRW' })}`,
        ),
      ]);
      if (!Array.isArray(prices) || prices.length > MARKET_INDICATOR_CATALOG.length)
        throw invalid();
      const seen = new Set<string>();
      const indicators = prices.map((value) => {
        const p = record(value);
        const item = MARKET_INDICATOR_CATALOG.find((entry) => entry.symbol === p.symbol);
        if (!item || seen.has(item.symbol)) throw invalid();
        seen.add(item.symbol);
        return {
          ...item,
          lastPrice: decimal(p.lastPrice),
          timestamp: nullableTimestamp(p.timestamp),
        };
      });
      const rate = record(fx);
      if (rate.baseCurrency !== 'USD' || rate.quoteCurrency !== 'KRW') throw invalid();
      return {
        source: 'Toss Securities OpenAPI',
        asOf: new Date().toISOString(),
        indicators,
        exchangeRate: {
          baseCurrency: 'USD' as const,
          quoteCurrency: 'KRW' as const,
          midRate: decimal(rate.midRate),
          rate: decimal(rate.rate),
          rateChangeType: ['UP', 'EQUAL', 'DOWN'].includes(rate.rateChangeType as string)
            ? (rate.rateChangeType as 'UP' | 'EQUAL' | 'DOWN')
            : null,
          validFrom: timestamp(rate.validFrom),
          validUntil: timestamp(rate.validUntil),
        },
      };
    });
  }
}
export function tossFromEnvironment(production: boolean) {
  const {
    TOSS_CLIENT_ID: clientId,
    TOSS_CLIENT_SECRET: clientSecret,
    TOSS_ACCOUNT_SEQ: accountSeq,
    TOSS_OWNER_USER_ID: ownerUserId,
  } = process.env;
  if (!clientId || !clientSecret || !accountSeq || !ownerUserId) return undefined;
  return new TossClient(
    { clientId, clientSecret, accountSeq, ownerUserId },
    production ? new FirestoreTokenCache(clientId) : new MemoryTokenCache(),
  );
}
