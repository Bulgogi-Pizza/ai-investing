import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Sparkles,
  ShieldCheck,
  Newspaper,
  ChartNoAxesCombined,
  Target,
  ChevronRight,
  FlaskConical,
  Info,
} from 'lucide-react';
import {
  assetKeys,
  assetLabels,
  analyzeStrategy,
  defensiveScenario,
  initialStrategy,
  parseStoredStrategy,
  type Strategy,
} from '../lib/strategy';
import { demoPrices, events, rsi } from '../lib/market';
import './investing.css';
const periods = {
  daily: {
    label: '데일리',
    horizon: '1 거래일',
    title: '변동성에 대비하며, 원칙은 유지하세요',
    text: '일간 변화가 투자 성향별 임계치를 넘는지 확인합니다. 신규 위험 노출을 늘리기 전 목표 비중과 현금 여력을 점검하는 규칙입니다.',
  },
  weekly: {
    label: '주간',
    horizon: '5 거래일',
    title: '단기 신호보다 자산 배분을 점검하세요',
    text: '한 주의 가격 움직임만으로 전략을 바꾸기보다 자산군 간 편중과 다음 주 일정에 대한 노출을 확인하는 시나리오입니다.',
  },
  monthly: {
    label: '월간',
    horizon: '1개월',
    title: '장기 목표에 맞춰 천천히 균형을 찾으세요',
    text: '투자 기간과 비교 지수를 다시 확인하고, 비용과 세금을 반영한 정기 리밸런싱 계획을 세우는 시나리오입니다.',
  },
};
type AiNarrative =
  | {
      status: 'ready';
      type: 'llm';
      provider: 'vertex';
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
      provider: 'vertex';
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
const kst = (date: string) => new Date(date).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
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
                {source.url?.startsWith('https://') && (
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
                    <a href={news.sourceUrl} target="_blank" rel="noopener noreferrer">
                      {news.sourceName} ↗
                    </a>
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
                  <a href={event.sourceUrl} target="_blank" rel="noopener noreferrer">
                    {event.sourceName} ↗
                  </a>
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
export default function Recommendations() {
  const [period, setPeriod] = useState<keyof typeof periods>('daily');
  const [scenario, setScenario] = useState(false);
  const [sourceMode, setSourceMode] = useState<'demo' | 'live'>('demo');
  const [symbol, setSymbol] = useState('005930');
  const [live, setLive] = useState<LiveInsight | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setLive(null);
    setLiveError('');
    setLiveLoading(false);
    if (sourceMode !== 'live') return;
    const controller = new AbortController();
    setLiveLoading(true);
    async function loadLive() {
      try {
        const response = await fetch(
          `/api/recommendations?period=${period}&symbol=${encodeURIComponent(symbol)}`,
          { signal: controller.signal },
        );
        const body = await response.json();
        if (!response.ok)
          throw new Error(
            typeof body.error?.message === 'string'
              ? body.error.message.slice(0, 400)
              : '내 데이터 분석을 불러오지 못했습니다.',
          );
        if (
          body.engine !== 'rules-v1' ||
          body.dataMode !== 'live' ||
          body.period !== period ||
          !body.metrics ||
          !body.decision ||
          !body.strategy ||
          !Array.isArray(body.evidence?.calendar?.events) ||
          !Array.isArray(body.risks) ||
          !Array.isArray(body.scenarios) ||
          !Array.isArray(body.stockExposureByCurrency)
        )
          throw new Error('분석 응답 형식을 확인하지 못했습니다.');
        if (
          body.ai?.status === 'ready' &&
          (!body.ai.model ||
            !Number.isFinite(Date.parse(body.ai.asOf)) ||
            typeof body.ai.summary !== 'string' ||
            typeof body.ai.counterScenario !== 'string' ||
            typeof body.ai.confidenceExplanation !== 'string' ||
            !Array.isArray(body.ai.actions) ||
            !body.ai.actions.every((item: unknown) => typeof item === 'string') ||
            !Array.isArray(body.ai.dataGaps) ||
            !body.ai.dataGaps.every((item: unknown) => typeof item === 'string') ||
            !Array.isArray(body.ai.sources) ||
            !body.ai.sources.every(
              (source: { id?: unknown; title?: unknown; url?: unknown }) =>
                typeof source?.id === 'string' &&
                typeof source.title === 'string' &&
                (source.url === undefined || typeof source.url === 'string'),
            ))
        ) {
          body.ai = {
            status: 'unavailable',
            type: 'llm',
            provider: 'vertex',
            message: 'AI 해석의 응답 형식을 확인하지 못했습니다.',
          };
        }
        if (!controller.signal.aborted) setLive(body);
      } catch (error) {
        if (!controller.signal.aborted)
          setLiveError(error instanceof Error ? error.message : '분석 요청에 실패했습니다.');
      } finally {
        if (!controller.signal.aborted) setLiveLoading(false);
      }
    }
    void loadLive();
    return () => controller.abort();
  }, [sourceMode, period, symbol, retry]);
  const [strategy, setStrategy] = useState<Strategy>(structuredClone(initialStrategy));
  const [strategySource, setStrategySource] = useState('예시 전략 · 연결 확인 중');
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const auth = await fetch('/api/auth/me', { signal: controller.signal });
        if (!auth.ok) {
          setStrategySource('예시 전략 · 로그인하지 않음');
          return;
        }
        const response = await fetch('/api/strategy', { signal: controller.signal });
        if (!response.ok) throw new Error('strategy unavailable');
        const parsed = parseStoredStrategy((await response.json()).strategy);
        if (parsed) {
          setStrategy(parsed);
          setStrategySource('내 계정에 저장된 전략');
        } else setStrategySource('예시 전략 · 저장된 유효 전략 없음');
      } catch {
        if (!controller.signal.aborted) setStrategySource('예시 전략 · 계정 전략을 불러오지 못함');
      }
    }
    void load();
    return () => controller.abort();
  }, []);
  const config = periods[period];
  const analysis = analyzeStrategy(
    demoPrices.map((item) => item.close),
    strategy,
    period,
  );
  const latestRsi = rsi(demoPrices.map((item) => item.close)).at(-1)!;
  const relevantEvents = events.filter(
    (item) =>
      item.day >= 20 && item.day < 20 + (period === 'daily' ? 1 : period === 'weekly' ? 7 : 31),
  );
  const importantEvents = relevantEvents.filter((item) => item.importance === 3);

  const adjusted = scenario ? defensiveScenario(strategy.targets) : strategy.targets;
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
        <span className="invest-demo">
          {sourceMode === 'demo'
            ? 'AI 연결 대기 · 규칙 기반 예시'
            : '내 데이터 · 규칙 분석 + 선택적 AI 해석'}
        </span>
      </div>
      <div className="invest-source-controls">
        <div className="invest-segment" aria-label="분석 데이터 선택">
          <button
            className={sourceMode === 'demo' ? 'active' : ''}
            onClick={() => setSourceMode('demo')}
          >
            합성 예시
          </button>
          <button
            className={sourceMode === 'live' ? 'active' : ''}
            onClick={() => setSourceMode('live')}
          >
            내 데이터 분석
          </button>
        </div>
        {sourceMode === 'live' && (
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
        )}
      </div>
      <div className="invest-connection">
        <ShieldCheck size={17} />
        <span>
          {sourceMode === 'demo' ? (
            <>시장 입력은 합성 데이터입니다. {strategySource} · 주문 없는 규칙 분석입니다.</>
          ) : (
            '내 계정의 저장 전략, 토스 가격 및 출처가 등록된 자료를 서버에서 분석합니다. 생성형 AI가 연결된 경우 근거를 포함한 해석을 별도 카드로 표시합니다.'
          )}
        </span>
      </div>
      <div className="invest-recommend-toolbar">
        <div className="invest-segment invest-period">
          {Object.entries(periods).map(([key, item]) => (
            <button
              className={key === period ? 'active' : ''}
              key={key}
              onClick={() => {
                setPeriod(key as keyof typeof periods);
                setScenario(false);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span>
          {sourceMode === 'demo'
            ? '예시 데이터 기준: 2026.10.20 09:00 KST'
            : '분석 기간과 종목을 바꾸면 다시 조회합니다.'}
        </span>
      </div>
      {sourceMode === 'live' ? (
        <>
          {liveLoading && (
            <section className="invest-card invest-live-state" role="status">
              <Sparkles size={24} />
              <h2>내 데이터를 분석하고 있습니다</h2>
              <p>저장 전략, 가격 및 일정 근거를 확인하는 중입니다.</p>
            </section>
          )}
          {liveError && (
            <section className="invest-card invest-live-state" role="alert">
              <Info size={24} />
              <h2>분석을 제공할 수 없습니다</h2>
              <p>{liveError}</p>
              <button className="invest-primary" onClick={() => setRetry((value) => value + 1)}>
                다시 시도
              </button>
              <small>실제 분석 실패 시 합성 추천으로 대체하지 않습니다.</small>
            </section>
          )}
          {!liveLoading && !liveError && live && <LiveAnalysis insight={live} />}
        </>
      ) : (
        <>
          <section className="invest-insight-hero">
            <div className="invest-insight-top">
              <span>
                <Sparkles size={16} /> {config.label} 전략 브리핑
              </span>
              <span>분석 기간 · {config.horizon}</span>
            </div>
            <h2>{analysis.action}</h2>
            <p>
              {config.text} {analysis.window}거래일 합성 시계열 변화{' '}
              {analysis.change >= 0 ? '+' : ''}
              {analysis.change.toFixed(2)}%, 목표 주식 {strategy.targets.stock}%를 함께 점검합니다.
            </p>
            <div className="invest-insight-tags">
              <span>
                {strategy.risk === 'conservative'
                  ? '안정형'
                  : strategy.risk === 'growth'
                    ? '성장형'
                    : '균형형'}{' '}
                투자자
              </span>
              <span>{strategy.horizon}년 투자 기간</span>
              <span>
                {strategySource}: 주식 {strategy.targets.stock}%
              </span>
            </div>
            <div className="invest-insight-disclaimer">
              <Info size={15} /> 규칙: 기간 수익률과 성향별 임계치 {analysis.threshold}%를
              비교합니다. 합성 차트 RSI {latestRsi.toFixed(1)} · 20일 평균 대비{' '}
              {analysis.deviation.toFixed(2)}%.
            </div>
          </section>
          <div className="invest-evidence-grid">
            <section className="invest-card">
              <div className="invest-evidence-icon">
                <Newspaper size={22} />
              </div>
              <h3>뉴스 관점</h3>
              <p>선택 기간의 중요 경제 일정 {importantEvents.length}건 점검</p>
              <div className="invest-evidence-note">
                합성 캘린더: {relevantEvents.length}건<br />
                {importantEvents[0]?.title || relevantEvents[0]?.title || '해당 예시 일정 없음'} ·
                외부 기사 미수집
              </div>
              <span className="invest-pill">가정 입력 · 뉴스 연결 대기</span>
            </section>
            <section className="invest-card">
              <div className="invest-evidence-icon blue">
                <ChartNoAxesCombined size={22} />
              </div>
              <h3>차트 관점</h3>
              <p>
                {analysis.window}거래일 변화 {analysis.change.toFixed(2)}%
              </p>
              <div className="invest-evidence-note">
                합성 가격으로 RSI {latestRsi.toFixed(1)} 계산
                <br />
                20일 평균 {analysis.average.toFixed(0)} · 실제 종목 시세 아님
              </div>
              <span className="invest-pill">합성 가격 계산 · 실시간 미연결</span>
            </section>
            <section className="invest-card">
              <div className="invest-evidence-icon green">
                <Target size={22} />
              </div>
              <h3>내 전략 관점</h3>
              <p>
                주식 목표 {strategy.targets.stock}% · {strategy.benchmark}
              </p>
              <div className="invest-evidence-note">
                {strategySource}
                <br />
                선호: {strategy.preferences.join(' · ') || '미지정'}
              </div>
              <span className="invest-pill">저장 출처에 따른 전략 계산</span>
            </section>
          </div>
          <section className="invest-card">
            <div className="invest-section-title">
              <div>
                <h2>
                  <FlaskConical size={20} /> 방어 시나리오 살펴보기
                </h2>
                <p>계정에 저장하기 전에, 이 화면에서 배분의 차이를 확인하세요.</p>
              </div>
              <span className="invest-pill">시뮬레이션 전용</span>
            </div>
            <div className="invest-scenario">
              <div>
                <h3>
                  {scenario
                    ? '주식 5%p를 채권과 현금으로 이동'
                    : '금리·변동성 위험이 커진다고 가정하면?'}
                </h3>
                <p>
                  선택된 전략에서 주식을 최대 5%p 줄이고, 채권 3%p와 현금 2%p를 더합니다. 시장
                  방향을 예측하지 않으며, 채권도 금리 상승 시 손실이 날 수 있습니다.
                </p>
                <button className="invest-primary" onClick={() => setScenario(!scenario)}>
                  {scenario ? '기본 예시로 되돌리기' : '배분 시나리오 적용'}
                  <ArrowRight size={16} />
                </button>
              </div>
              <div className="invest-scenario-bars">
                {assetKeys.map((key) => (
                  <div key={key}>
                    <span>{assetLabels[key]}</span>
                    <div>
                      <i style={{ width: `${adjusted[key]}%` }} />
                    </div>
                    <strong>
                      {strategy.targets[key]}% <ChevronRight size={13} /> {adjusted[key]}%
                    </strong>
                  </div>
                ))}
              </div>
            </div>
            <p className="invest-scenario-status" role="status">
              {scenario
                ? '시나리오 적용됨 · 이 화면의 예시 배분만 변경했습니다. 실제 전략 저장이나 매매는 수행하지 않습니다.'
                : '가정 배분은 버튼을 눌러 비교할 수 있습니다.'}
            </p>
          </section>
          <div className="invest-detail-grid">
            <section className="invest-card">
              <h2>판단의 전제와 위험</h2>
              <ul className="invest-risk-list">
                <li>
                  <strong>기간</strong>
                  <span>
                    {config.horizon} 관찰용 · 기본 투자 기간 {strategy.horizon}년 투자 기간
                  </span>
                </li>
                <li>
                  <strong>가정</strong>
                  <span>합성 차트·캘린더와 {strategySource}, 세금·수수료·환율 변동 제외</span>
                </li>
                <li>
                  <strong>불확실성</strong>
                  <span>예측 신뢰도 산정 불가 · 실시간 입력 및 검증된 모델 없음</span>
                </li>
                <li>
                  <strong>대안</strong>
                  <span>목표 비중 유지 또는 신규 납입으로 점진적 비중 조정</span>
                </li>
              </ul>
            </section>
            <section className="invest-card">
              <h2>데이터 출처</h2>
              <div className="invest-lineage">
                <div>
                  <i />
                  <span>
                    <strong>전략 출처</strong>
                    <small>{strategySource} · 계좌 잔고는 분석에 사용하지 않음</small>
                  </span>
                </div>
                <div>
                  <i />
                  <span>
                    <strong>전략 규칙</strong>
                    <small>비중 차이 계산 및 방어 배분 함수 · 로컬 결정 규칙</small>
                  </span>
                </div>
                <div>
                  <i />
                  <span>
                    <strong>시장·AI 모델 연결</strong>
                    <small>합성 가격/일정으로 계산 · 실뉴스·실시세·LLM 미연결</small>
                  </span>
                </div>
              </div>
            </section>
          </div>
          <p className="invest-footnote">
            <Info size={15} /> 투자 판단의 참고용 인터페이스 예시입니다. 실시간 추천은 데이터
            제공사와 AI 연결, 출처 검증 후 활성화됩니다. 주문 실행 기능은 제공하지 않습니다.
          </p>
        </>
      )}
    </div>
  );
}
