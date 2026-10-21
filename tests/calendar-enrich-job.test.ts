import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  JOB_NAME,
  calendarEnrichConfiguration,
  enrichmentCollaborators,
  runCalendarEnrich,
} from '../src/jobs/calendar-enrich';
import { JOB_NAME as MORNING_JOB, runMorningCalendar } from '../src/jobs/morning-calendar';
import { createJobLogger } from '../src/jobs/runner';
import { MemoryAiQuota } from '../src/server/ai';
import { ClaudeVertexProvider, type ClaudeMessagesClient } from '../src/server/ai-provider';
import { MemoryCalendarEnrichRunRepository } from '../src/server/calendar-enrich-runs';
import { ProviderEnrichAi, enrichCalendar, type EnrichInput } from '../src/server/calendar-enrich';
import { MemoryCalendarRepository, cleanEvent, type EconomicEvent } from '../src/server/calendar';
import { MemoryMorningRunRepository } from '../src/server/morning';
import { ReactionCalculator, type ReactionToss } from '../src/server/reaction';

const NOW = new Date('2026-10-27T09:00:00+09:00');
const config = { project: 'fixture-project', model: 'claude-sonnet-5-5', location: 'global' };
const bok = (id = 1, title = '[보도자료] 한국은행 발표') =>
  cleanEvent({
    id,
    eventKind: 'news-release',
    date: '2026-10-20',
    time: '10:00',
    title,
    country: '한국',
    category: '공식 보도자료·기관발표',
    assets: ['시장전반'],
    importance: 1,
    description: 'x',
    sourceUrl: 'https://www.bok.or.kr/a',
    sourceName: '한국은행 공식 보도자료',
    impactDirection: 'unknown',
    impactHorizon: 'x',
    confidence: 'low',
    factualObservedAt: '2026-10-26T00:00:00Z',
  })!;
const DAYS = ['2026-10-19', '2026-10-20', '2026-10-21'];
const page = (start: number) => ({
  candles: DAYS.map((date, index) => ({
    timestamp: `${date}T00:00:00+09:00`,
    date,
    open: '1',
    high: '1',
    low: '1',
    close: String(start + index),
    volume: '0',
    currency: 'USD' as const,
  })).reverse(),
  nextBefore: null,
});
const toss = () =>
  ({
    marketIndicatorCandlePage: vi.fn(async () => page(100)),
    dailyCandlePage: vi.fn(async () => page(100)),
    exchangeRateAt: vi.fn(async (dateTime: string) => ({
      midRate: '1400',
      validFrom: new Date(Date.parse(dateTime) - 3600_000).toISOString(),
      validUntil: new Date(Date.parse(dateTime) + 3600_000).toISOString(),
    })),
  }) as unknown as ReactionToss;
const claudeAi = (failure?: Error) => {
  const create = vi.fn(async (params: { messages: { content: string }[] }) => {
    if (failure) throw failure;
    const sent = JSON.parse(params.messages[0].content).items as EnrichInput[];
    return {
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            items: sent.map((entry) => ({
              ref: entry.ref,
              titleKo: '',
              headline: '한국은행이 발표한 내용을 정리했다',
              facts: [],
              impact: [],
              explainer: '',
            })),
          }),
        },
      ],
      usage: { input_tokens: 800, output_tokens: 300 },
    };
  });
  return new ProviderEnrichAi(
    new ClaudeVertexProvider(config, { messages: { create } } as unknown as ClaudeMessagesClient),
    new MemoryAiQuota('calendar'),
    () => NOW.getTime(),
  );
};
const options = { from: '2026-06-01', to: '2026-10-27', force: false, maxAiCalls: 3 };
function harness(
  events: EconomicEvent[],
  extra: Partial<Parameters<typeof runCalendarEnrich>[0]> = {},
) {
  const calendar = new MemoryCalendarRepository();
  void calendar.upsert(events, 'seed');
  const runs = new MemoryCalendarEnrichRunRepository();
  const lines: string[] = [];
  const run = () =>
    runCalendarEnrich({
      calendar,
      runs,
      now: () => NOW,
      log: createJobLogger(JOB_NAME, (line) => lines.push(line)),
      options,
      ...extra,
    });
  return { calendar, runs, lines, run };
}

