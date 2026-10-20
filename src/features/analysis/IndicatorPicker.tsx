import { InfoTip } from '../../components/InfoTip';
import { WINDOWS } from '../../lib/chartData';
import { indicatorDescriptions, indicatorIds, type IndicatorId } from '../../lib/indicators';

const groups = [
  { pane: 'price', title: '차트 위에 겹쳐 보기' },
  { pane: 'separate', title: '별도 패널로 보기' },
] as const;

/** Period buttons and the indicator selector. Each indicator has its own ⓘ explanation. */
export function IndicatorPicker({
  period,
  onPeriod,
  selected,
  onToggle,
}: {
  period: string;
  onPeriod: (label: string) => void;
  selected: ReadonlySet<IndicatorId>;
  onToggle: (id: IndicatorId) => void;
}) {
  return (
    <section className="analysis-card" aria-label="기간과 지표 선택">
      <div className="period-row" role="group" aria-label="차트 기간">
        {WINDOWS.map((window) => (
          <button
            key={window.label}
            type="button"
            aria-pressed={period === window.label}
            onClick={() => onPeriod(window.label)}
          >
            {window.label}
          </button>
        ))}
        <span className="muted">약 {WINDOWS.find((w) => w.label === period)?.bars}거래일 기준</span>
      </div>
      {groups.map((group) => (
        <div className="indicator-group" key={group.pane}>
          <h3>{group.title}</h3>
          <ul className="indicator-list">
            {indicatorIds
              .filter((id) => indicatorDescriptions[id].pane === group.pane)
              .map((id) => {
                const item = indicatorDescriptions[id];
                const on = selected.has(id);
                return (
                  <li key={id} className={`indicator-item${on ? ' on' : ''}`}>
                    <button
                      type="button"
                      className="indicator-toggle"
                      data-indicator={id}
                      aria-pressed={on}
                      onClick={() => onToggle(id)}
                    >
                      {item.name} <small>{item.defaultParams}</small>
                    </button>
                    <InfoTip label={item.name}>{item.tooltip}</InfoTip>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </section>
  );
}
