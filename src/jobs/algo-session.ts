import type { MarketCalendar } from '../server/toss.js';
import { isTradingDay, minutesBetween, sessionsOf, type Session } from './market-session.js';

/**
 * Which market session (if any) the algorithm job may trade "now". Scheduler slots are only
 * triggers: KR fires at 09:05 KST, US at 22:35 and 23:35 KST. The regular open and every holiday,
 * half day and daylight-saving shift come from the Toss market calendar, so a US slot that does not
 * fall right after the actual open (the wrong one of the two) finds nothing to do.
 */
export const DEFAULT_OPEN_WINDOW_MINUTES = 20;

export type OpenSkipCode =
  'MARKET_CLOSED_TODAY' | 'NO_SESSION' | 'SESSION_NOT_OPEN_YET' | 'OUTSIDE_OPEN_WINDOW';
export type OpenDecision =
  { action: 'run'; session: Session } | { action: 'skip'; code: OpenSkipCode };

/** Run only from the regular open until `windowMinutes` minutes after it, on today's session. */
export function selectSessionToTrade(
  calendar: MarketCalendar,
  now: Date,
  windowMinutes: number = DEFAULT_OPEN_WINDOW_MINUTES,
): OpenDecision {
  if (!isTradingDay(calendar)) return { action: 'skip', code: 'MARKET_CLOSED_TODAY' };
  const session = sessionsOf(calendar).find((s) => s.date === calendar.today.date);
  if (!session) return { action: 'skip', code: 'NO_SESSION' };
  const elapsed = minutesBetween(session.open, now);
  if (elapsed < 0) return { action: 'skip', code: 'SESSION_NOT_OPEN_YET' };
  if (elapsed > windowMinutes || now.getTime() >= session.close.getTime())
    return { action: 'skip', code: 'OUTSIDE_OPEN_WINDOW' };
  return { action: 'run', session };
}
