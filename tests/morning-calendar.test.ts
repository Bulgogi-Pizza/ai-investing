import { describe, expect, it, vi } from 'vitest';
import {
  JOB_NAME,
  PreservingCalendarRepository,
  buildBrief,
  mergeStoredEvent,
  mergeValues,
  morningConfiguration,
  runMorningCalendar,
  valueFor,
  type MorningDependencies,
} from '../src/jobs/morning-calendar';
import { createJobLogger } from '../src/jobs/runner';
import { MorningAiError, type MorningAi } from '../src/server/ai-morning';
import {
  MemoryCalendarRepository,
  cleanEvent,
  type EconomicEvent,
  type EventValue,
} from '../src/server/calendar';
import { indicatorById, macroEventId } from '../src/server/macro';
import { MemoryMorningRunRepository } from '../src/server/morning';
import {
  MemoryNotificationRepository,
  NotificationService,
  type Notifier,
} from '../src/server/notify';
import { ProviderError } from '../src/server/toss';

const NOW = new Date('2026-10-21T07:00:00+09:00');
const TODAY = '2026-10-21';
const cpiId = macroEventId('fred-release:10:2026-10-20');
const futureId = macroEventId('fred-release:10:2026-11-13');
const release = (date: string, releaseId = 10, indicatorIds = ['us-cpi', 'us-core-cpi']) => ({
  releaseId,
  date,
  indicatorIds,
});
const observation = (id: string) => ({
  id,
  asOf: TODAY,
  latest: { date: '2026-09-01', value: id === 'us-cpi' ? '324.368' : '330.1' },
  previous: { date: '2026-08-01', value: id === 'us-cpi' ? '323.364' : '329.5' },
});
function fakeFred(overrides: Partial<NonNullable<MorningDependencies['fred']>> = {}) {
  return {
    upcomingReleases: vi.fn(async () => [release('2026-10-20'), release('2026-11-13')]),
    latestObservations: vi.fn(async (ids: string[]) => ids.map(observation)),
    ...overrides,
  };
}
const englishNews = () =>
  cleanEvent({
    id: 4242,
    eventKind: 'news-release',
    date: '2026-10-20',
    time: '03:00',
    title: 'Federal Reserve Board announces approval of final rule',
    country: '미국',
    category: '공식 보도자료·기관발표',
    assets: ['시장전반'],
    importance: 1,
    description: '공식 RSS 보도자료의 게시시각입니다.',
    sourceUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/other20261020a.htm',
    sourceName: '미 연준 공식 보도자료',
    impactDirection: 'unknown',
    impactHorizon: '보도자료 게시 시점',
    confidence: 'low',
    factualObservedAt: NOW.toISOString(),
  })!;
const usage = { prompt: 100, output: 50, thoughts: 20, total: 170 };
function fakeAi(model = 'gemini-fixture'): MorningAi & {
  summarize: ReturnType<typeof vi.fn>;
  translate: ReturnType<typeof vi.fn>;
} {
  return {
    model,
    summarize: vi.fn(async (items: { refId: string }[]) => ({
      items: items.map((item) => ({
        refId: item.refId,
        text: '발표값이 이전보다 높게 나왔다. 금리 기대에 영향을 줄 수 있다.',
      })),
      rejected: 0,
      usage,
    })),
    translate: vi.fn(async (items: { refId: string }[]) => ({
      items: items.map((item) => ({
        refId: item.refId,
        titleKo: '연준 이사회, 최종 규칙 승인 발표',
      })),
      rejected: 0,
      usage,
    })),
  } as never;
}
function harness(
  options: {
    fred?: MorningDependencies['fred'] | null;
    ai?: MorningAi;
    notifier?: MorningDependencies['notifier'];
    calendar?: MemoryCalendarRepository;
    runs?: MemoryMorningRunRepository;
    news?: boolean;
    options?: MorningDependencies['options'];
  } = {},
) {
  const calendar = options.calendar ?? new MemoryCalendarRepository();
  const runs = options.runs ?? new MemoryMorningRunRepository();
  const lines: string[] = [];
  const notifier = options.notifier ?? {
    notify: vi.fn(async () => ({ status: 'sent' as const, recorded: true })),
  };
  const syncNews = vi.fn(async (repository: { upsert: MemoryCalendarRepository['upsert'] }) => {
    await repository.upsert([englishNews()], 'test');
    return { count: 1, failedSources: 0 };
  });
  const run = (now = NOW, extra: MorningDependencies['options'] = {}) =>
    runMorningCalendar({
      calendar,
      runs,
      ...(options.fred === null ? {} : { fred: options.fred ?? fakeFred() }),
      ...(options.news === false ? {} : { syncNews }),
      ...(options.ai ? { ai: options.ai } : {}),
      notifier,
      now: () => now,
      log: createJobLogger(JOB_NAME, (line) => lines.push(line)),
      options: { ...options.options, ...extra },
    });
  return { calendar, runs, lines, notifier, syncNews, run };
}
const all = (calendar: MemoryCalendarRepository) => calendar.list('2000-01-01', '2100-01-01');

