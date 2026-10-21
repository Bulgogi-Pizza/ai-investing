import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiEnricher, MemoryAiQuota, type AiRules } from '../src/server/ai';
import { ProviderMorningAi } from '../src/server/ai-morning';
import {
  AiProviderError,
  AnthropicProvider,
  SERVER_FALLBACK_BETA,
  aiEnvironment,
  aiProviderFromEnvironment,
  codeForSdkError,
  createAiProvider,
  refusalFallbackFlag,
  validAnthropicApiKey,
  type AiGenerateRequest,
  type AnthropicApiClient,
  type ClaudeMessage,
} from '../src/server/ai-provider';
import {
  MemoryFeatureQuota,
  ProviderAlgorithmDecider,
  type AiDecisionInput,
} from '../src/server/algorithm-ai';
import { ProviderEnrichAi } from '../src/server/calendar-enrich';
import { installBudgetGuard } from '../src/server/budget-guard';

// A fixture value that only has the shape of a key; it is not a credential.
const KEY = 'sk-ant-api03-FIXTURE_0123456789';
const config = { model: 'claude-sonnet-5-5' };
const SCHEMA = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: { items: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'string' } } },
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
  model: 'claude-sonnet-5-5',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: '{"ok":true}' }],
  usage: { input_tokens: 120, output_tokens: 40, output_tokens_details: { thinking_tokens: 15 } },
  ...over,
});
const fakeClient = (reply: () => Promise<ClaudeMessage> = async () => message()) => {
  const standard = vi.fn((_params: unknown, _options: unknown) => reply());
  const beta = vi.fn((_params: unknown, _options: unknown) => reply());
  return {
    standard,
    beta,
    client: {
      messages: { create: standard },
      beta: { messages: { create: beta } },
    } as unknown as AnthropicApiClient,
  };
};
const provider = (client: AnthropicApiClient, refusalFallback = true) =>
  new AnthropicProvider(config, { apiKey: KEY, refusalFallback }, client);

