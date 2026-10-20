import { createHash } from 'node:crypto';

/**
 * Toss order client (plan stage 7d). UNWIRED: nothing in app/job code imports this module.
 *
 * Contract: official Toss Securities Open API spec v1.2.24, read 2026-10-21
 * (https://openapi.tossinvest.com/openapi-docs/latest/openapi.json). Only these operations are
 * used: POST /api/v1/orders (quantity-based LIMIT + DAY only), GET /api/v1/orders,
 * GET /api/v1/orders/{orderId}, POST /api/v1/orders/{orderId}/cancel, GET /api/v1/buying-power,
 * GET /api/v1/sellable-quantity, GET /api/v1/commissions, GET /api/v1/stocks/{symbol}/warnings,
 * GET /api/v1/price-limits. See docs/implementation/trading.md for the recorded facts.
 *
 * The client never sees credentials: authentication, the account header, timeouts, redirects and
 * response-size limits belong to the injected `OrderTransport`.
 */

export type TradeMarket = 'KR' | 'US';
export type TradeSide = 'buy' | 'sell';
export type TradeCurrency = 'KRW' | 'USD';

// ---------------------------------------------------------------------------
// Transport port (the supervisor satisfies it from TossClient later).
// ---------------------------------------------------------------------------
export type TransportRequest = {
  method: 'GET' | 'POST';
  /** Absolute API path such as `/api/v1/orders`; never includes a query string. */
  path: string;
  query?: Record<string, string>;
  /** JSON body for POST. */
  body?: Record<string, unknown>;
};
export type TransportResponse = {
  status: number;
  /** Parsed JSON body, or undefined when the body was not valid JSON / empty. */
  body: unknown;
  /** Parsed `Retry-After` header in seconds, when present and valid. */
  retryAfterSeconds?: number | null;
};
/**
 * Contract for implementations: attach the bearer token and `X-Tossinvest-Account`; use a
 * timeout, `redirect: 'error'` and a response-size cap; return HTTP error statuses as responses
 * (do not throw); throw `TransportNetworkError` when no response was received; NEVER retry (the
 * order client owns retry/idempotency); never log bodies or headers.
 */
export interface OrderTransport {
  send(request: TransportRequest): Promise<TransportResponse>;
}
/** No HTTP response was received (connection failure, timeout). The outcome is unknown. */
export class TransportNetworkError extends Error {
  constructor() {
    super('network');
    this.name = 'TransportNetworkError';
  }
}

// ---------------------------------------------------------------------------
// Sanitized errors: only a status, a validated kebab-case code and a request id. Never provider
// message text, response bodies, error `data`, account identifiers or credentials.
// ---------------------------------------------------------------------------
export type OrderErrorInfo = {
  kind: 'network' | 'http' | 'schema';
  status: number | null;
  /** Provider error code (validated `[a-z0-9-]`) or a local code such as `network-error`. */
  code: string;
  requestId?: string;
  retryAfterSeconds?: number;
};
export class OrderApiError extends Error {
  constructor(public readonly info: OrderErrorInfo) {
    super(info.code); // The message is only the code.
    this.name = 'OrderApiError';
  }
}
/** Programmer error: the caller built an order that must never be sent. */
export class OrderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderInputError';
  }
}

const CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

function errorInfoFromResponse(response: TransportResponse): OrderErrorInfo {
  const body = response.body;
  const error =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).error
      : undefined;
  const fields =
    error && typeof error === 'object' && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : {};
  const code =
    typeof fields.code === 'string' && CODE.test(fields.code)
      ? fields.code
      : `http-${response.status}`;
  const requestId =
    typeof fields.requestId === 'string' && REQUEST_ID.test(fields.requestId)
      ? fields.requestId
      : undefined;
  const retry = response.retryAfterSeconds;
  return {
    kind: 'http',
    status: response.status,
    code,
    ...(requestId ? { requestId } : {}),
    ...(typeof retry === 'number' && Number.isInteger(retry) && retry >= 0
      ? { retryAfterSeconds: Math.min(retry, 3600) }
      : {}),
  };
}
const networkError = (): OrderErrorInfo => ({
  kind: 'network',
  status: null,
  code: 'network-error',
});
const schemaError = (status: number | null = null): OrderErrorInfo => ({
  kind: 'schema',
  status,
  code: 'response-invalid',
});

