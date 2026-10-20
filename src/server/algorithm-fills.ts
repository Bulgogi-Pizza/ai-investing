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