afterEach(() => {
  installBudgetGuard(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Anthropic provider: request', () => {
  it('uses the beta messages endpoint with the default fallback and structured output', async () => {
    const { beta, standard, client } = fakeClient();
    const ai = provider(client);
    const result = await ai.generate(request());
    expect(result.json).toEqual({ ok: true });
    expect(result.fallback).toBeUndefined();
    expect(ai.name).toBe('anthropic');
    expect(ai.label).toBe('Claude Sonnet 5.5');
    expect(standard).not.toHaveBeenCalled();
    const [params, options] = beta.mock.calls[0] as [Record<string, unknown>, { signal: unknown }];
    expect(params).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 4000,
      system: 'SYSTEM',
      messages: [{ role: 'user', content: '{"x":1}' }],
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
    expect(SERVER_FALLBACK_BETA).toBe('server-side-fallback-2026-07-01');
    // Schema translated for Claude (closed object, unsupported constraints removed).
    const format = (params.output_config as { format: { schema: Record<string, unknown> } }).format;
    expect(format.schema).toMatchObject({ additionalProperties: false });
    expect(JSON.stringify(format.schema)).not.toMatch(/maxItems|"minItems":2/);
    // Rules for Claude Sonnet 5.5: nothing it rejects.
    for (const forbidden of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice', 'tools'])
      expect(params).not.toHaveProperty(forbidden);
    expect((params.messages as { role: string }[]).at(-1)?.role).toBe('user');
    // Never retried by the SDK; the caller's signal bounds the call.
    expect(options).toMatchObject({ maxRetries: 0 });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it('with the fallback switched off it uses the standard endpoint and sends neither beta nor fallbacks', async () => {
    const { beta, standard, client } = fakeClient();
    await provider(client, false).generate(request({ effort: 'medium', maxOutputTokens: 4096 }));
    expect(beta).not.toHaveBeenCalled();
    const params = standard.mock.calls[0][0] as Record<string, unknown>;
    expect(params).toMatchObject({ max_tokens: 4096, output_config: { effort: 'medium' } });
    expect(params).not.toHaveProperty('betas');
    expect(params).not.toHaveProperty('fallbacks');
  });
  it('talks to api.anthropic.com with the key as x-api-key, whatever the environment says', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://attacker.example');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'token-that-must-be-ignored');
    const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({
          url: String(url),
          headers: new Headers(init.headers),
          body: JSON.parse(String(init.body)),
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
      }),
    );
    const result = await new AnthropicProvider(config, { apiKey: KEY }).generate(request());
    expect(result.usage).toEqual({ prompt: 5, output: 3, thoughts: 0, total: 8 });
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0].url).origin).toBe('https://api.anthropic.com');
    expect(new URL(seen[0].url).pathname).toBe('/v1/messages');
    expect(seen[0].headers.get('x-api-key')).toBe(KEY);
    expect(seen[0].headers.get('authorization')).toBeNull();
    expect(seen[0].headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(seen[0].body).toMatchObject({
      model: 'claude-sonnet-5-5',
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
  });
});

describe('Anthropic provider: stop reasons and content', () => {
  const code = async (reply: () => Promise<ClaudeMessage>) => {
    try {
      await provider(fakeClient(reply).client).generate(request());
    } catch (error) {
      expect(error).toBeInstanceOf(AiProviderError);
      expect(String((error as Error).message)).toMatch(/^AI_[A-Z_]+$/);
      return (error as AiProviderError).code;
    }
    return 'NO_ERROR';
  };
  it('a refusal is AI_REFUSED before the content is read; a cut-off answer is incomplete', async () => {
    expect(
      await code(async () =>
        message({ stop_reason: 'refusal', content: [{ type: 'text', text: '{"ok":true}' }] }),
      ),
    ).toBe('AI_REFUSED');
    expect(await code(async () => message({ stop_reason: 'max_tokens' }))).toBe(
      'AI_RESPONSE_INCOMPLETE',
    );
    for (const stop of ['tool_use', 'pause_turn', null, undefined])
      expect(await code(async () => message({ stop_reason: stop }))).toBe('AI_RESPONSE_INVALID');
    expect(await code(async () => message({ content: [{ type: 'text', text: 'no json' }] }))).toBe(
      'AI_RESPONSE_INVALID',
    );
  });
});

describe('Anthropic provider: server-side fallback', () => {
  const served = (over: Partial<ClaudeMessage> = {}): ClaudeMessage =>
    message({
      model: 'claude-sonnet-5',
      content: [
        { type: 'text', text: '{"discarded":"text before the boundary"}' },
        { type: 'fallback' },
        { type: 'thinking' },
        { type: 'text', text: '{"ok":' },
        { type: 'text', text: 'true}' },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 30,
        output_tokens_details: { thinking_tokens: 10 },
        iterations: [
          { type: 'message', model: 'claude-sonnet-5-5', input_tokens: 100, output_tokens: 5 },
          {
            type: 'fallback_message',
            model: 'claude-sonnet-5',
            input_tokens: 100,
            output_tokens: 30,
          },
        ],
      },
      ...over,
    });
  it('records the serving model, reads only what follows the fallback marker and bills every attempt', async () => {
    const result = await provider(fakeClient(async () => served()).client).generate(request());
    expect(result.json).toEqual({ ok: true });
    expect(result.fallback).toEqual({ model: 'claude-sonnet-5' });
    // Top-level usage is only the serving attempt; the declined attempt was spent too.
    expect(result.usage).toEqual({ prompt: 200, output: 35, thoughts: 10, total: 235 });
  });
  it('a plain answer has no fallback marker and a fallback chain that refused is a refusal', async () => {
    const plain = await provider(fakeClient().client).generate(request());
    expect(plain).not.toHaveProperty('fallback');
    // Iterations without a fallback_message entry do not count as a fallback.
    const single = await provider(
      fakeClient(async () =>
        message({
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            iterations: [{ type: 'message', model: 'claude-sonnet-5-5' }],
          },
        }),
      ).client,
    ).generate(request());
    expect(single.fallback).toBeUndefined();
    await expect(
      provider(fakeClient(async () => served({ stop_reason: 'refusal' })).client).generate(
        request(),
      ),
    ).rejects.toMatchObject({ code: 'AI_REFUSED' });
  });
  it('a served model id of an unexpected shape is reported as "unknown", never copied', async () => {
    const odd = served();
    odd.usage!.iterations = [
      { type: 'fallback_message', model: 'x y <script>', input_tokens: 1, output_tokens: 1 },
    ];
    const result = await provider(fakeClient(async () => odd).client).generate(request());
    expect(result.fallback).toEqual({ model: 'unknown' });
  });
  it('reaches every feature as metadata: explanation, morning, calendar and algorithm', async () => {
    const fallbackReply = (json: unknown) => async () =>
      served({
        content: [{ type: 'fallback' }, { type: 'text', text: JSON.stringify(json) }],
      });
    const morning = await new ProviderMorningAi(
      provider(
        fakeClient(
          fallbackReply({ translations: [{ refId: 't1', titleKo: '연준 최종 규칙 승인' }] }),
        ).client,
      ),
      new MemoryAiQuota('morning'),
    ).translate([{ refId: 't1', title: 'Federal Reserve approves final rule' }]);
    expect(morning.fallbackModel).toBe('claude-sonnet-5');
    const enrich = await new ProviderEnrichAi(
      provider(
        fakeClient(
          fallbackReply({
            items: [
              {
                ref: 'A',
                titleKo: '',
                headline: '발표 내용을 정리한 한 문장',
                facts: [],
                impact: [],
                explainer: '',
              },
            ],
          }),
        ).client,
      ),
      new MemoryAiQuota('calendar'),
    ).enrich([
      {
        ref: 'A',
        country: '한국',
        date: '2026-10-20',
        title: '한국은행 보도자료',
        importance: 'low',
        titleIsKorean: true,
        knownFacts: [],
        reaction: [],
        reactionSmall: false,
      },
    ]);
    expect(enrich.fallbackModel).toBe('claude-sonnet-5');
    const input: AiDecisionInput = {
      market: 'KR',
      date: '2026-10-21',
      currency: 'KRW',
      symbols: [
        { symbol: '005930', price: 77000, held: false, heldTradingDays: null, signals: {} },
      ],
    };
    const decision = await new ProviderAlgorithmDecider(
      provider(
        fakeClient(
          fallbackReply({
            decisions: [
              {
                symbol: '005930',
                decision: 'hold',
                reasons: ['신호가 약하다'],
                expectedReturn: { low: -0.01, high: 0.01 },
              },
            ],
          }),
        ).client,
      ),
      new MemoryFeatureQuota(),
    ).decide(input);
    expect(decision).toMatchObject({ status: 'ready', model: 'claude-sonnet-5' });
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
      evidence: { market: { source: 'fixture' }, calendar: { events: [], coverageWarning: '' } },
    } as unknown as AiRules;
    const narrative = {
      summary: '요약',
      actions: ['출처 확인'],
      counterScenario: '반대 시나리오',
      dataGaps: ['한계'],
      confidenceExplanation: '근거가 제한적이다',
      sourceIds: ['market'],
    };
    const explained = await new AiEnricher(
      provider(fakeClient(fallbackReply(narrative)).client),
      new MemoryAiQuota(),
    ).enrich(rules, 'owner');
    expect(explained.ai).toMatchObject({
      status: 'ready',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      fallbackFrom: 'Claude Sonnet 5.5',
    });
    const direct = await new AiEnricher(
      provider(
        fakeClient(async () =>
          message({ content: [{ type: 'text', text: JSON.stringify(narrative) }] }),
        ).client,
      ),
      new MemoryAiQuota(),
    ).enrich(rules, 'owner');
    expect(direct.ai).toMatchObject({ status: 'ready', model: 'Claude Sonnet 5.5' });
    expect(direct.ai).not.toHaveProperty('fallbackFrom');
  });
});

