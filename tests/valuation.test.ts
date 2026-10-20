import { describe, expect, it } from 'vitest';
import {
  computePerShareMetrics,
  periodIndex,
  priceRatios,
  sectorSummary,
  statementsKnownAt,
  valuationAt,
  type FinancialStatement,
  type FiscalPeriod,
} from '../src/lib/valuation';

const periodEnds: Record<Exclude<FiscalPeriod, 'FY'>, string> = {
  Q1: '03-31',
  Q2: '06-30',
  Q3: '09-30',
  Q4: '12-31',
};
function statement(
  year: number,
  period: FiscalPeriod,
  overrides: Partial<FinancialStatement> = {},
): FinancialStatement {
  const end = `${year}-${periodEnds[period === 'FY' ? 'Q4' : period]}`;
  return {
    market: 'KR',
    symbol: '000001',
    periodType: period === 'FY' ? 'annual' : 'quarter',
    fiscalYear: year,
    fiscalPeriod: period,
    periodEnd: end,
    periodEndAssumed: false,
    // reports are filed 45 days after period end
    filedAt: new Date(Date.parse(end) + 45 * 86400000).toISOString().slice(0, 10),
    currency: 'KRW',
    scope: 'consolidated',
    derived: false,
    revenue: null,
    operatingIncome: null,
    netIncome: '100',
    totalAssets: null,
    totalLiabilities: null,
    totalEquity: '1000',
    sharesOutstanding: '50',
    source: 'DART',
    sourceUrl: 'https://example.invalid/synthetic',
    ...overrides,
  };
}
/** Eight consecutive quarters 2024Q1..2025Q4, net income 10..80 and equity 1000.. */
function quarters(): FinancialStatement[] {
  const result: FinancialStatement[] = [];
  let n = 0;
  for (const year of [2024, 2025])
    for (const q of ['Q1', 'Q2', 'Q3', 'Q4'] as const) {
      n++;
      result.push(
        statement(year, q, { netIncome: String(n * 10), totalEquity: String(1000 + n * 100) }),
      );
    }
  return result;
}

describe('시점 필터', () => {
  it('접수일이 기준일 이후인 재무제표는 제외한다', () => {
    const all = quarters();
    const known = statementsKnownAt(all, '2025-05-14');
    // 2025Q1 is filed 2025-05-15 (45 days after 03-31)
    expect(known.some((s) => s.fiscalYear === 2025)).toBe(false);
    expect(known).toHaveLength(4);
    expect(statementsKnownAt(all, '2025-05-15').some((s) => s.fiscalYear === 2025)).toBe(true);
    expect(
      statementsKnownAt(all, '2025-05-15', { inclusive: false }).some((s) => s.fiscalYear === 2025),
    ).toBe(false);
    expect(statementsKnownAt(all, new Date('2025-05-15T12:00:00Z'))).toHaveLength(5);
    expect(all).toHaveLength(8); // input is not mutated
  });
  it('잘못된 날짜와 잘못된 접수일을 거부한다', () => {
    expect(() => statementsKnownAt([], '2025/05/15')).toThrow(RangeError);
    expect(() => statementsKnownAt([], '2025-13-45')).toThrow(RangeError);
    expect(
      statementsKnownAt([statement(2025, 'Q1', { filedAt: 'unknown' })], '2030-01-01'),
    ).toEqual([]);
  });
  it('미래 데이터를 바꿔도 과거 시점의 결과는 변하지 않는다(미래 참조 없음)', () => {
    const all = quarters();
    const baseline = valuationAt(all, '2025-03-01', 1000);
    const tampered = quarters().map((s) =>
      s.fiscalYear === 2025
        ? { ...s, netIncome: '-9999', totalEquity: '1', sharesOutstanding: '1' }
        : s,
    );
    expect(valuationAt(tampered, '2025-03-01', 1000)).toEqual(baseline);
    expect(baseline.metrics.asOf).toBe('2025-02-14'); // 2024Q4 filed 45 days after 12-31
  });
});

