import { useState } from 'react';
import { CircleAlert, CircleCheck, Radio, TriangleAlert } from 'lucide-react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DataState, LoadingState } from '../../components/DataState';
import type { AlgorithmRecord, Currency } from '../../lib/algorithmRecords';
import { ApiError, apiSend } from '../../lib/api';
import { formatKst } from '../../lib/kst';
import type { LiveResponse } from '../../server/live';
import { inputOfRecord } from './AlgorithmForm';
import { outcomeText } from './EmergencyStop';
import {
  invalidResponse,
  isRecord,
  money,
  percent,
  signedPercent,
  useLiveResource,
} from './shared';

export function parseLive(body: unknown): LiveResponse {
  const b = body as LiveResponse;
  if (
    !isRecord(body) ||
    b.live !== true ||
    !isRecord(b.algorithm) ||
    !isRecord(b.enable) ||
    !Array.isArray(b.enable.blockers) ||
    !isRecord(b.job) ||
    !isRecord(b.ledger) ||
    !Array.isArray(b.ledger.positions) ||
    !Array.isArray(b.orders) ||
    !Array.isArray(b.blocked) ||
    !Array.isArray(b.notes) ||
    typeof b.emergencyStop !== 'boolean' ||
    !['KRW', 'USD'].includes(b.algorithm.currency)
  )
    throw invalidResponse('실전 운용');
  return b;
}

const orderStatusLabel: Record<string, string> = {
  reserved: '전송 전(예약)',
  accepted: '접수됨',
  unknown: '접수 여부 미확인',
  rejected: '거부됨',
  'partially-filled': '일부 체결',
  filled: '체결',
  canceled: '취소됨',
};
const probeLabels: Record<string, string> = {
  buyingPowerKrw: '매수 가능 금액(원)',
  buyingPowerUsd: '매수 가능 금액(달러)',
  commissions: '수수료율',
  openOrders: '미체결 주문 목록',
};
const outcomeLabels: Record<string, string> = {
  ok: '정상 종료',
  partial: '일부 실패',
  failed: '실패',
  skipped: '건너뜀(휴장·개장 시간대 아님 등)',
};
const tone = (value: number) => (value > 0 ? 'positive' : value < 0 ? 'negative' : undefined);

function AccessCheck({ data }: { data: LiveResponse }) {
  const check = data.accessCheck;
  return (
    <div className="algo-live-block" data-testid="live-access-check">
      <h3 className="algo-subtitle">주문 권한 확인</h3>
      {check === null ? (
        <p className="algo-note algo-note-error" role="status">
          <CircleAlert size={15} aria-hidden="true" /> 아직 확인하지 않았습니다. 운영자가 읽기 전용
          확인 작업을 한 번 실행해야 합니다(실제 주문은 내지 않습니다).
        </p>
      ) : check.allOk ? (
        <p className="algo-note algo-note-ok" role="status">
          <CircleCheck size={15} aria-hidden="true" /> 읽기 확인 통과 ({formatKst(check.checkedAt)}{' '}
          KST): 매수 가능 금액·수수료율·미체결 주문 조회가 모두 응답했습니다.
        </p>
      ) : (
        <div className="algo-note algo-note-error" role="alert">
          <p>
            <TriangleAlert size={15} aria-hidden="true" /> 읽기 확인에 실패한 항목이 있습니다 (
            {formatKst(check.checkedAt)} KST).
            {check.permissionDenied && ' 증권사가 접근을 거부했습니다(인증·권한 문제).'}
          </p>
          <ul>
            {Object.entries(check.probes)
              .filter(([, probe]) => !probe.ok)
              .map(([key, probe]) => (
                <li key={key}>
                  {probeLabels[key] ?? key}: {probe.code ?? '확인 실패'}
                  {probe.status ? ` (HTTP ${probe.status})` : ''}
                </li>
              ))}
          </ul>
        </div>
      )}
      <p className="invest-muted">
        이 확인은 조회 API만 부릅니다. <strong>주문 권한 자체</strong>는 토스증권 WTS 설정 &gt; Open
        API 화면에서 직접 확인하세요. 권한 문제로 첫 주문이 거부되면 이 알고리즘은 자동 정지되고
        텔레그램으로 알립니다.
      </p>
    </div>
  );
}

