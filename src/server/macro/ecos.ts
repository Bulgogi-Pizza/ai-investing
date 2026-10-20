import { ProviderError } from '../toss.js';
import { ecosIndicator, type EcosCycle, type EcosIndicator } from './catalog.js';
import {
  RateLimiter,
  SingleFlightCache,
  TtlCache,
  accessDenied,
  addDays,
  decimalOrNull,
  fetchProviderJson,
  isRealDate,
  providerUnavailable,
  rateLimited,
  record,
  requestRejected,
  schemaInvalid,
  text,
  tooLarge,
} from './shared.js';

// Official contract (checked 2026-10-21): https://ecos.bok.or.kr/api/ -> 개발가이드 -> 개발 명세서
// (StatisticSearch, StatisticItemList, KeyStatisticList). See docs/implementation/macro-data.md.
const base = 'https://ecos.bok.or.kr/api/';
export const ecosLimits = {
  timeoutMs: 20000,
  jsonBytes: 6 * 1024 * 1024,
  pageSize: 1000,
  maximumPages: 10,
  minimumIntervalMs: 300,
  seriesTtlMs: 10 * 60 * 1000,
};
// The key format is not specified in the guide. It goes into a URL path, so only path-safe
// characters are accepted.
const keyPattern = /^[0-9A-Za-z]{10,64}$/;

export interface EcosObservation {
  /** First calendar day of the period (daily: the day, monthly: day 1, quarterly: first month). */
  date: string;
  /** The raw TIME value (YYYYMMDD / YYYYMM / YYYYQn / YYYY). */
  period: string;
  value: string | null;
  unit: string | null;
}
export interface EcosLatest {
  id: string;
  asOf: string;
  latest: EcosObservation | null;
  previous: EcosObservation | null;
}

type ResultKind = 'no-data' | ProviderError;
/**
 * ECOS result codes (개발 명세서 "에러 및 정보배치"): 정보-100 invalid key, 정보-200 no data,
 * 에러-100 required value missing, 101 date format differs from cycle, 200 bad file type,
 * 300/301 bad row counts, 400 60 s timeout, 500 server error, 600/601 DB/SQL error, 602 call
 * limit. The page prints the Korean labels 정보/에러; the English INFO/ERROR forms are accepted too
 * because the machine-readable spelling is not shown in the guide. Provider text is never used.
 */
export function ecosResult(code: string): ResultKind {
  const match = /^(INFO|정보|ERROR|에러)-(\d{3})$/i.exec(code.trim());
  if (!match) return schemaInvalid();
  const info = /^(INFO|정보)$/i.test(match[1]);
  const number = match[2];
  if (info) {
    if (number === '100') return accessDenied();
    if (number === '200') return 'no-data';
    return schemaInvalid();
  }
  switch (number) {
    case '100':
    case '101':
    case '200':
    case '300':
    case '301':
      return requestRejected();
    case '400':
    case '500':
    case '600':
    case '601':
      return providerUnavailable();
    case '602':
      return rateLimited(60);
    default:
      return schemaInvalid();
  }
}

export function periodArgument(date: string, cycle: EcosCycle): string {
  const [year, month, day] = date.split('-');
  if (cycle === 'D') return `${year}${month}${day}`;
  if (cycle === 'M') return `${year}${month}`;
  if (cycle === 'Q') return `${year}Q${Math.floor((Number(month) - 1) / 3) + 1}`;
  return year;
}
export function periodStart(period: string, cycle: EcosCycle): string {
  let date: string | null = null;
  if (cycle === 'D' && /^\d{8}$/.test(period))
    date = `${period.slice(0, 4)}-${period.slice(4, 6)}-${period.slice(6, 8)}`;
  else if (cycle === 'M' && /^\d{6}$/.test(period))
    date = `${period.slice(0, 4)}-${period.slice(4, 6)}-01`;
  else if (cycle === 'Q' && /^\d{4}Q[1-4]$/.test(period))
    date = `${period.slice(0, 4)}-${String((Number(period[5]) - 1) * 3 + 1).padStart(2, '0')}-01`;
  else if (cycle === 'A' && /^\d{4}$/.test(period)) date = `${period}-01-01`;
  if (!date || !isRealDate(date)) throw schemaInvalid();
  return date;
}

export interface EcosOptions {
  apiKey: string;
  transport?: typeof fetch;
  now?: () => Date;
  limiter?: RateLimiter;
}

export class EcosAdapter {
  private apiKey: string;
  private transport: typeof fetch;
  private now: () => Date;
  private limiter: RateLimiter;
  private cooldownUntil = 0;
  private cache: SingleFlightCache<EcosObservation[]>;
  constructor(options: EcosOptions) {
    if (!keyPattern.test(options.apiKey)) throw new Error('Invalid ECOS configuration');
    this.apiKey = options.apiKey;
    this.transport = options.transport ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.limiter = options.limiter ?? new RateLimiter(ecosLimits.minimumIntervalMs);
    this.cache = new SingleFlightCache(
      new TtlCache(ecosLimits.seriesTtlMs, 100, () => this.now().getTime()),
    );
  }

  /** The key is part of the path. This URL must never be logged or put in an error. */
  private url(entry: EcosIndicator, from: number, to: number, start: string, end: string) {
    const segments = [
      'StatisticSearch',
      this.apiKey,
      'json',
      'kr',
      String(from),
      String(to),
      entry.statCode,
      entry.cycle,
      periodArgument(start, entry.cycle),
      periodArgument(end, entry.cycle),
      entry.itemCode,
    ];
    return `${base}${segments.map(encodeURIComponent).join('/')}/`;
  }

