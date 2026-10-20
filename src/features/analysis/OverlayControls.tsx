import { DataState } from '../../components/DataState';
import {
  COMPARE_SERIES,
  modeLabel,
  sideLabel,
  type CompareId,
  type FillMark,
} from '../../lib/compare';
import { formatPrice, type Currency } from '../../lib/format';
import { formatKst } from '../../lib/kst';
import type { Resource } from '../../lib/api';
import type { CompareState } from './overlays';
import type { FillsResponse, HoldingCost } from './parsers';

export type TradeToggles = { cost: boolean; fills: boolean };

const stateNote = (state: CompareState) =>
  state.status === 'issue' && state.issue
    ? state.issue.kind === 'not-connected'
      ? '미연결'
      : state.issue.kind === 'no-data'
        ? '데이터 없음'
        : state.issue.kind === 'permission'
          ? '권한 없음'
          : '오류'
    : state.status === 'loading'
      ? '불러오는 중'
      : null;

/** Comparison toggles with each series' status, source and as-of; a failing series is reported on its own. */
export function CompareControls({
  enabled,
  onToggle,
  states,
  comparisonBase,
  noCommonDate,
}: {
  enabled: ReadonlySet<CompareId>;
  onToggle: (id: CompareId) => void;
  states: CompareState[];
  /** Base date of the active normalization, or null when none is drawn. */
  comparisonBase: string | null;
  noCommonDate: boolean;
}) {
  return (
    <div className="overlay-group" role="group" aria-label="시장 비교">
      <h3>시장 비교 · 기준 100으로 정규화</h3>
      <ul className="overlay-list">
        {COMPARE_SERIES.map((def) => {
          const state = states.find((item) => item.def.id === def.id)!;
          const on = enabled.has(def.id);
          const note = on ? stateNote(state) : null;
          return (
            <li key={def.id} className={`overlay-item${on ? ' on' : ''}`}>
              <button
                type="button"
                data-compare={def.id}
                aria-pressed={on}
                onClick={() => onToggle(def.id)}
              >
                <i style={{ background: def.color }} aria-hidden="true" />
                {def.label}
                {note && <small data-testid={`compare-note-${def.id}`}>{note}</small>}
              </button>
            </li>
          );
        })}
      </ul>
      {comparisonBase && (
        <p className="muted" data-testid="compare-base">
          비교 모드: 종목과 선택한 지표 모두 {comparisonBase}(첫 공통 날짜)의 값을 100으로 맞춘 상대
          값입니다. 가격 단위 지표·기준선도 같은 비율로 바꿔 그립니다. 날짜가 맞지 않는 날 (휴장
          등)은 값이 없어 선이 이어집니다.
        </p>
      )}
      {noCommonDate && (
        <p className="muted" role="status">
          선택한 계열과 이 종목이 함께 값을 가진 날짜가 표시 구간에 없어 정규화하지 못했습니다. 일반
          가격 차트를 그립니다.
        </p>
      )}
      <ul className="compare-notes">
        {states
          .filter((state) => enabled.has(state.def.id))
          .map((state) => (
            <li key={state.def.id} data-testid={`compare-source-${state.def.id}`}>
              {state.status === 'ready' && (
                <>
                  <strong>{state.def.label}</strong> — {state.def.detail}. 출처: {state.source} ·
                  조회 {formatKst(state.asOf!)} KST · 일별 값 {state.count}개
                </>
              )}
              {state.status === 'loading' && (
                <>
                  <strong>{state.def.label}</strong> — 불러오는 중…
                </>
              )}
              {state.status === 'issue' && state.issue && (
                <DataState
                  compact
                  issue={state.issue}
                  onRetry={state.retry}
                  scope={state.def.label}
                />
              )}
            </li>
          ))}
      </ul>
    </div>
  );
}