function Summary({ data }: { data: LiveResponse }) {
  const s = data.paperSummary;
  const currency = data.algorithm.currency as Currency;
  return (
    <div className="algo-live-block" data-testid="live-paper-summary">
      <h3 className="algo-subtitle">모의 운용 요약 (가상 기록)</h3>
      {s === null ? (
        <p className="invest-muted">
          모의 운용 기록이 없습니다. 기록 없이도 켤 수 있지만, 예상 이익 기록이 없으면 매수 주문이
          나가지 않습니다.
        </p>
      ) : (
        <div className="algo-metrics">
          <div className="algo-metric">
            <span>모의 기간</span>
            <strong>
              {s.since} ~ {s.lastRunDate ?? s.since}
            </strong>
            <small>{s.days}거래일 판단</small>
          </div>
          <div className="algo-metric">
            <span>가상 왕복 횟수</span>
            <strong>{s.roundTrips}회</strong>
            <small>가상 매매 {s.fills}회</small>
          </div>
          <div className="algo-metric">
            <span>비용 차감 후 수익</span>
            <strong
              className={
                tone(s.netReturn) === 'positive'
                  ? 'invest-positive'
                  : tone(s.netReturn) === 'negative'
                    ? 'invest-negative'
                    : ''
              }
            >
              {signedPercent(s.netReturn)}
            </strong>
            <small>비용 합계 {money(s.costsTotal, currency)}</small>
          </div>
          <div className="algo-metric">
            <span>최대 낙폭</span>
            <strong className={s.maxDrawdown > 0 ? 'invest-negative' : ''}>
              {percent(s.maxDrawdown)}
            </strong>
            <small>가상 기록 기준</small>
          </div>
        </div>
      )}
      <p className="invest-muted" data-testid="live-hold-explain">
        <strong>&quot;기록 부족으로 주문 보류&quot;</strong>: 실전에서도 &quot;예상 이익 &gt; 왕복
        비용&quot; 규칙이 그대로 적용됩니다. 같은 점수 구간의 모의·시뮬레이션 왕복 기록이 충분하지
        않으면 켜 두어도 매수 주문이 나가지 않고, 그 이유를 아래 &quot;보류·차단 기록&quot;에 보여
        줍니다. 시스템이 정한 최소 기간이나 성과 기준은 없습니다. 위 숫자를 보고 직접 판단하세요.
      </p>
    </div>
  );
}

/**
 * 실전 운용: the live-enable panel and the live ledger (stage 7f). Everything here is a REAL order or
 * a real fill, labelled 실제 so it can never be mistaken for the 가상 records above it. Turning live on
 * needs a click and a confirmation (no extra authentication by decision); every risk-increasing
 * change is announced on Telegram by the server.
 */
