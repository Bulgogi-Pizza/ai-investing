import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { computePerShareMetrics, statementsKnownAt } from '../src/lib/valuation';
import {
  DartAdapter,
  dartFromEnvironment,
  dartLimits,
  dartStatusError,
  parseCorpXml,
} from '../src/server/fundamentals/dart';
import { RateLimiter } from '../src/server/fundamentals/shared';
import { extractZipEntry } from '../src/server/fundamentals/zip';
import { buildZip } from './fixtures/fundamentals/build-zip';
import {
  filingList,
  noData,
  reportCodes,
  sharesResponse,
  statementResponse,
  synthetic,
  type ReportInput,
} from './fixtures/fundamentals/dart';

const KEY = 'A1b2C3d4E5f6A1b2C3d4E5f6A1b2C3d4E5f6A1b2';
const now = () => new Date('2026-10-21T00:00:00Z');
const corpXml = readFileSync(
  new URL('./fixtures/fundamentals/corpcode.xml', import.meta.url),
  'utf8',
);
const corpZip = () => buildZip([{ name: 'CORPCODE.xml', data: Buffer.from(corpXml, 'utf8') }]);
const limits = {
  maxEntries: 4,
  maxCompressedBytes: 1024 * 1024,
  maxUncompressedBytes: 1024 * 1024,
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
interface Scenario {
  reports?: Map<string, ReportInput>;
  zip?: Buffer | (() => Response);
  /** fs_div values that have data. Default: CFS only. */
  scopes?: string[];
  listed?: Iterable<ReportInput>;
  statusFor?: (path: string) => string | undefined;
}
function transport(scenario: Scenario = {}) {
  const reports = scenario.reports ?? synthetic;
  const scopes = scenario.scopes ?? ['CFS'];
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const forced = scenario.statusFor?.(url.pathname);
    if (forced) return json({ status: forced, message: 'raw provider text' });
    if (url.pathname === '/api/corpCode.xml') {
      const zip = scenario.zip ?? corpZip();
      return typeof zip === 'function' ? zip() : new Response(new Uint8Array(zip));
    }
    const year = url.searchParams.get('bsns_year');
    const code = url.searchParams.get('reprt_code');
    const key = Object.entries(reportCodes).find(([, value]) => value === code)?.[0];
    const report = reports.get(`${year}:${key === 'H1' ? 'H1' : key}`);
    if (url.pathname === '/api/list.json')
      return json(filingList(scenario.listed ?? reports.values()));
    if (!report) return json(noData);
    if (url.pathname === '/api/fnlttSinglAcntAll.json')
      return json(
        scopes.includes(url.searchParams.get('fs_div') ?? '')
          ? statementResponse(report, { nci: report.netIncome !== undefined })
          : noData,
      );
    if (url.pathname === '/api/stockTotqySttus.json')
      return json(sharesResponse(1_000_000, report.settlement ?? '2025-12-31'));
    return json(noData);
  }) as unknown as ReturnType<typeof vi.fn> & typeof fetch;
}
function adapter(
  t: typeof fetch,
  extra: Partial<ConstructorParameters<typeof DartAdapter>[0]> = {},
) {
  return new DartAdapter({
    apiKey: KEY,
    transport: t,
    now,
    limiter: new RateLimiter(0),
    ...extra,
  });
}