describe('calendar-enrich 작업', () => {
  it('실행 기록: 건수, AI 호출·토큰, 정제된 코드만 남고 완료로 끝난다', async () => {
    const h = harness([bok(1), bok(2, '[보도참고자료] 외환시장 동향')], {
      reaction: new ReactionCalculator(toss(), { now: () => NOW.getTime() }),
      ai: claudeAi(),
    });
    expect(await h.run()).toBe('ok');
    const [record] = await h.runs.listRuns(5);
    expect(record).toMatchObject({
      id: '2026-10-27_090000',
      date: '2026-10-27',
      status: 'complete',
      trigger: 'manual',
      counts: { examined: 2, cleaned: 2, reactions: 2, enriched: 2, rejected: 0 },
      ai: {
        enabled: true,
        model: 'Claude Sonnet 5.5',
        calls: 1,
        tokens: { prompt: 800, output: 300 },
      },
    });
    expect(record.finishedAt).toBe(NOW.toISOString());
    // Counts and fixed codes only: no event text, no provider text.
    expect(JSON.stringify(record)).not.toMatch(/한국은행|https?:/);
    const finished = h.lines
      .map((line) => JSON.parse(line))
      .find((line) => line.message === 'run-finished');
    expect(finished).toMatchObject({ job: JOB_NAME, status: 'complete', count: 2 });
  });
  it('AI 없이(꺼짐·한도): 정리와 반응은 하고 AI_DISABLED를 기록하며 완료다', async () => {
    const h = harness([bok()], {
      reaction: new ReactionCalculator(toss(), { now: () => NOW.getTime() }),
    });
    expect(await h.run()).toBe('ok');
    const [record] = await h.runs.listRuns(1);
    expect(record.status).toBe('complete');
    expect(record.codes).toMatchObject({ AI_DISABLED: 1 });
    expect(record.ai).toMatchObject({ enabled: false, model: null, calls: 0 });
    expect(record.counts).toMatchObject({ cleaned: 1, reactions: 1, enriched: 0 });
  });
  it('공급자 429(AI_QUOTA_PROVIDER)는 죽지 않고 부분 완료로 기록·로그에 보인다', async () => {
    const limited = Object.assign(new Error('RESOURCE_EXHAUSTED: project secret'), { status: 429 });
    const h = harness([bok()], {
      reaction: new ReactionCalculator(toss(), { now: () => NOW.getTime() }),
      ai: claudeAi(limited),
    });
    expect(await h.run()).toBe('partial');
    const [record] = await h.runs.listRuns(1);
    expect(record.status).toBe('partial');
    expect(record.codes).toMatchObject({ AI_QUOTA_PROVIDER: 1 });
    // Cleanup and the measured reaction were still written.
    const stored = (await h.calendar.list('2026-01-01', '2026-12-31'))[0];
    expect(stored.title).toBe('한국은행 발표');
    expect(stored.reaction?.length).toBeGreaterThan(0);
    expect(h.lines.join('\n')).toContain('AI_QUOTA_PROVIDER');
    expect(h.lines.join('\n')).not.toMatch(/secret|RESOURCE_EXHAUSTED/);
  });
  it('아무 것도 하지 못한 채 실패하면 failed', async () => {
    const calendar = new MemoryCalendarRepository();
    const broken = {
      list: async () => {
        throw new Error('firestore down');
      },
      upsert: async () => undefined,
    };
    const runs = new MemoryCalendarEnrichRunRepository();
    const code = await runCalendarEnrich({
      calendar: broken,
      runs,
      now: () => NOW,
      log: createJobLogger(JOB_NAME, () => undefined),
      options,
    });
    expect(code).toBe('failed');
    expect((await runs.listRuns(1))[0]).toMatchObject({
      status: 'failed',
      codes: { JOB_FAILED: 1 },
    });
    expect(calendar).toBeDefined();
  });
});

