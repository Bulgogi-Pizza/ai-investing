import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { GoogleAuth } from 'google-auth-library';

/**
 * Provider abstraction shared by every AI feature (explanations in ai.ts, the morning summary and
 * translation in ai-morning.ts, calendar enrichment in calendar-enrich.ts, algorithm decisions in
 * algorithm-ai.ts). A feature builds the request (minimized input, JSON schema, effort) and
 * validates the answer; the provider only moves it to the model and back.
 *
 *   vertex-claude  Claude Sonnet 5.5 on Google Vertex AI through @anthropic-ai/vertex-sdk (default)
 *   vertex         Gemini on Vertex AI generateContent (kept selectable by configuration)
 *
 * Both use the project's own Google credentials (ADC / IAM); there is no API key anywhere.
 *
 * Provider contract (the part that does not depend on the model):
 *   - the call never retries by itself (the SDK's maxRetries is 0); a failed generation is a failed
 *     generation and the caller records a code;
 *   - the caller's AbortSignal bounds the call;
 *   - errors are fixed codes only: never provider text, request bodies or credentials;
 *   - a 429 from the provider is its own code (AI_QUOTA_PROVIDER) so a provider-side quota problem
 *     is visible and distinct from our own per-feature daily quota (AI_QUOTA_EXCEEDED).
 */
export type AiProviderName = 'vertex-claude' | 'vertex';
export type AiEffort = 'low' | 'medium';
export type AiProviderErrorCode =
  | 'AI_AUTH_UNAVAILABLE'
  | 'AI_TIMEOUT'
  | 'AI_UNAVAILABLE'
  | 'AI_QUOTA_PROVIDER'
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
export type AiGenerateResult = { json: unknown; usage: AiUsage };
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
  stop_reason?: string | null;
  content?: { type: string; text?: unknown }[];
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    output_tokens_details?: { thinking_tokens?: unknown } | null;
  };
};

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
    // Thinking blocks (summarized or empty) are skipped; any other non-text block is not expected.
    const texts: string[] = [];
    for (const block of blocks) {
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
    const prompt = count(usage.input_tokens);
    const output = count(usage.output_tokens);
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
};
/**
 * AI_PROVIDER = vertex-claude | vertex (anything else, or unset, means "no provider").
 * vertex-claude defaults AI_MODEL to claude-sonnet-5-5; vertex needs AI_MODEL (a Gemini model id).
 * A model id of the wrong family for the provider is a configuration error (returns null).
 */
export function aiEnvironment(env: NodeJS.ProcessEnv): AiEnvironment | null {
  const { AI_PROVIDER, AI_LOCATION, GOOGLE_CLOUD_PROJECT } = env;
  if ((AI_PROVIDER !== 'vertex-claude' && AI_PROVIDER !== 'vertex') || !GOOGLE_CLOUD_PROJECT)
    return null;
  const model = env.AI_MODEL || (AI_PROVIDER === 'vertex-claude' ? DEFAULT_CLAUDE_MODEL : '');
  const config = { project: GOOGLE_CLOUD_PROJECT, model, location: AI_LOCATION || 'global' };
  if (!model || !validProviderConfig(config)) return null;
  const claude = /^claude-/.test(model);
  if ((AI_PROVIDER === 'vertex-claude') !== claude) return null;
  return { provider: AI_PROVIDER, config };
}
/** Builds the provider for a validated environment; throws only on an invalid configuration. */
export function createAiProvider(selection: AiEnvironment): AiProvider {
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
