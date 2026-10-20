// SYNTHETIC DART responses. Company, numbers and receipt numbers are invented.
// Field names follow the official guide (fnlttSinglAcntAll, stockTotqySttus, list).
export const reportCodes = { Q1: '11013', H1: '11012', Q3: '11014', FY: '11011' } as const;
export type ReportKey = keyof typeof reportCodes;

/** Amounts are written in millions of KRW to keep the table readable. */
export const won = (millions: number) =>
  (millions * 1_000_000).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export interface Flow {
  /** thstrm_amount (3-month for 1Q/반기/3Q, full year for the annual report) */
  current: number | null;
  /** thstrm_add_amount (cumulative) */
  cumulative?: number;
}
export interface ReportInput {
  receipt: string;
  filed: string;
  revenue?: Flow;
  operatingIncome?: Flow;
  /** attributable to owners of the parent */
  netIncome?: Flow;
  /** total profit including non-controlling interests (must NOT be used) */
  netIncomeTotal?: Flow;
  assets?: number;
  liabilities?: number;
  /** attributable to owners of the parent */
  equity?: number;
  equityTotal?: number;
  settlement?: string;
}

function amountRow(
  receipt: string,
  sjDiv: string,
  id: string,
  name: string,
  value: Flow | number,
  currency = 'KRW',
) {
  const flow: Flow = typeof value === 'number' ? { current: value } : value;
  return {
    rcept_no: receipt,
    reprt_code: '11011',
    bsns_year: '2025',
    corp_code: '00000001',
    sj_div: sjDiv,
    sj_nm: sjDiv,
    account_id: id,
    account_nm: name,
    account_detail: '-',
    thstrm_nm: '제 1 기',
    thstrm_amount: flow.current === null ? '' : won(flow.current),
    thstrm_add_amount: flow.cumulative === undefined ? '' : won(flow.cumulative),
    ord: '1',
    currency,
  };
}

export function statementResponse(input: ReportInput, options: { nci?: boolean } = {}) {
  const r = input.receipt;
  const rows = [];
  if (input.revenue) rows.push(amountRow(r, 'IS', 'ifrs-full_Revenue', '매출액', input.revenue));
  if (input.operatingIncome)
    rows.push(
      amountRow(r, 'IS', 'dart_OperatingIncomeLoss', '영업이익(손실)', input.operatingIncome),
    );
  if (input.netIncomeTotal)
    rows.push(amountRow(r, 'IS', 'ifrs-full_ProfitLoss', '당기순이익(손실)', input.netIncomeTotal));
  if (input.netIncome) {
    rows.push(
      amountRow(
        r,
        'IS',
        'ifrs-full_ProfitLossAttributableToOwnersOfParent',
        '지배기업 소유주지분',
        input.netIncome,
      ),
    );
    if (options.nci !== false)
      rows.push(
        amountRow(
          r,
          'IS',
          'ifrs-full_ProfitLossAttributableToNoncontrollingInterests',
          '비지배지분',
          1,
        ),
      );
  }
  if (input.assets !== undefined)
    rows.push(amountRow(r, 'BS', 'ifrs-full_Assets', '자산총계', input.assets));
  if (input.liabilities !== undefined)
    rows.push(amountRow(r, 'BS', 'ifrs-full_Liabilities', '부채총계', input.liabilities));
  if (input.equityTotal !== undefined)
    rows.push(amountRow(r, 'BS', 'ifrs-full_Equity', '자본총계', input.equityTotal));
  if (input.equity !== undefined) {
    rows.push(
      amountRow(
        r,
        'BS',
        'ifrs-full_EquityAttributableToOwnersOfParent',
        '지배기업 소유주지분',
        input.equity,
      ),
    );
    rows.push(amountRow(r, 'BS', 'ifrs-full_NoncontrollingInterests', '비지배지분', 1));
  }
  return { status: '000', message: '정상', list: rows };
}

export const noData = { status: '013', message: '조회된 데이타가 없습니다.' };

export function sharesResponse(shares: number, settlement: string) {
  const row = (se: string, value: string) => ({
    rcept_no: '20250101000001',
    corp_cls: 'Y',
    corp_code: '00000001',
    corp_name: '합성전자',
    se,
    isu_stock_totqy: '9,999,999,999',
    now_to_isu_stock_totqy: value,
    now_to_dcrs_stock_totqy: '0',
    istc_totqy: value,
    tesstk_co: '0',
    distb_stock_co: value,
    stlm_dt: settlement,
  });
  const text = shares.toLocaleString('en-US');
  return {
    status: '000',
    message: '정상',
    list: [row('보통주', text), row('우선주', '1,000'), row('합계', text), row('비고', '-')],
  };
}

function report(
  year: number,
  key: ReportKey,
  filed: string,
  seq: string,
  values: Omit<ReportInput, 'receipt' | 'filed'>,
): [string, ReportInput] {
  return [`${year}:${key}`, { receipt: `${filed.replaceAll('-', '')}${seq}`, filed, ...values }];
}

