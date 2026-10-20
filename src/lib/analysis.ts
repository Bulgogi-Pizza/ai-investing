// Pure rules behind the 종목 분석 tab. No I/O and no clock: every number shown on the tab that is
// derived (not delivered by a provider) comes from one of these functions and has a unit test.
import { sectorSummary, type Metric, type SectorSummary } from './valuation';

/** "근접" (near) a daily price limit: within 2 % of the limit price itself. */
export const NEAR_LIMIT_RATE = 0.02;

export type Market = 'KR' | 'US';

/** Toss `market` segment (stocks API) to our two markets. Unknown values fall back to currency. */
export function marketOf(segment: string | null | undefined, currency?: string): Market | null {
  if (segment === 'KOSPI' || segment === 'KOSDAQ' || segment === 'KR_ETC') return 'KR';
  if (segment === 'NYSE' || segment === 'NASDAQ' || segment === 'AMEX' || segment === 'US_ETC')
    return 'US';
  if (currency === 'KRW') return 'KR';
  if (currency === 'USD') return 'US';
  return null;
}

export type CandlePoint = { timestamp: string; close: number };

export type PriceChange =
  | {
      status: 'ok';
      previousClose: number;
      /** Trading date of the previous close as written in the candle timestamp (YYYY-MM-DD). */
      previousCloseDate: string;
      change: number;
      /** Ratio, 0.0123 = +1.23 %. */
      rate: number;
      /** Why this candle is the reference. */
      basis: 'session-candle-excluded' | 'latest-candle';
    }
  | {
      status: 'unavailable';
      reason:
        'NO_CANDLES' | 'NO_PRICE_TIME' | 'STALE_PRICE' | 'NO_PREVIOUS_CLOSE' | 'INVALID_PRICE';
    };

const DAY_MS = 24 * 3600 * 1000;

