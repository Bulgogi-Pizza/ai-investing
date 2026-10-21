import { useState } from 'react';
import { OctagonAlert, TriangleAlert } from 'lucide-react';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ApiError, apiSend } from '../lib/api';
import { formatKst } from '../lib/kst';
import { outcomeText } from './algorithms/EmergencyStop';
import { invalidResponse, isRecord, useLiveResource } from './algorithms/shared';
import './budget.css';

export type BudgetView = {
  stopped: boolean;
  warned: boolean;
  stoppedAt: string | null;
  emergencyStop: boolean;
  enabled: boolean;
};
export function parseBudget(body: unknown): BudgetView {
  const budget = isRecord(body) ? body.budget : null;
  if (
    !isRecord(budget) ||
    typeof budget.stopped !== 'boolean' ||
    typeof budget.warned !== 'boolean' ||
    !isRecord(body) ||
    typeof body.emergencyStop !== 'boolean' ||
    typeof body.enabled !== 'boolean'
  )
    throw invalidResponse('월 예산 상태');
  return {
    stopped: budget.stopped,
    warned: budget.warned,
    stoppedAt: typeof budget.stoppedAt === 'string' ? budget.stoppedAt : null,
    emergencyStop: body.emergencyStop,
    enabled: body.enabled,
  };
}

/**
 * Top banner for the monthly budget stop (docs/operations/budget.md). The state endpoint is
 * owner-only: for anyone else (403) or while loading nothing is rendered.
 */
export default function BudgetBanner() {
  const [refresh, setRefresh] = useState(0);
  const { state } = useLiveResource('/api/ops/budget', parseBudget, refresh);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const budget = state.status === 'ready' ? state.data : null;

  async function release() {
    setBusy(true);
    try {
      const body = await apiSend('POST', '/api/ops/budget/release');
      const outcome = isRecord(body)
        ? (body.notification as Parameters<typeof outcomeText>[0])
        : undefined;
      setMessage({
        kind: 'ok',
        text: `월 예산 정지를 해제했습니다. 긴급 정지는 그대로이니 알고리즘 화면에서 직접 확인하세요. ${outcomeText(outcome)}`,
      });
      setConfirming(false);
      setRefresh((value) => value + 1);
    } catch (error) {
      setMessage({
        kind: 'error',
        text:
          error instanceof ApiError
            ? error.message
            : '요청을 처리하지 못했습니다. 상태를 확인한 뒤 다시 시도하세요.',
      });
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  if (!budget && !message) return null;
  return (
    <>
      {budget?.stopped && (
        <section
          className="budget-banner budget-banner-stop"
          role="alert"
          data-testid="budget-stop"
        >
          <OctagonAlert size={20} aria-hidden="true" />
          <div className="budget-banner-text">
            <strong>월 예산 한도(3만 원)에 도달해 예약 작업·AI·실전 주문을 멈췄습니다</strong>
            <small>
              사이트와 데이터는 그대로입니다.
              {budget.stoppedAt ? ` 멈춘 시각 ${formatKst(budget.stoppedAt)} KST.` : ''} 새 청구
              기간이 시작되면 예약 작업과 AI는 자동으로 다시 열리지만, 긴급 정지는 직접 해제해야
              합니다.
            </small>
          </div>
          <button className="button budget-release" onClick={() => setConfirming(true)}>
            월 예산 정지 해제
          </button>
        </section>
      )}
      {budget && !budget.stopped && budget.warned && (
        <section
          className="budget-banner budget-banner-warn"
          role="status"
          data-testid="budget-warn"
        >
          <TriangleAlert size={20} aria-hidden="true" />
          <div className="budget-banner-text">
            <strong>이번 달 클라우드 비용이 월 예산 경고 기준에 도달했습니다</strong>
            <small>한도(3만 원)에 도달하면 예약 작업·AI·실전 주문이 자동으로 멈춥니다.</small>
          </div>
        </section>
      )}
      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={`algo-note algo-note-${message.kind} budget-message`}
        >
          {message.text}
        </p>
      )}
      {confirming && (
        <ConfirmDialog
          title="월 예산 정지를 해제할까요?"
          confirmLabel="월 예산 정지 해제"
          tone="danger"
          busy={busy}
          onConfirm={() => void release()}
          onCancel={() => setConfirming(false)}
        >
          <p>이번 달 안에는 다시 자동으로 멈추지 않으므로 비용이 계속 늘 수 있습니다.</p>
          <p>
            긴급 정지는 해제되지 않습니다. 예약 작업과 AI가 다시 열리고,{' '}
            <strong>해제하면 텔레그램으로 알림이 갑니다.</strong>
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
