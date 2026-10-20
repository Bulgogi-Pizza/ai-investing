// Pure valuation helpers shared by the server, the UI and the point-in-time backtester.
// No I/O, no clock access: every function depends only on its arguments.

export type FundamentalsMarket = 'KR' | 'US';
export type FiscalPeriod = 'FY' | 'Q1' | 'Q2' | 'Q3' | 'Q4';

/** Normalized statement of one fiscal period. Money values are decimal strings (toss.ts convention). */
export interface FinancialStatement {
  market: FundamentalsMarket;
  symbol: string;
  periodType: 'annual' | 'quarter';
  fiscalYear: number;
  fiscalPeriod: FiscalPeriod;
  /** YYYY-MM-DD */
  periodEnd: string;
  /** true when periodEnd was derived from the fiscal calendar instead of a provider field. */
  periodEndAssumed: boolean;
  /** YYYY-MM-DD: date the provider says the report became public (DART 접수일, SEC `filed`). */
  filedAt: string;
  currency: string;
  /** DART only: 연결(consolidated) or 별도(separate). SEC facts are as reported (consolidated). */
  scope: 'consolidated' | 'separate' | null;
  /** Quarter flows are 3-month amounts. true when Q4 was derived as annual minus nine-month. */
  derived: boolean;
  revenue: string | null;
  operatingIncome: string | null;
  /** Attributable to owners of the parent. */
  netIncome: string | null;
  totalAssets: string | null;
  totalLiabilities: string | null;
  /** Attributable to owners of the parent. */
  totalEquity: string | null;
  sharesOutstanding: string | null;
  source: 'DART' | 'SEC EDGAR';
  sourceUrl: string;
}

export type MetricReason =
  | 'NO_STATEMENTS'
  | 'INSUFFICIENT_QUARTERS'
  | 'MISSING_SHARES'
  | 'MISSING_EQUITY'
  | 'INSUFFICIENT_EQUITY_HISTORY'
  | 'NON_POSITIVE_EPS'
  | 'NON_POSITIVE_EQUITY'
  | 'INVALID_PRICE'
  | 'CURRENCY_MISMATCH';

export interface Metric {
  value: number | null;
  reason: MetricReason | null;
  /** Latest filedAt among the statements this metric used. */
  asOf: string | null;
}

