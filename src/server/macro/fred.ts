import { ProviderError } from '../toss.js';
import { fredIndicator, indicatorsByRelease, type FredIndicator } from './catalog.js';
import {
  RateLimiter,
  SingleFlightCache,
  TtlCache,
  accessDenied,
  dayDifference,
  decimalOrNull,
  fetchProviderJson,
  isRealDate,
  rateLimited,
  record,
  requireDate,
  schemaInvalid,
  text,
} from './shared.js';

// Official contract (checked 2026-10-21): https://fred.stlouisfed.org/docs/api/fred/
// series_observations.html, release_dates.html, series_release.html, errors.html,
// realtime_period.html. See docs/implementation/macro-data.md.
const base = 'https://api.stlouisfed.org/fred/';
export const fredLimits = {
  timeoutMs: 15000,
  jsonBytes: 8 * 1024 * 1024,
  // Documented limit: 120 requests/minute. We stay well below it.
  minimumIntervalMs: 600,
  observationsTtlMs: 5 * 60 * 1000,
  releasesTtlMs: 60 * 60 * 1000,
  maximumReleaseWindowDays: 120,
  documentedObservationLimit: 100000,
  documentedReleaseDatesLimit: 10000,
};
const keyPattern = /^[a-z0-9]{32}$/; // documented: 32-character lowercase alphanumeric string

export interface Observation {
  date: string;
  /** Decimal string; null for FRED's missing marker. */
  value: string | null;
}
export interface VintageObservation extends Observation {
  realtimeStart: string;
  realtimeEnd: string;
}
export interface LatestObservation {
  id: string;
  asOf: string;
  latest: Observation | null;
  previous: Observation | null;
}
export interface ReleaseDate {
  releaseId: number;
  date: string;
  indicatorIds: string[];
}
export interface CatalogMismatch {
  indicatorId: string;
  expectedReleaseId: number;
  actualReleaseIds: number[];
}

/** FRED error body: { error_code, error_message }. Only the key-related case is told apart. */
function classify(status: number, body: unknown): ProviderError | undefined {
  if (status === 400 && body && typeof body === 'object') {
    const message = (body as Record<string, unknown>).error_message;
    // The message itself is never forwarded; it only distinguishes a bad key from a bad request.
    if (typeof message === 'string' && /api_key/i.test(message)) return accessDenied();
  }
  return undefined;
}

export interface FredOptions {
  apiKey: string;
  transport?: typeof fetch;
  now?: () => Date;
  limiter?: RateLimiter;
}

export class FredAdapter {
  private apiKey: string;
  private transport: typeof fetch;
  private now: () => Date;
  private limiter: RateLimiter;
  private cooldownUntil = 0;
  private observationsCache: SingleFlightCache<VintageObservation[]>;
  private releasesCache: SingleFlightCache<string[]>;
  constructor(options: FredOptions) {
    if (!keyPattern.test(options.apiKey)) throw new Error('Invalid FRED configuration');
    this.apiKey = options.apiKey;
    this.transport = options.transport ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.limiter = options.limiter ?? new RateLimiter(fredLimits.minimumIntervalMs);
    const clock = () => this.now().getTime();
    this.observationsCache = new SingleFlightCache(
      new TtlCache(fredLimits.observationsTtlMs, 200, clock),
    );
    this.releasesCache = new SingleFlightCache(new TtlCache(fredLimits.releasesTtlMs, 50, clock));
  }

