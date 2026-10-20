import { describe, expect, it, vi } from 'vitest';
import type { MarketCalendar, MarketCode, MarketDay } from '../src/server/toss';
import {
  calendarQueryDate,
  formatKst,
  isTradingDay,
  isWithinMinutesAfterClose,
  isWithinMinutesAfterOpen,
  kstDate,
  loadMarketCalendar,
  localDate,
  selectSessionToSnapshot,
  sessionsOf,
} from '../src/jobs/market-session';

const day = (date: string, regular: [string, string] | null): MarketDay => ({
  date,
  regularMarket: regular ? { startTime: regular[0], endTime: regular[1] } : null,
});
const calendar = (
  market: MarketCode,
  requestedDate: string,
  previous: MarketDay,
  today: MarketDay,
  next: MarketDay,
): MarketCalendar => ({
  source: 'fixture',
  asOf: '2026-10-21T00:00:00Z',
  market,
  requestedDate,
  previousBusinessDay: previous,
  today,
  nextBusinessDay: next,
});
const kr = (
  date: string,
  today: [string, string] | null = [`${date}T09:00:00+09:00`, `${date}T15:30:00+09:00`],
) =>
  calendar(
    'KR',
    date,
    day('2026-10-20', ['2026-10-20T09:00:00+09:00', '2026-10-20T15:30:00+09:00']),
    day(date, today),
    day('2026-10-22', ['2026-10-22T09:00:00+09:00', '2026-10-22T15:30:00+09:00']),
  );
// Synthetic US sessions shifted into KST by the provider: summer 22:30-05:00, winter 23:30-06:00.
const usSummer = calendar(
  'US',
  '2026-10-20',
  day('2026-10-19', ['2026-10-19T22:30:00+09:00', '2026-10-20T05:00:00+09:00']),
  day('2026-10-20', ['2026-10-20T22:30:00+09:00', '2026-10-21T05:00:00+09:00']),
  day('2026-10-21', ['2026-10-21T22:30:00+09:00', '2026-10-22T05:00:00+09:00']),
);
const usWinter = calendar(
  'US',
  '2026-12-01',
  day('2026-11-30', ['2026-11-30T23:30:00+09:00', '2026-12-01T06:00:00+09:00']),
  day('2026-12-01', ['2026-12-01T23:30:00+09:00', '2026-12-02T06:00:00+09:00']),
  day('2026-12-02', ['2026-12-02T23:30:00+09:00', '2026-12-03T06:00:00+09:00']),
);
const at = (value: string) => new Date(value);

describe('market-local dates', () => {
  it('uses the US local date for the US calendar query across daylight saving time', () => {
    // 06:30 KST is still the previous US day, in summer (EDT) and winter (EST) alike.
    expect(calendarQueryDate('US', at('2026-10-21T06:30:00+09:00'))).toBe('2026-10-20');
    expect(calendarQueryDate('US', at('2026-12-02T06:30:00+09:00'))).toBe('2026-12-01');
    expect(calendarQueryDate('KR', at('2026-10-21T06:30:00+09:00'))).toBe('2026-10-21');
  });
  it('follows the DST end (2026-11-01) and start (2026-03-08) transitions', () => {
    expect(localDate(at('2026-11-02T06:30:00+09:00'), 'America/New_York')).toBe('2026-11-01');
    expect(localDate(at('2026-11-01T06:30:00+09:00'), 'America/New_York')).toBe('2026-10-31');
    // After DST starts the same KST clock time is one hour earlier in New York but the date holds.
    expect(localDate(at('2026-03-09T06:30:00+09:00'), 'America/New_York')).toBe('2026-03-08');
    expect(localDate(at('2026-03-10T06:30:00+09:00'), 'America/New_York')).toBe('2026-03-09');
    // Just before and after the instant clocks change in New York.
    expect(localDate(at('2026-03-08T06:59:00Z'), 'America/New_York')).toBe('2026-03-08');
    expect(localDate(at('2026-03-08T07:00:00Z'), 'America/New_York')).toBe('2026-03-08');
  });
  it('formats KST wall-clock times and dates', () => {
    expect(formatKst(at('2026-10-20T20:00:00Z'))).toBe('2026-10-21 05:00');
    expect(kstDate(at('2026-10-20T15:30:00Z'))).toBe('2026-10-21');
  });
});

