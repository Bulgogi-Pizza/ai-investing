import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  EVENT_WINDOW_MAX_DAYS,
  byImportance,
  type ChartEvent,
  type EventKind,
  type EventMarket,
} from '../lib/chartEvents.js';
import { cleanFills, NoAlgorithmFills, type AlgorithmFillSource } from './algorithm-fills.js';
import { cleanEvent, type CalendarRepository, type EconomicEvent } from './calendar.js';
import type { DartAdapter } from './fundamentals/dart.js';
import { normalizeUsSymbol, type SecAdapter } from './fundamentals/sec.js';
import type { FredAdapter } from './macro/fred.js';
import { releaseCatalog } from './macro/catalog.js';
import { addDays, dayDifference, isRealDate } from './macro/shared.js';
import { ownerGate } from './owner.js';
import { ProviderError } from './toss.js';

const events = '/api/analysis/events';
const fills = '/api/analysis/algorithm-fills';
/** Most events returned for one chart window. */
export const MAX_EVENTS = 300;
/** FRED release dates are read in windows of at most this many days (adapter limit). */
const FRED_CHUNK_DAYS = 120;
const cacheTtlMs = 5 * 60 * 1000;

export const eventsNotice =
  '등록 일정·FRED 발표일·DART 공시·SEC 공시를 합친 값입니다. 날짜는 국내 이벤트가 KST, 미국 이벤트가 미국 현지(동부) 날짜이며, 휴장일 이벤트는 다음 거래일 위치에 그립니다. 미국 실적 발표 예정일은 무료 공식 출처가 없어 발표 후 공시 날짜만 있습니다. 중요도는 이 프로젝트의 판단 기준입니다.';

export type SourceStatus = 'ok' | 'unavailable' | 'error' | 'no-data' | 'not-applicable';
export interface SourceReport {
  id: 'calendar' | 'fred' | 'dart' | 'sec';
  name: string;
  status: SourceStatus;
  count: number;
  asOf: string | null;
  code?: string;
  message?: string;
  retryAfter?: number;
}

export interface EventsRouterOptions {
  calendar: CalendarRepository;
  fred?: Pick<FredAdapter, 'upcomingReleases'>;
  dart?: Partial<Pick<DartAdapter, 'disclosures'>>;
  sec?: Partial<Pick<SecAdapter, 'filings'>>;
  /** Algorithm fills for the chart markers; defaults to "not connected" until stage 7c. */
  fills?: AlgorithmFillSource;
  ownerUserId?: string;
  now?: () => Date;
}

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });

/** US Eastern calendar date of a KST wall-clock date and time (the calendar stores KST). */
export function kstToUsDate(date: string, time: string): string | null {
  const instant = Date.parse(`${date}T${time}:00+09:00`);
  if (!Number.isFinite(instant)) return null;
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
}

const hangul = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const rateDecision = /금리 결정|기준금리|FOMC|정책금리/;

/** Registered calendar entries -> chart events (rules in docs/implementation/charts.md). */
export function calendarToEvents(
  records: EconomicEvent[],
  requestedMarket: EventMarket,
  from: string,
  to: string,
): ChartEvent[] {
  const result: ChartEvent[] = [];
  for (const event of records) {
    // Press-release items carry their publication time, not a scheduled release.
    if (event.eventKind === 'news-release') continue;
    const market: EventMarket =
      event.country === '한국' ? 'KR' : event.country === '미국' ? 'US' : requestedMarket;
    const date = market === 'KR' ? event.date : kstToUsDate(event.date, event.time);
    if (!date || date < from || date > to) continue;
    const text = `${event.category} ${event.title}`;
    const kind: EventKind = /실적|earnings/i.test(text)
      ? 'earnings'
      : rateDecision.test(text)
        ? 'rate-decision'
        : 'economic-indicator';
    result.push({
      id: `calendar-${event.id}`,
      date,
      title: event.title,
      titleLanguage: hangul.test(event.title) ? 'ko' : 'original',
      kind,
      importance: event.importance,
      market,
      source: event.sourceName,
      url: event.sourceUrl,
      origin: 'calendar',
    });
  }
  return result;
}

