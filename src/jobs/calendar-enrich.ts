import { pathToFileURL } from 'node:url';
import { Firestore } from '@google-cloud/firestore';
import { FirestoreAiQuota } from '../server/ai.js';
import {
  aiEnvironment,
  createAiProvider,
  emptyUsage,
  type AiEnvironment,
} from '../server/ai-provider.js';
import { PreservingCalendarRepository } from '../server/calendar-merge.js';
import {
  ProviderEnrichAi,
  enrichCalendar,
  type EnrichAi,
  type EnrichDeps,
  type EnrichReport,
} from '../server/calendar-enrich.js';
import {
  FirestoreCalendarEnrichRunRepository,
  type CalendarEnrichRun,
  type CalendarEnrichRunRepository,
} from '../server/calendar-enrich-runs.js';
import { policyFactsProvider, type PolicySource } from '../server/calendar-policy.js';
import { FirestoreCalendarRepository, type CalendarRepository } from '../server/calendar.js';
import { ecosFromEnvironment, fredFromEnvironment } from '../server/macro/index.js';
import { addDays } from '../server/macro/shared.js';
import { ReactionCalculator, type ReactionToss } from '../server/reaction.js';
import { tossFromEnvironment } from '../server/toss.js';
import {
  JobConfigError,
  runJob,
  safeErrorCode,
  type JobLogger,
  type JobOutcome,
} from './runner.js';
import { budgetJobGate } from './budget-gate.js';

/**
 * Calendar enrichment job (manual Cloud Run Job `investing-calendar-enrich`; the morning job runs
 * the same step for new events every day). It needs the fixed egress IP and the Toss secrets
 * because the measured market reaction comes from Toss candles and exchange rates.
 *
 * Steps (src/server/calendar-enrich.ts): deterministic cleanup -> measured reactions -> Korean
 * outcome/impact/explainer by the AI provider. Without Toss the reaction step is skipped, without AI
 * (disabled, daily quota, provider quota, refusal) cleanup and reactions still run and the AI_*
 * code is recorded in the run record `calendarEnrichRuns/{id}`.
 */
export const JOB_NAME = 'calendar-enrich';
export const AUTHOR = 'calendar-enrich-job';
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const PACE_MS = 150;

