import { trueRange } from './atr';
import { assertPositiveInteger, type IndicatorCandle, type Series } from './common';

export type AdxPoint = {
  plusDI: number | null;
  minusDI: number | null;
  adx: number | null;
};

/**
 * Average Directional Index with +DI/-DI (Wilder, default 14). +DM = up move when it exceeds the
 * down move and is positive, -DM likewise for the down move. TR, +DM and -DM are Wilder-smoothed
 * (first value = sum of the first `period` changes at index `period`, then S = S - S/period + x);
 * +DI = 100 * smoothed(+DM) / smoothed(TR); DX = 100 * |+DI - -DI| / (+DI + -DI); ADX = Wilder
 * average of DX (first value = mean of the first `period` DX at index 2 * period - 1).
 * Warm-up: DI is null before index `period`, ADX before index 2 * period - 1.
 * Flat prices: smoothed TR = 0 gives +DI = -DI = 0 and DX = 0 (no directional movement), so ADX
 * is 0 rather than NaN.
 */
export function adx(candles: IndicatorCandle[], period = 14): AdxPoint[] {
  assertPositiveInteger('adx', 'period', period);
  const n = candles.length;
  const out: AdxPoint[] = candles.map(() => ({ plusDI: null, minusDI: null, adx: null }));
  if (n <= period) return out;
  const tr = trueRange(candles);
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const sum = (values: number[]) => values.slice(1, period + 1).reduce((a, v) => a + v, 0);
  let sTR = sum(tr);
  let sPlus = sum(plusDM);
  let sMinus = sum(minusDM);
  const dx: Series = candles.map(() => null);
  let adxPrev: number | null = null;
  for (let i = period; i < n; i++) {
    if (i > period) {
      sTR = sTR - sTR / period + tr[i];
      sPlus = sPlus - sPlus / period + plusDM[i];
      sMinus = sMinus - sMinus / period + minusDM[i];
    }
    const plusDI = sTR === 0 ? 0 : (100 * sPlus) / sTR;
    const minusDI = sTR === 0 ? 0 : (100 * sMinus) / sTR;
    const total = plusDI + minusDI;
    const value = total === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / total;
    dx[i] = value;
    let adxValue: number | null = null;
    if (i === 2 * period - 1) {
      adxValue = (dx.slice(period, i + 1) as number[]).reduce((a, v) => a + v, 0) / period;
    } else if (i > 2 * period - 1 && adxPrev !== null) {
      adxValue = (adxPrev * (period - 1) + value) / period;
    }
    adxPrev = adxValue ?? adxPrev;
    out[i] = { plusDI, minusDI, adx: adxValue };
  }
  return out;
}