describe('calendar-enrich 설정', () => {
  const base = {
    NODE_ENV: 'production',
    CLOUD_RUN_JOB: 'investing-calendar-enrich',
    GOOGLE_CLOUD_PROJECT: 'fixture-project',
  };
  it('Cloud Run 작업에서만 돌고 AI는 CALENDAR_AI_ENABLED=true일 때만 켜진다', () => {
    expect(calendarEnrichConfiguration(base)).toMatchObject({
      project: 'fixture-project',
      ai: null,
      options: { force: false, maxAiCalls: 15, days: 400 },
    });
    expect(calendarEnrichConfiguration({ ...base, AI_PROVIDER: 'vertex-claude' }).ai).toBeNull();
    expect(
      calendarEnrichConfiguration({
        ...base,
        CALENDAR_AI_ENABLED: 'true',
        AI_PROVIDER: 'vertex-claude',
      }).ai,
    ).toEqual({ provider: 'vertex-claude', config });
    expect(() => calendarEnrichConfiguration({ ...base, CALENDAR_AI_ENABLED: 'true' })).toThrow();
    for (const flag of ['TRUE', '1', 'yes'])
      expect(() => calendarEnrichConfiguration({ ...base, CALENDAR_AI_ENABLED: flag })).toThrow();
    expect(() => calendarEnrichConfiguration({ ...base, NODE_ENV: 'development' })).toThrow();
    expect(() => calendarEnrichConfiguration({ ...base, CLOUD_RUN_JOB: undefined })).toThrow();
  });
  it('옵션: FORCE=1, FROM 날짜, 최대 AI 호출 1~20', () => {
    expect(
      calendarEnrichConfiguration({
        ...base,
        CALENDAR_ENRICH_FORCE: '1',
        CALENDAR_ENRICH_FROM: '2026-01-01',
        CALENDAR_ENRICH_MAX_AI_CALLS: '20',
      }).options,
    ).toMatchObject({ force: true, from: '2026-01-01', maxAiCalls: 20 });
    for (const bad of [
      { CALENDAR_ENRICH_FORCE: 'yes' },
      { CALENDAR_ENRICH_FROM: '10-21' },
      { CALENDAR_ENRICH_MAX_AI_CALLS: '0' },
      { CALENDAR_ENRICH_MAX_AI_CALLS: '21' },
      { CALENDAR_ENRICH_MAX_AI_CALLS: 'x' },
    ])
      expect(() => calendarEnrichConfiguration({ ...base, ...bad })).toThrow();
  });
  it('협력 객체: Toss·AI는 있을 때만 만들어진다', () => {
    const none = enrichmentCollaborators({}, {} as never, null, { toss: null });
    expect(none).toEqual({ reaction: undefined, ai: undefined, policyFacts: undefined });
    const full = enrichmentCollaborators(
      { GOOGLE_CLOUD_PROJECT: 'fixture-project' },
      {} as never,
      { provider: 'vertex-claude', config },
      { toss: toss() },
    );
    expect(full.reaction).toBeInstanceOf(ReactionCalculator);
    expect(full.ai?.model).toBe('Claude Sonnet 5.5');
  });
});

