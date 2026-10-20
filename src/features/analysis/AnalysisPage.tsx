import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Bell, Check } from 'lucide-react';
import { DataState, LoadingState } from '../../components/DataState';
import { useApiResource } from '../../lib/api';
import { marketOf, type Market } from '../../lib/analysis';
import { buildChartModel, targetBars } from '../../lib/chartData';
import { formatPrice } from '../../lib/format';
import { formatKst } from '../../lib/kst';
import type { IndicatorId } from '../../lib/indicators';
import { priceRatios } from '../../lib/valuation';
import { useCandleHistory } from './candles';
import { FlowPanel } from './FlowPanel';
import { IndicatorPicker } from './IndicatorPicker';
import { IndicatorPane, PriceChart, separatePanes } from './PriceChart';
import { parsePriceLimits, parsePriceQuote, parseStockLookup, parseWarnings } from './parsers';
import { QuotePanel } from './QuotePanel';
import { Summary, SymbolSearch, SYMBOL_PATTERN, type Valuation } from './Summary';
import { useFundamentals, ValuePanel } from './ValuePanel';
import './analysis.css';

type TabId = 'value' | 'flow' | 'quote';
const tabs: { id: TabId; label: string }[] = [
  { id: 'value', label: '가치·재무' },
  { id: 'flow', label: '수급' },
  { id: 'quote', label: '호가·체결' },
];

/** 종목 분석: symbol search, then everything for the chosen symbol (remounted per symbol). */
export default function AnalysisPage({ initialSymbol }: { initialSymbol: string }) {
  const start = SYMBOL_PATTERN.test(initialSymbol) ? initialSymbol.toUpperCase() : '005930';
  const [symbol, setSymbol] = useState(start);
  const [period, setPeriod] = useState('3개월');
  const [selected, setSelected] = useState<ReadonlySet<IndicatorId>>(new Set(['sma', 'rsi']));
  const toggle = (id: IndicatorId) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <div className="analysis">
      <div className="page-heading">
        <div className="eyebrow">STOCK ANALYSIS</div>
        <div className="title-row">
          <div>
            <h1>
              종목 분석
              <span className="title-dot" />
            </h1>
            <p>
              종목 요약, 가격 지표, 재무·수급·호가를 한 화면에서 확인합니다. 모든 값은 출처와 조회
              시각을 함께 표시합니다.
            </p>
          </div>
        </div>
      </div>
      <SymbolSearch key={symbol} symbol={symbol} onSearch={setSymbol} />
      {/* Remounting per symbol drops every request state, so one symbol's data never mixes with another's. */}
      <AnalysisBody
        key={symbol}
        symbol={symbol}
        period={period}
        onPeriod={setPeriod}
        selected={selected}
        onToggle={toggle}
      />
    </div>
  );
}