describe('DART corpCode ZIP', () => {
  it('압축·무압축 항목에서 CORPCODE.xml을 꺼내 상장사만 남긴다', async () => {
    for (const method of [8, 0] as const) {
      const zip = buildZip([
        { name: 'other.txt', data: Buffer.from('x') },
        { name: 'corpcode.XML', data: Buffer.from(corpXml, 'utf8'), method },
      ]);
      const xml = await extractZipEntry(zip, 'CORPCODE.xml', limits);
      const map = parseCorpXml(xml.toString('utf8'));
      expect([...map.keys()].sort()).toEqual(['000001', '000003']);
      expect(map.get('000001')).toEqual({ corpCode: '00000001', corpName: '합성전자' });
      // two entries share a stock code: the newest modify_date wins
      expect(map.get('000003')?.corpCode).toBe('00000003');
    }
  });
  it('크기 한도·변조된 헤더·손상된 ZIP을 거부한다', async () => {
    const data = Buffer.from(corpXml, 'utf8');
    const bad: [string, Buffer, Partial<typeof limits>?][] = [
      ['not a zip', Buffer.from('<html>error</html>' + ' '.repeat(40))],
      ['truncated', corpZip().subarray(0, corpZip().length - 10)],
      ['empty', Buffer.alloc(0)],
      ['entry missing', buildZip([{ name: 'a.xml', data }])],
      [
        'duplicate',
        buildZip([
          { name: 'CORPCODE.xml', data },
          { name: 'corpcode.xml', data },
        ]),
      ],
      ['encrypted', buildZip([{ name: 'CORPCODE.xml', data, flags: 1 }])],
      ['crc', buildZip([{ name: 'CORPCODE.xml', data, crc: 123 }])],
      ['entry count', buildZip([{ name: 'CORPCODE.xml', data }], { entryCountOverride: 9 })],
      [
        'too many entries',
        buildZip([
          { name: 'a', data },
          { name: 'b', data },
          { name: 'CORPCODE.xml', data },
        ]),
        { maxEntries: 2 },
      ],
      ['compressed limit', corpZip(), { maxCompressedBytes: 10 }],
      ['declared uncompressed limit', corpZip(), { maxUncompressedBytes: 100 }],
    ];
    for (const [name, zip, override] of bad)
      await expect(
        extractZipEntry(zip, 'CORPCODE.xml', { ...limits, ...override }),
        name,
      ).rejects.toThrow(/^ZIP_/);
  });
  it('선언 크기를 속인 압축 폭탄은 실제 해제 한도에서 멈춘다', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const bomb = buildZip([{ name: 'CORPCODE.xml', data: big, declaredUncompressed: 1000 }]);
    await expect(
      extractZipEntry(bomb, 'CORPCODE.xml', { ...limits, maxUncompressedBytes: 1024 * 1024 }),
    ).rejects.toThrow('ZIP_INFLATE');
    // sanity: the same payload is legal when the limit allows it
    expect(deflateRawSync(big).length).toBeLessThan(limits.maxCompressedBytes);
    const honest = buildZip([{ name: 'CORPCODE.xml', data: big }]);
    await expect(
      extractZipEntry(honest, 'CORPCODE.xml', { ...limits, maxUncompressedBytes: 1024 * 1024 }),
    ).rejects.toThrow('ZIP_UNCOMPRESSED_TOO_LARGE');
  });
  it('DOCTYPE·ENTITY·빈 XML은 거부한다', () => {
    for (const xml of [
      '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><result><list><corp_code>00000001</corp_code><stock_code>000001</stock_code></list></result>',
      '<result></result>',
      '<result><list><corp_code>00000001</corp_code><stock_code>000001</stock_code></result>',
    ])
      expect(() => parseCorpXml(xml)).toThrow();
  });
});

