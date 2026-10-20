import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { DataState, LoadingState } from '../../components/DataState';
import {
  defaultSafeguardSettings,
  hardSafeguards,
  parseSafeguardSettings,
  safeguardLimits,
  type SafeguardSettings as Settings,
  type SafeguardSettingsRecord,
} from '../../lib/algorithmRecords';
import { ApiError, apiSend } from '../../lib/api';
import { formatKst } from '../../lib/kst';
import { outcomeText } from './EmergencyStop';
import { invalidResponse, isRecord, useLiveResource } from './shared';

type Loaded = { safeguards: SafeguardSettingsRecord | null; invalid: boolean };
export function parseSafeguards(body: unknown): Loaded {
  if (!isRecord(body)) throw invalidResponse('안전장치 설정');
  if (body.safeguards === null || body.safeguards === undefined)
    return { safeguards: null, invalid: body.safeguardsInvalid === true };
  const parsed = parseSafeguardSettings(body.safeguards);
  if (!parsed.ok) throw invalidResponse('안전장치 설정');
  const s = body.safeguards as Record<string, unknown>;
  return {
    safeguards: {
      ...parsed.value,
      updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : null,
    },
    invalid: false,
  };
}

const changeLabels: Record<string, string> = {
  'max-orders-raised': '하루 최대 주문 횟수 상향',
  'min-holding-lowered': '최소 보유 기간 단축',
  'loss-stop-loosened': '누적 손실 정지 기준 완화',
  'liquidity-lowered': '최소 거래대금 기준 하향',
};

/**
 * 실전 안전장치 설정: the values the live job enforces. Raising risk (more orders, shorter holding,
 * a looser loss stop, a lower liquidity floor) is allowed without extra authentication and is
 * announced on Telegram; the fixed limits are shown but cannot be edited.
 */
export function SafeguardSettings({ onChanged }: { onChanged: () => void }) {
  const { state, retry } = useLiveResource('/api/algorithm-settings', parseSafeguards);
  return (
    <section className="invest-card" aria-labelledby="algo-safeguards-title">
      <div className="invest-section-title">
        <div>
          <h2 id="algo-safeguards-title">
            <ShieldAlert size={18} aria-hidden="true" /> 실전 안전장치 설정
          </h2>
          <p>
            실전 주문 직전 검사가 쓰는 값입니다. 기본값은 설계에서 정한 값이며, 위험을 늘리는 변경은
            추가 인증 없이 되지만 변경 즉시 텔레그램으로 알립니다.
          </p>
        </div>
      </div>
      {state.status === 'loading' && <LoadingState label="설정을 불러오는 중…" compact />}
      {state.status === 'issue' && (
        <DataState issue={state.issue} onRetry={retry} title="설정을 불러오지 못했습니다" compact />
      )}
      {state.status === 'ready' &&
        (state.data.safeguards === null ? (
          <p className="algo-note algo-note-error" role="alert">
            저장된 안전장치 설정이 올바르지 않아 실전 주문이 모두 보류됩니다. 아래 값을 확인하고
            저장하면 바로잡힙니다.
          </p>
        ) : null)}
      {state.status === 'ready' && (
        <Form
          initial={state.data.safeguards ?? { ...defaultSafeguardSettings, updatedAt: null }}
          onChanged={onChanged}
        />
      )}
    </section>
  );
}

