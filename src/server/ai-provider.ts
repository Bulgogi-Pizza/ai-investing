import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { GoogleAuth } from 'google-auth-library';
import { aiBlockedByBudget } from './budget-guard.js';

/**
 * Provider abstraction shared by every AI feature (explanations in ai.ts, the morning summary and
 * translation in ai-morning.ts, calendar enrichment in calendar-enrich.ts, algorithm decisions in
 * algorithm-ai.ts). A feature builds the request (minimized input, JSON schema, effort) and
 * validates the answer; the provider only moves it to the model and back.
 *
 *   anthropic      Claude Sonnet 5.5 on the first-party Anthropic API through @anthropic-ai/sdk
 *                  (the production route since 2026-10-21; needs ANTHROPIC_API_KEY from Secret Manager)
 *   vertex-claude  Claude Sonnet 5.5 on Google Vertex AI through @anthropic-ai/vertex-sdk (same model;
 *                  blocked for this project: its anthropic-claude-sonnet quota is 0)
 *   vertex         Gemini on Vertex AI generateContent (kept selectable by configuration)
 *
 * The Vertex providers use the project's own Google credentials (ADC / IAM). Only `anthropic` has an
 * API key; it is read from the environment once, never logged, never part of an error.
 *
 * Provider contract (the part that does not depend on the model):
 *   - the call never retries by itself (the SDK's maxRetries is 0); a failed generation is a failed
 *     generation and the caller records a code;
 *   - the caller's AbortSignal bounds the call;
 *   - errors are fixed codes only: never provider text, request bodies or credentials;
 *   - a 429 from the provider is its own code (AI_QUOTA_PROVIDER) so a provider-side quota problem
 *     is visible and distinct from our own per-feature daily quota (AI_QUOTA_EXCEEDED);
 *   - the monthly budget stop is checked inside every provider call, in front of the network
 *     (AI_BUDGET_STOPPED). The features check it too (cheaper, before they charge their daily quota);
 *     this one exists because Anthropic spend is outside the GCP budget, so the app's own stop is the
 *     only brake, and it must also cover callers that forgot theirs.
 */
export type AiProviderName = 'anthropic' | 'vertex-claude' | 'vertex';
export type AiEffort = 'low' | 'medium';
export type AiProviderErrorCode =
  | 'AI_AUTH_UNAVAILABLE'
  | 'AI_TIMEOUT'
  | 'AI_UNAVAILABLE'
  | 'AI_QUOTA_PROVIDER'
  | 'AI_BUDGET_STOPPED'
  | 'AI_REFUSED'
  | 'AI_RESPONSE_INVALID'
  | 'AI_RESPONSE_INCOMPLETE';
