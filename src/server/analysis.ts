import { Router, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  invalidQuery,
  isKoreanSymbol,
  parseCount,
  parseSymbol,
  parseSymbolList,
  TREND_COUNT_DEFAULT,
  TREND_COUNT_MAX,
  TRADES_COUNT_DEFAULT,
  TRADES_COUNT_MAX,
  unsupportedMarket,
  type TossAnalysis,
} from './toss-analysis.js';

type Gate = (req: Request, res: Response, next: NextFunction) => void;
const known = ['symbol', 'symbols', 'count', 'market'];

/**
 * Owner-only reads for the 종목 분석 tab. `gate` is the app's `requireOwner` (503 when Toss is not
 * configured, 403 for any other account) and runs before any provider call. Authentication has
 * already run in createApp. Query parameters are validated strictly: unknown, repeated or
 * object-shaped parameters are rejected.
 */
export function createAnalysisRouter({
  analysis,
  gate,
}: {
  analysis: TossAnalysis | undefined;
  gate: Gate;
}) {
  const router = Router();
  const base = '/api/analysis';
  router.use(base, gate);
  router.use(
    base,
    rateLimit({
      windowMs: 60 * 1000,
      limit: 90,
      keyGenerator: (_req, res) => res.locals.user.id,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
  );
  const run =
    (handler: (req: Request, analysis: TossAnalysis) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      // `gate` has already returned 503 when Toss is missing; this only narrows the type.
      const body = (await handler(req, analysis!)) as object;
      res.json(body);
    };
  const clean = (req: Request) =>
    Object.entries(req.query).every(
      ([key, value]) => known.includes(key) && typeof value === 'string',
    );
  const symbolOf = (req: Request) => (clean(req) ? parseSymbol(req.query.symbol) : null);

  router.get(
    `${base}/stocks`,
    run(async (req, a) => {
      const symbols = clean(req) ? parseSymbolList(req.query.symbols) : null;
      if (!symbols) throw invalidQuery();
      return a.stocks(symbols);
    }),
  );
  router.get(
    `${base}/warnings`,
    run(async (req, a) => {
      const symbol = symbolOf(req);
      if (!symbol) throw invalidQuery();
      return a.warnings(symbol);
    }),
  );
  router.get(
    `${base}/price-limits`,
    run(async (req, a) => {
      const symbol = symbolOf(req);
      if (!symbol) throw invalidQuery();
      return a.priceLimits(symbol);
    }),
  );
  router.get(
    `${base}/sector-peers`,
    run(async (req, a) => {
      const symbol = symbolOf(req);
      const market = req.query.market;
      if (!symbol || (market !== 'KR' && market !== 'US')) throw invalidQuery();
      return a.sectorPeers(symbol, market);
    }),
  );
  const trend = (
    path: string,
    call: (a: TossAnalysis, symbol: string, count: number) => Promise<unknown>,
  ) =>
    router.get(
      `${base}/${path}`,
      run(async (req, a) => {
        const symbol = symbolOf(req);
        const count = parseCount(req.query.count, TREND_COUNT_DEFAULT, TREND_COUNT_MAX);
        if (!symbol || count === null) throw invalidQuery();
        if (!isKoreanSymbol(symbol)) throw unsupportedMarket();
        return call(a, symbol, count);
      }),
    );
  trend('investor-trading', (a, s, c) => a.investorTrading(s, c));
  trend('program-trades', (a, s, c) => a.programTrades(s, c));
  trend('short-selling', (a, s, c) => a.shortSelling(s, c));
  trend('credit-trades', (a, s, c) => a.creditTrades(s, c));
  router.get(
    `${base}/orderbook`,
    run(async (req, a) => {
      const symbol = symbolOf(req);
      if (!symbol) throw invalidQuery();
      return a.orderbook(symbol);
    }),
  );
  router.get(
    `${base}/trades`,
    run(async (req, a) => {
      const symbol = symbolOf(req);
      const count = parseCount(req.query.count, TRADES_COUNT_DEFAULT, TRADES_COUNT_MAX);
      if (!symbol || count === null) throw invalidQuery();
      return a.trades(symbol, count);
    }),
  );
  return router;
}
