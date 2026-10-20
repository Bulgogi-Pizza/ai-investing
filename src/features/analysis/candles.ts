import { useEffect, useRef, useState } from 'react';
import { ApiError, apiGet, issueOf, NoDataError, type DataIssue } from '../../lib/api';
import { candleDate } from '../../lib/analysis';
import { MAX_PAGES, PAGE_SIZE, type Candle } from '../../lib/chartData';

export type CandlePage = {
  source: string;
  asOf: string;
  currency: 'KRW' | 'USD';
  /** Oldest first. */
  candles: Candle[];
  /** Cursor for the next older page; null when the provider has no older candles. */
  nextBefore: string | null;
};

const invalid = (text = '시세 데이터 형식이 올바르지 않습니다.') =>
  new ApiError(502, 'INVALID_RESPONSE', text);
const positive = (value: unknown) => {
  const n = Number(value);
  if (typeof value !== 'string' || !Number.isFinite(n) || n <= 0) throw invalid();
  return n;
};

/** Validates one page of `GET /api/market/candles`. An empty page is allowed (see parseCandles). */
export function parseCandlePage(body: unknown): CandlePage {
  const d = body as {
    source?: unknown;
    asOf?: unknown;
    candles?: unknown;
    nextBefore?: unknown;
  };
  if (!d || typeof d.source !== 'string' || !Number.isFinite(Date.parse(String(d.asOf))))
    throw invalid('시세 응답 형식을 확인하지 못했습니다.');
  if (!Array.isArray(d.candles)) throw invalid('시세 응답 형식을 확인하지 못했습니다.');
  const nextBefore = d.nextBefore;
  if (
    nextBefore !== undefined &&
    nextBefore !== null &&
    (typeof nextBefore !== 'string' || !Number.isFinite(Date.parse(nextBefore)))
  )
    throw invalid('시세 응답 형식을 확인하지 못했습니다.');
  const candles = d.candles.map((raw): Candle => {
    const c = raw as Record<string, unknown>;
    if (typeof c?.timestamp !== 'string' || !Number.isFinite(Date.parse(c.timestamp)))
      throw invalid();
    const volume = Number(c.volume);
    if (typeof c.volume !== 'string' || !Number.isFinite(volume) || volume < 0) throw invalid();
    return {
      timestamp: c.timestamp,
      date: candleDate(c.timestamp),
      open: positive(c.open),
      high: positive(c.high),
      low: positive(c.low),
      close: positive(c.close),
      volume,
    };
  });
  const last = d.candles.at(-1) as { currency?: unknown } | undefined;
  return {
    source: d.source,
    asOf: String(d.asOf),
    currency: last?.currency === 'USD' ? 'USD' : 'KRW',
    candles,
    nextBefore: typeof nextBefore === 'string' ? nextBefore : null,
  };
}
/** The first page: an empty list means the provider has no candles for the symbol. */
export function parseCandles(body: unknown): CandlePage {
  const page = parseCandlePage(body);
  if (!page.candles.length)
    throw new NoDataError('이 종목에 대해 제공자가 돌려준 일봉이 없습니다.');
  return page;
}

export type CandleHistory =
  | { status: 'loading' }
  | { status: 'issue'; issue: DataIssue }
  | {
      status: 'ready';
      /** The symbol these candles belong to (a stale state from another symbol is ignored). */
      symbol: string;
      source: string;
      asOf: string;
      currency: 'KRW' | 'USD';
      candles: Candle[];
      /** True when the provider reported no older candles (the history is complete). */
      exhausted: boolean;
      /** Pages fetched / cap, and a notice when an older page failed or the cap stopped paging. */
      pages: number;
      notice: string | null;
    };

type Entry = {
  source: string;
  asOf: string;
  currency: 'KRW' | 'USD';
  candles: Candle[];
  nextBefore: string | null;
  pages: number;
  failure: string | null;
};

export const stockUrl = (symbol: string, before: string | null) =>
  `/api/market/candles?symbol=${encodeURIComponent(symbol)}&interval=1d&count=${PAGE_SIZE}` +
  (before ? `&before=${encodeURIComponent(before)}` : '');