describe('DART 어댑터', () => {
  it('고정 호스트·redirect 금지·키는 쿼리에만 있고 고유번호를 24시간 캐시한다', async () => {
    const t = transport();
    const dart = adapter(t);
    await dart.statements('000001');
    const urls = t.mock.calls.map((call) => new URL(String(call[0])));
    expect(urls.every((url) => url.origin === 'https://opendart.fss.or.kr')).toBe(true);
    expect(urls.every((url) => url.searchParams.get('crtfc_key') === KEY)).toBe(true);
    expect(
      t.mock.calls.every(
        (call) =>
          (call[1] as RequestInit).redirect === 'error' &&
          (call[1] as RequestInit).signal instanceof AbortSignal,
      ),
    ).toBe(true);
    expect(urls.filter((url) => url.pathname === '/api/corpCode.xml')).toHaveLength(1);
    // 3 years x 4 reports x (statement + shares) + list + corpCode
    expect(t.mock.calls).toHaveLength(3 * 4 * 2 + 2);
  });
  it('같은 종목의 동시 요청은 한 번만 가져오고 6시간 동안 재사용한다', async () => {
    const t = transport();
    const dart = adapter(t);
    const [a, b] = await Promise.all([dart.statements('000001'), dart.statements('000001')]);
    expect(a).toBe(b);
    const count = t.mock.calls.length;
    await dart.statements('000001');
    expect(t.mock.calls.length).toBe(count);
  });
  it('분기·반기·3분기는 3개월 값, 4분기는 연간-9개월 누적으로 만든다', async () => {
    const result = await adapter(transport()).statements('000001');
    expect(result.name).toBe('합성전자');
    expect(result.source).toBe('DART');
    expect(result.statements).toHaveLength(12);
    const pick = (year: number, period: string) =>
      result.statements.find((s) => s.fiscalYear === year && s.fiscalPeriod === period)!;
    const q2 = pick(2025, 'Q2');
    expect(q2.revenue).toBe('110000000');
    expect(q2.operatingIncome).toBe('22000000');
    expect(q2.netIncome).toBe('11000000'); // owners of parent, not the 13 total
    expect(q2.periodType).toBe('quarter');
    expect(q2.filedAt).toBe('2025-08-14');
    expect(q2.periodEnd).toBe('2025-06-30');
    expect(q2.periodEndAssumed).toBe(false);
    expect(q2.totalEquity).toBe('240000000'); // owners of parent equity
    expect(q2.sharesOutstanding).toBe('1000000');
    expect(q2.scope).toBe('consolidated');
    const q4 = pick(2025, 'Q4');
    expect(q4.derived).toBe(true);
    expect(q4.revenue).toBe('130000000'); // 460 - 330
    expect(q4.operatingIncome).toBe('29000000'); // 95 - 66
    expect(q4.netIncome).toBe('17000000'); // 50 - 33
    expect(q4.filedAt).toBe('2026-03-16');
    expect(q4.totalAssets).toBe('580000000');
    const fy = pick(2025, 'FY');
    expect(fy.periodType).toBe('annual');
    expect(fy.revenue).toBe('460000000');
    expect(fy.sourceUrl).toBe('https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260316000001');
    expect(pick(2024, 'Q4').netIncome).toBe('14000000');
    // 2026 3Q and annual report are not published yet: no statements, not an error
    expect(result.statements.some((s) => s.fiscalYear === 2026 && s.fiscalPeriod === 'Q3')).toBe(
      false,
    );
  });
  it('누적만 있는 분기는 누적 차이로 구하고 합이 맞지 않는 분기는 제외한다', async () => {
    const reports = new Map(synthetic);
    reports.set('2025:H1', {
      ...reports.get('2025:H1')!,
      revenue: { current: null, cumulative: 210 },
    });
    reports.set('2025:Q3', {
      ...reports.get('2025:Q3')!,
      operatingIncome: { current: 24, cumulative: 70 }, // 42 + 24 != 70
    });
    const result = await adapter(transport({ reports })).statements('000001');
    const pick = (period: string) =>
      result.statements.find((s) => s.fiscalYear === 2025 && s.fiscalPeriod === period)!;
    expect(pick('Q2').revenue).toBe('110000000'); // 210 - 100
    expect(pick('Q2').derived).toBe(true);
    expect(pick('Q3').operatingIncome).toBeNull();
    expect(pick('Q3').revenue).toBe('120000000');
    expect(result.warnings.join('\n')).toContain('3분기');
  });
  it('공시 접수일을 알 수 없는 보고서는 제외하고 경고한다', async () => {
    const listed = [...synthetic.values()].filter((report) => report.receipt !== '20260316000001');
    const result = await adapter(transport({ listed })).statements('000001');
    expect(result.statements.some((s) => s.fiscalYear === 2025 && s.fiscalPeriod === 'FY')).toBe(
      false,
    );
    expect(result.warnings.join('\n')).toContain('접수일');
  });
  it('연결 재무제표가 전혀 없으면 별도 재무제표를 쓴다', async () => {
    const result = await adapter(transport({ scopes: ['OFS'] })).statements('000001');
    expect(result.statements.length).toBeGreaterThan(0);
    expect(new Set(result.statements.map((s) => s.scope))).toEqual(new Set(['separate']));
  });
  it('시점 필터: 접수일 이후의 공시는 알려진 값에서 빠진다', async () => {
    const { statements } = await adapter(transport()).statements('000001');
    const known = statementsKnownAt(statements, '2026-03-15');
    expect(known.some((s) => s.fiscalYear === 2025 && s.fiscalPeriod === 'FY')).toBe(false);
    expect(known.some((s) => s.fiscalYear === 2025 && s.fiscalPeriod === 'Q4')).toBe(false);
    expect(known.some((s) => s.fiscalYear === 2025 && s.fiscalPeriod === 'Q3')).toBe(true);
    const metrics = computePerShareMetrics(known);
    expect(metrics.ttm?.netIncome).toBe(47_000_000); // Q4'24 14 + Q1 10 + Q2 11 + Q3 12
    expect(metrics.eps.value).toBeCloseTo(47);
    expect(metrics.asOf).toBe('2025-11-14');
    const after = computePerShareMetrics(statementsKnownAt(statements, '2026-03-16'));
    expect(after.ttm?.basis).toBe('annual');
    expect(after.ttm?.netIncome).toBe(50_000_000);
  });
  it('종목 코드를 찾지 못하면 404, 잘못된 코드는 요청 전에 거부한다', async () => {
    const t = transport();
    const dart = adapter(t);
    await expect(dart.statements('999999')).rejects.toMatchObject({
      status: 404,
      code: 'FUNDAMENTALS_NOT_FOUND',
    });
    await expect(dart.statements('abc')).rejects.toThrow(RangeError);
  });
  it('모든 보고서가 013이면 데이터 없음(404)이다', async () => {
    const dart = adapter(transport({ reports: new Map() }));
    await expect(dart.statements('000001')).rejects.toMatchObject({ status: 404 });
  });
});