describe('trading day and sessions', () => {
  it('recognizes a trading day and a holiday', () => {
    expect(isTradingDay(kr('2026-10-21'))).toBe(true);
    expect(isTradingDay(kr('2026-10-21', null))).toBe(false);
  });
  it('treats a nearest-business-day answer for a holiday as not trading', () => {
    const holiday = calendar(
      'KR',
      '2026-10-24',
      day('2026-10-23', ['2026-10-23T09:00:00+09:00', '2026-10-23T15:30:00+09:00']),
      day('2026-10-26', ['2026-10-26T09:00:00+09:00', '2026-10-26T15:30:00+09:00']),
      day('2026-10-27', ['2026-10-27T09:00:00+09:00', '2026-10-27T15:30:00+09:00']),
    );
    expect(isTradingDay(holiday)).toBe(false);
  });
  it('lists regular sessions oldest first and skips closed days', () => {
    const sessions = sessionsOf(kr('2026-10-21', null));
    expect(sessions.map((s) => s.date)).toEqual(['2026-10-20', '2026-10-22']);
    expect(sessions[0].close.toISOString()).toBe('2026-10-20T06:30:00.000Z');
  });
  it('knows within-N-minutes after the close and after the open', () => {
    const [session] = sessionsOf(kr('2026-10-21')).filter((s) => s.date === '2026-10-21');
    expect(isWithinMinutesAfterClose(at('2026-10-21T15:29:00+09:00'), session, 30)).toBe(false);
    expect(isWithinMinutesAfterClose(at('2026-10-21T15:30:00+09:00'), session, 30)).toBe(true);
    expect(isWithinMinutesAfterClose(at('2026-10-21T16:00:00+09:00'), session, 30)).toBe(true);
    expect(isWithinMinutesAfterClose(at('2026-10-21T16:01:00+09:00'), session, 30)).toBe(false);
    expect(isWithinMinutesAfterOpen(at('2026-10-21T08:59:00+09:00'), session, 10)).toBe(false);
    expect(isWithinMinutesAfterOpen(at('2026-10-21T09:05:00+09:00'), session, 10)).toBe(true);
    expect(isWithinMinutesAfterOpen(at('2026-10-21T09:11:00+09:00'), session, 10)).toBe(false);
  });
});

