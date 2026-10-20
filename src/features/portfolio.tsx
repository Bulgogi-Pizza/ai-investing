import { useState } from 'react';
import { Eye, EyeOff, ShieldCheck, SlidersHorizontal, Info } from 'lucide-react';
import { DataState, LoadingState } from '../components/DataState';
import { ApiError, signalAuthRequired, useApiResource } from '../lib/api';
import { formatKst } from '../lib/kst';
import {
  assetKeys,
  assetLabels,
  initialStrategy,
  validateTargets,
  parseStoredStrategy,
  type Strategy,
} from '../lib/strategy';
import './investing.css';

interface LivePortfolio {
  source: string;
  asOf: string;
  scope: 'stocks-only';
  totals: Record<
    'KRW' | 'USD',
    { marketValue: string | null; purchaseAmount: string | null; profitLoss: string | null }
  >;
  holdings: {
    symbol: string;
    name: string;
    market: string;
    currency: 'KRW' | 'USD';
    quantity: string;
    lastPrice: string;
    marketValue: string;
    profitLoss: string;
    profitLossRate: string;
  }[];
}
export function parsePortfolio(body: unknown): LivePortfolio {
  const data = body as LivePortfolio;
  if (
    data?.scope !== 'stocks-only' ||
    !data.totals?.KRW ||
    !data.totals?.USD ||
    !Array.isArray(data.holdings) ||
    !Number.isFinite(Date.parse(data.asOf))
  )
    throw new ApiError(502, 'INVALID_RESPONSE', '자산 응답 형식을 확인하지 못했습니다.');
  return data;
}
const colors = ['#7c66e5', '#a698ef', '#e6c47a', '#cdd4df'];
type LoadedStrategy = { strategy: Strategy; isNew: boolean };
export function parseStrategyResponse(body: unknown): LoadedStrategy {
  if (!body || typeof body !== 'object' || !('strategy' in body))
    throw new ApiError(502, 'INVALID_RESPONSE', '전략 응답 형식을 확인하지 못했습니다.');
  const stored = (body as { strategy: unknown }).strategy;
  if (stored === null) return { strategy: structuredClone(initialStrategy), isNew: true };
  const parsed = parseStoredStrategy(stored);
  // Never fall back to defaults for an unreadable stored strategy: saving would overwrite it.
  if (!parsed)
    throw new ApiError(
      502,
      'INVALID_RESPONSE',
      '저장된 전략을 읽지 못해 편집을 막았습니다. 저장하면 기존 전략을 덮어쓰므로 다시 시도해 주세요.',
    );
  return { strategy: parsed, isNew: false };
}
function StrategySection({ hideOwnerOnly }: { hideOwnerOnly: boolean }) {
  const { state, retry } = useApiResource('/api/strategy', parseStrategyResponse);
  if (state.status === 'loading' || state.status === 'idle')
    return <LoadingState label="저장된 전략을 불러오는 중…" />;
  if (state.status === 'issue')
    return state.issue.kind === 'owner-only' && hideOwnerOnly ? null : (
      <DataState issue={state.issue} onRetry={retry} title="내 전략을 불러오지 못했습니다" />
    );
  return <StrategyEditor initial={state.data.strategy} isNew={state.data.isNew} />;
}
/** Mounted only after the saved strategy (or an explicit null) arrived, so defaults never overwrite it. */
function StrategyEditor({ initial, isNew }: { initial: Strategy; isNew: boolean }) {
  const [strategy, setStrategy] = useState<Strategy>(() => structuredClone(initial));
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const error = validateTargets(strategy.targets);
  async function saveStrategy() {
    if (error) return;
    setSaving(true);
    try {
      const response = await fetch('/api/strategy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strategy: {
            name: '나의 투자 전략',
            horizon: String(strategy.horizon),
            benchmark: strategy.benchmark,
            riskTolerance:
              strategy.risk === 'conservative'
                ? 'low'
                : strategy.risk === 'growth'
                  ? 'high'
                  : 'medium',
            targetAllocations: assetKeys.map((key) => ({
              asset: key,
              percentage: strategy.targets[key],
            })),
            notes: strategy.preferences.join(' · '),
          },
        }),
      });
      if (response.status === 401) signalAuthRequired(401, 'AUTH_REQUIRED');
      setNotice(
        response.ok
          ? '내 계정에 전략을 저장했습니다. 실제 자산이나 주문은 변경되지 않습니다.'
          : '전략을 저장하지 못했습니다. 로그인과 서버 상태를 확인해 주세요.',
      );
    } catch {
      setNotice('서버 연결 실패로 저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="invest-card">
      <div className="invest-section-title">
        <div>
          <h2>
            <SlidersHorizontal size={19} /> 나의 투자 전략
          </h2>
          <p>비중과 원칙을 정하면 리밸런싱 기준이 됩니다.</p>
        </div>
        <span className="invest-pill">{isNew ? '새 전략 · 기본값' : '내 계정 전략'}</span>
      </div>
      <div className="invest-strategy-fields">
        <label>
          투자 성향
          <select
            value={strategy.risk}
            onChange={(e) => setStrategy({ ...strategy, risk: e.target.value })}
          >
            <option value="conservative">안정형</option>
            <option value="balanced">균형형</option>
            <option value="growth">성장형</option>
          </select>
        </label>
        <label>
          투자 기간
          <select
            value={strategy.horizon}
            onChange={(e) => setStrategy({ ...strategy, horizon: Number(e.target.value) })}
          >
            <option value={1}>1년</option>
            <option value={3}>3년</option>
            <option value={5}>5년 이상</option>
          </select>
        </label>
        <label>
          비교 지수
          <select
            value={strategy.benchmark}
            onChange={(e) => setStrategy({ ...strategy, benchmark: e.target.value })}
          >
            <option>S&P 500</option>
            <option>KOSPI 200</option>
            <option>글로벌 주식·채권 60/40</option>
          </select>
        </label>
      </div>
      <div className="invest-targets">
        {assetKeys.map((key, index) => (
          <label key={key}>
            <span>
              <i style={{ background: colors[index] }} />
              {assetLabels[key]}
            </span>
            <div>
              <input
                aria-label={`${assetLabels[key]} 목표 비중`}
                type="number"
                min="0"
                max="100"
                value={Number.isFinite(strategy.targets[key]) ? strategy.targets[key] : ''}
                onChange={(e) =>
                  setStrategy({
                    ...strategy,
                    targets: {
                      ...strategy.targets,
                      [key]: e.target.value === '' ? NaN : Number(e.target.value),
                    },
                  })
                }
              />
              <span>%</span>
            </div>
          </label>
        ))}
      </div>
      <div className="invest-preferences">
        {['분산 투자', '장기 성장', '배당 선호', '환위험 축소'].map((preference) => (
          <label key={preference}>
            <input
              type="checkbox"
              checked={strategy.preferences.includes(preference)}
              onChange={(e) =>
                setStrategy({
                  ...strategy,
                  preferences: e.target.checked
                    ? [...strategy.preferences, preference]
                    : strategy.preferences.filter((value) => value !== preference),
                })
              }
            />
            {preference}
          </label>
        ))}
      </div>
      <div className="invest-save">
        <span role="status" className={error ? 'invest-negative' : 'invest-muted'}>
          {error ||
            notice ||
            (isNew
              ? '저장된 전략이 없어 기본값으로 시작했습니다. 저장하면 새 전략이 만들어집니다.'
              : '저장 버튼을 누르면 내 계정에 전략을 저장합니다.')}
        </span>
        <button
          className="invest-primary"
          disabled={Boolean(error) || saving}
          onClick={() => void saveStrategy()}
        >
          {saving ? '저장 중…' : '내 전략 저장'}
        </button>
      </div>
    </section>
  );
}
export default function Portfolio() {
  const [hidden, setHidden] = useState(false);
  const { state, retry } = useApiResource('/api/portfolio', parsePortfolio);
  return (
    <div className="invest-page">
      <div className="invest-heading">
        <div>
          <div className="invest-eyebrow">MY PORTFOLIO</div>
          <h1>내 자산</h1>
          <p>토스증권에서 조회한 주식 잔고입니다. 소유자 계정 전용입니다.</p>
        </div>
        {state.status === 'ready' && <span className="invest-pill">실계좌 · 주식 전용</span>}
      </div>
      {(state.status === 'loading' || state.status === 'idle') && (
        <LoadingState label="토스증권 주식 잔고를 조회하는 중…" />
      )}
      {state.status === 'issue' && <DataState issue={state.issue} onRetry={retry} />}
      {state.status === 'ready' && (
        <PortfolioView live={state.data} hidden={hidden} setHidden={setHidden} />
      )}
      <StrategySection
        hideOwnerOnly={state.status === 'issue' && state.issue.kind === 'owner-only'}
      />
    </div>
  );
}

