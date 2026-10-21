import type { EconomicEvent } from './calendar.js';
import type { EnrichFact } from './calendar-enrich.js';
import { addDays } from './macro/shared.js';

/**
 * Official policy-rate facts for rate-decision releases (deterministic, no AI): the Fed's FOMC
 * statement from the FRED target-range series and the Bank of Korea's rate decision from ECOS.
 * The level is read as known right after the decision and right before it, so "동결"/"인상"/"인하"
 * and the change in bp are differences of two official observations, never a model's guess. Only
 * runs when the matching adapter is configured; no value is returned when either observation is
 * missing or does not belong to this decision.
 *
 * Release-day rules (the event date is the KST date of the press release):
 *   Fed: the statement comes out at 14:00 ET, i.e. KST date D = ET date D-1. FRED shows the new
 *        range from D, so "after" = latest observation as of D+3 that is dated D..D+5, and "before"
 *        = latest observation as of D-2 that is dated at most 12 days earlier.
 *   BOK: ECOS shows the new rate from the decision day D: "after" = latest as of D+2 dated D..D+5,
 *        "before" = latest as of D-1.
 */
type Observation = { date: string; value: string | null };
type Latest = { id: string; latest: Observation | null; previous: Observation | null };
export type PolicySource = {
  latestObservations(ids: string[], asOf: string): Promise<Latest[]>;
};
const dayGap = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
const number = (value: string | null) => {
  if (value === null || !/^-?\d{1,3}(?:\.\d{1,4})?$/.test(value)) return null;
  return Number(value);
};
const bp = (diff: number) => Math.round(diff * 100);
const change = (before: number[], after: number[]): string => {
  const moves = after.map((value, index) => bp(value - before[index]));
  if (moves.every((move) => move === 0)) return '동결(0bp)';
  const move = moves.find((value) => value !== 0)!;
  return `${move > 0 ? '인상' : '인하'} ${Math.abs(move)}bp`;
};

export function isFedDecision(event: EconomicEvent) {
  return event.country === '미국' && /\bFOMC statement\b/i.test(event.titleOriginal ?? event.title);
}
export function isBokDecision(event: EconomicEvent) {
  const title = event.title;
  return (
    event.country === '한국' && /통화정책방향/.test(title) && !/의사록|설명|일정|간담회/.test(title)
  );
}
export function policyFactsProvider(deps: {
  fred?: PolicySource;
  ecos?: PolicySource;
  today: () => string;
}) {
  const pair = async (
    source: PolicySource,
    ids: string[],
    asOf: string,
  ): Promise<Map<string, Observation | null>> =>
    new Map((await source.latestObservations(ids, asOf)).map((row) => [row.id, row.latest]));
  return async (event: EconomicEvent): Promise<EnrichFact[]> => {
    const today = deps.today();
    if (isFedDecision(event) && deps.fred) {
      const afterAsOf = addDays(event.date, 3) <= today ? addDays(event.date, 3) : today;
      if (dayGap(event.date, afterAsOf) < 0) return [];
      const ids = ['us-fed-funds-lower', 'us-fed-funds-upper'];
      const after = await pair(deps.fred, ids, afterAsOf);
      const before = await pair(deps.fred, ids, addDays(event.date, -2));
      const read = (map: Map<string, Observation | null>) => ids.map((id) => map.get(id) ?? null);
      const [afterLower, afterUpper] = read(after);
      const [beforeLower, beforeUpper] = read(before);
      if (!afterLower || !afterUpper || !beforeLower || !beforeUpper) return [];
      const dates = [afterLower.date, afterUpper.date];
      if (dates.some((date) => dayGap(event.date, date) < 0 || dayGap(event.date, date) > 5))
        return [];
      if ([beforeLower.date, beforeUpper.date].some((date) => dayGap(date, event.date) > 14))
        return [];
      const nums = [afterLower, afterUpper, beforeLower, beforeUpper].map((row) =>
        number(row.value),
      );
      if (nums.some((value) => value === null)) return [];
      const [aLow, aUp, bLow, bUp] = nums as number[];
      return [
        {
          label: '연방기금금리 목표 범위',
          value: `${afterLower.value}~${afterUpper.value}%`,
          note: `출처: FRED, ${afterLower.date} 기준`,
        },
        { label: '변동', value: change([bLow, bUp], [aLow, aUp]) },
      ];
    }
    if (isBokDecision(event) && deps.ecos) {
      const afterAsOf = addDays(event.date, 2) <= today ? addDays(event.date, 2) : today;
      if (dayGap(event.date, afterAsOf) < 0) return [];
      const ids = ['kr-base-rate'];
      const after = (await pair(deps.ecos, ids, afterAsOf)).get('kr-base-rate') ?? null;
      const before =
        (await pair(deps.ecos, ids, addDays(event.date, -1))).get('kr-base-rate') ?? null;
      if (!after || !before) return [];
      if (dayGap(event.date, after.date) < 0 || dayGap(event.date, after.date) > 5) return [];
      if (dayGap(before.date, event.date) > 60) return [];
      const a = number(after.value);
      const b = number(before.value);
      if (a === null || b === null) return [];
      return [
        {
          label: '기준금리',
          value: `${after.value}%`,
          note: `출처: 한국은행 ECOS, ${after.date} 기준`,
        },
        { label: '변동', value: change([b], [a]) },
      ];
    }
    return [];
  };
}