export class AiProviderError extends Error {
  constructor(public code: AiProviderErrorCode) {
    super(code);
    this.name = 'AiProviderError';
  }
}
/** JSON Schema subset: lowercase types, closed objects. Providers translate it to their own dialect. */
export type JsonSchema = { [key: string]: unknown };
export type AiUsage = { prompt: number; output: number; thoughts: number; total: number };
export type AiGenerateRequest = {
  system: string;
  prompt: string;
  schema: JsonSchema;
  /** Thinking depth. Claude: output_config.effort. Gemini: ignored (see `gemini`). */
  effort: AiEffort;
  /** Output ceiling including thinking tokens (both providers count thinking against it). */
  maxOutputTokens: number;
  /** Bounds the whole call; the caller creates it. */
  signal: AbortSignal;
  /** Gemini only. Claude Sonnet 5.5 rejects non-default sampling parameters, so none is sent there. */
  temperature?: number;
  gemini?: { thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH'; thinkingBudget?: number };
};
export type AiGenerateResult = {
  json: unknown;
  usage: AiUsage;
  /**
   * Present only when a different model than the requested one produced the answer (Anthropic
   * server-side refusal fallback). `model` is the model id that served it; it is billed at that
   * model's rates (docs/implementation/ai-provider.md).
   */
  fallback?: { model: string };
};
export interface AiProvider {
  readonly name: AiProviderName;
  readonly model: string;
  /** Short human label stored with generated text ("Claude Sonnet 5.5", or the model id). */
  readonly label: string;
  generate(request: AiGenerateRequest): Promise<AiGenerateResult>;
}
export type AiProviderConfig = { project: string; model: string; location: string };

export const DEFAULT_AI_PROVIDER: AiProviderName = 'vertex-claude';
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';

export const validProviderConfig = (config: AiProviderConfig) =>
  /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(config.project) &&
  /^[a-z][a-z0-9.-]{1,80}$/.test(config.model) &&
  /^(global|us|eu|[a-z]+-[a-z]+\d)$/.test(config.location);
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
export const emptyUsage = (): AiUsage => ({ prompt: 0, output: 0, thoughts: 0, total: 0 });
/** The monthly budget stop, in front of every provider call (fails closed, see budget-guard.ts). */
async function assertNotBudgetStopped() {
  if (await aiBlockedByBudget()) throw new AiProviderError('AI_BUDGET_STOPPED');
}

/** Maps an HTTP status from the provider to one fixed code. */
export function codeForStatus(status: unknown): AiProviderErrorCode {
  if (status === 429) return 'AI_QUOTA_PROVIDER';
  if (status === 401 || status === 403) return 'AI_AUTH_UNAVAILABLE';
  if (status === 408 || status === 504) return 'AI_TIMEOUT';
  return 'AI_UNAVAILABLE';
}

// ---------------------------------------------------------------------------
// Schema translation.
// ---------------------------------------------------------------------------
const recordOf = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
/** Gemini's responseSchema uses uppercase type names and has no additionalProperties. */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!recordOf(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') continue;
    if (key === 'type' && typeof value === 'string') out[key] = value.toUpperCase();
    else if (key === 'properties' && recordOf(value))
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toGeminiSchema(v)]));
    else out[key] = toGeminiSchema(value);
  }
  return out;
}
/**
 * Claude structured outputs: objects must be closed, and numeric/string constraints, maxItems and
 * minItems other than 0/1 are not supported (docs: Structured outputs, JSON Schema limitations).
 * They are removed from the schema sent to the model; the caller's validation enforces them.
 */
export function toClaudeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toClaudeSchema);
  if (!recordOf(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (['maxItems', 'minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength'].includes(key))
      continue;
    if (key === 'minItems' && value !== 0 && value !== 1) continue;
    if (key === 'properties' && recordOf(value))
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toClaudeSchema(v)]));
    else out[key] = toClaudeSchema(value);
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

// ---------------------------------------------------------------------------
// Claude on Vertex AI (default).
// ---------------------------------------------------------------------------
/** The only part of the SDK client the adapter uses, so tests can inject a fake. */
export interface ClaudeMessagesClient {
  messages: {
    create(
      params: ClaudeMessageParams,
      options: { signal: AbortSignal; timeout?: number; maxRetries?: number },
    ): Promise<ClaudeMessage>;
  };
}
export type ClaudeMessageParams = {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: 'user'; content: string }[];
  output_config: {
    effort: AiEffort;
    format: { type: 'json_schema'; schema: JsonSchema };
  };
};
export type ClaudeMessage = {
  /** The model that produced the message (the fallback model after a server-side fallback). */
  model?: unknown;
  stop_reason?: string | null;
  content?: { type: string; text?: unknown }[];
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    output_tokens_details?: { thinking_tokens?: unknown } | null;
    /** Per-attempt usage; a `fallback_message` entry means a fallback model served the answer. */
    iterations?:
      { type?: unknown; model?: unknown; input_tokens?: unknown; output_tokens?: unknown }[] | null;
  };
};

/**
 * Turns a finished Claude message into the provider result. Shared by the Vertex and the Anthropic
 * API providers; it never throws anything but an AiProviderError with a fixed code.
 */
