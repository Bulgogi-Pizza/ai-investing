import { FieldPath, Firestore } from '@google-cloud/firestore';
import { Router } from 'express';
import { ownerGate } from './owner.js';

/**
 * Morning calendar job records (stage 6b). Server-only collection, no TTL:
 *
 *   morningRuns/{YYYY-MM-DD}   one run record per KST date, including the stored brief shown in the UI
 *
 * The record holds status codes, counts and the brief text only: never provider payloads, keys or
 * error messages.
 */
export type MorningStepStatus = 'ok' | 'failed' | 'skipped' | 'disabled';
export type MorningStep = {
  status: MorningStepStatus;
  /** Items handled (events upserted, values attached, summaries stored, ...). */
  count: number;
  /** Sanitized codes (upper snake case) with counts. */
  codes: Record<string, number>;
};
export type MorningRunStatus = 'running' | 'complete' | 'partial' | 'failed';
export type MorningBrief = {
  text: string;
  generatedAt: string;
  /** True when at least one AI-written summary is part of the brief. */
  aiUsed: boolean;
};
export type MorningRun = {
  id: string;
  /** KST date the run is for. */
  date: string;
  status: MorningRunStatus;
  trigger: 'scheduler' | 'manual';
  attempts: number;
  startedAt: string;
  finishedAt: string | null;
  steps: Record<string, MorningStep>;
  ai: {
    enabled: boolean;
    model: string | null;
    calls: number;
    /** Token counts the provider reported (numbers only), summed over calls. */
    tokens: { prompt: number; output: number; thoughts: number; total: number };
  };
  brief: MorningBrief | null;
  notification: { status: 'sent' | 'failed' | 'disabled'; failureCode: string | null } | null;
};
export type MorningBeginResult = { state: 'started' | 'complete' | 'running'; attempts: number };
export interface MorningRunRepository {
  /** Starts (or restarts) the day unless it is complete or running; stale "running" is taken over. */
  beginRun(
    run: MorningRun,
    options: { nowMs: number; staleAfterMs: number; force: boolean },
  ): Promise<MorningBeginResult>;
  /** Persists progress/final state of a started run. */
  saveRun(run: MorningRun): Promise<void>;
  getRun(date: string): Promise<MorningRun | null>;
  /** Newest runs first. */
  listRuns(limit: number): Promise<MorningRun[]>;
}
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export function decideMorningBegin(
  existing: MorningRun | null,
  options: { nowMs: number; staleAfterMs: number; force: boolean },
): MorningBeginResult['state'] {
  if (!existing) return 'started';
  if (existing.status === 'complete' && !options.force) return 'complete';
  if (
    existing.status === 'running' &&
    options.nowMs - Date.parse(existing.startedAt) < options.staleAfterMs
  )
    return 'running';
  return 'started';
}
export class MemoryMorningRunRepository implements MorningRunRepository {
  readonly runs = new Map<string, MorningRun>();
  async beginRun(
    run: MorningRun,
    options: { nowMs: number; staleAfterMs: number; force: boolean },
  ): Promise<MorningBeginResult> {
    const existing = this.runs.get(run.id) ?? null;
    const state = decideMorningBegin(existing, options);
    const attempts = (existing?.attempts ?? 0) + (state === 'started' ? 1 : 0);
    // A restart keeps what an earlier attempt already achieved (a sent brief is not sent again).
    if (state === 'started')
      this.runs.set(
        run.id,
        plain({
          ...run,
          attempts,
          notification: options.force ? null : (existing?.notification ?? null),
        }),
      );
    return { state, attempts };
  }
  async saveRun(run: MorningRun) {
    this.runs.set(run.id, plain(run));
  }
  async getRun(date: string) {
    return plain(this.runs.get(date) ?? null);
  }
  async listRuns(limit: number) {
    return plain(
      [...this.runs.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit),
    );
  }
}
export class FirestoreMorningRunRepository implements MorningRunRepository {
  constructor(private db = new Firestore()) {}
  private collection() {
    return this.db.collection('morningRuns');
  }
  async beginRun(
    run: MorningRun,
    options: { nowMs: number; staleAfterMs: number; force: boolean },
  ): Promise<MorningBeginResult> {
    const ref = this.collection().doc(run.id);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const existing = snapshot.exists ? (snapshot.data() as MorningRun) : null;
      const state = decideMorningBegin(existing, options);
      const attempts = (existing?.attempts ?? 0) + (state === 'started' ? 1 : 0);
      if (state === 'started')
        tx.set(
          ref,
          plain({
            ...run,
            attempts,
            notification: options.force ? null : (existing?.notification ?? null),
          }),
        );
      return { state, attempts };
    });
  }
  async saveRun(run: MorningRun) {
    await this.collection().doc(run.id).set(plain(run));
  }
  async getRun(date: string) {
    const doc = await this.collection().doc(date).get();
    return doc.exists ? (doc.data() as MorningRun) : null;
  }
  async listRuns(limit: number) {
    const result = await this.collection()
      .orderBy(FieldPath.documentId(), 'desc')
      .limit(limit)
      .get();
    return result.docs.map((doc) => doc.data() as MorningRun);
  }
}

/** Owner-only: the newest stored morning brief (text and time only). */
export function createMorningRouter({
  repository,
  ownerUserId,
}: {
  repository: MorningRunRepository;
  ownerUserId?: string;
}) {
  const router = Router();
  router.use('/api/calendar/brief', (_req, res, next) => {
    if (!res.locals.user || res.locals.user.active === false) {
      res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: '로그인이 필요합니다.' } });
      return;
    }
    next();
  });
  router.use('/api/calendar/brief', ownerGate(ownerUserId));
  router.get('/api/calendar/brief', async (_req, res) => {
    try {
      const runs = await repository.listRuns(7);
      const run = runs.find((candidate) => candidate.brief !== null);
      res.set('Cache-Control', 'no-store');
      res.json({
        brief: run?.brief
          ? {
              date: run.date,
              text: run.brief.text,
              generatedAt: run.brief.generatedAt,
              aiUsed: run.brief.aiUsed,
            }
          : null,
      });
    } catch {
      res.status(503).json({
        error: { code: 'BRIEF_UNAVAILABLE', message: '아침 브리핑을 불러오지 못했습니다.' },
      });
    }
  });
  return router;
}
