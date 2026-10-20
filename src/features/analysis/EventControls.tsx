import { DataState, LoadingState } from '../../components/DataState';
import type { Resource } from '../../lib/api';
import {
  EVENT_KINDS,
  EVENT_MARKETS,
  IMPORTANCE_LEVELS,
  toggleIn,
  type ChartEvent,
  type EventCluster,
  type EventFilter,
} from '../../lib/chartEvents';
import { formatKst } from '../../lib/kst';
import { EventItem } from './EventTooltip';
import type { EventSourceReport, EventsResponse } from './parsers';

const statusText = (source: EventSourceReport) => {
  switch (source.status) {
    case 'ok':
      return `${source.count}건`;
    case 'unavailable':
      return '미연결';
    case 'no-data':
      return '종목 없음';
    case 'error':
      return '오류';
    default:
      return '해당 없음';
  }
};

function Group<T extends string | number>({
  label,
  items,
  selected,
  onToggle,
  testId,
}: {
  label: string;
  items: { id: T; label: string }[];
  selected: ReadonlySet<T>;
  onToggle: (id: T) => void;
  testId: string;
}) {
  return (
    <div className="event-filter-group" role="group" aria-label={label}>
      <span className="event-filter-label">{label}</span>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          data-filter={`${testId}-${item.id}`}
          aria-pressed={selected.has(item.id)}
          onClick={() => onToggle(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 이벤트 필터 card: importance, kind and market filters (kept in memory only), the per-source
 * status of the last event request, and a text list of the drawn events (keyboard and screen-reader
 * access to every event, including those whose chart label did not fit).
 */
export function EventPanel({
  resource,
  retry,
  filter,
  onFilter,
  shown,
  clusters,
  outside,
  clamped,
  windowDays,
}: {
  resource: Resource<EventsResponse>;
  retry: () => void;
  filter: EventFilter;
  onFilter: (next: EventFilter) => void;
  /** Events that pass the filter. */
  shown: ChartEvent[];
  clusters: EventCluster[];
  /** Filtered events that fall outside the chart's trading days. */
  outside: number;
  /** The chart is longer than the 400 days events are read for. */
  clamped: boolean;
  windowDays: number | null;
}) {
  return (
    <section className="analysis-card" aria-label="이벤트 필터">
      <h2>이벤트 수직선</h2>
      <div className="event-filters">
        <Group
          label="중요도"
          testId="importance"
          items={IMPORTANCE_LEVELS}
          selected={filter.importance}
          onToggle={(id) => onFilter({ ...filter, importance: toggleIn(filter.importance, id) })}
        />
        <Group
          label="종류"
          testId="kind"
          items={EVENT_KINDS}
          selected={filter.kinds}
          onToggle={(id) => onFilter({ ...filter, kinds: toggleIn(filter.kinds, id) })}
        />
        <Group
          label="시장"
          testId="market"
          items={EVENT_MARKETS}
          selected={filter.markets}
          onToggle={(id) => onFilter({ ...filter, markets: toggleIn(filter.markets, id) })}
        />
      </div>
      {resource.status === 'loading' && <LoadingState compact label="이벤트를 불러오는 중…" />}
      {resource.status === 'issue' && (
        <DataState compact issue={resource.issue} onRetry={retry} scope="이벤트" />
      )}
      {resource.status === 'ready' && (
        <>
          <ul className="event-sources" aria-label="이벤트 출처 상태">
            {resource.data.sources
              .filter((source) => source.status !== 'not-applicable')
              .map((source) => (
                <li
                  key={source.id}
                  className={`event-source-chip ${source.status}`}
                  data-testid={`event-source-${source.id}`}
                  data-status={source.status}
                >
                  <strong>{source.name}</strong> {statusText(source)}
                  {source.status === 'error' && (
                    <button type="button" className="button small" onClick={retry}>
                      다시 시도
                    </button>
                  )}
                  {source.message && source.status !== 'unavailable' && (
                    <small> · {source.message}</small>
                  )}
                  {source.status === 'unavailable' && <small> · {source.message}</small>}
                </li>
              ))}
          </ul>
          <p className="muted" data-testid="event-summary">
            표시 {shown.length}건(차트 위 {clusters.length}일)
            {outside > 0 && ` · 거래일이 없는 구간 밖 ${outside}건 제외`} · 조회{' '}
            {formatKst(resource.data.asOf)} KST
            {resource.data.truncated && ' · 이벤트가 많아 일부만 받았습니다(최대 300건)'}
            {clamped &&
              ` · 이벤트는 최근 ${windowDays ?? 400}일까지만 조회합니다(차트 기간이 더 깁니다)`}
          </p>
          <p className="muted">{resource.data.notice}</p>
          {shown.length > 0 && (
            <details className="event-list">
              <summary>이벤트 목록 {shown.length}건 (날짜순)</summary>
              <ul>
                {shown.map((event) => (
                  <EventItem key={event.id} event={event} />
                ))}
              </ul>
            </details>
          )}
          {shown.length === 0 && (
            <p className="muted" role="status">
              선택한 조건에 맞는 이벤트가 이 구간에 없습니다.
            </p>
          )}
        </>
      )}
    </section>
  );
}