describe('아침 캘린더 작업 (AI 꺼짐, 기본값)', () => {
  it('다가오는 일정을 시각 없이 만들고 지난 일정에 값을 붙이며 AI 없이 브리핑을 보낸다', async () => {
    const h = harness();
    expect(await h.run()).toBe('ok');
    const events = await all(h.calendar);
    const cpi = events.find((event) => event.id === cpiId)!;
    expect(cpi).toMatchObject({
      date: '2026-10-20',
      time: '',
      country: '미국',
      eventKind: 'scheduled',
    });
    expect(cpi.values).toEqual([
      expect.objectContaining({
        indicatorId: 'us-cpi',
        actual: '324.368',
        previous: '323.364',
        period: '2026-09-01',
        previousPeriod: '2026-08-01',
        source: 'FRED',
        observedAt: NOW.toISOString(),
      }),
      expect.objectContaining({ indicatorId: 'us-core-cpi', actual: '330.1' }),
    ]);
    // AI is off: no AI text, explicitly marked as "no summary".
    expect(cpi.aiSummary).toBeNull();
    expect(cpi.translation).toBeUndefined();
    // Upcoming events exist (same deterministic id format) and carry no values yet.
    const upcoming = events.find((event) => event.id === futureId)!;
    expect(upcoming).toMatchObject({ date: '2026-11-13', time: '' });
    expect(upcoming.values).toBeUndefined();
    // News stays in its original language when AI is off.
    expect(events.find((event) => event.id === 4242)?.title).toContain('Federal Reserve');
    const run = (await h.runs.getRun(TODAY))!;
    expect(run.status).toBe('complete');
    expect(run.ai).toMatchObject({ enabled: false, calls: 0 });
    expect(run.steps['ai-summary']).toMatchObject({
      status: 'disabled',
      codes: { AI_DISABLED: 1 },
    });
    expect(run.steps.values).toMatchObject({ status: 'ok', count: 1 });
    expect(run.brief?.aiUsed).toBe(false);
    expect(h.notifier.notify).toHaveBeenCalledTimes(1);
    expect(h.notifier.notify).toHaveBeenCalledWith({
      kind: 'morning-brief',
      summary: run.brief!.text,
    });
  });

  it('같은 날 다시 실행하면 건너뛰고, 강제 재실행도 중복·재기록 없이 같은 결과를 만든다', async () => {
    const h = harness();
    await h.run();
    const before = await all(h.calendar);
    // Completed day: nothing runs, nothing is sent again.
    expect(await h.run(new Date('2026-10-21T07:05:00+09:00'))).toBe('ok');
    expect(h.notifier.notify).toHaveBeenCalledTimes(1);
    expect(h.lines.join('\n')).toContain('RUN_ALREADY_COMPLETE');
    // Forced: same ids, values keep the first observedAt, no duplicates.
    await h.run(new Date('2026-10-21T08:00:00+09:00'), { force: true, trigger: 'manual' });
    const after = await all(h.calendar);
    expect(after).toHaveLength(before.length);
    expect(after.map((event) => event.id).sort()).toEqual(before.map((event) => event.id).sort());
    expect(after.find((event) => event.id === cpiId)!.values![0].observedAt).toBe(
      NOW.toISOString(),
    );
    expect((await h.runs.getRun(TODAY))!.attempts).toBe(2);
  });

  it('값이 비어 오거나 더 오래된 기간이어도 이미 붙은 값을 지우거나 되돌리지 않는다', async () => {
    const calendar = new MemoryCalendarRepository();
    const runs = new MemoryMorningRunRepository();
    await harness({ calendar, runs }).run();
    const empty = fakeFred({
      latestObservations: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, asOf: TODAY, latest: null, previous: null })),
      ),
    });
    await harness({ calendar, runs, fred: empty }).run(new Date('2026-10-22T07:00:00+09:00'));
    expect((await all(calendar)).find((event) => event.id === cpiId)!.values).toHaveLength(2);
    const older = fakeFred({
      latestObservations: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
          id,
          asOf: TODAY,
          latest: { date: '2026-08-01', value: '1' },
          previous: null,
        })),
      ),
    });
    await harness({ calendar, runs, fred: older }).run(new Date('2026-10-23T07:00:00+09:00'));
    expect((await all(calendar)).find((event) => event.id === cpiId)!.values![0]).toMatchObject({
      actual: '324.368',
      period: '2026-09-01',
    });
  });

  it('일부 단계가 실패해도 나머지를 계속하고 실행 기록에는 코드만 남긴다', async () => {
    const fred = fakeFred({
      upcomingReleases: vi.fn(async () => {
        throw new ProviderError(503, 'PROVIDER_RATE_LIMITED', 'secret-provider-text', 30);
      }),
    });
    const h = harness({ fred });
    expect(await h.run()).toBe('partial');
    const run = (await h.runs.getRun(TODAY))!;
    expect(run.status).toBe('partial');
    expect(run.steps.upcoming).toMatchObject({
      status: 'failed',
      codes: { PROVIDER_RATE_LIMITED: 1 },
    });
    expect(run.steps.news.status).toBe('ok');
    expect(run.steps.brief.status).toBe('ok');
    expect(JSON.stringify(run)).not.toContain('secret-provider-text');
    expect(h.lines.join('\n')).not.toContain('secret-provider-text');
    expect(h.notifier.notify).toHaveBeenCalledTimes(1);
  });

  it('FRED 키가 없으면 해당 단계만 건너뛰고(설정 안 됨 기록) 실패로 보지 않는다', async () => {
    const h = harness({ fred: null });
    expect(await h.run()).toBe('ok');
    const run = (await h.runs.getRun(TODAY))!;
    expect(run.steps.upcoming).toMatchObject({
      status: 'skipped',
      codes: { FRED_NOT_CONFIGURED: 1 },
    });
    expect(run.status).toBe('complete');
  });

  it('텔레그램 전송이 실패하면 기록하고 부분 실패로 끝내며 다음 실행에서 다시 보낸다', async () => {
    const notify = vi
      .fn()
      .mockResolvedValueOnce({ status: 'failed', failureCode: 'TELEGRAM_TIMEOUT', recorded: true })
      .mockResolvedValue({ status: 'sent', recorded: true });
    const h = harness({ notifier: { notify } });
    expect(await h.run()).toBe('partial');
    expect((await h.runs.getRun(TODAY))!.steps.notify).toMatchObject({
      status: 'failed',
      codes: { TELEGRAM_TIMEOUT: 1 },
    });
    expect(await h.run(new Date('2026-10-21T07:30:00+09:00'))).toBe('ok');
    expect(notify).toHaveBeenCalledTimes(2);
    expect((await h.runs.getRun(TODAY))!.notification).toEqual({
      status: 'sent',
      failureCode: null,
    });
  });

  it('알림이 설정되지 않아도(비활성) 작업은 완료되고 브리핑은 화면용으로 저장된다', async () => {
    const service = new NotificationService({
      repository: new MemoryNotificationRepository(),
      appOrigin: 'https://app.example.test',
    });
    const h = harness({ notifier: service });
    expect(await h.run()).toBe('ok');
    const run = (await h.runs.getRun(TODAY))!;
    expect(run.steps.notify).toMatchObject({ status: 'skipped', codes: { NOT_CONFIGURED: 1 } });
    expect(run.brief?.text).toContain('10월 21일 아침 브리핑');
  });
});

