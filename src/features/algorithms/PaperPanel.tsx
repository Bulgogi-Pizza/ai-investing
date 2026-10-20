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
import { NotebookPen, TriangleAlert } from 'lucide-react';
import { DataState, LoadingState } from '../../components/DataState';
import type { AlgorithmRecord, Currency } from '../../lib/algorithmRecords';
import { formatKst } from '../../lib/kst';
import type { PaperResponse } from '../../server/paper';
import {
  invalidResponse,
  isRecord,
  money,
  percent,
  signedPercent,
  useLiveResource,
} from './shared';

export function parsePaper(body: unknown): PaperResponse {
  const b = body as PaperResponse;
  if (
    !isRecord(body) ||
    b.virtual !== true ||
    !isRecord(b.algorithm) ||
    !Array.isArray(b.trades) ||
    !Array.isArray(b.runs) ||
    !Array.isArray(b.equityCurve) ||
    !Array.isArray(b.notes) ||
    (b.ledger !== null && !isRecord(b.ledger)) ||
    (b.metrics !== null && !isRecord(b.metrics)) ||
    (b.ledger !== null && !Array.isArray(b.ledger.positions)) ||
    !['KRW', 'USD'].includes(b.algorithm.currency)
  )
    throw invalidResponse('모의 운용');
  return b;
}

// The generic virtual-record note is already the banner inside the result.
const isExtraNote = (note: string) => !note.startsWith('모의 운용은 가상 기록입니다');
const runResultLabel = { applied: '판단 완료', skipped: '건너뜀', failed: '실패' } as const;
const runStatusLabel = {
  running: '진행 중',
  complete: '완료',
  partial: '일부 실패',
  failed: '실패',
  skipped: '휴장',
} as const;
const tone = (value: number) => (value > 0 ? 'positive' : value < 0 ? 'negative' : undefined);