/** Synthetic company 000001: 2024 and 2025 complete, 2026 has only 1Q and 반기. */
export const synthetic = new Map<string, ReportInput>([
  report(2024, 'Q1', '2024-05-15', '000001', {
    revenue: { current: 90, cumulative: 90 },
    operatingIncome: { current: 18, cumulative: 18 },
    netIncome: { current: 9, cumulative: 9 },
    netIncomeTotal: { current: 11, cumulative: 11 },
    assets: 500,
    liabilities: 300,
    equity: 200,
    equityTotal: 205,
    settlement: '2024-03-31',
  }),
  report(2024, 'H1', '2024-08-14', '000001', {
    revenue: { current: 100, cumulative: 190 },
    operatingIncome: { current: 20, cumulative: 38 },
    netIncome: { current: 10, cumulative: 19 },
    netIncomeTotal: { current: 12, cumulative: 23 },
    assets: 510,
    liabilities: 305,
    equity: 205,
    equityTotal: 210,
    settlement: '2024-06-30',
  }),
  report(2024, 'Q3', '2024-11-14', '000001', {
    revenue: { current: 110, cumulative: 300 },
    operatingIncome: { current: 22, cumulative: 60 },
    netIncome: { current: 11, cumulative: 30 },
    netIncomeTotal: { current: 13, cumulative: 36 },
    assets: 520,
    liabilities: 310,
    equity: 210,
    equityTotal: 216,
    settlement: '2024-09-30',
  }),
  report(2024, 'FY', '2025-03-17', '000001', {
    revenue: { current: 400 },
    operatingIncome: { current: 88 },
    netIncome: { current: 44 },
    netIncomeTotal: { current: 52 },
    assets: 540,
    liabilities: 320,
    equity: 220,
    equityTotal: 228,
    settlement: '2024-12-31',
  }),
  report(2025, 'Q1', '2025-05-15', '000001', {
    revenue: { current: 100, cumulative: 100 },
    operatingIncome: { current: 20, cumulative: 20 },
    netIncome: { current: 10, cumulative: 10 },
    netIncomeTotal: { current: 12, cumulative: 12 },
    assets: 550,
    liabilities: 320,
    equity: 230,
    equityTotal: 238,
    settlement: '2025-03-31',
  }),
  report(2025, 'H1', '2025-08-14', '000001', {
    revenue: { current: 110, cumulative: 210 },
    operatingIncome: { current: 22, cumulative: 42 },
    netIncome: { current: 11, cumulative: 21 },
    netIncomeTotal: { current: 13, cumulative: 25 },
    assets: 560,
    liabilities: 320,
    equity: 240,
    equityTotal: 248,
    settlement: '2025-06-30',
  }),
  report(2025, 'Q3', '2025-11-14', '000001', {
    revenue: { current: 120, cumulative: 330 },
    operatingIncome: { current: 24, cumulative: 66 },
    netIncome: { current: 12, cumulative: 33 },
    netIncomeTotal: { current: 14, cumulative: 39 },
    assets: 570,
    liabilities: 320,
    equity: 250,
    equityTotal: 258,
    settlement: '2025-09-30',
  }),
  report(2025, 'FY', '2026-03-16', '000001', {
    revenue: { current: 460 },
    operatingIncome: { current: 95 },
    netIncome: { current: 50 },
    netIncomeTotal: { current: 58 },
    assets: 580,
    liabilities: 320,
    equity: 260,
    equityTotal: 268,
    settlement: '2025-12-31',
  }),
  report(2026, 'Q1', '2026-05-15', '000001', {
    revenue: { current: 120, cumulative: 120 },
    operatingIncome: { current: 25, cumulative: 25 },
    netIncome: { current: 13, cumulative: 13 },
    netIncomeTotal: { current: 15, cumulative: 15 },
    assets: 590,
    liabilities: 320,
    equity: 270,
    equityTotal: 278,
    settlement: '2026-03-31',
  }),
  report(2026, 'H1', '2026-08-14', '000001', {
    revenue: { current: 130, cumulative: 250 },
    operatingIncome: { current: 27, cumulative: 52 },
    netIncome: { current: 14, cumulative: 27 },
    netIncomeTotal: { current: 16, cumulative: 31 },
    assets: 600,
    liabilities: 320,
    equity: 280,
    equityTotal: 288,
    settlement: '2026-06-30',
  }),
]);

export function filingList(reports: Iterable<ReportInput>, page = 1) {
  const items = [...reports].map((item) => ({
    corp_cls: 'Y',
    corp_name: '합성전자',
    corp_code: '00000001',
    stock_code: '000001',
    report_nm: '정기보고서',
    rcept_no: item.receipt,
    flr_nm: '합성전자',
    rcept_dt: item.filed.replaceAll('-', ''),
    rm: '연',
  }));
  return {
    status: '000',
    message: '정상',
    page_no: page,
    page_count: 100,
    total_count: items.length,
    total_page: 1,
    list: items,
  };
}
