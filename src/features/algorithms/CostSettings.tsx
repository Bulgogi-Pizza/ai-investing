import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import { DataState, LoadingState } from '../../components/DataState';
import { maxRate, type CostSettingsRecord } from '../../lib/algorithmRecords';
import { ApiError, apiSend } from '../../lib/api';
import { formatKst } from '../../lib/kst';
import {
  fractionToPercent,
  invalidResponse,
  isRecord,
  percentToFraction,
  useLiveResource,
} from './shared';

export function parseCosts(body: unknown): CostSettingsRecord {
  const costs = isRecord(body) ? body.costs : null;
  if (!isRecord(costs)) throw invalidResponse('수수료·세금 설정');
  const rate = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const gains = costs.capitalGainsTax;
  return {
    commissionRate: rate(costs.commissionRate),
    sellTaxRate: rate(costs.sellTaxRate),
    capitalGainsTax:
      isRecord(gains) && rate(gains.rate) !== null && rate(gains.annualDeduction) !== null
        ? { rate: gains.rate as number, annualDeduction: gains.annualDeduction as number }
        : null,
    updatedAt: typeof costs.updatedAt === 'string' ? costs.updatedAt : null,
  };
}

export function CostSettings() {
  const { state, retry } = useLiveResource('/api/algorithm-settings', parseCosts);
  return (
    <section className="invest-card" aria-labelledby="algo-costs-title">
      <div className="invest-section-title">
        <div>
          <h2 id="algo-costs-title">수수료·세금 설정</h2>
          <p>
            시뮬레이션 비용 계산에 쓰는 값입니다. 입력하지 않은 항목은 0으로 계산하고 결과에
            &quot;설정 필요&quot;로 표시합니다.
          </p>
        </div>
      </div>
      <p className="algo-law-note">
        <Info size={15} aria-hidden="true" /> 세율은 바뀔 수 있으니 직접 확인하세요. 이 앱은 법정
        세율을 내장하지 않습니다.
      </p>
      {state.status === 'loading' && <LoadingState label="설정을 불러오는 중…" compact />}
      {state.status === 'issue' && (
        <DataState issue={state.issue} onRetry={retry} title="설정을 불러오지 못했습니다" compact />
      )}
      {state.status === 'ready' && <CostForm initial={state.data} />}
    </section>
  );
}

function CostForm({ initial }: { initial: CostSettingsRecord }) {
  const [commission, setCommission] = useState(fractionToPercent(initial.commissionRate));
  const [sellTax, setSellTax] = useState(fractionToPercent(initial.sellTaxRate));
  const [gainsRate, setGainsRate] = useState(
    fractionToPercent(initial.capitalGainsTax?.rate ?? null),
  );
  const [deduction, setDeduction] = useState(
    initial.capitalGainsTax ? String(initial.capitalGainsTax.annualDeduction) : '',
  );
  const [updatedAt, setUpdatedAt] = useState(initial.updatedAt);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  useEffect(() => setNotice(null), [commission, sellTax, gainsRate, deduction]);

  const commissionFraction = percentToFraction(commission);
  const sellTaxFraction = percentToFraction(sellTax);
  const gainsFraction = percentToFraction(gainsRate);
  const deductionNumber = deduction.trim() === '' ? null : Number(deduction);
  const gainsSet = gainsRate.trim() !== '' || deduction.trim() !== '';
  const overMax = (f: number | null | 'invalid') =>
    f === 'invalid' || (f !== null && (f < 0 || f > maxRate));
  const error =
    overMax(commissionFraction) || overMax(sellTaxFraction) || overMax(gainsFraction)
      ? `비율은 0 이상 ${maxRate * 100}% 이하의 숫자로 입력하세요(퍼센트 단위).`
      : gainsSet &&
          (gainsFraction === null ||
            deductionNumber === null ||
            !Number.isFinite(deductionNumber) ||
            deductionNumber < 0)
        ? '양도소득세는 세율과 연 공제액을 모두 입력하세요.'
        : '';

  async function save() {
    if (error) return;
    setSaving(true);
    try {
      const body = await apiSend('PUT', '/api/algorithm-settings', {
        costs: {
          commissionRate: commissionFraction,
          sellTaxRate: sellTaxFraction,
          capitalGainsTax: gainsSet
            ? { rate: gainsFraction, annualDeduction: deductionNumber }
            : null,
        },
      });
      setUpdatedAt(parseCosts(body).updatedAt);
      setNotice({ kind: 'ok', text: '저장했습니다. 다음 시뮬레이션부터 적용됩니다.' });
    } catch (e) {
      setNotice({
        kind: 'error',
        text: e instanceof ApiError ? e.message : '저장하지 못했습니다.',
      });
    } finally {
      setSaving(false);
    }
  }
  return (
    <form
      className="algo-costs"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="algo-form-grid algo-form-grid-3">
        <label className="algo-field">
          매매 수수료율 (%, 한 번의 매매당)
          <input
            type="number"
            step="any"
            min="0"
            value={commission}
            onChange={(e) => setCommission(e.target.value)}
          />
          <small className="invest-muted">토스 /commissions 값 연동 전까지 직접 입력합니다.</small>
        </label>
        <label className="algo-field">
          국내 증권거래세율 (%, 매도 금액 기준)
          <input
            type="number"
            step="any"
            min="0"
            value={sellTax}
            onChange={(e) => setSellTax(e.target.value)}
          />
        </label>
        <div className="algo-field">
          <label>
            미국 양도소득세율 (%)
            <input
              type="number"
              step="any"
              min="0"
              value={gainsRate}
              onChange={(e) => setGainsRate(e.target.value)}
            />
          </label>
          <label>
            연 공제액 (USD로 환산해 입력)
            <input
              type="number"
              step="any"
              min="0"
              value={deduction}
              onChange={(e) => setDeduction(e.target.value)}
            />
          </label>
        </div>
      </div>
      <div className="invest-save">
        <span
          role="status"
          className={error || notice?.kind === 'error' ? 'invest-negative' : 'invest-muted'}
        >
          {error ||
            notice?.text ||
            (updatedAt
              ? `마지막 저장 ${formatKst(updatedAt)} KST`
              : '아직 저장한 설정이 없습니다.')}
        </span>
        <button className="invest-primary" type="submit" disabled={Boolean(error) || saving}>
          {saving ? '저장 중…' : '설정 저장'}
        </button>
      </div>
    </form>
  );
}
