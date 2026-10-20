import { Loader, Lock, ShieldOff, SearchX, TriangleAlert, Unplug } from 'lucide-react';
import type { DataIssue } from '../lib/api';

const copy = {
  'not-connected': {
    icon: Unplug,
    title: '토스 계좌가 연결되지 않았습니다',
    text: '서버에 토스 API 연결 설정이 없어 실제 데이터를 받을 수 없습니다. 예시 값으로 대체하지 않습니다.',
    role: 'status',
  },
  'owner-only': {
    icon: Lock,
    title: '소유자 계정 전용 기능입니다',
    text: '이 화면의 실데이터는 토스 계좌를 연결한 소유자 계정에만 제공됩니다. 현재 계정에는 표시할 데이터가 없습니다.',
    role: 'status',
  },
  permission: {
    icon: ShieldOff,
    title: '토스 권한 없음',
    text: '토스 Open API 키에 이 데이터를 조회할 권한이 없습니다. 토스증권 Open API 권한 설정을 확인하세요. 값을 대신 만들어 보여 주지 않습니다.',
    role: 'status',
  },
  'no-data': {
    icon: SearchX,
    title: '표시할 데이터가 없습니다',
    text: '해당 종목 또는 조건에 대해 제공자가 돌려준 데이터가 없습니다.',
    role: 'status',
  },
  error: {
    icon: TriangleAlert,
    title: '일시적인 오류가 발생했습니다',
    text: '데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
    role: 'alert',
  },
} as const;

/** Shared explicit state for live data: not connected, owner only, no data, transient error. */
export function DataState({
  issue,
  onRetry,
  title,
  scope,
  compact = false,
}: {
  issue: DataIssue;
  onRetry?: () => void;
  /** Replaces the heading entirely. */
  title?: string;
  /** Names the part of the screen the state belongs to; shown before the standard heading. */
  scope?: string;
  compact?: boolean;
}) {
  const item = copy[issue.kind];
  const Icon = item.icon;
  // Server messages are already sanitized Korean text; fixed copy is the default for the rest.
  // Not-connected without the Toss code comes from another provider (DART, SEC): use its message.
  const otherProvider =
    issue.kind === 'not-connected' && issue.code && issue.code !== 'TOSS_INTEGRATION_UNAVAILABLE';
  const detail =
    issue.kind === 'error' || issue.kind === 'no-data' || otherProvider ? issue.message : item.text;
  const standard = otherProvider ? '데이터 제공자가 연결되지 않았습니다' : item.title;
  const heading = title ?? (scope ? `${scope} · ${standard}` : standard);
  return (
    <section
      className={`data-state data-state-${issue.kind}${compact ? ' data-state-compact' : ''}`}
      role={item.role}
      data-state={issue.kind}
    >
      <Icon size={compact ? 16 : 26} aria-hidden="true" />
      <div>
        <h2>{heading}</h2>
        <p>{detail}</p>
        {issue.kind === 'error' && onRetry && issue.retryable && (
          <button className="button small" onClick={onRetry}>
            다시 시도
          </button>
        )}
        {issue.kind === 'no-data' && onRetry && (
          <button className="button small" onClick={onRetry}>
            다시 조회
          </button>
        )}
      </div>
    </section>
  );
}

export function LoadingState({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <section
      className={`data-state data-state-loading${compact ? ' data-state-compact' : ''}`}
      role="status"
      aria-live="polite"
    >
      <Loader size={compact ? 14 : 22} aria-hidden="true" />
      <div>
        <p>{label}</p>
      </div>
    </section>
  );
}
