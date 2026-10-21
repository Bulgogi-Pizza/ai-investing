import { useState } from 'react';
import { Sparkles, ShieldCheck, Newspaper, ChartNoAxesCombined, Target, Info } from 'lucide-react';
import { assetLabels } from '../lib/strategy';
import { DataState, LoadingState } from '../components/DataState';
import { SourceLink, isHttpsUrl } from '../components/SourceLink';
import { ApiError, useApiResource } from '../lib/api';
import { formatKst } from '../lib/kst';
import './investing.css';
const periods = {
  daily: { label: '데일리' },
  weekly: { label: '주간' },
  monthly: { label: '월간' },
};
type AiNarrative =
  | {
      status: 'ready';
      type: 'llm';
      provider: 'anthropic' | 'vertex' | 'vertex-claude';
      model: string;
      asOf: string;
      summary: string;
      actions: string[];
      counterScenario: string;
      dataGaps: string[];
      confidenceExplanation: string;
      sourceIds: string[];
      sources: { id: string; title: string; url?: string }[];
    }
  | {
      status: 'disabled' | 'unavailable';
      type: 'llm';
      provider: 'anthropic' | 'vertex' | 'vertex-claude';
      model?: string;
      message: string;
    };
interface LiveInsight {
  ai?: AiNarrative;
  engine: 'rules-v1';
  dataMode: 'live';
  asOf: string;
  period: keyof typeof periods;
  symbol: string;
  horizon: { tradingDays: number; calendarDays: number };
  strategy: {
    name: string;
    horizon: string;
    benchmark: string;
    riskTolerance: string;
    targetAllocations: { asset: string; percentage: number }[];
    notes: string;
  };
  decision: { action: string; title: string; rationale: string; thresholdPercent: number };
  metrics: {
    returnPercent: number;
    sma20: number;
    rsi14: number;
    latestClose: number;
    latestTimestamp: string;
  };
  evidence: {
    news?: LiveInsight['evidence']['calendar'];
    market: { source: string; asOf: string; candles: { timestamp: string; currency?: string }[] };
    calendar: {
      from: string;
      to: string;
      source: string;
      events: {
        id: number;
        date: string;
        time: string;
        title: string;
        importance: number;
        sourceName: string;
        sourceUrl: string;
        factualObservedAt: string;
      }[];
      truncated: boolean;
      coverageWarning: string;
      relevanceRule?: string;
      excludedCount?: number;
    };
  };
  scenarios: string[];
  risks: string[];
  stockExposureByCurrency: {
    currency: string;
    holdings: { symbol: string; weightWithinStocksPercent: number }[];
  }[];
}
const kst = formatKst;
function LiveAnalysis({ insight }: { insight: LiveInsight }) {
  const { strategy, metrics, evidence, decision } = insight;
  return (
    <div className="invest-live-results">
      <section className="invest-insight-hero">
        <div className="invest-insight-top">
          <span>
            <ShieldCheck size={16} /> 내 데이터 · 규칙 기반 분석
          </span>
          <span>{kst(insight.asOf)} KST</span>
        </div>
        <h2>{decision.title}</h2>
        <p>{decision.rationale}</p>
        <div className="invest-insight-tags">
          <span>{insight.symbol}</span>
          <span>{insight.horizon.tradingDays}거래일 관찰</span>
          <span>성향별 기준 {decision.thresholdPercent}%</span>
          <span>{insight.engine} · 이 규칙 카드 LLM 미사용</span>
        </div>
        <div className="invest-insight-disclaimer">
          <Info size={15} /> 실제 입력의 결정 규칙 분석이며 미래 수익이나 투자 성공 확률을 예측하지
          않습니다.
        </div>
      </section>
      {insight.ai?.status === 'ready' ? (
        <section className="invest-card invest-ai-narrative" aria-label="Gemini AI 해석">
          <div className="invest-section-title">
            <div>
              <h2>
                <Sparkles size={18} /> Gemini AI 해석
              </h2>
              <p>
                Vertex AI · {insight.ai.model} · {insight.horizon.tradingDays}거래일 관찰 ·{' '}
                {kst(insight.ai.asOf)} KST
              </p>
            </div>
          </div>
          <p>{insight.ai.summary}</p>
          <h3>검토할 행동</h3>
          <ul className="invest-live-list">
            {insight.ai.actions.map((action, index) => (
              <li key={index}>{action}</li>
            ))}
          </ul>
          <h3>반대 시나리오</h3>
          <p>{insight.ai.counterScenario}</p>
          <h3>부족한 데이터</h3>
          {insight.ai.dataGaps.length ? (
            <ul className="invest-live-list">
              {insight.ai.dataGaps.map((gap, index) => (
                <li key={index}>{gap}</li>
              ))}
            </ul>
          ) : (
            <p className="invest-live-empty">
              모델이 추가 데이터 공백을 보고하지 않았습니다. 전체 데이터의 완전성을 뜻하지 않습니다.
            </p>
          )}
          <p className="invest-footnote">불확실성: {insight.ai.confidenceExplanation}</p>
          <div className="invest-event-evidence">
            {insight.ai.sources.map((source) => (
              <div key={source.id}>
                <span>
                  <strong>{source.title}</strong>
                  <small>근거 {source.id}</small>
                </span>
                {isHttpsUrl(source.url) && (
                  <a href={source.url} target="_blank" rel="noopener noreferrer">
                    원문 확인 ↗
                  </a>
                )}
              </div>
            ))}
          </div>
          <p className="invest-footnote">
            위 규칙 분석과 아래 출처에 근거한 모델 해석입니다. 추정과 해석에는 오류가 있을 수 있으며
            자동 주문이나 전략 변경을 수행하지 않습니다.
          </p>
        </section>
      ) : (
        <section className="invest-card invest-ai-pending" role="status">
          <h2>LLM 연결 대기</h2>
          <p>{insight.ai?.message ?? '이 응답에는 생성형 AI 해석이 포함되지 않았습니다.'}</p>
          <p className="invest-footnote">
            {insight.ai?.status === 'unavailable'
              ? 'AI 제공자 응답을 사용할 수 없습니다.'
              : 'AI 제공자 설정이 비활성화되었거나 준비되지 않았습니다.'}{' '}
            규칙 기반 분석은 별도로 확인할 수 있습니다.
          </p>
        </section>
      )}
      <div className="invest-evidence-grid">
        <section className="invest-card">
          <div className="invest-evidence-icon blue">
            <ChartNoAxesCombined size={22} />
          </div>
          <h3>차트 근거</h3>
          <p>
            {insight.horizon.tradingDays}거래일 변화 {metrics.returnPercent >= 0 ? '+' : ''}
            {metrics.returnPercent.toFixed(2)}%
          </p>
          <div className="invest-evidence-note">
            최근 종가 {metrics.latestClose.toLocaleString('ko-KR')}{' '}
            {evidence.market.candles.at(-1)?.currency ?? ''}
            <br />
            SMA20 {metrics.sma20.toFixed(2)} · RSI14 {metrics.rsi14.toFixed(1)}
            <br />
            가격 시각 {kst(metrics.latestTimestamp)} KST
          </div>
          <span className="invest-pill">{evidence.market.source}</span>
        </section>
        <section className="invest-card">
          <div className="invest-evidence-icon">
            <Newspaper size={22} />
          </div>
          <h3>등록 일정 근거</h3>
          <p>
            {evidence.calendar.from} ~ {evidence.calendar.to}
          </p>
          <div className="invest-evidence-note">
            관리자 출처 등록 일정 {evidence.calendar.events.length}건<br />
            등록 자료에는 공식 발표 뉴스가 포함될 수 있습니다. 뉴스는 발표 시각 기준이며 미래 일정이
            아닙니다.
          </div>
          <span className="invest-pill">{evidence.calendar.source}</span>
        </section>
        <section className="invest-card">
          <div className="invest-evidence-icon green">
            <Target size={22} />
          </div>
          <h3>내 전략 근거</h3>
          <p>
            {strategy.name} · {strategy.benchmark}
          </p>
          <div className="invest-evidence-note">
            투자 기간{' '}
            {/^[0-9]+$/.test(strategy.horizon) ? `${strategy.horizon}년` : strategy.horizon} ·{' '}
            {strategy.riskTolerance === 'low'
              ? '안정형'
              : strategy.riskTolerance === 'high'
                ? '성장형'
                : '균형형'}
            <br />
            {strategy.notes || '추가 선호 설정 없음'}
          </div>
          <span className="invest-pill">내 계정에 저장된 전략</span>
        </section>
      </div>
      {evidence.news && (
        <section className="invest-card invest-news-evidence" aria-label="공식 발표 뉴스 근거">
          <div className="invest-section-title">
            <div>
              <h2>공식 발표 뉴스 근거</h2>
              <p>
                {evidence.news.from} ~ {evidence.news.to} · 발표 시각 기준의 최근 뉴스{' '}
                {evidence.news.events.length}건
              </p>
            </div>
          </div>
          <p className="invest-footnote">
            미래 경제 일정이 아닙니다. 분류·중요도·영향 태그는 규칙 추정이며 전체 뉴스나 검증된 투자
            방향을 뜻하지 않습니다.
          </p>
          {evidence.news.coverageWarning && (
            <div className="invest-connection">
              <Info size={15} />
              <span>{evidence.news.coverageWarning}</span>
            </div>
          )}
          {evidence.news.truncated && (
            <p role="status">뉴스 조회 한도를 초과하여 일부 자료만 분석했습니다.</p>
          )}
          {evidence.news.relevanceRule && (
            <p className="invest-live-empty">뉴스 관련성 기준: {evidence.news.relevanceRule}</p>
          )}
          {evidence.news.events.length ? (
            <div className="invest-event-evidence">
              {evidence.news.events.map((news) => (
                <div key={news.id}>
                  <span>
                    <strong>{news.title}</strong>
                    <small>
                      발표 {news.date} {news.time} KST
                    </small>
                  </span>
                  <span>
                    <SourceLink url={news.sourceUrl}>{news.sourceName} ↗</SourceLink>
                    <small>확인 {kst(news.factualObservedAt)} KST</small>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="invest-live-empty">
              이 기간에 분석한 공식 발표 뉴스가 없습니다. 시장 위험이 없다는 뜻은 아닙니다.
            </p>
          )}
        </section>
      )}
      <section className="invest-card">
        <div className="invest-section-title">
          <div>
            <h2>일정 출처와 데이터 범위</h2>
            <p>등록된 일정은 전체 경제 일정이나 모든 뉴스의 목록이 아닙니다.</p>
          </div>
        </div>
        {evidence.calendar.coverageWarning && (
          <div className="invest-connection">
            <Info size={16} />
            <span>{evidence.calendar.coverageWarning}</span>
          </div>
        )}
        {evidence.calendar.relevanceRule && (
          <p className="invest-live-empty">일정 관련성 기준: {evidence.calendar.relevanceRule}</p>
        )}
        {typeof evidence.calendar.excludedCount === 'number' && (
          <p className="invest-live-empty">
            관련성 기준에 따라 제외한 일정: {evidence.calendar.excludedCount}건
          </p>
        )}
        {evidence.calendar.truncated && (
          <p role="status">일정 조회 한도를 초과하여 일부 일정만 분석했습니다.</p>
        )}
        {evidence.calendar.events.length === 0 ? (
          <p className="invest-live-empty">
            해당 기간에 등록된 일정이 없습니다. 일정 부재를 시장 위험이 없다는 뜻으로 해석하지
            않습니다.
          </p>
        ) : (
          <div className="invest-event-evidence">
            {evidence.calendar.events.map((event) => (
              <div key={event.id}>
                <span>
                  <strong>{event.title}</strong>
                  <small>
                    {event.date} {event.time} KST · 중요도 {event.importance}
                  </small>
                </span>
                <span>
                  <SourceLink url={event.sourceUrl}>{event.sourceName} ↗</SourceLink>
                  <small>확인 {kst(event.factualObservedAt)} KST</small>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      <div className="invest-detail-grid">
        <section className="invest-card">
          <h2>대안 시나리오</h2>
          <ul className="invest-live-list">
            {insight.scenarios.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </section>
        <section className="invest-card">
          <h2>위험과 불확실성</h2>
          <ul className="invest-live-list">
            {insight.risks.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </section>
      </div>
      <section className="invest-card">
        <h2>분석에 사용한 목표 비중</h2>
        <div className="invest-live-targets">
          {strategy.targetAllocations.map((item) => (
            <span key={item.asset}>
              <strong>{assetLabels[item.asset as keyof typeof assetLabels] || item.asset}</strong>
              {item.percentage}%
            </span>
          ))}
        </div>
        <p className="invest-footnote">
          저장된 목표 비중이며 현재 계좌 비중이 아닙니다. 통화 간 환산 합산은 하지 않습니다.
        </p>
        {insight.stockExposureByCurrency.map((group) => (
          <div className="invest-exposure" key={group.currency}>
            <strong>{group.currency} 주식 내 종목 비중</strong>
            {group.holdings.length === 0 ? (
              <span>해당 통화 보유 주식 없음</span>
            ) : (
              group.holdings.map((item) => (
                <span key={item.symbol}>
                  {item.symbol} {item.weightWithinStocksPercent.toFixed(2)}%
                </span>
              ))
            )}
          </div>
        ))}
      </section>
      <p className="invest-footnote">
        <Info size={15} /> 시세 조회 {kst(evidence.market.asOf)} KST ·{' '}
        {evidence.market.candles.length}개 가격 관측값. 규칙은 검증된 수익 예측 모델이 아니며 자동
        매매·전략 저장을 수행하지 않습니다.
      </p>
    </div>
  );
}
export function parseInsight(body: unknown, period: string): LiveInsight {
  const v = body as LiveInsight;
  if (
    v?.engine !== 'rules-v1' ||
    v.dataMode !== 'live' ||
    v.period !== period ||
    !v.metrics ||
    !v.decision ||
    !v.strategy ||
    !Array.isArray(v.evidence?.calendar?.events) ||
    !Array.isArray(v.risks) ||
    !Array.isArray(v.scenarios) ||
    !Array.isArray(v.stockExposureByCurrency)
  )
    throw new ApiError(502, 'INVALID_RESPONSE', '분석 응답 형식을 확인하지 못했습니다.');
  const ai = v.ai as Record<string, unknown> | undefined;
  if (
    ai?.status === 'ready' &&
    (!ai.model ||
      !Number.isFinite(Date.parse(String(ai.asOf))) ||
      typeof ai.summary !== 'string' ||
      typeof ai.counterScenario !== 'string' ||
      typeof ai.confidenceExplanation !== 'string' ||
      !Array.isArray(ai.actions) ||
      !ai.actions.every((item: unknown) => typeof item === 'string') ||
      !Array.isArray(ai.dataGaps) ||
      !ai.dataGaps.every((item: unknown) => typeof item === 'string') ||
      !Array.isArray(ai.sources) ||
      !ai.sources.every(
        (source: { id?: unknown; title?: unknown; url?: unknown }) =>
          typeof source?.id === 'string' &&
          typeof source.title === 'string' &&
          (source.url === undefined || typeof source.url === 'string'),
      ))
  )
    v.ai = {
      status: 'unavailable',
      type: 'llm',
      provider: 'vertex-claude',
      message: 'AI 해석의 응답 형식을 확인하지 못했습니다.',
    };
  return v;
}
export default function Recommendations() {
  const [period, setPeriod] = useState<keyof typeof periods>('daily');
  const [symbol, setSymbol] = useState('005930');
  // Analysis only runs on explicit request: each run costs Toss + Vertex quota and the
  // per-user limit is 3 per minute, so changing the inputs never fires a request by itself.
  const [requested, setRequested] = useState<{
    period: keyof typeof periods;
    symbol: string;
  } | null>(null);
  const { state, retry } = useApiResource(
    requested
      ? `/api/recommendations?period=${requested.period}&symbol=${encodeURIComponent(requested.symbol)}`
      : null,
    (body) => parseInsight(body, requested?.period ?? period),
  );
  const running = state.status === 'loading';
  const stale = requested !== null && (requested.period !== period || requested.symbol !== symbol);
  function run() {
    if (running) return;
    if (requested && !stale) retry();
    else setRequested({ period, symbol });
  }
  return (
    <div className="invest-page">
      <div className="invest-heading">
        <div>
          <div className="invest-eyebrow">INVESTMENT INTELLIGENCE</div>
          <h1>
            AI 인사이트 <Sparkles size={25} />
          </h1>
          <p>뉴스와 차트, 투자 원칙을 하나의 관점으로.</p>
        </div>
        <span className="invest-pill">내 데이터 · 규칙 분석 + 선택적 AI 해석</span>
      </div>
      <div className="invest-source-controls">
        <label>
          분석 종목
          <select
            aria-label="분석 종목"
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
          >
            <option value="005930">삼성전자 · 005930</option>
            <option value="000660">SK하이닉스 · 000660</option>
            <option value="AAPL">Apple · AAPL</option>
          </select>
        </label>
      </div>
      <div className="invest-connection">
        <ShieldCheck size={17} />
        <span>
          내 계정의 저장 전략, 토스 가격 및 출처가 등록된 자료를 서버에서 분석합니다. 생성형 AI가
          연결된 경우 근거를 포함한 해석을 별도 카드로 표시합니다. 소유자 계정 전용입니다.
        </span>
      </div>
      <div className="invest-recommend-toolbar">
        <div className="invest-segment invest-period">
          {Object.entries(periods).map(([key, item]) => (
            <button
              className={key === period ? 'active' : ''}
              key={key}
              onClick={() => setPeriod(key as keyof typeof periods)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button className="invest-primary" disabled={running} onClick={run}>
          {running ? '분석 중…' : '분석 실행'}
        </button>
        <span>
          기간·종목을 고른 뒤 실행하세요. 분석은 토스·AI 호출 한도(분당 3회)를 사용합니다.
        </span>
      </div>
      {state.status === 'idle' && (
        <section className="invest-card invest-live-state" role="status">
          <Sparkles size={24} />
          <h2>아직 분석하지 않았습니다</h2>
          <p>기간과 종목을 고르고 분석 실행을 누르면 내 데이터로 분석합니다.</p>
        </section>
      )}
      {running && (
        <LoadingState label="내 데이터를 분석하는 중입니다. 저장 전략, 가격 및 일정 근거를 확인합니다." />
      )}
      {state.status === 'issue' && <DataState issue={state.issue} onRetry={retry} />}
      {stale && state.status !== 'idle' && !running && (
        <div className="invest-connection" role="status">
          <Info size={17} />
          <span>
            선택이 바뀌었습니다. 아래 결과는 이전 선택({periods[requested!.period].label} ·{' '}
            {requested?.symbol}) 기준이며 분석 실행을 눌러야 갱신됩니다.
          </span>
        </div>
      )}
      {state.status === 'ready' && <LiveAnalysis insight={state.data} />}
    </div>
  );
}
