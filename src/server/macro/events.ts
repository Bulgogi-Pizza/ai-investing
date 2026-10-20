import { createHash } from 'node:crypto';
import { cleanEvent, type EconomicEvent } from '../calendar.js';
import { releaseCatalog } from './catalog.js';
import type { ReleaseDate } from './fred.js';

/**
 * Bridge to the calendar model for the morning job (6b). FRED gives release dates only: no time of
 * day and no time zone, so a release cannot become an EconomicEvent until the caller supplies the
 * KST date and time. The draft keeps the provider date as `releaseDate` to make that explicit.
 */
export type MacroEventDraft = Omit<EconomicEvent, 'id' | 'date' | 'time'> & {
  /** FRED release date as delivered (calendar date; time zone not documented by FRED). */
  releaseDate: string;
  idKey: string;
};

/**
 * Deterministic positive integer id for upsert (same release + date -> same id). 48-bit hash
 * offset by 1e15 so it cannot collide with small manually entered ids; collisions between two
 * macro events are astronomically unlikely but not impossible.
 */
export function macroEventId(idKey: string): number {
  const digest = createHash('sha256').update(idKey).digest();
  return 1_000_000_000_000_000 + digest.readUIntBE(0, 6);
}

export function releaseEventDraft(release: ReleaseDate, observedAt: Date): MacroEventDraft | null {
  const entry = releaseCatalog().find((candidate) => candidate.releaseId === release.releaseId);
  if (!entry) return null;
  return {
    eventKind: 'scheduled',
    releaseDate: release.date,
    idKey: `fred-release:${release.releaseId}:${release.date}`,
    title: entry.titleKo,
    country: '미국',
    category: entry.category,
    assets: entry.assets,
    // The morning job attaches the released values of these catalog indicators after the date.
    indicatorIds: release.indicatorIds,
    importance: entry.importance,
    description: `FRED 발표 일정(${entry.releaseName}). 발표 시각은 제공되지 않는다. 대상 지표: ${release.indicatorIds.join(', ')}.`,
    sourceUrl: entry.sourceUrl,
    sourceName: 'FRED',
    impactDirection: 'unknown',
    impactHorizon: '발표 직후~수 거래일',
    confidence: 'low',
    factualObservedAt: observedAt.toISOString(),
  };
}

/** Completes a draft with the caller's KST date/time; returns null if the calendar rejects it. */
export function toEconomicEvent(
  draft: MacroEventDraft,
  kst: { date: string; time: string },
): EconomicEvent | null {
  const { releaseDate: _releaseDate, idKey, ...rest } = draft;
  return cleanEvent({ ...rest, id: macroEventId(idKey), date: kst.date, time: kst.time });
}
