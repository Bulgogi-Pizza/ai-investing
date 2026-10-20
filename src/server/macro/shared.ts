import { ProviderError } from '../toss.js';
import { RateLimiter, SingleFlightCache, TtlCache, record, text } from '../fundamentals/shared.js';

export { RateLimiter, SingleFlightCache, TtlCache, record, text };

export const schemaInvalid = () =>
  new ProviderError(502, 'PROVIDER_SCHEMA_INVALID', '제공자 응답 형식을 확인하지 못했습니다.');
export const unreachable = () =>
  new ProviderError(503, 'PROVIDER_UNREACHABLE', '거시 지표 제공자에 연결할 수 없습니다.');
export const rateLimited = (retryAfter: number) =>
  new ProviderError(
    503,
    'PROVIDER_RATE_LIMITED',
    '제공자 요청 한도로 잠시 대기해야 합니다.',
    retryAfter,
  );
export const accessDenied = () =>
  new ProviderError(503, 'PROVIDER_ACCESS_DENIED', '제공자 인증키·접근 정책을 확인하세요.');
export const providerUnavailable = () =>
  new ProviderError(503, 'PROVIDER_UNAVAILABLE', '거시 지표 제공자 서비스를 사용할 수 없습니다.');
export const requestRejected = () =>
  new ProviderError(502, 'PROVIDER_REQUEST_REJECTED', '제공자가 요청을 거부했습니다.');
export const tooLarge = () =>
  new ProviderError(502, 'PROVIDER_RESPONSE_TOO_LARGE', '제공자 응답이 허용 크기를 넘었습니다.');

/** Real calendar date check, YYYY-MM-DD. */
export function isRealDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    value >= '1000-01-01' &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
export function requireDate(value: unknown): string {
  if (!isRealDate(value)) throw schemaInvalid();
  return value;
}
export function dayDifference(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
}
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

/**
 * Decimal-string convention of toss.ts: optional minus, digits, optional fraction, no exponent.
 * Missing markers ("." from FRED, empty/null from ECOS) become null; anything else non-numeric is
 * a schema failure rather than a silent zero.
 */
export function decimalOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw schemaInvalid();
    const result = String(value);
    if (!/^-?\d+(\.\d+)?$/.test(result)) throw schemaInvalid();
    return result;
  }
  if (typeof value !== 'string' || value.length > 40) throw schemaInvalid();
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '.') return null;
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw schemaInvalid();
  return trimmed;
}

export interface FetchOptions {
  headers: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
}

/**
 * Fixed-host GET with redirect refusal, timeout, byte cap and sanitized errors. The URL carries
 * the provider key (FRED: query, ECOS: path), so neither the URL nor any thrown transport error
 * is ever forwarded. `classify` may turn a non-2xx body into a more specific error (it must not
 * return provider text).
 */
export async function fetchProviderJson(
  transport: typeof fetch,
  url: string,
  options: FetchOptions,
  classify?: (status: number, body: unknown) => ProviderError | undefined,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await transport(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: options.headers,
    });
  } catch {
    throw unreachable();
  }
  const readCapped = async (limit: number): Promise<Buffer> => {
    if (!response.body) throw schemaInvalid();
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
      await response.body.cancel().catch(() => undefined);
      throw tooLarge();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit) {
          await reader.cancel().catch(() => undefined);
          throw tooLarge();
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw unreachable();
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  };
  if (!response.ok || response.redirected) {
    let body: unknown;
    try {
      body = response.redirected
        ? undefined
        : JSON.parse((await readCapped(64 * 1024)).toString('utf8'));
    } catch {
      // Error bodies are only used for classification; unreadable ones fall back to the status.
      body = undefined;
    }
    const specific = classify?.(response.status, body);
    if (specific) throw specific;
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      throw rateLimited(Number.isInteger(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 60);
    }
    if (response.status === 401 || response.status === 403) throw accessDenied();
    if (response.status === 400) throw requestRejected();
    throw providerUnavailable();
  }
  const bytes = await readCapped(options.maxBytes);
  try {
    return record(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw schemaInvalid();
  }
}
