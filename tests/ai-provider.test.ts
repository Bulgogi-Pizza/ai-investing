import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { describe, expect, it, vi } from 'vitest';
import { AiEnricher, MemoryAiQuota, type AiRules } from '../src/server/ai';
import { ProviderMorningAi } from '../src/server/ai-morning';
import {
  AiProviderError,
  ClaudeVertexProvider,
  GeminiVertexProvider,
  aiEnvironment,
  aiProviderFromEnvironment,
  toClaudeSchema,
  toGeminiSchema,
  type AiGenerateRequest,
  type ClaudeMessage,
  type ClaudeMessageParams,
  type ClaudeMessagesClient,
} from '../src/server/ai-provider';
import {
  MemoryFeatureQuota,
  ProviderAlgorithmDecider,
  type AiDecisionInput,
} from '../src/server/algorithm-ai';

const config = { project: 'fixture-project', model: 'claude-sonnet-5-5', location: 'global' };
const SCHEMA = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      minItems: 2,
      maxItems: 5,
      items: { type: 'object', properties: { n: { type: 'number', minimum: 0 } } },
    },
    name: { type: 'string', maxLength: 5 },
  },
};
const request = (over: Partial<AiGenerateRequest> = {}): AiGenerateRequest => ({
  system: 'SYSTEM',
  prompt: '{"x":1}',
  schema: SCHEMA,
  effort: 'low',
  maxOutputTokens: 4000,
  signal: AbortSignal.timeout(5000),
  ...over,
});
const message = (over: Partial<ClaudeMessage> = {}): ClaudeMessage => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: '{"ok":true}' }],
  usage: { input_tokens: 120, output_tokens: 40, output_tokens_details: { thinking_tokens: 15 } },
  ...over,
});
const fakeClient = (reply: () => Promise<ClaudeMessage>) => {
  const create = vi.fn((_params: ClaudeMessageParams, _options: { signal: AbortSignal }) =>
    reply(),
  );
  return { create, client: { messages: { create } } as ClaudeMessagesClient };
};
const failWith = (status?: number, name = 'APIError') =>
  Object.assign(new Error('provider said: secret-token-12345 quota exceeded for project x'), {
    ...(status === undefined ? {} : { status }),
    name,
  });

