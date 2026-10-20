import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { FinancialStatement, FiscalPeriod } from '../../lib/valuation.js';
import { ProviderError } from '../toss.js';
import {
  RateLimiter,
  SingleFlightCache,
  TtlCache,
  accessDenied,
  fetchBytes,
  type FundamentalsResult,
  fetchJson,
  kstDate,
  notFound,
  providerUnavailable,
  rateLimited,
  record,
  schemaInvalid,
  text,
} from './shared.js';
import { extractZipEntry, type ZipLimits } from './zip.js';

// Official contract: https://opendart.fss.or.kr/guide (checked 2026-10-21). See docs/implementation/fundamentals.md.
const base = 'https://opendart.fss.or.kr/api/';
const reportCodes: Record<Exclude<FiscalPeriod, 'Q4'>, string> = {
  Q1: '11013',
  Q2: '11012',
  Q3: '11014',
  FY: '11011',
};
const calendarEnd: Record<Exclude<FiscalPeriod, 'Q4'>, string> = {
  Q1: '03-31',
  Q2: '06-30',
  Q3: '09-30',
  FY: '12-31',
};
export const dartLimits = {
  zipBytes: 10 * 1024 * 1024,
  jsonBytes: 4 * 1024 * 1024,
  errorBytes: 64 * 1024,
  zip: {
    maxEntries: 8,
    maxCompressedBytes: 10 * 1024 * 1024,
    maxUncompressedBytes: 80 * 1024 * 1024,
  } satisfies ZipLimits,
  timeoutMs: 15000,
  corpMapTtlMs: 24 * 3600 * 1000,
  statementsTtlMs: 6 * 3600 * 1000,
  minimumIntervalMs: 150,
};
const stockCodePattern = /^[0-9A-Z]{6}$/;

export interface CorpEntry {
  corpCode: string;
  corpName: string;
}

/** DART status code -> app error. Provider message text is never forwarded. */
export function dartStatusError(code: string): ProviderError {
  switch (code) {
    case '010':
    case '011':
    case '012':
    case '901':
      return accessDenied();
    case '020':
      return rateLimited(3600);
    case '800':
    case '900':
      return providerUnavailable();
    case '100':
    case '101':
    case '021':
      return new ProviderError(502, 'PROVIDER_REQUEST_REJECTED', '제공자가 요청을 거부했습니다.');
    default:
      return schemaInvalid();
  }
}

export function parseCorpXml(xml: string): Map<string, CorpEntry> {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw schemaInvalid();
  // Only listed companies are parsed: unlisted ones (about 95%) have an empty stock_code.
  const blocks: string[] = [];
  let total = 0;
  let position = 0;
  while (true) {
    const start = xml.indexOf('<list>', position);
    if (start < 0) break;
    const end = xml.indexOf('</list>', start);
    if (end < 0) throw schemaInvalid();
    position = end + 7;
    if (++total > 500000) throw schemaInvalid();
    const block = xml.slice(start, position);
    if (/<stock_code>\s*[0-9A-Za-z]{6}\s*<\/stock_code>/.test(block)) blocks.push(block);
  }
  if (total === 0 || blocks.length === 0) throw schemaInvalid();
  const document = `<result>${blocks.join('')}</result>`;
  if (XMLValidator.validate(document) !== true) throw schemaInvalid();
  const parsed = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: true,
    isArray: (name) => name === 'list',
  }).parse(document);
  const items = parsed?.result?.list;
  if (!Array.isArray(items)) throw schemaInvalid();
  const entries = new Map<string, CorpEntry & { modified: string }>();
  for (const item of items) {
    const row = record(item);
    const corpCode = text(row.corp_code, 20);
    const stockCode = text(row.stock_code, 20).toUpperCase();
    const name = typeof row.corp_name === 'string' ? row.corp_name.slice(0, 200) : '';
    const modified = typeof row.modify_date === 'string' ? row.modify_date : '';
    if (!/^\d{8}$/.test(corpCode) || !stockCodePattern.test(stockCode)) throw schemaInvalid();
    const previous = entries.get(stockCode);
    if (!previous || modified > previous.modified)
      entries.set(stockCode, { corpCode, corpName: name, modified });
  }
  return new Map(
    [...entries].map(([code, { corpCode, corpName }]) => [code, { corpCode, corpName }]),
  );
}

