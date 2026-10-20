import { ArrowDownRight, ArrowUpRight, Minus, RefreshCw } from 'lucide-react';
import { DataState, LoadingState } from '../components/DataState';
import { ApiError, useApiResource } from '../lib/api';
import { formatKstTime } from '../lib/kst';

type Indicator = {
  symbol: string;
  name: string;
  kind: 'INDEX' | 'BOND';
  unit: 'point' | 'percent';
  lastPrice: string;
  timestamp: string | null;
};
type Indicators = {
  source: string;
  asOf: string;
  indicators: Indicator[];
  exchangeRate: {
    midRate: string;
    rate: string;
    rateChangeType: 'UP' | 'EQUAL' | 'DOWN' | null;
    validFrom: string;
  };
};
const numeric = (value: unknown) => typeof value === 'string' && Number.isFinite(Number(value));
export function parseIndicators(body: unknown): Indicators {
  const v = body as Indicators;
  if (
    !v ||
    typeof v.source !== 'string' ||
    !Number.isFinite(Date.parse(v.asOf)) ||
    !Array.isArray(v.indicators) ||
    !v.indicators.every(
      (item) =>
        typeof item?.symbol === 'string' &&
        typeof item.name === 'string' &&
        numeric(item.lastPrice) &&
        (item.unit === 'point' || item.unit === 'percent'),
    ) ||
    !numeric(v.exchangeRate?.midRate) ||
    !numeric(v.exchangeRate?.rate)
  )
    throw new ApiError(502, 'INVALID_RESPONSE', '시장 지표 응답 형식을 확인하지 못했습니다.');
  return v;
}
const format = (value: string, digits = 2) =>
  Number(value).toLocaleString('ko-KR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

/** Real indices, bond yields and USD/KRW from the owner's Toss connection; never example values. */
export default function MarketStrip() {
  const { state, retry } = useApiResource('/api/market/indicators', parseIndicators);
  if (state.status === 'loading' || state.status === 'idle')
    return (
      <div className="market-strip-state">
        <LoadingState label="시장 지표를 불러오는 중…" compact />
      </div>
    );
  if (state.status === 'issue')
    return (
      <div className="market-strip-state">
        <DataState issue={state.issue} onRetry={retry} compact />
      </div>
    );
  const { indicators, exchangeRate, asOf } = state.data;
  const fxIcon =
    exchangeRate.rateChangeType === 'UP' ? (
      <ArrowUpRight size={12} aria-label="상승" />
    ) : exchangeRate.rateChangeType === 'DOWN' ? (
      <ArrowDownRight size={12} aria-label="하락" />
    ) : exchangeRate.rateChangeType === 'EQUAL' ? (
      <Minus size={12} aria-label="보합" />
    ) : null;
  return (
    <div className="market-strip" role="region" aria-label="시장 지표">
      {indicators.map((item) => (
        <div className="market-item" key={item.symbol}>
          <span>{item.name}</span>
          <strong>
            {format(item.lastPrice)}
            {item.unit === 'percent' ? '%' : ''}
          </strong>
        </div>
      ))}
      <div className="market-item">
        <span>USD/KRW</span>
        <strong>{format(exchangeRate.midRate)}</strong>
        <small title="매매기준율 기준. 실제 거래 환율과 다를 수 있습니다.">
          {fxIcon} 매매기준율
        </small>
      </div>
      <span className="market-meta">
        토스증권 · 조회 {formatKstTime(asOf)} KST
        <button className="market-refresh" aria-label="시장 지표 새로고침" onClick={retry}>
          <RefreshCw size={12} />
        </button>
      </span>
    </div>
  );
}