/** "내 매매": average-purchase-price line and algorithm fill markers. */
export function TradeControls({
  toggles,
  onToggle,
  holding,
  fills,
  marks,
  costState,
  currency,
  retryHolding,
  retryFills,
}: {
  toggles: TradeToggles;
  onToggle: (key: keyof TradeToggles) => void;
  holding: Resource<HoldingCost>;
  fills: Resource<FillsResponse>;
  marks: { marks: FillMark[]; outside: number };
  costState: 'none' | 'draw' | 'outside';
  currency: Currency;
  retryHolding: () => void;
  retryFills: () => void;
}) {
  return (
    <div className="overlay-group" role="group" aria-label="내 매매 표시">
      <h3>내 매매</h3>
      <ul className="overlay-list">
        {(
          [
            ['cost', '평균 매수가 선'],
            ['fills', '알고리즘 체결 ▲▼'],
          ] as const
        ).map(([key, label]) => (
          <li key={key} className={`overlay-item${toggles[key] ? ' on' : ''}`}>
            <button
              type="button"
              data-trade={key}
              aria-pressed={toggles[key]}
              onClick={() => onToggle(key)}
            >
              {label}
            </button>
          </li>
        ))}
      </ul>
      {toggles.cost && (
        <div className="trade-note" data-testid="cost-note">
          {holding.status === 'loading' && <p className="muted">보유 종목을 불러오는 중…</p>}
          {holding.status === 'issue' && (
            <DataState compact issue={holding.issue} onRetry={retryHolding} scope="평균 매수가" />
          )}
          {holding.status === 'ready' && (
            <p className="muted">
              {holding.data.holding === null
                ? `이 종목은 보유 종목에 없어 평균 매수가 선이 없습니다(토스 보유 조회 ${formatKst(holding.data.asOf)} KST).`
                : holding.data.holding.averagePurchasePrice === null
                  ? '토스가 이 종목의 평균 매수가를 주지 않아 선을 그리지 않습니다.'
                  : holding.data.holding.currency !== currency
                    ? '보유 통화와 차트 통화가 달라 선을 그리지 않습니다.'
                    : `평균 매수가 ${formatPrice(holding.data.holding.averagePurchasePrice, currency)} · 보유 ${holding.data.holding.quantity}주 · 출처 ${holding.data.source} 보유 종목(${formatKst(holding.data.asOf)} KST)${
                        costState === 'outside'
                          ? ' — 표시 구간의 가격에서 너무 멀어 선을 그리면 차트가 눌려서 그리지 않습니다.'
                          : ''
                      }`}
            </p>
          )}
        </div>
      )}
      {toggles.fills && (
        <div className="trade-note" data-testid="fills-note">
          {fills.status === 'loading' && <p className="muted">알고리즘 체결을 불러오는 중…</p>}
          {fills.status === 'issue' && (
            <DataState compact issue={fills.issue} onRetry={retryFills} scope="알고리즘 체결" />
          )}
          {fills.status === 'ready' && !fills.data.connected && (
            <p className="muted" role="status" data-testid="fills-unconnected">
              알고리즘 체결 기록(모의 운용·실전)이 아직 연결되지 않았습니다. 연결되면 가상(속이 빈
              표시)과 실제(채운 표시) 체결을 ▲ 매수 ▼ 매도로 표시합니다.
            </p>
          )}
          {fills.status === 'ready' && fills.data.connected && fills.data.fills.length === 0 && (
            <p className="muted">이 구간에 이 종목의 알고리즘 체결이 없습니다.</p>
          )}
          {fills.status === 'ready' && fills.data.connected && fills.data.fills.length > 0 && (
            <>
              <p className="muted">
                체결 {fills.data.fills.length}건(조회 {formatKst(fills.data.asOf)} KST).
                {marks.outside > 0 && ` 표시 구간 밖 ${marks.outside}건은 그리지 않았습니다.`}
              </p>
              <ul className="fill-list">
                {fills.data.fills.map((fill) => (
                  <li key={fill.id} data-testid="fill-row">
                    {fill.date} · <strong>{modeLabel(fill.mode)}</strong> {sideLabel(fill.side)} ·{' '}
                    {fill.algorithmName} · {fill.quantity}주 @ {fill.price} {fill.currency}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