export interface Row {
  sjDiv: string;
  accountId: string;
  accountName: string;
  amount: string;
  addAmount: string;
  rceptNo: string;
  currency: string;
}
type FlowField = 'revenue' | 'operatingIncome' | 'netIncome';
type BalanceField = 'totalAssets' | 'totalLiabilities' | 'totalEquity';
const flowFields: FlowField[] = ['revenue', 'operatingIncome', 'netIncome'];
const balanceFields: BalanceField[] = ['totalAssets', 'totalLiabilities', 'totalEquity'];

function parseRows(list: unknown): Row[] {
  if (!Array.isArray(list) || list.length > 3000) throw schemaInvalid();
  const optional = (value: unknown) =>
    value === undefined || value === null ? '' : text(value, 100);
  return list.map((item) => {
    const row = record(item);
    const rceptNo = text(row.rcept_no, 14);
    if (!/^\d{14}$/.test(rceptNo)) throw schemaInvalid();
    return {
      sjDiv: text(row.sj_div, 10),
      accountId: text(row.account_id, 200),
      accountName: text(row.account_nm, 200),
      amount: optional(row.thstrm_amount),
      addAmount: optional(row.thstrm_add_amount),
      rceptNo,
      currency: optional(row.currency),
    };
  });
}

/** Integer amount with optional thousands separators. Empty, "-" or anything else -> null. */
export function parseAmount(value: string): bigint | null {
  const cleaned = value.trim();
  if (/^-?\d+$/.test(cleaned)) return BigInt(cleaned);
  if (/^-?\d{1,3}(,\d{3})+$/.test(cleaned)) return BigInt(cleaned.replaceAll(',', ''));
  return null;
}

// Account mapping. Standard IDs first; names only for rows whose ID is not a standard one.
const standardId = /^(ifrs-full|dart)_/;
function findRow(
  rows: Row[],
  divisions: string[],
  ids: string[],
  names: string[] = [],
): Row | undefined {
  for (const division of divisions)
    for (const id of ids) {
      const hit = rows.find((row) => row.sjDiv === division && row.accountId === id);
      if (hit) return hit;
    }
  for (const division of divisions) {
    const hit = rows.find(
      (row) =>
        row.sjDiv === division &&
        !standardId.test(row.accountId) &&
        names.includes(row.accountName),
    );
    if (hit) return hit;
  }
  return undefined;
}

interface Extracted {
  rceptNo: string;
  currency: string;
  flows: Record<FlowField, { current: bigint | null; cumulative: bigint | null }>;
  balances: Record<BalanceField, bigint | null>;
}

export function extractStatement(rows: Row[], warnings: string[]): Extracted | null {
  if (rows.length === 0) return null;
  const currency = rows.find((row) => /^[A-Z]{3}$/.test(row.currency))?.currency;
  if (!currency) return null;
  const incomeDivisions = ['IS', 'CIS'];
  const hasIncomeNci = rows.some(
    (row) => row.accountId === 'ifrs-full_ProfitLossAttributableToNoncontrollingInterests',
  );
  const hasEquityNci = rows.some((row) => row.accountId === 'ifrs-full_NoncontrollingInterests');
  const flowRows: Record<FlowField, Row | undefined> = {
    revenue: findRow(
      rows,
      incomeDivisions,
      ['ifrs-full_Revenue'],
      ['매출액', '수익(매출액)', '영업수익', '매출'],
    ),
    operatingIncome: findRow(
      rows,
      incomeDivisions,
      ['dart_OperatingIncomeLoss'],
      ['영업이익', '영업이익(손실)', '영업손익'],
    ),
    netIncome:
      findRow(rows, incomeDivisions, ['ifrs-full_ProfitLossAttributableToOwnersOfParent']) ??
      (hasIncomeNci
        ? undefined
        : findRow(
            rows,
            incomeDivisions,
            ['ifrs-full_ProfitLoss'],
            [
              '당기순이익',
              '당기순이익(손실)',
              '분기순이익',
              '분기순이익(손실)',
              '반기순이익',
              '반기순이익(손실)',
            ],
          )),
  };
  const balanceRows: Record<BalanceField, Row | undefined> = {
    totalAssets: findRow(rows, ['BS'], ['ifrs-full_Assets'], ['자산총계']),
    totalLiabilities: findRow(rows, ['BS'], ['ifrs-full_Liabilities'], ['부채총계']),
    totalEquity:
      findRow(rows, ['BS'], ['ifrs-full_EquityAttributableToOwnersOfParent']) ??
      (hasEquityNci ? undefined : findRow(rows, ['BS'], ['ifrs-full_Equity'], ['자본총계'])),
  };
  const read = (row: Row | undefined, field: 'amount' | 'addAmount') => {
    if (!row) return null;
    const value = parseAmount(row[field]);
    if (value === null && row[field].trim() !== '' && row[field].trim() !== '-')
      warnings.push(`${row.accountName}: 금액 형식을 확인하지 못해 제외했습니다.`);
    return value;
  };
  const flows = Object.fromEntries(
    flowFields.map((field) => [
      field,
      { current: read(flowRows[field], 'amount'), cumulative: read(flowRows[field], 'addAmount') },
    ]),
  ) as Extracted['flows'];
  const balances = Object.fromEntries(
    balanceFields.map((field) => [field, read(balanceRows[field], 'amount')]),
  ) as Extracted['balances'];
  return { rceptNo: rows[0].rceptNo, currency, flows, balances };
}

