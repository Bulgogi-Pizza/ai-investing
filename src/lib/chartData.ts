// Turns daily candles into the rows the 종목 분석 chart draws. Indicators are computed on the whole
// received history (so their warm-up is not visible) and then cut to the displayed window.
import {
  adx,
  atr,
  cci,
  fibonacciRetracement,
  ichimoku,
  keltner,
  obv,
  parabolicSar,
  stochastic,
  vwap,
  type FibonacciRetracement,
  type IndicatorId,
} from './indicators';
import { bollinger, ema, macd, rsi, sma } from './market';

export type Candle = {
  /** As sent by the provider (local midnight of the trading day for daily candles). */
  timestamp: string;
  /** Trading date, YYYY-MM-DD. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export const WINDOWS = [
  { label: '1주', bars: 5 },
  { label: '1개월', bars: 21 },
  { label: '3개월', bars: 63 },
  { label: '6개월', bars: 126 },
  { label: '1년', bars: 252 },
  { label: '3년', bars: 756 },
] as const;
export type WindowLabel = (typeof WINDOWS)[number]['label'];
/** Bars before the window that indicators need so their first drawn value is already warmed up. */
export const WARMUP_BARS = 120;
export const PAGE_SIZE = 200;
/** Candle pages requested at most per symbol (1,000 daily bars, about four years). */
export const MAX_PAGES = 5;
export const windowBars = (label: string) =>
  WINDOWS.find((window) => window.label === label)?.bars ?? 63;
export const targetBars = (label: string) =>
  Math.min(windowBars(label) + WARMUP_BARS, PAGE_SIZE * MAX_PAGES);

type Num = number | null;
export type ChartRow = {
  /** Position in the displayed rows. */
  index: number;
  /** X axis label: MM/DD or YY/MM/DD for long windows; "+N봉" for future Ichimoku positions. */
  label: string;
  date: string | null;
  future: boolean;
  close: Num;
  sma: Num;
  ema: Num;
  bbUpper: Num;
  bbLower: Num;
  tenkan: Num;
  kijun: Num;
  senkouA: Num;
  senkouB: Num;
  chikou: Num;
  /** Cloud where span A is on or above span B / below it, as [low, high] for a range area. */
  cloudUp: [number, number] | null;
  cloudDown: [number, number] | null;
  vwap: Num;
  sar: Num;
  sarTrend: 'up' | 'down' | null;
  kcMiddle: Num;
  kcUpper: Num;
  kcLower: Num;
  rsi: Num;
  macd: Num;
  macdSignal: Num;
  macdHistogram: Num;
  stochK: Num;
  stochD: Num;
  atr: Num;
  obv: Num;
  adx: Num;
  plusDI: Num;
  minusDI: Num;
  cci: Num;
};

export type ChartModel = {
  rows: ChartRow[];
  /** Number of leading rows that are real candles (the rest are future cloud positions). */
  candleRows: number;
  futureRows: number;
  fibonacci: FibonacciRetracement | null;
  /** Window length asked for vs. candles actually available. */
  requestedBars: number;
  shownBars: number;
};

const emptyRow = (index: number): ChartRow => ({
  index,
  label: '',
  date: null,
  future: false,
  close: null,
  sma: null,
  ema: null,
  bbUpper: null,
  bbLower: null,
  tenkan: null,
  kijun: null,
  senkouA: null,
  senkouB: null,
  chikou: null,
  cloudUp: null,
  cloudDown: null,
  vwap: null,
  sar: null,
  sarTrend: null,
  kcMiddle: null,
  kcUpper: null,
  kcLower: null,
  rsi: null,
  macd: null,
  macdSignal: null,
  macdHistogram: null,
  stochK: null,
  stochD: null,
  atr: null,
  obv: null,
  adx: null,
  plusDI: null,
  minusDI: null,
  cci: null,
});

const shortLabel = (date: string, long: boolean) =>
  long
    ? `${date.slice(2, 4)}/${date.slice(5, 7)}/${date.slice(8, 10)}`
    : `${date.slice(5, 7)}/${date.slice(8, 10)}`;

/**
 * Rows for the displayed window. `selected` decides which indicators are computed (unselected ones
 * stay null and cost nothing). Ichimoku adds `displacement` future rows that carry only the cloud.
 */
export function buildChartModel(
  history: readonly Candle[],
  selected: ReadonlySet<IndicatorId>,
  windowLabel: string,
): ChartModel {
  const candles = [...history];
  const requestedBars = windowBars(windowLabel);
  const n = candles.length;
  const start = Math.max(0, n - requestedBars);
  const shownBars = n - start;
  const long = requestedBars > 63;
  const rows: ChartRow[] = [];
  const closes = candles.map((c) => c.close);
  const has = (id: IndicatorId) => selected.has(id);
  // Indicators take oldest-first OHLCV candles; the same objects are reused.
  const smaS = has('sma') ? sma(closes, 20) : [];
  const emaS = has('ema') ? ema(closes, 20) : [];
  const bbS = has('bollinger') ? bollinger(closes) : [];
  const rsiS = has('rsi') ? rsi(closes) : [];
  const macdS = has('macd') ? macd(closes) : [];
  const vwapS = has('vwap') ? vwap(candles, { anchor: 'cumulative', anchorIndex: start }) : [];
  const stochS = has('stochastic') ? stochastic(candles) : [];
  const atrS = has('atr') ? atr(candles) : [];
  const obvS = has('obv') ? obv(candles) : [];
  const sarS = has('parabolicSar') ? parabolicSar(candles) : [];
  const adxS = has('adx') ? adx(candles) : [];
  const cciS = has('cci') ? cci(candles) : [];
  const kcS = has('keltner') ? keltner(candles) : [];
  const ichiS = has('ichimoku') ? ichimoku(candles) : [];
  // Ichimoku positions beyond the last candle exist only in `ichiS`.
  const futureRows = has('ichimoku') && n ? ichiS.length - n : 0;
  for (let i = start; i < n; i++) {
    const row = emptyRow(i - start);
    const c = candles[i];
    row.label = shortLabel(c.date, long);
    row.date = c.date;
    row.close = c.close;
    if (has('sma')) row.sma = smaS[i] ?? null;
    if (has('ema')) row.ema = i >= 19 ? (emaS[i] ?? null) : null;
    if (has('bollinger')) {
      row.bbUpper = bbS[i]?.upper ?? null;
      row.bbLower = bbS[i]?.lower ?? null;
    }
    if (has('rsi')) row.rsi = rsiS[i] ?? null;
    if (has('macd') && i >= 25) {
      row.macd = macdS[i].macd;
      row.macdSignal = macdS[i].signal;
      row.macdHistogram = macdS[i].histogram;
    }
    if (has('vwap')) row.vwap = vwapS[i] ?? null;
    if (has('stochastic')) {
      row.stochK = stochS[i]?.k ?? null;
      row.stochD = stochS[i]?.d ?? null;
    }
    if (has('atr')) row.atr = atrS[i] ?? null;
    if (has('obv')) row.obv = obvS[i] ?? null;
    if (has('parabolicSar')) {
      row.sar = sarS[i]?.sar ?? null;
      row.sarTrend = sarS[i]?.trend ?? null;
    }
    if (has('adx')) {
      row.adx = adxS[i]?.adx ?? null;
      row.plusDI = adxS[i]?.plusDI ?? null;
      row.minusDI = adxS[i]?.minusDI ?? null;
    }
    if (has('cci')) row.cci = cciS[i] ?? null;
    if (has('keltner')) {
      row.kcMiddle = kcS[i]?.middle ?? null;
      row.kcUpper = kcS[i]?.upper ?? null;
      row.kcLower = kcS[i]?.lower ?? null;
    }
    rows.push(row);
  }
  if (has('ichimoku') && n) {
    for (let i = start; i < ichiS.length; i++) {
      const row = i < n ? rows[i - start] : emptyRow(i - start);
      if (i >= n) {
        row.future = true;
        row.label = `+${i - n + 1}봉`;
        rows.push(row);
      }
      const p = ichiS[i];
      row.tenkan = p.tenkan;
      row.kijun = p.kijun;
      row.senkouA = p.senkouA;
      row.senkouB = p.senkouB;
      row.chikou = p.chikou;
      if (p.senkouA !== null && p.senkouB !== null) {
        const range: [number, number] = [
          Math.min(p.senkouA, p.senkouB),
          Math.max(p.senkouA, p.senkouB),
        ];
        if (p.senkouA >= p.senkouB) row.cloudUp = range;
        else row.cloudDown = range;
      }
    }
  }
  // Retracement over the displayed window only, so the lines match what the reader sees.
  const fibonacci = has('fibonacci') ? fibonacciRetracement(candles.slice(start)) : null;
  return { rows, candleRows: shownBars, futureRows, fibonacci, requestedBars, shownBars };
}