describe('TTM·EPS·BPS·ROE', () => {
  it('최근 4개 분기 합으로 TTM 순이익과 주당 값을 계산한다', () => {
    const m = computePerShareMetrics(quarters());
    // 2025 Q1..Q4 = 50+60+70+80
    expect(m.ttm).toMatchObject({
      netIncome: 260,
      basis: 'four-quarters',
      periodEnd: '2025-12-31',
    });
    expect(m.shares?.value).toBe(50);
    expect(m.eps.value).toBeCloseTo(260 / 50);
    // equity at 2025Q4 = 1000 + 8*100
    expect(m.equity?.value).toBe(1800);
    expect(m.bps.value).toBeCloseTo(1800 / 50);
    // average of equity now (1800) and four quarters earlier (2024Q4 = 1400)
    expect(m.roe.value).toBeCloseTo(260 / 1600);
    expect(m.asOf).toBe('2026-02-14');
    expect(m.currency).toBe('KRW');
    expect(m.eps.asOf).toBe('2026-02-14');
  });
  it('연간 보고서가 가장 최근이면 연간 순이익을 TTM으로 쓴다', () => {
    const all = [
      ...quarters(),
      statement(2025, 'FY', { netIncome: '270', totalEquity: '1800', filedAt: '2026-03-01' }),
    ];
    const m = computePerShareMetrics(all);
    expect(m.ttm).toMatchObject({ netIncome: 270, basis: 'annual' });
    expect(m.asOf).toBe('2026-03-01');
    expect(periodIndex(all.at(-1)!)).toBe(periodIndex(statement(2025, 'Q4')));
  });
  it('분기가 하나 비면 가장 최근의 완전한 4분기 합으로 물러나고 그 기준일을 표시한다', () => {
    const all = quarters().filter((s) => !(s.fiscalYear === 2025 && s.fiscalPeriod === 'Q4'));
    const m = computePerShareMetrics(all);
    expect(m.ttm).toMatchObject({ netIncome: 50 + 60 + 70 + 40, periodEnd: '2025-09-30' });
    const gap = quarters().filter((s) => !(s.fiscalYear === 2025 && s.fiscalPeriod === 'Q2'));
    expect(computePerShareMetrics(gap).ttm?.periodEnd).toBe('2025-03-31');
  });
  it('데이터가 부족하면 이유 코드와 함께 null이다', () => {
    expect(computePerShareMetrics([]).eps).toEqual({
      value: null,
      reason: 'NO_STATEMENTS',
      asOf: null,
    });
    const three = quarters().slice(0, 3);
    const m = computePerShareMetrics(three);
    expect(m.eps.reason).toBe('INSUFFICIENT_QUARTERS');
    expect(m.roe.reason).toBe('INSUFFICIENT_QUARTERS');
    expect(m.bps.value).toBeCloseTo(1300 / 50); // book value needs no TTM
  });
  it('주식 수가 없거나 400일 넘게 오래됐으면 EPS·BPS를 만들지 않는다', () => {
    const noShares = quarters().map((s) => ({ ...s, sharesOutstanding: null }));
    const m = computePerShareMetrics(noShares);
    expect(m.eps).toMatchObject({ value: null, reason: 'MISSING_SHARES' });
    expect(m.bps).toMatchObject({ value: null, reason: 'MISSING_SHARES' });
    expect(m.roe.value).not.toBeNull(); // ROE does not need shares
    const stale = quarters().map((s) =>
      s.fiscalYear === 2025 ? { ...s, sharesOutstanding: null } : { ...s, sharesOutstanding: '50' },
    );
    // newest share count is 2024Q4 (2024-12-31), 365 days before the TTM end: still usable
    expect(computePerShareMetrics(stale).shares?.periodEnd).toBe('2024-12-31');
    const old = quarters().map((s) =>
      s.fiscalYear === 2025 || s.fiscalPeriod === 'Q4' ? { ...s, sharesOutstanding: null } : s,
    );
    expect(computePerShareMetrics(old).eps.reason).toBe('MISSING_SHARES');
  });
  it('음수·0 EPS와 자본은 비율을 null로 만들고 이유를 남긴다', () => {
    const loss = quarters().map((s) => ({ ...s, netIncome: '-10' }));
    const m = computePerShareMetrics(loss);
    expect(m.eps.value).toBeCloseTo(-40 / 50); // signed EPS is still reported
    const ratios = priceRatios(m, 1000);
    expect(ratios.per).toMatchObject({ value: null, reason: 'NON_POSITIVE_EPS' });
    expect(ratios.pbr.value).toBeCloseTo(1000 / m.bps.value!);
    const zero = quarters().map((s) => ({ ...s, netIncome: '0' }));
    expect(priceRatios(computePerShareMetrics(zero), 1000).per.reason).toBe('NON_POSITIVE_EPS');
    const negativeEquity = quarters().map((s) => ({ ...s, totalEquity: '-500' }));
    const n = computePerShareMetrics(negativeEquity);
    expect(priceRatios(n, 1000).pbr).toMatchObject({ value: null, reason: 'NON_POSITIVE_EQUITY' });
    expect(n.roe).toMatchObject({ value: null, reason: 'NON_POSITIVE_EQUITY' });
    const zeroEquity = quarters().map((s) => ({ ...s, totalEquity: '0' }));
    expect(computePerShareMetrics(zeroEquity).roe.reason).toBe('NON_POSITIVE_EQUITY');
  });
  it('4분기 전 자본이 없으면 ROE는 이력 부족이다', () => {
    const m = computePerShareMetrics(quarters().slice(4));
    expect(m.roe).toMatchObject({ value: null, reason: 'INSUFFICIENT_EQUITY_HISTORY' });
  });
  it('통화가 섞인 분기 합은 만들지 않는다', () => {
    const mixed = quarters().map((s, i) => (i === 7 ? { ...s, currency: 'USD' } : s));
    // the newest four mix KRW and USD, so TTM falls back to the last single-currency window
    expect(computePerShareMetrics(mixed).ttm?.periodEnd).not.toBe('2025-12-31');
  });
});