interface SharesInfo {
  shares: bigint | null;
  settlementDate: string | null;
}

export function extractShares(list: unknown): SharesInfo {
  if (!Array.isArray(list) || list.length > 100) throw schemaInvalid();
  const rows = list.map((item) => {
    const row = record(item);
    return {
      se: text(row.se, 100).trim(),
      distributed:
        row.distb_stock_co === undefined || row.distb_stock_co === null
          ? ''
          : text(row.distb_stock_co, 40),
      settlement: row.stlm_dt === undefined || row.stlm_dt === null ? '' : text(row.stlm_dt, 20),
    };
  });
  const candidates = rows.filter((row) => row.se !== '비고');
  const total =
    candidates.find((row) => row.se === '합계') ??
    (candidates.length === 1 ? candidates[0] : undefined);
  const settlement = rows
    .map((row) => row.settlement)
    .find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
  const shares = total ? parseAmount(total.distributed) : null;
  return {
    shares: shares !== null && shares > 0n ? shares : null,
    settlementDate: settlement && !Number.isNaN(Date.parse(settlement)) ? settlement : null,
  };
}

interface Period {
  extracted: Extracted | null;
  shares: SharesInfo;
}

const numberString = (value: bigint | null) => (value === null ? null : value.toString());

export interface DartOptions {
  apiKey: string;
  transport?: typeof fetch;
  now?: () => Date;
  limiter?: RateLimiter;
  /** Fiscal years fetched: current year and this many before. Default 2 (three years). */
  yearsBack?: number;
}

export class DartAdapter {
  readonly market = 'KR' as const;
  private transport: typeof fetch;
  private now: () => Date;
  private limiter: RateLimiter;
  private yearsBack: number;
  private apiKey: string;
  private cooldownUntil = 0;
  private corpMaps: SingleFlightCache<Map<string, CorpEntry>>;
  private results: SingleFlightCache<FundamentalsResult>;
  constructor(options: DartOptions) {
    if (!/^[0-9A-Za-z]{40}$/.test(options.apiKey)) throw new Error('Invalid DART configuration');
    this.apiKey = options.apiKey;
    this.transport = options.transport ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.limiter = options.limiter ?? new RateLimiter(dartLimits.minimumIntervalMs);
    this.yearsBack = options.yearsBack ?? 2;
    const clock = () => this.now().getTime();
    this.corpMaps = new SingleFlightCache(new TtlCache(dartLimits.corpMapTtlMs, 1, clock));
    this.results = new SingleFlightCache(new TtlCache(dartLimits.statementsTtlMs, 100, clock));
  }

  private url(endpoint: string, params: Record<string, string>) {
    const url = new URL(endpoint, base);
    url.searchParams.set('crtfc_key', this.apiKey);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }
  private async guard() {
    if (this.cooldownUntil > Date.now())
      throw rateLimited(Math.ceil((this.cooldownUntil - Date.now()) / 1000));
    await this.limiter.wait();
  }
  private fail(error: unknown): never {
    if (error instanceof ProviderError && error.code === 'PROVIDER_RATE_LIMITED')
      this.cooldownUntil = Date.now() + (error.retryAfter ?? 60) * 1000;
    throw error;
  }