/** Korean display text per provider code. Unknown codes get a neutral sentence. */
const ERROR_MESSAGES: Record<string, string> = {
  'invalid-request': '주문 요청 형식이 증권사 규칙에 맞지 않습니다.',
  'confirm-high-value-required': '1억 원 이상 주문은 낼 수 없습니다.',
  'account-header-required': '계좌 설정을 확인하세요.',
  'invalid-token': '증권사 인증이 유효하지 않습니다.',
  'expired-token': '증권사 인증이 만료되었습니다.',
  'token-revoked': '증권사 인증이 무효화되었습니다.',
  'login-user-not-found': '증권사 로그인 정보를 찾을 수 없습니다.',
  forbidden: '증권사가 이 API 접근 권한을 허용하지 않았습니다.',
  'request-in-progress': '같은 주문 요청이 처리 중입니다. 결과를 확인해야 합니다.',
  'opposite-pending-order-exists': '같은 종목에 반대 방향 미체결 주문이 있습니다.',
  'insufficient-buying-power': '주문 가능 금액이 부족합니다.',
  'order-hours-closed': '지금은 주문을 접수할 수 없는 시간입니다.',
  'stock-restricted': '해당 종목은 주문이 제한되어 있습니다.',
  'price-out-of-range': '주문 가격이 허용 범위를 벗어났습니다.',
  'order-type-not-allowed': '현재 사용할 수 없는 호가 유형입니다.',
  'prerequisite-required': '주문 전 필요한 사전 자격 요건이 충족되지 않았습니다.',
  'market-not-supported-for-stock': '해당 종목은 이 시장에서 거래할 수 없습니다.',
  'investor-exchange-not-integrated': '투자자지시 거래소 설정이 통합(SOR)이 아닙니다.',
  'account-restricted': '계좌 상태가 주문을 허용하지 않습니다.',
  'max-order-amount-exceeded': '최대 주문 가능 금액을 넘었습니다.',
  'idempotency-key-conflict':
    '같은 주문 키로 다른 내용의 요청이 있었습니다. 결과를 확인해야 합니다.',
  'rate-limit-exceeded': '증권사 요청 한도를 넘었습니다.',
  'internal-error': '증권사 처리 중 일시적 오류가 있었습니다.',
  maintenance: '증권사가 점검 중입니다.',
  'network-error': '증권사에 연결하지 못했습니다. 주문이 접수되었는지 확인해야 합니다.',
  'response-invalid': '증권사 응답 형식을 확인하지 못했습니다.',
  'tick-correction-declined': '호가 단위 보정을 적용하지 않아 주문하지 않았습니다.',
  'tick-correction-unavailable': '호가 단위 정보를 확인하지 못해 주문하지 않았습니다.',
  'already-filled': '이미 체결된 주문입니다.',
  'already-canceled': '이미 취소된 주문입니다.',
  'order-not-found': '주문을 찾을 수 없습니다.',
  'stock-not-found': '종목을 찾을 수 없습니다.',
  'account-not-found': '계좌를 찾을 수 없습니다.',
};
export function describeOrderError(info: OrderErrorInfo): string {
  return (
    ERROR_MESSAGES[info.code] ??
    (info.status === null
      ? '주문 요청에 실패했습니다.'
      : `증권사 요청이 거부되었습니다. (HTTP ${info.status})`)
  );
}

/**
 * Codes meaning "an earlier request with this key may exist". These come back as 4xx but must
 * never be treated as a definitive rejection.
 */
const AMBIGUOUS_CODES: ReadonlySet<string> = new Set([
  'request-in-progress',
  'idempotency-key-conflict',
]);

/** True when a 401/403 on the orders endpoint points at missing credentials or permission. */
export function isPermissionError(info: OrderErrorInfo) {
  return info.kind === 'http' && (info.status === 401 || info.status === 403);
}