function readClaudeMessage(message: ClaudeMessage): AiGenerateResult {
  // Always before reading content: a refusal or a cut-off answer is never parsed.
  if (message.stop_reason === 'refusal') throw new AiProviderError('AI_REFUSED');
  if (
    message.stop_reason === 'max_tokens' ||
    message.stop_reason === 'model_context_window_exceeded'
  )
    throw new AiProviderError('AI_RESPONSE_INCOMPLETE');
  if (message.stop_reason !== 'end_turn') throw new AiProviderError('AI_RESPONSE_INVALID');
  const blocks = message.content;
  if (!Array.isArray(blocks)) throw new AiProviderError('AI_RESPONSE_INVALID');
  // After a server-side fallback the content has a `fallback` marker where the first model's
  // output gave way to the next model's; only what follows the last marker is the answer.
  const lastBoundary = blocks.map((block) => block?.type).lastIndexOf('fallback');
  // Thinking blocks (summarized or empty) are skipped; any other non-text block is not expected.
  const texts: string[] = [];
  for (const block of blocks.slice(lastBoundary + 1)) {
    if (block?.type === 'thinking' || block?.type === 'redacted_thinking') continue;
    if (block?.type !== 'text' || typeof block.text !== 'string')
      throw new AiProviderError('AI_RESPONSE_INVALID');
    texts.push(block.text);
  }
  let json: unknown;
  try {
    json = JSON.parse(texts.join(''));
  } catch {
    throw new AiProviderError('AI_RESPONSE_INVALID');
  }
  const usage = message.usage ?? {};
  let prompt = count(usage.input_tokens);
  let output = count(usage.output_tokens);
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  const served = iterations.find((entry) => entry?.type === 'fallback_message');
  if (!served) {
    return {
      json,
      usage: {
        prompt,
        output,
        thoughts: count(usage.output_tokens_details?.thinking_tokens),
        total: prompt + output,
      },
    };
  }
  // Top-level usage covers only the attempt that produced the message; the declined attempts are
  // spent tokens too, so the per-attempt entries are the source of truth for a fallback turn.
  prompt = iterations.reduce((sum, entry) => sum + count(entry?.input_tokens), 0);
  output = iterations.reduce((sum, entry) => sum + count(entry?.output_tokens), 0);
  const model = typeof served.model === 'string' ? served.model : message.model;
  return {
    json,
    usage: {
      prompt,
      output,
      thoughts: count(usage.output_tokens_details?.thinking_tokens),
      total: prompt + output,
    },
    fallback: {
      model:
        typeof model === 'string' && /^[a-z][a-z0-9.@-]{1,80}$/.test(model) ? model : 'unknown',
    },
  };
}

/**
 * Claude Sonnet 5.5 on Vertex AI. Request rules (claude-api skill, model-migration.md "Migrating
 * to Claude Sonnet 5.5"; TypeScript README, structured outputs):
 *   - model id is the bare `claude-sonnet-5-5`; client region `global`; ADC credentials;
 *   - thinking is adaptive by default: no `thinking` parameter is sent (`disabled` is a 400);
 *   - depth is controlled with output_config.effort (low for text work);
 *   - structured JSON through output_config.format (json_schema);
 *   - no temperature/top_p/top_k (non-default values are a 400), no assistant prefill, no tool_choice;
 *   - stop_reason is always checked: `refusal` -> AI_REFUSED, `max_tokens` -> AI_RESPONSE_INCOMPLETE.
 * Server-side `fallbacks` (beta server-side-fallback-2026-07-01) is not available on Vertex, and the
 * client-side refusal-fallback middleware is deliberately not used: other Claude models have no
 * quota in this project, so a fallback could only turn a refusal into a quota error.
 */
