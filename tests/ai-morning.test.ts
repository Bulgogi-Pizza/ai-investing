import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';
import {
  AI_FEATURE_LIMITS,
  FirestoreAiQuota,
  MemoryAiQuota,
  aiUsageDocumentId,
  type AiQuota,
} from '../src/server/ai';
import {
  MORNING_AI_TASKS,
  MorningAiError,
  VertexMorningAi,
  morningAiConfigFromEnvironment,
  unsafeMorningText,
  validateSummaries,
  validateTranslations,
  type MorningSummaryInput,
} from '../src/server/ai-morning';

const config = { project: 'fixture-project', model: 'gemini-3.8-flash', location: 'global' };
const auth = () => ({ getAccessToken: vi.fn(async () => 'fixture-bearer') });
const summaryInput: MorningSummaryInput = {
  refId: 'e1',
  date: '2026-10-20',
  title: '미국 소비자물가지수(CPI) 발표',
  importance: 3,
  values: [
    {
      label: '미국 소비자물가지수',
      actual: '324.368',
      previous: '323.364',
      unit: '지수',
      period: '2026-09-01',
      previousPeriod: '2026-08-01',
    },
  ],
};
const goodSummary = '발표값 324.368은 이전 323.364보다 높다. 금리 기대에 영향을 줄 수 있다.';
function reply(
  payload: unknown,
  extra: { finishReason?: string; usage?: Record<string, number>; status?: number } = {},
) {
  return Response.json(
    {
      candidates: [
        {
          finishReason: extra.finishReason ?? 'STOP',
          content: { parts: [{ text: JSON.stringify(payload) }] },
        },
      ],
      usageMetadata: extra.usage,
    },
    { status: extra.status ?? 200 },
  );
}
const client = (transport: unknown, quota: AiQuota = new MemoryAiQuota('morning')) =>
  new VertexMorningAi(config, quota, transport as typeof fetch, auth(), () =>
    Date.parse('2026-10-21T07:00:00+09:00'),
  );