// ---------------------------------------------------------------------------
// Validation helpers (strict: a malformed response never passes).
// ---------------------------------------------------------------------------
function record(value: unknown, status: number | null = null): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OrderApiError(schemaError(status));
  return value as Record<string, unknown>;
}
function bad(): never {
  throw new OrderApiError(schemaError());
}
const DECIMAL = /^\d+(\.\d+)?$/;
function decimal(value: unknown): string {
  if (typeof value !== 'string' || value.length > 30 || !DECIMAL.test(value)) bad();
  return value as string;
}
function nullableDecimal(value: unknown): string | null {
  return value === null || value === undefined ? null : decimal(value);
}
function nullableTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) bad();
  return value as string;
}
function timestamp(value: unknown): string {
  const result = nullableTimestamp(value);
  if (result === null) bad();
  return result as string;
}
function shortText(value: unknown, max = 64): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) bad();
  return value as string;
}
const ORDER_ID = /^[A-Za-z0-9_\-=.~]{1,256}$/;
const SYMBOL = /^[A-Za-z0-9.\-]{1,30}$/;
function orderIdText(value: unknown): string {
  if (typeof value !== 'string' || !ORDER_ID.test(value)) bad();
  return value as string;
}

export type TossOrder = {
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell' | 'unknown';
  orderType: string;
  timeInForce: string;
  /** Provider status string; unknown values are kept (the spec says clients must tolerate them). */
  status: string;
  price: string | null;
  quantity: string;
  currency: string;
  orderedAt: string;
  filledQuantity: string;
  averageFilledPrice: string | null;
  commission: string | null;
  tax: string | null;
  filledAt: string | null;
};
export type OrderPage = { orders: TossOrder[]; nextCursor: string | null; hasNext: boolean };

function parseOrder(value: unknown): TossOrder {
  const o = record(value);
  const execution = record(o.execution);
  const side = o.side === 'BUY' ? 'buy' : o.side === 'SELL' ? 'sell' : 'unknown';
  if (typeof o.side !== 'string') bad();
  return {
    orderId: orderIdText(o.orderId),
    symbol: ((s) => {
      if (!SYMBOL.test(s)) bad();
      return s;
    })(shortText(o.symbol, 30)),
    side,
    orderType: shortText(o.orderType, 16),
    timeInForce: shortText(o.timeInForce, 16),
    status: shortText(o.status, 32),
    price: nullableDecimal(o.price),
    quantity: decimal(o.quantity),
    currency: shortText(o.currency, 8),
    orderedAt: timestamp(o.orderedAt),
    filledQuantity: decimal(execution.filledQuantity),
    averageFilledPrice: nullableDecimal(execution.averageFilledPrice),
    commission: nullableDecimal(execution.commission),
    tax: nullableDecimal(execution.tax),
    filledAt: nullableTimestamp(execution.filledAt),
  };
}

export type BuyingPower = { currency: TradeCurrency; cashBuyingPower: string };
export type Commission = {
  marketCountry: TradeMarket;
  commissionRate: string;
  startDate: string | null;
  endDate: string | null;
};
export type StockWarning = {
  /** Provider code; unknown codes are kept and treated as blocking by the pre-trade check. */
  warningType: string;
  exchange: string | null;
  startDate: string | null;
  endDate: string | null;
};
export type PriceLimits = {
  timestamp: string;
  upperLimitPrice: string | null;
  lowerLimitPrice: string | null;
  currency: TradeCurrency;
};

function currency(value: unknown): TradeCurrency {
  if (value !== 'KRW' && value !== 'USD') bad();
  return value as TradeCurrency;
}
function nullableDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) bad();
  return value as string;
}

// ---------------------------------------------------------------------------
// Deterministic identifiers and prices.
// ---------------------------------------------------------------------------
export type ClientOrderIdParts = {
  algorithmId: string;
  runId: string;
  symbol: string;
  side: TradeSide;
  /** Sell tranche index (0 for the first or only order). */
  tranche: number;
};
/**
 * Deterministic per (algorithm, run, symbol, side, tranche): the same inputs always give the same
 * id, so a retry — even after a restart with the same run id — reuses it. 31 characters of
 * `[a-z0-9-]` (limit: 36, `[a-zA-Z0-9\-_]`).
 */
