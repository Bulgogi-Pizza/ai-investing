import { createHash } from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { cleanTitle } from './calendar-clean.js';
import { cleanEvent, type CalendarRepository, type EconomicEvent } from './calendar.js';
import { ownerGate } from './owner.js';

export const officialNewsSources = [
  {
    id: 'fed-press',
    name: '미 연준 공식 보도자료',
    feedUrl: 'https://www.federalreserve.gov/feeds/press_all.xml',
    country: '미국' as const,
    coverage:
      '연준 최근 보도자료의 제목·원문 링크·게시시각. 전체 미국 금융 뉴스나 미래 발표 일정이 아닙니다.',
  },
  {
    id: 'bok-press',
    name: '한국은행 공식 보도자료',
    feedUrl: 'https://www.bok.or.kr/portal/bbs/B0000552/news.rss?menuNo=200690',
    country: '한국' as const,
    coverage:
      '한국은행 전체 보도자료 RSS의 최근 항목. 전체 국내 금융 뉴스나 미래 발표 일정이 아닙니다.',
  },
] as const;
type NewsSource = (typeof officialNewsSources)[number];
const maximumBytes = 2 * 1024 * 1024;
const cacheLifetime = 15 * 60 * 1000;
export const newsCoverageWarning =
  '공식 기관 2곳의 최근 보도자료만 포함합니다. 제목 기반 중요도·분류·영향자산은 낮은 확신의 규칙 추정이며 실제 가격 영향이나 예정 발표 시각이 아닙니다.';
