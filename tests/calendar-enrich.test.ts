import { describe, expect, it, vi } from 'vitest';
import { AI_FEATURE_TOKEN_LIMITS, MemoryAiQuota, type AiQuota } from '../src/server/ai';
import { ClaudeVertexProvider, type ClaudeMessagesClient } from '../src/server/ai-provider';
import {
  ENRICH_BATCH_SIZE,
  ENRICH_SCHEMA,
  EnrichAiError,
  ProviderEnrichAi,
  allowedNumbers,
  enrichCalendar,
  validateEnrichment,
  type EnrichInput,
} from '../src/server/calendar-enrich';
import { PreservingCalendarRepository } from '../src/server/calendar-merge';
import {
  MemoryCalendarRepository,
  cleanEvent,
  type CalendarRepository,
  type EconomicEvent,
} from '../src/server/calendar';
import { ReactionCalculator, type ReactionToss } from '../src/server/reaction';

const NOW = new Date('2026-10-27T09:00:00+09:00');
const TODAY = '2026-10-27';
const config = { project: 'fixture-project', model: 'claude-sonnet-5-5', location: 'global' };
const base = {
  eventKind: 'news-release' as const,
  category: '공식 보도자료·기관발표',
  assets: ['시장전반'],
  importance: 1,
  description: 'x',
  impactDirection: 'unknown' as const,
  impactHorizon: 'x',
  confidence: 'low' as const,
  factualObservedAt: '2026-10-26T00:00:00Z',
};
const bok = (over: Partial<EconomicEvent> = {}) =>
  cleanEvent({
    ...base,
    id: 1,
    date: '2026-10-20',
    time: '10:00',
    title: '[보도자료] 한국은행 기준금리를 연 2.50%로 동결',
    country: '한국',
    sourceUrl: 'https://www.bok.or.kr/portal/a',
    sourceName: '한국은행 공식 보도자료',
    ...over,
  })!;
const fed = (over: Partial<EconomicEvent> = {}) =>
  cleanEvent({
    ...base,
    id: 2,
    date: '2026-10-22',
    time: '03:00',
    title: 'Federal Reserve Board announces approval of application by Example Bancorp',
    country: '미국',
    sourceUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/orders20261021a.htm',
    sourceName: '미 연준 공식 보도자료',
    ...over,
  })!;

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------
const DAYS = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26'];
const candles = (start: number, step: number) => ({
  candles: DAYS.map((date, index) => ({
    timestamp: `${date}T00:00:00+09:00`,
    date,
    open: '1',
    high: '1',
    low: '1',
    close: String(start + step * index),
    volume: '0',
    currency: 'USD' as const,
  })).reverse(),
  nextBefore: null,
});
function fakeToss(missing: string[] = []) {
  const data: Record<string, [number, number]> = {
    KOSPI: [2500, 10],
    KOSDAQ: [800, 2],
    KR_BOND_3Y: [3.0, 0.01],
    KR_BOND_10Y: [3.4, 0.02],
    SPY: [500, 1],
  };
  const read = async (symbol: string) =>
    missing.includes(symbol) ? { candles: [], nextBefore: null } : candles(...data[symbol]);
  return {
    marketIndicatorCandlePage: vi.fn(read),
    dailyCandlePage: vi.fn(read),
    exchangeRateAt: vi.fn(async (dateTime: string) => ({
      midRate: '1400',
      validFrom: new Date(Date.parse(dateTime) - 3600_000).toISOString(),
      validUntil: new Date(Date.parse(dateTime) + 3600_000).toISOString(),
    })),
  };
}
const reactionOf = (toss = fakeToss()) =>
  new ReactionCalculator(toss as unknown as ReactionToss, { now: () => NOW.getTime() });
const message = (text: unknown, stop = 'end_turn') => ({
  stop_reason: stop,
  content: [{ type: 'text', text: JSON.stringify(text) }],
  usage: {
    input_tokens: 1000,
    output_tokens: 500,
    output_tokens_details: { thinking_tokens: 100 },
  },
});
type Responder = (inputs: EnrichInput[]) => unknown[];
/** A Claude client whose answer is computed from the inputs the adapter really sent. */
function claude(respond: Responder, failure?: Error) {
  const create = vi.fn(async (params: { messages: { content: string }[] }) => {
    if (failure) throw failure;
    const sent = JSON.parse(params.messages[0].content).items as EnrichInput[];
    return message({ items: respond(sent) });
  });
  const client = { messages: { create } } as unknown as ClaudeMessagesClient;
  return { create, client };
}
const item = (ref: string, over: Record<string, unknown> = {}) => ({
  ref,
  titleKo: '',
  headline: '발표 내용을 정리한 한 문장',
  facts: [],
  impact: [],
  explainer: '',
  ...over,
});
const enrichAi = (client: ClaudeMessagesClient, quota: AiQuota = new MemoryAiQuota('calendar')) =>
  new ProviderEnrichAi(new ClaudeVertexProvider(config, client), quota, () => NOW.getTime());
