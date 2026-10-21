import type { Firestore } from '@google-cloud/firestore';
import {
  BudgetGuard,
  FirestoreBudgetRepository,
  installBudgetGuard,
} from '../server/budget-guard.js';
import type { JobLogger, JobOutcome } from './runner.js';

/**
 * Monthly budget stop at the start of a job (docs/operations/budget.md). Returns the outcome to
 * finish with when the job must not run, or undefined to go on. It also installs the process-wide
 * guard the AI call sites read, so AI stays blocked (fail closed) even in a job that proceeds.
 *
 * - `failClosed: false` (snapshot, morning, paper, access check): an unreadable flag lets the job
 *   run. These jobs are cheap and a missed snapshot is data that cannot be recovered later.
 * - `failClosed: true` (live trading): an unreadable flag stops the job (exit 1, so it is visible).
 *
 * A skipped job writes no run record on purpose: nothing looks "complete" for that day, so the
 * next scheduled run (after a release or a new billing month) does the work.
 */
export async function gateJob(
  guard: Pick<BudgetGuard, 'status'>,
  log: Pick<JobLogger, 'warn' | 'error'>,
  options: { failClosed: boolean },
): Promise<JobOutcome | undefined> {
  installBudgetGuard(guard);
  const status = await guard.status();
  if (status === 'stopped') {
    log.warn('job-skipped', { code: 'BUDGET_STOPPED' });
    return 'ok';
  }
  if (status === 'unknown') {
    if (options.failClosed) {
      log.error('job-skipped', { code: 'BUDGET_UNKNOWN' });
      return 'failed';
    }
    log.warn('budget-check-failed', { code: 'BUDGET_UNKNOWN' });
  }
  return undefined;
}

/** The entry-point form: reads opsControl/budget through the job's own Firestore client. */
export const budgetJobGate = (
  db: Firestore,
  log: Pick<JobLogger, 'warn' | 'error'>,
  options: { failClosed: boolean },
) => gateJob(new BudgetGuard(new FirestoreBudgetRepository(db)), log, options);
