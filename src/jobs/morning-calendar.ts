import { pathToFileURL } from 'node:url';
import { Firestore } from '@google-cloud/firestore';
import { FirestoreAiQuota } from '../server/ai.js';
import {
  MorningAiError,
  ProviderMorningAi,
  MORNING_MAX_SUMMARY_ITEMS,
  MORNING_MAX_TRANSLATION_ITEMS,
  morningAiConfigFromEnvironment,
  type MorningAi,
  type MorningUsage,
} from '../server/ai-morning.js';
import { createAiProvider, type AiEnvironment } from '../server/ai-provider.js';
import { enrichCalendar, type EnrichReport } from '../server/calendar-enrich.js';
import { enrichmentCollaborators } from './calendar-enrich.js';
import { PreservingCalendarRepository } from '../server/calendar-merge.js';
import {
  FirestoreCalendarRepository,
  cleanEvent,
  type CalendarRepository,
  type EconomicEvent,
  type EventValue,
} from '../server/calendar.js';
import {
  ecosFromEnvironment,
  fredFromEnvironment,
  indicatorById,
  releaseEventDraft,
  toEconomicEvent,
  type EcosAdapter,
  type FredAdapter,
  type Indicator,
} from '../server/macro/index.js';
import { addDays, dayDifference } from '../server/macro/shared.js';
import {
  FirestoreMorningRunRepository,
  type MorningRun,
  type MorningRunRepository,
  type MorningStep,
} from '../server/morning.js';
import { syncOfficialNews } from '../server/news.js';
import {
  FirestoreNotificationRepository,
  NotificationService,
  notifierFromEnvironment,
  sanitizeNotificationText,
  validAppOrigin,
  type NotifyOutcome,
} from '../server/notify.js';
import {
  JobConfigError,
  runJob,
  safeErrorCode,
  type JobLogger,
  type JobOutcome,
} from './runner.js';
import { budgetJobGate } from './budget-gate.js';

export const JOB_NAME = 'morning-calendar';
const AUTHOR = 'morning-calendar-job';

export type MorningFred = Pick<FredAdapter, 'upcomingReleases' | 'latestObservations'>;
export type MorningEcos = Pick<EcosAdapter, 'latestObservations'>;
export type MorningNotifier = Pick<NotificationService, 'notify'>;
export type MorningOptions = {
  trigger: 'scheduler' | 'manual';
  /** Run a day that already completed again. */
  force: boolean;
  /** Treat this KST date as "today" (manual backfill). */
  date?: string;
  /** Released values are attached to events of the last N days. */
  pastDays: number;
  /** Upcoming release dates are fetched N days ahead. */
  aheadDays: number;
  /** AI summaries are written for results of the last N days that have none yet. */
  summaryDays: number;
  /** Calendar enrichment looks at events of the last N days (the calendar-enrich job backfills older ones). */
  enrichDays: number;
  /** A "running" record older than this is treated as a crashed run. */
  staleRunMs: number;
};
export const DEFAULT_OPTIONS: MorningOptions = {
  trigger: 'scheduler',
  force: false,
  pastDays: 7,
  aheadDays: 45,
  summaryDays: 3,
  enrichDays: 14,
  staleRunMs: 30 * 60 * 1000,
};
export type MorningDependencies = {
  calendar: CalendarRepository;
  runs: MorningRunRepository;
  /** Undefined when FRED_API_KEY is not configured: the FRED steps are recorded as skipped. */
  fred?: MorningFred;
  ecos?: MorningEcos;
  /** Official Fed/BOK RSS sync (writes through the repository it is given). */
  syncNews?: (repository: CalendarRepository) => Promise<{ count: number; failedSources: number }>;
  /** Present only when MORNING_AI_ENABLED=true; the job never builds it otherwise. */
  ai?: MorningAi;
  /**
   * Calendar enrichment for new events (cleanup, measured reactions, Korean outcome/impact). It gets
   * the preserving repository and builds its own Toss/AI collaborators; undefined = step skipped.
   */
  enrich?: (
    calendar: CalendarRepository,
    window: { from: string; to: string },
  ) => Promise<EnrichReport>;
  notifier: MorningNotifier;
  now?: () => Date;
  log: JobLogger;
  options?: Partial<MorningOptions>;
};