  private url(endpoint: string, params: Record<string, string>) {
    const url = new URL(endpoint, base);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('file_type', 'json');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }
  private async call(endpoint: string, params: Record<string, string>) {
    if (this.cooldownUntil > Date.now())
      throw rateLimited(Math.ceil((this.cooldownUntil - Date.now()) / 1000));
    await this.limiter.wait();
    try {
      return await fetchProviderJson(
        this.transport,
        this.url(endpoint, params),
        {
          headers: { Accept: 'application/json' },
          timeoutMs: fredLimits.timeoutMs,
          maxBytes: fredLimits.jsonBytes,
        },
        classify,
      );
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'PROVIDER_RATE_LIMITED')
        this.cooldownUntil = Date.now() + (error.retryAfter ?? 60) * 1000;
      throw error;
    }
  }
  /**
   * FRED's "today" for real-time parameters. FRED rejects realtime_start/realtime_end after its own
   * current date (observed 2026-10-21: "can not be after today's date (2026-10-20)" while it was
   * already 10-21 in Korea and UTC), which follows US Central time.
   */
  private today() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(this.now());
  }
  /** A requested vintage date, never later than FRED's today. */
  private realtimeDate(date: string) {
    const today = this.today();
    return date > today ? today : date;
  }

  private async fetchObservations(
    entry: FredIndicator,
    params: Record<string, string>,
  ): Promise<VintageObservation[]> {
    const key = `${entry.seriesId}?${new URLSearchParams(params).toString()}`;
    return this.observationsCache.get(key, async () => {
      const body = await this.call('series/observations', {
        series_id: entry.seriesId,
        ...params,
      });
      return parseObservations(body);
    });
  }

  /**
   * Observations as FRED serves them today (current vintage). Values may have been revised since
   * first release, so this is NOT look-ahead safe for historical decisions: use
   * observationsKnownAt for that.
   */
  async observations(
    id: string,
    range: { from?: string; to?: string } = {},
  ): Promise<Observation[]> {
    const entry = this.requireEntry(id);
    const params: Record<string, string> = {
      realtime_start: this.today(),
      realtime_end: this.today(),
      sort_order: 'asc',
      limit: String(fredLimits.documentedObservationLimit),
    };
    if (range.from !== undefined) params.observation_start = checkDate(range.from);
    if (range.to !== undefined) params.observation_end = checkDate(range.to);
    const rows = await this.fetchObservations(entry, params);
    return rows.map(({ date, value }) => ({ date, value }));
  }

  /**
   * Look-ahead safe read: the series as it was known on `date`, using FRED real-time periods
   * (realtime_start = realtime_end = date). Rows whose real-time period does not contain `date`
   * and observations dated after `date` are dropped even if the API returned them. Limits: the
   * vintage is the date FRED stored the value, which can trail the source's own publication by a
   * day or more, and revisions that FRED never stored as vintages are invisible. See
   * docs/implementation/macro-data.md.
   */
  async observationsKnownAt(
    id: string,
    date: string,
    range: { from?: string } = {},
  ): Promise<VintageObservation[]> {
    const entry = this.requireEntry(id);
    // Vintage as of the requested date, but never later than FRED's own today.
    const vintage = this.realtimeDate(checkDate(date));
    const params: Record<string, string> = {
      realtime_start: vintage,
      realtime_end: vintage,
      observation_end: date,
      sort_order: 'asc',
      limit: String(fredLimits.documentedObservationLimit),
    };
    if (range.from !== undefined) params.observation_start = checkDate(range.from);
    const rows = await this.fetchObservations(entry, params);
    return rows.filter(
      (row) => row.realtimeStart <= vintage && row.realtimeEnd >= vintage && row.date <= date,
    );
  }

  /** Latest and previous non-missing observation known on `asOf` for each catalog FRED id. */
  async latestObservations(ids: string[], asOf: string): Promise<LatestObservation[]> {
    checkDate(asOf);
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20) throw new RangeError('ids');
    const result: LatestObservation[] = [];
    for (const id of ids) {
      const entry = this.requireEntry(id);
      const vintage = this.realtimeDate(asOf);
      const rows = await this.fetchObservations(entry, {
        realtime_start: vintage,
        realtime_end: vintage,
        observation_end: asOf,
        sort_order: 'desc',
        limit: '24',
      });
      const known = rows
        .filter(
          (row) => row.realtimeStart <= vintage && row.realtimeEnd >= vintage && row.date <= asOf,
        )
        .filter((row) => row.value !== null)
        // Do not rely on the API's order; newest observation first, newest vintage on ties.
        .sort(
          (a, b) => b.date.localeCompare(a.date) || b.realtimeStart.localeCompare(a.realtimeStart),
        );
      const plain = ({ date, value }: VintageObservation): Observation => ({ date, value });
      result.push({
        id,
        asOf,
        latest: known[0] ? plain(known[0]) : null,
        previous: known[1] ? plain(known[1]) : null,
      });
    }
    return result;
  }

  /**
   * Release dates of the catalog's FRED releases inside [from, to] (at most 120 days). Uses
   * include_release_dates_with_no_data=true because by default FRED drops future dates. FRED
   * documents that these dates "do not necessarily represent when data will be available".
   */
  async upcomingReleases(from: string, to: string): Promise<ReleaseDate[]> {
    checkDate(from);
    checkDate(to);
    if (from > to || dayDifference(from, to) > fredLimits.maximumReleaseWindowDays)
      throw new RangeError('window');
    const releases: ReleaseDate[] = [];
    for (const [releaseId, entries] of indicatorsByRelease()) {
      const key = `${releaseId}:${from}:${to}`;
      const dates = await this.releasesCache.get(key, async () => {
        const body = await this.call('release/dates', {
          release_id: String(releaseId),
          realtime_start: from,
          realtime_end: to,
          include_release_dates_with_no_data: 'true',
          sort_order: 'asc',
          limit: String(fredLimits.documentedReleaseDatesLimit),
        });
        return parseReleaseDates(body, releaseId);
      });
      for (const date of dates)
        if (date >= from && date <= to)
          releases.push({ releaseId, date, indicatorIds: entries.map((entry) => entry.id) });
    }
    return releases.sort((a, b) => a.date.localeCompare(b.date) || a.releaseId - b.releaseId);
  }

  /**
   * First-real-call check: asks fred/series/release for every catalog series and reports entries
   * whose release id differs from the catalog. Run once after a key exists; never part of a
   * request path.
   */
  async verifyCatalog(entries?: FredIndicator[]): Promise<CatalogMismatch[]> {
    const targets = entries ?? [...indicatorsByRelease().values()].flat();
    const mismatches: CatalogMismatch[] = [];
    for (const entry of targets) {
      const body = await this.call('series/release', { series_id: entry.seriesId });
      const ids = parseSeriesRelease(body);
      if (!ids.includes(entry.releaseId))
        mismatches.push({
          indicatorId: entry.id,
          expectedReleaseId: entry.releaseId,
          actualReleaseIds: ids,
        });
    }
    return mismatches;
  }

  private requireEntry(id: string): FredIndicator {
    const entry = fredIndicator(id);
    if (!entry) throw new RangeError('indicator');
    return entry;
  }
}