  private async page(
    entry: EcosIndicator,
    first: number,
    last: number,
    start: string,
    end: string,
  ) {
    if (this.cooldownUntil > Date.now())
      throw rateLimited(Math.ceil((this.cooldownUntil - Date.now()) / 1000));
    await this.limiter.wait();
    try {
      const body = await fetchProviderJson(
        this.transport,
        this.url(entry, first, last, start, end),
        {
          headers: { Accept: 'application/json' },
          timeoutMs: ecosLimits.timeoutMs,
          maxBytes: ecosLimits.jsonBytes,
        },
      );
      return parsePage(body, entry);
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'PROVIDER_RATE_LIMITED')
        this.cooldownUntil = Date.now() + (error.retryAfter ?? 60) * 1000;
      throw error;
    }
  }

  /** Observations of a catalog ECOS indicator between two ISO dates (inclusive periods). */
  async observations(id: string, range: { from: string; to: string }): Promise<EcosObservation[]> {
    const entry = ecosIndicator(id);
    if (!entry) throw new RangeError('indicator');
    if (!isRealDate(range.from) || !isRealDate(range.to) || range.from > range.to)
      throw new RangeError('range');
    const key = `${entry.id}:${range.from}:${range.to}`;
    return this.cache.get(key, async () => {
      const rows: EcosObservation[] = [];
      for (let pageIndex = 0; pageIndex < ecosLimits.maximumPages; pageIndex++) {
        const first = pageIndex * ecosLimits.pageSize + 1;
        const result = await this.page(
          entry,
          first,
          first + ecosLimits.pageSize - 1,
          range.from,
          range.to,
        );
        rows.push(...result.rows);
        if (rows.length >= result.total || result.rows.length === 0) return dedupe(rows);
        if (rows.length > ecosLimits.pageSize * ecosLimits.maximumPages) break;
      }
      throw tooLarge();
    });
  }

  /** Daily series (원/달러 매매기준율 etc.) for chart comparison. Rejects non-daily indicators. */
  async dailySeries(id: string, from: string, to: string): Promise<EcosObservation[]> {
    if (ecosIndicator(id)?.cycle !== 'D') throw new RangeError('indicator');
    return this.observations(id, { from, to });
  }

  /**
   * Latest and previous non-missing observation up to `asOf` (default: today, KST). ECOS exposes
   * no real-time vintages: for a past asOf this is only the current value of old periods, not what
   * was known then (publication lag and revisions are invisible), so it is for display, not for
   * point-in-time backtests.
   */
  async latestObservations(ids: string[], asOf?: string): Promise<EcosLatest[]> {
    const end = asOf ?? new Date(this.now().getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    if (!isRealDate(end)) throw new RangeError('asOf');
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 10) throw new RangeError('ids');
    const lookback: Record<EcosCycle, number> = { D: 45, M: 430, Q: 900, A: 2000 };
    const result: EcosLatest[] = [];
    for (const id of ids) {
      const entry = ecosIndicator(id);
      if (!entry) throw new RangeError('indicator');
      const rows = (
        await this.observations(id, { from: addDays(end, -lookback[entry.cycle]), to: end })
      )
        .filter((row) => row.value !== null && row.date <= end)
        .sort((a, b) => b.date.localeCompare(a.date));
      result.push({ id, asOf: end, latest: rows[0] ?? null, previous: rows[1] ?? null });
    }
    return result;
  }
}

function dedupe(rows: EcosObservation[]): EcosObservation[] {
  const byDate = new Map<string, EcosObservation>();
  for (const row of rows) byDate.set(row.date, row);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function parsePage(
  body: Record<string, unknown>,
  entry: EcosIndicator,
): { total: number; rows: EcosObservation[] } {
  if (body.RESULT !== undefined) {
    const code = text(record(body.RESULT).CODE, 40);
    const outcome = ecosResult(code);
    if (outcome === 'no-data') return { total: 0, rows: [] };
    throw outcome;
  }
  const service = record(body.StatisticSearch);
  const total = Number(service.list_total_count);
  if (!Number.isSafeInteger(total) || total < 0) throw schemaInvalid();
  const raw = service.row;
  if (total === 0 && raw === undefined) return { total: 0, rows: [] };
  if (!Array.isArray(raw) || raw.length > ecosLimits.pageSize) throw schemaInvalid();
  const rows = raw.map((item) => {
    const row = record(item);
    if (text(row.STAT_CODE, 20) !== entry.statCode || text(row.ITEM_CODE1, 40) !== entry.itemCode)
      throw schemaInvalid();
    const period = text(row.TIME, 13);
    return {
      date: periodStart(period, entry.cycle),
      period,
      value: decimalOrNull(row.DATA_VALUE),
      unit: typeof row.UNIT_NAME === 'string' && row.UNIT_NAME.length <= 200 ? row.UNIT_NAME : null,
    };
  });
  return { total, rows };
}

export function ecosFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<EcosOptions, 'apiKey'> = {},
): EcosAdapter | undefined {
  const apiKey = env.ECOS_API_KEY;
  if (!apiKey || !keyPattern.test(apiKey)) return undefined;
  return new EcosAdapter({ apiKey, ...options });
}
