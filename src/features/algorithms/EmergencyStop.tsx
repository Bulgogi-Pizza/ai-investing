import { useState } from 'react';
import { OctagonAlert, ShieldCheck } from 'lucide-react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ApiError, apiSend } from '../../lib/api';
import { formatKst } from '../../lib/kst';
import { invalidResponse, isRecord, useLiveResource } from './shared';

type Control = { emergencyStop: boolean; updatedAt: string | null };
type NotificationOutcome = { status: 'sent' | 'failed' | 'disabled'; failureCode?: string };
export function parseControl(body: unknown): Control {
  const control = isRecord(body) ? body.control : null;
  if (!isRecord(control) || typeof control.emergencyStop !== 'boolean')
    throw invalidResponse('긴급 정지 상태');
  return {
    emergencyStop: control.emergencyStop,
    updatedAt: typeof control.updatedAt === 'string' ? control.updatedAt : null,
  };
}
export const outcomeText = (outcome: NotificationOutcome | undefined) =>
  !outcome
    ? ''
    : outcome.status === 'sent'
      ? '텔레그램 알림을 보냈습니다.'
      : outcome.status === 'failed'
        ? '텔레그램 알림 전송에 실패했습니다. 아래 알림 목록에 기록되었습니다.'
        : '텔레그램이 설정되지 않아 알림을 보내지 못했습니다. 아래 알림 목록에만 기록되었습니다.';

/**
 * Always visible at the top of the algorithm screen. Stopping is one click plus a confirmation
 * and works even when the current state could not be loaded (it is idempotent and only reduces
 * risk). Releasing sends a Telegram alert.
 */
export function EmergencyStop({ onChanged }: { onChanged: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const { state, retry } = useLiveResource('/api/algorithm-control', parseControl, refresh);
  const [dialog, setDialog] = useState<'stop' | 'release' | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const control = state.status === 'ready' ? state.data : null;

  async function change(emergencyStop: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      const body = await apiSend('PUT', '/api/algorithm-control', { emergencyStop });
      parseControl(body);
      const outcome = (body as { notification?: NotificationOutcome }).notification;
      setMessage({
        kind: 'ok',
        text: emergencyStop
          ? '긴급 정지를 켰습니다. 모든 자동 매매가 멈춥니다.'
          : `긴급 정지를 해제했습니다. ${outcomeText(outcome)}`,
      });
      setDialog(null);
      setRefresh((value) => value + 1);
      onChanged();
    } catch (error) {
      setMessage({
        kind: 'error',
        text:
          error instanceof ApiError
            ? error.message
            : '요청을 처리하지 못했습니다. 상태를 확인한 뒤 다시 시도하세요.',
      });
      setDialog(null);
    } finally {
      setBusy(false);
    }
  }

  const stopped = control?.emergencyStop === true;
  return (
    <section
      className={`algo-stop ${stopped ? 'algo-stop-on' : ''}`}
      aria-label="긴급 정지"
      data-testid="emergency-stop"
    >
      <div className="algo-stop-state">
        {stopped ? (
          <OctagonAlert size={22} aria-hidden="true" />
        ) : (
          <ShieldCheck size={22} aria-hidden="true" />
        )}
        <div>
          <strong>
            {state.status === 'loading'
              ? '긴급 정지 상태를 확인하는 중…'
              : state.status === 'issue'
                ? '긴급 정지 상태를 불러오지 못했습니다'
                : stopped
                  ? '긴급 정지 중 — 모든 자동 매매가 멈춰 있습니다'
                  : '정상 — 긴급 정지가 꺼져 있습니다'}
          </strong>
          <small>
            {state.status === 'issue'
              ? `${state.issue.message} 정지는 상태를 몰라도 누를 수 있습니다.`
              : control?.updatedAt
                ? `마지막 변경 ${formatKst(control.updatedAt)} KST`
                : '모든 알고리즘의 자동 매매를 한 번에 끄는 스위치입니다.'}
          </small>
        </div>
      </div>
      <div className="algo-stop-actions">
        {stopped ? (
          <button className="button algo-release" onClick={() => setDialog('release')}>
            긴급 정지 해제
          </button>
        ) : (
          <button className="button primary danger" onClick={() => setDialog('stop')}>
            긴급 정지
          </button>
        )}
        {state.status === 'issue' && (
          <button className="button small" onClick={retry}>
            상태 다시 확인
          </button>
        )}
      </div>
      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={`algo-note algo-note-${message.kind}`}
        >
          {message.text}
        </p>
      )}
      {dialog === 'stop' && (
        <ConfirmDialog
          title="긴급 정지를 켤까요?"
          confirmLabel="긴급 정지 켜기"
          tone="danger"
          busy={busy}
          onConfirm={() => void change(true)}
          onCancel={() => setDialog(null)}
        >
          <p>모든 알고리즘의 자동 매매가 즉시 멈춥니다. 추가 인증 없이 바로 적용됩니다.</p>
        </ConfirmDialog>
      )}
      {dialog === 'release' && (
        <ConfirmDialog
          title="긴급 정지를 해제할까요?"
          confirmLabel="긴급 정지 해제"
          tone="danger"
          busy={busy}
          onConfirm={() => void change(false)}
          onCancel={() => setDialog(null)}
        >
          <p>해제하면 자동 매매가 다시 가능해집니다.</p>
          <p>
            <strong>해제하면 텔레그램으로 알림이 갑니다.</strong> 본인이 한 변경이 아니라면 해제하지
            말고 바로 긴급 정지를 유지하세요.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