/** Trading date of a daily candle: the written date when the provider stamps local midnight. */
export function candleDate(timestamp: string): string {
  const local = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(timestamp);
  if (local) return local[1];
  return new Date(Date.parse(timestamp) + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Change versus the previous close, computed from daily candles because the prices endpoint has
 * no change field. A daily candle is stamped with the local midnight that starts its trading day:
 * - price time inside [that midnight, +24 h): the latest candle is today's (in progress or just
 *   closed), so the reference is the candle before it;
 * - price time later than that: the latest candle is an earlier session and is the reference;
 * - price time earlier, or missing: no number is produced.
 * Candles are adjusted (수정주가) closes, oldest first.
 */
export function previousCloseChange(
  lastPrice: number,
  priceTimestamp: string | null,
  candles: readonly CandlePoint[],
): PriceChange {
  if (!Number.isFinite(lastPrice) || lastPrice <= 0)
    return { status: 'unavailable', reason: 'INVALID_PRICE' };
  const latest = candles.at(-1);
  if (!latest) return { status: 'unavailable', reason: 'NO_CANDLES' };
  const priceTime = priceTimestamp === null ? NaN : Date.parse(priceTimestamp);
  if (!Number.isFinite(priceTime)) return { status: 'unavailable', reason: 'NO_PRICE_TIME' };
  const start = Date.parse(latest.timestamp);
  if (!Number.isFinite(start) || priceTime < start)
    return { status: 'unavailable', reason: 'STALE_PRICE' };
  const sameSession = priceTime < start + DAY_MS;
  const reference = sameSession ? candles.at(-2) : latest;
  if (!reference || !Number.isFinite(reference.close) || reference.close <= 0)
    return { status: 'unavailable', reason: 'NO_PREVIOUS_CLOSE' };
  const change = lastPrice - reference.close;
  return {
    status: 'ok',
    previousClose: reference.close,
    previousCloseDate: candleDate(reference.timestamp),
    change,
    rate: change / reference.close,
    basis: sameSession ? 'session-candle-excluded' : 'latest-candle',
  };
}

export type LimitLevel = 'upper-reached' | 'upper-near' | 'lower-reached' | 'lower-near' | 'normal';
export type LimitProximity =
  | { status: 'not-provided' }
  | {
      status: 'ok';
      level: LimitLevel;
      /** (upper - price) / upper; null without an upper limit. */
      toUpper: number | null;
      /** (price - lower) / lower; null without a lower limit. */
      toLower: number | null;
    };

/**
 * 상하한가 근접: 현재가가 상한가까지 상한가의 2 % 이내(또는 도달), 하한가에서 하한가의 2 % 이내
 * (또는 도달)이면 표시한다. 가격 제한이 없는 시장(null)은 판단하지 않는다. 임계값은 상한가·하한가
 * 가격 자체 대비 비율이며 전일 종가 대비 등락률이 아니다.
 */
export function limitProximity(
  lastPrice: number,
  upperLimit: number | null,
  lowerLimit: number | null,
  threshold: number = NEAR_LIMIT_RATE,
): LimitProximity {
  const upper =
    upperLimit !== null && Number.isFinite(upperLimit) && upperLimit > 0 ? upperLimit : null;
  const lower =
    lowerLimit !== null && Number.isFinite(lowerLimit) && lowerLimit > 0 ? lowerLimit : null;
  if ((upper === null && lower === null) || !Number.isFinite(lastPrice) || lastPrice <= 0)
    return { status: 'not-provided' };
  const toUpper = upper === null ? null : (upper - lastPrice) / upper;
  const toLower = lower === null ? null : (lastPrice - lower) / lower;
  let level: LimitLevel = 'normal';
  if (toUpper !== null && toUpper <= 0) level = 'upper-reached';
  else if (toLower !== null && toLower <= 0) level = 'lower-reached';
  else if (toUpper !== null && toUpper <= threshold) level = 'upper-near';
  else if (toLower !== null && toLower <= threshold) level = 'lower-near';
  return { status: 'ok', level, toUpper, toLower };
}

/** Market capitalization = price × shares outstanding (stocks API 발행주식수). */
export function marketCapitalization(lastPrice: number, shares: number): number | null {
  if (!Number.isFinite(lastPrice) || lastPrice <= 0 || !Number.isFinite(shares) || shares <= 0)
    return null;
  return lastPrice * shares;
}

const warningLabels: Record<string, string> = {
  LIQUIDATION_TRADING: '정리매매',
  OVERHEATED: '단기과열종목',
  INVESTMENT_WARNING: '투자경고',
  INVESTMENT_RISK: '투자위험',
  VI_STATIC_AND_DYNAMIC: 'VI 정적·동적 발동',
  VI_STATIC: 'VI 정적 발동',
  VI_DYNAMIC: 'VI 동적 발동',
  STOCK_WARRANTS: '신주인수권',
};
/** Toss warning code to Korean; unknown codes stay visible instead of being dropped. */
export const warningLabel = (type: string) => warningLabels[type] ?? `유의사항(${type})`;

export type StockFlags = {
  status: string;
  koreanMarketDetail: {
    liquidationTrading: boolean;
    krxTradingSuspended: boolean;
    nxtTradingSuspended: boolean | null;
  } | null;
};
/** Badges that come from the stock-info record itself (not from the warnings list). */
export function stockFlagLabels(stock: StockFlags): string[] {
  const labels: string[] = [];
  if (stock.status === 'DELISTED') labels.push('상장폐지');
  if (stock.status === 'SCHEDULED') labels.push('상장 예정');
  const detail = stock.koreanMarketDetail;
  if (detail?.krxTradingSuspended) labels.push('KRX 거래정지');
  if (detail?.nxtTradingSuspended === true) labels.push('NXT 거래정지');
  if (detail?.liquidationTrading) labels.push('정리매매');
  return labels;
}

export const limitLabel: Record<Exclude<LimitLevel, 'normal'>, string> = {
  'upper-reached': '상한가 도달',
  'upper-near': '상한가 근접',
  'lower-reached': '하한가 도달',
  'lower-near': '하한가 근접',
};

export type PeerRatios = {
  symbol: string;
  name: string;
  per: number | null;
  pbr: number | null;
  /** Why the peer has no PER / PBR: a MetricReason or a fetch failure code. */
  perReason: string | null;
  pbrReason: string | null;
};

export type SectorComparison = {
  per: SectorSummary;
  pbr: SectorSummary;
  /** Peers with no PER / PBR, by reason. */
  perExclusions: Record<string, number>;
  pbrExclusions: Record<string, number>;
  peers: number;
};

/** Mean, median, count and exclusions of the peers' PER and PBR (null never counts as zero). */
export function compareSector(peers: readonly PeerRatios[]): SectorComparison {
  const reasons = (key: 'per' | 'pbr') => {
    const counts: Record<string, number> = {};
    for (const peer of peers) {
      if (peer[key] !== null) continue;
      const reason = (key === 'per' ? peer.perReason : peer.pbrReason) ?? 'UNKNOWN';
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
    return counts;
  };
  return {
    per: sectorSummary(peers.map((p) => p.per)),
    pbr: sectorSummary(peers.map((p) => p.pbr)),
    perExclusions: reasons('per'),
    pbrExclusions: reasons('pbr'),
    peers: peers.length,
  };
}

const metricReasonText: Record<string, string> = {
  NO_STATEMENTS: '공시된 재무제표 없음',
  INSUFFICIENT_QUARTERS: '연속 4개 분기(또는 연간) 순이익 없음',
  MISSING_SHARES: '주식 수 없음',
  MISSING_EQUITY: '자본 없음',
  INSUFFICIENT_EQUITY_HISTORY: '4분기 전 자본 없음',
  NON_POSITIVE_EPS: '순이익 적자(EPS 0 이하)라 PER 산출 안 함',
  NON_POSITIVE_EQUITY: '자본 0 이하라 산출 안 함',
  INVALID_PRICE: '현재가를 확인할 수 없음',
  CURRENCY_MISMATCH: '현재가와 재무제표 통화가 다름',
  FETCH_FAILED: '재무 조회 실패',
  RATE_LIMITED: '요청 한도로 조회하지 못함',
  NO_PRICE: '현재가를 받지 못함',
  UNKNOWN: '사유 미상',
};
export const reasonText = (reason: string | null) =>
  reason === null ? '' : (metricReasonText[reason] ?? reason);

/** A metric for display: the value, or why there is none. */
export function describeMetric(metric: Metric | null | undefined) {
  if (!metric) return { value: null, note: '계산 전' };
  return metric.value === null
    ? { value: null, note: reasonText(metric.reason) }
    : { value: metric.value, note: '' };
}