// Calendar writes that keep what earlier runs attached live in src/server/calendar-merge.ts
// (shared with the calendar-enrich job); re-exported here for the existing imports.
export { PreservingCalendarRepository, mergeStoredEvent } from '../server/calendar-merge.js';

// ---------------------------------------------------------------------------
// Released values.
// ---------------------------------------------------------------------------
/**
 * Freshness guard (heuristic): a value is attached only if its observation period starts within
 * this many days before the event date. It keeps the previous period's value from being shown as
 * the new result while the provider has not published/ingested the new one yet. Derived from the
 * usual release lag of each frequency (see docs/implementation/calendar.md).
 */
const MAXIMUM_PERIOD_AGE_DAYS: Record<string, number> = {
  daily: 10,
  D: 10,
  monthly: 60,
  M: 60,
  quarterly: 180,
  Q: 180,
  A: 400,
};
type Observation = { date: string; value: string | null };
type LatestRow = { id: string; latest: Observation | null; previous: Observation | null };
/** Shape shared by FredAdapter and EcosAdapter. */
type LatestSource = { latestObservations(ids: string[], asOf: string): Promise<LatestRow[]> };
function periodKey(indicator: Indicator) {
  return indicator.source === 'fred' ? indicator.frequency : indicator.cycle;
}
const isDaily = (indicator: Indicator) =>
  periodKey(indicator) === 'daily' || periodKey(indicator) === 'D';
/** Null when the observation cannot be the result of this event (too old, not yet after it, ...). */
export function valueFor(
  indicator: Indicator,
  eventDate: string,
  latest: Observation | null,
  previous: Observation | null,
  observedAt: string,
): EventValue | null {
  if (!latest || latest.value === null) return null;
  // Days from the observation period to the event date (positive: the period starts before it).
  const age = dayDifference(latest.date, eventDate);
  if (isDaily(indicator)) {
    // Daily series (policy rates, FX) show the new level from the day after the decision (FRED) or
    // the decision day (ECOS): wait until such an observation exists.
    const minimum = indicator.source === 'fred' ? -1 : 0;
    if (age > minimum || -age > MAXIMUM_PERIOD_AGE_DAYS.daily) return null;
  } else if (age <= 0 || age > (MAXIMUM_PERIOD_AGE_DAYS[periodKey(indicator)] ?? 0)) {
    return null;
  }
  return {
    indicatorId: indicator.id,
    label: indicator.titleKo,
    actual: latest.value,
    previous: previous?.value ?? null,
    unit: indicator.unit,
    period: latest.date,
    previousPeriod: previous?.value == null ? null : previous.date,
    source: indicator.source === 'fred' ? 'FRED' : '한국은행 ECOS',
    observedAt,
  };
}
/**
 * Adds `incoming` to `existing` per indicator: nulls never replace a value, an older period never
 * replaces a newer one, and an unchanged value keeps its original observedAt (idempotent).
 */