function AnalysisBody({
  symbol,
  period,
  onPeriod,
  selected,
  onToggle,
}: {
  symbol: string;
  period: string;
  onPeriod: (label: string) => void;
  selected: ReadonlySet<IndicatorId>;
  onToggle: (id: IndicatorId) => void;
}) {
  const [tab, setTab] = useState<TabId>('value');
  const [buy, setBuy] = useState('');
  const [sell, setSell] = useState('');
  const [memo, setMemo] = useState(false);
  const enc = encodeURIComponent(symbol);

  const stock = useApiResource(`/api/analysis/stocks?symbols=${enc}`, parseStockLookup(symbol));
  const price = useApiResource(`/api/market/prices?symbols=${enc}`, parsePriceQuote(symbol));
  const warnings = useApiResource(`/api/analysis/warnings?symbol=${enc}`, parseWarnings);
  const limits = useApiResource(`/api/analysis/price-limits?symbol=${enc}`, parsePriceLimits);
  const history = useCandleHistory(symbol, targetBars(period));
  const info = stock.state.status === 'ready' ? stock.state.data.stock : null;
  const quote = price.state.status === 'ready' ? price.state.data : null;
  const candleCurrency = history.state.status === 'ready' ? history.state.currency : undefined;
  // Market from the stock record; before it arrives (or if it fails) the currency decides.
  const market: Market | null = marketOf(
    info?.market,
    info?.currency ?? quote?.currency ?? candleCurrency,
  );
  const fundamentals = useFundamentals(market, symbol);

  const valuation = useMemo<Valuation | null>(() => {
    if (fundamentals.state.status !== 'ready' || !quote) return null;
    return {
      ratios: priceRatios(fundamentals.state.data.perShare, quote.lastPrice, quote.currency),
      computedAt: new Date().toISOString(),
    };
  }, [fundamentals.state, quote]);

  const readyHistory =
    history.state.status === 'ready' && history.state.symbol === symbol ? history.state : null;
  const model = useMemo(
    () => (readyHistory ? buildChartModel(readyHistory.candles, selected, period) : null),
    [readyHistory, selected, period],
  );
  const buyLine = Number(buy) > 0 ? Number(buy) : null;
  const sellLine = Number(sell) > 0 ? Number(sell) : null;
  const unknownSymbol = stock.state.status === 'issue' && stock.state.issue.kind === 'no-data';
  // Price and candles both failed: nothing on the screen can load, so say it once with one retry.
  const primaryFailure =
    price.state.status === 'issue' && history.state.status === 'issue' ? price.state.issue : null;
  const retryAll = () => {
    stock.retry();
    price.retry();
    warnings.retry();
    limits.retry();
    history.retry();
  };
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onTabKey = (event: KeyboardEvent, index: number) => {
    const move =
      event.key === 'ArrowRight'
        ? index + 1
        : event.key === 'ArrowLeft'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : null;
    if (move === null) return;
    event.preventDefault();
    const next = (move + tabs.length) % tabs.length;
    setTab(tabs[next].id);
    tabRefs.current[next]?.focus();
  };

  if (primaryFailure)
    return <DataState issue={primaryFailure} onRetry={retryAll} scope="종목 분석" />;
  return (
    <>
      <Summary
        symbol={symbol}
        stock={stock.state}
        price={price.state}
        history={history.state}
        limits={limits.state}
        warnings={warnings.state}
        fundamentals={fundamentals.state}
        valuation={valuation}
        retry={{
          stock: stock.retry,
          price: price.retry,
          limits: limits.retry,
          warnings: warnings.retry,
          fundamentals: fundamentals.retry,
        }}
      />

      {unknownSymbol ? (
        <DataState
          issue={{
            kind: 'no-data',
            message: '토스에서 이 종목 코드를 찾지 못했습니다. 코드를 확인하고 다시 조회하세요.',
            retryable: false,
          }}
          title="종목을 찾지 못했습니다"
        />
      ) : (
        <>
          <IndicatorPicker
            period={period}
            onPeriod={onPeriod}
            selected={selected}
            onToggle={onToggle}
          />

          <section className="analysis-card" aria-label="가격 차트">
            <h2>가격 차트 (일봉, 수정주가)</h2>
            {(history.state.status === 'loading' ||
              (history.state.status === 'ready' && !readyHistory)) && (
              <LoadingState label="일봉을 불러오는 중…" />
            )}
            {history.state.status === 'issue' && (
              <DataState issue={history.state.issue} onRetry={history.retry} scope="일봉" />
            )}
            {readyHistory && model && (
              <>
                <PriceChart
                  model={model}
                  selected={selected}
                  currency={readyHistory.currency}
                  buyLine={buyLine}
                  sellLine={sellLine}
                  summary={`${symbol} 일봉 종가 차트. 표시 ${model.shownBars}개, 마지막 종가 ${formatPrice(
                    readyHistory.candles.at(-1)!.close,
                    readyHistory.currency,
                  )}.`}
                />
                {separatePanes(selected).map((id, index, all) => (
                  <IndicatorPane
                    key={id}
                    id={id}
                    rows={model.rows}
                    showAxis={index === all.length - 1}
                  />
                ))}
                <ul className="chart-notes">
                  <li>
                    출처: {readyHistory.source} · 조회 {formatKst(readyHistory.asOf)} KST · 자동
                    갱신 아님 · 조정주가 일봉 {readyHistory.candles.length}개 수신(최대 {200 * 5}
                    개까지, {readyHistory.pages}쪽).
                  </li>
                  {model.shownBars < model.requestedBars && (
                    <li>
                      선택한 기간은 약 {model.requestedBars}거래일이지만 제공된 일봉은{' '}
                      {model.shownBars}개라 그만큼만 그렸습니다.
                    </li>
                  )}
                  {readyHistory.notice && <li role="status">{readyHistory.notice}</li>}
                  {selected.has('ichimoku') && (
                    <li>
                      일목균형표의 선행스팬(구름대)은 26봉 앞으로 이동해 그립니다. 오른쪽 “+N봉”은
                      아직 거래일이 정해지지 않은 위치이며 날짜가 아닙니다.
                    </li>
                  )}
                  {selected.has('vwap') && (
                    <li>
                      일봉 VWAP은 표시 구간의 첫 봉부터 누적한 값입니다(구간을 바꾸면 값이
                      달라집니다).
                    </li>
                  )}
                  <li>
                    지표는 과거 가격으로 계산한 참고 값이며 미래 수익을 보장하지 않습니다. 투자
                    권유나 주문이 아닙니다.
                  </li>
                </ul>
              </>
            )}
          </section>

          <section className="analysis-card analysis-tabs" aria-label="분석 탭">
            <div role="tablist" aria-label="분석 탭">
              {tabs.map((item, index) => (
                <button
                  key={item.id}
                  ref={(node) => {
                    tabRefs.current[index] = node;
                  }}
                  role="tab"
                  type="button"
                  id={`analysis-tab-${item.id}`}
                  aria-selected={tab === item.id}
                  aria-controls={`analysis-panel-${item.id}`}
                  tabIndex={tab === item.id ? 0 : -1}
                  onClick={() => setTab(item.id)}
                  onKeyDown={(event) => onTabKey(event, index)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div
              role="tabpanel"
              id={`analysis-panel-${tab}`}
              aria-labelledby={`analysis-tab-${tab}`}
              tabIndex={0}
            >
              {tab === 'value' && (
                <ValuePanel
                  symbol={symbol}
                  market={market}
                  fundamentals={fundamentals.state}
                  retryFundamentals={fundamentals.retry}
                  quote={quote}
                  valuation={valuation}
                />
              )}
              {tab === 'flow' && <FlowPanel symbol={symbol} market={market} />}
              {tab === 'quote' && <QuotePanel symbol={symbol} />}
            </div>
          </section>
        </>
      )}

      {!unknownSymbol && (
        <section className="analysis-card" aria-label="내 매매 기준선">
          <h2>내 매매 기준선</h2>
          <p className="muted">
            선택한 종목 차트에만 표시 · 종목을 바꾸면 초기화 · 통화 단위로 직접 입력
          </p>
          <div className="line-inputs">
            <label>
              <span className="positive">매수 검토선</span>
              <input
                aria-label="매수 검토선"
                type="number"
                min="0"
                value={buy}
                onChange={(e) => setBuy(e.target.value)}
              />
            </label>
            <label>
              <span className="text-red">매도 검토선</span>
              <input
                aria-label="매도 검토선"
                type="number"
                min="0"
                value={sell}
                onChange={(e) => setSell(e.target.value)}
              />
            </label>
          </div>
          {buyLine !== null && sellLine !== null && buyLine >= sellLine && (
            <p className="form-error">매수 검토선은 매도 검토선보다 낮게 설정하세요.</p>
          )}
          <p className="muted">사용자가 직접 설정한 참고선입니다. 투자 권유나 주문이 아닙니다.</p>
          <button className="button small" onClick={() => setMemo(!memo)}>
            <Bell size={14} />
            {memo ? '알림 메모 해제' : '이 가격 기준 메모'}
            {memo && <Check size={13} />}
          </button>
          {memo && (
            <p className="muted">
              현재 세션에 기준 메모를 추가했습니다. 외부 가격 알림은 연결 전입니다.
            </p>
          )}
        </section>
      )}
    </>
  );
}