export function deriveClientOrderId(parts: ClientOrderIdParts): string {
  if (!Number.isInteger(parts.tranche) || parts.tranche < 0)
    throw new OrderInputError('tranche must be a non-negative integer');
  const canonical = JSON.stringify([
    'v1',
    parts.algorithmId,
    parts.runId,
    parts.symbol,
    parts.side,
    parts.tranche,
  ]);
  return `ai-${createHash('sha256').update(canonical).digest('hex').slice(0, 28)}`;
}
/**
 * The id for the single price-corrected resend after a tick-size rejection. The first request
 * was refused with 400, so nothing exists under the base id; whether the provider keeps the key
 * bound to the rejected body is not documented, hence a separate key (not a different body under
 * the same key).
 */
export const correctedClientOrderId = (base: string) => `${base}-t1`;

const KR_SYMBOL = /^[0-9A-Z]{6}$/;
const US_SYMBOL = /^[A-Z][A-Z0-9.\-]{0,14}$/;
export function validSymbolFor(market: TradeMarket, symbol: unknown): symbol is string {
  return typeof symbol === 'string' && (market === 'KR' ? KR_SYMBOL : US_SYMBOL).test(symbol);
}

function stripZeros(frac: string) {
  return frac.replace(/0+$/, '');
}
/**
 * Rounds a price to the documented price scale, always toward the LESS aggressive side (buy
 * down, sell up): KR integer won; US 4 decimals below $1 and 2 decimals from $1. Returns null for
 * anything that is not a positive finite price. KR tick size (hoga) is NOT applied here: the KRX
 * table is not in the Toss spec, so ticks are learned from the 400 response (see placeOrder).
 */
export function normalizeLimitPrice(
  market: TradeMarket,
  side: TradeSide,
  price: number | string,
): string | null {
  let text: string;
  if (typeof price === 'number') {
    if (!Number.isFinite(price) || price <= 0) return null;
    text = String(price);
    if (/e/i.test(text)) return null;
  } else text = price;
  if (!DECIMAL.test(text) || text.length > 30) return null;
  const [intPart, fracPart = ''] = text.split('.');
  const scale = market === 'KR' ? 0 : Number(intPart) >= 1 ? 2 : 4;
  const padded = (fracPart + '0'.repeat(scale)).slice(0, scale);
  const dropped = fracPart.slice(scale);
  let units = BigInt(intPart + padded);
  if (side === 'sell' && /[1-9]/.test(dropped)) units += 1n;
  if (units <= 0n) return null;
  const digits = units.toString().padStart(scale + 1, '0');
  const integer = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? '' : stripZeros(digits.slice(-scale));
  return fraction ? `${integer}.${fraction}` : integer;
}

/**
 * Reads the documented tick-size 400: `error.data = {field: 'price', tickSize, nearestPrices:
 * [lower, upper]}`. Returns the nearest price on the LESS aggressive side (buy -> lower,
 * sell -> upper), or null when the data is missing or inconsistent with the sent price.
 */
export function tickCorrection(
  market: TradeMarket,
  side: TradeSide,
  sentPrice: string,
  body: unknown,
): string | null {
  if (market !== 'KR') return null; // US has no tick table in the spec; the scale rule is applied up front.
  const error =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).error
      : undefined;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const e = error as Record<string, unknown>;
  if (e.code !== 'invalid-request') return null;
  const data = e.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const integer = /^[1-9]\d{0,14}$/;
  if (d.field !== 'price' || typeof d.tickSize !== 'string' || !integer.test(d.tickSize))
    return null;
  const near = d.nearestPrices;
  if (
    !Array.isArray(near) ||
    near.length !== 2 ||
    typeof near[0] !== 'string' ||
    typeof near[1] !== 'string' ||
    !integer.test(near[0]) ||
    !integer.test(near[1]) ||
    !integer.test(sentPrice)
  )
    return null;
  const lower = BigInt(near[0]);
  const upper = BigInt(near[1]);
  const sent = BigInt(sentPrice);
  if (!(lower < sent && sent < upper) || upper - lower > BigInt(d.tickSize)) return null;
  return (side === 'buy' ? lower : upper).toString();
}