/** Toss market-indicator daily candles (KOSPI, KOSDAQ): same paging contract, other route. */
export const indicatorUrl = (symbol: string, before: string | null) =>
  `/api/market/indicator-candles?symbol=${encodeURIComponent(symbol)}&count=${PAGE_SIZE}` +
  (before ? `&before=${encodeURIComponent(before)}` : '');

/**
 * Daily candle history for a symbol: page 1 on load, older pages (`before` = previous
 * `nextBefore`) only while the chosen window still needs bars, at most MAX_PAGES pages. Fetched
 * pages are kept per symbol, so widening the window loads only the missing older pages.
 */
const IDLE = { status: 'idle' } as const;
export function useCandleHistory(symbol: string, wantedBars: number) {
  return useCandleSeries(symbol, stockUrl, wantedBars, true) as {
    state: CandleHistory;
    retry: () => void;
  };
}
/**
 * The same paged loader for any candle route. `key` identifies the series in the per-hook cache and
 * in the returned `symbol` field; `enabled=false` loads nothing and reports `idle`.
 */
export function useCandleSeries(
  symbol: string,
  urlFor: (symbol: string, before: string | null) => string,
  wantedBars: number,
  enabled: boolean,
): { state: CandleHistory | { status: 'idle' }; retry: () => void } {
  const [state, setState] = useState<CandleHistory>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const cache = useRef(new Map<string, Entry>());
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const entryFor = () => cache.current.get(symbol);
    const publish = () => {
      const entry = entryFor();
      if (!entry || controller.signal.aborted) return;
      const capped = entry.pages >= MAX_PAGES && entry.nextBefore !== null;
      setState({
        status: 'ready',
        symbol,
        source: entry.source,
        asOf: entry.asOf,
        currency: entry.currency,
        candles: entry.candles,
        exhausted: entry.nextBefore === null,
        pages: entry.pages,
        notice:
          entry.failure ??
          (capped && entry.candles.length < wantedBars
            ? `한 번에 최대 ${MAX_PAGES}쪽(${PAGE_SIZE * MAX_PAGES}개 일봉)까지만 불러옵니다.`
            : null),
      });
    };
    const needsMore = (entry: Entry | undefined) =>
      !entry ||
      (entry.nextBefore !== null && entry.candles.length < wantedBars && entry.pages < MAX_PAGES);
    if (!needsMore(entryFor()) && entryFor()?.failure === null) {
      publish();
      return () => controller.abort();
    }
    if (!entryFor()) setState({ status: 'loading' });
    (async () => {
      let entry = entryFor();
      try {
        while (needsMore(entry)) {
          const first = !entry;
          let page: CandlePage;
          try {
            const body = await apiGet(urlFor(symbol, entry?.nextBefore ?? null), controller.signal);
            page = first ? parseCandles(body) : parseCandlePage(body);
          } catch (error) {
            if (controller.signal.aborted) return;
            if (first) throw error;
            // An older page failed: keep what we have and say so; the retry button repeats it.
            entry!.failure = `더 오래된 일봉을 불러오지 못했습니다(${issueOf(error).message}). 받은 ${entry!.candles.length}개로 표시합니다.`;
            break;
          }
          if (controller.signal.aborted) return;
          if (!entry) {
            entry = {
              source: page.source,
              asOf: page.asOf,
              currency: page.currency,
              candles: page.candles,
              nextBefore: page.nextBefore,
              pages: 1,
              failure: null,
            };
          } else {
            const known = new Set(entry.candles.map((c) => c.timestamp));
            entry.candles = [
              ...page.candles.filter((c) => !known.has(c.timestamp)),
              ...entry.candles,
            ];
            // The provider may repeat the boundary candle; an unchanged cursor would loop forever.
            entry.nextBefore = page.nextBefore === entry.nextBefore ? null : page.nextBefore;
            entry.pages += 1;
            entry.failure = null;
          }
          cache.current.set(symbol, entry);
        }
        if (entry) entry.failure = entry.failure ?? null;
        publish();
      } catch (error) {
        if (!controller.signal.aborted) setState({ status: 'issue', issue: issueOf(error) });
      }
    })();
    return () => controller.abort();
  }, [symbol, wantedBars, attempt, enabled]);
  return {
    state: enabled ? state : IDLE,
    retry: () => {
      const entry = cache.current.get(symbol);
      if (entry) entry.failure = null;
      setAttempt((value) => value + 1);
    },
  };
}