const releaseEntries = () => new Map(releaseCatalog().map((entry) => [entry.releaseId, entry]));

/** FRED release dates -> chart events. FRED dates are calendar dates of the US release. */
export async function fredEvents(
  fred: Pick<FredAdapter, 'upcomingReleases'>,
  from: string,
  to: string,
): Promise<ChartEvent[]> {
  const catalog = releaseEntries();
  const result: ChartEvent[] = [];
  let start = from;
  while (start <= to) {
    const end = addDays(start, FRED_CHUNK_DAYS) < to ? addDays(start, FRED_CHUNK_DAYS) : to;
    for (const release of await fred.upcomingReleases(start, end)) {
      const entry = catalog.get(release.releaseId);
      if (!entry) continue;
      result.push({
        id: `fred-${release.releaseId}-${release.date}`,
        date: release.date,
        title: entry.titleKo,
        titleLanguage: 'ko',
        kind: entry.category === '금리 결정' ? 'rate-decision' : 'economic-indicator',
        importance: entry.importance,
        market: 'US',
        source: 'FRED',
        url: entry.sourceUrl,
        origin: 'fred',
      });
    }
    start = addDays(end, 1);
  }
  return result;
}

function report(
  id: SourceReport['id'],
  name: string,
  status: SourceStatus,
  count: number,
  asOf: string | null,
  extra: Partial<SourceReport> = {},
): SourceReport {
  return { id, name, status, count, asOf, ...extra };
}
function failureReport(
  id: SourceReport['id'],
  name: string,
  caught: unknown,
  unavailableCode?: string,
): SourceReport {
  if (caught instanceof ProviderError) {
    if (caught.code === unavailableCode)
      return report(id, name, 'unavailable', 0, null, {
        code: caught.code,
        message: caught.message,
      });
    if (caught.code === 'FUNDAMENTALS_NOT_FOUND')
      return report(id, name, 'no-data', 0, null, { code: caught.code, message: caught.message });
    return report(id, name, 'error', 0, null, {
      code: caught.code,
      message: caught.message,
      ...(caught.retryAfter ? { retryAfter: caught.retryAfter } : {}),
    });
  }
  return report(id, name, 'error', 0, null, {
    code: 'EVENTS_SOURCE_FAILED',
    message: `${name}에서 이벤트를 가져오지 못했습니다.`,
  });
}

function parseEventsQuery(req: Request) {
  const query = req.query;
  const allowed = ['market', 'symbol', 'from', 'to'];
  if (
    Object.keys(query).length !== allowed.length ||
    !allowed.every((key) => typeof query[key] === 'string')
  )
    return null;
  const { market, symbol, from, to } = query as Record<string, string>;
  if (market !== 'KR' && market !== 'US') return null;
  const normalized =
    market === 'KR'
      ? /^[0-9A-Za-z]{6}$/.test(symbol)
        ? symbol.toUpperCase()
        : null
      : normalizeUsSymbol(symbol);
  if (
    !normalized ||
    !isRealDate(from) ||
    !isRealDate(to) ||
    from > to ||
    dayDifference(from, to) > EVENT_WINDOW_MAX_DAYS
  )
    return null;
  return { market: market as EventMarket, symbol: normalized, from, to };
}

type Cached = { expiresAt: number; body: Record<string, unknown> };

/**
 * Owner-only reads for the chart's event lines and algorithm-fill markers. Mounted before the
 * Toss-backed analysis router (it needs the owner id, not the Toss client). Order: authentication,
 * owner, rate limit, input validation, then the sources in parallel. One failing source never
 * fails the response: it is reported in `sources` and the others are still returned.
 */
