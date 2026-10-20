import { defaultSignalParams, requiredBarsForSignal } from './signals';
import {
  historicalSignalIds,
  type AlgorithmDefinition,
  type AlgorithmTemplateId,
  type DualMomentumParams,
  type Market,
  type SignalParams,
  type SignalWeight,
} from './types';

export type TemplateDefaults = {
  label: string;
  description: string;
  signals: SignalWeight[];
  buyThreshold: number;
  sellThreshold: number;
  dualMomentum?: DualMomentumParams;
};

export const defaultDualMomentumParams: DualMomentumParams = {
  lookbackDays: 252,
  topN: 1,
  absoluteThreshold: 0,
  scale: 0.2,
};

/**
 * Pre-built strategies. Parameters are defaults only; the registering user can change signals,
 * weights and thresholds. Signal parameters come from `defaultSignalParams`.
 */
export const templateDefaults: Record<AlgorithmTemplateId, TemplateDefaults> = {
  momentum: {
    label: '모멘텀',
    description: '추세(이동평균·ADX)와 60거래일 수익률이 강한 종목을 사고, 약해지면 판다.',
    signals: [
      { id: 'trend', weight: 0.4 },
      { id: 'momentum', weight: 0.6 },
    ],
    buyThreshold: 0.3,
    sellThreshold: -0.1,
  },
  meanReversion: {
    label: '평균회귀',
    description: 'RSI와 볼린저 %B로 과매도 종목을 사고, 평균으로 돌아오면(점수 0 이하) 판다.',
    signals: [{ id: 'meanReversion', weight: 1 }],
    buyThreshold: 0.5,
    sellThreshold: 0,
  },
  dualMomentum: {
    label: '듀얼 모멘텀',
    description:
      '대상 목록에서 252거래일(12개월) 수익률 상위 1종목(상대 모멘텀)만 보유하고, 수익률이 0 이하이면(절대 모멘텀) 보유하지 않는다.',
    signals: [],
    buyThreshold: 0,
    sellThreshold: 0,
    dualMomentum: defaultDualMomentumParams,
  },
  custom: {
    label: '직접 구성',
    description: '신호와 가중치, 기준값을 직접 정한다.',
    signals: [{ id: 'trend', weight: 1 }],
    buyThreshold: 0.3,
    sellThreshold: -0.3,
  },
};

export type AlgorithmBase = {
  name: string;
  market: Market;
  symbols: string[];
  budget: number;
};

export type AlgorithmOverrides = Partial<
  Pick<
    AlgorithmDefinition,
    'signals' | 'buyThreshold' | 'sellThreshold' | 'dualMomentum' | 'positionFraction'
  >
> & { params?: { [K in keyof SignalParams]?: Partial<SignalParams[K]> } };

/** Build a definition from a template and optional overrides; validates the result. */
export function createAlgorithm(
  template: AlgorithmTemplateId,
  base: AlgorithmBase,
  overrides: AlgorithmOverrides = {},
): AlgorithmDefinition {
  const t = templateDefaults[template];
  const params: SignalParams = {
    trend: { ...defaultSignalParams.trend, ...overrides.params?.trend },
    momentum: { ...defaultSignalParams.momentum, ...overrides.params?.momentum },
    meanReversion: { ...defaultSignalParams.meanReversion, ...overrides.params?.meanReversion },
    value: { ...defaultSignalParams.value, ...overrides.params?.value },
  };
  const algorithm: AlgorithmDefinition = {
    name: base.name,
    method: 'formula',
    template,
    market: base.market,
    symbols: [...base.symbols],
    signals: (overrides.signals ?? t.signals).map((s) => ({ ...s })),
    params,
    dualMomentum:
      template === 'dualMomentum' ? { ...t.dualMomentum!, ...overrides.dualMomentum } : undefined,
    buyThreshold: overrides.buyThreshold ?? t.buyThreshold,
    sellThreshold: overrides.sellThreshold ?? t.sellThreshold,
    budget: base.budget,
    positionFraction: overrides.positionFraction,
  };
  validateAlgorithm(algorithm);
  return algorithm;
}

const known = new Set<string>([...historicalSignalIds, 'supply', 'news']);

/** Throws a descriptive error for an invalid definition. */
export function validateAlgorithm(a: AlgorithmDefinition): void {
  const fail = (msg: string): never => {
    throw new Error(`algorithm: ${msg}`);
  };
  if (a.method !== 'formula') fail('only method "formula" is supported here');
  if (a.market !== 'KR' && a.market !== 'US') fail('market must be KR or US');
  if (!a.name.trim()) fail('name is required');
  if (a.symbols.length === 0) fail('symbols must not be empty');
  if (new Set(a.symbols).size !== a.symbols.length) fail('symbols must be unique');
  if (!(a.budget > 0) || !Number.isFinite(a.budget)) fail('budget must be a positive number');
  if (a.positionFraction !== undefined && !(a.positionFraction > 0 && a.positionFraction <= 1))
    fail('positionFraction must be within (0, 1]');
  if (a.template === 'dualMomentum') {
    const d = a.dualMomentum;
    if (!d) return fail('dualMomentum parameters are required');
    if (!Number.isInteger(d.lookbackDays) || d.lookbackDays < 1)
      fail('lookbackDays must be a positive integer');
    if (!Number.isInteger(d.topN) || d.topN < 1) fail('topN must be a positive integer');
    if (!(d.absoluteThreshold >= 0)) fail('absoluteThreshold must be >= 0');
    if (!(d.scale > 0)) fail('scale must be > 0');
    return;
  }
  if (a.signals.length === 0) fail('at least one signal is required');
  const seen = new Set<string>();
  for (const s of a.signals) {
    if (!known.has(s.id)) fail(`unknown signal ${s.id}`);
    if (seen.has(s.id)) fail(`duplicate signal ${s.id}`);
    seen.add(s.id);
    if (!Number.isFinite(s.weight) || s.weight < 0) fail(`weight of ${s.id} must be >= 0`);
  }
  if (!a.signals.some((s) => s.weight > 0)) fail('at least one signal needs a positive weight');
  const inRange = (x: number) => Number.isFinite(x) && x >= -1 && x <= 1;
  if (!inRange(a.buyThreshold) || !inRange(a.sellThreshold))
    fail('thresholds must be within [-1, 1]');
  if (!(a.sellThreshold < a.buyThreshold)) fail('sellThreshold must be below buyThreshold');
}

/** Completed bars needed before the algorithm can decide on a symbol (warm-up length). */
export function requiredBars(a: AlgorithmDefinition): number {
  if (a.template === 'dualMomentum') return a.dualMomentum?.lookbackDays ?? 0;
  return Math.max(
    0,
    ...a.signals.filter((s) => s.weight > 0).map((s) => requiredBarsForSignal(s.id, a.params)),
  );
}