function Form({ initial, onChanged }: { initial: SafeguardSettingsRecord; onChanged: () => void }) {
  const [text, setText] = useState({
    maxOrdersPerDay: String(initial.maxOrdersPerDay),
    maxGlobalOrdersPerDay: String(initial.maxGlobalOrdersPerDay),
    minHoldingTradingDays: String(initial.minHoldingTradingDays),
    lossStopPercent: String(Number((initial.lossStopFraction * 100).toPrecision(10))),
    liquidityKRW: String(initial.liquidityMinAvgValue.KRW),
    liquidityUSD: String(initial.liquidityMinAvgValue.USD),
  });
  const [updatedAt, setUpdatedAt] = useState(initial.updatedAt);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  useEffect(() => setNotice(null), [text]);

  const candidate: Settings = {
    maxOrdersPerDay: Number(text.maxOrdersPerDay),
    maxGlobalOrdersPerDay: Number(text.maxGlobalOrdersPerDay),
    minHoldingTradingDays: Number(text.minHoldingTradingDays),
    lossStopFraction: Number((Number(text.lossStopPercent) / 100).toPrecision(10)),
    liquidityMinAvgValue: { KRW: Number(text.liquidityKRW), USD: Number(text.liquidityUSD) },
  };
  const parsed = parseSafeguardSettings(candidate);
  const error = parsed.ok ? '' : parsed.message;
  const setField = (key: keyof typeof text) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setText((current) => ({ ...current, [key]: e.target.value }));

  async function save() {
    if (!parsed.ok) return;
    setSaving(true);
    try {
      const body = (await apiSend('PUT', '/api/algorithm-settings/safeguards', {
        safeguards: parsed.value,
      })) as {
        changed: boolean;
        safeguards: SafeguardSettingsRecord;
        notifications?: { change: string; status: 'sent' | 'failed' | 'disabled' }[];
      };
      setUpdatedAt(body.safeguards?.updatedAt ?? null);
      const alerts = (body.notifications ?? [])
        .map((n) => `${changeLabels[n.change] ?? n.change}: ${outcomeText(n)}`)
        .join(' ');
      setNotice({
        kind: 'ok',
        text: body.changed
          ? `저장했습니다. 다음 실전 판단부터 적용됩니다. ${alerts}`
          : '바뀐 값이 없습니다.',
      });
      onChanged();
    } catch (e) {
      setNotice({
        kind: 'error',
        text: e instanceof ApiError ? e.message : '저장하지 못했습니다.',
      });
    } finally {
      setSaving(false);
    }
  }
  const d = defaultSafeguardSettings;
  return (
    <form
      className="algo-costs"
      aria-label="실전 안전장치 설정"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="algo-form-grid algo-form-grid-3">
        <label className="algo-field">
          알고리즘당 하루 최대 주문 횟수
          <input
            type="number"
            min={safeguardLimits.maxOrdersPerDay.min}
            max={safeguardLimits.maxOrdersPerDay.max}
            value={text.maxOrdersPerDay}
            onChange={setField('maxOrdersPerDay')}
          />
          <small className="invest-muted">기본 {d.maxOrdersPerDay}건</small>
        </label>
        <label className="algo-field">
          전체 하루 최대 주문 횟수
          <input
            type="number"
            min={safeguardLimits.maxGlobalOrdersPerDay.min}
            max={safeguardLimits.maxGlobalOrdersPerDay.max}
            value={text.maxGlobalOrdersPerDay}
            onChange={setField('maxGlobalOrdersPerDay')}
          />
          <small className="invest-muted">기본 {d.maxGlobalOrdersPerDay}건</small>
        </label>
        <label className="algo-field">
          최소 보유 기간 (거래일)
          <input
            type="number"
            min={safeguardLimits.minHoldingTradingDays.min}
            max={safeguardLimits.minHoldingTradingDays.max}
            value={text.minHoldingTradingDays}
            onChange={setField('minHoldingTradingDays')}
          />
          <small className="invest-muted">
            기본 {d.minHoldingTradingDays}거래일. 이 안에는 매도 신호가 나와도 매도하지 않습니다.
          </small>
        </label>
        <label className="algo-field">
          누적 손실 자동 정지 (운용 금액의 %)
          <input
            type="number"
            step="any"
            min={safeguardLimits.lossStopFraction.min * 100}
            max={safeguardLimits.lossStopFraction.max * 100}
            value={text.lossStopPercent}
            onChange={setField('lossStopPercent')}
          />
          <small className="invest-muted">
            기본 {d.lossStopFraction * 100}% (실현 + 평가 손실이 이 비율에 닿으면 정지)
          </small>
        </label>
        <label className="algo-field">
          최소 평균 거래대금 — 국내 (원, 최근 20거래일)
          <input
            type="number"
            min={safeguardLimits.liquidityMinAvgValue.KRW.min}
            value={text.liquidityKRW}
            onChange={setField('liquidityKRW')}
          />
          <small className="invest-muted">
            기본 {d.liquidityMinAvgValue.KRW.toLocaleString('ko-KR')}원
          </small>
        </label>
        <label className="algo-field">
          최소 평균 거래대금 — 미국 (달러, 최근 20거래일)
          <input
            type="number"
            min={safeguardLimits.liquidityMinAvgValue.USD.min}
            value={text.liquidityUSD}
            onChange={setField('liquidityUSD')}
          />
          <small className="invest-muted">
            기본 ${d.liquidityMinAvgValue.USD.toLocaleString('en-US')}
          </small>
        </label>
      </div>
      <p className="invest-muted" data-testid="hard-limits">
        고정 한도(수정 불가): 한 주문은 {hardSafeguards.maxOrderValueKrw.toLocaleString('ko-KR')}원
        미만(1억 원 이상 주문은 내지 않음, 매도는 나눠서), 현재가는 주문 직전{' '}
        {hardSafeguards.maxQuoteAgeSeconds}초 안에 받은 값만 사용합니다.
      </p>
      <div className="invest-save">
        <span
          role="status"
          className={error || notice?.kind === 'error' ? 'invest-negative' : 'invest-muted'}
        >
          {error ||
            notice?.text ||
            (updatedAt
              ? `마지막 저장 ${formatKst(updatedAt)} KST`
              : '저장한 적 없음 — 기본값을 쓰고 있습니다.')}
        </span>
        <button className="invest-primary" type="submit" disabled={Boolean(error) || saving}>
          {saving ? '저장 중…' : '안전장치 저장'}
        </button>
      </div>
    </form>
  );
}