export interface PerShareMetrics {
  /** Latest filedAt among all statements that contributed to any value below. */
  asOf: string | null;
  currency: string | null;
  ttm: {
    netIncome: number;
    periodEnd: string;
    fiscalYear: number;
    fiscalPeriod: FiscalPeriod;
    basis: 'annual' | 'four-quarters';
  } | null;
  shares: { value: number; periodEnd: string } | null;
  equity: { value: number; periodEnd: string } | null;
  /** TTM net income / shares. Signed: a negative EPS is reported as is. */
  eps: Metric;
  /** Latest equity / shares. Signed. */
  bps: Metric;
  /** TTM net income / average of equity now and four quarters earlier. Ratio, not percent. */
  roe: Metric;
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const maximumSharesAgeDays = 400;
const periodOffset: Record<FiscalPeriod, number> = { Q1: 0, Q2: 1, Q3: 2, Q4: 3, FY: 3 };

function dateString(value: string | Date): string {
  const result = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  if (!isoDate.test(result) || Number.isNaN(Date.parse(result)))
    throw new RangeError('날짜는 YYYY-MM-DD 형식이어야 합니다.');
  return result;
}

function num(value: string | null): number | null {
  if (value === null) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

const missing = (reason: MetricReason, asOf: string | null = null): Metric => ({
  value: null,
  reason,
  asOf,
});

/** Sequential quarter index: FY maps to the same slot as Q4. */
export function periodIndex(statement: Pick<FinancialStatement, 'fiscalYear' | 'fiscalPeriod'>) {
  return statement.fiscalYear * 4 + periodOffset[statement.fiscalPeriod];
}

/**
 * Point-in-time filter for the backtester: only statements that were public on `date`.
 * `inclusive` (default) keeps filedAt === date. A decision taken before the market opens on
 * `date` cannot know a filing made later that day, so such callers pass `inclusive: false`.
 */
export function statementsKnownAt(
  statements: readonly FinancialStatement[],
  date: string | Date,
  options: { inclusive?: boolean } = {},
): FinancialStatement[] {
  const limit = dateString(date);
  const inclusive = options.inclusive ?? true;
  return statements.filter(
    (statement) =>
      isoDate.test(statement.filedAt) &&
      (inclusive ? statement.filedAt <= limit : statement.filedAt < limit),
  );
}

function latestFiled(statements: readonly FinancialStatement[]): string | null {
  return statements.reduce<string | null>(
    (latest, statement) =>
      latest === null || statement.filedAt > latest ? statement.filedAt : latest,
    null,
  );
}

function newest(a: FinancialStatement | undefined, b: FinancialStatement) {
  return !a || b.filedAt > a.filedAt ? b : a;
}

function dayDifference(later: string, earlier: string) {
  return (Date.parse(later) - Date.parse(earlier)) / 86400000;
}

/** TTM net income, EPS, BPS and ROE from whatever statements the caller says are known. */
export function computePerShareMetrics(statements: readonly FinancialStatement[]): PerShareMetrics {
  const empty = (reason: MetricReason): PerShareMetrics => ({
    asOf: null,
    currency: null,
    ttm: null,
    shares: null,
    equity: null,
    eps: missing(reason),
    bps: missing(reason),
    roe: missing(reason),
  });
  const valid = statements.filter((statement) => isoDate.test(statement.filedAt));
  if (valid.length === 0) return empty('NO_STATEMENTS');

  // One statement per slot. A later filing of the same slot (a correction) wins.
  const quarters = new Map<number, FinancialStatement>();
  const annuals = new Map<number, FinancialStatement>();
  const anyAt = new Map<number, FinancialStatement[]>();
  for (const statement of valid) {
    const index = periodIndex(statement);
    const target = statement.periodType === 'annual' ? annuals : quarters;
    target.set(index, newest(target.get(index), statement));
    anyAt.set(index, [...(anyAt.get(index) ?? []), statement]);
  }

  // TTM: newest slot where a full trailing year of net income exists.
  const slots = [...new Set([...quarters.keys(), ...annuals.keys()])].sort((a, b) => b - a);
  let ttm: PerShareMetrics['ttm'] = null;
  let ttmUsed: FinancialStatement[] = [];
  let currency: string | null = null;
  let currencyMismatch = false;
  for (const slot of slots) {
    const annual = annuals.get(slot);
    const annualNet = annual ? num(annual.netIncome) : null;
    if (annual && annualNet !== null) {
      ttm = {
        netIncome: annualNet,
        periodEnd: annual.periodEnd,
        fiscalYear: annual.fiscalYear,
        fiscalPeriod: 'FY',
        basis: 'annual',
      };
      ttmUsed = [annual];
      currency = annual.currency;
      break;
    }
    const four = [slot, slot - 1, slot - 2, slot - 3].map((index) => quarters.get(index));
    if (four.every((statement) => statement && num(statement.netIncome) !== null)) {
      const used = four as FinancialStatement[];
      if (new Set(used.map((statement) => statement.currency)).size !== 1) {
        currencyMismatch = true;
        continue;
      }
      const latest = used[0];
      ttm = {
        netIncome: used.reduce((sum, statement) => sum + num(statement.netIncome)!, 0),
        periodEnd: latest.periodEnd,
        fiscalYear: latest.fiscalYear,
        fiscalPeriod: latest.fiscalPeriod,
        basis: 'four-quarters',
      };
      ttmUsed = used;
      currency = latest.currency;
      break;
    }
  }

  // Shares: newest statement with a usable count, not older than the TTM end by > 400 days.
  const byRecency = [...valid].sort((a, b) =>
    a.periodEnd < b.periodEnd ? 1 : a.periodEnd > b.periodEnd ? -1 : b.filedAt < a.filedAt ? -1 : 1,
  );
  const reference = ttm?.periodEnd ?? byRecency[0].periodEnd;
  const sharesStatement = byRecency.find((statement) => {
    const value = num(statement.sharesOutstanding);
    return (
      value !== null &&
      value > 0 &&
      isoDate.test(statement.periodEnd) &&
      dayDifference(reference, statement.periodEnd) <= maximumSharesAgeDays
    );
  });
  const shares = sharesStatement
    ? { value: num(sharesStatement.sharesOutstanding)!, periodEnd: sharesStatement.periodEnd }
    : null;

  const equityStatement = byRecency.find((statement) => num(statement.totalEquity) !== null);
  const equity = equityStatement
    ? { value: num(equityStatement.totalEquity)!, periodEnd: equityStatement.periodEnd }
    : null;
  if (!currency) currency = equityStatement?.currency ?? byRecency[0].currency;

  const ttmAsOf = latestFiled(ttmUsed);
  let eps: Metric;
  if (!ttm) eps = missing(currencyMismatch ? 'CURRENCY_MISMATCH' : 'INSUFFICIENT_QUARTERS');
  else if (!shares || !sharesStatement) eps = missing('MISSING_SHARES', ttmAsOf);
  else
    eps = {
      value: ttm.netIncome / shares.value,
      reason: null,
      asOf: latestFiled([...ttmUsed, sharesStatement]),
    };

  let bps: Metric;
  if (!equity || !equityStatement) bps = missing('MISSING_EQUITY');
  else if (!shares || !sharesStatement) bps = missing('MISSING_SHARES', equityStatement.filedAt);
  else
    bps = {
      value: equity.value / shares.value,
      reason: null,
      asOf: latestFiled([equityStatement, sharesStatement]),
    };

  let roe: Metric;
  if (!ttm) roe = missing(eps.reason ?? 'INSUFFICIENT_QUARTERS');
  else {
    const slot = ttm.fiscalYear * 4 + periodOffset[ttm.fiscalPeriod];
    const equityAt = (index: number) =>
      (anyAt.get(index) ?? [])
        .filter((statement) => num(statement.totalEquity) !== null)
        .reduce<FinancialStatement | undefined>(
          (best, statement) => newest(best, statement),
          undefined,
        );
    const now = equityAt(slot);
    const before = equityAt(slot - 4);
    if (!now || !before) roe = missing('INSUFFICIENT_EQUITY_HISTORY', ttmAsOf);
    else {
      const average = (num(now.totalEquity)! + num(before.totalEquity)!) / 2;
      const asOf = latestFiled([...ttmUsed, now, before]);
      roe =
        average > 0
          ? { value: ttm.netIncome / average, reason: null, asOf }
          : missing('NON_POSITIVE_EQUITY', asOf);
    }
  }

  const contributing = [...ttmUsed];
  if (sharesStatement) contributing.push(sharesStatement);
  if (equityStatement) contributing.push(equityStatement);
  return {
    asOf: latestFiled(contributing),
    currency,
    ttm,
    shares,
    equity,
    eps,
    bps,
    roe,
  };
}

export interface PriceRatios {
  per: Metric;
  pbr: Metric;
}

/** PER = price / EPS(TTM), PBR = price / BPS. Non-positive EPS or equity gives null with a reason. */
export function priceRatios(
  metrics: PerShareMetrics,
  price: number,
  priceCurrency?: string,
): PriceRatios {
  const fail = (metric: Metric, reason: MetricReason): Metric => missing(reason, metric.asOf);
  const invalidPrice = !Number.isFinite(price) || price <= 0;
  const currencyMismatch =
    priceCurrency !== undefined && metrics.currency !== null && priceCurrency !== metrics.currency;
  const ratio = (per: Metric, positiveReason: MetricReason): Metric => {
    if (per.value === null) return fail(per, per.reason ?? positiveReason);
    if (invalidPrice) return fail(per, 'INVALID_PRICE');
    if (currencyMismatch) return fail(per, 'CURRENCY_MISMATCH');
    if (per.value <= 0) return fail(per, positiveReason);
    return { value: price / per.value, reason: null, asOf: per.asOf };
  };
  return {
    per: ratio(metrics.eps, 'NON_POSITIVE_EPS'),
    pbr: ratio(metrics.bps, 'NON_POSITIVE_EQUITY'),
  };
}

/** Convenience for the backtester: filter to `date`, then compute. */
export function valuationAt(
  statements: readonly FinancialStatement[],
  date: string | Date,
  price?: number,
  options: { inclusive?: boolean; priceCurrency?: string } = {},
) {
  const metrics = computePerShareMetrics(statementsKnownAt(statements, date, options));
  return {
    metrics,
    ratios: price === undefined ? null : priceRatios(metrics, price, options.priceCurrency),
  };
}

export interface SectorSummary {
  /** Values that entered the statistics. */
  count: number;
  /** null, undefined and non-finite inputs that were left out. */
  excluded: number;
  mean: number | null;
  median: number | null;
}

/** Sector comparison helper: median and mean over the non-null values, reporting the count. */
export function sectorSummary(values: readonly (number | null | undefined)[]): SectorSummary {
  const usable = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  if (usable.length === 0) return { count: 0, excluded: values.length, mean: null, median: null };
  const sorted = [...usable].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: usable.length,
    excluded: values.length - usable.length,
    mean: usable.reduce((sum, value) => sum + value, 0) / usable.length,
    median: sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
  };
}
