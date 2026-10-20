import type { NextFunction, Request, Response } from 'express';

/**
 * Owner-only gate. Authentication must already have run: it reads the server-side session user
 * (res.locals.user), never a client-supplied value. An unknown owner id fails closed with 503.
 */
export function ownerGate(ownerUserId: string | undefined) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!ownerUserId) {
      res.status(503).json({
        error: {
          code: 'TOSS_INTEGRATION_UNAVAILABLE',
          message: '토스 API 환경변수와 소유 계정 연결 설정이 필요합니다.',
        },
      });
      return;
    }
    if (!res.locals.user || res.locals.user.id !== ownerUserId) {
      res.status(403).json({
        error: { code: 'OWNER_REQUIRED', message: '소유자 계정 전용 기능입니다.' },
      });
      return;
    }
    next();
  };
}