describe('아침 캘린더 작업 (AI 켜짐, 가짜 Vertex)', () => {
  it('결과 요약과 한국어 번역을 저장하고 원문 제목을 남기며, 다시 수집해도 지워지지 않는다', async () => {
    const ai = fakeAi();
    const h = harness({ ai });
    expect(await h.run()).toBe('ok');
    const events = await all(h.calendar);
    const cpi = events.find((event) => event.id === cpiId)!;
    expect(cpi.aiSummary).toEqual({
      text: expect.stringContaining('금리 기대'),
      model: 'gemini-fixture',
      generatedAt: NOW.toISOString(),
    });
    const news = events.find((event) => event.id === 4242)!;
    expect(news).toMatchObject({
      title: '연준 이사회, 최종 규칙 승인 발표',
      titleOriginal: 'Federal Reserve Board announces approval of final rule',
      translation: { model: 'gemini-fixture' },
      sourceUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/other20261020a.htm',
    });
    const run = (await h.runs.getRun(TODAY))!;
    expect(run.ai).toMatchObject({
      enabled: true,
      model: 'gemini-fixture',
      calls: 2,
      tokens: { prompt: 200, output: 100, thoughts: 40, total: 340 },
    });
    expect(run.brief?.aiUsed).toBe(true);
    expect(run.brief?.text).toContain('AI 요약');
    // The next morning the RSS delivers the English title again: translation and summary stay,
    // and nothing is sent to the AI a second time.
    await h.run(new Date('2026-10-22T07:00:00+09:00'));
    const again = (await all(h.calendar)).find((event) => event.id === 4242)!;
    expect(again.title).toBe('연준 이사회, 최종 규칙 승인 발표');
    expect(again.titleOriginal).toContain('Federal Reserve');
    expect((await all(h.calendar)).find((event) => event.id === cpiId)!.aiSummary?.text).toContain(
      '금리 기대',
    );
    expect(ai.summarize).toHaveBeenCalledTimes(1);
    expect(ai.translate).toHaveBeenCalledTimes(1);
  });

  it('일일 한도가 소진되면 AI 단계만 건너뛰고(실패 아님) 요약은 null로 남는다', async () => {
    const ai = fakeAi();
    ai.summarize.mockRejectedValue(new MorningAiError('AI_QUOTA_EXCEEDED'));
    ai.translate.mockRejectedValue(new MorningAiError('AI_QUOTA_EXCEEDED'));
    const h = harness({ ai });
    expect(await h.run()).toBe('ok');
    const run = (await h.runs.getRun(TODAY))!;
    expect(run.steps['ai-summary']).toMatchObject({
      status: 'skipped',
      codes: { AI_QUOTA_EXCEEDED: 1 },
    });
    expect(run.status).toBe('complete');
    expect((await all(h.calendar)).find((event) => event.id === cpiId)!.aiSummary).toBeNull();
  });

  it('AI 호출이 실패하면 부분 실패로 기록하되 일정과 브리핑은 그대로 저장한다', async () => {
    const ai = fakeAi();
    ai.summarize.mockRejectedValue(new MorningAiError('AI_RESPONSE_INVALID'));
    ai.translate.mockRejectedValue(new Error('raw provider error with secret-token'));
    const h = harness({ ai });
    expect(await h.run()).toBe('partial');
    const run = (await h.runs.getRun(TODAY))!;
    expect(run.steps['ai-summary']).toMatchObject({
      status: 'failed',
      codes: { AI_RESPONSE_INVALID: 1 },
    });
    expect(run.steps['ai-translation']).toMatchObject({
      status: 'failed',
      codes: { AI_UNAVAILABLE: 1 },
    });
    expect(JSON.stringify(run)).not.toContain('secret-token');
    expect(run.brief).not.toBeNull();
    expect(
      (await all(h.calendar)).find((event) => event.id === 4242)!.titleOriginal,
    ).toBeUndefined();
  });

  it('검증을 통과하지 못한 항목(rejected)은 저장하지 않는다', async () => {
    const ai = fakeAi();
    ai.summarize.mockResolvedValue({ items: [], rejected: 1, usage });
    const h = harness({ ai });
    expect(await h.run()).toBe('ok');
    expect((await all(h.calendar)).find((event) => event.id === cpiId)!.aiSummary).toBeNull();
    expect((await h.runs.getRun(TODAY))!.steps['ai-summary'].codes).toEqual({
      AI_OUTPUT_REJECTED: 1,
    });
  });
});

