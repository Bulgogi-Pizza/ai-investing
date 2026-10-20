/**
 * Algorithm fills drawn as ▲▼ markers on the 종목 분석 chart (stage 5e).
 *
 * Stage 7c will write virtual fills to `paperTrades` and stage 7f real orders to `liveOrders`; neither
 * exists yet, so the only implementation today is `NoAlgorithmFills`, which reports itself as not
 * connected and returns an empty list. When 7c lands, implement `AlgorithmFillSource` over those
 * collections and pass it as `algorithmFills` to createApp: nothing else changes. The route
 * re-validates every field of what the source returns, so a bad record cannot reach the browser.
 */
export interface AlgorithmFill {
  id: string;
  algorithmId: string;
  algorithmName: string;
  symbol: string;
  side: 'buy' | 'sell';
  /** `paper` = virtual fill (가상), `live` = real order fill (실제). */
  mode: 'paper' | 'live';
  /** Trade date in the symbol's market (KST for KR, US Eastern for US), YYYY-MM-DD. */
  date: string;
  filledAt: string;
  /** Decimal strings, as everywhere else in the API. */
  price: string;
  quantity: string;
  currency: 'KRW' | 'USD';
}

export interface AlgorithmFillSource {
  /** False while no fill store exists (stage 7c not built): the UI says "미연결" instead of "체결 없음". */
  readonly connected: boolean;
  /** Fills of `symbol` with `date` in [from, to]. */
  listFills(symbol: string, from: string, to: string): Promise<AlgorithmFill[]>;
}

export class NoAlgorithmFills implements AlgorithmFillSource {
  readonly connected = false;
  async listFills(): Promise<AlgorithmFill[]> {
    return [];
  }
}

const decimal = /^-?\d+(\.\d+)?$/;
const isDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
/** Keeps only well-formed fills inside the window; unknown fields are dropped. */
export function cleanFills(
  input: unknown,
  symbol: string,
  from: string,
  to: string,
): AlgorithmFill[] {
  if (!Array.isArray(input)) return [];
  const result: AlgorithmFill[] = [];
  for (const raw of input.slice(0, 500)) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as Record<string, unknown>;
    const price = f.price;
    const quantity = f.quantity;
    if (
      typeof f.id !== 'string' ||
      typeof f.algorithmId !== 'string' ||
      typeof f.algorithmName !== 'string' ||
      typeof f.symbol !== 'string' ||
      f.symbol.toUpperCase() !== symbol.toUpperCase() ||
      (f.side !== 'buy' && f.side !== 'sell') ||
      (f.mode !== 'paper' && f.mode !== 'live') ||
      !isDate(f.date) ||
      f.date < from ||
      f.date > to ||
      typeof f.filledAt !== 'string' ||
      !Number.isFinite(Date.parse(f.filledAt)) ||
      typeof price !== 'string' ||
      !decimal.test(price) ||
      typeof quantity !== 'string' ||
      !decimal.test(quantity) ||
      (f.currency !== 'KRW' && f.currency !== 'USD')
    )
      continue;
    result.push({
      id: f.id.slice(0, 80),
      algorithmId: f.algorithmId.slice(0, 80),
      algorithmName: f.algorithmName.slice(0, 100),
      symbol: f.symbol,
      side: f.side,
      mode: f.mode,
      date: f.date,
      filledAt: f.filledAt,
      price,
      quantity,
      currency: f.currency,
    });
  }
  return result.sort((a, b) => a.filledAt.localeCompare(b.filledAt) || a.id.localeCompare(b.id));
}

/** Minimal reads the paper-backed source needs (PaperRepository and AlgorithmRepository satisfy them). */
type PaperTradeReader = {
  listTradesBySymbol(
    symbol: string,
    limit: number,
  ): Promise<
    {
      id: string;
      algorithmId: string;
      market: 'KR' | 'US';
      symbol: string;
      side: 'buy' | 'sell';
      quantity: number;
      price: number;
      date: string;
      createdAt: string;
      mode: 'paper';
    }[]
  >;
};
type AlgorithmNameReader = { list(): Promise<{ id: string; name: string }[]> };

