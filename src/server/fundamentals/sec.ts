import type { FinancialStatement, FiscalPeriod } from '../../lib/valuation.js';
import {
  RateLimiter,
  SingleFlightCache,
  TtlCache,
  decimalFromNumber,
  fetchJson,
  isoDateOnly,
  notFound,
  record,
  schemaInvalid,
  text,
  type FundamentalsResult,
} from './shared.js';

// Official contract: SEC "Accessing EDGAR Data", "EDGAR APIs" and the webmaster developer FAQ
// (checked 2026-10-21). See docs/implementation/fundamentals.md.
const tickersUrl = 'https://www.sec.gov/files/company_tickers.json';
const factsBase = 'https://data.sec.gov/api/xbrl/companyfacts/';
export const secLimits = {
  tickersBytes: 3 * 1024 * 1024,
  factsBytes: 40 * 1024 * 1024,
  timeoutMs: 15000,
  tickersTtlMs: 24 * 3600 * 1000,
  statementsTtlMs: 6 * 3600 * 1000,
  // SEC allows 10 requests/second. One request per 250 ms is 4/second.
  minimumIntervalMs: 250,
};
const day = 86400000;
const allowedForms = new Set(['10-K', '10-Q']);

export interface TickerEntry {
  cik: number;
  title: string;
}

export function normalizeUsSymbol(symbol: string): string | null {
  const upper = symbol.toUpperCase();
  return /^[A-Z]{1,6}([.-][A-Z]{1,2})?$/.test(upper) ? upper.replace('.', '-') : null;
}

export function validSecUserAgent(value: string | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 200 &&
    /^[\x20-\x7e]+$/.test(value) &&
    (value.includes('@') || /https?:\/\//.test(value))
  );
}

export function parseTickers(json: Record<string, unknown>): Map<string, TickerEntry> {
  const values = Object.values(json);
  if (values.length === 0 || values.length > 100000) throw schemaInvalid();
  const map = new Map<string, TickerEntry>();
  for (const item of values) {
    const row = record(item);
    const cik =
      typeof row.cik_str === 'string' && /^\d+$/.test(row.cik_str)
        ? Number(row.cik_str)
        : row.cik_str;
    if (typeof cik !== 'number' || !Number.isSafeInteger(cik) || cik <= 0 || cik > 9999999999)
      throw schemaInvalid();
    const ticker = text(row.ticker, 20).toUpperCase();
    if (!map.has(ticker)) map.set(ticker, { cik, title: text(row.title, 300) });
  }
  return map;
}

interface Fact {
  start: string | null;
  end: string;
  value: number;
  accn: string;
  form: string;
  filed: string;
}

function readFacts(
  facts: Record<string, unknown>,
  taxonomy: string,
  tag: string,
  unit: string,
): Fact[] {
  const taxonomyNode = facts[taxonomy];
  if (taxonomyNode === undefined) return [];
  const tagNode = record(taxonomyNode)[tag];
  if (tagNode === undefined) return [];
  const units = record(record(tagNode).units);
  const entries = units[unit];
  if (entries === undefined) return [];
  if (!Array.isArray(entries) || entries.length > 100000) throw schemaInvalid();
  const result: Fact[] = [];
  for (const item of entries) {
    const row = record(item);
    const value = row.val;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw schemaInvalid();
    const fact: Fact = {
      start: row.start === undefined ? null : isoDateOnly(row.start),
      end: isoDateOnly(row.end),
      value,
      accn: text(row.accn, 40),
      form: text(row.form, 30),
      filed: isoDateOnly(row.filed),
    };
    // Amendments and foreign-issuer forms are not used: values are "as first reported".
    if (allowedForms.has(fact.form)) result.push(fact);
  }
  return result;
}

const earliest = (facts: Fact[]) =>
  [...facts].sort((a, b) =>
    a.filed === b.filed ? a.accn.localeCompare(b.accn) : a.filed < b.filed ? -1 : 1,
  )[0];