// ---------------------------------------------------------------------------
// Client.
// ---------------------------------------------------------------------------
export type PlaceOrderRequest = {
  clientOrderId: string;
  market: TradeMarket;
  symbol: string;
  side: TradeSide;
  /** Integer shares >= 1. */
  quantity: number;
  /** Decimal string already in the documented price scale (see `normalizeLimitPrice`). */
  price: string;
};
export type PlaceOrderResult =
  | {
      outcome: 'accepted';
      orderId: string;
      /** The key actually sent on the wire (differs from the request only after a tick fix). */
      clientOrderId: string;
      price: string;
      tickCorrected: boolean;
      attempts: number;
    }
  | {
      /** Definitive refusal: no order exists under the keys used. */
      outcome: 'rejected';
      error: OrderErrorInfo;
      clientOrderId: string;
      price: string;
      tickCorrected: boolean;
      attempts: number;
    }
  | {
      /** The order may or may not exist. It must be reconciled before anything else is placed. */
      outcome: 'unknown';
      error: OrderErrorInfo;
      clientOrderId: string;
      price: string;
      tickCorrected: boolean;
      attempts: number;
    };

export type PlaceOrderOptions = {
  /**
   * Veto for the single tick-size correction. Called with the corrected price; the resend only
   * happens when it resolves true. Without it a tick-size rejection is final.
   */
  onPriceCorrection?: (correctedPrice: string) => boolean | Promise<boolean>;
};