describe('아침 작업의 enrich 단계', () => {
  const morning = (
    enrich?: Parameters<typeof runMorningCalendar>[0]['enrich'],
    events = [bok()],
  ) => {
    const calendar = new MemoryCalendarRepository();
    void calendar.upsert(events, 'seed');
    const runs = new MemoryMorningRunRepository();
    const run = () =>
      runMorningCalendar({
        calendar,
        runs,
        notifier: { notify: vi.fn(async () => ({ status: 'disabled' as const, recorded: false })) },
        now: () => NOW,
        log: createJobLogger(MORNING_JOB, () => undefined),
        ...(enrich ? { enrich } : {}),
      });
    return { calendar, runs, run };
  };
  const real =
    (ai?: ProviderEnrichAi) =>
    (
      repository: Parameters<typeof enrichCalendar>[0]['calendar'],
      window: { from: string; to: string },
    ) =>
      enrichCalendar(
        {
          calendar: repository,
          reaction: new ReactionCalculator(toss(), { now: () => NOW.getTime() }),
          ai,
          now: () => NOW,
          author: 'morning-calendar-job',
        },
        { ...window, force: false, maxAiCalls: 2 },
      );
  it('새 이벤트를 정리·측정·보강하고 단계 기록과 AI 호출·토큰을 남긴다', async () => {
    const h = morning(real(claudeAi()));
    expect(await h.run()).toBe('ok');
    const run = (await h.runs.getRun('2026-10-27'))!;
    expect(run.steps.enrich).toMatchObject({ status: 'ok', count: 3 });
    expect(run.ai.calls).toBe(1);
    expect(run.ai.tokens).toMatchObject({ prompt: 800, output: 300 });
    const stored = (await h.calendar.list('2026-10-01', '2026-10-31'))[0];
    expect(stored).toMatchObject({
      title: '한국은행 발표',
      releaseType: '보도자료',
      outcome: { headline: '한국은행이 발표한 내용을 정리했다' },
    });
  });
  it('AI 없음은 코드로만 남고 단계는 정상이며, 공급자 429는 단계 실패·부분 완료로 보인다', async () => {
    const noAi = morning(real(undefined));
    expect(await noAi.run()).toBe('ok');
    expect((await noAi.runs.getRun('2026-10-27'))!.steps.enrich.codes).toMatchObject({
      AI_DISABLED: 1,
    });
    const limited = morning(real(claudeAi(Object.assign(new Error('x'), { status: 429 }))));
    expect(await limited.run()).toBe('partial');
    expect((await limited.runs.getRun('2026-10-27'))!.steps.enrich).toMatchObject({
      status: 'failed',
      codes: { AI_QUOTA_PROVIDER: 1 },
    });
  });
  it('주입하지 않으면 건너뛰고(NOT_CONFIGURED) 나머지는 그대로 돈다', async () => {
    const h = morning(undefined);
    expect(await h.run()).toBe('ok');
    expect((await h.runs.getRun('2026-10-27'))!.steps.enrich).toMatchObject({
      status: 'skipped',
      codes: { NOT_CONFIGURED: 1 },
    });
  });
});

describe('배포 정의(정적 검사)', () => {
  const deploy = readFileSync('.github/workflows/deploy.yml', 'utf8');
  it('수동 보강 작업: 같은 이미지·계정·VPC, 토스 숫자 버전 필수, 스케줄·invoker 없음', () => {
    const start = deploy.indexOf('- name: Deploy calendar enrichment job');
    expect(start).toBeGreaterThan(0);
    const next = deploy.indexOf('- name: ', start + 1);
    const step = deploy.slice(start, next === -1 ? undefined : next);
    expect(step).toContain('JOB=investing-calendar-enrich');
    expect(step).toContain('--image="$DEPLOY_IMAGE"');
    expect(step).toContain('--service-account="investing-jobs@$PROJECT.iam.gserviceaccount.com"');
    expect(step).toContain('src/jobs/calendar-enrich.ts');
    expect(step).toContain(
      '--network=investing-network --subnet=investing-subnet --vpc-egress=all-traffic',
    );
    expect(step).toContain('CALENDAR_AI_ENABLED=true');
    expect(step).toContain('AI_PROVIDER=$AI_PROVIDER,AI_MODEL=$AI_MODEL,AI_LOCATION=$AI_LOCATION');
    expect(step).toContain('investing-toss-[a-z-]+:[0-9]+');
    expect(step).toContain('--max-retries=0');
    expect(step).not.toContain('run.invoker');
    expect(step).not.toContain('ALGO_AI_ENABLED');
  });
  it('AI 기본값은 Claude Sonnet 5.5(vertex-claude, global), AI형 알고리즘은 꺼 둔다', () => {
    expect(deploy).toContain("AI_PROVIDER: ${{ vars.AI_PROVIDER || 'vertex-claude' }}");
    expect(deploy).toContain("AI_MODEL: ${{ vars.AI_MODEL || 'claude-sonnet-5-5' }}");
    expect(deploy).toContain("AI_LOCATION: ${{ vars.AI_LOCATION || 'global' }}");
    expect(deploy.match(/--set-env-vars="[^"]*ALGO_AI_ENABLED=false[^"]*"/g)?.length).toBe(2);
    expect(deploy).not.toContain('ALGO_AI_ENABLED=true');
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain('/app/src/jobs/calendar-enrich.ts');
  });
});