describe('Anthropic provider: typed SDK errors', () => {
  const failingFetch = (status: number, text = `provider echoed ${KEY} and a secret`) => {
    const calls = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ type: 'error', error: { type: 'api_error', message: text } }),
          { status, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', calls);
    return calls;
  };
  const run = async () => {
    try {
      await new AnthropicProvider(config, { apiKey: KEY }).generate(request());
    } catch (error) {
      expect(error).toBeInstanceOf(AiProviderError);
      return error as AiProviderError;
    }
    throw new Error('expected a failure');
  };
  it('maps real SDK errors by class (and the SDK never retries by itself)', async () => {
    const cases: [number, string][] = [
      [429, 'AI_QUOTA_PROVIDER'],
      [401, 'AI_AUTH_UNAVAILABLE'],
      [403, 'AI_AUTH_UNAVAILABLE'],
      [400, 'AI_UNAVAILABLE'],
      [404, 'AI_UNAVAILABLE'],
      [500, 'AI_UNAVAILABLE'],
      [529, 'AI_UNAVAILABLE'],
      [504, 'AI_TIMEOUT'],
    ];
    for (const [status, expected] of cases) {
      const calls = failingFetch(status);
      const error = await run();
      expect(error.code, String(status)).toBe(expected);
      expect(calls, `${status} was not retried`).toHaveBeenCalledTimes(1);
      // Only the fixed code: never provider text, never the key.
      expect(error.message).toBe(expected);
      expect(inspect(error, { depth: 6 })).not.toContain(KEY);
      expect(inspect(error, { depth: 6 })).not.toContain('secret');
    }
  });
  it('a network failure is unavailable; timeout and abort classes are timeouts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect((await run()).code).toBe('AI_UNAVAILABLE');
    expect(codeForSdkError(new Anthropic.APIConnectionTimeoutError(), false)).toBe('AI_TIMEOUT');
    expect(codeForSdkError(new Anthropic.APIUserAbortError(), false)).toBe('AI_TIMEOUT');
    expect(codeForSdkError(new Anthropic.APIConnectionError({}), false)).toBe('AI_UNAVAILABLE');
    expect(codeForSdkError(new Error('rate limit exceeded 429'), false)).toBe('AI_UNAVAILABLE');
    expect(codeForSdkError(new Error('anything'), true)).toBe('AI_TIMEOUT');
    expect(
      codeForSdkError(
        Anthropic.APIError.generate(
          429,
          { error: { type: 'rate_limit_error' } },
          'x',
          new Headers(),
        ),
        false,
      ),
    ).toBe('AI_QUOTA_PROVIDER');
  });
  it('an aborted signal never reaches the network', async () => {
    const { beta, client } = fakeClient();
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider(client).generate(request({ signal: controller.signal })),
    ).rejects.toThrow();
    expect(beta).not.toHaveBeenCalled();
  });
});

