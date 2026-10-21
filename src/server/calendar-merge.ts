import { cleanEvent, type CalendarRepository, type EconomicEvent } from './calendar.js';

/** The provider's own title: the exact original when it was replaced, the title itself otherwise. */
const sourceTitle = (event: EconomicEvent) => event.titleOriginal ?? event.title;

/**
 * Merges a fresh event into the stored one so a re-sync never erases attached values, AI text,
 * translations or enrichment (and never replaces a known release time with "unknown"). Fields the
 * incoming event carries win; fields it lacks are filled from the stored event, never the reverse
 * and never with nulls.
 */
export function mergeStoredEvent(
  stored: EconomicEvent | undefined,
  incoming: EconomicEvent,
): EconomicEvent {
  if (!stored) return incoming;
  const merged: EconomicEvent = { ...incoming };
  if (merged.values === undefined && stored.values) merged.values = stored.values;
  if (merged.indicatorIds === undefined && stored.indicatorIds)
    merged.indicatorIds = stored.indicatorIds;
  if (merged.aiSummary === undefined && stored.aiSummary !== undefined)
    merged.aiSummary = stored.aiSummary;
  // The same provider item: RSS re-delivers the English/uncleaned title every time, while the stored
  // event may carry its Korean title and the enrichment written for it. (Older records kept the
  // provider title in titleOriginal only together with a translation; both shapes match.)
  const sameSource =
    sourceTitle(incoming) === sourceTitle(stored) || incoming.title === stored.titleOriginal;
  if (sameSource) {
    if (incoming.translation === undefined && stored.translation !== undefined) {
      merged.title = stored.title;
      merged.translation = stored.translation;
    }
    if (merged.titleOriginal === undefined && stored.titleOriginal !== undefined)
      merged.titleOriginal = stored.titleOriginal;
    if (merged.releaseType === undefined && stored.releaseType !== undefined)
      merged.releaseType = stored.releaseType;
    if (merged.outcome === undefined && stored.outcome !== undefined)
      merged.outcome = stored.outcome;
    if (merged.reaction === undefined && stored.reaction !== undefined)
      merged.reaction = stored.reaction;
    if (merged.impact === undefined && stored.impact !== undefined) merged.impact = stored.impact;
    if (merged.explainer === undefined && stored.explainer !== undefined)
      merged.explainer = stored.explainer;
    if (merged.enrichment === undefined && stored.enrichment !== undefined)
      merged.enrichment = stored.enrichment;
  }
  if (merged.time === '' && stored.time !== '') merged.time = stored.time;
  return merged;
}
export class PreservingCalendarRepository implements CalendarRepository {
  constructor(private inner: CalendarRepository) {}
  list(from: string, to: string) {
    return this.inner.list(from, to);
  }
  async upsert(events: EconomicEvent[], authorId: string) {
    if (!events.length) return;
    const dates = events.map((event) => event.date).sort();
    const stored = new Map<number, EconomicEvent>();
    for (const record of await this.inner.list(dates[0], dates[dates.length - 1])) {
      const event = cleanEvent(record);
      if (event) stored.set(event.id, event);
    }
    await this.inner.upsert(
      events.map((event) => mergeStoredEvent(stored.get(event.id), event)),
      authorId,
    );
  }
}