export type OrderClientOptions = {
  /** Retries after the first attempt (network error / 5xx / 429 only). Hard cap 2. */
  maxRetries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** Provider idempotency window is 10 minutes; stop retrying a minute before it. */
export const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;
export const RETRY_CUTOFF_MS = 9 * 60 * 1000;
export const MAX_RETRIES = 2;

export interface TossOrderReads {
  listOrders(query: {
    status: 'OPEN' | 'CLOSED';
    symbol?: string;
    limit?: number;
    cursor?: string;
  }): Promise<OrderPage>;
  getOrder(orderId: string): Promise<TossOrder>;
  getBuyingPower(currency: TradeCurrency): Promise<BuyingPower>;
  getSellableQuantity(symbol: string): Promise<{ sellableQuantity: string }>;
  getCommissions(): Promise<Commission[]>;
  getStockWarnings(symbol: string): Promise<StockWarning[]>;
  getPriceLimits(symbol: string): Promise<PriceLimits>;
}
export interface TossOrderWrites {
  placeOrder(request: PlaceOrderRequest, options?: PlaceOrderOptions): Promise<PlaceOrderResult>;
  cancelOrder(orderId: string): Promise<{ orderId: string }>;
}

export class TossOrderClient implements TossOrderReads, TossOrderWrites {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  constructor(
    private readonly transport: OrderTransport,
    options: OrderClientOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = Math.max(0, Math.min(options.maxRetries ?? MAX_RETRIES, MAX_RETRIES));
  }

  // -- reads ---------------------------------------------------------------
  private async read(request: TransportRequest): Promise<unknown> {
    let response: TransportResponse;
    try {
      response = await this.transport.send(request);
    } catch {
      throw new OrderApiError(networkError());
    }
    if (!response || typeof response.status !== 'number' || !Number.isInteger(response.status))
      throw new OrderApiError(schemaError());
    if (response.status !== 200) throw new OrderApiError(errorInfoFromResponse(response));
    const body = record(response.body, 200);
    if (!('result' in body)) throw new OrderApiError(schemaError(200));
    return body.result;
  }

  async listOrders(query: {
    status: 'OPEN' | 'CLOSED';
    symbol?: string;
    limit?: number;
    cursor?: string;
  }): Promise<OrderPage> {
    if (query.status !== 'OPEN' && query.status !== 'CLOSED')
      throw new OrderInputError('status must be OPEN or CLOSED');
    const params: Record<string, string> = { status: query.status };
    if (query.symbol !== undefined) params.symbol = this.symbolParam(query.symbol);
    if (query.status === 'CLOSED') {
      if (query.limit !== undefined) {
        if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)
          throw new OrderInputError('limit must be 1..100');
        params.limit = String(query.limit);
      }
      if (query.cursor !== undefined) {
        if (!/^[A-Za-z0-9_\-=.~]{1,512}$/.test(query.cursor))
          throw new OrderInputError('cursor is malformed');
        params.cursor = query.cursor;
      }
    }
    const result = record(
      await this.read({ method: 'GET', path: '/api/v1/orders', query: params }),
    );
    if (!Array.isArray(result.orders) || result.orders.length > 5000) bad();
    const orders = (result.orders as unknown[]).map(parseOrder);
    if (typeof result.hasNext !== 'boolean') bad();
    const nextCursor =
      result.nextCursor === null || result.nextCursor === undefined
        ? null
        : shortText(result.nextCursor, 512);
    // Spec: OPEN returns everything with hasNext always false. Anything else is not trustworthy.
    if (query.status === 'OPEN' && (result.hasNext !== false || nextCursor !== null)) bad();
    return { orders, nextCursor, hasNext: result.hasNext as boolean };
  }

  async getOrder(orderId: string): Promise<TossOrder> {
    const result = await this.read({
      method: 'GET',
      path: `/api/v1/orders/${this.orderIdParam(orderId)}`,
    });
    return parseOrder(result);
  }

  async getBuyingPower(cur: TradeCurrency): Promise<BuyingPower> {
    if (cur !== 'KRW' && cur !== 'USD') throw new OrderInputError('currency must be KRW or USD');
    const result = record(
      await this.read({ method: 'GET', path: '/api/v1/buying-power', query: { currency: cur } }),
    );
    if (currency(result.currency) !== cur) bad();
    return { currency: cur, cashBuyingPower: decimal(result.cashBuyingPower) };
  }

  async getSellableQuantity(symbol: string): Promise<{ sellableQuantity: string }> {
    const result = record(
      await this.read({
        method: 'GET',
        path: '/api/v1/sellable-quantity',
        query: { symbol: this.symbolParam(symbol) },
      }),
    );
    return { sellableQuantity: decimal(result.sellableQuantity) };
  }

  async getCommissions(): Promise<Commission[]> {
    const result = await this.read({ method: 'GET', path: '/api/v1/commissions' });
    if (!Array.isArray(result) || result.length > 20) bad();
    return (result as unknown[]).map((value) => {
      const c = record(value);
      if (c.marketCountry !== 'KR' && c.marketCountry !== 'US') bad();
      return {
        marketCountry: c.marketCountry as TradeMarket,
        commissionRate: decimal(c.commissionRate),
        startDate: nullableDate(c.startDate),
        endDate: nullableDate(c.endDate),
      };
    });
  }

  async getStockWarnings(symbol: string): Promise<StockWarning[]> {
    const result = await this.read({
      method: 'GET',
      path: `/api/v1/stocks/${this.symbolParam(symbol)}/warnings`,
    });
    if (!Array.isArray(result) || result.length > 100) bad();
    return (result as unknown[]).map((value) => {
      const w = record(value);
      return {
        warningType: shortText(w.warningType, 64),
        exchange:
          w.exchange === null || w.exchange === undefined ? null : shortText(w.exchange, 16),
        startDate: nullableDate(w.startDate),
        endDate: nullableDate(w.endDate),
      };
    });
  }

  async getPriceLimits(symbol: string): Promise<PriceLimits> {
    const result = record(
      await this.read({
        method: 'GET',
        path: '/api/v1/price-limits',
        query: { symbol: this.symbolParam(symbol) },
      }),
    );
    return {
      timestamp: timestamp(result.timestamp),
      upperLimitPrice: nullableDecimal(result.upperLimitPrice),
      lowerLimitPrice: nullableDecimal(result.lowerLimitPrice),
      currency: currency(result.currency),
    };
  }

  private symbolParam(symbol: string) {
    if (typeof symbol !== 'string' || !SYMBOL.test(symbol))
      throw new OrderInputError('symbol is malformed');
    return symbol;
  }
  private orderIdParam(orderId: string) {
    if (typeof orderId !== 'string' || !ORDER_ID.test(orderId))
      throw new OrderInputError('orderId is malformed');
    return encodeURIComponent(orderId);
  }

  // -- cancel (no automatic retry: callers decide) ---------------------------
  async cancelOrder(orderId: string): Promise<{ orderId: string }> {
    const result = record(
      await this.read({
        method: 'POST',
        path: `/api/v1/orders/${this.orderIdParam(orderId)}/cancel`,
      }),
    );
    return { orderId: orderIdText(result.orderId) };
  }

  // -- create ----------------------------------------------------------------
  /**
   * Places ONE LIMIT + DAY, quantity-based order. Never throws for provider outcomes: the result
   * is `accepted`, `rejected` (definitive) or `unknown` (may exist). Throws OrderInputError only
   * when the request itself is malformed (nothing is sent).
   */
  async placeOrder(
    request: PlaceOrderRequest,
    options: PlaceOrderOptions = {},
  ): Promise<PlaceOrderResult> {
    this.validateRequest(request);
    let wire = { clientOrderId: request.clientOrderId, price: request.price };
    let tickCorrected = false;
    let attempts = 0;
    for (;;) {
      const sent = await this.sendWithRetries(request, wire);
      attempts += sent.attempts;
      const base = {
        clientOrderId: wire.clientOrderId,
        price: wire.price,
        tickCorrected,
        attempts,
      };
      if (sent.kind === 'accepted') return { outcome: 'accepted', orderId: sent.orderId, ...base };
      if (sent.kind === 'unknown') return { outcome: 'unknown', error: sent.error, ...base };
      // Definitive refusal. A tick-size 400 may be corrected exactly once.
      if (sent.error.status === 400 && !tickCorrected) {
        const corrected = tickCorrection(request.market, request.side, wire.price, sent.body);
        if (corrected === null)
          return {
            outcome: 'rejected',
            error:
              sent.error.code === 'invalid-request' && this.looksLikeTick(sent.body)
                ? { ...sent.error, code: 'tick-correction-unavailable' }
                : sent.error,
            ...base,
          };
        let allowed = false;
        try {
          allowed = (await options.onPriceCorrection?.(corrected)) === true;
        } catch {
          allowed = false;
        }
        if (!allowed)
          return {
            outcome: 'rejected',
            error: { ...sent.error, code: 'tick-correction-declined' },
            ...base,
          };
        wire = { clientOrderId: correctedClientOrderId(request.clientOrderId), price: corrected };
        tickCorrected = true;
        continue;
      }
      return { outcome: 'rejected', error: sent.error, ...base };
    }
  }

  private looksLikeTick(body: unknown) {
    const e =
      body && typeof body === 'object' ? (body as Record<string, unknown>).error : undefined;
    const d = e && typeof e === 'object' ? (e as Record<string, unknown>).data : undefined;
    return (
      !!d &&
      typeof d === 'object' &&
      (d as Record<string, unknown>).field === 'price' &&
      'tickSize' in (d as Record<string, unknown>)
    );
  }

  private validateRequest(r: PlaceOrderRequest) {
    if (!r || typeof r !== 'object') throw new OrderInputError('request required');
    if (r.market !== 'KR' && r.market !== 'US') throw new OrderInputError('market must be KR/US');
    if (r.side !== 'buy' && r.side !== 'sell') throw new OrderInputError('side must be buy/sell');
    if (typeof r.clientOrderId !== 'string' || !/^[a-zA-Z0-9\-_]{1,36}$/.test(r.clientOrderId))
      throw new OrderInputError('clientOrderId is required and must match [a-zA-Z0-9-_]{1,36}');
    if (!validSymbolFor(r.market, r.symbol)) throw new OrderInputError('symbol is malformed');
    if (!Number.isSafeInteger(r.quantity) || r.quantity < 1 || r.quantity > 999_999_999_999)
      throw new OrderInputError('quantity must be a positive integer');
    if (typeof r.price !== 'string' || normalizeLimitPrice(r.market, r.side, r.price) !== r.price)
      throw new OrderInputError('price must be a positive decimal in the documented price scale');
  }

  private body(r: PlaceOrderRequest, wire: { clientOrderId: string; price: string }) {
    // The complete, fixed field set. No amount-based fields, no market orders, no other
    // time-in-force values, no high-value confirmation flag.
    return {
      clientOrderId: wire.clientOrderId,
      symbol: r.symbol,
      side: r.side === 'buy' ? 'BUY' : 'SELL',
      orderType: 'LIMIT',
      timeInForce: 'DAY',
      quantity: String(r.quantity),
      price: wire.price,
    };
  }

  private async sendWithRetries(
    r: PlaceOrderRequest,
    wire: { clientOrderId: string; price: string },
  ): Promise<
    | { kind: 'accepted'; orderId: string; attempts: number }
    | { kind: 'unknown'; error: OrderErrorInfo; attempts: number }
    | { kind: 'refused'; error: OrderErrorInfo; body: unknown; attempts: number }
  > {
    const startedAt = this.now();
    let maybeCreated = false;
    let last: OrderErrorInfo = networkError();
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      let response: TransportResponse | undefined;
      try {
        response = await this.transport.send({
          method: 'POST',
          path: '/api/v1/orders',
          body: this.body(r, wire),
        });
      } catch {
        response = undefined;
      }
      let retryDelayMs: number | null = null;
      if (response === undefined) {
        maybeCreated = true;
        last = networkError();
        retryDelayMs = this.backoff(attempt, undefined);
      } else if (typeof response.status !== 'number' || !Number.isInteger(response.status)) {
        return { kind: 'unknown', error: schemaError(), attempts: attempt };
      } else if (response.status === 200) {
        const id = this.acceptedOrderId(response.body, wire.clientOrderId);
        if (id === null) return { kind: 'unknown', error: schemaError(200), attempts: attempt };
        return { kind: 'accepted', orderId: id, attempts: attempt };
      } else if (response.status === 429 || response.status >= 500) {
        const info = errorInfoFromResponse(response);
        last = info;
        if (response.status >= 500) maybeCreated = true;
        retryDelayMs = this.backoff(attempt, info.retryAfterSeconds);
      } else if (response.status >= 400 && response.status < 500) {
        const info = errorInfoFromResponse(response);
        // Never retried. Some 4xx codes mean the earlier request with this key may exist.
        if (AMBIGUOUS_CODES.has(info.code))
          return { kind: 'unknown', error: info, attempts: attempt };
        return { kind: 'refused', error: info, body: response.body, attempts: attempt };
      } else {
        // 1xx/2xx other than 200/3xx: not part of the documented contract.
        return { kind: 'unknown', error: schemaError(response.status), attempts: attempt };
      }
      const elapsed = this.now() - startedAt;
      if (
        attempt > this.maxRetries ||
        retryDelayMs === null ||
        elapsed + retryDelayMs >= RETRY_CUTOFF_MS
      ) {
        // Exhausted. Only a pure 429 history proves nothing was created.
        return !maybeCreated && last.status === 429
          ? { kind: 'refused', error: last, body: undefined, attempts: attempt }
          : { kind: 'unknown', error: last, attempts: attempt };
      }
      await this.sleep(retryDelayMs);
    }
    return { kind: 'unknown', error: last, attempts: this.maxRetries + 1 };
  }

  private backoff(attempt: number, retryAfterSeconds: number | undefined): number | null {
    if (retryAfterSeconds !== undefined) return Math.min(Math.max(retryAfterSeconds, 0), 30) * 1000;
    return 500 * 2 ** (attempt - 1);
  }

  private acceptedOrderId(body: unknown, sentClientOrderId: string): string | null {
    try {
      const result = record(record(body).result);
      const orderId = orderIdText(result.orderId);
      // The provider echoes the key; a different echo is not our order.
      if (result.clientOrderId !== sentClientOrderId) return null;
      return orderId;
    } catch {
      return null;
    }
  }
}