export type CalendarEnrichOptions = {
  /** Examine events from this KST date. */
  from: string;
  to: string;
  force: boolean;
  maxAiCalls: number;
};
export type CalendarEnrichDependencies = {
  calendar: CalendarRepository;
  runs: CalendarEnrichRunRepository;
  reaction?: EnrichDeps['reaction'];
  ai?: EnrichAi;
  policyFacts?: EnrichDeps['policyFacts'];
  now?: () => Date;
  log: JobLogger;
  options: CalendarEnrichOptions;
};
const kstDate = (at: Date) => new Date(at.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const stamp = (at: Date) =>
  `${kstDate(at)}_${new Date(at.getTime() + 9 * 3_600_000).toISOString().slice(11, 19).replaceAll(':', '')}`;

export async function runCalendarEnrich(deps: CalendarEnrichDependencies): Promise<JobOutcome> {
  const now = deps.now ?? (() => new Date());
  const { log } = deps;
  const started = now();
  const run: CalendarEnrichRun = {
    id: stamp(started),
    date: kstDate(started),
    status: 'running',
    trigger: 'manual',
    startedAt: started.toISOString(),
    finishedAt: null,
    options: deps.options,
    counts: { examined: 0, cleaned: 0, reactions: 0, enriched: 0, rejected: 0 },
    codes: {},
    ai: {
      enabled: deps.ai !== undefined,
      model: deps.ai?.model ?? null,
      calls: 0,
      tokens: emptyUsage(),
    },
  };
  log.info('run-started', { date: run.date, trigger: 'manual' });
  let report: EnrichReport | null = null;
  try {
    report = await enrichCalendar(
      {
        calendar: new PreservingCalendarRepository(deps.calendar),
        reaction: deps.reaction,
        ai: deps.ai,
        policyFacts: deps.policyFacts,
        now,
        author: AUTHOR,
      },
      deps.options,
    );
  } catch (error) {
    run.codes[safeErrorCode(error)] = 1;
  }
  if (report) {
    run.counts = {
      examined: report.examined,
      cleaned: report.cleaned,
      reactions: report.reactions,
      enriched: report.enriched,
      rejected: report.rejected,
    };
    run.codes = report.codes;
    run.ai.calls = report.aiCalls;
    run.ai.tokens = report.usage;
  }
  const worked = report ? report.cleaned + report.reactions + report.enriched > 0 : false;
  run.status = !report
    ? 'failed'
    : report.failures.length
      ? worked
        ? 'partial'
        : 'failed'
      : 'complete';
  run.finishedAt = now().toISOString();
  let outcome: JobOutcome =
    run.status === 'complete' ? 'ok' : run.status === 'partial' ? 'partial' : 'failed';
  try {
    await deps.runs.saveRun(run);
  } catch (error) {
    log.error('run-record-failed', { date: run.date, code: safeErrorCode(error) });
    outcome = 'failed';
  }
  log.info('run-finished', {
    date: run.date,
    status: run.status,
    count: run.counts.enriched,
    codes: run.codes,
  });
  return outcome;
}

// ---------------------------------------------------------------------------
// Wiring shared with the morning job.
// ---------------------------------------------------------------------------
/** Everything enrichCalendar needs besides the calendar itself, built from the environment. */
export function enrichmentCollaborators(
  env: NodeJS.ProcessEnv,
  db: Firestore,
  ai: AiEnvironment | null,
  overrides: { toss?: ReactionToss | null } = {},
): Pick<EnrichDeps, 'reaction' | 'ai' | 'policyFacts'> {
  const toss =
    overrides.toss === undefined
      ? (tossFromEnvironment(true) as ReactionToss | undefined)
      : overrides.toss;
  const fred = fredFromEnvironment(env) as PolicySource | undefined;
  const ecos = ecosFromEnvironment(env) as PolicySource | undefined;
  return {
    reaction: toss ? new ReactionCalculator(toss, { paceMs: PACE_MS }) : undefined,
    ai: ai
      ? new ProviderEnrichAi(createAiProvider(ai), new FirestoreAiQuota(db, 'calendar'))
      : undefined,
    policyFacts:
      fred || ecos
        ? policyFactsProvider({ fred, ecos, today: () => kstDate(new Date()) })
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------
export type CalendarEnrichConfiguration = {
  project: string;
  options: Omit<CalendarEnrichOptions, 'from' | 'to'> & { days: number; from?: string };
  /** Non-null only when CALENDAR_AI_ENABLED=true (and the provider is fully configured). */
  ai: AiEnvironment | null;
};
/**
 * Only runs as a Cloud Run Job in an explicit project. AI is on only when CALENDAR_AI_ENABLED is
 * exactly "true"; any other non-empty value besides "false" is a configuration error. Options:
 * CALENDAR_ENRICH_FORCE=1, CALENDAR_ENRICH_FROM=YYYY-MM-DD (default: 400 days back),
 * CALENDAR_ENRICH_MAX_AI_CALLS=1..20 (default 15, i.e. up to 150 events).
 */
export function calendarEnrichConfiguration(env: NodeJS.ProcessEnv): CalendarEnrichConfiguration {
  const project = env.GOOGLE_CLOUD_PROJECT;
  if (env.NODE_ENV !== 'production' || !env.CLOUD_RUN_JOB || !project || !PROJECT.test(project))
    throw new JobConfigError();
  const flag = env.CALENDAR_AI_ENABLED;
  if (flag !== undefined && flag !== '' && flag !== 'true' && flag !== 'false')
    throw new JobConfigError();
  let ai: AiEnvironment | null = null;
  if (flag === 'true') {
    ai = aiEnvironment(env);
    if (!ai) throw new JobConfigError();
  }
  const options: CalendarEnrichConfiguration['options'] = {
    force: false,
    maxAiCalls: 15,
    days: 400,
  };
  if (env.CALENDAR_ENRICH_FORCE) {
    if (env.CALENDAR_ENRICH_FORCE !== '1') throw new JobConfigError();
    options.force = true;
  }
  if (env.CALENDAR_ENRICH_FROM) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(env.CALENDAR_ENRICH_FROM)) throw new JobConfigError();
    options.from = env.CALENDAR_ENRICH_FROM;
  }
  if (env.CALENDAR_ENRICH_MAX_AI_CALLS) {
    const value = Number(env.CALENDAR_ENRICH_MAX_AI_CALLS);
    if (!/^\d{1,2}$/.test(env.CALENDAR_ENRICH_MAX_AI_CALLS) || value < 1 || value > 20)
      throw new JobConfigError();
    options.maxAiCalls = value;
  }
  return { project, options, ai };
}
export async function main(env: NodeJS.ProcessEnv = process.env) {
  return runJob(JOB_NAME, async ({ log }) => {
    const config = calendarEnrichConfiguration(env);
    const db = new Firestore({ projectId: config.project });
    try {
      // Monthly budget stop (also installs the AI gate the provider reads; docs/operations/budget.md).
      const skipped = await budgetJobGate(db, log, { failClosed: false });
      if (skipped) return skipped;
      const today = kstDate(new Date());
      return await runCalendarEnrich({
        calendar: new FirestoreCalendarRepository(db),
        runs: new FirestoreCalendarEnrichRunRepository(db),
        ...enrichmentCollaborators(env, db, config.ai),
        log,
        options: {
          from: config.options.from ?? addDays(today, -config.options.days),
          to: today,
          force: config.options.force,
          maxAiCalls: config.options.maxAiCalls,
        },
      });
    } finally {
      await db.terminate();
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