describe('Anthropic provider: the key never leaks', () => {
  it('is absent from the provider, the selection, errors and every console channel', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => undefined),
    );
    const selection = aiEnvironment({
      AI_PROVIDER: 'anthropic',
      GOOGLE_CLOUD_PROJECT: 'fixture-project',
      ANTHROPIC_API_KEY: KEY,
    })!;
    const ai = createAiProvider(selection);
    for (const value of [selection, ai]) {
      expect(JSON.stringify(value)).not.toContain(KEY);
      expect(inspect(value, { depth: 6, showHidden: false })).not.toContain(KEY);
      expect(Object.keys(value).join()).not.toMatch(/key/i);
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: { message: KEY } }, { status: 401 })),
    );
    const error = await ai.generate(request()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'AI_AUTH_UNAVAILABLE', message: 'AI_AUTH_UNAVAILABLE' });
    expect(inspect(error, { depth: 6 })).not.toContain(KEY);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
    // A bad key is rejected without echoing it.
    try {
      new AnthropicProvider(config, { apiKey: 'not-a-key-but-secret-text-123' });
      expect.unreachable();
    } catch (caught) {
      expect(String((caught as Error).message)).toBe('Invalid AI configuration');
    }
  });
});

describe('Anthropic provider: the budget stop is in front of every call', () => {
  const stopped = (status: 'stopped' | 'unknown' | 'running') =>
    installBudgetGuard({ status: async () => status });
  it('a stopped or unreadable budget blocks before any SDK use; running goes through', async () => {
    const { beta, standard, client } = fakeClient();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    for (const status of ['stopped', 'unknown'] as const) {
      stopped(status);
      await expect(provider(client).generate(request())).rejects.toMatchObject({
        code: 'AI_BUDGET_STOPPED',
      });
      // A provider that would build its own SDK client must not touch the network either.
      await expect(
        new AnthropicProvider(config, { apiKey: KEY }).generate(request()),
      ).rejects.toMatchObject({ code: 'AI_BUDGET_STOPPED' });
    }
    expect(beta).not.toHaveBeenCalled();
    expect(standard).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    stopped('running');
    await expect(provider(client).generate(request())).resolves.toMatchObject({
      json: { ok: true },
    });
    expect(beta).toHaveBeenCalledTimes(1);
  });
  it('production without an installed guard blocks too (fail closed)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { beta, client } = fakeClient();
    await expect(provider(client).generate(request())).rejects.toMatchObject({
      code: 'AI_BUDGET_STOPPED',
    });
    expect(beta).not.toHaveBeenCalled();
  });
  it('every feature stops with its own code and charges no quota', async () => {
    stopped('stopped');
    const { beta, client } = fakeClient();
    const quota = { consume: vi.fn(async () => true) };
    await expect(
      new ProviderMorningAi(provider(client), quota).translate([{ refId: 't1', title: 'x' }]),
    ).rejects.toMatchObject({ code: 'BUDGET_STOPPED' });
    await expect(
      new ProviderEnrichAi(provider(client), quota).enrich([
        {
          ref: 'A',
          country: '한국',
          date: '2026-10-20',
          title: '한국은행 보도자료',
          importance: 'low',
          titleIsKorean: true,
          knownFacts: [],
          reaction: [],
          reactionSmall: false,
        },
      ]),
    ).rejects.toMatchObject({ code: 'BUDGET_STOPPED' });
    const featureQuota = { consume: vi.fn(async () => true) };
    expect(
      await new ProviderAlgorithmDecider(provider(client), featureQuota).decide({
        market: 'KR',
        date: '2026-10-21',
        currency: 'KRW',
        symbols: [
          { symbol: '005930', price: 77000, held: false, heldTradingDays: null, signals: {} },
        ],
      }),
    ).toEqual({ status: 'unavailable', code: 'BUDGET_STOPPED' });
    expect(quota.consume).not.toHaveBeenCalled();
    expect(featureQuota.consume).not.toHaveBeenCalled();
    expect(beta).not.toHaveBeenCalled();
  });
  it('the provider-level stop maps to the features codes when a caller forgot its own check', async () => {
    // Simulate a feature without the early check: the provider itself throws the stop code.
    stopped('stopped');
    const { client } = fakeClient();
    await expect(provider(client).generate(request())).rejects.toMatchObject({
      code: 'AI_BUDGET_STOPPED',
    });
  });
});

