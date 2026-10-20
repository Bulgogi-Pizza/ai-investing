export const assetKeys = ['stock', 'bond', 'gold', 'cash'] as const;
export type AssetKey = (typeof assetKeys)[number];
export type Targets = Record<AssetKey, number>;
export interface Strategy {
  targets: Targets;
  risk: string;
  horizon: number;
  benchmark: string;
  preferences: string[];
}
export const assetLabels: Record<AssetKey, string> = {
  stock: '주식',
  bond: '채권',
  gold: '금',
  cash: '현금',
};
export const initialStrategy: Strategy = {
  targets: { stock: 55, bond: 25, gold: 10, cash: 10 },
  risk: 'balanced',
  horizon: 5,
  benchmark: 'S&P 500',
  preferences: ['분산 투자', '장기 성장'],
};
export function validateTargets(targets: Targets): string | null {
  if (
    assetKeys.some(
      (key) => !Number.isFinite(targets[key]) || targets[key] < 0 || targets[key] > 100,
    )
  )
    return '각 비중은 0~100 사이의 숫자여야 합니다.';
  return Math.abs(assetKeys.reduce((sum, key) => sum + targets[key], 0) - 100) > 0.001
    ? '목표 비중의 합계를 100%로 맞춰 주세요.'
    : null;
}
export function rebalance(total: number, current: Targets, targets: Targets) {
  if (!Number.isFinite(total) || total < 0 || validateTargets(current) || validateTargets(targets))
    throw new Error('유효한 자산 금액과 비중이 필요합니다.');
  return assetKeys.map((key) => ({
    key,
    current: current[key],
    target: targets[key],
    difference: targets[key] - current[key],
    amount: (total * (targets[key] - current[key])) / 100,
  }));
}
export function defensiveScenario(targets: Targets): Targets {
  if (validateTargets(targets)) throw new Error('유효한 비중이 필요합니다.');
  const transfer = Math.min(5, targets.stock);
  return {
    ...targets,
    stock: targets.stock - transfer,
    bond: targets.bond + transfer * 0.6,
    cash: targets.cash + transfer * 0.4,
  };
}

export function parseStoredStrategy(remote: unknown): Strategy | null {
  if (!remote || typeof remote !== 'object') return null;
  const value = remote as Record<string, unknown>;
  if (!Array.isArray(value.targetAllocations)) return null;
  const targets = Object.fromEntries(
    assetKeys.map((key) => [
      key,
      value.targetAllocations instanceof Array
        ? (value.targetAllocations.find((item: { asset: string }) => item.asset === key)
            ?.percentage ?? 0)
        : 0,
    ]),
  ) as Targets;
  if (validateTargets(targets)) return null;
  return {
    targets,
    risk:
      value.riskTolerance === 'low'
        ? 'conservative'
        : value.riskTolerance === 'high'
          ? 'growth'
          : 'balanced',
    horizon: Number(value.horizon) || 5,
    benchmark: typeof value.benchmark === 'string' ? value.benchmark : 'S&P 500',
    preferences: typeof value.notes === 'string' ? value.notes.split(' · ').filter(Boolean) : [],
  };
}
export type AnalysisPeriod = 'daily' | 'weekly' | 'monthly';
export function analyzeStrategy(prices: number[], strategy: Strategy, period: AnalysisPeriod) {
  if (
    prices.length < 21 ||
    prices.some((value) => !Number.isFinite(value) || value <= 0) ||
    validateTargets(strategy.targets)
  )
    throw new Error('분석 입력을 확인해 주세요.');
  const window = period === 'daily' ? 1 : period === 'weekly' ? 5 : 20;
  const last = prices.at(-1)!;
  const change = (last / prices[prices.length - window - 1] - 1) * 100;
  const average = prices.slice(-20).reduce((sum, value) => sum + value, 0) / 20;
  const deviation = (last / average - 1) * 100;
  const threshold = strategy.risk === 'conservative' ? 2 : strategy.risk === 'growth' ? 6 : 4;
  const action =
    change > threshold
      ? '추격 확대 전 비중 점검'
      : change < -threshold
        ? '손실 감내 범위 점검'
        : '목표 배분 유지 여부 점검';
  return {
    window,
    change,
    average,
    deviation,
    threshold,
    action,
    stockTarget: strategy.targets.stock,
    horizon: strategy.horizon,
  };
}