describe('아침 AI 계약: 요청', () => {
  it('공식 REST 형태, 작업별 출력 한도, 생각 수준(thinkingLevel)을 보내고 thinkingBudget은 보내지 않는다', async () => {
    const transport = vi.fn(async () =>
      reply(
        { summaries: [{ refId: 'e1', text: goodSummary }] },
        {
          usage: {
            promptTokenCount: 300,
            candidatesTokenCount: 90,
            thoughtsTokenCount: 40,
            totalTokenCount: 430,
          },
        },
      ),
    );
    const result = await client(transport).summarize([summaryInput]);
    expect(result.items).toEqual([{ refId: 'e1', text: goodSummary }]);
    expect(result.usage).toEqual({ prompt: 300, output: 90, thoughts: 40, total: 430 });
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://aiplatform.googleapis.com/v1/projects/fixture-project/locations/global/publishers/google/models/gemini-3.8-flash:generateContent',
    );
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture-bearer' });
    const body = JSON.parse(String(init.body));
    expect(body.generationConfig).toMatchObject({
      candidateCount: 1,
      maxOutputTokens: MORNING_AI_TASKS.summary.maxOutputTokens,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingLevel: 'LOW' },
    });
    expect(body.generationConfig.thinkingConfig).not.toHaveProperty('thinkingBudget');
    expect(body.generationConfig.responseSchema.required).toEqual(['summaries']);
    // Only the fields needed for the summary leave the process.
    expect(String(init.body)).not.toMatch(/https?:|@|authorization/i);
  });
  it('번역 호출은 자체 스키마와 출력 한도를 쓴다', async () => {
    const transport = vi.fn(async () =>
      reply({ translations: [{ refId: 't1', titleKo: '연준 최종 규칙 승인' }] }),
    );
    const result = await client(transport).translate([
      { refId: 't1', title: 'Federal Reserve approves final rule https://x.example 12345678901' },
    ]);
    expect(result.items).toEqual([{ refId: 't1', titleKo: '연준 최종 규칙 승인' }]);
    const body = JSON.parse(
      String((transport.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(body.generationConfig.maxOutputTokens).toBe(
      MORNING_AI_TASKS.translation.maxOutputTokens,
    );
    expect(body.generationConfig.responseSchema.required).toEqual(['translations']);
    // URLs and long digit runs in the untrusted title are removed before they reach the model.
    expect(body.contents[0].parts[0].text).not.toMatch(/https?:|12345678901/);
  });
  it('입력이 비었거나 한도를 넘으면 호출하지 않는다', async () => {
    const transport = vi.fn();
    const ai = client(transport);
    await expect(ai.summarize([])).rejects.toMatchObject({ code: 'AI_INPUT_TOO_LARGE' });
    await expect(
      ai.translate(Array.from({ length: 21 }, (_, i) => ({ refId: `t${i}`, title: 'x' }))),
    ).rejects.toMatchObject({ code: 'AI_INPUT_TOO_LARGE' });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('아침 AI 계약: 응답 검증(엄격, 항목별)', () => {
  const run = async (text: string, input = summaryInput) =>
    (
      await client(vi.fn(async () => reply({ summaries: [{ refId: 'e1', text }] }))).summarize([
        input,
      ])
    ).items;
  it('링크·이메일·긴 숫자·마크업을 거부한다', async () => {
    for (const bad of [
      `${goodSummary} 자세한 내용은 https://example.com 참고.`,
      `${goodSummary} 문의 a@b.co`,
      `${goodSummary} 번호 1234 5678 9012`,
      `${goodSummary} <b>강조</b>`,
      `${goodSummary} [링크](x)`,
      `${goodSummary} www.example.com`,
    ])
      expect(await run(bad), bad).toEqual([]);
  });
  it('매수·매도 권유, 목표가, 비중 제안, 수익 보장, 확률 수치를 거부한다', async () => {
    for (const bad of [
      '발표값 324.368은 이전보다 높다. 지금 매수하세요.',
      '발표값 324.368은 이전보다 높다. 목표 주가를 올릴 만하다.',
      '발표값 324.368은 이전보다 높다. 채권 비중 확대가 좋다.',
      '발표값 324.368은 이전보다 높다. 주식 비중을 60%로 늘리세요.',
      '발표값 324.368은 이전보다 높다. 상승 확률 70%로 본다.',
      '발표값 324.368은 이전보다 높다. 수익이 보장된다. 수익 보장이다.',
      '발표값 324.368은 이전보다 높다. 매수 추천 의견이다.',
    ])
      expect(await run(bad), bad).toEqual([]);
  });
  it('입력에 없는 숫자, 문장 수 위반, 너무 짧은 글, 알 수 없는 refId, 중복을 거부한다', async () => {
    expect(await run('발표값 999.1은 이전 323.364보다 높다. 영향이 있을 수 있다.')).toEqual([]);
    expect(await run('발표값 324.368은 이전 323.364보다 높다.')).toEqual([]);
    expect(
      await run('발표값 324.368은 이전보다 높다. 영향이 있다. 변동이 있다. 주의가 필요하다.'),
    ).toEqual([]);
    expect(await run('짧다. 짧다.')).toEqual([]);
    const payload = {
      summaries: [
        { refId: 'zzz', text: goodSummary },
        { refId: 'e1', text: goodSummary },
        { refId: 'e1', text: goodSummary },
      ],
    };
    const result = await client(vi.fn(async () => reply(payload))).summarize([
      summaryInput,
      { ...summaryInput, refId: 'e2' },
      { ...summaryInput, refId: 'e3' },
    ]);
    expect(result.items).toEqual([{ refId: 'e1', text: goodSummary }]);
    expect(result.rejected).toBe(2);
  });
  it('입력의 숫자는 천 단위 쉼표나 자릿수 표기 차이가 있어도 허용한다', async () => {
    const input = {
      ...summaryInput,
      values: [{ ...summaryInput.values[0], actual: '158123', previous: '157000' }],
    };
    expect(
      await run(
        '고용은 158,123명으로 이전 157,000명보다 많다. 금리 기대에 영향을 줄 수 있다.',
        input,
      ),
    ).toHaveLength(1);
  });
  it('봉투가 스키마와 다르면 전체를 거부한다', async () => {
    for (const payload of [
      { summaries: [], extra: 1 },
      { other: [] },
      [],
      'text',
      { summaries: 'x' },
      { summaries: [1] },
      {
        summaries: [
          { refId: 'e1', text: goodSummary },
          { refId: 'e1', text: goodSummary },
        ],
      },
    ])
      await expect(
        client(vi.fn(async () => reply(payload))).summarize([summaryInput]),
      ).rejects.toMatchObject({ code: 'AI_RESPONSE_INVALID' });
  });
  it('잘린 응답(MAX_TOKENS), 생각 파트, 빈 본문, 오류 응답은 쓰지 않는다', async () => {
    await expect(
      client(vi.fn(async () => reply({ summaries: [] }, { finishReason: 'MAX_TOKENS' }))).summarize(
        [summaryInput],
      ),
    ).rejects.toMatchObject({ code: 'AI_RESPONSE_INCOMPLETE' });
    const thought = vi.fn(async () =>
      Response.json({
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [{ text: 'thinking', thought: true }, { text: '{"summaries":[]}' }] },
          },
        ],
      }),
    );
    await expect(client(thought).summarize([summaryInput])).rejects.toMatchObject({
      code: 'AI_RESPONSE_INVALID',
    });
    await expect(
      client(vi.fn(async () => new Response('{}', { status: 500 }))).summarize([summaryInput]),
    ).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    await expect(
      client(vi.fn(async () => new Response('not json'))).summarize([summaryInput]),
    ).rejects.toMatchObject({ code: 'AI_RESPONSE_INVALID' });
  });
  it('번역: 한글이 없거나 원문에 없는 숫자·링크가 있으면 항목을 거부한다', () => {
    const inputs = [
      { refId: 't1', title: 'Fed announces 2 meetings' },
      { refId: 't2', title: 'Other' },
      { refId: 't3', title: 'Third' },
      { refId: 't4', title: 'Fourth' },
    ];
    const result = validateTranslations(
      {
        translations: [
          { refId: 't1', titleKo: '연준, 2차례 회의 발표' },
          { refId: 't2', titleKo: 'English only' },
          { refId: 't3', titleKo: '세 번째 99 건' },
          { refId: 't4', titleKo: '링크 https://x.example 포함' },
        ],
      },
      inputs,
    );
    expect(result.items).toEqual([{ refId: 't1', titleKo: '연준, 2차례 회의 발표' }]);
    expect(result.rejected).toBe(3);
  });
  it('공용 안전 검사는 정상 한국어 문장은 통과시킨다', () => {
    expect(unsafeMorningText(goodSummary)).toBe(false);
    expect(validateSummaries({ summaries: [] }, [summaryInput])).toEqual({
      items: [],
      rejected: 0,
    });
  });
});

describe('기능별 일일 한도(morning: 4회)', () => {
  it('호출 4회 뒤에는 모델을 부르지 않고 AI_QUOTA_EXCEEDED로 끝난다', async () => {
    const transport = vi.fn(async () => reply({ summaries: [] }));
    const ai = client(transport);
    for (let i = 0; i < AI_FEATURE_LIMITS.morning; i++) await ai.summarize([summaryInput]);
    await expect(ai.summarize([summaryInput])).rejects.toMatchObject({ code: 'AI_QUOTA_EXCEEDED' });
    expect(transport).toHaveBeenCalledTimes(4);
    // The explanation feature keeps its own, larger counter.
    const explanation = new MemoryAiQuota();
    for (let i = 0; i < 25; i++) expect(await explanation.consume('2026-10-21')).toBe(true);
    expect(await explanation.consume('2026-10-21')).toBe(false);
  });
  it('한도를 확인하지 못하면(저장소 오류) 호출하지 않는다', async () => {
    const transport = vi.fn();
    const ai = client(transport, { consume: async () => Promise.reject(new Error('db')) });
    await expect(ai.summarize([summaryInput])).rejects.toBeInstanceOf(MorningAiError);
    expect(transport).not.toHaveBeenCalled();
  });
  it('Firestore 트랜잭션으로 aiUsage/{날짜}_morning 문서를 세고 설명 기능 문서와 분리한다', async () => {
    const docs = new Map<string, Record<string, unknown>>();
    let queue: Promise<unknown> = Promise.resolve();
    const db = {
      collection: (name: string) => ({ doc: (id: string) => `${name}/${id}` }),
      runTransaction: (run: (tx: unknown) => Promise<unknown>) => {
        const next = queue.then(() =>
          run({
            get: async (ref: string) => ({ data: () => docs.get(ref) }),
            set: (ref: string, value: Record<string, unknown>) => docs.set(ref, value),
          }),
        );
        queue = next.catch(() => undefined);
        return next;
      },
    } as unknown as Firestore;
    const morning = new FirestoreAiQuota(db, 'morning');
    const results = await Promise.all(
      Array.from({ length: 6 }, () => morning.consume('2026-10-21')),
    );
    expect(results.filter(Boolean)).toHaveLength(4);
    expect(docs.get('aiUsage/2026-10-21_morning')).toMatchObject({ count: 4 });
    expect(docs.has('aiUsage/2026-10-21')).toBe(false);
    expect(await new FirestoreAiQuota(db).consume('2026-10-21')).toBe(true);
    expect(docs.get('aiUsage/2026-10-21')).toMatchObject({ count: 1 });
    expect(aiUsageDocumentId('2026-10-21', 'explanation')).toBe('2026-10-21');
    await expect(morning.consume('bad')).rejects.toThrow();
  });
});

describe('설정', () => {
  it('Vertex 환경변수가 모두 올바를 때만 설정을 만든다', () => {
    expect(
      morningAiConfigFromEnvironment({
        AI_PROVIDER: 'vertex',
        AI_MODEL: 'gemini-3.8-flash',
        GOOGLE_CLOUD_PROJECT: 'fixture-project',
      }),
    ).toEqual(config);
    expect(morningAiConfigFromEnvironment({ AI_MODEL: 'x' })).toBeNull();
    expect(
      morningAiConfigFromEnvironment({
        AI_PROVIDER: 'vertex',
        AI_MODEL: 'gemini-3.8-flash',
        GOOGLE_CLOUD_PROJECT: 'fixture-project',
        AI_LOCATION: 'bad location',
      }),
    ).toBeNull();
  });
});
