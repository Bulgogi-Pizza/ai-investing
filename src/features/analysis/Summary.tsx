import { useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Minus, Search } from 'lucide-react';
import { DataState, LoadingState } from '../../components/DataState';
import type { CandleHistory } from './candles';
import type { Resource } from '../../lib/api';
import {
  limitLabel,
  limitProximity,
  marketCapitalization,
  NEAR_LIMIT_RATE,
  previousCloseChange,
  reasonText,
  stockFlagLabels,
  warningLabel,
} from '../../lib/analysis';
import {
  formatMarketCap,
  formatPercent,
  formatPrice,
  formatRatioTimes,
  formatSignedPercent,
  formatSignedPrice,
} from '../../lib/format';
import { formatKst } from '../../lib/kst';
import type { PriceRatios } from '../../lib/valuation';
import type { Fundamentals, PriceLimits, PriceQuote, StockLookup, Warnings } from './parsers';

export const SYMBOL_PATTERN = /^[A-Za-z0-9.\-]{1,30}$/;
export const quickSymbols = [
  { code: '005930', label: '삼성전자' },
  { code: '000660', label: 'SK하이닉스' },
  { code: 'AAPL', label: 'Apple' },
] as const;

export function SymbolSearch({
  symbol,
  onSearch,
}: {
  symbol: string;
  onSearch: (symbol: string) => void;
}) {
  const [input, setInput] = useState(symbol);
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = input.trim().toUpperCase();
    if (!SYMBOL_PATTERN.test(value)) {
      setError('종목 코드는 영문·숫자·점·하이픈 30자 이내로 입력하세요. 예: 005930, AAPL');
      return;
    }
    setError('');
    setInput(value);
    onSearch(value);
  };
  return (
    <section className="analysis-card" aria-label="종목 검색">
      <form className="symbol-search" onSubmit={submit} role="search">
        <label htmlFor="symbol-input">종목 코드로 조회 (국내 6자리 코드 또는 미국 티커)</label>
        <input
          id="symbol-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="예: 005930, AAPL"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'symbol-error' : undefined}
        />
        <button className="button primary" type="submit">
          <Search size={15} aria-hidden="true" /> 조회
        </button>
      </form>
      {error && (
        <p id="symbol-error" role="alert" className="symbol-error">
          {error}
        </p>
      )}
      <div className="symbol-quick" aria-label="자주 보는 종목">
        {quickSymbols.map((item) => (
          <button
            key={item.code}
            type="button"
            aria-pressed={symbol === item.code}
            onClick={() => {
              setInput(item.code);
              setError('');
              onSearch(item.code);
            }}
          >
            {item.label} {item.code}
          </button>
        ))}
      </div>
    </section>
  );
}

const kst = (value: string) => `${formatKst(value)} KST`;
const marketLabels: Record<string, string> = {
  KOSPI: '코스피',
  KOSDAQ: '코스닥',
  KR_ETC: '국내 기타',
  NYSE: 'NYSE',
  NASDAQ: 'NASDAQ',
  AMEX: 'AMEX',
  US_ETC: '미국 기타',
};

export type Valuation = { ratios: PriceRatios; computedAt: string };

