/**
 * Wire and storage types for the algorithm screen (stage 7a) plus the one validation function the
 * browser (inline feedback) and the server (authoritative) both use. Pure: no network, no clock,
 * no storage, no order code. The engine itself lives in `src/lib/algo`.
 */
import {
  defaultDualMomentumParams,
  defaultSignalParams,
  templateDefaults,
  validateAlgorithm,
  type AlgorithmDefinition,
  type AlgorithmTemplateId,
  type DualMomentumParams,
  type Market,
  type SignalId,
  type SignalParams,
  type SignalWeight,
} from './algo';

export const maxAlgorithms = 20;
export const maxTargets = 30;
export const maxNameLength = 60;
/** Same character set the notification module accepts, so a symbol is never sanitized away. */
export const symbolPattern = /^[A-Za-z0-9][A-Za-z0-9.-]{0,11}$/;
export const maxBudget: Record<Currency, number> = { KRW: 1_000_000_000_000, USD: 1_000_000_000 };
/** Used only by simulations of algorithms that have no budget yet; flagged in the result. */
export const defaultSimulationBudget: Record<Currency, number> = {
  KRW: 10_000_000,
  USD: 10_000,
};
/** Dual momentum look-back bounds (trading days). */
export const lookbackLimits = { min: 20, max: 756 } as const;

export type Currency = 'KRW' | 'USD';
export type AlgorithmMode = 'simulation' | 'paper' | 'live';
export type AlgorithmMethod = 'formula' | 'ai';
export const algorithmModes: readonly AlgorithmMode[] = ['simulation', 'paper', 'live'];
export const currencyOf = (market: Market): Currency => (market === 'KR' ? 'KRW' : 'USD');

export const signalLabels: Record<SignalId, { label: string; description: string }> = {
  trend: {
    label: '추세',
    description: '이동평균(20/50일) 위치와 ADX 강도로 상승·하락 추세를 점수화한다.',
  },
  momentum: {
    label: '모멘텀',
    description: '최근 60거래일 수익률이 클수록 높은 점수를 준다.',
  },
  meanReversion: {
    label: '평균회귀',
    description: 'RSI와 볼린저 %B로 과매도일수록 높은 점수를 준다.',
  },
  value: {
    label: '가치',
    description:
      '종목 자신의 PER·PBR 이력과 비교한다. 재무 데이터 연결 전에는 시뮬레이션에서 제외된다.',
  },
  supply: {
    label: '수급',
    description: '외국인·기관 순매수. 과거 시점 데이터가 없어 시뮬레이션에서는 항상 제외된다.',
  },
  news: {
    label: '뉴스',
    description: '뉴스 기반 점수. 과거 시점 데이터가 없어 시뮬레이션에서는 항상 제외된다.',
  },
};
export const signalOrder: SignalId[] = [
  'trend',
  'momentum',
  'meanReversion',
  'value',
  'supply',
  'news',
];
const signalSet = new Set<string>(signalOrder);