export function mergeValues(existing: EventValue[] | undefined, incoming: EventValue[]) {
  const byId = new Map((existing ?? []).map((value) => [value.indicatorId, value]));
  let changed = false;
  for (const value of incoming) {
    const old = byId.get(value.indicatorId);
    if (old) {
      const same =
        old.actual === value.actual &&
        old.previous === value.previous &&
        old.period === value.period &&
        old.previousPeriod === value.previousPeriod;
      if (same || value.period < old.period) continue;
    }
    byId.set(value.indicatorId, value);
    changed = true;
  }
  return { values: [...byId.values()], changed };
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------
const kstDate = (at: Date) => new Date(at.getTime() + 9 * 3600000).toISOString().slice(0, 10);
const monthDay = (date: string) => `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일`;
const emptyUsage = (): MorningUsage => ({ prompt: 0, output: 0, thoughts: 0, total: 0 });
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const aiErrorCode = (error: unknown) =>
  error instanceof MorningAiError ? error.code : 'AI_UNAVAILABLE';
const byImportance = (a: EconomicEvent, b: EconomicEvent) =>
  b.importance - a.importance || b.date.localeCompare(a.date) || a.id - b.id;

/** Collects what each step did; the final status is derived once at the end. */
class Steps {
  private tallies = new Map<
    string,
    {
      count: number;
      failed: boolean;
      skipped: boolean;
      disabled: boolean;
      codes: Record<string, number>;
    }
  >();
  private tally(name: string) {
    let tally = this.tallies.get(name);
    if (!tally) {
      tally = { count: 0, failed: false, skipped: false, disabled: false, codes: {} };
      this.tallies.set(name, tally);
    }
    return tally;
  }
  private code(name: string, code?: string) {
    if (code && CODE.test(code)) {
      const codes = this.tally(name).codes;
      codes[code] = (codes[code] ?? 0) + 1;
    }
  }
  done(name: string, count: number) {
    this.tally(name).count += count;
  }
  /** A known condition worth recording that does not make the step fail. */
  info(name: string, code: string, times = 1) {
    if (CODE.test(code)) {
      const codes = this.tally(name).codes;
      codes[code] = (codes[code] ?? 0) + times;
    }
  }
  skipped(name: string, code: string) {
    this.tally(name).skipped = true;
    this.code(name, code);
  }
  disabled(name: string, code: string) {
    this.tally(name).disabled = true;
    this.code(name, code);
  }
  failed(name: string, code: string) {
    this.tally(name).failed = true;
    this.code(name, code);
  }
  result(): Record<string, MorningStep> {
    return Object.fromEntries(
      [...this.tallies].map(([name, tally]) => [
        name,
        {
          status: tally.failed
            ? 'failed'
            : tally.count > 0
              ? 'ok'
              : tally.disabled
                ? 'disabled'
                : tally.skipped
                  ? 'skipped'
                  : 'ok',
          count: tally.count,
          codes: tally.codes,
        } satisfies MorningStep,
      ]),
    );
  }
}

export async function runMorningCalendar(deps: MorningDependencies): Promise<JobOutcome> {
  const options = { ...DEFAULT_OPTIONS, ...deps.options };
  const now = deps.now ?? (() => new Date());
  const { log, runs } = deps;
  const started = now();
  const today = options.date ?? kstDate(started);
  const run: MorningRun = {
    id: today,
    date: today,
    status: 'running',
    trigger: options.trigger,
    attempts: 0,
    startedAt: started.toISOString(),
    finishedAt: null,
    steps: {},
    ai: {
      enabled: deps.ai !== undefined,
      model: deps.ai?.model ?? null,
      calls: 0,
      tokens: emptyUsage(),
    },
    brief: null,
    notification: null,
  };
  let begin;
  try {
    begin = await runs.beginRun(run, {
      nowMs: started.getTime(),
      staleAfterMs: options.staleRunMs,
      force: options.force,
    });
  } catch (error) {
    log.error('run-record-failed', { date: today, code: safeErrorCode(error) });
    return 'failed';
  }
  if (begin.state !== 'started') {
    log.info('run-skipped', {
      date: today,
      code: begin.state === 'complete' ? 'RUN_ALREADY_COMPLETE' : 'RUN_IN_PROGRESS',
    });
    return 'ok';
  }
  run.attempts = begin.attempts;
  // What an earlier attempt of the same day already achieved (a brief that was sent stays sent).
  run.notification = options.force
    ? null
    : ((await runs.getRun(today).catch(() => null))?.notification ?? null);
  log.info('run-started', { date: today, trigger: options.trigger, attempts: run.attempts });

  const steps = new Steps();
  const calendar = new PreservingCalendarRepository(deps.calendar);
  const stamp = () => now().toISOString();
  const guarded = async (name: string, body: () => Promise<void>) => {
    try {
      await body();
    } catch (error) {
      steps.failed(name, safeErrorCode(error));
    }
  };
  const readEvents = async (from: string, to: string) =>
    (await deps.calendar.list(from, to))
      .map(cleanEvent)
      .filter((event): event is EconomicEvent => event !== null);

  // b. upcoming release dates (and the recent ones, so a first run has events to attach values to)
  await guarded('upcoming', async () => {
    if (!deps.fred) return steps.skipped('upcoming', 'FRED_NOT_CONFIGURED');
    const releases = await deps.fred.upcomingReleases(
      addDays(today, -options.pastDays),
      addDays(today, options.aheadDays),
    );
    const events: EconomicEvent[] = [];
    for (const release of releases) {
      const draft = releaseEventDraft(release, now());
      // FRED gives dates only: the event is all-day and labeled "발표 시각 미확인" in the UI.
      const event = draft ? toEconomicEvent(draft, { date: release.date, time: '' }) : null;
      if (event) events.push(event);
      else steps.failed('upcoming', 'EVENT_INVALID');
    }
    await calendar.upsert(events, AUTHOR);
    steps.done('upcoming', events.length);
  });
  await guarded('news', async () => {
    if (!deps.syncNews) return steps.skipped('news', 'NOT_CONFIGURED');
    const news = await deps.syncNews(calendar);
    if (news.failedSources) steps.failed('news', 'NEWS_SOURCE_FAILED');
    steps.done('news', news.count);
  });

  // a. released and previous values for past events
  await guarded('values', async () => {
    const past = (await readEvents(addDays(today, -options.pastDays), addDays(today, -1))).filter(
      (event) => event.indicatorIds?.length,
    );
    const catalog = [...new Set(past.flatMap((event) => event.indicatorIds ?? []))]
      .map((id) => indicatorById(id))
      .filter((entry): entry is Indicator => entry !== undefined);
    const lookups = new Map<string, LatestRow>();
    const sources: [Indicator['source'], LatestSource | undefined, string, number][] = [
      ['fred', deps.fred, 'FRED_NOT_CONFIGURED', 20],
      ['ecos', deps.ecos, 'ECOS_NOT_CONFIGURED', 10],
    ];
    for (const [source, adapter, missing, size] of sources) {
      const wanted = catalog.filter((entry) => entry.source === source).map((entry) => entry.id);
      if (!wanted.length) continue;
      if (!adapter) {
        steps.skipped('values', missing);
        continue;
      }
      try {
        for (let start = 0; start < wanted.length; start += size)
          for (const row of await adapter.latestObservations(
            wanted.slice(start, start + size),
            today,
          ))
            lookups.set(row.id, row);
      } catch (error) {
        steps.failed('values', safeErrorCode(error));
      }
    }
    const changed: EconomicEvent[] = [];
    for (const event of past) {
      const incoming: EventValue[] = [];
      for (const id of event.indicatorIds ?? []) {
        const indicator = indicatorById(id);
        const found = lookups.get(id);
        if (!indicator || !found) continue;
        const value = valueFor(indicator, event.date, found.latest, found.previous, stamp());
        if (value) incoming.push(value);
        else steps.info('values', 'VALUE_NOT_AVAILABLE_YET');
      }
      const merged = mergeValues(event.values, incoming);
      // An event with values but no AI text yet is explicitly "no summary" (null), not "unknown".
      const aiSummary = event.aiSummary === undefined && merged.values.length ? null : undefined;
      if (!merged.changed && aiSummary === undefined) continue;
      changed.push({
        ...event,
        ...(merged.values.length ? { values: merged.values } : {}),
        ...(aiSummary === null ? { aiSummary: null } : {}),
      });
    }
    await calendar.upsert(changed, AUTHOR);
    steps.done('values', changed.length);
  });

  // c. AI step: off unless MORNING_AI_ENABLED=true produced an adapter
  const ai = deps.ai;
  const useAi = async <T extends { usage: MorningUsage; fallbackModel?: string }>(
    name: string,
    call: (adapter: MorningAi) => Promise<T>,
  ): Promise<T | null> => {
    if (!ai) return null;
    try {
      run.ai.calls++;
      const result = await call(ai);
      for (const key of Object.keys(run.ai.tokens) as (keyof MorningUsage)[])
        run.ai.tokens[key] += result.usage[key];
      // A refusal fallback answered with another model, billed at that model's rates: visible in the run.
      if (result.fallbackModel) steps.info(name, 'AI_FALLBACK_SERVED');
      return result;
    } catch (error) {
      const code = aiErrorCode(error);
      // A used-up quota is the guard working, not a failure; everything else is.
      if (code === 'AI_QUOTA_EXCEEDED') steps.skipped(name, code);
      else steps.failed(name, code);
      return null;
    }
  };
  // c0. calendar enrichment of new events: runs before the older title translation so that step only
  // sees what enrichment could not handle. Cleanup and measured reactions need no AI.
  await guarded('enrich', async () => {
    if (!deps.enrich) return steps.skipped('enrich', 'NOT_CONFIGURED');
    const report = await deps.enrich(calendar, {
      from: addDays(today, -options.enrichDays),
      to: today,
    });
    run.ai.calls += report.aiCalls;
    for (const key of Object.keys(run.ai.tokens) as (keyof MorningUsage)[])
      run.ai.tokens[key] += report.usage[key];
    for (const [code, times] of Object.entries(report.codes)) {
      if (code === 'AI_QUOTA_EXCEEDED') steps.skipped('enrich', code);
      else if (!report.failures.includes(code)) steps.info('enrich', code, times);
    }
    for (const code of report.failures) steps.failed('enrich', code);
    steps.done('enrich', report.cleaned + report.reactions + report.enriched);
  });
  await guarded('ai-summary', async () => {
    if (!ai) return steps.disabled('ai-summary', 'AI_DISABLED');
    const refs = (await readEvents(addDays(today, -options.summaryDays), addDays(today, -1)))
      .filter((event) => event.values?.length && !event.aiSummary)
      .sort(byImportance)
      .slice(0, MORNING_MAX_SUMMARY_ITEMS)
      .map((event, index) => ({ refId: `e${index + 1}`, event }));
    if (!refs.length) return;
    const result = await useAi('ai-summary', (adapter) =>
      adapter.summarize(
        refs.map(({ refId, event }) => ({
          refId,
          date: event.date,
          title: event.title,
          importance: event.importance,
          values: (event.values ?? []).map((value) => ({
            label: value.label,
            actual: value.actual,
            previous: value.previous,
            unit: value.unit,
            period: value.period,
            previousPeriod: value.previousPeriod,
          })),
        })),
      ),
    );
    if (!result) return;
    const generatedAt = stamp();
    const written: EconomicEvent[] = [];
    for (const item of result.items) {
      const event = refs.find((ref) => ref.refId === item.refId)?.event;
      if (event)
        written.push({
          ...event,
          aiSummary: {
            text: item.text,
            model: result.fallbackModel ?? ai.model,
            generatedAt,
          },
        });
    }
    // Rejected items stay "no summary"; the safety check working is recorded, not a failure.
    if (result.rejected) steps.info('ai-summary', 'AI_OUTPUT_REJECTED');
    await calendar.upsert(written, AUTHOR);
    steps.done('ai-summary', written.length);
  });
  await guarded('ai-translation', async () => {
    if (!ai) return steps.disabled('ai-translation', 'AI_DISABLED');
    const refs = (await readEvents(addDays(today, -options.pastDays), today))
      .filter(
        (event) => event.country === '미국' && !event.titleOriginal && !/[가-힣]/.test(event.title),
      )
      .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time) || a.id - b.id)
      .slice(0, MORNING_MAX_TRANSLATION_ITEMS)
      .map((event, index) => ({ refId: `t${index + 1}`, event }));
    if (!refs.length) return;
    const result = await useAi('ai-translation', (adapter) =>
      adapter.translate(refs.map(({ refId, event }) => ({ refId, title: event.title }))),
    );
    if (!result) return;
    const translatedAt = stamp();
    const written: EconomicEvent[] = [];
    for (const item of result.items) {
      const event = refs.find((ref) => ref.refId === item.refId)?.event;
      const translated = event
        ? cleanEvent({
            ...event,
            title: item.titleKo,
            titleOriginal: event.title,
            translation: { model: result.fallbackModel ?? ai.model, translatedAt },
          })
        : null;
      if (translated) written.push(translated);
    }
    if (result.rejected || written.length < result.items.length)
      steps.info('ai-translation', 'AI_OUTPUT_REJECTED');
    await calendar.upsert(written, AUTHOR);
    steps.done('ai-translation', written.length);
  });

  // d. brief: stored for the UI, one Telegram message per day
  await guarded('brief', async () => {
    const window = await readEvents(addDays(today, -options.summaryDays), addDays(today, 7));
    run.brief = buildBrief(window, today, stamp());
    steps.done('brief', 1);
  });
  await guarded('notify', async () => {
    if (!run.brief) return steps.skipped('notify', 'BRIEF_MISSING');
    if (run.notification?.status === 'sent') return steps.skipped('notify', 'ALREADY_SENT');
    const outcome: NotifyOutcome = await deps.notifier.notify({
      kind: 'morning-brief',
      summary: run.brief.text,
    });
    run.notification = { status: outcome.status, failureCode: outcome.failureCode ?? null };
    if (outcome.status === 'sent') steps.done('notify', 1);
    else if (outcome.status === 'disabled') steps.skipped('notify', 'NOT_CONFIGURED');
    else steps.failed('notify', outcome.failureCode ?? 'DELIVERY_ERROR');
  });

  run.steps = steps.result();
  const results = Object.values(run.steps);
  const failed = results.some((step) => step.status === 'failed');
  const worked = results.some((step) => step.status === 'ok' && step.count > 0);
  run.status = !failed ? 'complete' : worked ? 'partial' : 'failed';
  run.finishedAt = stamp();
  let outcome: JobOutcome =
    run.status === 'complete' ? 'ok' : run.status === 'partial' ? 'partial' : 'failed';
  try {
    await runs.saveRun(run);
  } catch (error) {
    log.error('run-record-failed', { date: today, code: safeErrorCode(error) });
    outcome = 'failed';
  }
  for (const [step, result] of Object.entries(run.steps))
    log.info('step-finished', {
      step,
      date: today,
      status: result.status,
      count: result.count,
      codes: result.codes,
    });
  log.info('run-finished', { date: today, status: run.status, count: run.ai.calls });
  // A failed run is also reported (notify never throws; a failed Telegram send is recorded).
  if (run.status === 'failed')
    await deps.notifier.notify({ kind: 'job-failure', jobName: JOB_NAME });
  return outcome;
}

