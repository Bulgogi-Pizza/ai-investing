import { useMemo } from 'react';
import { useApiResource, type DataIssue } from '../../lib/api';
import { COMPARE_SERIES, valuesByDate, type CompareDef, type CompareId } from '../../lib/compare';
import { indicatorUrl, stockUrl, useCandleSeries, type CandleHistory } from './candles';
import { parseHoldingCost, parseMacroSeries, parseFills } from './parsers';

/** One comparison series: its own request, state and provenance. A failing one never blanks the others. */
export type CompareState = {
  def: CompareDef;
  status: 'off' | 'loading' | 'ready' | 'issue';
  issue?: DataIssue;
  source?: string;
  asOf?: string;
  values?: Map<string, number>;
  /** Number of daily values received. */
  count?: number;
  retry: () => void;
};

const fromCandles = (
  def: CompareDef,
  enabled: boolean,
  state: CandleHistory | { status: 'idle' },
  retry: () => void,
  source: string,
): CompareState => {
  if (!enabled) return { def, status: 'off', retry };
  if (state.status === 'ready')
    return {
      def,
      status: 'ready',
      source,
      asOf: state.asOf,
      values: valuesByDate(state.candles.map((c) => ({ date: c.date, value: c.close }))),
      count: state.candles.length,
      retry,
    };
  if (state.status === 'issue') return { def, status: 'issue', issue: state.issue, retry };
  return { def, status: 'loading', retry };
};

const def = (id: CompareId) => COMPARE_SERIES.find((item) => item.id === id)!;

/**
 * Loads the selected comparison series. KOSPI and KOSDAQ come from the Toss market-indicator daily
 * candles, S&P 500 from the SPY ETF's Toss daily candles, USD/KRW from ECOS (`/api/macro/series`).
 * Nothing is requested for a series that is not selected.
 */
export function useCompareSeries(
  enabled: ReadonlySet<CompareId>,
  bars: number,
  window: { from: string; to: string } | null,
): CompareState[] {
  const kospi = useCandleSeries('KOSPI', indicatorUrl, bars, enabled.has('kospi'));
  const kosdaq = useCandleSeries('KOSDAQ', indicatorUrl, bars, enabled.has('kosdaq'));
  const spy = useCandleSeries('SPY', stockUrl, bars, enabled.has('sp500'));
  const fxUrl =
    enabled.has('usdkrw') && window
      ? `/api/macro/series?source=ecos&id=kr-usdkrw&from=${window.from}&to=${window.to}`
      : null;
  const fx = useApiResource(fxUrl, parseMacroSeries);
  const fxState = fx.state;
  const fxValues = useMemo(
    () => (fxState.status === 'ready' ? valuesByDate(fxState.data.points) : undefined),
    [fxState],
  );
  const usdkrw: CompareState = !enabled.has('usdkrw')
    ? { def: def('usdkrw'), status: 'off', retry: fx.retry }
    : fxState.status === 'ready'
      ? {
          def: def('usdkrw'),
          status: 'ready',
          source: fxState.data.sourceName,
          asOf: fxState.data.asOf,
          values: fxValues,
          count: fxState.data.points.length,
          retry: fx.retry,
        }
      : fxState.status === 'issue'
        ? { def: def('usdkrw'), status: 'issue', issue: fxState.issue, retry: fx.retry }
        : { def: def('usdkrw'), status: 'loading', retry: fx.retry };
  const toss = 'Toss Securities OpenAPI';
  // Memoized so downstream memos (comparison, chart rows) only recompute when a series changes.
  // The retry callbacks only call stable setters, so a stale closure is harmless.
  return useMemo(
    () => [
      fromCandles(def('kospi'), enabled.has('kospi'), kospi.state, kospi.retry, toss),
      fromCandles(def('kosdaq'), enabled.has('kosdaq'), kosdaq.state, kosdaq.retry, toss),
      fromCandles(def('sp500'), enabled.has('sp500'), spy.state, spy.retry, `${toss}(SPY)`),
      usdkrw,
    ],
    [enabled, kospi.state, kosdaq.state, spy.state, fxState],
  );
}

/** The owner's holding of the symbol (average purchase price) from `/api/portfolio`. */
export function useHoldingCost(symbol: string, enabled: boolean) {
  const parse = useMemo(() => parseHoldingCost(symbol), [symbol]);
  return useApiResource(enabled ? '/api/portfolio' : null, parse);
}

/** Algorithm fills (virtual and real) of the symbol within the chart window. */
export function useAlgorithmFills(
  symbol: string,
  window: { from: string; to: string } | null,
  enabled: boolean,
) {
  const url =
    enabled && window
      ? `/api/analysis/algorithm-fills?symbol=${encodeURIComponent(symbol)}&from=${window.from}&to=${window.to}`
      : null;
  return useApiResource(url, parseFills);
}
