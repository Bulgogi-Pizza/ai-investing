import type { EconomicEvent, EventReaction, ReactionAsset } from './calendar.js';
import {
  collectCandlePages,
  type CandlePage,
  type DailyCandle,
  type StockDailyCandle,
} from './toss.js';

/**
 * Measured market reaction around a calendar event (deterministic; no AI, no estimates).
 *
 * Rule: compare the LAST CLOSE AT OR BEFORE the release with the FIRST CLOSE AFTER it.
 *   - A close is the regular-session close of a trade date: 15:30 KST for the Korean market
 *     (KOSPI, KOSDAQ, bond yields, and the USD/KRW rate sampled at the same instants), 16:00
 *     America/New_York for SPY. Early closes (13:00 ET) are not modeled.
 *   - Korean release at 10:00 KST on day D: before = close of the previous Korean session, after =
 *     close of D. Published at or after 15:30: before = close of D, after = close of the next session.
 *   - US release (Fed, 03:00 KST on D = 14:00 ET on D-1): SPY before = close of D-1's previous
 *     session, after = close of D-1; the Korean assets before = close of D-1 (KST), after = close of
 *     D, that is the first Korean session after the release.
 *   - Weekends and holidays have no bar, so "next session" is simply the next bar.
 *   - Release time unknown (provider gives dates only): no reaction. A close that has not happened
 *     yet (or happened less than 30 minutes ago, when the daily bar may still be changing): no
 *     reaction. A before/after bar more than 7 days away from the release: no reaction (data gap).
 *   - Units: indices and SPY in %, bond yields in %p (yield difference), USD/KRW in 원 and %.
 *   - Missing data omits that asset; nothing is interpolated or estimated.
 * Provider data: Toss market-indicator 1d candles (KOSPI, KOSDAQ, KR_BOND_3Y/10Y), Toss 1d stock
 * candles for SPY (the S&P 500 index itself is not offered, so the label says "SPY ETF 기준"), and
 * Toss GET /exchange-rate?dateTime= (midRate = 매매기준율) for USD/KRW.
 */
export type ReactionToss = {
  marketIndicatorCandlePage(
    symbol: string,
    options?: { count?: number; before?: string },
  ): Promise<CandlePage<DailyCandle>>;
  dailyCandlePage(
    symbol: string,
    options?: { count?: number; before?: string },
  ): Promise<CandlePage<StockDailyCandle>>;
  exchangeRateAt(
    dateTime: string,
  ): Promise<{ midRate: string; validFrom: string; validUntil: string }>;
};
export type Bar = { date: string; close: number };
type Market = 'KR' | 'US';

export const KR_CLOSE_TIME = '15:30';
const SETTLE_MS = 30 * 60 * 1000;
const MAX_GAP_DAYS = 7;
/** After this many days a missing close is treated as permanently missing. */
const SETTLE_DAYS = 3;
const DAY_MS = 86_400_000;
export const SOURCE_KR = '토스증권 OpenAPI 시장 지표(일봉 종가)';
export const SOURCE_SPY = 'SPY ETF 기준 · 토스증권 OpenAPI(일봉 종가)';
export const SOURCE_FX = '토스증권 OpenAPI 환율(매매기준율)';

const KR_ASSETS: { asset: ReactionAsset; symbol: string }[] = [
  { asset: 'KOSPI', symbol: 'KOSPI' },
  { asset: 'KOSDAQ', symbol: 'KOSDAQ' },
  { asset: 'KR_BOND_3Y', symbol: 'KR_BOND_3Y' },
  { asset: 'KR_BOND_10Y', symbol: 'KR_BOND_10Y' },
];
/** Assets a release of this country is measured against. */
export function expectedAssets(country: EconomicEvent['country']): ReactionAsset[] {
  const kr: ReactionAsset[] = [...KR_ASSETS.map((entry) => entry.asset), 'USDKRW'];
  return country === '한국' ? kr : ['SPY', ...kr];
}

// ---------------------------------------------------------------------------
// Time arithmetic.
// ---------------------------------------------------------------------------
/** Release instant (ms) from the stored KST date and time; null when the time is unknown. */
export function releaseInstant(event: Pick<EconomicEvent, 'date' | 'time'>): number | null {
  if (!event.time) return null;
  const at = Date.parse(`${event.date}T${event.time}:00+09:00`);
  return Number.isFinite(at) ? at : null;
}
const newYorkHour = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  hourCycle: 'h23',
});
/** 16:00 America/New_York of a trade date, DST-aware (20:00Z in summer time, 21:00Z otherwise). */
export function usCloseInstant(date: string): number {
  for (const hourUtc of [20, 21]) {
    const at = Date.parse(`${date}T${String(hourUtc).padStart(2, '0')}:00:00Z`);
    if (Number(newYorkHour.format(new Date(at))) === 16) return at;
  }
  return Date.parse(`${date}T21:00:00Z`);
}
export const krCloseInstant = (date: string) => Date.parse(`${date}T${KR_CLOSE_TIME}:00+09:00`);
export const closeInstant = (market: Market, date: string) =>
  market === 'KR' ? krCloseInstant(date) : usCloseInstant(date);