export function LivePanel({
  record,
  dirty,
  refreshKey,
  onChanged,
}: {
  record: AlgorithmRecord;
  /** The form has unsaved edits: they are not part of what this panel enables. */
  dirty: boolean;
  refreshKey: number;
  onChanged: (saved: AlgorithmRecord, message: string) => void;
}) {
  const [reload, setReload] = useState(0);
  const { state, retry } = useLiveResource(
    `/api/algorithms/${record.id}/live`,
    parseLive,
    refreshKey + reload,
  );
  const [dialog, setDialog] = useState<'enable' | 'disable' | 'release' | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function setMode(mode: 'live' | 'paper') {
    setBusy(true);
    setMessage(null);
    try {
      const body = (await apiSend('PUT', `/api/algorithms/${record.id}`, {
        version: record.version,
        algorithm: { ...inputOfRecord(record), mode },
        ...(mode === 'live' ? { liveConfirm: true } : {}),
      })) as {
        algorithm: AlgorithmRecord;
        notifications?: { change: string; status: 'sent' | 'failed' | 'disabled' }[];
      };
      if (!body.algorithm?.id)
        throw new ApiError(502, 'INVALID_RESPONSE', '저장 응답 형식을 확인하지 못했습니다.');
      const alerts = (body.notifications ?? [])
        .map((n) => `${outcomeText(n)}`)
        .filter(Boolean)
        .join(' ');
      const text =
        mode === 'live'
          ? `실전을 켰습니다. 실제 주문은 운영자가 실전 일정을 켠 뒤 다음 개장 직후부터 나갑니다. ${alerts}`
          : '실전을 껐습니다. 이 알고리즘은 더 이상 주문하지 않습니다.';
      setMessage({ kind: 'ok', text });
      setDialog(null);
      onChanged(body.algorithm, text);
      setReload((v) => v + 1);
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof ApiError ? error.message : '변경하지 못했습니다. 다시 시도하세요.',
      });
      setDialog(null);
    } finally {
      setBusy(false);
    }
  }

  async function releaseStop() {
    setBusy(true);
    setMessage(null);
    try {
      const body = (await apiSend('POST', `/api/algorithms/${record.id}/live/release-stop`)) as {
        notification?: { status: 'sent' | 'failed' | 'disabled' };
      };
      setMessage({
        kind: 'ok',
        text: `자동 정지를 해제했습니다. ${outcomeText(body.notification)}`,
      });
      setDialog(null);
      setReload((v) => v + 1);
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof ApiError ? error.message : '정지를 해제하지 못했습니다.',
      });
      setDialog(null);
    } finally {
      setBusy(false);
    }
  }

  const isLive = record.mode === 'live';
  return (
    <section className="invest-card algo-live" aria-labelledby="algo-live-title">
      <div className="invest-section-title">
        <div>
          <h2 id="algo-live-title">
            <Radio size={18} aria-hidden="true" /> 실전 운용
          </h2>
          <p>
            <strong>실제 돈</strong>으로 자동 주문을 내는 단계입니다. 아래 주문·체결은 모두 실제
            기록이며 위의 가상(모의) 기록과 다릅니다.
          </p>
        </div>
        <span
          className={`algo-badge ${isLive ? 'algo-badge-live' : 'algo-badge-info'}`}
          data-testid="live-state-badge"
        >
          {isLive ? '실전 켜짐 · 실제 주문' : '실전 꺼짐'}
        </span>
      </div>
      {state.status === 'loading' && <LoadingState label="실전 운용 상태를 불러오는 중…" compact />}
      {state.status === 'issue' && (
        <DataState
          issue={state.issue}
          onRetry={retry}
          title="실전 운용 상태를 불러오지 못했습니다"
          compact
        />
      )}
      {state.status === 'ready' && (
        <LiveBody
          data={state.data}
          record={record}
          dirty={dirty}
          busy={busy}
          onEnable={() => setDialog('enable')}
          onDisable={() => setDialog('disable')}
          onRelease={() => setDialog('release')}
        />
      )}
      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={`algo-note algo-note-${message.kind}`}
        >
          {message.text}
        </p>
      )}
      {dialog === 'enable' && (
        <ConfirmDialog
          title={`"${record.name}"의 실전을 켤까요?`}
          confirmLabel="실전 켜기"
          tone="danger"
          busy={busy}
          onConfirm={() => void setMode('live')}
          onCancel={() => setDialog(null)}
        >
          <p>
            <strong>실제 돈으로 주문이 나갑니다.</strong> 운용 금액 한도는{' '}
            {record.budget === null ? '미설정' : money(record.budget, record.currency)}입니다.
          </p>
          <p>
            추가 인증 없이 바로 켜지며, 켜는 즉시 텔레그램으로 알림이 갑니다. 본인이 한 변경이
            아니면 위의 긴급 정지를 누르세요.
          </p>
          <p>
            실제 주문은 운영자가 실전 일정을 켠 뒤 개장 직후에 나갑니다. 모든 안전장치를 통과한
            주문만 나갑니다.
          </p>
        </ConfirmDialog>
      )}
      {dialog === 'disable' && (
        <ConfirmDialog
          title={`"${record.name}"의 실전을 끌까요?`}
          confirmLabel="실전 끄기 (모의로 전환)"
          busy={busy}
          onConfirm={() => void setMode('paper')}
          onCancel={() => setDialog(null)}
        >
          <p>모드가 모의로 바뀌고 새 주문이 나가지 않습니다.</p>
          <p>
            이미 보유한 수량이나 접수된 주문은 자동으로 정리되지 않습니다. 필요하면 토스증권 앱에서
            직접 처리하세요.
          </p>
        </ConfirmDialog>
      )}
      {dialog === 'release' && (
        <ConfirmDialog
          title="자동 정지를 해제할까요?"
          confirmLabel="정지 해제"
          tone="danger"
          busy={busy}
          onConfirm={() => void releaseStop()}
          onCancel={() => setDialog(null)}
        >
          <p>해제하면 이 알고리즘이 다시 실제 주문을 낼 수 있습니다.</p>
          <p>
            <strong>해제하면 텔레그램으로 알림이 갑니다.</strong> 정지 사유를 확인하지 않았다면
            해제하지 마세요.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function LiveBody({
  data,
  record,
  dirty,
  busy,
  onEnable,
  onDisable,
  onRelease,
}: {
  data: LiveResponse;
  record: AlgorithmRecord;
  dirty: boolean;
  busy: boolean;
  onEnable: () => void;
  onDisable: () => void;
  onRelease: () => void;
}) {
  const currency = data.algorithm.currency as Currency;
  const isLive = record.mode === 'live';
  const last = data.job.lastRun;
  return (
    <div className="algo-result" aria-live="polite">
      <ul className="algo-live-status" aria-label="실전 상태">
        {data.emergencyStop && (
          <li className="algo-note algo-note-error" data-testid="live-emergency-notice">
            <TriangleAlert size={15} aria-hidden="true" /> 긴급 정지 중이라 어떤 주문도 나가지
            않습니다.
          </li>
        )}
        {data.stop && (
          <li className="algo-note algo-note-error" data-testid="live-stopped-notice" role="alert">
            <div>
              <TriangleAlert size={15} aria-hidden="true" /> 이 알고리즘은 정지되어 있습니다:{' '}
              {data.stop.message}
              {data.stop.stoppedAt ? ` (${formatKst(data.stop.stoppedAt)} KST)` : ''}
            </div>
            <button className="button small" onClick={onRelease} disabled={busy}>
              정지 해제
            </button>
          </li>
        )}
        {isLive && data.job.schedulePaused && (
          <li className="algo-note algo-note-error" data-testid="live-schedule-notice">
            <CircleAlert size={15} aria-hidden="true" />{' '}
            {data.job.scheduleNotice ??
              '실전 일정이 아직 꺼져 있어 주문이 나가지 않습니다 — 운영자가 일정을 켜야 합니다.'}
          </li>
        )}
        {!isLive && data.job.schedulePaused && (
          <li className="algo-note" data-testid="live-schedule-notice">
            <CircleAlert size={15} aria-hidden="true" />{' '}
            {data.job.scheduleNotice ??
              '실전 일정이 아직 꺼져 있어 주문이 나가지 않습니다 — 운영자가 일정을 켜야 합니다.'}{' '}
            실전을 켜도 일정이 켜지기 전에는 주문이 나가지 않습니다.
          </li>
        )}
        {last && !data.job.schedulePaused && (
          <li className="algo-note algo-note-ok" data-testid="live-last-run">
            <CircleCheck size={15} aria-hidden="true" /> 실전 작업 마지막 실행 {formatKst(last.at)}{' '}
            KST — {outcomeLabels[last.outcome] ?? last.outcome}
            {last.code ? ` (${last.code})` : ''}
          </li>
        )}
        {data.unconfirmedCount > 0 && (
          <li className="algo-note algo-note-error" data-testid="live-unconfirmed-notice">
            <TriangleAlert size={15} aria-hidden="true" /> 접수 여부를 확인하지 못한 주문이{' '}
            {data.unconfirmedCount}건 있습니다. 토스증권 앱에서 주문 내역을 확인하세요. 확인될
            때까지 해당 종목의 새 주문은 나가지 않습니다.
          </li>
        )}
        {data.ai && !data.ai.enabled && (
          <li className="algo-note">AI형은 AI 비용 승인 대기 상태라 실전 주문도 하지 않습니다.</li>
        )}
      </ul>

      <AccessCheck data={data} />

      {!isLive && (
        <>
          <Summary data={data} />
          <div className="algo-live-block" data-testid="live-enable">
            <h3 className="algo-subtitle">실전 켜기</h3>
            <p>
              운용 금액 한도:{' '}
              <strong data-testid="live-budget">
                {data.algorithm.budget === null ? '미설정' : money(data.algorithm.budget, currency)}
              </strong>{' '}
              ({currency === 'KRW' ? '원' : '달러, 계좌의 달러만 사용'})
            </p>
            {data.enable.blockers.length > 0 ? (
              <ul className="algo-warnings" aria-label="실전을 켜기 전에 필요한 것">
                {data.enable.blockers.map((b) => (
                  <li key={b.code}>{b.message}</li>
                ))}
              </ul>
            ) : (
              <p className="algo-note algo-note-ok">켜기 위한 조건을 모두 충족했습니다.</p>
            )}
            {dirty && (
              <p className="algo-note">
                저장하지 않은 변경이 있습니다. 이 화면은 저장된 설정만 실전으로 켭니다.
              </p>
            )}
            <button
              className="button primary danger"
              disabled={!data.enable.ready || busy}
              onClick={onEnable}
            >
              실전 켜기…
            </button>
          </div>
        </>
      )}
      {isLive && (
        <div className="algo-live-block" data-testid="live-disable">
          <h3 className="algo-subtitle">실전 끄기</h3>
          <p>
            운용 금액 한도{' '}
            <strong>
              {data.algorithm.budget === null ? '미설정' : money(data.algorithm.budget, currency)}
            </strong>
            . 끄면 모드가 모의로 바뀌고 새 주문이 나가지 않습니다(추가 인증 없음).
          </p>
          <button className="button" disabled={busy} onClick={onDisable}>
            실전 끄기…
          </button>
        </div>
      )}

      <section aria-label="실제 보유 종목" className="algo-live-block">
        <h3 className="algo-subtitle">실제 보유 (이 알고리즘이 산 수량)</h3>
        {data.ledger.positions.length === 0 ? (
          <p className="invest-muted">이 알고리즘이 실제로 보유한 종목이 없습니다.</p>
        ) : (
          <div className="invest-table-scroll">
            <table className="invest-table">
              <thead>
                <tr>
                  <th>종목</th>
                  <th>실제 수량</th>
                  <th>평균 매수가</th>
                  <th>매도 주문 중</th>
                  <th>마지막 매수일</th>
                </tr>
              </thead>
              <tbody>
                {data.ledger.positions.map((p) => (
                  <tr key={p.symbol}>
                    <td>{p.symbol}</td>
                    <td>{p.quantity}</td>
                    <td>{p.averageCost === null ? '—' : money(p.averageCost, currency)}</td>
                    <td>{p.pendingSellQuantity}</td>
                    <td>{p.lastBuyDate ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="invest-muted">
          동원 중인 운용 금액(보유 원가 + 진행 중 매수): {money(data.ledger.committed, currency)}
        </p>
      </section>

      <details className="algo-trades" open={data.orders.length > 0 && data.orders.length <= 5}>
        <summary data-testid="live-orders-summary">
          실제 주문 {data.orders.length}건 (최근순)
        </summary>
        {data.orders.length === 0 ? (
          <p className="invest-muted">아직 실제 주문이 없습니다.</p>
        ) : (
          <div className="invest-table-scroll">
            <table className="invest-table" data-testid="live-orders">
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>종목</th>
                  <th>구분</th>
                  <th>주문 수량</th>
                  <th>지정가</th>
                  <th>체결 수량</th>
                  <th>평균 체결가</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.id}>
                    <td>{o.date}</td>
                    <td>{o.symbol}</td>
                    <td>
                      <span className="algo-badge algo-badge-live">
                        {o.side === 'buy' ? '실제 매수' : '실제 매도'}
                      </span>
                    </td>
                    <td>{o.quantity}</td>
                    <td>{money(o.price, currency)}</td>
                    <td>{o.filledQuantity}</td>
                    <td>
                      {o.averageFilledPrice === null ? '—' : money(o.averageFilledPrice, currency)}
                    </td>
                    <td>
                      {orderStatusLabel[o.status] ?? o.status}
                      {o.error && <small className="invest-muted"> · {o.error.message}</small>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
      <details className="algo-trades" open={data.blocked.length > 0 && data.blocked.length <= 5}>
        <summary>보류·차단 기록 {data.blocked.length}건 (주문이 나가지 않은 이유)</summary>
        {data.blocked.length === 0 ? (
          <p className="invest-muted">아직 보류·차단된 주문이 없습니다.</p>
        ) : (
          <ul className="algo-runs">
            {data.blocked.map((b) => (
              <li key={b.id}>
                <div className="algo-notification-head">
                  <strong>{b.date}</strong>
                  <span className="algo-badge algo-badge-info">
                    {b.symbol} · {b.side === 'buy' ? '매수 보류' : '매도 보류'}
                  </span>
                  <time dateTime={b.createdAt}>{formatKst(b.createdAt)}</time>
                </div>
                <ul>
                  {b.reasons.map((r) => (
                    <li key={r.code}>{r.message}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </details>
      <ul className="algo-warnings" aria-label="실전 운용 안내">
        {data.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
}