describe('Claude on Vertex adapter: request', () => {
  it('sends the bare model id, effort and a json_schema output format, and nothing the model rejects', async () => {
    const { create, client } = fakeClient(async () => message());
    const provider = new ClaudeVertexProvider(config, client);
    const result = await provider.generate(request());
    expect(result.json).toEqual({ ok: true });
    expect(provider.name).toBe('vertex-claude');
    expect(provider.label).toBe('Claude Sonnet 5.5');
    const [params, options] = create.mock.calls[0];
    expect(params.model).toBe('claude-sonnet-5-5');
    expect(params.max_tokens).toBe(4000);
    expect(params.system).toBe('SYSTEM');
    expect(params.messages).toEqual([{ role: 'user', content: '{"x":1}' }]);
    expect(params.output_config.effort).toBe('low');
    expect(params.output_config.format.type).toBe('json_schema');
    // Not accepted by Claude Sonnet 5.5: disabled thinking, sampling parameters, prefill, forced tools.
    for (const forbidden of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice', 'tools'])
      expect(params).not.toHaveProperty(forbidden);
    expect(params.messages.at(-1)?.role).toBe('user');
    // The SDK never retries a generation by itself.
    expect(options).toMatchObject({ maxRetries: 0 });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it('translates the schema: closed objects, unsupported constraints removed, minItems 0/1 kept', () => {
    const sent = toClaudeSchema(SCHEMA) as typeof SCHEMA;
    expect(sent.additionalProperties).toBe(false);
    expect(sent.properties.items).not.toHaveProperty('maxItems');
    expect(sent.properties.items).not.toHaveProperty('minItems'); // 2 is unsupported
    expect(sent.properties.items.items.properties.n).toEqual({ type: 'number' });
    expect(sent.properties.items.items).toHaveProperty('additionalProperties', false);
    expect(sent.properties.name).toEqual({ type: 'string' });
    expect(
      (
        toClaudeSchema({ type: 'array', items: { type: 'string' }, minItems: 1 }) as {
          minItems: number;
        }
      ).minItems,
    ).toBe(1);
    // The caller's schema object is not modified.
    expect(SCHEMA.properties.items.maxItems).toBe(5);
  });
  it('maps effort per call and passes the maximum output tokens through', async () => {
    const { create, client } = fakeClient(async () => message());
    const provider = new ClaudeVertexProvider(config, client);
    await provider.generate(request({ effort: 'medium', maxOutputTokens: 4096 }));
    expect(create.mock.calls[0][0]).toMatchObject({
      max_tokens: 4096,
      output_config: { effort: 'medium' },
    });
  });
  it('rejects configurations that are not Claude model ids', () => {
    expect(() => new ClaudeVertexProvider({ ...config, model: 'gemini-3.8-flash' })).toThrow();
    expect(() => new ClaudeVertexProvider({ ...config, location: 'bad region' })).toThrow();
    expect(() => new ClaudeVertexProvider({ ...config, project: 'X' })).toThrow();
  });
  it('talks to the official SDK shape: partner rawPredict path, vertex version, output_config', async () => {
    const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
    const sdk = new AnthropicVertex({
      projectId: 'fixture-project',
      region: 'global',
      // A fake auth client: the test must never reach real credentials or the network.
      authClient: {
        projectId: 'fixture-project',
        getRequestHeaders: async () => new Headers({ authorization: 'Bearer fixture-bearer' }),
      } as never,
      maxRetries: 0,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init.body)),
          auth: new Headers(init.headers).get('authorization'),
        });
        return Response.json({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          stop_reason: 'end_turn',
          stop_sequence: null,
          content: [{ type: 'text', text: '{"ok":true}' }],
          usage: { input_tokens: 5, output_tokens: 3 },
        });
      }) as unknown as typeof fetch,
    });
    const provider = new ClaudeVertexProvider(config, sdk as unknown as ClaudeMessagesClient);
    const result = await provider.generate(request());
    expect(result.usage).toEqual({ prompt: 5, output: 3, thoughts: 0, total: 8 });
    expect(calls[0].url).toBe(
      'https://aiplatform.googleapis.com/v1/projects/fixture-project/locations/global/publishers/anthropic/models/claude-sonnet-5-5:rawPredict',
    );
    expect(calls[0].body).toMatchObject({
      anthropic_version: 'vertex-2023-10-16',
      max_tokens: 4000,
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
    expect(calls[0].body).not.toHaveProperty('model');
    expect(calls[0].auth).toBe('Bearer fixture-bearer');
  });
});

