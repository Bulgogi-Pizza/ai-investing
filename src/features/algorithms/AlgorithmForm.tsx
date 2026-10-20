import { useEffect, useId, useMemo, useState } from 'react';
import { Lock, Plus, X } from 'lucide-react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import {
  templateDefaults,
  type AlgorithmTemplateId,
  type Market,
  type SignalId,
} from '../../lib/algo';
import {
  currencyOf,
  inputFromTemplate,
  lookbackLimits,
  maxBudget,
  maxTargets,
  normalizeSymbol,
  parseAlgorithmInput,
  signalLabels,
  signalOrder,
  symbolPattern,
  type AlgorithmInput,
  type AlgorithmMethod,
  type AlgorithmMode,
  type AlgorithmRecord,
} from '../../lib/algorithmRecords';
import { ApiError, apiSend } from '../../lib/api';
import { outcomeText } from './EmergencyStop';
import { modeDescriptions, modeLabels, money } from './shared';

const templateOrder: AlgorithmTemplateId[] = [
  'momentum',
  'meanReversion',
  'dualMomentum',
  'custom',
];
const modeOrder: AlgorithmMode[] = ['simulation', 'paper', 'live'];

export const inputOfRecord = (record: AlgorithmRecord): AlgorithmInput => ({
  name: record.name,
  method: record.method,
  template: record.template,
  market: record.market,
  targets: [...record.targets],
  signals: record.signals.map((s) => ({ ...s })),
  buyThreshold: record.buyThreshold,
  sellThreshold: record.sellThreshold,
  ...(record.dualMomentum ? { dualMomentum: { ...record.dualMomentum } } : {}),
  mode: record.mode,
  budget: record.budget,
});
const stable = (input: AlgorithmInput) =>
  JSON.stringify({
    ...input,
    signals: [...input.signals].sort((a, b) => a.id.localeCompare(b.id)),
  });