const makeRepo = (events: EconomicEvent[]) => {
  const memory = new MemoryCalendarRepository();
  void memory.upsert(events, 'seed');
  return { memory, repo: new PreservingCalendarRepository(memory) };
};
const read = async (memory: MemoryCalendarRepository, id: number) =>
  (await memory.list('2000-01-01', '2100-01-01')).find((event) => event.id === id)!;
const options = { from: '2026-06-01', to: TODAY, force: false, maxAiCalls: 3 };
const deps = (repo: CalendarRepository, extra: Record<string, unknown> = {}) => ({
  calendar: repo,
  now: () => NOW,
  author: 'test',
  ...extra,
});

// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------
describe('AI 결과 검증(부분별로 버리고 고치지 않는다)', () => {
  const input = (over: Partial<EnrichInput> = {}): EnrichInput => ({
    ref: 'A',
    country: '한국',
    date: '2026-10-20',
    title: '한국은행 기준금리를 연 2.50%로 동결',
    importance: 'high',
    titleIsKorean: true,
    knownFacts: [{ label: '변동', value: '동결(0bp)' }],
    reaction: [
      {
        asset: 'KOSPI',
        change: 0.4,
        unit: '%',
        from: { date: '2026-10-19', value: 2500 },
        to: { date: '2026-10-20', value: 2510 },
      },
    ],
    reactionSmall: false,
    ...over,
  });
  const run = (entry: Record<string, unknown>, inputs = [input()]) =>
    validateEnrichment({ items: [item('A', entry)] }, inputs);

  it('정상 항목: 결과·영향·설명을 받아들이고 빈 문자열은 "없음"이다', () => {
    const result = run({
      headline: '기준금리를 연 2.50%로 유지했다',
      facts: [{ label: '기준금리', value: '2.50%', note: '' }],
      impact: [{ asset: '채권', effect: '금리 동결로 단기 금리 하락 압력은 제한적' }],
      explainer: '',
    });
    expect(result.rejected).toBe(0);
    expect(result.items[0]).toMatchObject({
      outcome: {
        headline: '기준금리를 연 2.50%로 유지했다',
        facts: [{ label: '기준금리', value: '2.50%' }],
      },
      impact: [{ asset: '채권', effect: expect.stringContaining('하락 압력') }],
    });
    expect(result.items[0].explainer).toBeUndefined();
    expect(result.items[0].titleKo).toBeUndefined();
  });
  it('입력에 없는 숫자는 부분을 거부한다(번호 출처 규칙)', () => {
    // 3.00 is not in the title, the known facts or the measured reaction.
    const headline = run({ headline: '기준금리를 연 3.00%로 올렸다' });
    expect(headline.items[0].outcome).toBeUndefined();
    expect(headline.rejected).toBe(1);
    const fact = run({ facts: [{ label: '기준금리', value: '3.00%', note: '' }] });
    expect(fact.items[0].outcome?.facts).toEqual([]);
    const effect = run({ impact: [{ asset: '채권', effect: '금리가 0.75%p 하락 압력' }] });
    expect(effect.items[0].impact).toBeUndefined();
    const explainer = run({ explainer: '정책금리는 3.00%이다. 기준이다.' });
    expect(explainer.items[0].explainer).toBeUndefined();
    // The measured reaction numbers (0.4, 2500, 2510) and the title numbers are allowed in facts,
    // but impact describes the mechanism and may not replay the reaction (shown separately).
    const ok = run({
      impact: [{ asset: '주식', effect: '금리 부담이 커지면 성장주에 하락 압력' }],
      facts: [{ label: '코스피 종가', value: '2510', note: '' }],
    });
    expect(ok.rejected).toBe(0);
    const replay = run({
      impact: [{ asset: '주식', effect: '코스피 0.4% 상승이 관측됨, 상승 압력 해소' }],
    });
    expect(replay.items[0].impact).toBeUndefined();
    expect(allowedNumbers(input()).has('2.5')).toBe(true);
    expect(allowedNumbers(input()).has('3')).toBe(false);
  });
  it('번역 제목은 원문 제목의 숫자만 쓸 수 있고 한글이 있어야 한다', () => {
    const english = input({
      titleIsKorean: false,
      title: 'Federal Reserve approves rule effective in 2027',
    });
    expect(run({ titleKo: '연준, 2027년 시행 규칙 승인' }, [english]).items[0].titleKo).toBe(
      '연준, 2027년 시행 규칙 승인',
    );
    expect(
      run({ titleKo: '연준, 2028년 시행 규칙 승인' }, [english]).items[0].titleKo,
    ).toBeUndefined();
    expect(
      run({ titleKo: 'Federal Reserve approves rule' }, [english]).items[0].titleKo,
    ).toBeUndefined();
    // Month names and number words count as the title's own numbers.
    const minutes = input({
      titleIsKorean: false,
      title: 'Minutes of the Federal Open Market Committee, September 15-16, 2026',
    });
    expect(
      run({ titleKo: '연방공개시장위원회 의사록(2026년 9월 15~16일)' }, [minutes]).items[0].titleKo,
    ).toBe('연방공개시장위원회 의사록(2026년 9월 15~16일)');
    expect(
      run({ titleKo: '연방공개시장위원회 의사록(2026년 10월 15~16일)' }, [minutes]).items[0]
        .titleKo,
    ).toBeUndefined();
    const party = input({
      titleIsKorean: false,
      title: 'Agencies seek comment on third-party risk',
    });
    expect(run({ titleKo: '감독기관, 제3자 위험 관리 의견 수렴' }, [party]).items[0].titleKo).toBe(
      '감독기관, 제3자 위험 관리 의견 수렴',
    );
    // A Korean source keeps its title: whatever the model returns there is ignored.
    expect(run({ titleKo: '다른 제목' }).items[0].titleKo).toBeUndefined();
  });
  it('링크·이메일·긴 숫자·마크업·매수 권유·확률은 거부한다', () => {
    for (const bad of [
      '자세한 내용은 https://example.com 참고',
      '문의 a@b.co 로 연락',
      '번호 1234 5678 9012',
      '<b>강조</b>',
      '지금 매수하세요',
      '목표 주가를 올릴 만하다',
    ]) {
      const result = run({
        headline: `기준금리 동결 ${bad}`,
        impact: [{ asset: '주식', effect: `상승 압력 ${bad}` }],
      });
      expect(result.items[0].outcome, bad).toBeUndefined();
      expect(result.items[0].impact, bad).toBeUndefined();
    }
  });
  it('영향 문장은 방향 단어가 있어야 하고 60자·4개 한도를 넘지 않는다', () => {
    expect(
      run({ impact: [{ asset: '채권', effect: '채권 시장을 살펴볼 만하다' }] }).items[0].impact,
    ).toBeUndefined();
    const long = '채권 금리 하락 압력이 가능하다 '.repeat(5);
    expect(run({ impact: [{ asset: '채권', effect: long }] }).items[0].impact).toBeUndefined();
    const five = Array.from({ length: 5 }, (_, i) => ({
      asset: `자산${i}`.replace(/\d/, '가'),
      effect: '상승 압력',
    }));
    const result = run({ impact: five });
    expect(result.items[0].impact).toHaveLength(4);
    expect(result.rejected).toBe(1);
  });
  it('"시장 영향은 작음" 표현은 측정된 반응이 작을 때만 허용한다', () => {
    const phrase = [{ asset: '시장 전반', effect: '직접적인 시장 영향은 작음' }];
    expect(run({ impact: phrase }).items[0].impact).toBeUndefined();
    expect(run({ impact: phrase }, [input({ reactionSmall: true })]).items[0].impact).toEqual(
      phrase,
    );
  });
  it('설명은 2문장 이하이며 어려운 개념이 없으면 빈 문자열', () => {
    expect(
      run({ explainer: '할인율은 중앙은행이 은행에 빌려주는 금리이다. 정책 신호로도 쓰인다.' })
        .items[0].explainer,
    ).toContain('할인율');
    expect(run({ explainer: '첫째이다. 둘째이다. 셋째이다.' }).items[0].explainer).toBeUndefined();
  });
  it('봉투·필드·참조가 어긋나면 항목이나 전체를 버린다', () => {
    expect(() => validateEnrichment({ items: [], extra: 1 }, [input()])).toThrow();
    expect(() => validateEnrichment({ items: [item('A'), item('B')] }, [input()])).toThrow();
    expect(() => validateEnrichment('x', [input()])).toThrow();
    const unknownRef = validateEnrichment({ items: [item('Z')] }, [input()]);
    expect(unknownRef).toEqual({ items: [], rejected: 1 });
    const dup = validateEnrichment({ items: [item('A'), item('A')] }, [input(), input()]);
    expect(dup.items).toHaveLength(1);
    const extraKey = validateEnrichment({ items: [{ ...item('A'), surprise: 1 }] }, [input()]);
    expect(extraKey.items).toHaveLength(0);
    expect(ENRICH_SCHEMA.additionalProperties).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------
describe('ProviderEnrichAi', () => {
  it('Claude 요청 모양: 낮은 effort, json_schema, 참조는 글자, 최소화된 입력', async () => {
    const { create, client } = claude((sent) => sent.map((entry) => item(entry.ref)));
    const ai = enrichAi(client);
    const result = await ai.enrich([
      {
        ref: 'A',
        country: '미국',
        date: '2026-10-20',
        title: 'Fed approves rule https://x.example 12345678901 a@b.co',
        importance: 'low',
        titleIsKorean: false,
        knownFacts: [],
        reaction: [],
        reactionSmall: false,
      },
    ]);
    expect(ai.model).toBe('Claude Sonnet 5.5');
    expect(result.usage).toEqual({ prompt: 1000, output: 500, thoughts: 100, total: 1500 });
    const [params] = create.mock.calls[0];
    const body = params as unknown as {
      output_config: {
        effort: string;
        format: { type: string; schema: { additionalProperties: boolean } };
      };
      messages: { content: string }[];
    };
    expect(body.output_config.effort).toBe('low');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema.additionalProperties).toBe(false);
    expect(JSON.stringify(body.output_config.format.schema)).not.toContain('maxItems');
    expect(body.messages[0].content).not.toMatch(/https?:|12345678901|@/);
  });
  it('캘린더 일일 한도는 토큰 기준 20만이고, 끝난 호출의 실제 토큰을 기록한다', async () => {
    expect(AI_FEATURE_TOKEN_LIMITS.calendar).toBe(200_000);
    const quota = new MemoryAiQuota('calendar');
    const ai = enrichAi(claude((sent) => sent.map((entry) => item(entry.ref))).client, quota);
    await ai.enrich([minimalInput()]);
    // Each fake call reports 1,500 tokens (1,000 in + 500 out).
    await quota.record(TODAY, 200_000 - 1_500 - 1);
    await expect(ai.enrich([minimalInput()])).resolves.toBeDefined(); // 199,999 < 200,000
    await expect(ai.enrich([minimalInput()])).rejects.toMatchObject({ code: 'AI_QUOTA_EXCEEDED' });
    // The next KST day starts from zero; other features keep call limits and ignore tokens.
    expect(await quota.consume('2026-10-28')).toBe(true);
    const morning = new MemoryAiQuota('morning');
    await morning.record(TODAY, 10_000_000);
    expect(await morning.consume(TODAY)).toBe(true);
  });
  it('일일 한도(기능별 calendar)·공급자 429·거절은 고정 코드로 던진다', async () => {
    const exhausted = enrichAi(claude(() => []).client, { consume: async () => false });
    await expect(exhausted.enrich([minimalInput()])).rejects.toMatchObject({
      code: 'AI_QUOTA_EXCEEDED',
    });
    const limited = Object.assign(new Error('RESOURCE_EXHAUSTED secret detail'), { status: 429 });
    const quota = claude(() => [], limited);
    await expect(enrichAi(quota.client).enrich([minimalInput()])).rejects.toMatchObject({
      code: 'AI_QUOTA_PROVIDER',
    });
    expect(quota.create).toHaveBeenCalledTimes(1);
    const refused = {
      messages: { create: vi.fn(async () => ({ stop_reason: 'refusal', content: [] })) },
    };
    await expect(
      enrichAi(refused as unknown as ClaudeMessagesClient).enrich([minimalInput()]),
    ).rejects.toMatchObject({ code: 'AI_REFUSED' });
  });
  it('입력 한도: 비었거나 10개를 넘으면 호출하지 않는다', async () => {
    const { create, client } = claude(() => []);
    const ai = enrichAi(client);
    await expect(ai.enrich([])).rejects.toMatchObject({ code: 'AI_INPUT_TOO_LARGE' });
    await expect(
      ai.enrich(Array.from({ length: ENRICH_BATCH_SIZE + 1 }, () => minimalInput())),
    ).rejects.toMatchObject({ code: 'AI_INPUT_TOO_LARGE' });
    expect(create).not.toHaveBeenCalled();
  });
});
const minimalInput = (): EnrichInput => ({
  ref: 'A',
  country: '한국',
  date: '2026-10-20',
  title: '한국은행 발표',
  importance: 'low',
  titleIsKorean: true,
  knownFacts: [],
  reaction: [],
  reactionSmall: false,
});

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------
describe('enrichCalendar', () => {
  const responder: Responder = (sent) =>
    sent.map((entry) =>
      entry.titleIsKorean
        ? item(entry.ref, {
            headline: '기준금리를 연 2.50%로 유지했다',
            facts: [
              { label: '기준금리', value: '2.50%', note: '' },
              { label: '변동', value: '동결', note: '' },
            ],
            impact: [{ asset: '채권', effect: '금리 동결로 단기 금리 상승 압력 완화' }],
            explainer:
              '정책금리 경로는 앞으로 금리가 어떻게 움직일지에 대한 중앙은행의 방향을 뜻한다.',
          })
        : item(entry.ref, {
            titleKo: '연준, 예시 은행지주회사 신청 승인 발표',
            headline: '연준 이사회가 은행지주회사의 신청을 승인했다',
            impact: [],
          }),
    );
  it('정리 → 시장 반응 → 한국어 결과·영향이 한 번에 저장되고 출처가 남는다', async () => {
    const { memory, repo } = makeRepo([bok(), fed()]);
    const { client, create } = claude(responder);
    const report = await enrichCalendar(
      deps(repo, { reaction: reactionOf(), ai: enrichAi(client) }),
      options,
    );
    expect(report).toMatchObject({
      examined: 2,
      cleaned: 1,
      reactions: 2,
      enriched: 2,
      aiCalls: 1,
    });
    expect(report.failures).toEqual([]);
    expect(report.usage).toEqual({ prompt: 1000, output: 500, thoughts: 100, total: 1500 });
    expect(create).toHaveBeenCalledTimes(1);

    const stored = await read(memory, 1);
    expect(stored).toMatchObject({
      title: '한국은행 기준금리를 연 2.50%로 동결',
      titleOriginal: '[보도자료] 한국은행 기준금리를 연 2.50%로 동결',
      releaseType: '보도자료',
      outcome: { headline: '기준금리를 연 2.50%로 유지했다' },
      explainer: expect.stringContaining('정책금리 경로'),
      enrichment: {
        model: 'Claude Sonnet 5.5',
        version: 1,
        aiFields: ['outcome', 'impact', 'explainer'],
      },
    });
    expect(stored.outcome?.facts.map((f) => f.label)).toEqual(['기준금리', '변동']);
    expect(stored.impact).toEqual([
      { asset: '채권', effect: '금리 동결로 단기 금리 상승 압력 완화' },
    ]);
    expect(stored.reaction?.map((row) => row.asset)).toEqual([
      'KOSPI',
      'KOSDAQ',
      'KR_BOND_3Y',
      'KR_BOND_10Y',
      'USDKRW',
    ]);
    expect(stored.translation).toBeUndefined();

    const translated = await read(memory, 2);
    expect(translated).toMatchObject({
      title: '연준, 예시 은행지주회사 신청 승인 발표',
      titleOriginal: 'Federal Reserve Board announces approval of application by Example Bancorp',
      translation: { model: 'Claude Sonnet 5.5' },
      enrichment: { aiFields: ['title', 'outcome'] },
    });
    expect(translated.reaction?.map((row) => row.asset)[0]).toBe('SPY');
    // No AI impact, a low-importance release and small measured moves: the fixed sentence.
    expect(translated.impact).toEqual([
      { asset: '시장 전반', effect: '직접적인 시장 영향은 작음(발표 전후 변동 작음)' },
    ]);
    // The model saw the measured numbers, never an event id or a link.
    const sent = create.mock.calls[0][0].messages[0].content;
    expect(sent).toContain('"reaction"');
    expect(sent).not.toMatch(/https?:|"id"|bok\.or\.kr|federalreserve/);
  });
  it('두 번째 실행은 아무것도 다시 쓰지 않고 AI를 부르지 않는다(멱등)', async () => {
    const { memory, repo } = makeRepo([bok(), fed()]);
    const first = claude(responder);
    await enrichCalendar(
      deps(repo, { reaction: reactionOf(), ai: enrichAi(first.client) }),
      options,
    );
    const before = JSON.stringify(await memory.list('2000-01-01', '2100-01-01'));
    const second = claude(responder);
    const report = await enrichCalendar(
      deps(repo, { reaction: reactionOf(), ai: enrichAi(second.client) }),
      options,
    );
    expect(second.create).not.toHaveBeenCalled();
    expect(report).toMatchObject({ cleaned: 0, reactions: 0, enriched: 0, aiCalls: 0 });
    expect(JSON.stringify(await memory.list('2000-01-01', '2100-01-01'))).toBe(before);
    // CALENDAR_ENRICH_FORCE=1 recomputes and rewrites.
    const forced = claude(responder);
    const rerun = await enrichCalendar(
      deps(repo, { reaction: reactionOf(), ai: enrichAi(forced.client) }),
      { ...options, force: true },
    );
    expect(forced.create).toHaveBeenCalledTimes(1);
    expect(rerun.enriched).toBe(2);
  });
  it('AI 없이도 정리와 시장 반응은 하고 AI_DISABLED를 기록한다', async () => {
    const { memory, repo } = makeRepo([bok(), fed()]);
    const report = await enrichCalendar(deps(repo, { reaction: reactionOf() }), options);
    expect(report).toMatchObject({ cleaned: 1, reactions: 2, enriched: 0, aiCalls: 0 });
    expect(report.codes.AI_DISABLED).toBe(1);
    expect(report.failures).toEqual([]);
    const stored = await read(memory, 1);
    expect(stored.title).toBe('한국은행 기준금리를 연 2.50%로 동결');
    expect(stored.reaction).toHaveLength(5);
    expect(stored.enrichment).toBeUndefined();
    // A later run with AI still enriches: the events were not marked as done.
    const { client } = claude(responder);
    const later = await enrichCalendar(
      deps(repo, { reaction: reactionOf(), ai: enrichAi(client) }),
      options,
    );
    expect(later.enriched).toBe(2);
    expect((await read(memory, 1)).reaction).toHaveLength(5);
  });
  it('Toss가 없으면 반응은 건너뛰고(TOSS_NOT_CONFIGURED) AI는 계속한다', async () => {
    const { memory, repo } = makeRepo([bok()]);
    const { client } = claude(responder);
    const report = await enrichCalendar(deps(repo, { ai: enrichAi(client) }), options);
    expect(report.codes.TOSS_NOT_CONFIGURED).toBe(1);
    expect(report.enriched).toBe(1);
    expect((await read(memory, 1)).reaction).toBeUndefined();
  });
  it('거절 폴백 모델이 답했으면 그 모델 ID를 저장하고 AI_FALLBACK_SERVED를 기록한다(실패 아님)', async () => {
    const { memory, repo } = makeRepo([bok()]);
    const inner = enrichAi(claude(responder).client);
    const ai = {
      model: inner.model,
      enrich: async (items: EnrichInput[]) => ({
        ...(await inner.enrich(items)),
        fallbackModel: 'claude-sonnet-5',
      }),
    };
    const report = await enrichCalendar(deps(repo, { ai }), options);
    expect(report.codes.AI_FALLBACK_SERVED).toBe(1);
    expect(report.failures).toEqual([]);
    expect((await read(memory, 1)).enrichment?.model).toBe('claude-sonnet-5');
  });
  it('월 예산 중지(BUDGET_STOPPED)는 실패가 아닌 기록이고 남은 배치를 멈춘다', async () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      bok({ id: 300 + i, title: `한국은행 발표 ${String.fromCharCode(97 + i)}` }),
    );
    const { repo } = makeRepo(events);
    const enrich = vi.fn(async () => {
      throw new EnrichAiError('BUDGET_STOPPED');
    });
    const report = await enrichCalendar(
      deps(repo, { ai: { model: 'Claude Sonnet 5.5', enrich } }),
      options,
    );
    expect(report.codes.BUDGET_STOPPED).toBe(1);
    expect(report.failures).toEqual([]);
    expect(enrich).toHaveBeenCalledTimes(1);
  });
  it('일일 한도를 다 쓰면 건너뛰고(실패 아님), 공급자 429는 실패로 기록하고 멈춘다', async () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      bok({ id: 100 + i, title: `한국은행 발표 ${String.fromCharCode(97 + i)}` }),
    );
    const { repo } = makeRepo(events);
    const spent = await enrichCalendar(
      deps(repo, { ai: enrichAi(claude(responder).client, { consume: async () => false }) }),
      options,
    );
    expect(spent.codes.AI_QUOTA_EXCEEDED).toBe(1);
    expect(spent.failures).toEqual([]);
    expect(spent.aiCalls).toBe(1);

    const limited = claude(
      responder,
      Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }),
    );
    const { repo: other } = makeRepo(events);
    const report = await enrichCalendar(deps(other, { ai: enrichAi(limited.client) }), options);
    expect(report.codes.AI_QUOTA_PROVIDER).toBe(1);
    expect(report.failures).toEqual(['AI_QUOTA_PROVIDER']);
    // Stopped after the first failing batch: a provider quota problem is not retried 11 more times.
    expect(limited.create).toHaveBeenCalledTimes(1);
    expect(report.enriched).toBe(0);
  });
  it('AI가 거절한 배치(AI_REFUSED)는 기록하되 다음 배치는 시도한다', async () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      bok({ id: 200 + i, title: `한국은행 공표 ${String.fromCharCode(97 + i)}` }),
    );
    const { repo } = makeRepo(events);
    let calls = 0;
    const create = vi.fn(async (params: { messages: { content: string }[] }) => {
      calls++;
      if (calls === 1) return { stop_reason: 'refusal', content: [] };
      return message({
        items: (JSON.parse(params.messages[0].content).items as EnrichInput[]).map((entry) =>
          item(entry.ref),
        ),
      });
    });
    const report = await enrichCalendar(
      deps(repo, { ai: enrichAi({ messages: { create } } as unknown as ClaudeMessagesClient) }),
      options,
    );
    expect(report.codes.AI_REFUSED).toBe(1);
    expect(report.failures).toEqual(['AI_REFUSED']);
    expect(report.aiCalls).toBe(2);
    expect(report.enriched).toBe(2);
  });
  it('일부 항목만 검증을 통과하면 통과한 부분만 저장하고 거부 수를 기록한다', async () => {
    const { memory, repo } = makeRepo([bok()]);
    const { client } = claude((sent) =>
      sent.map((entry) =>
        item(entry.ref, {
          headline: '기준금리를 연 9.99%로 올렸다',
          impact: [{ asset: '채권', effect: '금리 하락 압력' }],
        }),
      ),
    );
    const report = await enrichCalendar(deps(repo, { ai: enrichAi(client) }), options);
    expect(report.rejected).toBe(1);
    expect(report.codes.AI_OUTPUT_REJECTED).toBe(1);
    const stored = await read(memory, 1);
    expect(stored.outcome).toBeUndefined();
    expect(stored.impact).toEqual([{ asset: '채권', effect: '금리 하락 압력' }]);
    expect(stored.enrichment?.aiFields).toEqual(['impact']);
  });
  it('반응이 아직 측정 중인 최근 이벤트는 AI를 미룬다', async () => {
    const recent = bok({ id: 5, date: TODAY, time: '08:00' });
    const { memory, repo } = makeRepo([recent]);
    const { client, create } = claude(responder);
    const report = await enrichCalendar(
      deps(repo, { reaction: reactionOf(), ai: enrichAi(client) }),
      options,
    );
    expect(report.codes.AI_DEFERRED_REACTION_PENDING).toBe(1);
    expect(create).not.toHaveBeenCalled();
    expect((await read(memory, 5)).enrichment).toBeUndefined();
    // Nothing measured yet stays "not computed" so that a later run measures it.
    expect((await read(memory, 5)).reaction).toBeUndefined();
  });
  it('작은 반응·낮은 중요도·AI 영향 없음이면 고정 문구로 "시장 영향은 작음"을 쓴다', async () => {
    const { memory, repo } = makeRepo([bok({ title: '한국은행 업무 공지 알림' })]);
    const { client } = claude((sent) => sent.map((entry) => item(entry.ref)));
    await enrichCalendar(deps(repo, { reaction: reactionOf(), ai: enrichAi(client) }), options);
    expect((await read(memory, 1)).impact).toEqual([
      { asset: '시장 전반', effect: '직접적인 시장 영향은 작음(발표 전후 변동 작음)' },
    ]);
    // A large move: no such sentence, and the model may not write it either.
    const big = fakeToss();
    big.marketIndicatorCandlePage.mockImplementation(async (symbol: string) => {
      const page = candles(symbol === 'KOSPI' ? 2500 : 3, symbol === 'KOSPI' ? 100 : 0.01);
      return page;
    });
    const { memory: memory2, repo: repo2 } = makeRepo([bok({ title: '한국은행 업무 공지 알림' })]);
    const phrase = claude((sent) =>
      sent.map((entry) =>
        item(entry.ref, { impact: [{ asset: '시장 전반', effect: '직접적인 시장 영향은 작음' }] }),
      ),
    );
    await enrichCalendar(
      deps(repo2, { reaction: reactionOf(big), ai: enrichAi(phrase.client) }),
      options,
    );
    expect((await read(memory2, 1)).impact).toBeUndefined();
  });
  it('공식 정책금리 수치(knownFacts)가 결과 표 앞에 오고 AI 문장이 그 숫자를 쓸 수 있다', async () => {
    const { memory, repo } = makeRepo([bok({ title: '2026년 10월 통화정책방향' })]);
    const policyFacts = vi.fn(async () => [
      { label: '기준금리', value: '2.50%', note: '출처: 한국은행 ECOS, 2026-10-20 기준' },
      { label: '변동', value: '동결(0bp)' },
    ]);
    const { client, create } = claude((sent) =>
      sent.map((entry) => item(entry.ref, { headline: '기준금리를 연 2.50%로 동결했다' })),
    );
    await enrichCalendar(deps(repo, { ai: enrichAi(client), policyFacts }), options);
    const stored = await read(memory, 1);
    expect(stored.outcome).toEqual({
      headline: '기준금리를 연 2.50%로 동결했다',
      facts: [
        { label: '기준금리', value: '2.50%', note: '출처: 한국은행 ECOS, 2026-10-20 기준' },
        { label: '변동', value: '동결(0bp)' },
      ],
    });
    expect(create.mock.calls[0][0].messages[0].content).toContain('knownFacts');
    // A failing facts provider never blocks the run.
    const { repo: other } = makeRepo([bok({ title: '2026년 10월 통화정책방향' })]);
    const failing = await enrichCalendar(
      deps(other, {
        ai: enrichAi(claude((sent) => sent.map((e) => item(e.ref))).client),
        policyFacts: vi.fn(async () => {
          throw new Error('x');
        }),
      }),
      options,
    );
    expect(failing.codes.POLICY_FACTS_FAILED).toBe(1);
    expect(failing.enriched).toBe(1);
  });
  it('공식 수치가 아직 없으면(null) 최근 일정은 AI를 미루고, 일주일이 지나면 수치 없이 보강한다', async () => {
    const { memory, repo } = makeRepo([
      bok({ id: 1, title: '2026년 9월 생산자물가지수(잠정)', date: '2026-10-20' }),
      bok({ id: 2, title: '2026년 7월 생산자물가지수(잠정)', date: '2026-08-21' }),
    ]);
    const { client, create } = claude((sent) => sent.map((entry) => item(entry.ref)));
    const report = await enrichCalendar(
      deps(repo, { ai: enrichAi(client), policyFacts: vi.fn(async () => null) }),
      options,
    );
    expect(report.codes.AI_DEFERRED_FACTS_PENDING).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].messages[0].content).toContain('2026-08-21');
    expect(create.mock.calls[0][0].messages[0].content).not.toContain('2026-10-20');
    expect((await read(memory, 1)).enrichment).toBeUndefined();
    expect((await read(memory, 2)).enrichment).toBeDefined();
  });
  it('보강은 됐지만 제목이 아직 원문(영어)인 일정은 다시 대상이 된다', async () => {
    const enrichment = {
      model: 'm',
      generatedAt: '2026-10-21T00:00:00.000Z',
      version: 1,
      aiFields: ['outcome'],
    };
    const { repo } = makeRepo([
      bok({
        id: 1,
        title: 'Minutes of the Federal Open Market Committee',
        country: '미국',
        enrichment,
      } as never),
      bok({ id: 2, title: '한국은행 발표', enrichment } as never),
    ]);
    const { client, create } = claude((sent) => sent.map((entry) => item(entry.ref)));
    await enrichCalendar(deps(repo, { ai: enrichAi(client) }), options);
    expect(create).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(create.mock.calls[0][0].messages[0].content).items;
    expect(sent.map((entry: { title: string }) => entry.title)).toEqual([
      'Minutes of the Federal Open Market Committee',
    ]);
  });
  it('저장된 값을 널이나 더 적은 값으로 덮지 않는다(보존 저장)', async () => {
    const stored = bok({
      outcome: { headline: '이미 있는 결과', facts: [] },
      reaction: [
        {
          asset: 'SPY',
          from: { date: '2026-10-19', value: 1 },
          to: { date: '2026-10-20', value: 2 },
          change: 100,
          unit: '%',
          source: '이전 실행',
        },
      ],
      enrichment: {
        model: 'old',
        generatedAt: '2026-10-21T00:00:00.000Z',
        version: 1,
        aiFields: ['outcome'],
      },
    });
    const { memory, repo } = makeRepo([stored]);
    // Fewer series this time (KOSDAQ and both bonds missing) and force: the old SPY row stays.
    await enrichCalendar(
      deps(repo, { reaction: reactionOf(fakeToss(['KOSDAQ', 'KR_BOND_3Y', 'KR_BOND_10Y'])) }),
      { ...options, force: true },
    );
    const after = await read(memory, 1);
    expect(after.reaction?.map((row) => row.asset)).toEqual(['SPY', 'KOSPI', 'USDKRW']);
    expect(after.reaction?.find((row) => row.asset === 'SPY')?.source).toBe('이전 실행');
    expect(after.outcome).toEqual({ headline: '이미 있는 결과', facts: [] });
    expect(after.enrichment?.model).toBe('old');
  });
  it('쓰기 실패는 CALENDAR_WRITE_FAILED로 기록한다', async () => {
    const memory = new MemoryCalendarRepository();
    await memory.upsert([bok()], 'seed');
    const broken: CalendarRepository = {
      list: (from, to) => memory.list(from, to),
      upsert: async () => {
        throw new Error('firestore down');
      },
    };
    const report = await enrichCalendar(deps(broken, { reaction: reactionOf() }), options);
    expect(report.failures).toEqual(['CALENDAR_WRITE_FAILED']);
  });
  it('시각 미확인 이벤트는 반응 없이 AI만 받는다', async () => {
    const scheduled = cleanEvent({
      ...base,
      id: 9,
      eventKind: 'scheduled',
      date: '2026-10-20',
      time: '',
      title: '미국 소비자물가지수(CPI) 발표',
      country: '미국',
      sourceUrl: 'https://fred.stlouisfed.org/release?rid=10',
      sourceName: 'FRED',
    })!;
    const { memory, repo } = makeRepo([scheduled]);
    const { client } = claude((sent) => sent.map((entry) => item(entry.ref)));
    const report = await enrichCalendar(
      deps(repo, { reaction: reactionOf(), ai: enrichAi(client) }),
      options,
    );
    expect(report.codes.RELEASE_TIME_UNKNOWN).toBe(1);
    expect(report.enriched).toBe(1);
    expect((await read(memory, 9)).reaction).toBeUndefined();
  });
});
