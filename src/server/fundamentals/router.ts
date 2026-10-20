import { Router, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { computePerShareMetrics } from '../../lib/valuation.js';
import { ProviderError } from '../toss.js';
import type { DartAdapter } from './dart.js';
import { normalizeUsSymbol, type SecAdapter } from './sec.js';

const path = '/api/fundamentals';
export const fundamentalsNotice =
  '공시 기준 재무제표와 파생 지표입니다. 각 값은 접수일(filedAt) 이후에만 알려진 값이며 실시간 시세가 아닙니다. PER·PBR은 이 값과 현재가로 화면에서 계산합니다.';

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });

export interface FundamentalsRouterOptions {
  dart?: Pick<DartAdapter, 'statements'>;
  sec?: Pick<SecAdapter, 'statements'>;
  ownerUserId: string;
}

/** Router factory: the supervisor mounts it after session, same-origin and body-limit middleware. */
export function createFundamentalsRouter({ dart, sec, ownerUserId }: FundamentalsRouterOptions) {
  const router = Router();
  router.use(path, (_req, res, next) => {
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
  router.get(
    path,
    rateLimit({
      windowMs: 60 * 1000,
      limit: 30,
      keyGenerator: (_req, res) => res.locals.user.id,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
    async (req, res) => {
      const { market, symbol: rawSymbol, ...rest } = req.query;
      let symbol: string | null = null;
      if (
        Object.keys(rest).length === 0 &&
        (market === 'KR' || market === 'US') &&
        typeof rawSymbol === 'string'
      )
        symbol =
          market === 'KR'
            ? /^[0-9A-Za-z]{6}$/.test(rawSymbol)
              ? rawSymbol.toUpperCase()
              : null
            : normalizeUsSymbol(rawSymbol);
      if (!symbol) {
        fail(res, 400, 'INVALID_FUNDAMENTALS_QUERY', 'market(KR|US)와 종목 코드를 확인하세요.');
        return;
      }
      const adapter = market === 'KR' ? dart : sec;
      if (!adapter) {
        if (market === 'KR')
          fail(res, 503, 'DART_UNAVAILABLE', '국내 재무 데이터(DART)가 설정되지 않았습니다.');
        else
          fail(res, 503, 'SEC_UNAVAILABLE', '미국 재무 데이터(SEC EDGAR)가 설정되지 않았습니다.');
        return;
      }
      try {
        const result = await adapter.statements(symbol);
        res.json({
          ...result,
          perShare: computePerShareMetrics(result.statements),
          notice: fundamentalsNotice,
        });
      } catch (caught) {
        if (caught instanceof ProviderError) {
          if (caught.retryAfter) res.setHeader('Retry-After', String(caught.retryAfter));
          fail(res, caught.status, caught.code, caught.message);
        } else if (caught instanceof RangeError)
          fail(res, 400, 'INVALID_FUNDAMENTALS_QUERY', '종목 코드를 확인하세요.');
        else fail(res, 500, 'FUNDAMENTALS_FAILED', '재무 데이터를 가져오지 못했습니다.');
      }
    },
  );
  return router;
}