/**
 * Short Korean brief. Dates are written "10월 21일" and numbers stay short so the notification
 * sanitizer (which removes long digit runs and URL-like text) leaves the message intact.
 */
export function buildBrief(events: EconomicEvent[], today: string, generatedAt: string) {
  const yesterday = addDays(today, -1);
  const released = events
    .filter((event) => event.values?.length && event.date <= yesterday)
    .sort(byImportance)
    .slice(0, 3);
  const upcoming = events
    .filter((event) => event.eventKind !== 'news-release' && event.date >= today)
    .filter((event) => event.date <= addDays(today, 7) && event.importance >= 2)
    .sort((a, b) => a.date.localeCompare(b.date) || b.importance - a.importance || a.id - b.id)
    .slice(0, 3);
  const parts = [`${monthDay(today)} 아침 브리핑.`];
  if (released.length) {
    parts.push(
      `최근 발표 결과: ${released
        .map((event) => {
          const value = event.values![0];
          const before = value.previous === null ? '' : `, 이전 ${value.previous}`;
          return `${shortTitle(event.title)} ${value.actual}${value.unit ? ` ${shortUnit(value.unit)}` : ''}${before}`;
        })
        .join(' / ')}.`,
    );
  }
  if (upcoming.length) {
    const unknownTime = upcoming.some((event) => event.time === '');
    parts.push(
      `이번 주 주요 일정: ${upcoming
        .map((event) => `${monthDay(event.date)} ${shortTitle(event.title)}`)
        .join(' / ')}${unknownTime ? ' (발표 시각 미확인 포함)' : ''}.`,
    );
  }
  if (!released.length && !upcoming.length)
    parts.push('새로 반영된 발표 결과와 이번 주 주요 일정이 없습니다.');
  const summary = released.find((event) => event.aiSummary?.text)?.aiSummary;
  if (summary) parts.push(`AI 요약: ${firstSentence(summary.text)}`);
  const text = sanitizeNotificationText(parts.join(' '), 600);
  return {
    text,
    generatedAt,
    aiUsed: summary !== undefined,
  };
}
const shortTitle = (title: string) =>
  Array.from(title).length > 28 ? `${Array.from(title).slice(0, 27).join('')}…` : title;