function PortfolioView({
  live,
  hidden,
  setHidden,
}: {
  live: LivePortfolio;
  hidden: boolean;
  setHidden: (value: boolean) => void;
}) {
  const liveMoney = (value: string | null, unit: string) =>
    hidden
      ? '••••••'
      : value === null
        ? '제공 안 됨'
        : `${Number(value).toLocaleString('ko-KR', { maximumFractionDigits: unit === 'USD' ? 2 : 0 })}${unit === 'KRW' ? '원' : ' USD'}`;
  return (
    <>
      <div className="invest-connection">
        <ShieldCheck size={17} />
        <span>
          {live.source} · {formatKst(live.asOf)} KST
        </span>
      </div>
      <div className="invest-portfolio-top">
        {(['KRW', 'USD'] as const).map((unit) => (
          <section key={unit} className="invest-card invest-total">
            <div className="invest-card-title">
              <span>{unit === 'KRW' ? '국내 주식' : '해외 주식'} 평가금액</span>
              <button
                className="invest-icon-button"
                aria-label={hidden ? '잔액 표시' : '잔액 숨기기'}
                onClick={() => setHidden(!hidden)}
              >
                {hidden ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <div className="invest-big-number">
              {liveMoney(live.totals[unit].marketValue, unit)}
            </div>
            <div>평가손익 {liveMoney(live.totals[unit].profitLoss, unit)}</div>
            <div className="invest-total-bottom">
              매입금액 {liveMoney(live.totals[unit].purchaseAmount, unit)}
            </div>
          </section>
        ))}
      </div>
      <section className="invest-card">
        <div className="invest-section-title">
          <div>
            <h2>보유 주식</h2>
            <p>통화별 원래 단위로 표시 · 환산 합계 없음</p>
          </div>
          <span className="invest-muted">{live.holdings.length}개 종목</span>
        </div>
        {live.holdings.length === 0 ? (
          <DataState
            issue={{
              kind: 'no-data',
              message: '토스 계좌에 보유 중인 국내·해외 주식이 없습니다.',
              retryable: false,
            }}
            title="보유 중인 주식이 없습니다"
            compact
          />
        ) : (
          <div className="invest-table-scroll">
            <table className="invest-table">
              <thead>
                <tr>
                  <th>종목</th>
                  <th>수량</th>
                  <th>현재가</th>
                  <th>평가금액</th>
                  <th>평가손익</th>
                  <th>수익률</th>
                </tr>
              </thead>
              <tbody>
                {live.holdings.map((item) => (
                  <tr key={`${item.market}-${item.symbol}`}>
                    <td>
                      <strong>{item.name}</strong>
                      <small> {item.symbol}</small>
                    </td>
                    <td>{hidden ? '••••' : item.quantity}</td>
                    <td>{liveMoney(item.lastPrice, item.currency)}</td>
                    <td>{liveMoney(item.marketValue, item.currency)}</td>
                    <td>{liveMoney(item.profitLoss, item.currency)}</td>
                    <td>
                      {hidden ? '••••' : `${(Number(item.profitLossRate) * 100).toFixed(2)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="invest-connection">
        <Info size={17} />
        <span>
          이 조회는 주식만 포함합니다. 현금·채권·금·다른 계좌는 포함하지 않으므로 전체 자산 비중 및
          리밸런싱 금액은 계산하지 않습니다.
        </span>
      </div>
      <p className="invest-footnote">
        조회 시점 이후 가격이 달라질 수 있습니다. 외화와 원화를 임의 환산하지 않습니다. 주문 실행
        기능은 없습니다.
      </p>
    </>
  );
}
