import { forwardRef } from 'react';
import { SourceLink } from '../../components/SourceLink';
import {
  importanceLabel,
  kindLabel,
  marketLabel,
  type ChartEvent,
  type EventCluster,
} from '../../lib/chartEvents';
import { importanceColor } from './EventLayer';

export function EventItem({ event }: { event: ChartEvent }) {
  return (
    <li className="event-item">
      <div className="event-item-head">
        <span className="event-badge" style={{ borderColor: importanceColor[event.importance] }}>
          {importanceLabel(event.importance)}
        </span>
        <span className="event-meta">
          {kindLabel(event.kind)} · {marketLabel(event.market)} · {event.date}
        </span>
      </div>
      <div className="event-title">
        {event.title}
        {event.titleLanguage === 'original' && <small> (원문 표기)</small>}
      </div>
      <div className="event-source">
        출처:{' '}
        <SourceLink url={event.url} title={`${event.source} 원문 열기`}>
          {event.source}
        </SourceLink>
      </div>
    </li>
  );
}

/** Tooltip for one event day: every event of the day with its source link. Hover, focus or pinned. */
export const EventTooltip = forwardRef<
  HTMLDivElement,
  {
    cluster: EventCluster;
    /** Left edge in px inside the chart wrap. */
    left: number;
    top: number;
    pinned: boolean;
    onEnter: () => void;
    onLeave: () => void;
    onClose: () => void;
  }
>(function EventTooltip({ cluster, left, top, pinned, onEnter, onLeave, onClose }, ref) {
  const dated = cluster.events.some((event) => event.date !== cluster.rowDate);
  return (
    <div
      ref={ref}
      className="event-tooltip"
      role="dialog"
      aria-label={`${cluster.rowDate} 이벤트`}
      data-testid="event-tooltip"
      tabIndex={-1}
      style={{ left, top }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div className="event-tooltip-head">
        <strong>{cluster.rowDate}</strong>
        {pinned && (
          <button type="button" className="event-close" onClick={onClose} aria-label="이벤트 닫기">
            ×
          </button>
        )}
      </div>
      <ul>
        {cluster.events.map((event) => (
          <EventItem key={event.id} event={event} />
        ))}
      </ul>
      {dated && (
        <p className="muted">차트의 거래일이 아닌 날짜의 이벤트는 다음 거래일 위치에 그립니다.</p>
      )}
    </div>
  );
});