describe('Claude on Vertex adapter: response and errors', () => {
  const run = async (reply: () => Promise<ClaudeMessage>) =>
    new ClaudeVertexProvider(config, fakeClient(reply).client).generate(request());
  const code = async (reply: () => Promise<ClaudeMessage>) => {
    try {
      await run(reply);
    } catch (error) {
      expect(error).toBeInstanceOf(AiProviderError);
      // Only the fixed code: never provider text.
      expect(String((error as Error).message)).toMatch(/^AI_[A-Z_]+$/);
      return (error as AiProviderError).code;
    }
    return 'NO_ERROR';
  };
  it('a refusal is "unavailable", a cut-off answer is incomplete, other stops are invalid', async () => {
    expect(await code(async () => message({ stop_reason: 'refusal', content: [] }))).toBe(
      'AI_REFUSED',
    );
    expect(await code(async () => message({ stop_reason: 'max_tokens' }))).toBe(
      'AI_RESPONSE_INCOMPLETE',
    );
    expect(await code(async () => message({ stop_reason: 'model_context_window_exceeded' }))).toBe(
      'AI_RESPONSE_INCOMPLETE',
    );
    for (const stop of ['tool_use', 'pause_turn', 'stop_sequence', null, undefined])
      expect(await code(async () => message({ stop_reason: stop }))).toBe('AI_RESPONSE_INVALID');
  });
  it('a refusal is checked before the content is read', async () => {
    expect(
      await code(async () =>
        message({ stop_reason: 'refusal', content: [{ type: 'text', text: '{"ok":true}' }] }),
      ),
    ).toBe('AI_REFUSED');
  });
  it('skips thinking blocks, joins text, and rejects anything else or non-JSON', async () => {
    const result = await run(async () =>
      message({
        content: [
          { type: 'thinking', text: undefined },
          { type: 'text', text: '{"ok":' },
          { type: 'text', text: 'true}' },
        ],
      }),
    );
    expect(result.json).toEqual({ ok: true });
    expect(await code(async () => message({ content: [{ type: 'tool_use' }] }))).toBe(
      'AI_RESPONSE_INVALID',
    );
    expect(await code(async () => message({ content: [{ type: 'text', text: 'not json' }] }))).toBe(
      'AI_RESPONSE_INVALID',
    );
    expect(await code(async () => message({ content: [] }))).toBe('AI_RESPONSE_INVALID');
    expect(await code(async () => message({ content: undefined }))).toBe('AI_RESPONSE_INVALID');
  });
  it('reads usage numbers only; thinking tokens are reported separately', async () => {
    const result = await run(async () => message());
    expect(result.usage).toEqual({ prompt: 120, output: 40, thoughts: 15, total: 160 });
    const weird = await run(async () =>
      message({ usage: { input_tokens: 'x', output_tokens: -1, output_tokens_details: null } }),
    );
    expect(weird.usage).toEqual({ prompt: 0, output: 0, thoughts: 0, total: 0 });
  });
  it('a 429 is its own sanitized code; auth, other statuses and network errors map to fixed codes', async () => {
    expect(await code(async () => Promise.reject(failWith(429)))).toBe('AI_QUOTA_PROVIDER');
    expect(await code(async () => Promise.reject(failWith(401)))).toBe('AI_AUTH_UNAVAILABLE');
    expect(await code(async () => Promise.reject(failWith(403)))).toBe('AI_AUTH_UNAVAILABLE');
    expect(await code(async () => Promise.reject(failWith(500)))).toBe('AI_UNAVAILABLE');
    expect(await code(async () => Promise.reject(failWith(400)))).toBe('AI_UNAVAILABLE');
    expect(await code(async () => Promise.reject(failWith(undefined, 'APIConnectionError')))).toBe(
      'AI_UNAVAILABLE',
    );
    expect(
      await code(async () => Promise.reject(failWith(undefined, 'APIConnectionTimeoutError'))),
    ).toBe('AI_TIMEOUT');
  });
  it('an aborted signal is a timeout and the provider is not called after it', async () => {
    const { create, client } = fakeClient(async () => message());
    const controller = new AbortController();
    controller.abort();
    await expect(
      new ClaudeVertexProvider(config, client).generate(request({ signal: controller.signal })),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    const slow = fakeClient(async () => Promise.reject(failWith(undefined, 'AbortError')));
    const abort = new AbortController();
    const pending = new ClaudeVertexProvider(config, slow.client).generate(
      request({ signal: abort.signal }),
    );
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
  });
});

describe('provider selection', () => {
  const env = { GOOGLE_CLOUD_PROJECT: 'fixture-project' };
  it('vertex-claude defaults the model; vertex needs a Gemini model; families must match', () => {
    expect(aiEnvironment({ ...env, AI_PROVIDER: 'vertex-claude' })).toEqual({
      provider: 'vertex-claude',
      config: { ...config, model: 'claude-sonnet-5-5' },
    });
    expect(aiEnvironment({ ...env, AI_PROVIDER: 'vertex' })).toBeNull();
    expect(aiEnvironment({ ...env, AI_PROVIDER: 'vertex', AI_MODEL: 'gemini-3.8-flash' })).toEqual({
      provider: 'vertex',
      config: { ...config, model: 'gemini-3.8-flash' },
    });
    expect(
      aiEnvironment({ ...env, AI_PROVIDER: 'vertex', AI_MODEL: 'claude-sonnet-5-5' }),
    ).toBeNull();
    expect(
      aiEnvironment({ ...env, AI_PROVIDER: 'vertex-claude', AI_MODEL: 'gemini-3.8-flash' }),
    ).toBeNull();
    expect(aiEnvironment({ ...env, AI_PROVIDER: 'openai' })).toBeNull();
    expect(aiEnvironment({ AI_PROVIDER: 'vertex-claude' })).toBeNull();
    expect(
      aiEnvironment({ ...env, AI_PROVIDER: 'vertex-claude', AI_LOCATION: 'bad location' }),
    ).toBeNull();
  });
  it('builds the matching provider without touching credentials', () => {
    expect(aiProviderFromEnvironment({ ...env, AI_PROVIDER: 'vertex-claude' })).toBeInstanceOf(
      ClaudeVertexProvider,
    );
    expect(
      aiProviderFromEnvironment({ ...env, AI_PROVIDER: 'vertex', AI_MODEL: 'gemini-3.8-flash' }),
    ).toBeInstanceOf(GeminiVertexProvider);
    expect(aiProviderFromEnvironment({})).toBeNull();
  });
  it('translates schemas for Gemini (uppercase types, no additionalProperties)', () => {
    const sent = toGeminiSchema(SCHEMA) as {
      type: string;
      additionalProperties?: unknown;
      properties: { items: { type: string; maxItems: number } };
    };
    expect(sent.type).toBe('OBJECT');
    expect(sent).not.toHaveProperty('additionalProperties');
    expect(sent.properties.items).toMatchObject({ type: 'ARRAY', maxItems: 5 });
  });
});

describe('features over the Claude provider', () => {
  const narrative = {
    summary: '요약',
    actions: ['출처 확인'],
    counterScenario: '반대 시나리오',
    dataGaps: ['한계'],
    confidenceExplanation: '근거가 제한적이다',
    sourceIds: ['market'],
  };
  const rules = {
    engine: 'rules-v1',
    dataMode: 'live',
    period: 'daily',
    symbol: '005930',
    horizon: { tradingDays: 5, calendarDays: 7 },
    strategy: {
      name: 'x',
      horizon: '5년',
      benchmark: 'x',
      riskTolerance: 'medium',
      targetAllocations: [{ asset: '주식', percentage: 100 }],
      notes: '',
    },
    metrics: { returnPercent: 1, sma20: 100, rsi14: 50, latestClose: 100, latestTimestamp: 't' },
    decision: { action: 'hold' },
    evidence: {
      market: { source: 'fixture' },
      calendar: { events: [], coverageWarning: '' },
    },
  } as unknown as AiRules;
  it('explanations: ready result carries the provider and the label; a 429 is only "unavailable"', async () => {
    const ok = fakeClient(async () =>
      message({ content: [{ type: 'text', text: JSON.stringify(narrative) }] }),
    );
    const enricher = new AiEnricher(
      new ClaudeVertexProvider(config, ok.client),
      new MemoryAiQuota(),
    );
    const result = await enricher.enrich(rules, 'owner');
    expect(result.ai).toMatchObject({
      status: 'ready',
      provider: 'vertex-claude',
      model: 'Claude Sonnet 5.5',
    });
    expect(ok.create.mock.calls[0][0].output_config.effort).toBe('low');
    const limited = fakeClient(async () => Promise.reject(failWith(429)));
    const unavailable = await new AiEnricher(
      new ClaudeVertexProvider(config, limited.client),
      new MemoryAiQuota(),
    ).enrich(rules, 'owner');
    expect(unavailable.ai).toMatchObject({ status: 'unavailable', provider: 'vertex-claude' });
    expect(JSON.stringify(unavailable.ai)).not.toMatch(/secret|quota exceeded/);
    expect(limited.create).toHaveBeenCalledTimes(1);
  });
  it('morning AI: the provider quota code passes through; our own daily quota stays distinct', async () => {
    const limited = fakeClient(async () => Promise.reject(failWith(429)));
    const ai = new ProviderMorningAi(
      new ClaudeVertexProvider(config, limited.client),
      new MemoryAiQuota('morning'),
    );
    await expect(
      ai.translate([{ refId: 't1', title: 'Federal Reserve approves rule' }]),
    ).rejects.toMatchObject({
      code: 'AI_QUOTA_PROVIDER',
    });
    expect(ai.model).toBe('Claude Sonnet 5.5');
    const refused = fakeClient(async () => message({ stop_reason: 'refusal', content: [] }));
    await expect(
      new ProviderMorningAi(
        new ClaudeVertexProvider(config, refused.client),
        new MemoryAiQuota('morning'),
      ).translate([{ refId: 't1', title: 'x' }]),
    ).rejects.toMatchObject({ code: 'AI_REFUSED' });
    // Retrying is the caller's decision: one failed call is one provider call.
    expect(limited.create).toHaveBeenCalledTimes(1);
  });
  it('morning AI: validated like before, with Claude low effort and no sampling parameters', async () => {
    const ok = fakeClient(async () =>
      message({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              translations: [{ refId: 't1', titleKo: '연준 최종 규칙 승인' }],
            }),
          },
        ],
      }),
    );
    const result = await new ProviderMorningAi(
      new ClaudeVertexProvider(config, ok.client),
      new MemoryAiQuota('morning'),
    ).translate([{ refId: 't1', title: 'Federal Reserve approves final rule' }]);
    expect(result.items).toEqual([{ refId: 't1', titleKo: '연준 최종 규칙 승인' }]);
    const [params] = ok.create.mock.calls[0];
    expect(params.output_config.effort).toBe('low');
    expect(params).not.toHaveProperty('temperature');
  });
  it('algorithm decisions use medium effort; 429 and refusal have their own codes', async () => {
    const input: AiDecisionInput = {
      market: 'KR',
      date: '2026-10-21',
      currency: 'KRW',
      symbols: [
        { symbol: '005930', price: 77000, held: false, heldTradingDays: null, signals: {} },
      ],
    };
    const body = {
      decisions: [
        {
          symbol: '005930',
          decision: 'hold',
          reasons: ['신호가 약하다'],
          expectedReturn: { low: -0.01, high: 0.01 },
        },
      ],
    };
    const ok = fakeClient(async () =>
      message({ content: [{ type: 'text', text: JSON.stringify(body) }] }),
    );
    const decider = (client: ClaudeMessagesClient) =>
      new ProviderAlgorithmDecider(
        new ClaudeVertexProvider(config, client),
        new MemoryFeatureQuota(),
      );
    expect(await decider(ok.client).decide(input)).toMatchObject({
      status: 'ready',
      model: 'Claude Sonnet 5.5',
    });
    expect(ok.create.mock.calls[0][0].output_config.effort).toBe('medium');
    expect(
      await decider(fakeClient(async () => Promise.reject(failWith(429))).client).decide(input),
    ).toEqual({ status: 'unavailable', code: 'PROVIDER_QUOTA' });
    expect(
      await decider(
        fakeClient(async () => message({ stop_reason: 'refusal', content: [] })).client,
      ).decide(input),
    ).toEqual({ status: 'unavailable', code: 'REFUSED' });
    expect(
      await decider(fakeClient(async () => message({ stop_reason: 'max_tokens' })).client).decide(
        input,
      ),
    ).toEqual({ status: 'unavailable', code: 'OUTPUT_INVALID' });
    expect(
      await decider(fakeClient(async () => Promise.reject(failWith(401))).client).decide(input),
    ).toEqual({ status: 'unavailable', code: 'AUTH_UNAVAILABLE' });
  });
});
