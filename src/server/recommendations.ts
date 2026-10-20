import { cleanEvent, type CalendarRepository, type EconomicEvent } from './calendar.js';
import type { Strategy } from './store.js';
import { ProviderError, type TossClient } from './toss.js';

export type RecommendationPeriod = 'daily' | 'weekly' | 'monthly';
const horizons = {
  daily: { tradingDays: 1, calendarDays: 1 },
  weekly: { tradingDays: 5, calendarDays: 7 },
  monthly: { tradingDays: 20, calendarDays: 30 },
} as const;
export function validRecommendationQuery(
  period: unknown,
  symbol: unknown,
): period is RecommendationPeriod {
  return (
    typeof period === 'string' &&
    Object.hasOwn(horizons, period) &&
    typeof symbol === 'string' &&
    /^[A-Za-z0-9.\-]{1,30}$/.test(symbol)
  );
}
function eventEvidence(
  event: EconomicEvent,
): Pick<
  EconomicEvent,
  | 'id'
  | 'eventKind'
  | 'date'
  | 'time'
  | 'title'
  | 'importance'
  | 'sourceName'
  | 'sourceUrl'
  | 'factualObservedAt'
> {
  return {
    id: event.id,
    eventKind: event.eventKind ?? 'scheduled',
    date: event.date,
    time: event.time,
    title: event.title,
    importance: event.importance,
    sourceName: event.sourceName,
    sourceUrl: event.sourceUrl,
    factualObservedAt: event.factualObservedAt,
  };
}
export async function createRecommendation({
  userId,
  strategy,
  period,
  symbol,
  toss,
  calendar,
  now = new Date(),
}: {
  userId: string;
  strategy: Strategy;
  period: RecommendationPeriod;
  symbol: string;
  toss: Pick<TossClient, 'portfolio' | 'candles'>;
  calendar: CalendarRepository;
  now?: Date;
}) {
  if (!validRecommendationQuery(period, symbol))
    throw new ProviderError(400, 'INVALID_RECOMMENDATION_QUERY', '추천 기간과 종목을 확인하세요.');
  // Gate through the provider's owner check before spending chart/news quota.
  const portfolio = await toss.portfolio(userId);
  const horizon = horizons[period];
  const from = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const to = new Date(Date.parse(`${from}T00:00:00Z`) + horizon.calendarDays * 86400000)
    .toISOString()
    .slice(0, 10);
  const newsCutoff = now.getTime() - horizon.calendarDays * 86400000;
  const newsFrom = new Date(newsCutoff + 9 * 3600000).toISOString().slice(0, 10);
  const [market, records, newsRecords] = await Promise.all([
    toss.candles(symbol, '1d', 90),
    calendar.list(from, to),
    calendar.list(newsFrom, from),
  ]);
  const candles = market.candles;
  const closes = candles.map((candle) => Number(candle.close));
  const timestamps = candles.map((candle) => Date.parse(candle.timestamp));
  if (
    candles.length < 21 ||
    candles.length > 200 ||
    closes.some((close) => !Number.isFinite(close) || close <= 0) ||
    timestamps.some(
      (stamp, i) => !Number.isFinite(stamp) || (i > 0 && stamp <= timestamps[i - 1]),
    ) ||
    new Set(candles.map((candle) => candle.currency)).size !== 1
  )
    throw new ProviderError(
      503,
      'INSUFFICIENT_MARKET_DATA',
      '지표 계산을 위한 연속된 일봉 데이터가 부족합니다.',
    );
  const latestTimestamp = timestamps.at(-1)!;
  if (latestTimestamp < now.getTime() - 10 * 86400000 || latestTimestamp > now.getTime() + 86400000)
    throw new ProviderError(
      503,
      'STALE_MARKET_DATA',
      '최근 거래 시점을 확인할 수 없어 추천을 생성하지 않았습니다.',
    );
  const latestClose = closes.at(-1)!;
  const returnPercent = (latestClose / closes[closes.length - 1 - horizon.tradingDays] - 1) * 100;
  const sma20 = closes.slice(-20).reduce((sum, close) => sum + close, 0) / 20;
  const changes = closes
    .slice(-15)
    .slice(1)
    .map((close, i) => close - closes[closes.length - 15 + i]);
  const gain = changes.reduce((sum, change) => sum + Math.max(change, 0), 0);
  const loss = changes.reduce((sum, change) => sum + Math.max(-change, 0), 0);
  const rsi14 = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  const thresholdPercent = { low: 2, medium: 4, high: 6 }[strategy.riskTolerance];
  const relevantMarket = /^\d{6}$/.test(symbol) ? '한국' : '미국';
  const validatedEvents = records
    .slice(0, 2000)
    .map(cleanEvent)
    .filter(
      (event): event is EconomicEvent => event !== null && event.eventKind !== 'news-release',
    );
  const relevantEvents = validatedEvents.filter(
    (event) =>
      event.country === relevantMarket ||
      event.country === '글로벌' ||
      event.assets.some((asset) => asset.toUpperCase() === symbol.toUpperCase()),
  );
  const excludedCount = records.slice(0, 2000).length - relevantEvents.length;
  const events = relevantEvents
    .filter((event) => {
      const stamp = Date.parse(`${event.date}T${event.time}:00+09:00`);
      try {
        return (
          Number.isFinite(stamp) &&
          stamp >= now.getTime() &&
          event.date <= to &&
          new URL(event.sourceUrl).protocol === 'https:'
        );
      } catch {
        return false;
      }
    })
    .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
  const validatedNews = newsRecords
    .slice(0, 2000)
    .map(cleanEvent)
    .filter(
      (event): event is EconomicEvent => event !== null && event.eventKind === 'news-release',
    );
  const relevantNews = validatedNews.filter(
    (event) =>
      event.country === relevantMarket ||
      event.country === '글로벌' ||
      event.assets.some((asset) => asset.toUpperCase() === symbol.toUpperCase()),
  );
  const recentNews = [
    ...new Map(
      relevantNews
        .filter((event) => {
          const published = Date.parse(`${event.date}T${event.time}:00+09:00`);
          return (
            Number.isFinite(published) && published >= newsCutoff && published <= now.getTime()
          );
        })
        .map((event) => [event.id, event]),
    ).values(),
  ].sort((a, b) => `${b.date}T${b.time}`.localeCompare(`${a.date}T${a.time}`));
  const highImpact = events.some((event) => event.importance === 3);
  const action =
    returnPercent <= -thresholdPercent || rsi14 >= 70 || highImpact
      ? 'review-risk'
      : returnPercent >= thresholdPercent && latestClose >= sma20 && rsi14 < 70
        ? 'review-opportunity'
        : 'hold-plan';
  const titles = {
    'review-risk': '목표 비중과 위험 노출을 우선 점검하세요',
    'review-opportunity': '상승 신호를 목표 전략과 대조하세요',
    'hold-plan': '단일 가격 변화보다 기존 전략을 유지하며 점검하세요',
  };
  const stockExposureByCurrency = (['KRW', 'USD'] as const).map((currency) => {
    const holdings = portfolio.holdings.filter((holding) => holding.currency === currency);
    const total = holdings.reduce((sum, holding) => sum + Number(holding.marketValue), 0);
    return {
      currency,
      holdings: holdings.map((holding) => ({
        symbol: holding.symbol,
        weightWithinStocksPercent:
          total > 0 && Number.isFinite(total)
            ? Math.round((Number(holding.marketValue) / total) * 10000) / 100
            : 0,
      })),
    };
  });
  return {
    engine: 'rules-v1' as const,
    dataMode: 'live' as const,
    asOf: now.toISOString(),
    period,
    symbol,
    horizon,
    strategy: structuredClone(strategy),
    decision: {
      action,
      title: titles[action],
      thresholdPercent,
      rationale: `${horizon.tradingDays}거래일 수익률 ${returnPercent.toFixed(2)}%, SMA20 대비 ${latestClose >= sma20 ? '상회' : '하회'}, RSI14 ${rsi14.toFixed(1)}를 저장된 위험성향 임계치 ${thresholdPercent}% 및 등록된 중요 일정 ${highImpact ? '있음' : '없음'}과 비교했습니다. 최근 공개 보도자료 ${recentNews.length}건을 별도 근거로 제공하며 낮은 확신의 제목 분류만으로 판단을 변경하지 않습니다. 자동 매매 지시가 아닌 점검 규칙입니다.`,
    },
    metrics: {
      returnPercent,
      sma20,
      rsi14,
      latestClose,
      latestTimestamp: candles.at(-1)!.timestamp,
    },
    evidence: {
      market,
      calendar: {
        from,
        to,
        source: 'admin-curated' as const,
        relevanceRule:
          '6자리 숫자 종목은 한국, 그 외는 미국 시장으로 분류하고 같은 시장·글로벌·assets에 종목이 명시된 일정만 포함합니다. 거시 일정의 직접적인 영향은 보장하지 않습니다.',
        excludedCount,
        events: events.slice(0, 50).map(eventEvidence),
        truncated: records.length > 2000 || events.length > 50,
        coverageWarning:
          '관리자가 등록한 일정만 참조하며 전체 금융 뉴스나 모든 시장 이벤트를 포괄하지 않습니다. 등록 일정이 없다는 것은 위험이 없다는 뜻이 아닙니다.',
      },
      news: {
        from: newsFrom,
        to: from,
        source: 'registered-news' as const,
        relevanceRule:
          '예정 일정과 같은 시장 관련성 기준을 사용하되, news-release로 구분된 최근 공개 보도자료만 포함합니다.',
        excludedCount: validatedNews.length - relevantNews.length,
        events: recentNews.slice(0, 50).map(eventEvidence),
        truncated: newsRecords.length > 2000 || recentNews.length > 50,
        coverageWarning:
          '일·주·월에 따라 최근1·7·30일의 공개 보도자료를 별도로 확인합니다. 게시시각은 미래 지표 발표 일정이 아니며 제목 기반 중요도는 낮은 확신의 추정입니다. 전체 금융 뉴스나 기사 본문을 수집하지 않습니다.',
      },
    },
    stockExposureByCurrency,
    scenarios: [
      `추세 지속: 가격이 SMA20 ${sma20.toFixed(2)} 이상을 유지하더라도 목표 비중과 투자 기간을 먼저 대조합니다.`,
      `반대 시나리오: 추세 반전이나 예상 밖 발표로 신호가 무효화될 수 있습니다. ${thresholdPercent}%는 전략별 점검 임계치이며 손실 한도나 가격 예측이 아닙니다.`,
    ],
    risks: [
      '생성형 AI 또는 전문가 판단이 아닌 설명 가능한 규칙 계산입니다. 예측 정확도나 수익 확률을 산출하지 않습니다.',
      'SMA20·RSI14와 과거 수익률은 후행 지표이며 미래 수익을 보장하지 않습니다. RSI14는 최근14개 변화의 단순 합산 방식입니다.',
      '주식 보유액의 통화별 내부 비중만 제시합니다. 환율 없이 KRW와 USD를 합산하지 않으며 현금·채권·옵션이 제외되어 전체 자산 배분이나 리밸런싱으로 해석할 수 없습니다.',
      '최근 보도자료는 게시 시각 기준의 별도 근거이며 영향 방향을 추정하지 않습니다. 제목 기반 중요도만으로 위험 판단을 변경하지 않습니다.',
      '비용·세금·유동성·기업 공시와 전체 뉴스는 반영하지 않았습니다. 실제 주문을 실행하지 않습니다.',
    ],
  };
}