describe('PER·PBR', () => {
  it('PER = 가격 / TTM EPS, PBR = 가격 / BPS', () => {
    const m = computePerShareMetrics(quarters());
    const { per, pbr } = priceRatios(m, 104);
    expect(per.value).toBeCloseTo(104 / (260 / 50));
    expect(pbr.value).toBeCloseTo(104 / (1800 / 50));
    expect(per.asOf).toBe('2026-02-14');
  });
  it('가격이 잘못됐거나 통화가 다르면 계산하지 않는다', () => {
    const m = computePerShareMetrics(quarters());
    for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(priceRatios(m, price).per.reason).toBe('INVALID_PRICE');
    expect(priceRatios(m, 100, 'USD').per.reason).toBe('CURRENCY_MISMATCH');
    expect(priceRatios(m, 100, 'KRW').per.value).not.toBeNull();
  });
  it('데이터가 없으면 원인을 그대로 전달한다', () => {
    const ratios = priceRatios(computePerShareMetrics([]), 100);
    expect(ratios.per.reason).toBe('NO_STATEMENTS');
    expect(ratios.pbr.reason).toBe('NO_STATEMENTS');
  });
  it('valuationAt은 기준일 이전 공시만으로 계산한다', () => {
    const early = valuationAt(quarters(), '2025-12-31', 100, { priceCurrency: 'KRW' });
    expect(early.metrics.ttm?.periodEnd).toBe('2025-09-30');
    expect(early.ratios?.per.value).toBeCloseTo(100 / ((40 + 50 + 60 + 70) / 50));
    expect(valuationAt(quarters(), '2025-12-31').ratios).toBeNull();
  });
});

describe('업종 평균 도우미', () => {
  it('null·비유한 값을 빼고 평균·중앙값·개수를 돌려준다', () => {
    expect(sectorSummary([10, null, 20, undefined, 30, Number.NaN])).toEqual({
      count: 3,
      excluded: 3,
      mean: 20,
      median: 20,
    });
    expect(sectorSummary([1, 2, 3, 10])).toMatchObject({ count: 4, mean: 4, median: 2.5 });
    expect(sectorSummary([5])).toMatchObject({ count: 1, mean: 5, median: 5 });
    expect(sectorSummary([null, undefined])).toEqual({
      count: 0,
      excluded: 2,
      mean: null,
      median: null,
    });
    expect(sectorSummary([])).toEqual({ count: 0, excluded: 0, mean: null, median: null });
  });
  it('입력 배열을 바꾸지 않는다', () => {
    const values = [3, 1, 2];
    sectorSummary(values);
    expect(values).toEqual([3, 1, 2]);
  });
});
