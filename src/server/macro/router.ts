import { Router, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { ProviderError } from '../toss.js';
import { ecosIndicator, fredIndicator, indicatorById, releaseCatalog } from './catalog.js';
import type { EcosAdapter } from './ecos.js';
import type { FredAdapter } from './fred.js';
import { dayDifference, isRealDate } from './shared.js';

const base = '/api/macro';
export const maximumSeriesWindowDays = 3660;
export const maximumReleaseWindowDays = 120;
export const macroNotice =
  '공식 API(FRED, 한국은행 ECOS) 값입니다. 현재 값은 이후 수정될 수 있어 과거 시점 판단에는 쓰지 않습니다. 발표 일정은 제공자 기준 날짜이며 시각은 제공하지 않습니다.';

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });

export interface MacroRouterOptions {
  fred?: Pick<FredAdapter, 'observations' | 'upcomingReleases'>;
  ecos?: Pick<EcosAdapter, 'observations'>;
  ownerUserId: string;
  now?: () => Date;
}

function onlyKeys(query: unknown, allowed: string[]): query is Record<string, string> {
  if (!query || typeof query !== 'object') return false;
  const entries = Object.entries(query);
  return (
    entries.every(([key, value]) => allowed.includes(key) && typeof value === 'string') &&
    allowed.every((key) => key in query)
  );
}

function providerFailure(res: Response, caught: unknown) {
  if (caught instanceof ProviderError) {
    if (caught.retryAfter) res.setHeader('Retry-After', String(caught.retryAfter));
    fail(res, caught.status, caught.code, caught.message);
  } else if (caught instanceof RangeError)
    fail(res, 400, 'INVALID_MACRO_QUERY', '요청 값을 확인하세요.');
  else fail(res, 500, 'MACRO_FAILED', '거시 지표를 가져오지 못했습니다.');
}

/** Router factory: the supervisor mounts it after session, same-origin and body-limit middleware. */
export function createMacroRouter({ fred, ecos, ownerUserId, now }: MacroRouterOptions) {
  const router = Router();
  router.use(base, (_req, res, next) => {
    if (!res.locals.user || res.locals.user.active === false) {
      fail(res, 401, 'AUTH_REQUIRED', '로그인이 필요합니다.');
      return;
    }
    if (!ownerUserId || res.locals.user.id !== ownerUserId) {
      fail(res, 403, 'OWNER_REQUIRED', '소유자 계정 전용 기능입니다.');
      return;
    }
    next();
  });
  router.use(
    base,
    rateLimit({
      windowMs: 60 * 1000,
      limit: 30,
      keyGenerator: (_req, res) => res.locals.user.id,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
  );

  router.get(`${base}/series`, async (req, res) => {
    const query = req.query;
    if (
      !onlyKeys(query, ['source', 'id', 'from', 'to']) ||
      (query.source !== 'fred' && query.source !== 'ecos') ||
      !isRealDate(query.from) ||
      !isRealDate(query.to) ||
      query.from > query.to ||
      dayDifference(query.from, query.to) > maximumSeriesWindowDays
    ) {
      fail(
        res,
        400,
        'INVALID_MACRO_QUERY',
        'source(fred|ecos), 카탈로그 id, 기간(최대 10년)을 확인하세요.',
      );
      return;
    }
    // Only catalog ids are accepted, and only for their own source.
    const entry = query.source === 'fred' ? fredIndicator(query.id) : ecosIndicator(query.id);
    if (!entry) {
      fail(
        res,
        400,
        'INVALID_MACRO_QUERY',
        'source(fred|ecos), 카탈로그 id, 기간(최대 10년)을 확인하세요.',
      );
      return;
    }
    const adapter = query.source === 'fred' ? fred : ecos;
    if (!adapter) {
      if (query.source === 'fred')
        fail(res, 503, 'FRED_UNAVAILABLE', '미국 경제지표(FRED)가 설정되지 않았습니다.');
      else
        fail(res, 503, 'ECOS_UNAVAILABLE', '한국 경제지표(한국은행 ECOS)가 설정되지 않았습니다.');
      return;
    }
    try {
      const range = { from: query.from, to: query.to };
      const observations =
        query.source === 'fred'
          ? (await (adapter as NonNullable<typeof fred>).observations(entry.id, range)).map(
              ({ date, value }) => ({ date, value }),
            )
          : (await (adapter as NonNullable<typeof ecos>).observations(entry.id, range)).map(
              ({ date, value }) => ({ date, value }),
            );
      res.json({
        id: entry.id,
        source: entry.source,
        titleKo: entry.titleKo,
        country: entry.country,
        unit: entry.unit,
        sourceName: entry.sourceName,
        sourceUrl: entry.sourceUrl,
        asOf: (now ?? (() => new Date()))().toISOString(),
        observations,
        notice: macroNotice,
      });
    } catch (caught) {
      providerFailure(res, caught);
    }
  });

  router.get(`${base}/releases`, async (req, res) => {
    const query = req.query;
    if (
      !onlyKeys(query, ['from', 'to']) ||
      !isRealDate(query.from) ||
      !isRealDate(query.to) ||
      query.from > query.to ||
      dayDifference(query.from, query.to) > maximumReleaseWindowDays
    ) {
      fail(res, 400, 'INVALID_MACRO_QUERY', '날짜 범위(최대 120일)를 확인하세요.');
      return;
    }
    if (!fred) {
      fail(res, 503, 'FRED_UNAVAILABLE', '미국 경제지표(FRED)가 설정되지 않았습니다.');
      return;
    }
    try {
      const dates = await fred.upcomingReleases(query.from, query.to);
      const catalog = new Map(releaseCatalog().map((entry) => [entry.releaseId, entry]));
      res.json({
        source: 'FRED',
        releases: dates.flatMap((release) => {
          const entry = catalog.get(release.releaseId);
          if (!entry) return [];
          return [
            {
              releaseId: release.releaseId,
              date: release.date,
              timeKnown: false,
              titleKo: entry.titleKo,
              importance: entry.importance,
              category: entry.category,
              assets: entry.assets,
              indicatorIds: release.indicatorIds.filter((id) => indicatorById(id)),
              sourceName: 'FRED',
              sourceUrl: entry.sourceUrl,
            },
          ];
        }),
        notice: macroNotice,
      });
    } catch (caught) {
      providerFailure(res, caught);
    }
  });
  return router;
}