describe('값 계산과 병합', () => {
  const cpi = indicatorById('us-cpi')!;
  const fedUpper = indicatorById('us-fed-funds-upper')!;
  const base = (period: string, actual: string): EventValue => ({
    indicatorId: 'us-cpi',
    label: 'x',
    actual,
    previous: null,
    unit: '',
    period,
    previousPeriod: null,
    source: 'FRED',
    observedAt: NOW.toISOString(),
  });
  it('직전 기간 값을 새 결과로 오인하지 않는다(월간 60일, 일간은 결정일 이후 관측만)', () => {
    const at = NOW.toISOString();
    expect(
      valueFor(cpi, '2026-10-20', { date: '2026-09-01', value: '1' }, null, at),
    ).not.toBeNull();
    // FRED has not published October's... the latest is still August: too old for a 10-20 event.
    expect(valueFor(cpi, '2026-10-20', { date: '2026-08-01', value: '1' }, null, at)).toBeNull();
    expect(valueFor(cpi, '2026-10-20', { date: '2026-10-21', value: '1' }, null, at)).toBeNull();
    expect(valueFor(cpi, '2026-10-20', { date: '2026-09-01', value: null }, null, at)).toBeNull();
    expect(
      valueFor(fedUpper, '2026-10-20', { date: '2026-10-20', value: '4.5' }, null, at),
    ).toBeNull();
    expect(
      valueFor(fedUpper, '2026-10-20', { date: '2026-10-21', value: '4.25' }, null, at),
    ).toMatchObject({ actual: '4.25' });
  });
  it('mergeValues는 null·오래된 기간으로 덮지 않고 같은 값은 그대로 둔다', () => {
    const first = base('2026-09-01', '1');
    expect(mergeValues([first], [base('2026-09-01', '1')])).toEqual({
      values: [first],
      changed: false,
    });
    expect(mergeValues([first], [base('2026-08-01', '9')]).changed).toBe(false);
    expect(mergeValues([first], [base('2026-10-01', '2')])).toMatchObject({
      changed: true,
      values: [expect.objectContaining({ actual: '2' })],
    });
    expect(mergeValues(undefined, [])).toEqual({ values: [], changed: false });
  });
  it('저장소 병합은 번역·요약·값을 지키고 알려진 시각을 "미확인"으로 덮지 않는다', async () => {
    const stored = cleanEvent({
      ...englishNews(),
      title: '번역된 제목',
      titleOriginal: englishNews().title,
      translation: { model: 'm', translatedAt: NOW.toISOString() },
      aiSummary: { text: '요약', model: 'm', generatedAt: NOW.toISOString() },
      values: [base('2026-09-01', '1')],
    })!;
    const merged = mergeStoredEvent(stored, { ...englishNews(), time: '' });
    expect(merged).toMatchObject({
      title: '번역된 제목',
      time: '03:00',
      aiSummary: { text: '요약' },
    });
    expect(merged.values).toHaveLength(1);
    // A changed provider title is a different text: the old translation must not stay.
    expect(mergeStoredEvent(stored, { ...englishNews(), title: 'Another title' }).title).toBe(
      'Another title',
    );
    const inner = new MemoryCalendarRepository();
    await inner.upsert([stored], 'a');
    await new PreservingCalendarRepository(inner).upsert([englishNews()], 'b');
    expect((await inner.list('2026-10-01', '2026-10-31'))[0].title).toBe('번역된 제목');
  });
});