export function createAnalysisEventsRouter({
  calendar,
  fred,
  dart,
  sec,
  fills: fillSource = new NoAlgorithmFills(),
  ownerUserId,
  now = () => new Date(),
}: EventsRouterOptions) {
  const router = Router();
  const cache = new Map<string, Cached>();
  router.use([events, fills], (_req, res, next) => {
    if (!res.locals.user || res.locals.user.active === false) {
      fail(res, 401, 'AUTH_REQUIRED', '로그인이 필요합니다.');
      return;
    }
    next();
  });
  router.use([events, fills], ownerGate(ownerUserId));
  router.use(
    [events, fills],
    rateLimit({
      windowMs: 60 * 1000,
      limit: 60,
      keyGenerator: (_req, res) => res.locals.user.id,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
  );

  router.get(events, async (req, res) => {
    const query = parseEventsQuery(req);
    if (!query) {
      fail(
        res,
        400,
        'INVALID_EVENTS_QUERY',
        `market(KR|US), 종목 코드, 날짜 범위(최대 ${EVENT_WINDOW_MAX_DAYS}일)를 확인하세요.`,
      );
      return;
    }
    const { market, symbol, from, to } = query;
    const key = `${market}:${symbol}:${from}:${to}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now().getTime()) {
      res.json(hit.body);
      return;
    }
    const readDart = dart?.disclosures?.bind(dart);
    const readSec = sec?.filings?.bind(sec);
    const started = now();
    const asOf = started.toISOString();
    const sources: SourceReport[] = [];
    const collected: ChartEvent[] = [];
    const run = async (
      id: SourceReport['id'],
      name: string,
      load: () => Promise<{
        items: ChartEvent[];
        asOf?: string;
        note?: string;
        incomplete?: boolean;
      }>,
      unavailableCode?: string,
    ) => {
      try {
        const loaded = await load();
        collected.push(...loaded.items);
        sources.push(
          report(id, name, 'ok', loaded.items.length, loaded.asOf ?? asOf, {
            ...(loaded.note ? { message: loaded.note } : {}),
            ...(loaded.incomplete ? { code: 'INCOMPLETE' } : {}),
          }),
        );
      } catch (caught) {
        sources.push(failureReport(id, name, caught, unavailableCode));
      }
    };
    const unavailable = (id: SourceReport['id'], name: string, code: string, message: string) =>
      sources.push(report(id, name, 'unavailable', 0, null, { code, message }));
    const notApplicable = (id: SourceReport['id'], name: string, message: string) =>
      sources.push(report(id, name, 'not-applicable', 0, null, { message }));

    await Promise.all([
      run('calendar', '등록 일정', async () => {
        // One day of slack on both sides: the calendar stores KST, US events convert to US dates.
        const records = await calendar.list(addDays(from, -1), addDays(to, 1));
        const clean = records
          .map(cleanEvent)
          .filter((event): event is EconomicEvent => event !== null);
        return { items: calendarToEvents(clean, market, from, to) };
      }),
      fred
        ? run('fred', 'FRED 발표 일정(미국)', async () => ({
            items: await fredEvents(fred, from, to),
          }))
        : Promise.resolve(
            unavailable(
              'fred',
              'FRED 발표 일정(미국)',
              'FRED_UNAVAILABLE',
              '미국 경제지표(FRED)가 설정되지 않았습니다.',
            ),
          ),
      market === 'KR'
        ? readDart
          ? run(
              'dart',
              'DART 공시(국내)',
              async () => {
                const result = await readDart(symbol, from, to);
                return {
                  items: result.filings.map((filing): ChartEvent => ({
                    id: `dart-${filing.key}`,
                    date: filing.date,
                    title: filing.title,
                    titleLanguage: filing.titleLanguage,
                    kind: filing.kind,
                    importance: filing.importance,
                    market: 'KR',
                    source: 'DART 전자공시',
                    url: filing.url,
                    origin: 'dart',
                  })),
                  asOf: result.asOf,
                  incomplete: result.truncated,
                  note: result.truncated
                    ? '공시가 많아 일부만 읽었습니다(분류별 최대 300건).'
                    : undefined,
                };
              },
              'DART_UNAVAILABLE',
            )
          : Promise.resolve(
              unavailable(
                'dart',
                'DART 공시(국내)',
                'DART_UNAVAILABLE',
                '국내 공시(DART)가 설정되지 않았습니다.',
              ),
            )
        : Promise.resolve(notApplicable('dart', 'DART 공시(국내)', '국내 종목에서만 조회합니다.')),
      market === 'US'
        ? readSec
          ? run(
              'sec',
              'SEC 공시(미국)',
              async () => {
                const result = await readSec(symbol, from, to);
                return {
                  items: result.filings.map((filing): ChartEvent => ({
                    id: `sec-${filing.key}`,
                    date: filing.date,
                    title: filing.title,
                    titleLanguage: filing.titleLanguage,
                    kind: filing.kind,
                    importance: filing.importance,
                    market: 'US',
                    source: 'SEC EDGAR',
                    url: filing.url,
                    origin: 'sec',
                  })),
                  asOf: result.asOf,
                  incomplete: result.incomplete,
                  note: result.incomplete
                    ? `SEC 최근 공시 목록은 ${result.oldestCovered}부터라 그 이전은 포함하지 못했습니다.`
                    : undefined,
                };
              },
              'SEC_UNAVAILABLE',
            )
          : Promise.resolve(
              unavailable(
                'sec',
                'SEC 공시(미국)',
                'SEC_UNAVAILABLE',
                '미국 공시(SEC EDGAR)가 설정되지 않았습니다.',
              ),
            )
        : Promise.resolve(notApplicable('sec', 'SEC 공시(미국)', '미국 종목에서만 조회합니다.')),
    ]);

    // A registered calendar event wins over the FRED release of the same kind, market and date.
    const registered = new Set(
      collected
        .filter((event) => event.origin === 'calendar')
        .map((event) => `${event.market}|${event.date}|${event.kind}`),
    );
    const merged = collected
      .filter(
        (event) =>
          event.origin !== 'fred' || !registered.has(`${event.market}|${event.date}|${event.kind}`),
      )
      .sort(
        (a, b) => a.date.localeCompare(b.date) || byImportance(a, b) || a.id.localeCompare(b.id),
      );
    for (const item of sources) {
      if (item.status === 'ok') item.count = merged.filter((e) => e.origin === item.id).length;
    }
    const order = ['calendar', 'fred', 'dart', 'sec'];
    sources.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    const body = {
      asOf,
      market,
      symbol,
      from,
      to,
      windowDays: dayDifference(from, to) + 1,
      events: merged.slice(0, MAX_EVENTS),
      truncated: merged.length > MAX_EVENTS,
      limit: MAX_EVENTS,
      sources,
      notice: eventsNotice,
    };
    // Only complete answers are reused; a failed source is retried on the next request.
    if (sources.every((item) => item.status !== 'error'))
      cache.set(key, { expiresAt: started.getTime() + cacheTtlMs, body });
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    res.json(body);
  });

  router.get(fills, async (req, res) => {
    const query = req.query;
    const allowed = ['symbol', 'from', 'to'];
    const { symbol, from, to } = query as Record<string, unknown>;
    if (
      Object.keys(query).length !== allowed.length ||
      !allowed.every((key) => typeof query[key] === 'string') ||
      !/^[A-Za-z0-9.\-]{1,30}$/.test(symbol as string) ||
      !isRealDate(from) ||
      !isRealDate(to) ||
      from > to ||
      dayDifference(from, to) > 3660
    ) {
      fail(res, 400, 'INVALID_FILLS_QUERY', '종목 코드와 날짜 범위를 확인하세요.');
      return;
    }
    try {
      const rows = cleanFills(
        await fillSource.listFills(symbol as string, from, to),
        symbol as string,
        from,
        to,
      );
      res.json({
        asOf: now().toISOString(),
        symbol,
        from,
        to,
        connected: fillSource.connected,
        fills: rows,
        notice: fillSource.connected
          ? '알고리즘 체결 기록입니다. 가상은 모의 운용의 가상 체결, 실제는 실전 주문 체결입니다.'
          : '알고리즘 체결 기록 저장소(모의 운용)가 아직 연결되지 않아 표시할 체결이 없습니다.',
      });
    } catch {
      fail(res, 500, 'FILLS_FAILED', '알고리즘 체결 기록을 가져오지 못했습니다.');
    }
  });
  return router;
}
