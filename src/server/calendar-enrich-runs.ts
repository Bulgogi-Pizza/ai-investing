import { Firestore } from '@google-cloud/firestore';
import type { AiUsage } from './ai-provider.js';

/**
 * Run records of the calendar-enrich job. Server-only collection, no TTL:
 *
 *   calendarEnrichRuns/{YYYY-MM-DD}_{HHmmss}   one record per execution (the job is run by hand)
 *
 * Counts and sanitized codes only: never provider payloads, event text, keys or error messages.
 */
export type CalendarEnrichRun = {
  id: string;
  /** KST date of the start. */
  date: string;
  status: 'running' | 'complete' | 'partial' | 'failed';
  trigger: 'manual';
  startedAt: string;
  finishedAt: string | null;
  options: { from: string; to: string; force: boolean; maxAiCalls: number };
  counts: {
    examined: number;
    cleaned: number;
    reactions: number;
    enriched: number;
    rejected: number;
  };
  /** Sanitized codes (upper snake case) with counts: AI_*, FX_*, REACTION_*, TOSS_NOT_CONFIGURED, ... */
  codes: Record<string, number>;
  ai: { enabled: boolean; model: string | null; calls: number; tokens: AiUsage };
};
export interface CalendarEnrichRunRepository {
  saveRun(run: CalendarEnrichRun): Promise<void>;
  /** Newest first. */
  listRuns(limit: number): Promise<CalendarEnrichRun[]>;
}
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export class MemoryCalendarEnrichRunRepository implements CalendarEnrichRunRepository {
  readonly runs = new Map<string, CalendarEnrichRun>();
  async saveRun(run: CalendarEnrichRun) {
    this.runs.set(run.id, plain(run));
  }
  async listRuns(limit: number) {
    return plain(
      [...this.runs.values()]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit),
    );
  }
}
export class FirestoreCalendarEnrichRunRepository implements CalendarEnrichRunRepository {
  constructor(private db = new Firestore()) {}
  private collection() {
    return this.db.collection('calendarEnrichRuns');
  }
  async saveRun(run: CalendarEnrichRun) {
    await this.collection().doc(run.id).set(plain(run));
  }
  async listRuns(limit: number) {
    const snapshot = await this.collection().orderBy('startedAt', 'desc').limit(limit).get();
    return snapshot.docs.map((doc) => doc.data() as CalendarEnrichRun);
  }
}