/** window key `start|end` -> first-reported fact, taking tags in priority order per window. */
function flowMap(facts: Record<string, unknown>, tags: string[]) {
  const map = new Map<string, Fact>();
  for (const tag of tags) {
    const groups = new Map<string, Fact[]>();
    for (const fact of readFacts(facts, 'us-gaap', tag, 'USD')) {
      if (fact.start === null) continue;
      const key = `${fact.start}|${fact.end}`;
      groups.set(key, [...(groups.get(key) ?? []), fact]);
    }
    for (const [key, group] of groups) if (!map.has(key)) map.set(key, earliest(group));
  }
  return map;
}
function instantMap(facts: Record<string, unknown>, tags: string[]) {
  const map = new Map<string, Fact>();
  for (const tag of tags) {
    const groups = new Map<string, Fact[]>();
    for (const fact of readFacts(facts, 'us-gaap', tag, 'USD')) {
      if (fact.start !== null) continue;
      groups.set(fact.end, [...(groups.get(fact.end) ?? []), fact]);
    }
    for (const [key, group] of groups) if (!map.has(key)) map.set(key, earliest(group));
  }
  return map;
}

export const secTags = {
  revenue: [
    'Revenues',
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'SalesRevenueNet',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
  ],
  operatingIncome: ['OperatingIncomeLoss'],
  netIncome: ['NetIncomeLoss'],
  totalAssets: ['Assets'],
  totalLiabilities: ['Liabilities'],
  totalEquity: ['StockholdersEquity'],
} as const;
type FlowField = 'revenue' | 'operatingIncome' | 'netIncome';
const flowFields: FlowField[] = ['revenue', 'operatingIncome', 'netIncome'];

function shift(date: string, days: number) {
  return new Date(Date.parse(date) + days * day).toISOString().slice(0, 10);
}
const span = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / day;
const fiscalYearOf = (end: string) => Number(shift(end, -15).slice(0, 4));

function subtract(a: number, b: number) {
  return Number.isSafeInteger(a) && Number.isSafeInteger(b) ? a - b : Number((a - b).toFixed(6));
}