export interface NewsCacheEntry {
  expiresAt: number;
  events: EconomicEvent[];
  warnings: string[];
}
export type NewsCache = Map<string, NewsCacheEntry>;
const sharedCache: NewsCache = new Map();
const flightsByCache = new WeakMap<NewsCache, Map<string, Promise<NewsCacheEntry>>>();
export interface NewsSyncOptions {
  sourceIds?: string[];
  transport?: typeof fetch;
  now?: () => Date;
  cache?: NewsCache;
  authorId?: string;
}
export interface NewsSyncResult {
  count: number;
  sources: { id: string; name: string; status: 'synced' | 'cached' | 'failed'; count: number }[];
  warnings: string[];
}
function selectedSources(sourceIds: unknown): NewsSource[] {
  if (sourceIds === undefined) return [...officialNewsSources];
  if (
    !Array.isArray(sourceIds) ||
    sourceIds.length < 1 ||
    sourceIds.length > officialNewsSources.length ||
    new Set(sourceIds).size !== sourceIds.length ||
    sourceIds.some(
      (id) => typeof id !== 'string' || !officialNewsSources.some((source) => source.id === id),
    )
  )
    throw new Error('INVALID_NEWS_SOURCES');
  return officialNewsSources.filter((source) => sourceIds.includes(source.id));
}
function stableEventId(sourceId: string, link: string) {
  // 52 bits: positive safe integer; source namespace avoids cross-feed ID collisions.
  return (
    Number.parseInt(
      createHash('sha256').update(`${sourceId}\n${link}`).digest('hex').slice(0, 13),
      16,
    ) || 1
  );
}
function classify(title: string, source: NewsSource) {
  const monetary =
    /interest rate|federal funds|monetary|fomc|discount rate|통화정책|기준금리|금융통화|금통위/i.test(
      title,
    );
  const inflation = /inflation|consumer price|물가|소비자물가/i.test(title);
  const exchange = /exchange|foreign currency|외환|환율/i.test(title);
  return {
    importance: monetary || inflation ? (3 as const) : exchange ? (2 as const) : (1 as const),
    category: `공식 보도자료·${monetary ? '통화정책' : inflation ? '물가' : exchange ? '외환' : '기관발표'}`,
    assets:
      monetary || inflation
        ? ['금리', '채권', source.country === '한국' ? '원화' : '달러']
        : exchange
          ? ['원화', '달러']
          : ['시장전반'],
  };
}
export function parseOfficialFeed(
  xml: string,
  source: NewsSource,
  fetchedAt: Date,
): { events: EconomicEvent[]; warnings: string[] } {
  if (Buffer.byteLength(xml, 'utf8') > maximumBytes || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml))
    throw new Error('UNSAFE_NEWS_XML');
  if (XMLValidator.validate(xml) !== true) throw new Error('INVALID_NEWS_XML');
  const document = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: true,
    isArray: (name) => name === 'item',
  }).parse(xml);
  const items = document?.rss?.channel?.item;
  if (!Array.isArray(items)) throw new Error('INVALID_NEWS_FEED');
  const events = new Map<number, EconomicEvent>();
  let skipped = 0;
  for (const item of items.slice(0, 100)) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.title !== 'string' ||
      typeof item.link !== 'string' ||
      typeof item.pubDate !== 'string' ||
      item.pubDate.length > 100 ||
      !/(?:\bGMT\b|\bUTC\b|[+-]\d{4}|Z\s*$)/i.test(item.pubDate)
    ) {
      skipped++;
      continue;
    }
    let link: URL;
    try {
      link = new URL(item.link);
    } catch {
      skipped++;
      continue;
    }
    const feedHost = new URL(source.feedUrl).hostname;
    if (
      link.protocol !== 'https:' ||
      link.hostname !== feedHost ||
      link.username ||
      link.password ||
      link.port ||
      link.hash
    ) {
      skipped++;
      continue;
    }
    const published = Date.parse(item.pubDate);
    if (
      !Number.isFinite(published) ||
      published < Date.UTC(1900, 0, 1) ||
      published > fetchedAt.getTime() + 5 * 60 * 1000
    ) {
      skipped++;
      continue;
    }
    const local = new Date(published + 9 * 60 * 60 * 1000).toISOString();
    // Deterministic cleanup: entities decoded, leading release-type tag split off. The exact
    // provider title is kept in titleOriginal whenever the cleaned title differs from it.
    const rawTitle = item.title.trim();
    const { title, releaseType } = cleanTitle(rawTitle);
    const candidate = cleanEvent({
      id: stableEventId(source.id, link.href),
      eventKind: 'news-release',
      date: local.slice(0, 10),
      time: local.slice(11, 16),
      title,
      ...(title === rawTitle ? {} : { titleOriginal: rawTitle }),
      ...(releaseType ? { releaseType } : {}),
      country: source.country,
      ...classify(title, source),
      description:
        '공식 RSS 보도자료의 게시시각입니다. 제목의 키워드로 중요도·분류·영향자산을 추정했으며 확신은 낮습니다. 기사 본문을 수집하거나 영향 방향을 예측하지 않았습니다. 미래 경제지표 발표 일정으로 해석하지 마세요.',
      sourceUrl: link.href,
      sourceName: source.name,
      impactDirection: 'unknown',
      impactHorizon: '보도자료 게시 시점 · 예정된 발표 일정 아님',
      confidence: 'low',
      factualObservedAt: fetchedAt.toISOString(),
    });
    if (candidate) events.set(candidate.id, candidate);
    else skipped++;
  }
  return {
    events: [...events.values()],
    warnings: [
      ...(skipped
        ? [`${source.name}: 필드·출처·게시시각 검증에서 ${skipped}개 항목을 제외했습니다.`]
        : []),
      ...(items.length > 100 ? [`${source.name}: 최근 100개 RSS 항목만 처리했습니다.`] : []),
    ],
  };
}
async function fetchFeed(
  source: NewsSource,
  transport: typeof fetch,
  now: () => Date,
): Promise<NewsCacheEntry> {
  const response = await transport(source.feedUrl, {
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
  });
  if (!response.ok || response.redirected || !response.body) {
    await response.body?.cancel();
    throw new Error('NEWS_PROVIDER_FAILED');
  }
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumBytes)
  ) {
    await response.body.cancel();
    throw new Error('NEWS_RESPONSE_TOO_LARGE');
  }
  const reader = response.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error('NEWS_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const fetchedAt = now();
  const parsed = parseOfficialFeed(Buffer.concat(chunks).toString('utf8'), source, fetchedAt);
  return { expiresAt: fetchedAt.getTime() + cacheLifetime, ...parsed };
}
export async function syncOfficialNews(
  repository: CalendarRepository,
  options: NewsSyncOptions = {},
): Promise<NewsSyncResult> {
  const sources = selectedSources(options.sourceIds);
  const cache = options.cache ?? sharedCache;
  const now = options.now ?? (() => new Date());
  const transport = options.transport ?? fetch;
  let flights = flightsByCache.get(cache);
  if (!flights) {
    flights = new Map();
    flightsByCache.set(cache, flights);
  }
  const result: NewsSyncResult = { count: 0, sources: [], warnings: [newsCoverageWarning] };
  for (const source of sources) {
    try {
      let entry = cache.get(source.id);
      const cached = !!entry && entry.expiresAt > now().getTime();
      if (!cached) {
        let pending = flights.get(source.id);
        if (!pending) {
          pending = fetchFeed(source, transport, now).then((value) => {
            cache.set(source.id, value);
            return value;
          });
          flights.set(source.id, pending);
        }
        try {
          entry = await pending;
        } finally {
          flights.delete(source.id);
        }
      }
      await repository.upsert(entry!.events, options.authorId ?? 'official-news-sync');
      result.count += entry!.events.length;
      result.sources.push({
        id: source.id,
        name: source.name,
        status: cached ? 'cached' : 'synced',
        count: entry!.events.length,
      });
      result.warnings.push(...entry!.warnings);
    } catch {
      result.sources.push({ id: source.id, name: source.name, status: 'failed', count: 0 });
      result.warnings.push(
        `${source.name}: 수집 또는 저장에 실패했습니다. 해당 출처의 새 보도자료가 반영되지 않았습니다.`,
      );
    }
  }
  return result;
}
export function createNewsRouter({
  repository,
  ownerUserId,
  options = {},
}: {
  repository: CalendarRepository;
  ownerUserId?: string;
  options?: Omit<NewsSyncOptions, 'sourceIds' | 'authorId'>;
}) {
  const router = Router();
  router.use(['/api/news/sources', '/api/admin/news/sync'], (_req, res, next) => {
    if (!res.locals.user || res.locals.user.active === false) {
      res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: '로그인이 필요합니다.' } });
      return;
    }
    next();
  });
  // News sources and sync are owner-only (sync additionally requires admin); re-checked here.
  router.use(['/api/news/sources', '/api/admin/news/sync'], ownerGate(ownerUserId));
  router.get('/api/news/sources', (_req, res) =>
    res.json({ sources: officialNewsSources, warnings: [newsCoverageWarning] }),
  );
  router.post(
    '/api/admin/news/sync',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 3,
      keyGenerator: (_req, res) => res.locals.user.id,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
    async (req, res) => {
      if (res.locals.user.role !== 'admin') {
        res
          .status(403)
          .json({ error: { code: 'ADMIN_REQUIRED', message: '관리자 권한이 필요합니다.' } });
        return;
      }
      const body = req.body ?? {};
      if (
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => key !== 'sourceIds')
      ) {
        res.status(400).json({
          error: { code: 'INVALID_NEWS_SOURCES', message: '등록된 출처 ID만 입력하세요.' },
        });
        return;
      }
      try {
        selectedSources(body.sourceIds);
      } catch {
        res.status(400).json({
          error: { code: 'INVALID_NEWS_SOURCES', message: '등록된 출처 ID만 입력하세요.' },
        });
        return;
      }
      const result = await syncOfficialNews(repository, {
        ...options,
        sourceIds: body.sourceIds,
        authorId: res.locals.user.id,
      });
      if (result.sources.every((source) => source.status === 'failed')) {
        res.status(503).json({
          ...result,
          error: {
            code: 'NEWS_SYNC_FAILED',
            message: '공식 뉴스 수집에 실패했습니다. 이전 저장 데이터는 유지됩니다.',
          },
        });
        return;
      }
      res.json(result);
    },
  );
  return router;
}