/** Last close at or before the release and first close after it (both final by `nowMs`). */
export function pickWindow(
  bars: Bar[],
  market: Market,
  releaseMs: number,
  nowMs: number,
): { from: Bar; to: Bar } | null {
  let from: Bar | undefined;
  let to: Bar | undefined;
  for (const bar of bars) {
    const at = closeInstant(market, bar.date);
    if (at <= releaseMs) {
      if (!from || at > closeInstant(market, from.date)) from = bar;
    } else if (!to || at < closeInstant(market, to.date)) to = bar;
  }
  if (!from || !to) return null;
  if (closeInstant(market, to.date) + SETTLE_MS > nowMs) return null;
  if (
    releaseMs - closeInstant(market, from.date) > MAX_GAP_DAYS * DAY_MS ||
    closeInstant(market, to.date) - releaseMs > MAX_GAP_DAYS * DAY_MS
  )
    return null;
  return { from, to };
}

// ---------------------------------------------------------------------------
// Numbers.
// ---------------------------------------------------------------------------
const round = (value: number, digits: number) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
export function reactionChange(
  asset: ReactionAsset,
  from: number,
  to: number,
): { change: number; unit: EventReaction['unit']; changePercent?: number } | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return null;
  if (asset === 'KR_BOND_3Y' || asset === 'KR_BOND_10Y')
    return { change: round(to - from, 3), unit: '%p' };
  if (asset === 'USDKRW')
    return {
      change: round(to - from, 2),
      unit: '원',
      changePercent: round((to / from - 1) * 100, 2),
    };
  return { change: round((to / from - 1) * 100, 2), unit: '%' };
}
/**
 * "Small" market move: every measured index/FX move below 0.5% and every bond yield move below
 * 0.05%p, with at least one index measured (KOSPI for Korean releases, SPY otherwise). Only then
 * may a low-importance release be described as having little direct market impact.
 */
export const SMALL_INDEX_PERCENT = 0.5;
export const SMALL_BOND_POINTS = 0.05;
export function reactionIsSmall(rows: EventReaction[], country: EconomicEvent['country']): boolean {
  const lead: ReactionAsset = country === '한국' ? 'KOSPI' : 'SPY';
  if (!rows.some((row) => row.asset === lead)) return false;
  return rows.every((row) =>
    row.unit === '%p'
      ? Math.abs(row.change) < SMALL_BOND_POINTS
      : Math.abs(row.asset === 'USDKRW' ? (row.changePercent ?? Infinity) : row.change) <
        SMALL_INDEX_PERCENT,
  );
}