export function buildSecStatements(
  json: Record<string, unknown>,
  symbol: string,
  sourceUrl: string,
  warnings: string[],
): FinancialStatement[] {
  const facts = record(json.facts);
  if (facts['us-gaap'] === undefined) {
    warnings.push(
      'us-gaap 재무 데이터가 없는 회사입니다(외국 발행사 등). 재무제표를 제공하지 않습니다.',
    );
    return [];
  }
  const flows = Object.fromEntries(
    flowFields.map((field) => [field, flowMap(facts, [...secTags[field]])]),
  ) as Record<FlowField, Map<string, Fact>>;
  const balances = {
    totalAssets: instantMap(facts, [...secTags.totalAssets]),
    totalLiabilities: instantMap(facts, [...secTags.totalLiabilities]),
    totalEquity: instantMap(facts, [...secTags.totalEquity]),
  };
  // dei cover-page share counts, keyed by filing. Several different values in one filing
  // (multiple share classes) are ambiguous, so no count is used.
  const sharesByAccn = new Map<string, Set<number>>();
  for (const fact of readFacts(facts, 'dei', 'EntityCommonStockSharesOutstanding', 'shares'))
    sharesByAccn.set(fact.accn, new Set([...(sharesByAccn.get(fact.accn) ?? []), fact.value]));

  const windows = new Map<string, { start: string; end: string }>();
  for (const field of flowFields)
    for (const key of flows[field].keys()) {
      const [start, end] = key.split('|');
      windows.set(key, { start, end });
    }
  const list = [...windows.entries()].map(([key, value]) => ({
    key,
    ...value,
    days: span(value.start, value.end),
  }));
  const annualWindows = list
    .filter((w) => w.days >= 350 && w.days <= 380)
    .sort((a, b) => (a.end < b.end ? -1 : 1));
  const quarterWindows = list.filter((w) => w.days >= 80 && w.days <= 100);
  const nineWindows = list.filter((w) => w.days >= 260 && w.days <= 290);

  const statements: FinancialStatement[] = [];
  const seen = new Set<string>();
  const flowFact = (field: FlowField, key: string | null) =>
    key ? flows[field].get(key) : undefined;

  const emit = (
    period: FiscalPeriod,
    fiscalYear: number,
    end: string,
    values: Record<FlowField, { value: string | null; facts: Fact[] }>,
    derived: boolean,
    balanceEnd = end,
  ) => {
    const slot = `${fiscalYear}:${period}`;
    if (seen.has(slot)) return;
    const used: Fact[] = [];
    for (const field of flowFields) used.push(...values[field].facts);
    const balanceValues = {} as Record<keyof typeof balances, string | null>;
    for (const field of Object.keys(balances) as (keyof typeof balances)[]) {
      const fact = balances[field].get(balanceEnd);
      balanceValues[field] = fact ? decimalFromNumber(fact.value) : null;
      if (fact) used.push(fact);
    }
    const primary = used[0];
    const shareSet = primary ? sharesByAccn.get(primary.accn) : undefined;
    const shares = shareSet && shareSet.size === 1 ? decimalFromNumber([...shareSet][0]) : null;
    const numbers = [
      values.revenue.value,
      values.operatingIncome.value,
      values.netIncome.value,
      balanceValues.totalAssets,
      balanceValues.totalLiabilities,
      balanceValues.totalEquity,
    ];
    if (numbers.every((value) => value === null) || used.length === 0) return;
    seen.add(slot);
    statements.push({
      market: 'US',
      symbol,
      periodType: period === 'FY' ? 'annual' : 'quarter',
      fiscalYear,
      fiscalPeriod: period,
      periodEnd: end,
      periodEndAssumed: false,
      filedAt: used
        .map((fact) => fact.filed)
        .sort()
        .at(-1)!,
      currency: 'USD',
      scope: 'consolidated',
      derived,
      revenue: values.revenue.value,
      operatingIncome: values.operatingIncome.value,
      netIncome: values.netIncome.value,
      totalAssets: balanceValues.totalAssets,
      totalLiabilities: balanceValues.totalLiabilities,
      totalEquity: balanceValues.totalEquity,
      sharesOutstanding: shares,
      source: 'SEC EDGAR',
      sourceUrl,
    });
  };
  const direct = (key: string) =>
    Object.fromEntries(
      flowFields.map((field) => {
        const fact = flowFact(field, key);
        return [
          field,
          { value: fact ? decimalFromNumber(fact.value) : null, facts: fact ? [fact] : [] },
        ];
      }),
    ) as Record<FlowField, { value: string | null; facts: Fact[] }>;

  // Annual (10-K) windows. A duplicate fiscal year keeps the later window.
  const annuals = new Map<number, (typeof annualWindows)[number]>();
  for (const window of annualWindows) annuals.set(fiscalYearOf(window.end), window);
  const annualList = [...annuals.values()];
  for (const [year, window] of annuals) {
    emit('FY', year, window.end, direct(window.key), false);
    // Q4 = annual - nine-month year-to-date that starts with the same fiscal year.
    const nine = nineWindows.find((w) => Math.abs(span(window.start, w.start)) <= 3);
    const fourth = Object.fromEntries(
      flowFields.map((field) => {
        const annual = flowFact(field, window.key);
        const ytd = nine ? flowFact(field, nine.key) : undefined;
        return [
          field,
          annual && ytd
            ? { value: decimalFromNumber(subtract(annual.value, ytd.value)), facts: [annual, ytd] }
            : { value: null, facts: [] },
        ];
      }),
    ) as Record<FlowField, { value: string | null; facts: Fact[] }>;
    // The year-end balance sheet always comes from the annual report; a missing nine-month
    // figure only leaves the Q4 flows null.
    emit('Q4', year, window.end, fourth, true);
  }

  // 3-month windows from 10-Q filings.
  for (const window of quarterWindows) {
    const containing = annualList.find(
      (a) =>
        Date.parse(window.start) >= Date.parse(a.start) - 5 * day &&
        Date.parse(window.end) <= Date.parse(a.end) + 5 * day,
    );
    let yearStart: string;
    let fiscalYear: number;
    if (containing) {
      yearStart = containing.start;
      fiscalYear = fiscalYearOf(containing.end);
    } else {
      const prior = annualList
        .filter((a) => Date.parse(a.end) < Date.parse(window.start) + 5 * day)
        .sort((a, b) => (a.end < b.end ? 1 : -1))[0];
      if (!prior) continue;
      yearStart = shift(prior.end, 1);
      fiscalYear = fiscalYearOf(shift(yearStart, 364));
    }
    const offset = span(yearStart, window.start);
    const number = Math.round(offset / 91.3) + 1;
    if (number < 1 || number > 4 || Math.abs(offset - (number - 1) * 91.3) > 12) continue;
    emit(`Q${number}` as FiscalPeriod, fiscalYear, window.end, direct(window.key), false);
  }
  return statements.sort((a, b) =>
    a.periodEnd < b.periodEnd
      ? -1
      : a.periodEnd > b.periodEnd
        ? 1
        : a.periodType === 'annual'
          ? 1
          : -1,
  );
}