export function Summary({
  symbol,
  stock,
  price,
  history,
  limits,
  warnings,
  fundamentals,
  valuation,
  retry,
}: {
  symbol: string;
  stock: Resource<StockLookup>;
  price: Resource<PriceQuote>;
  history: CandleHistory;
  limits: Resource<PriceLimits>;
  warnings: Resource<Warnings>;
  fundamentals: Resource<Fundamentals>;
  valuation: Valuation | null;
  retry: {
    stock: () => void;
    price: () => void;
    limits: () => void;
    warnings: () => void;
    fundamentals: () => void;
  };
}) {
  const info = stock.status === 'ready' ? stock.data.stock : null;
  const quote = price.status === 'ready' ? price.data : null;
  const currency = quote?.currency ?? info?.currency ?? null;
  const candles = history.status === 'ready' && history.symbol === symbol ? history.candles : null;
  const change =
    quote && candles
      ? previousCloseChange(
          quote.lastPrice,
          quote.timestamp,
          candles.map((c) => ({ timestamp: c.timestamp, close: c.close })),
        )
      : null;
  const cap =
    info && quote ? marketCapitalization(quote.lastPrice, Number(info.sharesOutstanding)) : null;
  const proximity =
    quote && limits.status === 'ready'
      ? limitProximity(quote.lastPrice, limits.data.upperLimitPrice, limits.data.lowerLimitPrice)
      : null;
  const flags = info ? stockFlagLabels(info) : [];
  return (
    <section className="analysis-card" aria-label="종목 요약">
      <div className="summary-head">
        {info ? (
          <>
            <h2>{info.name}</h2>
            <span className="meta">
              {info.englishName} · {info.symbol} · {marketLabels[info.market] ?? info.market} ·{' '}
              {info.currency}
            </span>
          </>
        ) : (
          <h2>{symbol}</h2>
        )}
      </div>
      {stock.status === 'loading' && <LoadingState label="종목 정보를 불러오는 중…" compact />}
      {stock.status === 'issue' && (
        <DataState issue={stock.issue} onRetry={retry.stock} scope="종목 정보" compact />
      )}

      <div className="summary-price">
        {price.status === 'loading' && <LoadingState label="현재가를 불러오는 중…" compact />}
        {price.status === 'issue' && (
          <DataState issue={price.issue} onRetry={retry.price} scope="현재가" compact />
        )}
        {quote && (
          <>
            <span className="now" data-testid="last-price">
              {formatPrice(quote.lastPrice, quote.currency)}
            </span>
            {change?.status === 'ok' ? (
              <span
                className={`change ${change.change > 0 ? 'up' : change.change < 0 ? 'down' : 'flat'}`}
                data-testid="price-change"
              >
                {change.change > 0 ? (
                  <ArrowUp size={14} aria-hidden="true" />
                ) : change.change < 0 ? (
                  <ArrowDown size={14} aria-hidden="true" />
                ) : (
                  <Minus size={14} aria-hidden="true" />
                )}{' '}
                {formatSignedPrice(change.change, quote.currency)} (
                {formatSignedPercent(change.rate)})
              </span>
            ) : change ? (
              <span className="change flat" data-testid="price-change">
                등락률 계산 불가
              </span>
            ) : history.status === 'issue' ? (
              <span className="change flat">등락률 계산 불가(일봉을 받지 못함)</span>
            ) : (
              <span className="change flat">등락률 계산 중…</span>
            )}
          </>
        )}
      </div>
      {quote && (
        <p className="summary-foot" data-testid="price-basis">
          현재가: 토스증권 Open API · 시세 시각 {quote.timestamp ? kst(quote.timestamp) : '미제공'}{' '}
          · 조회 {kst(quote.asOf)}
          <br />
          {change?.status === 'ok'
            ? `등락 기준: 전일 종가 ${formatPrice(change.previousClose, quote.currency)}(${change.previousCloseDate} 일봉 수정주가 종가) 대비. 토스 현재가 응답에 등락 필드가 없어 일봉으로 계산했습니다.`
            : change?.status === 'unavailable'
              ? `등락 기준을 정할 수 없어 표시하지 않습니다(${changeReason[change.reason]}).`
              : '등락률은 일봉 종가와 현재가 시각을 받은 뒤 계산합니다.'}
        </p>
      )}

      <dl className="summary-stats">
        <div>
          <dt>시가총액 (계산)</dt>
          <dd data-testid="market-cap">
            {cap !== null && currency ? formatMarketCap(cap, currency) : '—'}
            <small>
              {cap !== null && info && quote
                ? `현재가 × 발행주식수 ${Number(info.sharesOutstanding).toLocaleString('ko-KR')}주(토스 종목 정보, ${kst(stock.status === 'ready' ? stock.data.asOf : '')})`
                : stock.status === 'issue'
                  ? '종목 정보를 받지 못해 계산할 수 없습니다.'
                  : '발행주식수와 현재가가 모두 있어야 계산합니다.'}
            </small>
          </dd>
        </div>
        <Ratio
          label="PER (TTM)"
          testId="per"
          metric={valuation?.ratios.per}
          fundamentals={fundamentals}
          valuation={valuation}
          retry={retry.fundamentals}
        />
        <Ratio
          label="PBR"
          testId="pbr"
          metric={valuation?.ratios.pbr}
          fundamentals={fundamentals}
          valuation={valuation}
          retry={retry.fundamentals}
        />
      </dl>

      <div className="badge-row" aria-label="매수 유의사항" data-testid="warnings">
        <span className="label">매수 유의사항</span>
        {warnings.status === 'loading' && <span className="badge-none">확인 중…</span>}
        {warnings.status === 'issue' && (
          <DataState issue={warnings.issue} onRetry={retry.warnings} scope="유의사항" compact />
        )}
        {warnings.status === 'ready' &&
          warnings.data.warnings.map((w, index) => (
            <span className="warn-badge" key={`${w.warningType}-${index}`}>
              {warningLabel(w.warningType)}
              {(w.startDate || w.endDate) && (
                <small>
                  {w.startDate ?? '?'} ~ {w.endDate ?? '진행 중'}
                </small>
              )}
            </span>
          ))}
        {flags.map((flag) => (
          <span className="warn-badge" key={flag}>
            {flag}
          </span>
        ))}
        {proximity?.status === 'ok' && proximity.level !== 'normal' && (
          <span className="warn-badge limit" data-testid="limit-badge">
            {limitLabel[proximity.level]}
            <small>
              {proximity.level.startsWith('upper')
                ? `상한가까지 ${formatPercent(Math.max(proximity.toUpper ?? 0, 0))}`
                : `하한가에서 ${formatPercent(Math.max(proximity.toLower ?? 0, 0))}`}
            </small>
          </span>
        )}
        {warnings.status === 'ready' &&
          warnings.data.warnings.length === 0 &&
          flags.length === 0 &&
          !(proximity?.status === 'ok' && proximity.level !== 'normal') && (
            <span className="badge-none">현재 활성 유의사항 없음</span>
          )}
      </div>
      <p className="summary-foot">
        유의사항: 토스 <code>/stocks/&#123;symbol&#125;/warnings</code>
        {warnings.status === 'ready' && ` · 조회 ${kst(warnings.data.asOf)}`}. 상하한가 근접:{' '}
        <code>/price-limits</code>의 상·하한가까지 가격의 {NEAR_LIMIT_RATE * 100}% 이내이면 표시
        {limits.status === 'ready'
          ? limits.data.upperLimitPrice === null && limits.data.lowerLimitPrice === null
            ? ' — 이 종목은 가격 제한이 없어 판단하지 않습니다.'
            : ` · 상한가 ${limits.data.upperLimitPrice === null ? '없음' : formatPrice(limits.data.upperLimitPrice, limits.data.currency)} / 하한가 ${limits.data.lowerLimitPrice === null ? '없음' : formatPrice(limits.data.lowerLimitPrice, limits.data.currency)} (시각 ${kst(limits.data.timestamp)}).`
          : limits.status === 'issue'
            ? ' — 상하한가를 받지 못해 판단하지 않습니다.'
            : '.'}
      </p>
      {limits.status === 'issue' && (
        <DataState issue={limits.issue} onRetry={retry.limits} scope="상하한가" compact />
      )}
    </section>
  );
}

