import { useEffect, useMemo, useRef, useState, type ReactElement, type SVGProps } from 'react';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ChartModel, ChartRow } from '../../lib/chartData';
import { indicatorDescriptions, type IndicatorId } from '../../lib/indicators';
import { formatPrice, type Currency } from '../../lib/format';
import type { EventCluster } from '../../lib/chartEvents';
import {
  compareKey,
  modeLabel,
  rebaseRows,
  sideLabel,
  type CompareDef,
  type Comparison,
  type FillMark,
} from '../../lib/compare';
import { EventLayer, type EventAnchor } from './EventLayer';
import { EventTooltip } from './EventTooltip';

const SYNC = 'analysis-chart';
const axisTick = { fontSize: 11, fill: '#6b7186' };
const grid = <CartesianGrid strokeDasharray="3 5" vertical={false} stroke="#eef0f4" />;

type LineSpec = { key: keyof ChartRow; name: string; color: string; dash?: string; width?: number };
const overlayLines: Partial<Record<IndicatorId, LineSpec[]>> = {
  sma: [{ key: 'sma', name: 'SMA 20', color: '#d9902b', width: 1.6 }],
  ema: [{ key: 'ema', name: 'EMA 20', color: '#3a86c4', width: 1.6 }],
  bollinger: [
    { key: 'bbUpper', name: '볼린저 상단', color: '#8493ab', dash: '4 4' },
    { key: 'bbLower', name: '볼린저 하단', color: '#8493ab', dash: '4 4' },
  ],
  ichimoku: [
    { key: 'tenkan', name: '전환선', color: '#d6455d', width: 1.3 },
    { key: 'kijun', name: '기준선', color: '#2f64c8', width: 1.3 },
    { key: 'chikou', name: '후행스팬', color: '#8a6fd8', dash: '3 3', width: 1.2 },
    { key: 'senkouA', name: '선행스팬 1', color: '#2f8f6b', width: 1 },
    { key: 'senkouB', name: '선행스팬 2', color: '#c8374f', width: 1 },
  ],
  vwap: [{ key: 'vwap', name: 'VWAP(표시 구간 시작부터 누적)', color: '#a84dc4', width: 1.6 }],
  keltner: [
    { key: 'kcMiddle', name: '켈트너 중심', color: '#8f8222', width: 1.3 },
    { key: 'kcUpper', name: '켈트너 상단', color: '#b3a53a', dash: '4 4' },
    { key: 'kcLower', name: '켈트너 하단', color: '#b3a53a', dash: '4 4' },
  ],
};

function priceFormatter(currency: Currency) {
  return (value: unknown): string => {
    if (Array.isArray(value)) return value.map((v) => priceFormatter(currency)(v)).join(' ~ ');
    const n = Number(value);
    return Number.isFinite(n) ? formatPrice(n, currency) : '';
  };
}
const plain =
  (digits = 2) =>
  (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('ko-KR', { maximumFractionDigits: digits }) : '';
  };
const axisPrice = (currency: Currency) => (value: number) =>
  currency === 'KRW'
    ? value.toLocaleString('ko-KR', { maximumFractionDigits: 0 })
    : value.toLocaleString('en-US', { maximumFractionDigits: 2 });

// Recharts calls a function `dot` with the point's position and row; draw only real SAR values.
function sarDot(props: unknown): ReactElement<SVGProps<SVGElement>> {
  const { cx, cy, payload, index } = props as {
    cx?: number;
    cy?: number;
    payload?: ChartRow;
    index?: number;
  };
  const key = `sar-${index}`;
  if (cx === undefined || cy === undefined || !payload || payload.sar === null)
    return <g key={key} />;
  return (
    <circle
      key={key}
      cx={cx}
      cy={cy}
      r={2.4}
      fill={payload.sarTrend === 'down' ? '#c8374f' : '#2f8f6b'}
    />
  );
}

export type CompareView = {
  comparison: Comparison;
  series: Pick<CompareDef, 'id' | 'label' | 'color'>[];
};

const markerPath = (side: 'buy' | 'sell') =>
  side === 'buy' ? 'M0,-7 L6,5 L-6,5 Z' : 'M0,7 L6,-5 L-6,-5 Z';