/** Editable part of an algorithm; what the form sends. Currency is derived from the market. */
export type AlgorithmInput = {
  name: string;
  method: AlgorithmMethod;
  template: AlgorithmTemplateId;
  market: Market;
  targets: string[];
  signals: SignalWeight[];
  buyThreshold: number;
  sellThreshold: number;
  dualMomentum?: DualMomentumParams;
  mode: AlgorithmMode;
  /** Budget in the market currency. Required before live (7f); optional until then. */
  budget: number | null;
};
export type AlgorithmRecord = AlgorithmInput & {
  id: string;
  currency: Currency;
  /** Signal parameters snapshot (defaults at creation; not editable in this stage). */
  params: SignalParams;
  /** When the target list last changed; later results are separate from earlier ones. */
  targetsChangedAt: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type InputIssue = { field: string; message: string };
export type ParsedInput = { ok: true; value: AlgorithmInput } | ({ ok: false } & InputIssue);

const fail = (field: string, message: string): ParsedInput => ({ ok: false, field, message });
const controlChars = new RegExp(
  '[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]',
);

export function normalizeSymbol(value: string) {
  return value.trim().toUpperCase();
}
/** Returns an error message for a target list, or null when valid. */
export function validateTargets(targets: readonly string[]): string | null {
  if (targets.length === 0) return '대상 종목을 하나 이상 입력하세요.';
  if (targets.length > maxTargets) return `대상 종목은 최대 ${maxTargets}개입니다.`;
  const seen = new Set<string>();
  for (const symbol of targets) {
    if (!symbolPattern.test(symbol))
      return `종목 코드 "${symbol.slice(0, 20)}"의 형식이 맞지 않습니다. 영문·숫자·점·하이픈 12자 이하로 입력하세요.`;
    if (seen.has(symbol)) return `종목 코드 ${symbol}이(가) 중복되었습니다.`;
    seen.add(symbol);
  }
  return null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Strict, allow-list parser. Unknown keys are ignored (never stored); every known key is
 * type-checked. `currency`, when sent, must match the market (US is USD only).
 */
export function parseAlgorithmInput(body: unknown): ParsedInput {
  if (!isRecord(body)) return fail('body', '알고리즘 설정이 필요합니다.');
  const { name, method, template, market, targets, signals, mode, budget } = body;
  if (typeof name !== 'string') return fail('name', '이름을 입력하세요.');
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > maxNameLength || controlChars.test(trimmed))
    return fail('name', `이름은 제어 문자 없이 1~${maxNameLength}자로 입력하세요.`);
  if (method !== 'formula' && method !== 'ai')
    return fail('method', '방식은 수식형 또는 AI형이어야 합니다.');
  if (typeof template !== 'string' || !Object.hasOwn(templateDefaults, template))
    return fail('template', '알 수 없는 템플릿입니다.');
  if (market !== 'KR' && market !== 'US') return fail('market', '시장은 KR 또는 US여야 합니다.');
  if (body.currency !== undefined && body.currency !== currencyOf(market))
    return fail(
      'currency',
      market === 'US'
        ? '미국 종목 알고리즘은 USD만 지원합니다.'
        : '국내 종목 알고리즘은 KRW만 지원합니다.',
    );
  if (!Array.isArray(targets) || targets.some((t) => typeof t !== 'string'))
    return fail('targets', '대상 종목은 문자열 목록이어야 합니다.');
  const normalizedTargets = (targets as string[]).map(normalizeSymbol);
  const targetError = validateTargets(normalizedTargets);
  if (targetError) return fail('targets', targetError);
  if (typeof mode !== 'string' || !algorithmModes.includes(mode as AlgorithmMode))
    return fail('mode', '모드는 시뮬레이션·모의·실전 중 하나여야 합니다.');
  if (method === 'ai' && mode === 'simulation')
    return fail('mode', 'AI형은 과거 시뮬레이션을 지원하지 않습니다. 모의 운용부터 시작합니다.');
  const currency = currencyOf(market);
  let parsedBudget: number | null = null;
  if (budget !== null && budget !== undefined) {
    if (!finite(budget) || budget <= 0 || budget > maxBudget[currency])
      return fail(
        'budget',
        `운용 금액은 0보다 크고 ${maxBudget[currency].toLocaleString('ko-KR')}${currency === 'KRW' ? '원' : ' USD'} 이하로 입력하세요.`,
      );
    parsedBudget = budget;
  }
  const isDual = template === 'dualMomentum';
  const defaults = templateDefaults[template as AlgorithmTemplateId];
  let parsedSignals: SignalWeight[] = [];
  let buyThreshold = 0;
  let sellThreshold = 0;
  let dualMomentum: DualMomentumParams | undefined;
  if (isDual) {
    const d = isRecord(body.dualMomentum) ? body.dualMomentum : {};
    const lookbackDays = d.lookbackDays ?? defaultDualMomentumParams.lookbackDays;
    const topN = d.topN ?? defaultDualMomentumParams.topN;
    const absoluteThreshold = d.absoluteThreshold ?? defaultDualMomentumParams.absoluteThreshold;
    const scale = d.scale ?? defaultDualMomentumParams.scale;
    if (
      !Number.isInteger(lookbackDays) ||
      (lookbackDays as number) < lookbackLimits.min ||
      (lookbackDays as number) > lookbackLimits.max
    )
      return fail(
        'dualMomentum.lookbackDays',
        `수익률 기간은 ${lookbackLimits.min}~${lookbackLimits.max} 사이 정수(거래일)여야 합니다.`,
      );
    if (
      !Number.isInteger(topN) ||
      (topN as number) < 1 ||
      (topN as number) > normalizedTargets.length
    )
      return fail(
        'dualMomentum.topN',
        '보유 종목 수는 1 이상 대상 종목 수 이하의 정수여야 합니다.',
      );
    if (!finite(absoluteThreshold) || absoluteThreshold < 0 || absoluteThreshold > 1)
      return fail('dualMomentum.absoluteThreshold', '절대 모멘텀 기준은 0~1 사이여야 합니다.');
    if (!finite(scale) || scale <= 0 || scale > 5)
      return fail('dualMomentum.scale', '점수 환산 기준은 0보다 크고 5 이하여야 합니다.');
    dualMomentum = {
      lookbackDays: lookbackDays as number,
      topN: topN as number,
      absoluteThreshold,
      scale,
    };
  } else {
    if (!Array.isArray(signals) || signals.length === 0 || signals.length > signalOrder.length)
      return fail('signals', '신호를 하나 이상 선택하세요.');
    const seen = new Set<string>();
    for (const s of signals) {
      if (!isRecord(s) || typeof s.id !== 'string' || !signalSet.has(s.id))
        return fail('signals', '알 수 없는 신호가 있습니다.');
      if (seen.has(s.id)) return fail('signals', `신호 ${s.id}이(가) 중복되었습니다.`);
      seen.add(s.id);
      if (!finite(s.weight) || s.weight < 0 || s.weight > 1)
        return fail(
          'signals',
          `${signalLabels[s.id as SignalId].label} 가중치는 0~1 사이여야 합니다.`,
        );
      parsedSignals.push({ id: s.id as SignalId, weight: s.weight });
    }
    if (!parsedSignals.some((s) => s.weight > 0))
      return fail('signals', '가중치가 0보다 큰 신호가 하나 이상 필요합니다.');
    buyThreshold =
      body.buyThreshold === undefined ? defaults.buyThreshold : (body.buyThreshold as number);
    sellThreshold =
      body.sellThreshold === undefined ? defaults.sellThreshold : (body.sellThreshold as number);
    if (!finite(buyThreshold) || buyThreshold < -1 || buyThreshold > 1)
      return fail('buyThreshold', '매수 기준은 -1~1 사이여야 합니다.');
    if (!finite(sellThreshold) || sellThreshold < -1 || sellThreshold > 1)
      return fail('sellThreshold', '매도 기준은 -1~1 사이여야 합니다.');
    if (!(sellThreshold < buyThreshold))
      return fail('sellThreshold', '매도 기준은 매수 기준보다 낮아야 합니다.');
  }
  const value: AlgorithmInput = {
    name: trimmed,
    method,
    template: template as AlgorithmTemplateId,
    market,
    targets: normalizedTargets,
    signals: parsedSignals,
    buyThreshold,
    sellThreshold,
    ...(dualMomentum ? { dualMomentum } : {}),
    mode: mode as AlgorithmMode,
    budget: parsedBudget,
  };
  // Final structural check by the engine's own validator (single source of truth).
  try {
    validateAlgorithm(toDefinition(value, defaultSignalParams));
  } catch (error) {
    return fail(
      'algorithm',
      `설정을 확인하세요. (${error instanceof Error ? error.message : '검증 실패'})`,
    );
  }
  return { ok: true, value };
}

/** Engine definition for an input/record. A missing budget uses `budgetFallback` (placeholder). */
export function toDefinition(
  a: AlgorithmInput,
  params: SignalParams,
  budgetFallback = 1,
): AlgorithmDefinition {
  return {
    name: a.name,
    // The engine only runs formulas; AI-method records are rejected before simulation.
    method: 'formula',
    template: a.template,
    market: a.market,
    symbols: [...a.targets],
    signals: a.signals.map((s) => ({ ...s })),
    params: structuredClone(params),
    dualMomentum: a.dualMomentum ? { ...a.dualMomentum } : undefined,
    buyThreshold: a.buyThreshold,
    sellThreshold: a.sellThreshold,
    budget: a.budget ?? budgetFallback,
  };
}

/** Default form values for a template. */
export function inputFromTemplate(
  template: AlgorithmTemplateId,
  market: Market = 'KR',
): AlgorithmInput {
  const t = templateDefaults[template];
  return {
    name: '',
    method: 'formula',
    template,
    market,
    targets: [],
    signals: t.signals.map((s) => ({ ...s })),
    buyThreshold: t.buyThreshold,
    sellThreshold: t.sellThreshold,
    ...(t.dualMomentum ? { dualMomentum: { ...t.dualMomentum } } : {}),
    mode: 'simulation',
    budget: null,
  };
}

// ---------------------------------------------------------------------------
// Change history.
// ---------------------------------------------------------------------------
export type ChangeField =
  | 'name'
  | 'method'
  | 'template'
  | 'market'
  | 'targets'
  | 'signals'
  | 'thresholds'
  | 'dualMomentum'
  | 'mode'
  | 'budget'
  | 'emergencyStop'
  | 'costs';
export type Change = {
  field: ChangeField;
  from?: string | null;
  to?: string | null;
  added?: string[];
  removed?: string[];
};
export type AlgorithmEventKind =
  'created' | 'updated' | 'deleted' | 'emergency-stop' | 'emergency-release' | 'costs-updated';
export type AlgorithmEvent = {
  id: string;
  at: string;
  kind: AlgorithmEventKind;
  algorithmId?: string;
  algorithmName?: string;
  changes: Change[];
};

const signalsText = (signals: SignalWeight[]) =>
  signals.length === 0 ? '(없음)' : signals.map((s) => `${s.id} ${s.weight}`).join(', ');
const dualText = (d?: DualMomentumParams) =>
  d
    ? `기간 ${d.lookbackDays}일, 상위 ${d.topN}, 절대 기준 ${d.absoluteThreshold}, 환산 ${d.scale}`
    : null;

/** What changed between two versions of an algorithm (empty array = no change). */
export function diffAlgorithm(before: AlgorithmInput | null, after: AlgorithmInput): Change[] {
  const changes: Change[] = [];
  const text = (field: ChangeField, from: string | null, to: string | null) => {
    if (from !== to) changes.push({ field, from, to });
  };
  if (!before) {
    changes.push({ field: 'targets', added: [...after.targets], removed: [] });
    text('mode', null, after.mode);
    text('budget', null, after.budget === null ? null : String(after.budget));
    return changes;
  }
  text('name', before.name, after.name);
  text('method', before.method, after.method);
  text('template', before.template, after.template);
  text('market', before.market, after.market);
  const added = after.targets.filter((t) => !before.targets.includes(t));
  const removed = before.targets.filter((t) => !after.targets.includes(t));
  if (added.length || removed.length) changes.push({ field: 'targets', added, removed });
  text('signals', signalsText(before.signals), signalsText(after.signals));
  text(
    'thresholds',
    `매수 ${before.buyThreshold} / 매도 ${before.sellThreshold}`,
    `매수 ${after.buyThreshold} / 매도 ${after.sellThreshold}`,
  );
  text('dualMomentum', dualText(before.dualMomentum), dualText(after.dualMomentum));
  text('mode', before.mode, after.mode);
  text(
    'budget',
    before.budget === null ? null : String(before.budget),
    after.budget === null ? null : String(after.budget),
  );
  return changes;
}

/** True when `after` raises an existing budget (the notification case). */
export function budgetRaised(before: AlgorithmInput, after: AlgorithmInput): boolean {
  return before.budget !== null && after.budget !== null && after.budget > before.budget;
}

/** First algorithm already in live mode that shares a target symbol (live algorithms must not overlap). */
export function findLiveOverlap(
  candidate: { id?: string; targets: readonly string[] },
  others: readonly Pick<AlgorithmRecord, 'id' | 'name' | 'mode' | 'targets'>[],
): { name: string; symbols: string[] } | null {
  for (const other of others) {
    if (other.id === candidate.id || other.mode !== 'live') continue;
    const symbols = other.targets.filter((s) => candidate.targets.includes(s));
    if (symbols.length > 0) return { name: other.name, symbols };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cost and tax settings. No legal rate is hardcoded anywhere.
// ---------------------------------------------------------------------------
export type CostSettingsInput = {
  /** Fraction of notional per side. Until the Toss commissions adapter exists this is manual. */
  commissionRate: number | null;
  /** KR securities transaction tax, fraction of sell notional. */
  sellTaxRate: number | null;
  /** US capital-gains tax; deduction in USD (convert any KRW deduction yourself). */
  capitalGainsTax: { rate: number; annualDeduction: number } | null;
};
export type CostSettingsRecord = CostSettingsInput & { updatedAt: string | null };
export const maxRate = 0.5;

export type ParsedCosts = { ok: true; value: CostSettingsInput } | ({ ok: false } & InputIssue);
export function parseCostSettings(body: unknown): ParsedCosts {
  const bad = (field: string, message: string): ParsedCosts => ({ ok: false, field, message });
  if (!isRecord(body)) return bad('body', '세금·수수료 설정이 필요합니다.');
  const rate = (v: unknown) => v === null || (finite(v) && v >= 0 && v <= maxRate);
  const commissionRate = body.commissionRate ?? null;
  const sellTaxRate = body.sellTaxRate ?? null;
  if (!rate(commissionRate))
    return bad(
      'commissionRate',
      `수수료율은 0 이상 ${maxRate} 이하의 비율이거나 비워 두어야 합니다.`,
    );
  if (!rate(sellTaxRate))
    return bad(
      'sellTaxRate',
      `증권거래세율은 0 이상 ${maxRate} 이하의 비율이거나 비워 두어야 합니다.`,
    );
  let capitalGainsTax: CostSettingsInput['capitalGainsTax'] = null;
  if (body.capitalGainsTax !== null && body.capitalGainsTax !== undefined) {
    const c = body.capitalGainsTax;
    if (
      !isRecord(c) ||
      !finite(c.rate) ||
      c.rate < 0 ||
      c.rate > maxRate ||
      !finite(c.annualDeduction) ||
      c.annualDeduction < 0 ||
      c.annualDeduction > maxBudget.KRW
    )
      return bad('capitalGainsTax', '양도소득세율(0~0.5)과 연 공제액(0 이상)을 확인하세요.');
    capitalGainsTax = { rate: c.rate, annualDeduction: c.annualDeduction };
  }
  return {
    ok: true,
    value: {
      commissionRate: commissionRate as number | null,
      sellTaxRate: sellTaxRate as number | null,
      capitalGainsTax,
    },
  };
}
