import { useEffect, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Eye,
  EyeOff,
  ShieldCheck,
  SlidersHorizontal,
  Wallet,
  Info,
} from 'lucide-react';
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import {
  assetKeys,
  assetLabels,
  initialStrategy,
  rebalance,
  validateTargets,
  parseStoredStrategy,
  type Strategy,
  type Targets,
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
const colors = ['#7c66e5', '#a698ef', '#e6c47a', '#cdd4df'];
const total = 128450000;
const current: Targets = { stock: 62, bond: 20, gold: 8, cash: 10 };
const holdings = [
  {
    name: '미국 대형주 ETF',
    code: 'S&P 500 · 예시',
    type: '주식',
    weight: 40,
    amount: 51380000,
    change: 8.42,
  },
  {
    name: '국내 주식 ETF',
    code: 'KOSPI 200 · 예시',
    type: '주식',
    weight: 22,
    amount: 28259000,
    change: 3.15,
  },
  {
    name: '국채 ETF',
    code: '중기 국채 · 예시',
    type: '채권',
    weight: 20,
    amount: 25690000,
    change: 1.82,
  },
  { name: '금 현물 ETF', code: '금 · 예시', type: '금', weight: 8, amount: 10276000, change: 6.28 },
  { name: '예수금', code: 'KRW · 예시', type: '현금', weight: 10, amount: 12845000, change: 0 },
];
export default function Portfolio() {
  const [hidden, setHidden] = useState(false);
  const [currency, setCurrency] = useState('KRW');
  const [strategy, setStrategy] = useState<Strategy>(structuredClone(initialStrategy));
  const [status, setStatus] = useState('연결 상태 확인 중…');
  const [notice, setNotice] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [live, setLive] = useState<LivePortfolio | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    async function check() {
      try {
        const auth = await fetch('/api/auth/me', { signal: controller.signal });
        if (!auth.ok) {
          setStatus('로그인 후 실제 자산 연결이 가능합니다.');
          return;
        }
        setAuthenticated(true);
        const saved = await fetch('/api/strategy', { signal: controller.signal });
        if (saved.ok) {
          const body = await saved.json();
          const parsed = parseStoredStrategy(body.strategy);
          if (parsed) setStrategy(parsed);
        }
        const response = await fetch('/api/portfolio', { signal: controller.signal });
        if (response.ok) {
          const data = await response.json();
          if (
            data.scope !== 'stocks-only' ||
            !data.totals?.KRW ||
            !data.totals?.USD ||
            !Array.isArray(data.holdings) ||
            !data.asOf
          )
            throw new Error('Unexpected provider schema');
          setLive(data);
          setStatus('토스증권 주식 잔고 조회 완료');
        } else
          setStatus(
            response.status === 503
              ? '토스 API 연결 준비 중 · 실제 자산을 불러오지 않았습니다.'
              : '자산 연결에 실패했습니다. 다시 시도해 주세요.',
          );
      } catch (error) {
        if (!controller.signal.aborted)
          setStatus('서버에 연결할 수 없습니다. 아래는 예시 데이터입니다.');
      }
    }
    void check();
    return () => controller.abort();
  }, []);
  const amount = (value: number) =>
    hidden
      ? '••••••'
      : currency === 'KRW'
        ? `${Math.round(value).toLocaleString('ko-KR')}원`
        : `$${(value / 1350).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const error = validateTargets(strategy.targets);
  const rows = error ? [] : rebalance(total, current, strategy.targets);
  async function saveStrategy() {
    if (error) return;
    if (!authenticated) {
      setNotice('예시 전략 적용 완료 · 서버 저장이나 실제 자산 변경은 없습니다.');
      return;
    }
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
  const strategyEditor = (
    <section className="invest-card">
      <div className="invest-section-title">
        <div>
          <h2>
            <SlidersHorizontal size={19} /> 나의 투자 전략
          </h2>
          <p>비중과 원칙을 정하면 리밸런싱 기준이 됩니다.</p>
        </div>
        <span className="invest-pill">{authenticated ? '내 계정 전략' : '시뮬레이션'}</span>
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
            (authenticated
              ? '저장 버튼을 누르면 내 계정에 전략을 저장합니다.'
              : '이 예시 전략은 현재 페이지의 메모리에서만 유지됩니다.')}
        </span>
        <button
          className="invest-primary"
          disabled={Boolean(error) || saving}
          onClick={() => void saveStrategy()}
        >
          {saving ? '저장 중…' : authenticated ? '내 전략 저장' : '예시 전략 적용'}
        </button>
      </div>
    </section>
  );
  if (live) {
    const liveMoney = (value: string | null, unit: string) =>
      hidden
        ? '••••••'
        : value === null
          ? '제공 안 됨'
          : `${Number(value).toLocaleString('ko-KR', { maximumFractionDigits: unit === 'USD' ? 2 : 0 })}${unit === 'KRW' ? '원' : ' USD'}`;
    return (
      <div className="invest-page">
        <div className="invest-heading">
          <div>
            <div className="invest-eyebrow">MY PORTFOLIO</div>
            <h1>내 자산</h1>
            <p>토스증권에서 조회한 주식 잔고입니다.</p>
          </div>
          <span className="invest-pill">실계좌 · 주식 전용</span>
        </div>
        <div className="invest-connection">
          <ShieldCheck size={17} />
          <span>
            {live.source} ·{' '}
            {new Date(live.asOf).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST
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
            <p>보유 주식이 없습니다.</p>
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
        {strategyEditor}
        <div className="invest-connection">
          <Info size={17} />
          <span>
            이 조회는 주식만 포함합니다. 현금·채권·금·다른 계좌는 포함하지 않으므로 전체 자산 비중
            및 리밸런싱 금액은 계산하지 않습니다.
          </span>
        </div>
        <p className="invest-footnote">
          조회 시점 이후 가격이 달라질 수 있습니다. 외화와 원화를 임의 환산하지 않습니다. 주문 실행
          기능은 없습니다.
        </p>
      </div>
    );
  }
  return (
    <div className="invest-page">
      <div className="invest-heading">
        <div>
          <div className="invest-eyebrow">MY PORTFOLIO</div>
          <h1>내 자산</h1>
          <p>지금의 자산을 살피고, 다음 목표를 설계하세요.</p>
        </div>
        <span className="invest-demo">예시 데이터 · 실제 계좌 아님</span>
      </div>
      <div className="invest-connection">
        <ShieldCheck size={17} />
        <span>{status}</span>
      </div>
      <div className="invest-portfolio-top">
        <section className="invest-card invest-total">
          <div className="invest-card-title">
            <span>
              총 보유 자산 <span className="invest-muted">DEMO</span>
            </span>
            <button
              className="invest-icon-button"
              aria-label={hidden ? '잔액 표시' : '잔액 숨기기'}
              onClick={() => setHidden(!hidden)}
            >
              {hidden ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <div className="invest-big-number">{amount(total)}</div>
          <div className="invest-positive">
            <ArrowUpRight size={17} /> 예시 평가수익 +{amount(7624000)}
          </div>
          <div className="invest-total-bottom">
            <span>예시 원금 {amount(total - 7624000)}</span>
            <div className="invest-segment" aria-label="표시 통화">
              {['KRW', 'USD'].map((c) => (
                <button
                  key={c}
                  className={currency === c ? 'active' : ''}
                  onClick={() => setCurrency(c)}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          {currency === 'USD' && <small>환산 예시: 1 USD = 1,350 KRW · 실시간 환율 아님</small>}
        </section>
        <section className="invest-card">
          <div className="invest-card-title">
            <span>자산 구성</span>
            <span className="invest-muted">예시 비중</span>
          </div>
          <div className="invest-allocation">
            <div
              className="invest-donut"
              role="img"
              aria-label="주식 62%, 채권 20%, 금 8%, 현금 10%"
            >
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie
                    data={assetKeys.map((key) => ({ name: assetLabels[key], value: current[key] }))}
                    dataKey="value"
                    innerRadius={53}
                    outerRadius={73}
                    paddingAngle={3}
                    stroke="none"
                  >
                    {assetKeys.map((key, index) => (
                      <Cell key={key} fill={colors[index]} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="invest-donut-label">
                <strong>4</strong>
                <small>자산군</small>
              </div>
            </div>
            <div className="invest-legend">
              {assetKeys.map((key, index) => (
                <div key={key}>
                  <span>
                    <i style={{ background: colors[index] }} />
                    {assetLabels[key]}
                  </span>
                  <strong>{current[key]}%</strong>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
      <div className="invest-metrics">
        <div className="invest-card">
          <span>최대 자산군 집중도</span>
          <strong>
            62<span>%</span>
          </strong>
          <small>주식 · 설정 목표 {strategy.targets.stock}%</small>
        </div>
        <div className="invest-card">
          <span>현금 비중</span>
          <strong>
            10<span>%</span>
          </strong>
          <small>
            목표 대비 {10 - strategy.targets.cash > 0 ? '+' : ''}
            {10 - strategy.targets.cash}%p
          </small>
        </div>
        <div className="invest-card">
          <span>가정 스트레스 손실</span>
          <strong className="invest-negative">−{amount(total * 0.126)}</strong>
          <small>주식 −20%, 채권 −3%, 금 +5% 가정</small>
        </div>
      </div>
      <section className="invest-card">
        <div className="invest-section-title">
          <div>
            <h2>보유 자산</h2>
            <p>분산 투자의 흐름을 한눈에</p>
          </div>
          <span className="invest-muted">가상 포트폴리오 · 5개 자산</span>
        </div>
        <div className="invest-table-scroll">
          <table className="invest-table">
            <thead>
              <tr>
                <th>자산</th>
                <th>자산군</th>
                <th>평가금액</th>
                <th>비중</th>
                <th>예시 수익률</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((item, index) => (
                <tr key={item.name}>
                  <td>
                    <div className="invest-holding">
                      <span
                        className="invest-asset-icon"
                        style={{ background: colors[index % 4] + '22', color: colors[index % 4] }}
                      >
                        {index + 1}
                      </span>
                      <span>
                        <strong>{item.name}</strong>
                        <small>{item.code}</small>
                      </span>
                    </div>
                  </td>
                  <td>{item.type}</td>
                  <td className="invest-tabular">{amount(item.amount)}</td>
                  <td>{item.weight}%</td>
                  <td className={item.change > 0 ? 'invest-positive' : ''}>
                    {item.change > 0 ? '+' : ''}
                    {item.change.toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {strategyEditor}
      <section className="invest-card">
        <div className="invest-section-title">
          <div>
            <h2>
              <Wallet size={19} /> 목표 비중과의 차이
            </h2>
            <p>예시 총자산 기준 · 거래 비용과 세금 제외</p>
          </div>
          <span className="invest-muted">주문 기능 없음</span>
        </div>
        {error ? (
          <p role="alert">유효한 목표 비중을 입력하면 계산 결과가 표시됩니다.</p>
        ) : (
          <div className="invest-rebalance">
            {rows.map((row) => (
              <div key={row.key}>
                <span>
                  {assetLabels[row.key]}{' '}
                  <small>
                    {row.current}% → {row.target}%
                  </small>
                </span>
                <strong
                  className={
                    row.amount > 0 ? 'invest-positive' : row.amount < 0 ? 'invest-negative' : ''
                  }
                >
                  {row.amount > 0 ? (
                    <ArrowUpRight size={16} />
                  ) : row.amount < 0 ? (
                    <ArrowDownRight size={16} />
                  ) : null}
                  {row.amount === 0
                    ? '목표 유지'
                    : `${row.amount > 0 ? '+' : '−'}${amount(Math.abs(row.amount))}`}
                </strong>
              </div>
            ))}
          </div>
        )}
      </section>
      <p className="invest-footnote">
        <Info size={15} /> 모든 금액·수익률은 화면 검증용 고정 예시입니다. 스트레스 손실은 과거
        최대낙폭이 아닌 가정 계산이며, 리밸런싱은 투자 권유나 주문이 아닙니다.
      </p>
    </div>
  );
}