describe('브리핑과 알림 정제', () => {
  it('날짜는 "10월 21일" 형식으로 정제를 통과하고 링크·긴 숫자는 남지 않는다', async () => {
    const withValues = cleanEvent({
      ...englishNews(),
      id: cpiId,
      eventKind: 'scheduled',
      time: '',
      title: '미국 소비자물가지수(CPI) 발표 https://evil.example/x 12345678901',
      country: '미국',
      importance: 3,
      values: [
        {
          indicatorId: 'us-cpi',
          label: 'CPI',
          actual: '324.368',
          previous: '323.364',
          unit: '%',
          period: '2026-09-01',
          previousPeriod: '2026-08-01',
          source: 'FRED',
          observedAt: NOW.toISOString(),
        },
      ],
      aiSummary: {
        text: '이전보다 높다. 금리에 영향을 줄 수 있다.',
        model: 'm',
        generatedAt: NOW.toISOString(),
      },
    })!;
    const upcoming = cleanEvent({
      ...withValues,
      id: 7,
      date: '2026-10-24',
      title: '미국 GDP 발표',
      values: undefined,
      aiSummary: undefined,
    })!;
    const brief = buildBrief([withValues, upcoming], TODAY, NOW.toISOString());
    expect(brief.text).toContain('10월 21일 아침 브리핑');
    expect(brief.text).toContain('10월 24일');
    expect(brief.text).toContain('발표 시각 미확인');
    expect(brief.text).toContain('324.368');
    expect(brief.text).not.toMatch(/https?:|evil\.example|\d{8}/);
    expect(brief.aiUsed).toBe(true);
    // Round trip through the real service and formatter: the message keeps the dates.
    const sent: string[] = [];
    const notifier: Notifier = { send: async (message) => void sent.push(message) };
    const service = new NotificationService({
      repository: new MemoryNotificationRepository(),
      notifier,
      appOrigin: 'https://app.example.test',
    });
    expect((await service.notify({ kind: 'morning-brief', summary: brief.text })).status).toBe(
      'sent',
    );
    expect(sent[0]).toContain('10월 21일 아침 브리핑');
    expect(sent[0]).toContain('10월 24일');
    expect(sent[0]).toContain('324.368');
    expect(sent[0]).toContain('화면: https://app.example.test/calendar');
    expect(sent[0].split('\n')[1]).toBe(brief.text);
  });
  it('내용이 없으면 그렇게 말한다', () => {
    expect(buildBrief([], TODAY, NOW.toISOString()).text).toContain('주요 일정이 없습니다');
  });
});

