import type { FinancialStatement } from '../../lib/valuation.js';
import { ProviderError } from '../toss.js';

export interface FundamentalsResult {
  market: 'KR' | 'US';
  symbol: string;
  name: string | null;
  source: 'DART' | 'SEC EDGAR';
  asOf: string;
  statements: FinancialStatement[];
  warnings: string[];
}

export const schemaInvalid = () =>
  new ProviderError(502, 'PROVIDER_SCHEMA_INVALID', '제공자 응답 형식을 확인하지 못했습니다.');
export const unreachable = () =>
  new ProviderError(503, 'PROVIDER_UNREACHABLE', '재무 제공자에 연결할 수 없습니다.');
export const rateLimited = (retryAfter: number) =>
  new ProviderError(
    503,
    'PROVIDER_RATE_LIMITED',
    '제공자 요청 한도로 잠시 대기해야 합니다.',
    retryAfter,
  );
export const accessDenied = () =>
  new ProviderError(503, 'PROVIDER_ACCESS_DENIED', '제공자 인증키·허용 IP·접근 정책을 확인하세요.');
export const providerUnavailable = () =>
  new ProviderError(503, 'PROVIDER_UNAVAILABLE', '재무 제공자 서비스를 사용할 수 없습니다.');
export const notFound = () =>
  new ProviderError(404, 'FUNDAMENTALS_NOT_FOUND', '이 종목의 재무 데이터를 찾지 못했습니다.');

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw schemaInvalid();
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 500): string {
  if (typeof value !== 'string' || value.length > max) throw schemaInvalid();
  return value;
}
export function isoDateOnly(value: unknown): string {
  const result = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(result)))
    throw schemaInvalid();
  return result;
}

/** Decimal-string convention of toss.ts: optional minus, digits, optional fraction. No exponent. */
export function decimalFromNumber(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw schemaInvalid();
  const result = String(value);
  if (!/^-?\d+(\.\d+)?$/.test(result)) throw schemaInvalid();
  return result;
}

export class RateLimiter {
  private next = 0;
  constructor(
    private intervalMs: number,
    private sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private clock: () => number = Date.now,
    private maximumQueueMs = 60000,
  ) {}
  async wait() {
    if (this.intervalMs <= 0) return;
    const start = Math.max(this.clock(), this.next);
    if (start - this.clock() > this.maximumQueueMs)
      throw new ProviderError(
        503,
        'PROVIDER_BUSY',
        '조회 요청이 많습니다. 잠시 후 시도하세요.',
        30,
      );
    this.next = start + this.intervalMs;
    const delay = start - this.clock();
    if (delay > 0) await this.sleep(delay);
  }
}

export class TtlCache<T> {
  private values = new Map<string, { expiresAt: number; value: T }>();
  constructor(
    private ttlMs: number,
    private maximumEntries: number,
    private clock: () => number,
  ) {}
  get(key: string): T | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock()) {
      this.values.delete(key);
      return undefined;
    }
    return entry.value;
  }
  set(key: string, value: T) {
    this.values.delete(key);
    if (this.values.size >= this.maximumEntries)
      this.values.delete(this.values.keys().next().value!);
    this.values.set(key, { expiresAt: this.clock() + this.ttlMs, value });
  }
}

/** Cache with singleflight: concurrent loads of one key share a single provider call. */
export class SingleFlightCache<T> {
  private flights = new Map<string, Promise<T>>();
  constructor(private cache: TtlCache<T>) {}
  async get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let pending = this.flights.get(key);
    if (!pending) {
      pending = load()
        .then((value) => {
          this.cache.set(key, value);
          return value;
        })
        .finally(() => this.flights.delete(key));
      this.flights.set(key, pending);
    }
    return pending;
  }
}

export interface FetchOptions {
  headers: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
}

/** Fixed-host GET with redirect refusal, timeout and a hard byte cap on the decoded stream. */
export async function fetchBytes(
  transport: typeof fetch,
  url: string,
  options: FetchOptions,
): Promise<Buffer> {
  let response: Response;
  try {
    response = await transport(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: options.headers,
    });
  } catch {
    // The raw error may carry the request URL (with the API key). Never forward it.
    throw unreachable();
  }
  if (!response.ok || response.redirected || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      throw rateLimited(Number.isInteger(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 60);
    }
    if (response.status === 401 || response.status === 403) throw accessDenied();
    if (response.status === 404) throw notFound();
    throw providerUnavailable();
  }
  const tooLarge = () =>
    new ProviderError(502, 'PROVIDER_RESPONSE_TOO_LARGE', '제공자 응답이 허용 크기를 넘었습니다.');
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > options.maxBytes)) {
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
      if (length > options.maxBytes) {
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
}

export async function fetchJson(
  transport: typeof fetch,
  url: string,
  options: FetchOptions,
): Promise<Record<string, unknown>> {
  const bytes = await fetchBytes(transport, url, options);
  try {
    return record(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw schemaInvalid();
  }
}

/** KST calendar date (YYYY-MM-DD) of an instant. */
export function kstDate(date: Date): string {
  return new Date(date.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
