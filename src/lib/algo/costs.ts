import type { Market } from './types';

/** Annual capital-gains tax setting (US). Amounts are in the algorithm currency. */
export type CapitalGainsTaxSetting = { rate: number; annualDeduction: number };

/**
 * Cost inputs. No legal rate is hardcoded: commission comes from Toss `/commissions` at runtime,
 * the KR transaction tax and the US capital-gains tax are user settings. Omitted values count as
 * 0 and are flagged in `needsSetup` ("설정 필요"). FX is not a cost (USD-only US trading).
 */
export type CostSettings = {
  /** Fraction of notional per side, e.g. 0.00015. */
  commissionRate?: number;
  /** Fraction of sell notional (KR securities transaction tax). */
  sellTaxRate?: number;
  /** Net realized gains per calendar year above the deduction are taxed at `rate`. */
  capitalGainsTax?: CapitalGainsTaxSetting;
};

export type ResolvedCosts = {
  commissionRate: number;
  sellTaxRate: number;
  capitalGainsTax: CapitalGainsTaxSetting;
  /** Settings that were not supplied and therefore default to 0. */
  needsSetup: ('commissionRate' | 'sellTaxRate' | 'capitalGainsTax')[];
};

const assertRate = (name: string, v: number) => {
  if (!Number.isFinite(v) || v < 0 || v >= 1)
    throw new Error(`costs: ${name} must be within [0, 1)`);
};

export function resolveCosts(market: Market, settings: CostSettings = {}): ResolvedCosts {
  const needsSetup: ResolvedCosts['needsSetup'] = [];
  if (settings.commissionRate === undefined) needsSetup.push('commissionRate');
  if (market === 'KR' && settings.sellTaxRate === undefined) needsSetup.push('sellTaxRate');
  if (market === 'US' && settings.capitalGainsTax === undefined) needsSetup.push('capitalGainsTax');
  const commissionRate = settings.commissionRate ?? 0;
  const sellTaxRate = settings.sellTaxRate ?? 0;
  const capitalGainsTax = settings.capitalGainsTax ?? { rate: 0, annualDeduction: 0 };
  assertRate('commissionRate', commissionRate);
  assertRate('sellTaxRate', sellTaxRate);
  assertRate('capitalGainsTax.rate', capitalGainsTax.rate);
  if (!Number.isFinite(capitalGainsTax.annualDeduction) || capitalGainsTax.annualDeduction < 0)
    throw new Error('costs: capitalGainsTax.annualDeduction must be >= 0');
  return { commissionRate, sellTaxRate, capitalGainsTax, needsSetup };
}

/** Explicit round-trip cost as a fraction of notional: two commissions plus the sell tax. */
export function roundTripCostRate(
  c: Pick<ResolvedCosts, 'commissionRate' | 'sellTaxRate'>,
): number {
  return 2 * c.commissionRate + c.sellTaxRate;
}

/** Tax for one calendar year: max(0, net realized gain - deduction) * rate. No loss carry-over. */
export function capitalGainsTaxForYear(netGain: number, s: CapitalGainsTaxSetting): number {
  return Math.max(0, netGain - s.annualDeduction) * s.rate;
}

export const costWarnings: Record<ResolvedCosts['needsSetup'][number], string> = {
  commissionRate: '설정 필요: 매매 수수료율이 입력되지 않아 0으로 계산했다.',
  sellTaxRate: '설정 필요: 증권거래세율이 입력되지 않아 0으로 계산했다.',
  capitalGainsTax: '설정 필요: 양도소득세 설정이 입력되지 않아 0으로 계산했다.',
};