export class ClaudeVertexProvider implements AiProvider {
  readonly name = 'vertex-claude' as const;
  private client: ClaudeMessagesClient | undefined;
  constructor(
    private config: AiProviderConfig,
    client?: ClaudeMessagesClient,
  ) {
    if (!validProviderConfig(config) || !/^claude-[a-z0-9.-]+$/.test(config.model))
      throw new Error('Invalid AI configuration');
    this.client = client;
  }
  get model() {
    return this.config.model;
  }
  get label() {
    return this.config.model === DEFAULT_CLAUDE_MODEL ? 'Claude Sonnet 5.5' : this.config.model;
  }
  /** Created on first use: the SDK starts resolving credentials when it is constructed. */
  private sdk(): ClaudeMessagesClient {
    this.client ??= new AnthropicVertex({
      projectId: this.config.project,
      region: this.config.location,
      maxRetries: 0,
      googleAuth: new GoogleAuth({
        projectId: this.config.project,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      }),
    }) as unknown as ClaudeMessagesClient;
    return this.client;
  }
  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    request.signal.throwIfAborted();
    await assertNotBudgetStopped();
    let message: ClaudeMessage;
    try {
      message = await this.sdk().messages.create(
        {
          model: this.config.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
          output_config: {
            effort: request.effort,
            format: { type: 'json_schema', schema: toClaudeSchema(request.schema) as JsonSchema },
          },
        },
        { signal: request.signal, maxRetries: 0 },
      );
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if (request.signal.aborted) throw new AiProviderError('AI_TIMEOUT');
      const failure = error as { status?: unknown; name?: unknown };
      if (typeof failure?.status === 'number')
        throw new AiProviderError(codeForStatus(failure.status));
      throw new AiProviderError(
        failure?.name === 'APIConnectionTimeoutError' ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE',
      );
    }
    return readClaudeMessage(message);
  }
}

// ---------------------------------------------------------------------------
// Claude Sonnet 5.5 on the first-party Anthropic API (production route).
// ---------------------------------------------------------------------------
export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';
/** Beta header of the `fallbacks: "default"` form (claude-api skill, model-migration.md). */
export const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Loose shape check only (starts with sk-ant-, 20-300 characters); the provider decides if it works. */
export const validAnthropicApiKey = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= 20 &&
  value.length <= 300 &&
  /^sk-ant-[A-Za-z0-9_-]+$/.test(value);
/** Upper bound for one HTTP call; every caller's own AbortSignal is shorter and wins. */
const ANTHROPIC_HTTP_TIMEOUT_MS = 180_000;
/** The part of the SDK client this adapter uses (the standard and the beta messages endpoint). */
export interface AnthropicApiClient {
  messages: {
    create(
      params: ClaudeMessageParams,
      options: { signal: AbortSignal; maxRetries?: number },
    ): Promise<ClaudeMessage>;
  };
  beta: {
    messages: {
      create(
        params: ClaudeMessageParams & { betas: string[]; fallbacks: 'default' },
        options: { signal: AbortSignal; maxRetries?: number },
      ): Promise<ClaudeMessage>;
    };
  };
}
export type AnthropicProviderOptions = {
  /** ANTHROPIC_API_KEY. Held in memory only. */
  apiKey: string;
  /** Server-side refusal fallback; on unless explicitly turned off (ANTHROPIC_REFUSAL_FALLBACK=false). */
  refusalFallback?: boolean;
};

/** Maps an error thrown by the SDK to one fixed code, by class (never by message text). */
export function codeForSdkError(error: unknown, aborted: boolean): AiProviderErrorCode {
  if (error instanceof AiProviderError) return error.code;
  if (aborted || error instanceof Anthropic.APIUserAbortError) return 'AI_TIMEOUT';
  // APIConnectionTimeoutError extends APIConnectionError: the more specific class goes first.
  if (error instanceof Anthropic.APIConnectionTimeoutError) return 'AI_TIMEOUT';
  if (error instanceof Anthropic.APIConnectionError) return 'AI_UNAVAILABLE';
  if (error instanceof Anthropic.RateLimitError) return 'AI_QUOTA_PROVIDER';
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  )
    return 'AI_AUTH_UNAVAILABLE';
  // Remaining API errors (400, 404, 409, 422, 5xx incl. 529 overloaded; 408/504 through the status).
  if (error instanceof Anthropic.APIError) return codeForStatus(error.status);
  return 'AI_UNAVAILABLE';
}

