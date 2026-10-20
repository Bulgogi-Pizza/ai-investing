import { usePlotArea, useXAxisScale } from 'recharts';
import {
  importanceLabel,
  layoutEventLabels,
  textWidth,
  truncateLabel,
  type EventCluster,
} from '../../lib/chartEvents';

export const EVENT_TIERS = 3;
const LABEL_HEIGHT = 17;
const LABEL_FONT = 11;
const LABEL_MAX_WIDTH = 128;
const PADDING = 6;

export const importanceColor = { 3: '#c8374f', 2: '#d9822b', 1: '#7f8798' } as const;

export type EventAnchor = {
  /** Index into the cluster list. */
  index: number;
  /** Pixel position inside the chart (same frame as the chart container). */
  x: number;
  y: number;
};

/** Text of a cluster's label: the most important event, and how many others share the day. */
export function clusterLabel(cluster: EventCluster): string {
  const [top, ...rest] = cluster.events;
  return rest.length ? `${top.title} 외 ${rest.length}건` : top.title;
}

/**
 * SVG layer drawn inside the price chart: one dashed vertical line per event day with a label
 * above it. Labels are laid out so they never overlap (see layoutEventLabels); a day whose label
 * does not fit keeps its line and gets a small marker instead. Every label and marker is a
 * focusable button that opens the event tooltip (hover, focus, click or Enter).
 */
export function EventLayer({
  clusters,
  labels,
  activeIndex,
  onActivate,
  onLeave,
  onPin,
}: {
  clusters: EventCluster[];
  /** The chart rows' x-axis labels, by row index. */
  labels: string[];
  activeIndex: number | null;
  onActivate: (anchor: EventAnchor) => void;
  onLeave: () => void;
  onPin: (anchor: EventAnchor) => void;
}) {
  const xScale = useXAxisScale();
  const plot = usePlotArea();
  if (!xScale || !plot || !clusters.length) return null;
  const centers = clusters.map((cluster) =>
    xScale(labels[cluster.rowIndex], { position: 'middle' }),
  );
  const boxes = clusters.flatMap((cluster, index) => {
    const x = centers[index];
    if (x === undefined) return [];
    const text = truncateLabel(clusterLabel(cluster), LABEL_MAX_WIDTH);
    return [
      {
        id: String(index),
        x,
        width: textWidth(text) + PADDING * 2,
        priority: cluster.events[0].importance * 1000 + cluster.events.length,
      },
    ];
  });
  const { placed, hidden } = layoutEventLabels(
    boxes,
    { left: plot.x, right: plot.x + plot.width },
    EVENT_TIERS,
  );
  const placedBy = new Map(placed.map((label) => [Number(label.id), label]));
  const hiddenSet = new Set(hidden.map(Number));
  const anchorFor = (index: number, top: number): EventAnchor => ({
    index,
    x: centers[index]!,
    y: top,
  });
  return (
    <g className="event-layer">
      {clusters.map((cluster, index) => {
        const x = centers[index];
        if (x === undefined) return null;
        const top = cluster.events[0];
        const color = importanceColor[top.importance];
        const active = activeIndex === index;
        const label = placedBy.get(index);
        const tierY = label ? plot.y + 2 + label.tier * (LABEL_HEIGHT + 2) : plot.y + 3;
        const anchor = anchorFor(index, tierY + LABEL_HEIGHT);
        const description = `${cluster.rowDate} ${clusterLabel(cluster)} (중요도 ${importanceLabel(top.importance)})`;
        const props = {
          role: 'button' as const,
          tabIndex: 0,
          'aria-label': `이벤트: ${description}. 자세히 보려면 Enter`,
          'aria-expanded': active,
          'data-testid': 'event-anchor',
          'data-event-date': cluster.rowDate,
          onMouseEnter: () => onActivate(anchor),
          onMouseLeave: onLeave,
          onFocus: () => onActivate(anchor),
          onBlur: onLeave,
          onClick: () => onPin(anchor),
          onKeyDown: (event: React.KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onPin(anchor);
            }
          },
        };
        return (
          <g key={cluster.rowIndex} className={`event-mark${active ? ' active' : ''}`}>
            <line
              x1={x}
              x2={x}
              y1={plot.y}
              y2={plot.y + plot.height}
              stroke={color}
              strokeWidth={active ? 2 : 1.2}
              strokeDasharray="4 3"
              opacity={active ? 1 : 0.75}
            />
            {label && !hiddenSet.has(index) ? (
              <g {...props} className="event-label" style={{ cursor: 'pointer' }}>
                <rect
                  x={label.left}
                  y={tierY}
                  width={label.width}
                  height={LABEL_HEIGHT}
                  rx={4}
                  fill="#fff"
                  stroke={color}
                  strokeWidth={active ? 2 : 1}
                />
                <text
                  x={label.left + PADDING}
                  y={tierY + LABEL_HEIGHT - 5}
                  fontSize={LABEL_FONT}
                  fill={color}
                  fontWeight={600}
                >
                  {truncateLabel(clusterLabel(cluster), LABEL_MAX_WIDTH)}
                </text>
              </g>
            ) : (
              <g {...props} className="event-label" style={{ cursor: 'pointer' }}>
                {/* Larger invisible target keeps the small marker usable on touch screens. */}
                <circle cx={x} cy={plot.y + 8} r={11} fill="transparent" />
                <circle cx={x} cy={plot.y + 8} r={5} fill={color} stroke="#fff" strokeWidth={1.5} />
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
}
