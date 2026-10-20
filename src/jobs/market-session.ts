import type { MarketCalendar, MarketCode, MarketDay } from '../server/toss.js';

/**
 * Market-session helpers built on the Toss market calendar (GET /api/v1/market-calendar/{KR|US}).
 *
 * The provider already reports every regular session as KST timestamps, so US daylight saving time,
 * holidays and shortened days arrive as data: a US regular session ends 05:00 KST in summer time,
 * 06:00 KST otherwise, and earlier still on a half day. Nothing here hard-codes a close time. The
 * only calendar arithmetic is "what is today's date in the market's own time zone", which decides the
 * `date` to ask the provider for (US wants the US local date).
 */
export const MARKET_TIME_ZONE: Record<MarketCode, string> = {
  KR: 'Asia/Seoul',
  US: 'America/New_York',
};
export type Session = { market: MarketCode; date: string; open: Date; close: Date };
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** YYYY-MM-DD of `now` in the given IANA time zone. */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
export const kstDate = (now: Date) => localDate(now, 'Asia/Seoul');
/** "YYYY-MM-DD HH:mm" in KST (Korea has no daylight saving time). */
export function formatKst(date: Date): string {
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}
/** The `date` query value to ask the provider for: today's date in the market's own time zone. */
export const calendarQueryDate = (market: MarketCode, now: Date) =>
  localDate(now, MARKET_TIME_ZONE[market]);
function toSession(market: MarketCode, day: MarketDay): Session | null {
  if (!day.regularMarket) return null;
  return {
    market,
    date: day.date,
    open: new Date(day.regularMarket.startTime),
    close: new Date(day.regularMarket.endTime),
  };
}
/** Regular sessions among previous, current and next business day, oldest first, unique by date. */
export function sessionsOf(calendar: MarketCalendar): Session[] {
  const byDate = new Map<string, Session>();
  for (const day of [calendar.previousBusinessDay, calendar.today, calendar.nextBusinessDay]) {
    const session = toSession(calendar.market, day);
    if (session) byDate.set(session.date, session);
  }
  return [...byDate.values()].sort((a, b) => a.close.getTime() - b.close.getTime());
}
/**
 * Is the date the calendar was asked about a trading day for the regular session? A holiday has no
 * regular session; if the provider answers with the nearest business day instead, its date differs
 * from the asked one and this is still false.
 */
export function isTradingDay(calendar: MarketCalendar): boolean {
  return calendar.today.date === calendar.requestedDate && calendar.today.regularMarket !== null;
}
export const minutesBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 60000;
/** True from the close until `minutes` minutes after it. */
export function isWithinMinutesAfterClose(now: Date, session: Session, minutes: number): boolean {
  const elapsed = minutesBetween(session.close, now);
  return elapsed >= 0 && elapsed <= minutes;
}
/** True from the open until `minutes` minutes after it (algorithm runs just after the open). */
export function isWithinMinutesAfterOpen(now: Date, session: Session, minutes: number): boolean {
  const elapsed = minutesBetween(session.open, now);
  return elapsed >= 0 && elapsed <= minutes;
}
export type SessionSkipCode =
  'MARKET_CLOSED_TODAY' | 'SESSION_NOT_CLOSED_YET' | 'NO_RECENT_SESSION';
export type SessionDecision =
  { action: 'run'; session: Session } | { action: 'skip'; code: SessionSkipCode };
export type SessionWindowOptions = {
  /** Wait this long after the close so end-of-day data has settled. */
  minMinutesAfterClose: number;
  /** A session that closed longer ago belongs to an earlier schedule slot. */
  maxHoursAfterClose: number;
};
/**
 * KR runs at ~16:30 KST (one hour after the 15:30 close); the US schedules fire at 06:30 and 07:30
 * KST, which is 1.5 and 2.5 hours after a summer close and 0.5 and 1.5 hours after a winter close.
 * The windows are chosen so each slot picks up only its own market's latest session.
 */
export const DEFAULT_SESSION_WINDOWS: Record<MarketCode, SessionWindowOptions> = {
  KR: { minMinutesAfterClose: 20, maxHoursAfterClose: 8 },
  US: { minMinutesAfterClose: 20, maxHoursAfterClose: 6 },
};
/**
 * Decides whether a session closed recently enough (and long enough ago) to snapshot now.
 * `onlyDate` restricts the choice to one session date for manual backfills.
 */
export function selectSessionToSnapshot(
  calendar: MarketCalendar,
  now: Date,
  options: SessionWindowOptions = DEFAULT_SESSION_WINDOWS[calendar.market],
  onlyDate?: string,
): SessionDecision {
  const sessions = sessionsOf(calendar).filter((s) => !onlyDate || s.date === onlyDate);
  const settledBefore = now.getTime() - options.minMinutesAfterClose * 60000;
  // A manual backfill names its date explicitly, so age does not matter.
  const notOlderThan = onlyDate ? -Infinity : now.getTime() - options.maxHoursAfterClose * 3600000;
  const ready = sessions.filter(
    (s) => s.close.getTime() <= settledBefore && s.close.getTime() >= notOlderThan,
  );
  if (ready.length) return { action: 'run', session: ready[ready.length - 1] };
  // In progress, or closed but not yet settled.
  if (sessions.some((s) => s.open.getTime() <= now.getTime() && s.close.getTime() > settledBefore))
    return { action: 'skip', code: 'SESSION_NOT_CLOSED_YET' };
  if (!onlyDate && !isTradingDay(calendar)) return { action: 'skip', code: 'MARKET_CLOSED_TODAY' };
  return { action: 'skip', code: 'NO_RECENT_SESSION' };
}
export type CalendarSource = {
  marketCalendar(market: MarketCode, date: string): Promise<MarketCalendar>;
};
/** Fetches the calendar around `date` (default: today in the market's time zone). */
export function loadMarketCalendar(
  source: CalendarSource,
  market: MarketCode,
  now: Date,
  date?: string,
): Promise<MarketCalendar> {
  return source.marketCalendar(market, date ?? calendarQueryDate(market, now));
}