  async corpMap(): Promise<Map<string, CorpEntry>> {
    return this.corpMaps.get('corp', async () => {
      try {
        await this.guard();
        const bytes = await fetchBytes(this.transport, this.url('corpCode.xml', {}), {
          headers: { Accept: '*/*' },
          timeoutMs: dartLimits.timeoutMs,
          maxBytes: dartLimits.zipBytes,
        });
        if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
          let xml: Buffer;
          try {
            xml = await extractZipEntry(bytes, 'CORPCODE.xml', dartLimits.zip);
          } catch {
            throw schemaInvalid();
          }
          return parseCorpXml(xml.toString('utf8'));
        }
        // Not a ZIP: DART answers errors (bad key, IP, limit) with a small status document.
        if (bytes.length > dartLimits.errorBytes) throw schemaInvalid();
        const body = bytes.toString('utf8');
        if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(body) || XMLValidator.validate(body) !== true)
          throw schemaInvalid();
        const status = new XMLParser({ parseTagValue: false, ignoreAttributes: true }).parse(body)
          ?.result?.status;
        throw typeof status === 'string' ? dartStatusError(status.trim()) : schemaInvalid();
      } catch (error) {
        this.fail(error);
      }
    });
  }

  async corpForSymbol(symbol: string): Promise<CorpEntry> {
    const entry = (await this.corpMap()).get(symbol);
    if (!entry) throw notFound();
    return entry;
  }

  private async getJson(endpoint: string, params: Record<string, string>) {
    try {
      await this.guard();
      return await fetchJson(this.transport, this.url(endpoint, params), {
        headers: { Accept: 'application/json' },
        timeoutMs: dartLimits.timeoutMs,
        maxBytes: dartLimits.jsonBytes,
      });
    } catch (error) {
      this.fail(error);
    }
  }

  /** Returns null for status 013 (no data), the list otherwise. */
  private async listOrNull(endpoint: string, params: Record<string, string>) {
    const json = await this.getJson(endpoint, params);
    const status = text(json.status, 10);
    if (status === '013') return null;
    if (status !== '000') this.fail(dartStatusError(status));
    return json;
  }

  private async filingDates(corpCode: string, firstYear: number, today: string) {
    const dates = new Map<string, string>();
    for (let page = 1; page <= 5; page++) {
      const json = await this.listOrNull('list.json', {
        corp_code: corpCode,
        bgn_de: `${firstYear}0101`,
        end_de: today.replaceAll('-', ''),
        pblntf_ty: 'A',
        last_reprt_at: 'N',
        sort: 'date',
        sort_mth: 'asc',
        page_no: String(page),
        page_count: '100',
      });
      if (!json) break;
      if (!Array.isArray(json.list) || json.list.length > 100) throw schemaInvalid();
      for (const item of json.list) {
        const row = record(item);
        const receipt = text(row.rcept_no, 14);
        const received = text(row.rcept_dt, 8);
        if (!/^\d{14}$/.test(receipt) || !/^\d{8}$/.test(received)) throw schemaInvalid();
        dates.set(receipt, `${received.slice(0, 4)}-${received.slice(4, 6)}-${received.slice(6)}`);
      }
      const totalPage = typeof json.total_page === 'number' ? json.total_page : 1;
      if (page >= totalPage) break;
    }
    return dates;
  }

  private async period(
    corpCode: string,
    year: number,
    code: string,
    scope: 'CFS' | 'OFS',
    warnings: string[],
  ): Promise<Period> {
    const common = { corp_code: corpCode, bsns_year: String(year), reprt_code: code };
    const [statementJson, sharesJson] = await Promise.all([
      this.listOrNull('fnlttSinglAcntAll.json', { ...common, fs_div: scope }),
      this.listOrNull('stockTotqySttus.json', common),
    ]);
    return {
      extracted: statementJson ? extractStatement(parseRows(statementJson.list), warnings) : null,
      shares: sharesJson ? extractShares(sharesJson.list) : { shares: null, settlementDate: null },
    };
  }

  async statements(symbol: string): Promise<FundamentalsResult> {
    if (!stockCodePattern.test(symbol)) throw new RangeError('INVALID_SYMBOL');
    return this.results.get(`kr:${symbol}`, () => this.load(symbol));
  }

  private async load(symbol: string): Promise<FundamentalsResult> {
    const corp = await this.corpForSymbol(symbol);
    const fetchedAt = this.now();
    const today = kstDate(fetchedAt);
    const lastYear = Number(today.slice(0, 4));
    const years = Array.from(
      { length: this.yearsBack + 1 },
      (_, i) => lastYear - this.yearsBack + i,
    );
    const warnings: string[] = [];
    const periodKeys = years.flatMap((year) =>
      (['Q1', 'Q2', 'Q3', 'FY'] as const).map((period) => ({ year, period })),
    );
    const collect = (scope: 'CFS' | 'OFS') =>
      Promise.all(
        periodKeys.map(async (key) => ({
          ...key,
          data: await this.period(
            corp.corpCode,
            key.year,
            reportCodes[key.period],
            scope,
            warnings,
          ),
        })),
      );
    let scope: 'CFS' | 'OFS' = 'CFS';
    const [dates, firstPass] = await Promise.all([
      this.filingDates(corp.corpCode, years[0], today),
      collect('CFS'),
    ]);
    let collected = firstPass;
    // Consolidated statements are preferred. Use separate ones only when no period has any.
    if (collected.every((item) => item.data.extracted === null)) {
      scope = 'OFS';
      collected = await collect('OFS');
    }
    const byKey = new Map(collected.map((item) => [`${item.year}:${item.period}`, item.data]));
    const statements: FinancialStatement[] = [];
    const sourceUrl = (receipt: string) =>
      `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${receipt}`;

    for (const year of years) {
      const get = (period: Exclude<FiscalPeriod, 'Q4'>) => byKey.get(`${year}:${period}`);
      const q1 = get('Q1')?.extracted ?? null;
      const h1 = get('Q2')?.extracted ?? null;
      const q3 = get('Q3')?.extracted ?? null;
      const fy = get('FY')?.extracted ?? null;

      // Quarter flows: 3-month amounts. thstrm_amount of 1Q/반기/3Q income statements is the
      // 3-month amount; thstrm_add_amount is the cumulative amount (documented by DART).
      const quarterFlow = (field: FlowField) => {
        const first = q1?.flows[field].current ?? null;
        const cumulativeHalf = h1?.flows[field].cumulative ?? null;
        const cumulativeNine = q3?.flows[field].cumulative ?? null;
        let second = h1?.flows[field].current ?? null;
        let third = q3?.flows[field].current ?? null;
        let derived2 = false;
        let derived3 = false;
        if (second === null && cumulativeHalf !== null && first !== null) {
          second = cumulativeHalf - first;
          derived2 = true;
        }
        if (third === null && cumulativeNine !== null && cumulativeHalf !== null) {
          third = cumulativeNine - cumulativeHalf;
          derived3 = true;
        }
        if (
          second !== null &&
          first !== null &&
          cumulativeHalf !== null &&
          first + second !== cumulativeHalf
        ) {
          warnings.push(
            `${year} 반기 ${field}: 누적 금액과 3개월 합이 달라 2분기 값을 제외했습니다.`,
          );
          second = null;
        }
        if (
          third !== null &&
          cumulativeHalf !== null &&
          cumulativeNine !== null &&
          cumulativeHalf + third !== cumulativeNine
        ) {
          warnings.push(
            `${year} 3분기 ${field}: 누적 금액과 3개월 합이 달라 3분기 값을 제외했습니다.`,
          );
          third = null;
        }
        const annual = fy?.flows[field].current ?? null;
        const fourth = annual !== null && cumulativeNine !== null ? annual - cumulativeNine : null;
        return { first, second, third, fourth, derived2, derived3, annual };
      };
      const flows = Object.fromEntries(
        flowFields.map((field) => [field, quarterFlow(field)]),
      ) as Record<FlowField, ReturnType<typeof quarterFlow>>;

      const emit = (
        period: FiscalPeriod,
        extracted: Extracted | null,
        periodData: Period | undefined,
        values: Record<FlowField, bigint | null>,
        derived: boolean,
        extraFiled: (string | undefined)[],
        balanceSource: Extracted | null = extracted,
        sharesSource: Period | undefined = periodData,
      ) => {
        if (!extracted || !balanceSource) return;
        const filed = dates.get(extracted.rceptNo);
        if (!filed) {
          warnings.push(`${year} ${period}: 공시 접수일을 확인하지 못해 제외했습니다.`);
          return;
        }
        const calendar = `${year}-${calendarEnd[period === 'Q4' ? 'FY' : period]}`;
        const settlement = sharesSource?.shares.settlementDate ?? null;
        const useSettlement =
          settlement !== null &&
          Math.abs(Date.parse(settlement) - Date.parse(calendar)) <= 45 * 86400000;
        const statement: FinancialStatement = {
          market: 'KR',
          symbol,
          periodType: period === 'FY' ? 'annual' : 'quarter',
          fiscalYear: year,
          fiscalPeriod: period,
          periodEnd: useSettlement ? settlement! : calendar,
          periodEndAssumed: !useSettlement,
          filedAt: [filed, ...extraFiled.filter((value): value is string => !!value)]
            .sort()
            .at(-1)!,
          currency: extracted.currency,
          scope: scope === 'CFS' ? 'consolidated' : 'separate',
          derived,
          revenue: numberString(values.revenue),
          operatingIncome: numberString(values.operatingIncome),
          netIncome: numberString(values.netIncome),
          totalAssets: numberString(balanceSource.balances.totalAssets),
          totalLiabilities: numberString(balanceSource.balances.totalLiabilities),
          totalEquity: numberString(balanceSource.balances.totalEquity),
          sharesOutstanding: numberString(sharesSource?.shares.shares ?? null),
          source: 'DART',
          sourceUrl: sourceUrl(extracted.rceptNo),
        };
        const hasValue = [
          statement.revenue,
          statement.operatingIncome,
          statement.netIncome,
          statement.totalAssets,
          statement.totalLiabilities,
          statement.totalEquity,
        ].some((value) => value !== null);
        if (hasValue) statements.push(statement);
      };
      const pick = (which: 'first' | 'second' | 'third' | 'fourth' | 'annual') =>
        Object.fromEntries(flowFields.map((field) => [field, flows[field][which]])) as Record<
          FlowField,
          bigint | null
        >;
      emit('Q1', q1, get('Q1'), pick('first'), false, []);
      emit(
        'Q2',
        h1,
        get('Q2'),
        pick('second'),
        flowFields.some((f) => flows[f].derived2),
        [q1 ? dates.get(q1.rceptNo) : undefined],
      );
      emit(
        'Q3',
        q3,
        get('Q3'),
        pick('third'),
        flowFields.some((f) => flows[f].derived3),
        [h1 ? dates.get(h1.rceptNo) : undefined],
      );
      emit('FY', fy, get('FY'), pick('annual'), false, []);
      // Q4 = annual - nine-month cumulative. Balance sheet and shares are the annual report's.
      const fourth = pick('fourth');
      emit(
        'Q4',
        fy,
        get('FY'),
        fourth,
        true,
        fourth.revenue !== null || fourth.operatingIncome !== null || fourth.netIncome !== null
          ? [q3 ? dates.get(q3.rceptNo) : undefined]
          : [],
      );
    }
    const order = (value: FinancialStatement) =>
      value.fiscalYear * 4 + { Q1: 0, Q2: 1, Q3: 2, Q4: 3, FY: 4 }[value.fiscalPeriod];
    statements.sort((a, b) => order(a) - order(b));
    if (statements.length === 0) throw notFound();
    if (statements.some((s) => s.periodEndAssumed))
      warnings.push('일부 기간의 결산일을 공시 정보에서 확인하지 못해 12월 결산으로 가정했습니다.');
    return {
      market: 'KR',
      symbol,
      name: corp.corpName || null,
      source: 'DART',
      asOf: fetchedAt.toISOString(),
      statements,
      warnings: [...new Set(warnings)],
    };
  }
}

export function dartFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<DartOptions, 'apiKey'> = {},
): DartAdapter | undefined {
  const apiKey = env.DART_API_KEY;
  if (!apiKey || !/^[0-9A-Za-z]{40}$/.test(apiKey)) return undefined;
  return new DartAdapter({ apiKey, ...options });
}