export interface SecOptions {
  userAgent: string;
  transport?: typeof fetch;
  now?: () => Date;
  limiter?: RateLimiter;
}

export class SecAdapter {
  readonly market = 'US' as const;
  private transport: typeof fetch;
  private now: () => Date;
  private limiter: RateLimiter;
  private userAgent: string;
  private tickers: SingleFlightCache<Map<string, TickerEntry>>;
  private results: SingleFlightCache<FundamentalsResult>;
  constructor(options: SecOptions) {
    if (!validSecUserAgent(options.userAgent)) throw new Error('Invalid SEC configuration');
    this.userAgent = options.userAgent;
    this.transport = options.transport ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.limiter = options.limiter ?? new RateLimiter(secLimits.minimumIntervalMs);
    const clock = () => this.now().getTime();
    this.tickers = new SingleFlightCache(new TtlCache(secLimits.tickersTtlMs, 1, clock));
    this.results = new SingleFlightCache(new TtlCache(secLimits.statementsTtlMs, 100, clock));
  }

  private async getJson(url: string, maxBytes: number) {
    await this.limiter.wait();
    return fetchJson(this.transport, url, {
      headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
      timeoutMs: secLimits.timeoutMs,
      maxBytes,
    });
  }

  async tickerMap() {
    return this.tickers.get('tickers', async () =>
      parseTickers(await this.getJson(tickersUrl, secLimits.tickersBytes)),
    );
  }

  async statements(symbol: string): Promise<FundamentalsResult> {
    const normalized = normalizeUsSymbol(symbol);
    if (!normalized) throw new RangeError('INVALID_SYMBOL');
    return this.results.get(`us:${normalized}`, async () => {
      const entry = (await this.tickerMap()).get(normalized);
      if (!entry) throw notFound();
      const url = `${factsBase}CIK${String(entry.cik).padStart(10, '0')}.json`;
      const fetchedAt = this.now();
      const json = await this.getJson(url, secLimits.factsBytes);
      if (json.cik !== entry.cik) throw schemaInvalid();
      const warnings: string[] = [];
      const statements = buildSecStatements(json, normalized, url, warnings);
      if (statements.length === 0 && warnings.length === 0) throw notFound();
      return {
        market: 'US' as const,
        symbol: normalized,
        name: entry.title,
        source: 'SEC EDGAR' as const,
        asOf: fetchedAt.toISOString(),
        statements,
        warnings,
      };
    });
  }
}

export function secFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<SecOptions, 'userAgent'> = {},
): SecAdapter | undefined {
  const userAgent = env.SEC_USER_AGENT;
  return validSecUserAgent(userAgent) ? new SecAdapter({ userAgent, ...options }) : undefined;
}