const changeReason = {
  NO_CANDLES: '일봉 없음',
  NO_PRICE_TIME: '현재가 시각 없음',
  STALE_PRICE: '현재가 시각이 최신 일봉보다 앞섬',
  NO_PREVIOUS_CLOSE: '비교할 전일 종가 없음',
  INVALID_PRICE: '현재가 값 오류',
} as const;

function Ratio({
  label,
  testId,
  metric,
  fundamentals,
  valuation,
  retry,
}: {
  label: string;
  testId: string;
  metric: { value: number | null; reason: string | null; asOf: string | null } | undefined;
  fundamentals: Resource<Fundamentals>;
  valuation: Valuation | null;
  retry: () => void;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd data-testid={testId}>
        {fundamentals.status === 'loading' && '…'}
        {fundamentals.status === 'issue' && '—'}
        {metric && (metric.value !== null ? formatRatioTimes(metric.value) : '—')}
        <small>
          {fundamentals.status === 'loading' && '재무 공시를 불러오는 중입니다.'}
          {fundamentals.status === 'issue' && (
            <>
              {fundamentals.issue.message}
              {fundamentals.issue.retryable && (
                <>
                  {' '}
                  <button className="button small" type="button" onClick={retry}>
                    다시 시도
                  </button>
                </>
              )}
            </>
          )}
          {metric && valuation && (
            <>
              {metric.value !== null
                ? `재무 공시일 ${metric.asOf ?? '—'} · 계산 ${kst(valuation.computedAt)}`
                : `${reasonText(metric.reason)}${metric.asOf ? ` · 재무 공시일 ${metric.asOf}` : ''}`}
            </>
          )}
        </small>
      </dd>
    </div>
  );
}