function TargetEditor({
  targets,
  onChange,
}: {
  targets: string[];
  onChange: (targets: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const inputId = useId();
  function add() {
    const parts = draft
      .split(/[\s,]+/)
      .map(normalizeSymbol)
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = [...targets];
    for (const symbol of parts) {
      if (!symbolPattern.test(symbol)) {
        setError(
          `종목 코드 "${symbol.slice(0, 20)}"의 형식이 맞지 않습니다. 영문·숫자·점·하이픈 12자 이하로 입력하세요.`,
        );
        return;
      }
      if (next.includes(symbol)) {
        setError(`종목 코드 ${symbol}은(는) 이미 목록에 있습니다.`);
        return;
      }
      if (next.length >= maxTargets) {
        setError(`대상 종목은 최대 ${maxTargets}개입니다.`);
        return;
      }
      next.push(symbol);
    }
    setError('');
    setDraft('');
    onChange(next);
  }
  return (
    <div className="algo-targets">
      <label htmlFor={inputId}>
        대상 종목{' '}
        <span className="invest-muted">
          {targets.length}/{maxTargets}
        </span>
      </label>
      <div className="algo-target-add">
        <input
          id={inputId}
          value={draft}
          placeholder="종목 코드 (예: 005930, AAPL)"
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={`${inputId}-help`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="button" onClick={add}>
          <Plus size={14} aria-hidden="true" /> 추가
        </button>
      </div>
      <small id={`${inputId}-help`} className="invest-muted">
        쉼표나 공백으로 여러 개를 한 번에 넣을 수 있습니다. 과거 시뮬레이션, 모의, 실전이 같은
        목록을 씁니다.
      </small>
      {error && (
        <p role="alert" className="algo-note algo-note-error">
          {error}
        </p>
      )}
      {targets.length > 0 && (
        <ul className="algo-chips" aria-label="대상 종목 목록">
          {targets.map((symbol) => (
            <li key={symbol}>
              <span>{symbol}</span>
              <button
                type="button"
                aria-label={`${symbol} 제거`}
                onClick={() => onChange(targets.filter((t) => t !== symbol))}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AlgorithmForm({
  record,
  onSaved,
  onDeleted,
  onDirtyChange,
  initialNotice,
}: {
  /** null = creating a new algorithm. */
  record: AlgorithmRecord | null;
  onSaved: (record: AlgorithmRecord, message: string) => void;
  /** Message carried over when saving remounts the form (a new algorithm gets a new key). */
  initialNotice?: string;
  onDeleted: (id: string) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const initial = useMemo(
    () => (record ? inputOfRecord(record) : inputFromTemplate('momentum')),
    [record],
  );
  const [input, setInput] = useState<AlgorithmInput>(initial);
  const [budgetText, setBudgetText] = useState(
    record?.budget === null || !record ? '' : String(record.budget),
  );
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(
    initialNotice ? { kind: 'ok', text: initialNotice } : null,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const formId = useId();
  const currency = currencyOf(input.market);
  const isDual = input.template === 'dualMomentum';
  const budget = budgetText.trim() === '' ? null : Number(budgetText);
  const candidate: AlgorithmInput = {
    ...input,
    budget: budget === null || Number.isFinite(budget) ? budget : NaN,
  };
  const parsed = parseAlgorithmInput(candidate);
  const dirty = record === null ? true : stable(candidate) !== stable(initial);
  const clientError = parsed.ok ? '' : parsed.message;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  const patch = (changes: Partial<AlgorithmInput>) => {
    setInput((current) => ({ ...current, ...changes }));
    setNotice(null);
  };

  function changeTemplate(template: AlgorithmTemplateId) {
    if (template === input.template) return;
    const defaults = inputFromTemplate(template, input.market);
    patch({
      template,
      signals: defaults.signals,
      buyThreshold: defaults.buyThreshold,
      sellThreshold: defaults.sellThreshold,
      dualMomentum: defaults.dualMomentum,
    });
  }
  const signal = (id: SignalId) => input.signals.find((s) => s.id === id);
  function setSignal(id: SignalId, weight: number | null) {
    const rest = input.signals.filter((s) => s.id !== id);
    patch({ signals: weight === null ? rest : [...rest, { id, weight }] });
  }

  async function save() {
    if (!parsed.ok) return;
    setSaving(true);
    setNotice(null);
    try {
      const body = (await (record
        ? apiSend('PUT', `/api/algorithms/${record.id}`, {
            version: record.version,
            algorithm: parsed.value,
          })
        : apiSend('POST', '/api/algorithms', { algorithm: parsed.value }))) as {
        algorithm: AlgorithmRecord;
        notifications?: { change: string; status: 'sent' | 'failed' | 'disabled' }[];
      };
      if (!body.algorithm?.id)
        throw new ApiError(502, 'INVALID_RESPONSE', '저장 응답 형식을 확인하지 못했습니다.');
      const extra = (body.notifications ?? [])
        .map(
          (n) =>
            ` ${n.change === 'budget-raised' ? '운용 금액 한도 상향' : '실전 켜기'} 알림: ${outcomeText(n)}`,
        )
        .join('');
      const message = `저장했습니다.${extra}`;
      setNotice({ kind: 'ok', text: message });
      onSaved(body.algorithm, message);
    } catch (error) {
      setNotice({
        kind: 'error',
        text:
          error instanceof ApiError
            ? error.message
            : '저장하지 못했습니다. 잠시 후 다시 시도하세요.',
      });
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (!record) return;
    setSaving(true);
    try {
      await apiSend('DELETE', `/api/algorithms/${record.id}`);
      onDeleted(record.id);
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof ApiError ? error.message : '삭제하지 못했습니다.',
      });
    } finally {
      setConfirmDelete(false);
      setSaving(false);
    }
  }

  return (
    <form
      className="algo-form"
      aria-label={record ? `${record.name} 설정` : '새 알고리즘'}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="algo-form-grid">
        <label className="algo-field">
          이름
          <input
            value={input.name}
            maxLength={60}
            placeholder="예: 국내 모멘텀 A"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </label>
        <fieldset className="algo-field">
          <legend>방식</legend>
          <div className="invest-segment" role="radiogroup" aria-label="방식">
            {(['formula', 'ai'] as AlgorithmMethod[]).map((method) => (
              <button
                key={method}
                type="button"
                role="radio"
                aria-checked={input.method === method}
                className={input.method === method ? 'active' : ''}
                onClick={() =>
                  patch({
                    method,
                    mode: method === 'ai' && input.mode === 'simulation' ? 'paper' : input.mode,
                  })
                }
              >
                {method === 'formula' ? '수식형' : 'AI형'}
              </button>
            ))}
          </div>
          <small className="invest-muted">
            {input.method === 'formula'
              ? '신호 점수 × 가중치의 합이 기준값을 넘으면 매수합니다.'
              : 'AI형은 과거 시뮬레이션을 지원하지 않습니다(모의 운용부터 시작). AI 비용 승인 전에는 AI형 판단도 하지 않습니다.'}
          </small>
        </fieldset>
      </div>

      <fieldset className="algo-field">
        <legend>템플릿</legend>
        <div className="algo-template-grid" role="radiogroup" aria-label="템플릿">
          {templateOrder.map((id) => (
            <label key={id} className={`algo-template ${input.template === id ? 'selected' : ''}`}>
              <input
                type="radio"
                name={`${formId}-template`}
                checked={input.template === id}
                onChange={() => changeTemplate(id)}
              />
              <strong>{templateDefaults[id].label}</strong>
              <span>{templateDefaults[id].description}</span>
            </label>
          ))}
        </div>
        <small className="invest-muted">
          템플릿을 바꾸면 신호·가중치·기준값이 그 템플릿의 기본값으로 바뀝니다.
        </small>
      </fieldset>

      <div className="algo-form-grid">
        <fieldset className="algo-field">
          <legend>시장</legend>
          <div className="invest-segment" role="radiogroup" aria-label="시장">
            {(['KR', 'US'] as Market[]).map((market) => (
              <button
                key={market}
                type="button"
                role="radio"
                aria-checked={input.market === market}
                className={input.market === market ? 'active' : ''}
                disabled={record !== null && record.market !== market}
                onClick={() => patch({ market })}
              >
                {market === 'KR' ? '국내 (KRW)' : '미국 (USD)'}
              </button>
            ))}
          </div>
          <small className="invest-muted">
            통화:{' '}
            {currency === 'KRW'
              ? '원(KRW)'
              : '달러(USD) 전용 — 계좌의 달러만 사용하며 환전은 직접 합니다.'}
            {record ? ' 시장은 만든 뒤 바꿀 수 없습니다.' : ''}
          </small>
        </fieldset>
        <label className="algo-field">
          운용 금액 한도 ({currency}) <span className="invest-muted">선택 · 실전은 필수</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            max={maxBudget[currency]}
            value={budgetText}
            placeholder={currency === 'KRW' ? '예: 10000000' : '예: 10000'}
            onChange={(e) => {
              setBudgetText(e.target.value);
              setNotice(null);
            }}
          />
          <small className="invest-muted">
            {budget !== null && Number.isFinite(budget) && budget > 0
              ? `= ${money(budget, currency)}`
              : '비워 두면 시뮬레이션이 기본 금액을 가정하고 그렇게 표시합니다.'}
          </small>
        </label>
      </div>

      <TargetEditor targets={input.targets} onChange={(targets) => patch({ targets })} />

      {isDual ? (
        <div className="algo-form-grid">
          <label className="algo-field">
            수익률 기간 (거래일, {lookbackLimits.min}~{lookbackLimits.max})
            <input
              type="number"
              value={input.dualMomentum?.lookbackDays ?? ''}
              onChange={(e) =>
                patch({
                  dualMomentum: { ...input.dualMomentum!, lookbackDays: Number(e.target.value) },
                })
              }
            />
            <small className="invest-muted">
              토스 일봉은 한 번에 200개까지만 조회해 252일(기본)은 시뮬레이션할 수 없습니다. 126처럼
              줄이면 가능합니다.
            </small>
          </label>
          <label className="algo-field">
            보유할 종목 수 (상대 모멘텀 상위 N)
            <input
              type="number"
              min="1"
              value={input.dualMomentum?.topN ?? ''}
              onChange={(e) =>
                patch({ dualMomentum: { ...input.dualMomentum!, topN: Number(e.target.value) } })
              }
            />
          </label>
        </div>
      ) : (
        <>
          <fieldset className="algo-field">
            <legend>신호와 가중치</legend>
            <div className="algo-signals">
              {signalOrder.map((id) => {
                const current = signal(id);
                const labelId = `${formId}-${id}`;
                return (
                  <div key={id} className={`algo-signal ${current ? 'on' : ''}`}>
                    <label className="algo-signal-check">
                      <input
                        type="checkbox"
                        checked={Boolean(current)}
                        onChange={(e) => setSignal(id, e.target.checked ? 0.5 : null)}
                      />
                      <span id={labelId}>
                        <strong>{signalLabels[id].label}</strong>
                        <small>{signalLabels[id].description}</small>
                      </span>
                    </label>
                    <div className="algo-slider">
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        disabled={!current}
                        aria-label={`${signalLabels[id].label} 가중치`}
                        value={current?.weight ?? 0}
                        onChange={(e) => setSignal(id, Number(e.target.value))}
                      />
                      <output>{current ? current.weight.toFixed(2) : '—'}</output>
                    </div>
                  </div>
                );
              })}
            </div>
            <small className="invest-muted">
              가중치는 합이 1이 아니어도 비율로 계산합니다. 과거 시뮬레이션에서는 수급·뉴스(와 아직
              재무 연결 전인 가치) 신호가 제외됩니다.
            </small>
          </fieldset>
          <div className="algo-form-grid">
            {(
              [
                ['buyThreshold', '매수 기준 (점수가 이 값 이상이면 매수)'],
                ['sellThreshold', '매도 기준 (점수가 이 값 이하이면 매도)'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="algo-field">
                {label}
                <div className="algo-slider">
                  <input
                    type="range"
                    min="-1"
                    max="1"
                    step="0.05"
                    aria-label={label}
                    value={Number.isFinite(input[key]) ? input[key] : 0}
                    onChange={(e) => patch({ [key]: Number(e.target.value) })}
                  />
                  <output>{input[key].toFixed(2)}</output>
                </div>
              </label>
            ))}
          </div>
        </>
      )}

      <fieldset className="algo-field">
        <legend>모드</legend>
        <div className="algo-mode-grid" role="radiogroup" aria-label="모드">
          {modeOrder.map((mode) => {
            // Live is switched on only from the live panel; an algorithm that is already live may
            // stay live or move back to another mode here.
            const wasLive = record?.mode === 'live';
            const unavailable =
              (mode === 'live' && !wasLive) || (mode === 'simulation' && input.method === 'ai');
            return (
              <label
                key={mode}
                className={`algo-mode algo-mode-${mode} ${input.mode === mode ? 'selected' : ''} ${unavailable ? 'disabled' : ''}`}
              >
                <input
                  type="radio"
                  name={`${formId}-mode`}
                  checked={input.mode === mode}
                  disabled={unavailable}
                  onChange={() => patch({ mode })}
                />
                <strong>
                  {mode === 'live' && !wasLive && <Lock size={13} aria-hidden="true" />}{' '}
                  {modeLabels[mode]}
                </strong>
                <span>
                  {mode === 'live'
                    ? wasLive
                      ? '실전 운용 중입니다. 다른 모드를 고르면 실전이 꺼집니다(추가 인증 없음).'
                      : '아래 "실전 운용" 패널에서 모의 기록을 보고 켭니다.'
                    : mode === 'simulation' && input.method === 'ai'
                      ? 'AI형은 과거 시뮬레이션을 지원하지 않습니다.'
                      : modeDescriptions[mode]}
                </span>
              </label>
            );
          })}
        </div>
        {input.mode === 'paper' && (
          <small className="invest-muted">
            모의 운용은 영업일 개장 직후 한 번 판단하고 가상 기록만 쌓습니다. 실제 주문은 나가지
            않습니다.
          </small>
        )}
      </fieldset>

      <div className="invest-save">
        <span
          role="status"
          className={clientError || notice?.kind === 'error' ? 'invest-negative' : 'invest-muted'}
        >
          {notice?.kind === 'error'
            ? notice.text
            : (notice?.text ??
              (clientError || (dirty ? '저장하지 않은 변경이 있습니다.' : '저장된 설정입니다.')))}
        </span>
        <div className="algo-form-actions">
          {record && (
            <button
              type="button"
              className="button"
              onClick={() => setConfirmDelete(true)}
              disabled={saving}
            >
              삭제
            </button>
          )}
          <button
            className="invest-primary"
            type="submit"
            disabled={!parsed.ok || saving || !dirty}
          >
            {saving ? '저장 중…' : record ? '변경 저장' : '알고리즘 만들기'}
          </button>
        </div>
      </div>
      {confirmDelete && record && (
        <ConfirmDialog
          title={`"${record.name}"을(를) 삭제할까요?`}
          confirmLabel="삭제"
          tone="danger"
          busy={saving}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(false)}
        >
          <p>알고리즘 설정이 삭제됩니다. 변경 이력에는 삭제 기록이 남습니다.</p>
        </ConfirmDialog>
      )}
    </form>
  );
}
