// SYNTHETIC SEC companyfacts payload for company SYNT (CIK 1234567, fiscal year = calendar year).
// Field names follow the observed companyfacts layout; every value is invented.
// fy/fp/frame are deliberately WRONG on every entry: the adapter must not rely on them.
export interface Entry {
  start?: string;
  end: string;
  val: number;
  accn: string;
  fy: number;
  fp: string;
  form: string;
  filed: string;
}

export const filings = {
  q1_24: { accn: '0000000001-24-000001', form: '10-Q', filed: '2024-05-02' },
  q2_24: { accn: '0000000001-24-000002', form: '10-Q', filed: '2024-08-01' },
  q3_24: { accn: '0000000001-24-000003', form: '10-Q', filed: '2024-10-31' },
  k_24: { accn: '0000000001-25-000001', form: '10-K', filed: '2025-02-20' },
  k_24_amend: { accn: '0000000001-25-000009', form: '10-K/A', filed: '2025-04-01' },
  q1_25: { accn: '0000000001-25-000002', form: '10-Q', filed: '2025-05-01' },
  q2_25: { accn: '0000000001-25-000003', form: '10-Q', filed: '2025-07-31' },
  q3_25: { accn: '0000000001-25-000004', form: '10-Q', filed: '2025-10-30' },
  k_25: { accn: '0000000001-26-000001', form: '10-K', filed: '2026-02-19' },
  q1_26: { accn: '0000000001-26-000002', form: '10-Q', filed: '2026-04-30' },
} as const;
type FilingKey = keyof typeof filings;

export function entry(filing: FilingKey, end: string, val: number, start?: string): Entry {
  const { accn, form, filed } = filings[filing];
  return { ...(start ? { start } : {}), end, val, accn, fy: 2099, fp: 'FY', form, filed };
}
const duration = (filing: FilingKey, start: string, end: string, val: number) =>
  entry(filing, end, val, start);

const netIncome = [
  duration('q1_24', '2024-01-01', '2024-03-31', 80),
  duration('q2_24', '2024-04-01', '2024-06-30', 90),
  duration('q2_24', '2024-01-01', '2024-06-30', 170),
  duration('q3_24', '2024-07-01', '2024-09-30', 95),
  duration('q3_24', '2024-01-01', '2024-09-30', 265),
  duration('k_24', '2024-01-01', '2024-12-31', 400),
  duration('k_24_amend', '2024-01-01', '2024-12-31', 999),
  duration('q1_25', '2025-01-01', '2025-03-31', 90),
  duration('q1_25', '2024-01-01', '2024-03-31', 81), // restated comparative: must not replace 80
  duration('q2_25', '2025-04-01', '2025-06-30', 100),
  duration('q3_25', '2025-07-01', '2025-09-30', 110),
  duration('q3_25', '2025-01-01', '2025-09-30', 300),
  duration('k_25', '2025-01-01', '2025-12-31', 430),
  duration('k_25', '2024-01-01', '2024-12-31', 405), // restated comparative
  duration('q1_26', '2026-01-01', '2026-03-31', 120),
];
const revenueContract = [
  duration('q1_24', '2024-01-01', '2024-03-31', 400),
  duration('q2_24', '2024-04-01', '2024-06-30', 420),
  duration('q3_24', '2024-07-01', '2024-09-30', 430),
  duration('q3_24', '2024-01-01', '2024-09-30', 1250),
  duration('k_24', '2024-01-01', '2024-12-31', 1700),
  duration('q1_25', '2025-01-01', '2025-03-31', 440), // lower priority than Revenues below
];
const revenues = [
  duration('q1_25', '2025-01-01', '2025-03-31', 450),
  duration('q2_25', '2025-04-01', '2025-06-30', 460),
  duration('q3_25', '2025-07-01', '2025-09-30', 470),
  duration('q3_25', '2025-01-01', '2025-09-30', 1380),
  duration('k_25', '2025-01-01', '2025-12-31', 1900),
  duration('q1_26', '2026-01-01', '2026-03-31', 500),
];
const operatingIncome = [
  duration('q1_25', '2025-01-01', '2025-03-31', 100),
  duration('q2_25', '2025-04-01', '2025-06-30', 110),
  duration('q3_25', '2025-07-01', '2025-09-30', 120),
  duration('q3_25', '2025-01-01', '2025-09-30', 330),
  duration('k_25', '2025-01-01', '2025-12-31', 470),
];
const equity = [
  entry('q1_24', '2024-03-31', 1000),
  entry('q2_24', '2024-06-30', 1020),
  entry('q3_24', '2024-09-30', 1040),
  entry('k_24', '2024-12-31', 1060),
  entry('q1_25', '2025-03-31', 1100),
  entry('q2_25', '2025-06-30', 1150),
  entry('q3_25', '2025-09-30', 1200),
  entry('k_25', '2025-12-31', 1250),
  entry('q1_26', '2026-03-31', 1300),
  entry('k_25', '2024-12-31', 1070), // later comparative of an older balance: ignored
];
const assets = [
  entry('q3_25', '2025-09-30', 2900),
  entry('k_25', '2025-12-31', 3000),
  entry('k_24', '2024-12-31', 2500),
];
const liabilities = [entry('q3_25', '2025-09-30', 1700), entry('k_25', '2025-12-31', 1750)];
const shares = (filing: FilingKey, end: string, val: number): Entry => entry(filing, end, val);

export function unit(entries: Entry[], name = 'USD') {
  return { label: 'synthetic', description: 'synthetic', units: { [name]: entries } };
}

export function companyFacts(overrides: Record<string, unknown> = {}) {
  return {
    cik: 1234567,
    entityName: 'Synthetic Corp',
    facts: {
      dei: {
        EntityCommonStockSharesOutstanding: unit(
          [
            shares('k_24', '2025-02-14', 100),
            shares('q1_25', '2025-04-25', 100),
            // two share classes with different counts in one filing: ambiguous
            shares('q2_25', '2025-07-25', 100),
            shares('q2_25', '2025-07-25', 50),
            shares('q3_25', '2025-10-24', 100),
            shares('k_25', '2026-02-12', 100),
            shares('q1_26', '2026-04-24', 100),
          ],
          'shares',
        ),
      },
      'us-gaap': {
        RevenueFromContractWithCustomerExcludingAssessedTax: unit(revenueContract),
        Revenues: unit(revenues),
        OperatingIncomeLoss: unit(operatingIncome),
        NetIncomeLoss: unit(netIncome),
        Assets: unit(assets),
        Liabilities: unit(liabilities),
        StockholdersEquity: unit(equity),
      },
    },
    ...overrides,
  };
}
