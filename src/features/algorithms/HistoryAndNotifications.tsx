import { useState } from 'react';
import { Bell, History } from 'lucide-react';
import { DataState, LoadingState } from '../../components/DataState';
import type { AlgorithmEvent, AlgorithmRecord, Change } from '../../lib/algorithmRecords';
import { formatKst } from '../../lib/kst';
import { invalidResponse, isRecord, modeLabels, useLiveResource } from './shared';

const kindLabels: Record<AlgorithmEvent['kind'], string> = {
  created: '만듦',
  updated: '수정',
  deleted: '삭제',
  'emergency-stop': '긴급 정지 켬',
  'emergency-release': '긴급 정지 해제',
  'costs-updated': '수수료·세금 설정 변경',
  'safeguards-updated': '안전장치 설정 변경',
  'live-stop-released': '알고리즘 자동 정지 해제',
  'live-order-resolved': '미확인 주문 정리',
};
const fieldLabels: Record<Change['field'], string> = {
  name: '이름',
  method: '방식',
  template: '템플릿',
  market: '시장',
  targets: '대상 종목',
  signals: '신호·가중치',
  thresholds: '기준값',
  dualMomentum: '듀얼 모멘텀 설정',
  mode: '모드',
  budget: '운용 금액',
  emergencyStop: '긴급 정지',
  costs: '수수료·세금',
  safeguards: '안전장치',
  liveStop: '실전 자동 정지',
  liveOrder: '실전 주문',
};
const modeName = (value: string | null | undefined) =>
  value && value in modeLabels ? modeLabels[value as keyof typeof modeLabels] : (value ?? '없음');
const num = (value: string | null | undefined) =>
  value === null || value === undefined || value === ''
    ? '없음'
    : Number(value).toLocaleString('ko-KR');
