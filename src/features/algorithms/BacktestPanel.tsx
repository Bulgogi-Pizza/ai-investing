import { useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { FlaskConical, TriangleAlert } from 'lucide-react';
import { LoadingState } from '../../components/DataState';
import { ApiError, apiSend } from '../../lib/api';
import type { AlgorithmRecord, Currency } from '../../lib/algorithmRecords';
import type { BacktestResponse } from '../../server/algorithms';
import { isRecord, money, percent, signedPercent } from './shared';

export function parseBacktest(body: unknown): BacktestResponse {
  const b = body as BacktestResponse;
  if (
    !isRecord(body) ||
    b.simulation !== true ||
    !isRecord(b.metrics) ||
    !isRecord(b.costs) ||
    !isRecord(b.data) ||
    !isRecord(b.heldBack) ||
    !Array.isArray(b.equityCurve) ||
    !Array.isArray(b.trades) ||
    !Array.isArray(b.warnings) ||
    !Array.isArray(b.excludedSignals) ||
    !['KRW', 'USD'].includes(b.currency)
  )
    throw new ApiError(502, 'INVALID_RESPONSE', '시뮬레이션 응답 형식을 확인하지 못했습니다.');
  return b;
}

function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'positive' | 'negative';
}) {
  return (
    <div className="algo-metric">
      <span>{label}</span>
      <strong
        className={
          tone === 'positive' ? 'invest-positive' : tone === 'negative' ? 'invest-negative' : ''
        }
      >
        {value}
      </strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}
const tone = (value: number) => (value > 0 ? 'positive' : value < 0 ? 'negative' : undefined);

function EquityChart({ result }: { result: BacktestResponse }) {
  const currency = result.currency as Currency;
  const first = result.equityCurve[0]?.date;
  const last = result.equityCurve[result.equityCurve.length - 1]?.date;
  return (
    <figure className="algo-chart">
      <figcaption>
        시뮬레이션 자산 곡선 ({currency}) · 점선은 시작 금액 {money(result.budget, currency)}
      </figcaption>
      <div
        role="img"
        aria-label={`시뮬레이션 자산 곡선, ${first}부터 ${last}까지 ${result.equityCurve.length}개 지점`}
      >
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={result.equityCurve} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#eef0f6" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={36} />
            <YAxis
              tick={{ fontSize: 10 }}
              width={64}
              domain={['auto', 'auto']}
              tickFormatter={(v: number) =>
                currency === 'KRW' ? `${Math.round(v / 10000)}만` : `$${Math.round(v)}`
              }
            />
            <Tooltip
              formatter={(value) => [money(Number(value), currency), '시뮬레이션 자산']}
              labelFormatter={(label) => `${label} (거래소 날짜)`}
            />
            <ReferenceLine y={result.budget} stroke="#b9bfd0" strokeDasharray="4 4" />
            <Line
              type="monotone"
              dataKey="equity"
              stroke="#7860db"
              dot={false}
              strokeWidth={2}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

export function BacktestPanel({ record, dirty }: { record: AlgorithmRecord; dirty: boolean }) {
  const [slippage, setSlippage] = useState('0');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ algorithmId: string; data: BacktestResponse } | null>(
    null,
  );
  const isAi = record.method !== 'formula';
  const slippageValue = Number(slippage);
  const slippageValid =
    slippage.trim() !== '' &&
    Number.isFinite(slippageValue) &&
    slippageValue >= 0 &&
    slippageValue <= 500;

  async function run() {
    setRunning(true);
    setError('');
    try {
      const body = await apiSend('POST', `/api/algorithms/${record.id}/backtest`, {
        slippageBps: slippageValue,
      });
      setResult({ algorithmId: record.id, data: parseBacktest(body) });
    } catch (e) {
      setResult(null);
      setError(e instanceof ApiError ? e.message : '시뮬레이션을 실행하지 못했습니다.');
    } finally {
      setRunning(false);
    }
  }
  const shown = result && result.algorithmId === record.id ? result.data : null;
  const currency = (shown?.currency ?? record.currency) as Currency;

  return (
    <section className="invest-card algo-backtest" aria-labelledby="algo-backtest-title">
      <div className="invest-section-title">
        <div>
          <h2 id="algo-backtest-title">
            <FlaskConical size={18} aria-hidden="true" /> 과거 시뮬레이션
          </h2>
          <p>
            저장된 &quot;{record.name}&quot; 설정으로 토스 일봉을 다시 돌려 봅니다. 가상 계산이며
            실제 주문이나 체결이 아닙니다.
          </p>
        </div>
        <span className="algo-badge algo-badge-sim">시뮬레이션</span>
      </div>
      {isAi ? (
        <p className="algo-note">
          AI형은 과거 시뮬레이션을 지원하지 않습니다. AI 모델이 과거 결과를 이미 알고 있어 수익률이
          부풀려지기 때문입니다.
        </p>
      ) : (
        <div className="algo-backtest-controls">
          <label>
            슬리피지 (bp, 불리한 방향)
            <input
              type="number"
              min="0"
              max="500"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
              aria-invalid={slippageValid ? undefined : true}
            />
          </label>
          <button
            className="invest-primary"
            onClick={() => void run()}
            disabled={running || dirty || !slippageValid}
          >
            {running ? '실행 중…' : '시뮬레이션 실행'}
          </button>
          <small className="invest-muted">
            {dirty
              ? '저장하지 않은 변경이 있습니다. 저장한 뒤 실행하세요.'
              : '입력을 바꿀 때마다 자동으로 돌지 않습니다. 실행 버튼을 눌러야 계산합니다.'}
          </small>
        </div>
      )}
      {running && <LoadingState label="토스 일봉을 불러와 시뮬레이션하는 중…" compact />}
      {error && (
        <p role="alert" className="algo-note algo-note-error">
          {error}
        </p>
      )}
      {shown && <BacktestResult result={shown} currency={currency} />}
    </section>
  );
}

function BacktestResult({ result, currency }: { result: BacktestResponse; currency: Currency }) {
  const m = result.metrics;
  const c = result.costs;
  const bars = Object.values(result.data.barsPerSymbol);
  const minBars = bars.length ? Math.min(...bars) : 0;
  return (
    <div className="algo-result" aria-live="polite">
      <p className="algo-sim-banner">
        <TriangleAlert size={15} aria-hidden="true" /> 아래 숫자는 모두 시뮬레이션 결과입니다. 과거
        구간의 가상 계산이며 미래 수익을 보장하지 않습니다.
      </p>
      <dl className="algo-source">
        <div>
          <dt>데이터 출처</dt>
          <dd>
            {result.data.source} · 일봉(수정주가) · 종목별{' '}
            {minBars === Math.max(...bars) ? minBars : `${minBars}~${Math.max(...bars)}`}개 (최대{' '}
            {result.data.maxBarsPerSymbol}개)
          </dd>
        </div>
        <div>
          <dt>데이터 기간</dt>
          <dd>
            {result.data.start} ~ {result.data.end} (거래소 날짜) · 시뮬레이션 {result.period.start}{' '}
            ~ {result.period.end}, {result.period.tradingDays}거래일
          </dd>
        </div>
        <div>
          <dt>가정</dt>
          <dd>
            판단일 시가 지정가 체결, 슬리피지 {result.slippageBps}bp, 정수 주, 운용 금액{' '}
            {money(result.budget, currency)}
            {result.budgetAssumed ? ' (가정 금액)' : ''}
          </dd>
        </div>
      </dl>
      <div className="algo-badges" aria-label="시뮬레이션 제한 사항">
        <span className="algo-badge algo-badge-warn">수급·뉴스 신호 제외</span>
        {result.disabledSignals.includes('value') && (
          <span className="algo-badge algo-badge-warn">가치 신호 제외 (재무 연결 전)</span>
        )}
        {result.heldBack.insufficientHistory > 0 && (
          <span className="algo-badge algo-badge-info">
            예상 이익 기록 부족으로 보류 {result.heldBack.insufficientHistory}회
          </span>
        )}
        {result.heldBack.expectedBelowCost > 0 && (
          <span className="algo-badge algo-badge-info">
            예상 이익이 비용보다 작아 보류 {result.heldBack.expectedBelowCost}회
          </span>
        )}
        {result.researchOnly && (
          <span className="algo-badge algo-badge-warn">연구용 · 실전 판단에 쓰지 않음</span>
        )}
        {result.stoppedOn && (
          <span className="algo-badge algo-badge-warn">
            {result.stoppedOn} 누적 손실 한도로 정지
          </span>
        )}
      </div>
      <div className="algo-metrics">
        <Metric
          label="총수익 (비용 차감 전, 시뮬레이션)"
          value={signedPercent(m.totalReturn)}
          tone={tone(m.totalReturn)}
        />
        <Metric label="수수료 (시뮬레이션)" value={money(c.commission, currency)} />
        <Metric
          label="증권거래세 (시뮬레이션)"
          value={money(c.transactionTax, currency)}
          hint={result.costSettings.needsSetup.includes('sellTaxRate') ? '설정 필요' : undefined}
        />
        <Metric
          label="양도소득세 (시뮬레이션)"
          value={money(c.capitalGainsTax, currency)}
          hint={
            result.costSettings.needsSetup.includes('capitalGainsTax') ? '설정 필요' : undefined
          }
        />
        <Metric label="비용 합계 (시뮬레이션)" value={money(c.total, currency)} />
        <Metric
          label="비용 차감 후 수익 (시뮬레이션)"
          value={signedPercent(m.netReturn)}
          tone={tone(m.netReturn)}
          hint={`최종 자산 ${money(m.finalEquity, currency)}`}
        />
        <Metric
          label="최대 낙폭 (시뮬레이션)"
          value={percent(m.maxDrawdown)}
          tone={m.maxDrawdown > 0 ? 'negative' : undefined}
        />
        <Metric label="변동성 (연환산, 시뮬레이션)" value={percent(m.volatility)} />
        <Metric
          label="매매 횟수 (시뮬레이션)"
          value={`${m.trades}회`}
          hint={`왕복 ${m.roundTrips}회 · 승률 ${percent(m.winRate, 0)}`}
        />
      </div>
      {result.warnings.length > 0 && (
        <ul className="algo-warnings" aria-label="시뮬레이션 경고">
          {result.warnings.map((warning) => (
            <li key={warning} className={warning.startsWith('설정 필요') ? 'need-setup' : ''}>
              {warning}
            </li>
          ))}
        </ul>
      )}
      {result.equityCurve.length > 1 && <EquityChart result={result} />}
      {result.openPositions.length > 0 && (
        <p className="invest-muted">
          기간 끝 시점 가상 보유:{' '}
          {result.openPositions.map((p) => `${p.symbol} ${p.quantity}주`).join(', ')}
        </p>
      )}
      <details className="algo-trades">
        <summary>
          가상 매매 내역 {result.tradeCount}건
          {result.tradesTruncated ? ` (최근 ${result.trades.length}건만 표시)` : ''}
        </summary>
        {result.trades.length === 0 ? (
          <p className="invest-muted">가상 매매가 없었습니다.</p>
        ) : (
          <div className="invest-table-scroll">
            <table className="invest-table">
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>종목</th>
                  <th>구분</th>
                  <th>수량</th>
                  <th>가격</th>
                  <th>수수료</th>
                  <th>세금</th>
                </tr>
              </thead>
              <tbody>
                {result.trades.map((t, i) => (
                  <tr key={`${t.date}-${t.symbol}-${i}`}>
                    <td>{t.date}</td>
                    <td>{t.symbol}</td>
                    <td>{t.side === 'buy' ? '가상 매수' : '가상 매도'}</td>
                    <td>{t.quantity}</td>
                    <td>{money(t.price, currency)}</td>
                    <td>{money(t.commission, currency)}</td>
                    <td>{money(t.tax, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </div>
  );
}