/**
 * Claude Sonnet 5.5 on the Anthropic API through the official SDK (claude-api skill: TypeScript
 * README "Client Initialization" and "Stop Reasons", tool-use.md "Structured Outputs", shared
 * error-codes.md, model-migration.md "Migrating to Claude Sonnet 5.5" and the server-side
 * `fallbacks` sections). Same request rules as the Vertex path (see ClaudeVertexProvider):
 * adaptive thinking by default (no `thinking`), depth by `output_config.effort`, structured JSON by
 * `output_config.format`, no sampling parameters, no prefill, no forced tool choice, stop_reason
 * always checked before the content is read.
 *
 * Refusal fallback (on by default; ANTHROPIC_REFUSAL_FALLBACK=false turns it off): the request goes
 * to the beta messages endpoint with `betas: ['server-side-fallback-2026-07-01']` and
 * `fallbacks: 'default'`. A policy decline is then re-run server-side, inside the same call, on the
 * model Anthropic picks for that refusal category. The skill documents this form next to
 * `output_config.format`, so structured outputs stay on. The `fallback_message` entry of
 * `usage.iterations` and the `fallback` content block are read (readClaudeMessage) and the serving
 * model is returned as `fallback.model`. Billing: a fallback attempt is billed at the FALLBACK
 * model's own rates, not Sonnet 5.5's.
 *
 * The API key is the SDK's `apiKey` and nothing else. The base URL is pinned (an ANTHROPIC_BASE_URL in
 * the environment cannot redirect the key) and ANTHROPIC_AUTH_TOKEN is ignored (sending both
 * credentials is a 401).
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic' as const;
  /** A private field: neither enumerable nor serialized, so logging the provider cannot print it. */
  readonly #apiKey: string;
  readonly #refusalFallback: boolean;
  #client: AnthropicApiClient | undefined;
  constructor(
    private config: { model: string },
    options: AnthropicProviderOptions,
    client?: AnthropicApiClient,
  ) {
    if (!/^claude-[a-z0-9.-]{1,80}$/.test(config.model) || !validAnthropicApiKey(options.apiKey))
      throw new Error('Invalid AI configuration');
    this.#apiKey = options.apiKey;
    this.#refusalFallback = options.refusalFallback ?? true;
    this.#client = client;
  }
  get model() {
    return this.config.model;
  }
  get label() {
    return this.config.model === DEFAULT_CLAUDE_MODEL ? 'Claude Sonnet 5.5' : this.config.model;
  }
  get refusalFallback() {
    return this.#refusalFallback;
  }
  /** Created on first use. maxRetries 0: a failed generation is not retried by the SDK. */
  private sdk(): AnthropicApiClient {
    this.#client ??= new Anthropic({
      apiKey: this.#apiKey,
      authToken: null,
      baseURL: ANTHROPIC_API_BASE_URL,
      maxRetries: 0,
      timeout: ANTHROPIC_HTTP_TIMEOUT_MS,
    }) as unknown as AnthropicApiClient;
    return this.#client;
  }
  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    request.signal.throwIfAborted();
    // The app's monthly budget stop, before any network use of the key.
    await assertNotBudgetStopped();
    const params: ClaudeMessageParams = {
      model: this.config.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.prompt }],
      output_config: {
        effort: request.effort,
        format: { type: 'json_schema', schema: toClaudeSchema(request.schema) as JsonSchema },
      },
    };
    const options = { signal: request.signal, maxRetries: 0 };
    let message: ClaudeMessage;
    try {
      message = this.#refusalFallback
        ? await this.sdk().beta.messages.create(
            { ...params, betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' },
            options,
          )
        : await this.sdk().messages.create(params, options);
    } catch (error) {
      throw new AiProviderError(codeForSdkError(error, request.signal.aborted));
    }
    return readClaudeMessage(message);
  }
}