export function describeChange(change: Change): string {
  const label = fieldLabels[change.field] ?? change.field;
  if (change.field === 'targets')
    return [
      change.added?.length ? `추가 ${change.added.join(', ')}` : '',
      change.removed?.length ? `제거 ${change.removed.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
      .replace(/^/, `${label}: `);
  if (change.field === 'mode') return `${label}: ${modeName(change.from)} → ${modeName(change.to)}`;
  if (change.field === 'budget') return `${label}: ${num(change.from)} → ${num(change.to)}`;
  return `${label}: ${change.from ?? '없음'} → ${change.to ?? '없음'}`;
}

type EventList = AlgorithmEvent[];
function parseEvents(body: unknown): EventList {
  const events = isRecord(body) ? body.events : null;
  if (
    !Array.isArray(events) ||
    !events.every(
      (e) =>
        isRecord(e) &&
        typeof e.id === 'string' &&
        typeof e.at === 'string' &&
        Array.isArray(e.changes),
    )
  )
    throw invalidResponse('변경 이력');
  return events as EventList;
}

export function HistoryList({
  algorithms,
  refreshKey,
}: {
  algorithms: AlgorithmRecord[];
  refreshKey: number;
}) {
  const { state, retry } = useLiveResource(
    '/api/algorithm-events?limit=50',
    parseEvents,
    refreshKey,
  );
  const [filter, setFilter] = useState('all');
  const events =
    state.status === 'ready'
      ? state.data.filter((e) => filter === 'all' || e.algorithmId === filter)
      : [];
  return (
    <section className="invest-card" aria-labelledby="algo-history-title">
      <div className="invest-section-title">
        <div>
          <h2 id="algo-history-title">
            <History size={18} aria-hidden="true" /> 변경 이력
          </h2>
          <p>
            대상 종목, 설정, 모드, 운용 금액, 긴급 정지 변경을 시각(KST)과 함께 남깁니다. 지울 수
            없는 기록입니다.
          </p>
        </div>
        <label className="algo-filter">
          <span className="invest-muted">보기</span>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="이력 알고리즘 필터"
          >
            <option value="all">전체</option>
            {algorithms.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {state.status === 'loading' && <LoadingState label="변경 이력을 불러오는 중…" compact />}
      {state.status === 'issue' && (
        <DataState
          issue={state.issue}
          onRetry={retry}
          title="변경 이력을 불러오지 못했습니다"
          compact
        />
      )}
      {state.status === 'ready' &&
        (events.length === 0 ? (
          <DataState
            issue={{ kind: 'no-data', message: '아직 기록된 변경이 없습니다.', retryable: false }}
            title="변경 이력이 없습니다"
            compact
          />
        ) : (
          <ol className="algo-history">
            {events.map((event) => (
              <li key={event.id}>
                <div>
                  <strong>{kindLabels[event.kind] ?? event.kind}</strong>
                  {event.algorithmName && (
                    <span className="algo-history-name"> · {event.algorithmName}</span>
                  )}
                  <time dateTime={event.at}> {formatKst(event.at)} KST</time>
                </div>
                {event.changes.length > 0 && (
                  <ul>
                    {event.changes.map((change, i) => (
                      <li key={i}>{describeChange(change)}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        ))}
    </section>
  );
}

type NotificationRow = {
  id: string;
  kind: string;
  mode?: 'paper' | 'live';
  createdAt: string;
  status: 'pending' | 'sent' | 'failed' | 'disabled';
  failureCode?: string;
  message: string;
};
const statusLabels: Record<NotificationRow['status'], string> = {
  sent: '발송됨',
  failed: '실패',
  disabled: '미설정',
  pending: '전송 중',
};
const failureLabels: Record<string, string> = {
  NOT_CONFIGURED: '텔레그램 미설정',
  TELEGRAM_TIMEOUT: '시간 초과',
  TELEGRAM_UNREACHABLE: '연결 실패',
  TELEGRAM_RATE_LIMITED: '전송 한도',
  TELEGRAM_REJECTED: '텔레그램이 거부',
  TELEGRAM_RESPONSE_INVALID: '응답 형식 오류',
  MESSAGE_INVALID: '메시지 오류',
  DELIVERY_ERROR: '전송 오류',
};
const kindNames: Record<string, string> = {
  fill: '체결',
  'algorithm-auto-stop': '자동 정지',
  'order-rejected': '주문 거부',
  'live-order-unconfirmed': '주문 접수 여부 미확인',
  'live-order-resolved': '미확인 주문 정리',
  'data-error': '데이터 오류',
  'job-failure': '작업 실패',
  'morning-brief': '아침 브리핑',
  'setting-risk-increase': '위험 증가 설정 변경',
};
function parseNotifications(body: unknown): NotificationRow[] {
  const list = isRecord(body) ? body.notifications : null;
  if (
    !Array.isArray(list) ||
    !list.every(
      (n) =>
        isRecord(n) &&
        typeof n.id === 'string' &&
        typeof n.createdAt === 'string' &&
        typeof n.message === 'string' &&
        ['pending', 'sent', 'failed', 'disabled'].includes(n.status as string),
    )
  )
    throw invalidResponse('알림 목록');
  return list as NotificationRow[];
}

export function NotificationsList({ refreshKey }: { refreshKey: number }) {
  const { state, retry } = useLiveResource(
    '/api/notifications?limit=20',
    parseNotifications,
    refreshKey,
  );
  return (
    <section className="invest-card" aria-labelledby="algo-notifications-title">
      <div className="invest-section-title">
        <div>
          <h2 id="algo-notifications-title">
            <Bell size={18} aria-hidden="true" /> 최근 알림
          </h2>
          <p>
            텔레그램으로 보낸(또는 보내지 못한) 알림의 기록입니다. 금액·수량·계좌 정보는 담지
            않습니다.
          </p>
        </div>
      </div>
      {state.status === 'loading' && <LoadingState label="알림 목록을 불러오는 중…" compact />}
      {state.status === 'issue' && (
        <DataState
          issue={state.issue}
          onRetry={retry}
          title="알림 목록을 불러오지 못했습니다"
          compact
        />
      )}
      {state.status === 'ready' &&
        (state.data.length === 0 ? (
          <DataState
            issue={{ kind: 'no-data', message: '아직 보낸 알림이 없습니다.', retryable: false }}
            title="알림이 없습니다"
            compact
          />
        ) : (
          <ul className="algo-notifications">
            {state.data.map((n) => (
              <li key={n.id}>
                <div className="algo-notification-head">
                  <span className={`algo-badge algo-status-${n.status}`}>
                    {statusLabels[n.status]}
                  </span>
                  {n.mode && (
                    <span
                      className={`algo-badge ${n.mode === 'live' ? 'algo-badge-live' : 'algo-badge-paper'}`}
                    >
                      {n.mode === 'live' ? '실전 · 실제 주문' : '모의 · 가상'}
                    </span>
                  )}
                  <strong>{kindNames[n.kind] ?? n.kind}</strong>
                  <time dateTime={n.createdAt}>{formatKst(n.createdAt)} KST</time>
                  {n.failureCode && (
                    <small className="invest-muted">
                      {failureLabels[n.failureCode] ?? n.failureCode}
                    </small>
                  )}
                </div>
                <pre>
                  {n.message
                    .split('\n')
                    .filter((line) => !line.startsWith('화면:'))
                    .join('\n')}
                </pre>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