const shortUnit = (unit: string) => (Array.from(unit).length > 12 ? '' : unit);
const firstSentence = (text: string) => {
  const match = /^.*?[.!?](?=\s|$)/.exec(text.trim());
  return match ? match[0] : text.trim();
};

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export type MorningConfiguration = {
  project: string;
  appOrigin: string;
  options: Partial<MorningOptions>;
  /** Non-null only when MORNING_AI_ENABLED=true (and the AI provider is fully configured). */
  ai: AiEnvironment | null;
};
/**
 * Only runs as a Cloud Run Job in an explicit project. The AI step is off unless
 * MORNING_AI_ENABLED is exactly "true"; any other non-empty value other than "false" is a
 * configuration error so a typo can never switch AI on (or silently leave it off).
 */
export function morningConfiguration(env: NodeJS.ProcessEnv): MorningConfiguration {
  const project = env.GOOGLE_CLOUD_PROJECT;
  if (
    env.NODE_ENV !== 'production' ||
    !env.CLOUD_RUN_JOB ||
    !project ||
    !PROJECT.test(project) ||
    !validAppOrigin(env.APP_ORIGIN)
  )
    throw new JobConfigError();
  const flag = env.MORNING_AI_ENABLED;
  if (flag !== undefined && flag !== '' && flag !== 'true' && flag !== 'false')
    throw new JobConfigError();
  let ai: AiEnvironment | null = null;
  if (flag === 'true') {
    ai = morningAiConfigFromEnvironment(env);
    if (!ai) throw new JobConfigError();
  }
  const options: Partial<MorningOptions> = {};
  if (env.MORNING_DATE) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(env.MORNING_DATE)) throw new JobConfigError();
    options.date = env.MORNING_DATE;
  }
  if (env.MORNING_FORCE) {
    if (env.MORNING_FORCE !== '1') throw new JobConfigError();
    options.force = true;
  }
  if (options.date || options.force) options.trigger = 'manual';
  return { project, appOrigin: env.APP_ORIGIN!, options, ai };
}
export async function main(env: NodeJS.ProcessEnv = process.env) {
  return runJob(JOB_NAME, async ({ log }) => {
    const config = morningConfiguration(env);
    const db = new Firestore({ projectId: config.project });
    try {
      const skipped = await budgetJobGate(db, log, { failClosed: false });
      if (skipped) return skipped;
      const notifications = new NotificationService({
        repository: new FirestoreNotificationRepository(db),
        notifier: notifierFromEnvironment(env),
        appOrigin: config.appOrigin,
      });
      return await runMorningCalendar({
        calendar: new FirestoreCalendarRepository(db),
        runs: new FirestoreMorningRunRepository(db),
        fred: fredFromEnvironment(env),
        ecos: ecosFromEnvironment(env),
        syncNews: async (repository) => {
          const result = await syncOfficialNews(repository, { authorId: AUTHOR });
          return {
            count: result.count,
            failedSources: result.sources.filter((source) => source.status === 'failed').length,
          };
        },
        ai: config.ai
          ? new ProviderMorningAi(createAiProvider(config.ai), new FirestoreAiQuota(db, 'morning'))
          : undefined,
        enrich: async (repository, window) =>
          enrichCalendar(
            {
              calendar: repository,
              ...enrichmentCollaborators(env, db, config.ai),
              author: AUTHOR,
            },
            { ...window, force: false, maxAiCalls: 2 },
          ),
        notifier: notifications,
        log,
        options: config.options,
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