describe('설정', () => {
  const base = {
    NODE_ENV: 'production',
    CLOUD_RUN_JOB: 'investing-morning-calendar',
    GOOGLE_CLOUD_PROJECT: 'fixture-project',
    APP_ORIGIN: 'https://app.example.test',
  };
  it('MORNING_AI_ENABLED가 없거나 false면 AI는 꺼진다', () => {
    expect(morningConfiguration(base).ai).toBeNull();
    expect(morningConfiguration({ ...base, MORNING_AI_ENABLED: 'false' }).ai).toBeNull();
    expect(morningConfiguration({ ...base, MORNING_AI_ENABLED: '' }).ai).toBeNull();
    // Even a fully configured Vertex environment does not turn it on by itself.
    expect(
      morningConfiguration({ ...base, AI_PROVIDER: 'vertex', AI_MODEL: 'gemini-3.8-flash' }).ai,
    ).toBeNull();
  });
  it('true는 Vertex 설정이 모두 있을 때만 켜지고 오타는 설정 오류다', () => {
    const vertex = { AI_PROVIDER: 'vertex', AI_MODEL: 'gemini-3.8-flash' };
    expect(morningConfiguration({ ...base, ...vertex, MORNING_AI_ENABLED: 'true' }).ai).toEqual({
      provider: 'vertex',
      config: { project: 'fixture-project', model: 'gemini-3.8-flash', location: 'global' },
    });
    // Claude on Vertex needs no model: the default is claude-sonnet-5-5.
    expect(
      morningConfiguration({
        ...base,
        AI_PROVIDER: 'vertex-claude',
        MORNING_AI_ENABLED: 'true',
      }).ai,
    ).toEqual({
      provider: 'vertex-claude',
      config: { project: 'fixture-project', model: 'claude-sonnet-5-5', location: 'global' },
    });
    expect(() => morningConfiguration({ ...base, MORNING_AI_ENABLED: 'true' })).toThrow();
    for (const value of ['TRUE', 'yes', '1', 'on'])
      expect(() =>
        morningConfiguration({ ...base, ...vertex, MORNING_AI_ENABLED: value }),
      ).toThrow();
  });
  it('운영 Cloud Run Job과 올바른 APP_ORIGIN이 아니면 실행하지 않고 수동 실행 옵션을 검사한다', () => {
    expect(() => morningConfiguration({ ...base, NODE_ENV: 'development' })).toThrow();
    expect(() => morningConfiguration({ ...base, CLOUD_RUN_JOB: undefined })).toThrow();
    expect(() => morningConfiguration({ ...base, APP_ORIGIN: 'http://insecure.test' })).toThrow();
    expect(() => morningConfiguration({ ...base, MORNING_DATE: '10-21' })).toThrow();
    expect(() => morningConfiguration({ ...base, MORNING_FORCE: 'yes' })).toThrow();
    expect(
      morningConfiguration({ ...base, MORNING_DATE: TODAY, MORNING_FORCE: '1' }).options,
    ).toEqual({
      date: TODAY,
      force: true,
      trigger: 'manual',
    });
  });
});