describe('DART 상태 코드와 비밀 보호', () => {
  it('문서화된 상태 코드를 앱 오류로 바꾸고 제공자 메시지는 전달하지 않는다', () => {
    const expected: Record<string, [number, string]> = {
      '010': [503, 'PROVIDER_ACCESS_DENIED'],
      '011': [503, 'PROVIDER_ACCESS_DENIED'],
      '012': [503, 'PROVIDER_ACCESS_DENIED'],
      '901': [503, 'PROVIDER_ACCESS_DENIED'],
      '020': [503, 'PROVIDER_RATE_LIMITED'],
      '800': [503, 'PROVIDER_UNAVAILABLE'],
      '900': [503, 'PROVIDER_UNAVAILABLE'],
      '100': [502, 'PROVIDER_REQUEST_REJECTED'],
      '101': [502, 'PROVIDER_REQUEST_REJECTED'],
      '021': [502, 'PROVIDER_REQUEST_REJECTED'],
      '777': [502, 'PROVIDER_SCHEMA_INVALID'],
    };
    for (const [code, [status, error]] of Object.entries(expected)) {
      const result = dartStatusError(code);
      expect([result.status, result.code]).toEqual([status, error]);
      expect(result.message).not.toContain('raw provider text');
    }
  });
  it('020은 호출 대기 시간을 두고 이후 요청을 제공자로 보내지 않는다', async () => {
    const limited = transport({
      statusFor: (path) => (path === '/api/list.json' ? '020' : undefined),
    });
    const other = adapter(limited);
    await expect(other.statements('000001')).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
    });
    const calls = limited.mock.calls.length;
    await expect(other.statements('000001')).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
    });
    expect(limited.mock.calls.length).toBe(calls);
  });
  it('corpCode가 ZIP 대신 상태 문서를 주면 상태 코드를 따른다', async () => {
    const status = (code: string) =>
      transport({
        zip: () =>
          new Response(
            `<result><status>${code}</status><message>raw provider text</message></result>`,
          ),
      });
    await expect(adapter(status('010')).statements('000001')).rejects.toMatchObject({
      code: 'PROVIDER_ACCESS_DENIED',
    });
    await expect(adapter(status('000')).statements('000001')).rejects.toMatchObject({
      code: 'PROVIDER_SCHEMA_INVALID',
    });
  });
  it('과대 ZIP·과대 JSON·잘못된 형식은 스키마/크기 오류로 처리한다', async () => {
    const huge = transport({
      zip: () => new Response(new Uint8Array(dartLimits.zipBytes + 1)),
    });
    await expect(adapter(huge).statements('000001')).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE_TOO_LARGE',
    });
    const bad = transport({ zip: () => new Response('PK\u0003\u0004 not really a zip') });
    await expect(adapter(bad).statements('000001')).rejects.toMatchObject({
      code: 'PROVIDER_SCHEMA_INVALID',
    });
    const broken = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/corpCode.xml') return new Response(new Uint8Array(corpZip()));
      return json({ status: '000', list: [{ account_id: 5 }] });
    }) as unknown as typeof fetch;
    await expect(adapter(broken).statements('000001')).rejects.toMatchObject({
      code: 'PROVIDER_SCHEMA_INVALID',
    });
    const html = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/corpCode.xml') return new Response(new Uint8Array(corpZip()));
      return new Response('<html>not json</html>');
    }) as unknown as typeof fetch;
    await expect(adapter(html).statements('000001')).rejects.toMatchObject({
      code: 'PROVIDER_SCHEMA_INVALID',
    });
  });
  it('통신 오류·HTTP 오류에서 키와 URL이 오류에 남지 않는다', async () => {
    const leaking = vi.fn(async (input: string | URL | Request) => {
      throw new Error(`connect failed for ${String(input)} key=${KEY}`);
    }) as unknown as typeof fetch;
    const error = await adapter(leaking)
      .statements('000001')
      .catch((caught) => caught);
    expect(error.code).toBe('PROVIDER_UNREACHABLE');
    expect(
      JSON.stringify({ code: error.code, message: error.message, stack: error.stack }),
    ).not.toContain(KEY);
    for (const status of [401, 403, 404, 429, 500]) {
      const failing = vi.fn(
        async () => new Response(`raw ${KEY}`, { status }),
      ) as unknown as typeof fetch;
      const caught = await adapter(failing)
        .statements('000001')
        .catch((value) => value);
      expect(caught.status).toBeGreaterThanOrEqual(400);
      expect(`${caught.message}${caught.code}`).not.toContain(KEY);
    }
  });
  it('키 형식이 틀리면 환경 팩토리는 비활성(undefined)이고 생성자는 거부한다', () => {
    expect(dartFromEnvironment({})).toBeUndefined();
    expect(dartFromEnvironment({ DART_API_KEY: 'short' })).toBeUndefined();
    expect(dartFromEnvironment({ DART_API_KEY: KEY })).toBeInstanceOf(DartAdapter);
    expect(() => new DartAdapter({ apiKey: 'x' })).toThrow();
  });
});
