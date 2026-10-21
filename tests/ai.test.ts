import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import {
  aiFromEnvironment,
  FirestoreAiQuota,
  MemoryAiQuota,
  minimizeAiEvidence,
  validateAiNarrative,
  VertexAiEnricher,
  type AiRules,
} from '../src/server/ai';
const config = { project: 'fixture-project', model: 'gemini-3.1-flash-lite', location: 'global' };
const narrative = {
  summary: '가격 지표와 저장 전략을 함께 검토하세요.',
  actions: ['목표 전략과 원본 출처를 다시 확인하세요.'],
  counterScenario: '과거 추세가 뒤집힐 수 있습니다.',
  dataGaps: ['등록 일정은 전체 뉴스를 포괄하지 않습니다.'],
  confidenceExplanation: '이 해설은 근거가 제한된 모델 설명이며 예측 정확도를 보장하지 않습니다.',
  sourceIds: ['market', 'event-1'],
};
function rules(): AiRules {
  return {
    engine: 'rules-v1',
    dataMode: 'live',
    period: 'daily',
    symbol: '005930',
    horizon: { tradingDays: 1, calendarDays: 1 },
    strategy: {
      name: 'private-owner-email@example.test',
      notes: 'private-account-123456789012',
      benchmark: 'private benchmark',
      horizon: '5년',
      riskTolerance: 'medium',
      targetAllocations: [{ asset: '주식', percentage: 100 }],
    },
    metrics: {
      returnPercent: 1,
      sma20: 70000,
      rsi14: 60,
      latestClose: 71000,
      latestTimestamp: '2026-10-20T00:00:00+09:00',
    },
    decision: { action: 'hold-plan', title: '점검', thresholdPercent: 4, rationale: '규칙' },
    evidence: {
      market: {
        source: 'fixture-market',
        asOf: '2026-10-20T03:00:00Z',
        symbol: '005930',
        interval: '1d',
        adjusted: true,
        candles: [],
      },
      calendar: {
        from: '2026-10-20',
        to: '2026-10-21',
        source: 'admin-curated',
        events: [
          {
            id: 1,
            date: '2026-10-21',
            time: '12:00',
            title: '공식 일정',
            importance: 3,
            sourceName: 'fixture',
            sourceUrl: 'https://example.test/source',
            factualObservedAt: '2026-10-20T03:00:00Z',
          },
        ],
        truncated: false,
        coverageWarning: '등록 일정만 참조합니다.',
        relevanceRule: '같은 시장',
        excludedCount: 0,
      },
    },
  };
}
function response(output: unknown = narrative, finishReason = 'STOP') {
  return Response.json({
    candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(output) }] } }],
  });
}
const auth = () => ({ getAccessToken: vi.fn(async () => 'fixture-bearer') });
function fakeDatabase() {
  const docs = new Map<string, Record<string, unknown>>();
  let queue: Promise<unknown> = Promise.resolve();
  return {
    docs,
    db: {
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
    } as unknown as Firestore,
  };
}
afterEach(() => vi.unstubAllEnvs());
describe('optional Vertex AI narrative', () => {
  it('defaults disabled without calling credentials or a model and preserves rules', async () => {
    vi.stubEnv('AI_PROVIDER', '');
    const input = rules();
    const result = await aiFromEnvironment().enrich(input, 'owner');
    expect(result.ai.status).toBe('disabled');
    expect(result.decision).toEqual(input.decision);
    expect(result.ai).not.toHaveProperty('summary');
  });
  it('minimizes evidence, strips private fields, and uses fixed official REST/structured output', async () => {
    const input = rules();
    const minimized = minimizeAiEvidence(input);
    expect(minimized.serialized).not.toContain('private-');
    expect(minimized.serialized).not.toContain('quantity');
    expect(minimized.serialized).not.toContain('https://example.test');
    const transport = vi.fn(async () => response());
    const credentials = auth();
    const client = new VertexAiEnricher(
      config,
      new MemoryAiQuota(),
      transport as typeof fetch,
      credentials,
    );
    const result = await client.enrich(input, 'private-owner-id');
    expect(result.ai.status).toBe('ready');
    expect(result.decision).toBe(input.decision);
    expect(result.metrics).toBe(input.metrics);
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://aiplatform.googleapis.com/v1/projects/fixture-project/locations/global/publishers/google/models/gemini-3.1-flash-lite:generateContent',
    );
    expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture-bearer' });
    const body = JSON.parse(String(init.body));
    expect(body.generationConfig).toMatchObject({
      temperature: 0.2,
      maxOutputTokens: 4000,
      responseMimeType: 'application/json',
    });
    expect(body.generationConfig.responseSchema.required).toContain('counterScenario');
    expect(String(init.body)).not.toContain('private-owner-id');
    expect(result.ai).not.toHaveProperty('token');
    if (result.ai.status === 'ready') {
      expect(result.ai.sourceIds).toEqual(['market', 'event-1']);
      expect(result.ai.sources[1].url).toBe('https://example.test/source');
    }
  });
  it('grounds recent published news separately without sending articles or URLs', () => {
    const input = rules();
    input.evidence.news = {
      ...input.evidence.calendar,
      source: 'registered-news',
      events: [
        {
          ...input.evidence.calendar.events[0],
          title: '최근 공개된 통계 보도자료',
          date: '2026-10-19',
          eventKind: 'news-release',
        },
      ],
    };
    const evidence = minimizeAiEvidence(input);
    const payload = JSON.parse(evidence.serialized);
    expect(payload.events.map((event: { kind: string }) => event.kind)).toEqual([
      'scheduled',
      'news-release',
    ]);
    expect(evidence.sources.map((source) => source.id)).toEqual(['market', 'event-1', 'news-1']);
    expect(evidence.serialized).toContain('최근 공개된 통계');
    expect(evidence.serialized).not.toContain('https://');
  });
  it('blocks excessive input before quota and safely handles missing auth or aborted transport', async () => {
    const large = rules();
    large.strategy.targetAllocations = Array.from({ length: 30 }, () => ({
      asset: '한'.repeat(80),
      percentage: 1,
    }));
    large.evidence.calendar.events = Array.from({ length: 6 }, (_, id) => ({
      ...large.evidence.calendar.events[0],
      id: id + 1,
      title: '한'.repeat(180),
    }));
    large.evidence.news = {
      ...large.evidence.calendar,
      source: 'registered-news',
      events: large.evidence.calendar.events.map((event) => ({
        ...event,
        eventKind: 'news-release',
      })),
    };
    const quota = { consume: vi.fn(async () => true) };
    const transport = vi.fn(async () => response());
    const client = new VertexAiEnricher(config, quota, transport as typeof fetch, auth());
    expect((await client.enrich(large, 'owner')).ai.status).toBe('unavailable');
    expect(quota.consume).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    const missing = new VertexAiEnricher(config, new MemoryAiQuota(), transport as typeof fetch, {
      getAccessToken: async () => null,
    });
    expect((await missing.enrich(rules(), 'owner')).ai.status).toBe('unavailable');
    expect(transport).not.toHaveBeenCalled();
    const aborted = vi.fn(async () => {
      throw new DOMException('private timeout details', 'AbortError');
    });
    const failing = new VertexAiEnricher(
      config,
      new MemoryAiQuota(),
      aborted as typeof fetch,
      auth(),
    );
    expect((await failing.enrich(rules(), 'owner')).ai.status).toBe('unavailable');
    expect(aborted).toHaveBeenCalledTimes(1);
  });
  it('isolates two-minute caches by user, deduplicates calls, and refreshes after expiry', async () => {
    let now = Date.parse('2026-10-20T03:00:00Z');
    const transport = vi.fn(async () => response());
    const client = new VertexAiEnricher(
      config,
      new MemoryAiQuota(),
      transport as typeof fetch,
      auth(),
      () => now,
    );
    await Promise.all([client.enrich(rules(), 'first'), client.enrich(rules(), 'first')]);
    expect(transport).toHaveBeenCalledTimes(1);
    await client.enrich(rules(), 'second');
    expect(transport).toHaveBeenCalledTimes(2);
    now += 120001;
    await client.enrich(rules(), 'first');
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it('atomically caps all-model generation attempts at25 per KST day across instances with TTL', async () => {
    const { db, docs } = fakeDatabase();
    const first = new FirestoreAiQuota(db);
    const second = new FirestoreAiQuota(db);
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => (i % 2 ? first : second).consume('2026-10-20')),
    );
    expect(results.filter(Boolean)).toHaveLength(25);
    expect(docs.get('aiUsage/2026-10-20')?.count).toBe(25);
    expect(docs.get('aiUsage/2026-10-20')?.ttlAt).toBeInstanceOf(Timestamp);
    expect(await second.consume('2026-10-21')).toBe(true);
    const memory = new MemoryAiQuota();
    for (let i = 0; i < 25; i++) expect(await memory.consume('2026-10-20')).toBe(true);
    expect(await memory.consume('2026-10-20')).toBe(false);
    expect(await memory.consume('2026-10-21')).toBe(true);
  });
  it('keeps rules usable on quota, auth, provider, malformed, blocked, and unknown-source failures without retries', async () => {
    const never = vi.fn(async () => response());
    const exhausted = new VertexAiEnricher(
      config,
      { consume: async () => false },
      never as typeof fetch,
      auth(),
    );
    expect((await exhausted.enrich(rules(), 'owner')).ai.status).toBe('unavailable');
    expect(never).not.toHaveBeenCalled();
    const storageFailure = new VertexAiEnricher(
      config,
      {
        consume: async () => {
          throw new Error('secret provider detail');
        },
      },
      never as typeof fetch,
      auth(),
    );
    expect(JSON.stringify((await storageFailure.enrich(rules(), 'owner')).ai)).not.toContain(
      'secret provider',
    );
    for (const output of [
      { ...narrative, sourceIds: ['invented'] },
      { ...narrative, summary: 'https://malicious.test' },
      { ...narrative, allocation: { stock: 100 } },
      { ...narrative, summary: '목표 주가 999999원' },
      { ...narrative, confidenceExplanation: '예측확률 99%' },
      { ...narrative, summary: '성공 확률 99%로 예상합니다.' },
      { ...narrative, actions: ['연락처 owner@example.test로 확인하세요.'] },
      { ...narrative, summary: '계좌 1234-5678-9012를 확인하세요.' },
      { ...narrative, actions: [] },
    ]) {
      const transport = vi.fn(async () => response(output));
      const client = new VertexAiEnricher(
        config,
        new MemoryAiQuota(),
        transport as typeof fetch,
        auth(),
      );
      const result = await client.enrich(rules(), 'owner');
      expect(result.ai.status).toBe('unavailable');
      expect(result.ai).not.toHaveProperty('summary');
      expect(transport).toHaveBeenCalledTimes(1);
    }
    for (const status of [401, 429, 500]) {
      const transport = vi.fn(async () => new Response('private token detail', { status }));
      const client = new VertexAiEnricher(
        config,
        new MemoryAiQuota(),
        transport as typeof fetch,
        auth(),
      );
      const result = await client.enrich(rules(), 'owner');
      expect(result.ai.status).toBe('unavailable');
      expect(JSON.stringify(result.ai)).not.toContain('private token');
      expect(transport).toHaveBeenCalledTimes(1);
    }
    const blocked = new VertexAiEnricher(
      config,
      new MemoryAiQuota(),
      vi.fn(async () => response(narrative, 'SAFETY')) as typeof fetch,
      auth(),
    );
    expect((await blocked.enrich(rules(), 'owner')).ai.status).toBe('unavailable');
  });
  it('rejects setting new Korean and English allocation targets while allowing risk comparisons', () => {
    const sources = minimizeAiEvidence(rules()).sources;
    for (const instruction of [
      '주식 비중을 30%로 설정하세요.',
      '주식을 30%로 편입하세요.',
      '주식 비중을 30%에 맞추세요.',
      '주식 비중을 30%로 재배분하세요.',
      'Allocate 30% to stocks.',
      'Set target weights to stocks 30% and bonds 70%.',
      'Target weights: stocks 30%, bonds 70%.',
    ])
      expect(() => validateAiNarrative({ ...narrative, actions: [instruction] }, sources)).toThrow(
        'Disallowed AI instruction',
      );
    expect(
      validateAiNarrative(
        {
          ...narrative,
          summary:
            '현재 주식 비중 30%와 저장된 목표 40% 차이를 점검하세요. 하락률 4%는 과거 관측이며 손실 예측이 아닙니다.',
          actions: ['Compare the observed 4% decline with the existing strategy.'],
        },
        sources,
      ).summary,
    ).toContain('현재 주식 비중 30%');
  });
  it('rejects oversized inputs, unknown schemas and endpoint injection before a model request', async () => {
    expect(
      () =>
        new VertexAiEnricher(
          { ...config, location: 'global/../../evil' },
          new MemoryAiQuota(),
          fetch,
          auth(),
        ),
    ).toThrow();
    expect(
      () =>
        new VertexAiEnricher(
          { ...config, model: 'https://evil.test' },
          new MemoryAiQuota(),
          fetch,
          auth(),
        ),
    ).toThrow();
    const input = rules();
    input.dataMode = 'demo' as 'live';
    const transport = vi.fn(async () => response());
    const client = new VertexAiEnricher(
      config,
      new MemoryAiQuota(),
      transport as typeof fetch,
      auth(),
    );
    expect((await client.enrich(input, 'owner')).ai.status).toBe('unavailable');
    expect(transport).not.toHaveBeenCalled();
    expect(() =>
      validateAiNarrative(
        { ...narrative, sourceIds: ['market', 'market'] },
        minimizeAiEvidence(rules()).sources,
      ),
    ).toThrow();
  });
});