/** ▲ buy / ▼ sell. Virtual (paper) fills are hollow, real ones are filled. */
function fillShape(mark: FillMark) {
  return function Shape(props: unknown): ReactElement<SVGElement> {
    const { cx, cy } = props as { cx?: number; cy?: number };
    if (cx === undefined || cy === undefined) return <g />;
    const color = mark.side === 'buy' ? '#c8374f' : '#2f64c8';
    return (
      <g
        transform={`translate(${cx},${cy})`}
        data-testid="fill-mark"
        data-mode={mark.mode}
        data-side={mark.side}
      >
        <title>{`${modeLabel(mark.mode)} ${sideLabel(mark.side)} ${mark.date} ${mark.quantity}주 @ ${mark.price}`}</title>
        <path
          d={markerPath(mark.side)}
          fill={mark.mode === 'paper' ? '#fff' : color}
          stroke={color}
          strokeWidth={1.8}
        />
      </g>
    );
  };
}

/**
 * The price pane: close line, overlay indicators, the Ichimoku cloud and Fibonacci lines, plus the
 * 5d event lines and the 5e comparison overlay and own-trade marks. With `compare` set every
 * price-unit value is rebased to 100 at the comparison's base date.
 */
export function PriceChart({
  model,
  selected,
  currency,
  buyLine,
  sellLine,
  summary,
  compare = null,
  costLine = null,
  fillMarks = [],
  eventClusters = [],
}: {
  model: ChartModel;
  selected: ReadonlySet<IndicatorId>;
  currency: Currency;
  buyLine: number | null;
  sellLine: number | null;
  summary: string;
  compare?: CompareView | null;
  /** Average purchase price in price units (the page passes it only when it is near the prices). */
  costLine?: number | null;
  fillMarks?: FillMark[];
  eventClusters?: EventCluster[];
}) {
  const scale = compare ? compare.comparison.priceScale : 1;
  const rows = useMemo(
    () => (compare ? rebaseRows(model.rows, scale, compare.comparison) : model.rows),
    [compare, model.rows, scale],
  );
  const fmt = compare ? plain(2) : priceFormatter(currency);
  const wrap = useRef<HTMLDivElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [active, setActive] = useState<(EventAnchor & { pinned: boolean }) | null>(null);
  const labels = rows.map((row) => row.label);
  const clearHide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };
  const leave = () => {
    clearHide();
    hideTimer.current = setTimeout(
      () => setActive((current) => (current?.pinned ? current : null)),
      180,
    );
  };
  const returningFocus = useRef(false);
  const show = (anchor: EventAnchor) => {
    // Focus handed back after Esc must not reopen the tooltip it just closed.
    if (returningFocus.current) return;
    clearHide();
    setActive((current) => (current?.pinned ? current : { ...anchor, pinned: false }));
  };
  const pin = (anchor: EventAnchor) => {
    clearHide();
    setActive({ ...anchor, pinned: true });
  };
  const close = () => {
    const date = active ? eventClusters[active.index]?.rowDate : null;
    setActive(null);
    returningFocus.current = true;
    if (date) wrap.current?.querySelector<SVGElement>(`[data-event-date="${date}"]`)?.focus();
    returningFocus.current = false;
  };
  useEffect(() => {
    if (active?.pinned) tooltip.current?.focus();
  }, [active?.pinned, active?.index]);
  useEffect(() => clearHide, []);
  // A new event list or chart invalidates an open tooltip.
  useEffect(() => setActive(null), [eventClusters]);
  const wrapWidth = wrap.current?.clientWidth ?? 600;
  const tooltipWidth = Math.min(340, wrapWidth - 8);
  const activeCluster = active ? eventClusters[active.index] : undefined;
  const lines = (Object.keys(overlayLines) as IndicatorId[])
    .filter((id) => selected.has(id))
    .flatMap((id) => overlayLines[id] ?? []);
  const legend = [
    { name: compare ? '종가(기준 100)' : '종가', color: '#7460df' },
    ...lines.map((l) => ({ name: l.name, color: l.color })),
    ...(selected.has('ichimoku')
      ? [
          { name: '구름대(선행스팬 1≥2)', color: '#2f8f6b' },
          { name: '구름대(선행스팬 1<2)', color: '#c8374f' },
        ]
      : []),
    ...(selected.has('parabolicSar') ? [{ name: '파라볼릭 SAR(점)', color: '#2f8f6b' }] : []),
    ...(compare?.series.map((item) => ({ name: item.label, color: item.color })) ?? []),
    ...(costLine !== null ? [{ name: '내 평균 매수가', color: '#1f7a5c' }] : []),
    ...(fillMarks.length
      ? [{ name: '▲ 매수 ▼ 매도 (속이 빈 표시는 가상, 채운 표시는 실제)', color: '#c8374f' }]
      : []),
    ...(eventClusters.length ? [{ name: '점선 = 이벤트(색: 중요도)', color: '#d9822b' }] : []),
  ];
  const fib = model.fibonacci;
  return (
    <>
      <div className="analysis-chart-wrap" ref={wrap}>
        <div className="analysis-chart-main" role="group" aria-label={summary}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={rows}
              syncId={SYNC}
              margin={{ top: 12, right: 6, left: 0, bottom: 0 }}
            >
              {grid}
              <XAxis
                dataKey="label"
                minTickGap={36}
                interval="preserveStartEnd"
                tickLine={false}
                axisLine={false}
                tick={axisTick}
              />
              <YAxis
                domain={['auto', 'auto']}
                orientation="right"
                width={64}
                tickLine={false}
                axisLine={false}
                tick={axisTick}
                tickFormatter={compare ? (v: number) => v.toFixed(0) : axisPrice(currency)}
              />
              <Tooltip
                formatter={(value) => fmt(value)}
                contentStyle={{ borderRadius: 10, border: '1px solid #e9eaf0', fontSize: 12 }}
              />
              {selected.has('ichimoku') && (
                <>
                  <Area
                    dataKey="cloudUp"
                    name="구름대(선행스팬 1≥2)"
                    stroke="none"
                    fill="#2f8f6b"
                    fillOpacity={0.16}
                    isAnimationActive={false}
                  />
                  <Area
                    dataKey="cloudDown"
                    name="구름대(선행스팬 1<2)"
                    stroke="none"
                    fill="#c8374f"
                    fillOpacity={0.16}
                    isAnimationActive={false}
                  />
                </>
              )}
              <Line
                dataKey="close"
                name="종가"
                stroke="#7460df"
                strokeWidth={2.4}
                dot={false}
                isAnimationActive={false}
              />
              {compare?.series.map((item) => (
                <Line
                  key={item.id}
                  dataKey={compareKey(item.id)}
                  name={item.label}
                  stroke={item.color}
                  strokeWidth={1.8}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
              {lines.map((l) => (
                <Line
                  key={l.key}
                  dataKey={l.key}
                  name={l.name}
                  stroke={l.color}
                  strokeWidth={l.width ?? 1.2}
                  strokeDasharray={l.dash}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
              {selected.has('parabolicSar') && (
                <Line
                  dataKey="sar"
                  name="파라볼릭 SAR"
                  stroke="none"
                  dot={sarDot}
                  activeDot={false}
                  isAnimationActive={false}
                />
              )}
              {fib?.levels.map((level) => (
                <ReferenceLine
                  key={level.ratio}
                  y={level.price * scale}
                  stroke="#9b8bd0"
                  strokeDasharray="2 4"
                  label={{
                    value: `${level.label} ${fmt(level.price * scale)}`,
                    position: 'insideTopLeft',
                    fontSize: 11,
                    fill: '#6a58b5',
                  }}
                />
              ))}
              {buyLine !== null && (
                <ReferenceLine
                  y={buyLine * scale}
                  label={{ value: '매수 검토선', position: 'insideBottomLeft', fontSize: 11 }}
                  stroke="#26a18b"
                  strokeDasharray="5 5"
                />
              )}
              {sellLine !== null && (
                <ReferenceLine
                  y={sellLine * scale}
                  label={{ value: '매도 검토선', position: 'insideTopLeft', fontSize: 11 }}
                  stroke="#ef7b7e"
                  strokeDasharray="5 5"
                />
              )}
              {costLine !== null && (
                <ReferenceLine
                  y={costLine * scale}
                  ifOverflow="extendDomain"
                  stroke="#1f7a5c"
                  strokeWidth={1.6}
                  strokeDasharray="8 3"
                  label={{
                    value: `내 평균 매수가 ${compare ? fmt(costLine * scale) : fmt(costLine)}`,
                    position: 'insideBottomRight',
                    fontSize: 11,
                    fill: '#1f7a5c',
                  }}
                />
              )}
              {fillMarks.map((mark) => {
                const row = rows[mark.rowIndex];
                if (!row) return null;
                return (
                  <ReferenceDot
                    key={mark.id}
                    x={row.label}
                    y={mark.priceNumber * scale}
                    ifOverflow="extendDomain"
                    r={6}
                    shape={fillShape(mark)}
                  />
                );
              })}
              {eventClusters.length > 0 && (
                <EventLayer
                  clusters={eventClusters}
                  labels={labels}
                  activeIndex={active?.index ?? null}
                  onActivate={show}
                  onLeave={leave}
                  onPin={pin}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {activeCluster && active && (
          <EventTooltip
            ref={tooltip}
            cluster={activeCluster}
            left={Math.max(4, Math.min(active.x - tooltipWidth / 2, wrapWidth - tooltipWidth - 4))}
            top={active.y + 6}
            pinned={active.pinned}
            onEnter={clearHide}
            onLeave={leave}
            onClose={close}
          />
        )}
      </div>
      <ul className="legend-row" aria-label="범례">
        {legend.map((item) => (
          <li key={item.name}>
            <i style={{ background: item.color }} aria-hidden="true" />
            {item.name}
          </li>
        ))}
        {fib && (
          <li>
            <i style={{ background: '#9b8bd0' }} aria-hidden="true" />
            피보나치 되돌림(표시 구간 고가 {fmt(fib.high)} · 저가 {fmt(fib.low)},{' '}
            {fib.direction === 'up' ? '상승 후 되돌림' : '하락 후 반등'})
          </li>
        )}
      </ul>
    </>
  );
}

const paneIds: IndicatorId[] = ['rsi', 'macd', 'stochastic', 'atr', 'obv', 'adx', 'cci'];
export const separatePanes = (selected: ReadonlySet<IndicatorId>) =>
  paneIds.filter((id) => selected.has(id));

function paneBody(id: IndicatorId): ReactElement[] {
  const line = (key: string, name: string, stroke: string, extra = {}) => (
    <Line
      key={key}
      dataKey={key}
      name={name}
      stroke={stroke}
      strokeWidth={1.5}
      dot={false}
      isAnimationActive={false}
      {...extra}
    />
  );
  switch (id) {
    case 'rsi':
      return [
        line('rsi', 'RSI', '#7460df'),
        <ReferenceLine key="70" y={70} stroke="#e6b4bd" strokeDasharray="3 3" />,
        <ReferenceLine key="30" y={30} stroke="#a9d3c8" strokeDasharray="3 3" />,
      ];
    case 'macd':
      return [
        <Bar
          key="hist"
          dataKey="macdHistogram"
          name="히스토그램"
          fill="#c4bde6"
          isAnimationActive={false}
        />,
        line('macd', 'MACD', '#7460df'),
        line('macdSignal', '시그널', '#d9902b'),
        <ReferenceLine key="0" y={0} stroke="#cfd3df" />,
      ];
    case 'stochastic':
      return [
        line('stochK', '%K', '#7460df'),
        line('stochD', '%D', '#d9902b'),
        <ReferenceLine key="80" y={80} stroke="#e6b4bd" strokeDasharray="3 3" />,
        <ReferenceLine key="20" y={20} stroke="#a9d3c8" strokeDasharray="3 3" />,
      ];
    case 'atr':
      return [line('atr', 'ATR', '#7460df')];
    case 'obv':
      return [line('obv', 'OBV', '#7460df')];
    case 'adx':
      return [
        line('adx', 'ADX', '#7460df'),
        line('plusDI', '+DI', '#2f8f6b'),
        line('minusDI', '−DI', '#c8374f'),
        <ReferenceLine key="25" y={25} stroke="#cfd3df" strokeDasharray="3 3" />,
      ];
    default:
      return [
        line('cci', 'CCI', '#7460df'),
        <ReferenceLine key="p100" y={100} stroke="#e6b4bd" strokeDasharray="3 3" />,
        <ReferenceLine key="m100" y={-100} stroke="#a9d3c8" strokeDasharray="3 3" />,
      ];
  }
}

/** One separate pane (RSI, MACD, ...). Panes share the tooltip position with the price chart. */
export function IndicatorPane({
  id,
  rows,
  showAxis,
}: {
  id: IndicatorId;
  rows: ChartRow[];
  showAxis: boolean;
}) {
  const item = indicatorDescriptions[id];
  const bounded = id === 'rsi' || id === 'stochastic';
  return (
    <section className="analysis-pane" aria-label={`${item.name} 패널`}>
      <p className="analysis-pane-title">
        <strong>{item.name}</strong> · {item.defaultParams}
      </p>
      <div className={`analysis-pane-chart${showAxis ? ' with-axis' : ''}`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={rows}
            syncId={SYNC}
            margin={{ top: 4, right: 6, left: 0, bottom: 0 }}
          >
            {grid}
            <XAxis
              dataKey="label"
              hide={!showAxis}
              minTickGap={36}
              tickLine={false}
              axisLine={false}
              tick={axisTick}
            />
            <YAxis
              orientation="right"
              width={64}
              domain={bounded ? [0, 100] : ['auto', 'auto']}
              tickLine={false}
              axisLine={false}
              tick={axisTick}
              tickFormatter={(v: number) =>
                id === 'obv' ? v.toLocaleString('ko-KR', { notation: 'compact' }) : plain(1)(v)
              }
            />
            <Tooltip
              formatter={(value) => plain(2)(value)}
              contentStyle={{ borderRadius: 10, border: '1px solid #e9eaf0', fontSize: 12 }}
            />
            {paneBody(id)}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