// ---------------------------------------------------------------------------
// Calculator: loads each series once, then answers per event.
// ---------------------------------------------------------------------------
export type ReactionOptions = {
  now?: () => number;
  /** Candle pages per series. */
  maxPages?: number;
  /** Most exchange-rate calls per calculator (each one is a provider request). */
  fxBudget?: number;
  /** Minimum delay between provider calls. */
  paceMs?: number;
  sleep?: (ms: number) => Promise<void>;
};
export type ReactionResult = { rows: EventReaction[]; codes: string[] };
const parseBars = (candles: DailyCandle[]): Bar[] =>
  candles
    .map((candle) => ({ date: candle.date, close: Number(candle.close) }))
    .filter((bar) => Number.isFinite(bar.close) && bar.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

export class ReactionCalculator {
  private series = new Map<ReactionAsset, Bar[] | null>();
  private fx = new Map<number, number | null>();
  private fxCalls = 0;
  private lastCall = 0;
  readonly codes = new Map<string, number>();
  private now: () => number;
  private fxBudget: number;
  private paceMs: number;
  private sleep: (ms: number) => Promise<void>;
  private maxPages: number;
  constructor(
    private toss: ReactionToss,
    options: ReactionOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.fxBudget = options.fxBudget ?? 150;
    this.paceMs = options.paceMs ?? 0;
    this.maxPages = options.maxPages ?? 6;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }
  private count(code: string) {
    this.codes.set(code, (this.codes.get(code) ?? 0) + 1);
  }
  private async pace() {
    const wait = this.lastCall + this.paceMs - Date.now();
    if (this.paceMs > 0 && wait > 0) await this.sleep(wait);
    this.lastCall = Date.now();
  }
  /** Loads the daily bars of the six-asset plan back to `earliest` (a date), once. */
  async load(earliest: string, countries: Set<EconomicEvent['country']>) {
    const needUs = [...countries].some((country) => country !== '한국');
    const plan: {
      asset: ReactionAsset;
      read: (before?: string) => Promise<CandlePage<DailyCandle>>;
    }[] = [
      ...KR_ASSETS.map(({ asset, symbol }) => ({
        asset,
        read: async (before?: string) => {
          await this.pace();
          return this.toss.marketIndicatorCandlePage(symbol, { count: 200, before });
        },
      })),
      ...(needUs
        ? [
            {
              asset: 'SPY' as ReactionAsset,
              read: async (before?: string) => {
                await this.pace();
                return this.toss.dailyCandlePage('SPY', { count: 200, before });
              },
            },
          ]
        : []),
    ];
    for (const { asset, read } of plan) {
      if (this.series.has(asset)) continue;
      try {
        const paged = await collectCandlePages(read, {
          maxPages: this.maxPages,
          stopAtDate: earliest,
        });
        this.series.set(asset, parseBars(paged.candles));
      } catch {
        this.series.set(asset, null);
        this.count('REACTION_SERIES_FAILED');
      }
    }
  }
  private async rateAt(at: number): Promise<number | null> {
    if (this.fx.has(at)) return this.fx.get(at) ?? null;
    if (this.fxCalls >= this.fxBudget) {
      this.count('FX_BUDGET_EXHAUSTED');
      return null;
    }
    this.fxCalls++;
    await this.pace();
    let value: number | null = null;
    try {
      const rate = await this.toss.exchangeRateAt(new Date(at).toISOString());
      const mid = Number(rate.midRate);
      // The rate must have been in effect at the requested instant, else it is not that rate.
      if (
        Number.isFinite(mid) &&
        mid > 0 &&
        Date.parse(rate.validFrom) <= at &&
        at <= Date.parse(rate.validUntil)
      )
        value = mid;
      else this.count('FX_NOT_IN_EFFECT');
    } catch {
      this.count('FX_UNAVAILABLE');
    }
    this.fx.set(at, value);
    return value;
  }
  /** Reaction rows for one event; assets without data are simply absent. */
  async forEvent(event: EconomicEvent): Promise<ReactionResult> {
    const releaseMs = releaseInstant(event);
    if (releaseMs === null) return { rows: [], codes: ['RELEASE_TIME_UNKNOWN'] };
    const nowMs = this.now();
    const rows: EventReaction[] = [];
    const codes = new Set<string>();
    for (const asset of expectedAssets(event.country)) {
      if (asset === 'USDKRW') continue;
      const bars = this.series.get(asset);
      if (!bars) {
        codes.add('REACTION_SERIES_MISSING');
        continue;
      }
      const market: Market = asset === 'SPY' ? 'US' : 'KR';
      const window = pickWindow(bars, market, releaseMs, nowMs);
      if (!window) {
        codes.add('REACTION_DATA_PENDING');
        continue;
      }
      const change = reactionChange(asset, window.from.close, window.to.close);
      if (!change) continue;
      rows.push({
        asset,
        from: { date: window.from.date, value: window.from.close },
        to: { date: window.to.date, value: window.to.close },
        ...change,
        source: asset === 'SPY' ? SOURCE_SPY : SOURCE_KR,
      });
    }
    // USD/KRW: the rate at the same two Korean closes as KOSPI (needs that window to exist).
    const kospi = this.series.get('KOSPI');
    const krWindow = kospi ? pickWindow(kospi, 'KR', releaseMs, nowMs) : null;
    if (krWindow) {
      const before = await this.rateAt(krCloseInstant(krWindow.from.date));
      const after = before === null ? null : await this.rateAt(krCloseInstant(krWindow.to.date));
      const change =
        before !== null && after !== null ? reactionChange('USDKRW', before, after) : null;
      if (change)
        rows.push({
          asset: 'USDKRW',
          from: { date: krWindow.from.date, value: before! },
          to: { date: krWindow.to.date, value: after! },
          ...change,
          source: SOURCE_FX,
        });
      else codes.add('FX_UNAVAILABLE');
    }
    return { rows, codes: [...codes] };
  }
}

/** Stored rows plus freshly computed ones; a fresh row replaces the stored row of the same asset. */
export function mergeReactions(
  stored: EventReaction[] | undefined,
  fresh: EventReaction[],
): EventReaction[] {
  const byAsset = new Map((stored ?? []).map((row) => [row.asset, row]));
  for (const row of fresh) byAsset.set(row.asset, row);
  return [...byAsset.values()].sort(
    (a, b) =>
      (
        ['SPY', 'KOSPI', 'KOSDAQ', 'KR_BOND_3Y', 'KR_BOND_10Y', 'USDKRW'] as ReactionAsset[]
      ).indexOf(a.asset) -
      (
        ['SPY', 'KOSPI', 'KOSDAQ', 'KR_BOND_3Y', 'KR_BOND_10Y', 'USDKRW'] as ReactionAsset[]
      ).indexOf(b.asset),
  );
}
/** A reaction that cannot change any more: complete, or old enough that missing data stays missing. */
export function reactionSettled(event: EconomicEvent, todayKst: string, rows: EventReaction[]) {
  const complete = expectedAssets(event.country).every((asset) =>
    rows.some((row) => row.asset === asset),
  );
  const ageDays =
    (Date.parse(`${todayKst}T00:00:00Z`) - Date.parse(`${event.date}T00:00:00Z`)) / DAY_MS;
  return complete || ageDays > SETTLE_DAYS;
}