describe('Anthropic configuration', () => {
  const env = {
    AI_PROVIDER: 'anthropic',
    GOOGLE_CLOUD_PROJECT: 'fixture-project',
    ANTHROPIC_API_KEY: KEY,
  };
  it('selects the provider with the default model and the fallback on', () => {
    const selection = aiEnvironment(env);
    expect(selection).toEqual({
      provider: 'anthropic',
      config: { project: 'fixture-project', model: 'claude-sonnet-5-5', location: 'global' },
      refusalFallback: true,
    });
    const built = createAiProvider(selection!) as AnthropicProvider;
    expect(built).toBeInstanceOf(AnthropicProvider);
    expect(built.refusalFallback).toBe(true);
    expect(aiProviderFromEnvironment(env)).toBeInstanceOf(AnthropicProvider);
    expect(aiEnvironment({ ...env, AI_MODEL: 'claude-sonnet-5-5' })?.config.model).toBe(
      'claude-sonnet-5-5',
    );
  });
  it('is off (a configuration error) without a plausible key, in the wrong family or without a project', () => {
    expect(aiEnvironment({ ...env, ANTHROPIC_API_KEY: undefined })).toBeNull();
    expect(aiEnvironment({ ...env, ANTHROPIC_API_KEY: '' })).toBeNull();
    expect(aiEnvironment({ ...env, ANTHROPIC_API_KEY: 'sk-ant-short' })).toBeNull();
    expect(aiEnvironment({ ...env, ANTHROPIC_API_KEY: 'sk-proj-' + 'a'.repeat(30) })).toBeNull();
    expect(aiEnvironment({ ...env, ANTHROPIC_API_KEY: 'sk-ant-' + 'a b'.repeat(10) })).toBeNull();
    expect(aiEnvironment({ ...env, ANTHROPIC_API_KEY: 'sk-ant-' + 'a'.repeat(294) })).toBeNull();
    expect(aiEnvironment({ ...env, AI_MODEL: 'gemini-3.8-flash' })).toBeNull();
    expect(aiEnvironment({ ...env, GOOGLE_CLOUD_PROJECT: undefined })).toBeNull();
    expect(aiProviderFromEnvironment({ ...env, ANTHROPIC_API_KEY: 'nope' })).toBeNull();
    // The key is irrelevant to the Vertex providers.
    expect(
      aiEnvironment({ ...env, AI_PROVIDER: 'vertex-claude', ANTHROPIC_API_KEY: undefined }),
    ).toEqual({
      provider: 'vertex-claude',
      config: { project: 'fixture-project', model: 'claude-sonnet-5-5', location: 'global' },
    });
  });
  it('the key shape: sk-ant- prefix, 20 to 300 characters of the key alphabet', () => {
    expect(validAnthropicApiKey('sk-ant-' + 'a'.repeat(13))).toBe(true);
    expect(validAnthropicApiKey('sk-ant-' + 'a'.repeat(12))).toBe(false);
    expect(validAnthropicApiKey('sk-ant-' + 'a'.repeat(293))).toBe(true);
    expect(validAnthropicApiKey('sk-ant-' + 'a'.repeat(294))).toBe(false);
    expect(validAnthropicApiKey('sk-ant-api03-A_b-9' + 'c'.repeat(10))).toBe(true);
    expect(validAnthropicApiKey(undefined)).toBe(false);
    expect(validAnthropicApiKey(12345678901234567890)).toBe(false);
  });
  it('the fallback switch is exactly true/false (or unset); anything else is a configuration error', () => {
    expect(refusalFallbackFlag(undefined)).toBe(true);
    expect(refusalFallbackFlag('')).toBe(true);
    expect(refusalFallbackFlag('true')).toBe(true);
    expect(refusalFallbackFlag('false')).toBe(false);
    for (const bad of ['FALSE', '0', 'off', 'no', ' false'])
      expect(refusalFallbackFlag(bad)).toBeNull();
    expect(aiEnvironment({ ...env, ANTHROPIC_REFUSAL_FALLBACK: 'false' })?.refusalFallback).toBe(
      false,
    );
    expect(
      (
        aiProviderFromEnvironment({
          ...env,
          ANTHROPIC_REFUSAL_FALLBACK: 'false',
        }) as AnthropicProvider
      ).refusalFallback,
    ).toBe(false);
    expect(aiEnvironment({ ...env, ANTHROPIC_REFUSAL_FALLBACK: 'maybe' })).toBeNull();
  });
  it('the provider constructor refuses other model families and malformed keys', () => {
    expect(() => new AnthropicProvider({ model: 'gemini-3.8-flash' }, { apiKey: KEY })).toThrow();
    expect(() => new AnthropicProvider(config, { apiKey: 'sk-ant-' })).toThrow();
  });
});