// ---------------------------------------------------------------------------
// Gemini on Vertex AI (selectable, no longer the default).
// ---------------------------------------------------------------------------
export type AccessTokenSource = { getAccessToken(): Promise<string | null | undefined> };
const maximumResponseBytes = 128 * 1024;
export class GeminiVertexProvider implements AiProvider {
  readonly name = 'vertex' as const;
  private auth: AccessTokenSource;
  constructor(
    private config: AiProviderConfig,
    private transport: typeof fetch = fetch,
    auth?: AccessTokenSource,
  ) {
    if (!validProviderConfig(config) || /^claude/.test(config.model))
      throw new Error('Invalid AI configuration');
    this.auth =
      auth ??
      new GoogleAuth({
        projectId: config.project,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
  }
  get model() {
    return this.config.model;
  }
  get label() {
    return this.config.model;
  }
  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    const { signal } = request;
    signal.throwIfAborted();
    await assertNotBudgetStopped();
    let token: string | null | undefined;
    try {
      token = await this.auth.getAccessToken();
    } catch {
      throw new AiProviderError('AI_AUTH_UNAVAILABLE');
    }
    if (!token) throw new AiProviderError('AI_AUTH_UNAVAILABLE');
    signal.throwIfAborted();
    const host =
      this.config.location === 'global'
        ? 'aiplatform.googleapis.com'
        : `${this.config.location}-aiplatform.googleapis.com`;
    const url = `https://${host}/v1/projects/${this.config.project}/locations/${this.config.location}/publishers/google/models/${this.config.model}:generateContent`;
    let response: Response;
    try {
      response = await this.transport(url, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
          generationConfig: {
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            candidateCount: 1,
            maxOutputTokens: request.maxOutputTokens,
            responseMimeType: 'application/json',
            responseSchema: toGeminiSchema(request.schema),
            ...(request.gemini?.thinkingLevel
              ? { thinkingConfig: { thinkingLevel: request.gemini.thinkingLevel } }
              : request.gemini?.thinkingBudget === undefined
                ? {}
                : { thinkingConfig: { thinkingBudget: request.gemini.thinkingBudget } }),
          },
        }),
      });
    } catch {
      throw new AiProviderError(signal.aborted ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AiProviderError(codeForStatus(response.status));
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AiProviderError('AI_RESPONSE_INVALID');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumResponseBytes) {
        await reader.cancel();
        throw new AiProviderError('AI_RESPONSE_INVALID');
      }
      chunks.push(value);
    }
    let envelope: {
      candidates?: {
        finishReason?: unknown;
        content?: { parts?: { text?: unknown; thought?: unknown }[] };
      }[];
      usageMetadata?: Record<string, unknown>;
    };
    try {
      envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new AiProviderError('AI_RESPONSE_INVALID');
    }
    const candidate = envelope?.candidates?.[0];
    if (envelope?.candidates?.length !== 1 || !Array.isArray(candidate?.content?.parts))
      throw new AiProviderError('AI_RESPONSE_INVALID');
    // Thinking can use up the output budget: a cut-off answer is never parsed.
    if (candidate.finishReason !== 'STOP') throw new AiProviderError('AI_RESPONSE_INCOMPLETE');
    const parts = candidate.content.parts;
    if (parts.some((part) => typeof part.text !== 'string' || part.thought === true))
      throw new AiProviderError('AI_RESPONSE_INVALID');
    let json: unknown;
    try {
      json = JSON.parse(parts.map((part) => part.text as string).join(''));
    } catch {
      throw new AiProviderError('AI_RESPONSE_INVALID');
    }
    const meta = envelope.usageMetadata ?? {};
    return {
      json,
      usage: {
        prompt: count(meta.promptTokenCount),
        output: count(meta.candidatesTokenCount),
        thoughts: count(meta.thoughtsTokenCount),
        total: count(meta.totalTokenCount),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Selection by configuration.
// ---------------------------------------------------------------------------
export type AiEnvironment = {
  provider: AiProviderName;
  config: AiProviderConfig;
  /** anthropic only: the server-side refusal fallback switch (default on). */
  refusalFallback?: boolean;
};
/** The API key travels with a selection but is not an enumerable property: it never serializes. */
const API_KEY = Symbol('anthropic-api-key');
type SecretCarrier = { [API_KEY]?: string };
/**
 * ANTHROPIC_REFUSAL_FALLBACK: unset or empty = on; exactly "true" = on; exactly "false" = off. Any
 * other value is a configuration error (a typo must not silently change what a call may cost).
 */
export function refusalFallbackFlag(value: string | undefined): boolean | null {
  if (value === undefined || value === '' || value === 'true') return true;
  return value === 'false' ? false : null;
}
/**
 * AI_PROVIDER = anthropic | vertex-claude | vertex (anything else, or unset, means "no provider").
 * anthropic and vertex-claude default AI_MODEL to claude-sonnet-5-5; vertex needs AI_MODEL (a Gemini
 * model id). A model id of the wrong family for the provider is a configuration error (null).
 * anthropic additionally needs a plausible ANTHROPIC_API_KEY (starts with sk-ant-, 20-300
 * characters; checked, and kept out of the returned object's enumerable state) and a valid
 * ANTHROPIC_REFUSAL_FALLBACK; otherwise the provider is off (null) and nothing is called.
 */
export function aiEnvironment(env: NodeJS.ProcessEnv): AiEnvironment | null {
  const { AI_PROVIDER, AI_LOCATION, GOOGLE_CLOUD_PROJECT } = env;
  if (
    (AI_PROVIDER !== 'anthropic' && AI_PROVIDER !== 'vertex-claude' && AI_PROVIDER !== 'vertex') ||
    !GOOGLE_CLOUD_PROJECT
  )
    return null;
  const model = env.AI_MODEL || (AI_PROVIDER === 'vertex' ? '' : DEFAULT_CLAUDE_MODEL);
  const config = { project: GOOGLE_CLOUD_PROJECT, model, location: AI_LOCATION || 'global' };
  if (!model || !validProviderConfig(config)) return null;
  const claude = /^claude-/.test(model);
  if ((AI_PROVIDER !== 'vertex') !== claude) return null;
  if (AI_PROVIDER !== 'anthropic') return { provider: AI_PROVIDER, config };
  const apiKey = env.ANTHROPIC_API_KEY;
  const refusalFallback = refusalFallbackFlag(env.ANTHROPIC_REFUSAL_FALLBACK);
  if (!validAnthropicApiKey(apiKey) || refusalFallback === null) return null;
  const selection: AiEnvironment & SecretCarrier = {
    provider: AI_PROVIDER,
    config,
    refusalFallback,
  };
  Object.defineProperty(selection, API_KEY, { value: apiKey, enumerable: false });
  return selection;
}
/** Builds the provider for a validated environment; throws only on an invalid configuration. */
export function createAiProvider(selection: AiEnvironment): AiProvider {
  if (selection.provider === 'anthropic')
    return new AnthropicProvider(selection.config, {
      apiKey: (selection as SecretCarrier)[API_KEY] ?? '',
      refusalFallback: selection.refusalFallback ?? true,
    });
  return selection.provider === 'vertex-claude'
    ? new ClaudeVertexProvider(selection.config)
    : new GeminiVertexProvider(selection.config);
}
export function aiProviderFromEnvironment(env: NodeJS.ProcessEnv): AiProvider | null {
  const selection = aiEnvironment(env);
  if (!selection) return null;
  try {
    return createAiProvider(selection);
  } catch {
    return null;
  }
}