/**
 * Stage 7c virtual fills (`paperTrades`) as chart markers. Live fills join here in stage 7f. Numbers
 * are converted to decimal strings; the route's cleanFills re-validates every field afterwards.
 */
export class PaperAlgorithmFills implements AlgorithmFillSource {
  readonly connected = true;
  constructor(
    private trades: PaperTradeReader,
    private algorithms: AlgorithmNameReader,
    private limit = 200,
  ) {}
  async listFills(symbol: string, from: string, to: string): Promise<AlgorithmFill[]> {
    const [trades, algorithms] = await Promise.all([
      this.trades.listTradesBySymbol(symbol.toUpperCase(), this.limit),
      this.algorithms.list(),
    ]);
    const names = new Map(algorithms.map((a) => [a.id, a.name]));
    return trades
      .filter((t) => t.mode === 'paper' && t.date >= from && t.date <= to)
      .map((t) => ({
        id: t.id,
        algorithmId: t.algorithmId,
        algorithmName: names.get(t.algorithmId) ?? '(삭제된 알고리즘)',
        symbol: t.symbol,
        side: t.side,
        mode: 'paper' as const,
        date: t.date,
        filledAt: t.createdAt,
        price: String(t.price),
        quantity: String(t.quantity),
        currency: t.market === 'US' ? ('USD' as const) : ('KRW' as const),
      }));
  }
}

/** Minimal read of live orders the chart markers need (the trading store satisfies it). */
type LiveOrderReader = {
  listOrdersBySymbol(
    symbol: string,
    limit: number,
  ): Promise<
    {
      clientOrderId: string;
      algorithmId: string;
      market: 'KR' | 'US';
      symbol: string;
      side: 'buy' | 'sell';
      status: string;
      price: string;
      filledQuantity: number;
      averageFilledPrice?: number | null;
      dateKey: string;
      updatedAt: string;
    }[]
  >;
};

/**
 * Stage 7f real fills (`liveOrders`) as chart markers, labelled `live` (실제). Only quantity that
 * actually filled counts: an order that was accepted but not filled (or fully cancelled) is not a
 * fill, a partial fill shows its filled quantity. `date` is the KST reservation date, which is the
 * session date of both markets because orders go out right after the open (before midnight KST).
 */
export class LiveAlgorithmFills implements AlgorithmFillSource {
  readonly connected = true;
  constructor(
    private orders: LiveOrderReader,
    private algorithms: AlgorithmNameReader,
    private limit = 200,
  ) {}
  async listFills(symbol: string, from: string, to: string): Promise<AlgorithmFill[]> {
    const [orders, algorithms] = await Promise.all([
      this.orders.listOrdersBySymbol(symbol.toUpperCase(), this.limit),
      this.algorithms.list(),
    ]);
    const names = new Map(algorithms.map((a) => [a.id, a.name]));
    return orders
      .filter((o) => o.filledQuantity > 0 && o.dateKey >= from && o.dateKey <= to)
      .map((o) => ({
        id: o.clientOrderId,
        algorithmId: o.algorithmId,
        algorithmName: names.get(o.algorithmId) ?? '(삭제된 알고리즘)',
        symbol: o.symbol,
        side: o.side,
        mode: 'live' as const,
        date: o.dateKey,
        filledAt: o.updatedAt,
        price: String(o.averageFilledPrice ?? o.price),
        quantity: String(o.filledQuantity),
        currency: o.market === 'US' ? ('USD' as const) : ('KRW' as const),
      }));
  }
}

/**
 * Paper (가상) and live (실제) fills in one source. A source that fails drops out on its own: the
 * other still draws, and the chart simply misses the failed kind rather than showing nothing.
 */
export class CombinedAlgorithmFills implements AlgorithmFillSource {
  readonly connected = true;
  constructor(private sources: AlgorithmFillSource[]) {}
  async listFills(symbol: string, from: string, to: string): Promise<AlgorithmFill[]> {
    const parts = await Promise.allSettled(
      this.sources.map((source) => source.listFills(symbol, from, to)),
    );
    return parts.flatMap((part) => (part.status === 'fulfilled' ? part.value : []));
  }
}