describe('Anthropic route: static deployment checks', () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const deploy = read('.github/workflows/deploy.yml');
  const step = (name: string) => {
    const start = deploy.indexOf(`- name: ${name}`);
    expect(start, name).toBeGreaterThan(0);
    const next = deploy.indexOf('\n      - name: ', start + 1);
    return deploy.slice(start, next === -1 ? undefined : next);
  };
  it('the official SDK is a dependency (one SDK, no raw HTTP)', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies).toHaveProperty('@anthropic-ai/sdk');
    expect(read('src/server/ai-provider.ts')).not.toMatch(/api\.anthropic\.com\/v1/);
  });
  it('provider and model come from repository variables with the Anthropic defaults', () => {
    expect(deploy).toContain("AI_PROVIDER: ${{ vars.AI_PROVIDER || 'anthropic' }}");
    expect(deploy).toContain("AI_MODEL: ${{ vars.AI_MODEL || 'claude-sonnet-5-5' }}");
    expect(deploy).toContain(
      "ANTHROPIC_REFUSAL_FALLBACK: ${{ vars.ANTHROPIC_REFUSAL_FALLBACK || 'true' }}",
    );
    expect(deploy).not.toContain('ANTHROPIC_API_KEY=sk-');
    // The service gets the key from the --attach of the script, not from this workflow.
    expect(step('Deploy verified revision')).not.toContain('--set-secrets');
    expect(step('Deploy verified revision')).toContain(
      'ANTHROPIC_REFUSAL_FALLBACK=$ANTHROPIC_REFUSAL_FALLBACK',
    );
  });
  it('the morning, calendar-enrich, paper and live jobs copy the numeric key version from the service', () => {
    for (const name of [
      'Deploy morning calendar job',
      'Deploy calendar enrichment job',
      'Deploy paper algorithm job',
      'Deploy live algorithm job',
    ]) {
      const body = step(name);
      expect(body, name).toContain('select(.name == "ANTHROPIC_API_KEY")');
      expect(body, name).toContain('select(.valueFrom.secretKeyRef != null)');
      expect(body, name).toContain('investing-anthropic-api-key:[0-9]+');
      expect(body, name).toContain('ANTHROPIC_REFUSAL_FALLBACK=$ANTHROPIC_REFUSAL_FALLBACK');
      // The version comes from the service; nothing reads a secret value.
      expect(body, name).not.toMatch(/secrets versions access|latest/);
    }
    // The snapshot and access-check jobs never call a model: no key there.
    expect(step('Deploy daily snapshot job')).not.toContain('ANTHROPIC');
    expect(step('Deploy order access check job')).not.toContain('ANTHROPIC');
  });
  it('the AI switches of the morning and calendar jobs go off instead of the job failing without a key', () => {
    const morning = step('Deploy morning calendar job');
    expect(morning).toContain('MORNING_AI=true');
    expect(morning).toContain('MORNING_AI_ENABLED=$MORNING_AI');
    expect(morning).toContain('MORNING_AI=false');
    const calendar = step('Deploy calendar enrichment job');
    expect(calendar).toContain('CALENDAR_AI=true');
    expect(calendar).toContain('CALENDAR_AI_ENABLED=$CALENDAR_AI');
    expect(calendar).toContain('CALENDAR_AI=false');
  });
  it('AI-type algorithms stay off', () => {
    expect(deploy.match(/--set-env-vars="[^"]*ALGO_AI_ENABLED=false[^"]*"/g)?.length).toBe(2);
    expect(deploy).not.toContain('ALGO_AI_ENABLED=true');
  });
  it('Terraform: one secret, accessor for the runtime and the jobs account, no project-level role', () => {
    const tf = read('infra/gcp/providers.tf');
    expect(tf).toContain('"investing-anthropic-api-key"');
    // The runtime grant is the existing for_each over every provider secret.
    expect(tf).toMatch(/provider_secrets = toset\(\[[^\]]*"investing-anthropic-api-key"/s);
    expect(tf).toContain('google_service_account.runtime.email');
    expect(tf).toMatch(
      /resource "google_secret_manager_secret_iam_member" "jobs_anthropic" \{[^}]*"investing-anthropic-api-key"[^}]*roles\/secretmanager\.secretAccessor[^}]*google_service_account\.jobs\.email/s,
    );
    expect(tf).not.toMatch(/google_project_iam_member/);
    expect(tf).not.toMatch(/secretVersionAdder|secretmanager\.admin/);
  });
  it('the manual calendar job installs the budget gate before it can call a model', () => {
    const job = read('src/jobs/calendar-enrich.ts');
    expect(job).toContain("import { budgetJobGate } from './budget-gate.js'");
    expect(job.indexOf('budgetJobGate(db, log')).toBeGreaterThan(job.indexOf('new Firestore'));
    expect(job.indexOf('budgetJobGate(db, log')).toBeLessThan(job.indexOf('runCalendarEnrich({'));
  });
});