function Metric({
  label,
  value,
  hint,
  tone: toneName,
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
          toneName === 'positive'
            ? 'invest-positive'
            : toneName === 'negative'
              ? 'invest-negative'
              : ''
        }
      >
        {value}
      </strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

function PaperChart({
  data,
  currency,
  budget,
}: {
  data: PaperResponse;
  currency: Currency;
  budget: number;
}) {
  const first = data.equityCurve[0]?.date;
  const last = data.equityCurve[data.equityCurve.length - 1]?.date;
  return (
    <figure className="algo-chart">
      <figcaption>
        모의 운용 가상 자산 곡선 ({currency}) · 점선은 가상 시작 금액 {money(budget, currency)}
      </figcaption>
      <div
        role="img"
        aria-label={`모의 운용 가상 자산 곡선, ${first}부터 ${last}까지 ${data.equityCurve.length}개 지점`}
      >
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={data.equityCurve} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
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
              formatter={(value) => [money(Number(value), currency), '가상 자산']}
              labelFormatter={(label) => `${label} (거래소 날짜)`}
            />
            <ReferenceLine y={budget} stroke="#b9bfd0" strokeDasharray="4 4" />
            <Line
              type="monotone"
              dataKey="equity"
              stroke="#b88a1c"
              dot={data.equityCurve.length < 3}
              strokeWidth={2}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function PaperResult({ data }: { data: PaperResponse }) {
  const currency = data.algorithm.currency as Currency;
  const { ledger, metrics } = data;
  return (
    <div className="algo-result" aria-live="polite">
      <p className="algo-paper-banner">
        <TriangleAlert size={15} aria-hidden="true" />
        <span>
          아래 숫자는 모두 <strong>가상</strong> 기록입니다. 실제 주문과 체결이 아니며 실제 계좌
          잔고·보유에 영향이 없습니다. 미래 수익을 보장하지 않습니다.
        </span>
      </p>
      {ledger && (
        <>
          <div className="algo-badges" aria-label="모의 운용 상태">
            {ledger.status === 'stopped' ? (
              <span className="algo-badge algo-badge-live" data-testid="paper-stopped">
                {ledger.stoppedOn} 누적 손실 한도로 정지 (가상)
              </span>
            ) : (
              <span className="algo-badge algo-badge-paper">가상 운용 중</span>
            )}
            {data.ai && !data.ai.enabled && (
              <span className="algo-badge algo-badge-warn">{data.ai.message}</span>
            )}
          </div>
          <dl className="algo-source">
            <div>
              <dt>모의 시작일</dt>
              <dd>
                {ledger.startedOn} (거래소 날짜) · 마지막 판단일 {ledger.lastRunDate ?? '없음'}
              </dd>
            </div>
            <div>
              <dt>가상 금액</dt>
              <dd>
                시작 {money(ledger.budget, currency)} · 가상 현금 {money(ledger.cash, currency)}
              </dd>
            </div>
          </dl>
        </>
      )}
      {metrics && (
        <div className="algo-metrics">
          <Metric
            label="총수익 (비용 차감 전, 가상)"
            value={signedPercent(metrics.totalReturn)}
            tone={tone(metrics.totalReturn)}
            hint={`${metrics.since}부터 ${metrics.days}거래일`}
          />
          <Metric label="수수료 (가상)" value={money(metrics.costs.commission, currency)} />
          <Metric label="증권거래세 (가상)" value={money(metrics.costs.transactionTax, currency)} />
          <Metric
            label="양도소득세 (가상)"
            value={money(metrics.costs.capitalGainsTax, currency)}
          />
          <Metric
            label="비용 합계 (가상)"
            value={money(metrics.costs.total, currency)}
            hint={`슬리피지 ${money(metrics.costs.slippage, currency)}는 체결가에 이미 반영`}
          />
          <Metric
            label="비용 차감 후 수익 (가상)"
            value={signedPercent(metrics.netReturn)}
            tone={tone(metrics.netReturn)}
            hint={`가상 자산 ${money(metrics.equity, currency)}`}
          />
          <Metric
            label="최대 낙폭 (가상)"
            value={percent(metrics.maxDrawdown)}
            tone={metrics.maxDrawdown > 0 ? 'negative' : undefined}
          />
          <Metric
            label="변동성 (연환산, 가상)"
            value={percent(metrics.volatility)}
            hint={metrics.volatility === null ? '기록이 2일 이상 쌓이면 계산' : undefined}
          />
          <Metric
            label="가상 매매 횟수"
            value={`${metrics.fills}회`}
            hint={`왕복 ${metrics.roundTrips}회 · 승률 ${percent(metrics.winRate, 0)}`}
          />
          <Metric
            label="실현 손익 (가상)"
            value={money(metrics.realizedPnl, currency)}
            tone={tone(metrics.realizedPnl)}
          />
          <Metric
            label="평가 손익 (가상)"
            value={money(metrics.unrealizedPnl, currency)}
            tone={tone(metrics.unrealizedPnl)}
          />
        </div>
      )}
      {data.equityCurve.length > 1 && ledger && (
        <PaperChart data={data} currency={currency} budget={ledger.budget} />
      )}
      {ledger && (
        <section aria-label="가상 보유 종목">
          <h3 className="algo-subtitle">가상 보유</h3>
          {ledger.positions.length === 0 ? (
            <p className="invest-muted">가상으로 보유한 종목이 없습니다.</p>
          ) : (
            <div className="invest-table-scroll">
              <table className="invest-table">
                <thead>
                  <tr>
                    <th>종목</th>
                    <th>수량</th>
                    <th>가상 매수일</th>
                    <th>가상 매수가</th>
                    <th>최근 가격</th>
                    <th>평가 손익</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.positions.map((p) => (
                    <tr key={p.symbol}>
                      <td>{p.symbol}</td>
                      <td>{p.quantity}</td>
                      <td>{p.entryDate}</td>
                      <td>{money(p.entryPrice, currency)}</td>
                      <td>{money(p.markPrice, currency)}</td>
                      <td className={p.unrealizedPnl >= 0 ? 'invest-positive' : 'invest-negative'}>
                        {money(p.unrealizedPnl, currency)} ({signedPercent(p.unrealizedReturn)})
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      <details className="algo-trades" open={data.trades.length > 0 && data.trades.length <= 5}>
        <summary>가상 체결 내역 {data.trades.length}건 (최근순)</summary>
        {data.trades.length === 0 ? (
          <p className="invest-muted">아직 가상 체결이 없습니다.</p>
        ) : (
          <div className="invest-table-scroll">
            <table className="invest-table">
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>종목</th>
                  <th>구분</th>
                  <th>수량</th>
                  <th>가상 체결가</th>
                  <th>수수료</th>
                  <th>세금</th>
                  <th>근거</th>
                </tr>
              </thead>
              <tbody>
                {data.trades.map((t) => (
                  <tr key={t.id}>
                    <td>{t.date}</td>
                    <td>{t.symbol}</td>
                    <td>{t.side === 'buy' ? '가상 매수' : '가상 매도'}</td>
                    <td>{t.quantity}</td>
                    <td>{money(t.price, currency)}</td>
                    <td>{money(t.costs.commission, currency)}</td>
                    <td>{money(t.costs.tax, currency)}</td>
                    <td>{t.reasons.join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
      <details className="algo-trades" open={data.runs.length > 0 && data.runs.length <= 3}>
        <summary>판단 기록 {data.runs.length}회 (최근순)</summary>
        {data.runs.length === 0 ? (
          <p className="invest-muted">아직 이 알고리즘의 판단 기록이 없습니다.</p>
        ) : (
          <ul className="algo-runs">
            {data.runs.map((run) => (
              <li key={run.id}>
                <div className="algo-notification-head">
                  <strong>{run.date}</strong>
                  <span className="algo-badge algo-badge-paper">
                    {run.market === 'KR' ? '국내' : '미국'} · {runStatusLabel[run.status]}
                  </span>
                  <span
                    className={`algo-badge ${run.result.status === 'failed' ? 'algo-badge-warn' : 'algo-badge-info'}`}
                  >
                    {runResultLabel[run.result.status]}
                  </span>
                  <time dateTime={run.startedAt}>{formatKst(run.startedAt)}</time>
                </div>
                <p>
                  {run.result.reason ??
                    `가상 체결 ${run.result.fills}건 (매수 신호 ${run.result.decisions.buy}, 매도 신호 ${run.result.decisions.sell}, 보유 ${run.result.decisions.hold})`}
                </p>
                {run.result.status === 'applied' &&
                  (run.result.heldBack.insufficientHistory > 0 ||
                    run.result.heldBack.expectedBelowCost > 0) && (
                    <p className="invest-muted">
                      {run.result.heldBack.insufficientHistory > 0 &&
                        `예상 이익 기록 부족으로 매수 보류 ${run.result.heldBack.insufficientHistory}회. `}
                      {run.result.heldBack.expectedBelowCost > 0 &&
                        `예상 이익이 왕복 비용보다 작아 매수 보류 ${run.result.heldBack.expectedBelowCost}회.`}
                    </p>
                  )}
                {[...run.result.excludedSignals, ...run.result.notes].length > 0 && (
                  <ul>
                    {[...run.result.excludedSignals, ...run.result.notes].map((text) => (
                      <li key={text}>{text}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}

/**
 * 모의 운용: the virtual track record the daily paper job writes (stage 7c). Owner-only API. Every
 * figure is labeled 가상; nothing here is an order or a real fill.
 */
export function PaperPanel({
  record,
  refreshKey,
}: {
  record: AlgorithmRecord;
  refreshKey: number;
}) {
  const { state, retry } = useLiveResource(
    `/api/algorithms/${record.id}/paper`,
    parsePaper,
    refreshKey,
  );
  return (
    <section className="invest-card algo-paper" aria-labelledby="algo-paper-title">
      <div className="invest-section-title">
        <div>
          <h2 id="algo-paper-title">
            <NotebookPen size={18} aria-hidden="true" /> 모의 운용
          </h2>
          <p>
            오늘부터 실제 시세로 매일 개장 직후에 판단하고 <strong>가상 매매</strong>만 기록합니다.
            실제 주문은 나가지 않습니다.
          </p>
        </div>
        <span className="algo-badge algo-badge-paper">가상 기록</span>
      </div>
      {state.status === 'loading' && <LoadingState label="모의 운용 기록을 불러오는 중…" compact />}
      {state.status === 'issue' && (
        <DataState
          issue={state.issue}
          onRetry={retry}
          title="모의 운용 기록을 불러오지 못했습니다"
          compact
        />
      )}
      {state.status === 'ready' && (
        <>
          {state.data.ledger === null && (
            <p className="algo-note" data-testid="paper-empty">
              아직 모의 운용 기록이 없습니다. 모드가 &quot;모의&quot;인 알고리즘은 영업일 개장
              직후에 한 번씩 판단하고, 그 결과가 여기에 쌓입니다.
            </p>
          )}
          {state.data.notes.filter(isExtraNote).length > 0 && (
            <ul className="algo-warnings" aria-label="모의 운용 안내">
              {state.data.notes.filter(isExtraNote).map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          <PaperResult data={state.data} />
        </>
      )}
    </section>
  );
}