function checkDate(value: string): string {
  if (!isRealDate(value)) throw new RangeError('date');
  return value;
}

export function parseObservations(body: Record<string, unknown>): VintageObservation[] {
  const rows = body.observations;
  if (!Array.isArray(rows) || rows.length > fredLimits.documentedObservationLimit)
    throw schemaInvalid();
  return rows.map((raw) => {
    const row = record(raw);
    return {
      date: requireDate(row.date),
      value: decimalOrNull(text(row.value, 40)),
      realtimeStart: requireDate(row.realtime_start),
      realtimeEnd: requireDate(row.realtime_end),
    };
  });
}
export function parseReleaseDates(body: Record<string, unknown>, releaseId: number): string[] {
  const rows = body.release_dates;
  if (!Array.isArray(rows) || rows.length > fredLimits.documentedReleaseDatesLimit)
    throw schemaInvalid();
  const dates = new Set<string>();
  for (const raw of rows) {
    const row = record(raw);
    if (row.release_id !== releaseId) throw schemaInvalid();
    dates.add(requireDate(row.date));
  }
  return [...dates].sort();
}
export function parseSeriesRelease(body: Record<string, unknown>): number[] {
  const rows = body.releases;
  if (!Array.isArray(rows) || rows.length > 50) throw schemaInvalid();
  return rows.map((raw) => {
    const id = record(raw).id;
    if (!Number.isSafeInteger(id)) throw schemaInvalid();
    return id as number;
  });
}

export function fredFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<FredOptions, 'apiKey'> = {},
): FredAdapter | undefined {
  const apiKey = env.FRED_API_KEY;
  if (!apiKey || !keyPattern.test(apiKey)) return undefined;
  return new FredAdapter({ apiKey, ...options });
}