describe('which session to snapshot', () => {
  it('KR: runs after the close, waits until data settles, skips holidays', () => {
    const run = selectSessionToSnapshot(kr('2026-10-21'), at('2026-10-21T16:30:00+09:00'));
    expect(run).toMatchObject({ action: 'run', session: { date: '2026-10-21' } });
    expect(selectSessionToSnapshot(kr('2026-10-21'), at('2026-10-21T15:40:00+09:00'))).toEqual({
      action: 'skip',
      code: 'SESSION_NOT_CLOSED_YET',
    });
    expect(selectSessionToSnapshot(kr('2026-10-21'), at('2026-10-21T11:00:00+09:00'))).toEqual({
      action: 'skip',
      code: 'SESSION_NOT_CLOSED_YET',
    });
    expect(
      selectSessionToSnapshot(kr('2026-10-21', null), at('2026-10-21T16:30:00+09:00')),
    ).toEqual({
      action: 'skip',
      code: 'MARKET_CLOSED_TODAY',
    });
  });
  it('KR: the morning US slot does not pick up yesterday KR session', () => {
    expect(selectSessionToSnapshot(kr('2026-10-21'), at('2026-10-21T06:30:00+09:00'))).toEqual({
      action: 'skip',
      code: 'NO_RECENT_SESSION',
    });
  });
  it('US summer time: both 06:30 and 07:30 KST pick the 05:00 KST close, 16:30 KST does not', () => {
    for (const time of ['2026-10-21T06:30:00+09:00', '2026-10-21T07:30:00+09:00'])
      expect(selectSessionToSnapshot(usSummer, at(time))).toMatchObject({
        action: 'run',
        session: { date: '2026-10-20' },
      });
    expect(selectSessionToSnapshot(usSummer, at('2026-10-21T16:30:00+09:00'))).toEqual({
      action: 'skip',
      code: 'NO_RECENT_SESSION',
    });
  });
  it('US winter time: the 06:00 KST close makes 06:30 just late enough and 06:10 too early', () => {
    expect(selectSessionToSnapshot(usWinter, at('2026-12-02T06:30:00+09:00'))).toMatchObject({
      action: 'run',
      session: { date: '2026-12-01' },
    });
    expect(selectSessionToSnapshot(usWinter, at('2026-12-02T06:10:00+09:00'))).toEqual({
      action: 'skip',
      code: 'SESSION_NOT_CLOSED_YET',
    });
    expect(selectSessionToSnapshot(usWinter, at('2026-12-02T07:30:00+09:00'))).toMatchObject({
      action: 'run',
    });
  });
  it('US half day: an early 03:00 KST close is picked up by both morning slots', () => {
    const halfDay = calendar(
      'US',
      '2026-11-27',
      day('2026-11-25', ['2026-11-25T23:30:00+09:00', '2026-11-26T06:00:00+09:00']),
      day('2026-11-27', ['2026-11-27T23:30:00+09:00', '2026-11-28T03:00:00+09:00']),
      day('2026-11-30', ['2026-11-30T23:30:00+09:00', '2026-12-01T06:00:00+09:00']),
    );
    expect(selectSessionToSnapshot(halfDay, at('2026-11-28T06:30:00+09:00'))).toMatchObject({
      action: 'run',
      session: { date: '2026-11-27' },
    });
    expect(selectSessionToSnapshot(halfDay, at('2026-11-28T07:30:00+09:00'))).toMatchObject({
      action: 'run',
      session: { date: '2026-11-27' },
    });
  });
  it('US holiday: no session today and nothing recent means a skip, not a run', () => {
    const holiday = calendar(
      'US',
      '2026-11-26',
      day('2026-11-25', ['2026-11-25T23:30:00+09:00', '2026-11-26T06:00:00+09:00']),
      day('2026-11-26', null),
      day('2026-11-27', ['2026-11-27T23:30:00+09:00', '2026-11-28T03:00:00+09:00']),
    );
    expect(selectSessionToSnapshot(holiday, at('2026-11-27T06:30:00+09:00'))).toEqual({
      action: 'skip',
      code: 'MARKET_CLOSED_TODAY',
    });
  });
  it('a manual date restricts the choice to that session', () => {
    const now = at('2026-10-21T16:30:00+09:00');
    expect(selectSessionToSnapshot(kr('2026-10-21'), now, undefined, '2026-10-21')).toMatchObject({
      action: 'run',
    });
    // An older date is allowed for backfills; a date the calendar does not list is not.
    expect(selectSessionToSnapshot(kr('2026-10-21'), now, undefined, '2026-10-20')).toMatchObject({
      action: 'run',
      session: { date: '2026-10-20' },
    });
    expect(selectSessionToSnapshot(kr('2026-10-21'), now, undefined, '2026-10-19')).toEqual({
      action: 'skip',
      code: 'NO_RECENT_SESSION',
    });
  });
  it('asks the provider for the market-local date', async () => {
    const source = { marketCalendar: vi.fn(async () => usSummer) };
    await loadMarketCalendar(source, 'US', at('2026-10-21T06:30:00+09:00'));
    expect(source.marketCalendar).toHaveBeenCalledWith('US', '2026-10-20');
    await loadMarketCalendar(source, 'KR', at('2026-10-21T16:30:00+09:00'), '2026-10-01');
    expect(source.marketCalendar).toHaveBeenLastCalledWith('KR', '2026-10-01');
  });
});
