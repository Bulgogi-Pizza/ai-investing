import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { computePerShareMetrics, statementsKnownAt } from '../src/lib/valuation';
import {
  SecAdapter,
  buildSecStatements,
  normalizeUsSymbol,
  parseTickers,
  secFromEnvironment,
  secLimits,
  validSecUserAgent,
} from '../src/server/fundamentals/sec';
import { RateLimiter } from '../src/server/fundamentals/shared';
import { companyFacts, entry, unit } from './fixtures/fundamentals/sec';

const AGENT = 'Synthetic Test Project test-contact@example.invalid';
const now = () => new Date('2026-10-21T00:00:00Z');
const tickers = JSON.parse(
  readFileSync(new URL('./fixtures/fundamentals/company-tickers.json', import.meta.url), 'utf8'),
);
const FACTS_URL = 'https://data.sec.gov/api/xbrl/companyfacts/CIK0001234567.json';

function transport(
  facts: unknown = companyFacts(),
  options: { factsStatus?: number; tickersBody?: unknown } = {},
) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://www.sec.gov/files/company_tickers.json')
      return new Response(JSON.stringify(options.tickersBody ?? tickers));
    if (url.startsWith('https://data.sec.gov/api/xbrl/companyfacts/')) {
      if (options.factsStatus) return new Response('nope', { status: options.factsStatus });
      return new Response(JSON.stringify(facts));
    }
    return new Response('unexpected', { status: 500 });
  }) as unknown as ReturnType<typeof vi.fn> & typeof fetch;
}
const adapter = (t: typeof fetch) =>
  new SecAdapter({ userAgent: AGENT, transport: t, now, limiter: new RateLimiter(0) });
const build = (facts: unknown = companyFacts()) => {
  const warnings: string[] = [];
  const statements = buildSecStatements(
    facts as Record<string, unknown>,
    'SYNT',
    FACTS_URL,
    warnings,
  );
  return {
    statements,
    warnings,
    get: (year: number, period: string) =>
      statements.find((s) => s.fiscalYear === year && s.fiscalPeriod === period),
  };
};

describe('SEC 사실 선택과 분기 도출', () => {
  it('연간·분기 기간을 start/end 기간 길이로 정하고 fy/fp 필드에 의존하지 않는다', () => {
    const { statements, get } = build();
    expect(statements.map((s) => `${s.fiscalYear}${s.fiscalPeriod}`)).toEqual([
      '2024Q1',
      '2024Q2',
      '2024Q3',
      '2024Q4',
      '2024FY',
      '2025Q1',
      '2025Q2',
      '2025Q3',
      '2025Q4',
      '2025FY',
      '2026Q1',
    ]);
    expect(get(2025, 'Q1')).toMatchObject({
      periodEnd: '2025-03-31',
      periodType: 'quarter',
      market: 'US',
      currency: 'USD',
      source: 'SEC EDGAR',
      sourceUrl: FACTS_URL,
      periodEndAssumed: false,
    });
    expect(get(2025, 'FY')).toMatchObject({ periodType: 'annual', periodEnd: '2025-12-31' });
  });
  it('같은 기간이 여러 공시에 있으면 최초 공시 값을 쓰고 정정·후속 비교값은 무시한다', () => {
    const { get } = build();
    expect(get(2024, 'FY')?.netIncome).toBe('400'); // not 405 (restated) nor 999 (10-K/A)
    expect(get(2024, 'Q1')?.netIncome).toBe('80'); // not the restated comparative 81
    expect(get(2024, 'FY')?.totalEquity).toBe('1060'); // not the later comparative 1070
  });
  it('매출 태그는 기간별 우선순위(Revenues 먼저)로 고르고 태그가 바뀌어도 이어 붙인다', () => {
    const { get } = build();
    expect(get(2025, 'Q1')?.revenue).toBe('450'); // Revenues beats the ASC 606 tag
    expect(get(2024, 'Q1')?.revenue).toBe('400'); // only the ASC 606 tag exists in 2024
    expect(get(2025, 'FY')?.revenue).toBe('1900');
  });
  it('4분기는 연간 - 9개월 누적, 1~3분기는 3개월 기간 값이다', () => {
    const { get } = build();
    expect(get(2025, 'Q3')).toMatchObject({
      revenue: '470',
      netIncome: '110',
      operatingIncome: '120',
    });
    const q4 = get(2025, 'Q4')!;
    expect(q4).toMatchObject({
      derived: true,
      revenue: '520', // 1900 - 1380
      netIncome: '130', // 430 - 300
      operatingIncome: '140', // 470 - 330
      periodEnd: '2025-12-31',
      periodType: 'quarter',
    });
    expect(q4.totalEquity).toBe('1250'); // balance sheet of the 10-K
    expect(get(2024, 'Q4')).toMatchObject({ revenue: '450', netIncome: '135' });
  });
  it('없는 항목은 추정하지 않고 null이다', () => {
    const { get } = build();
    expect(get(2024, 'FY')?.operatingIncome).toBeNull();
    expect(get(2024, 'Q4')?.operatingIncome).toBeNull();
    expect(get(2025, 'Q1')?.totalLiabilities).toBeNull();
    expect(get(2025, 'FY')?.totalLiabilities).toBe('1750');
    expect(get(2024, 'Q1')?.totalAssets).toBeNull();
  });
  it('진행 중인 회계연도의 분기는 직전 연간 보고서 기준으로 위치를 정한다', () => {
    const q1 = build().get(2026, 'Q1')!;
    expect(q1).toMatchObject({ revenue: '500', netIncome: '120', periodEnd: '2026-03-31' });
  });
  it('공시일은 사용한 사실의 공시일 중 가장 늦은 날이다', () => {
    const { get } = build();
    expect(get(2025, 'Q1')?.filedAt).toBe('2025-05-01');
    expect(get(2025, 'FY')?.filedAt).toBe('2026-02-19');
    expect(get(2025, 'Q4')?.filedAt).toBe('2026-02-19');
    expect(get(2024, 'Q4')?.filedAt).toBe('2025-02-20');
  });
  it('표지의 발행주식수는 같은 공시에서 값이 하나일 때만 쓴다', () => {
    const { get } = build();
    expect(get(2025, 'Q1')?.sharesOutstanding).toBe('100');
    expect(get(2025, 'Q2')?.sharesOutstanding).toBeNull(); // two classes, two values
    expect(get(2025, 'Q4')?.sharesOutstanding).toBe('100');
  });
  it('시점 필터: 공시 전에는 해당 분기·연간 값을 쓰지 않는다', () => {
    const { statements } = build();
    const known = statementsKnownAt(statements, '2026-02-18');
    expect(known.some((s) => s.fiscalYear === 2025 && s.fiscalPeriod === 'FY')).toBe(false);
    expect(known.some((s) => s.fiscalYear === 2025 && s.fiscalPeriod === 'Q4')).toBe(false);
    expect(known.some((s) => s.fiscalYear === 2026)).toBe(false);
    const before = computePerShareMetrics(known);
    // Q4'24 135 + Q1 90 + Q2 100 + Q3 110 = 435, 100 shares
    expect(before.ttm).toMatchObject({ netIncome: 435, basis: 'four-quarters' });
    expect(before.eps.value).toBeCloseTo(4.35);
    expect(before.asOf).toBe('2025-10-30');
    const after = computePerShareMetrics(statementsKnownAt(statements, '2026-02-19'));
    expect(after.ttm).toMatchObject({ netIncome: 430, basis: 'annual' });
    expect(after.asOf).toBe('2026-02-19');
    const latest = computePerShareMetrics(statements);
    expect(latest.ttm?.netIncome).toBe(100 + 110 + 130 + 120);
    expect(latest.eps.value).toBeCloseTo(4.6);
    expect(latest.roe.value).toBeCloseTo(460 / ((1300 + 1100) / 2));
  });
  it('USD 이외 단위·us-gaap 없는 회사·형식 오류를 구분한다', () => {
    const foreign = build({ cik: 1234567, facts: { 'ifrs-full': {} } });
    expect(foreign.statements).toEqual([]);
    expect(foreign.warnings[0]).toContain('us-gaap');
    const eur = companyFacts();
    (eur.facts['us-gaap'] as Record<string, unknown>).NetIncomeLoss = unit(
      [entry('k_24', '2024-12-31', 5, '2024-01-01')],
      'EUR',
    );
    expect(build(eur).get(2024, 'FY')?.netIncome).toBeNull();
    for (const mutate of [
      (f: ReturnType<typeof companyFacts>) =>
        ((f.facts['us-gaap'] as Record<string, unknown>).NetIncomeLoss = unit([
          { ...entry('k_24', '2024-12-31', 1, '2024-01-01'), val: '1' as unknown as number },
        ])),
      (f: ReturnType<typeof companyFacts>) =>
        ((f.facts['us-gaap'] as Record<string, unknown>).NetIncomeLoss = unit([
          { ...entry('k_24', '2024-12-31', 1, '2024-01-01'), filed: 'yesterday' },
        ])),
      (f: ReturnType<typeof companyFacts>) =>
        ((f.facts['us-gaap'] as Record<string, unknown>).Assets = { units: { USD: 'x' } }),
    ]) {
      const facts = companyFacts();
      mutate(facts);
      expect(() => build(facts)).toThrowError(/./);
      try {
        build(facts);
      } catch (error) {
        expect(error).toMatchObject({ status: 502, code: 'PROVIDER_SCHEMA_INVALID' });
      }
    }
  });
});

describe('SEC 어댑터', () => {
  it('고정 호스트·User-Agent·redirect 금지로 요청하고 ticker 지도를 캐시한다', async () => {
    const t = transport();
    const sec = adapter(t);
    const result = await sec.statements('synt');
    expect(result).toMatchObject({
      market: 'US',
      symbol: 'SYNT',
      name: 'Synthetic Corp',
      source: 'SEC EDGAR',
    });
    expect(result.asOf).toBe(now().toISOString());
    expect(t.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://www.sec.gov/files/company_tickers.json',
      FACTS_URL,
    ]);
    for (const call of t.mock.calls) {
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>)['User-Agent']).toBe(AGENT);
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    await sec.statements('SYNT'); // cached for 6 hours
    expect(t.mock.calls).toHaveLength(2);
  });
  it('동시 요청은 한 번의 companyfacts 호출로 합치고 점 표기 티커를 정규화한다', async () => {
    const t = transport();
    const sec = adapter(t);
    await Promise.all([sec.statements('SYNT'), sec.statements('SYNT')]);
    expect(t.mock.calls.filter((call) => String(call[0]).includes('companyfacts'))).toHaveLength(1);
    expect(normalizeUsSymbol('syn.b')).toBe('SYN-B');
    expect(normalizeUsSymbol('BRK-B')).toBe('BRK-B');
    for (const invalid of ['', '123', 'TOOLONGSYMBOL', 'A B', '../x', 'A;B'])
      expect(normalizeUsSymbol(invalid)).toBeNull();
    await expect(sec.statements('../x')).rejects.toThrow(RangeError);
    const tc = transport();
    await adapter(tc)
      .statements('syn.b')
      .catch(() => undefined);
    expect(String(tc.mock.calls[1][0])).toBe(
      'https://data.sec.gov/api/xbrl/companyfacts/CIK0007654321.json',
    );
  });
  it('알 수 없는 티커·companyfacts 404는 404, 인증·한도·장애는 503으로 구분한다', async () => {
    await expect(adapter(transport()).statements('ZZZZ')).rejects.toMatchObject({ status: 404 });
    await expect(
      adapter(transport(undefined, { factsStatus: 404 })).statements('NOFACT'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      adapter(transport(undefined, { factsStatus: 403 })).statements('SYNT'),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ACCESS_DENIED',
    });
    await expect(
      adapter(transport(undefined, { factsStatus: 429 })).statements('SYNT'),
    ).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
      retryAfter: 60,
    });
    await expect(
      adapter(transport(undefined, { factsStatus: 500 })).statements('SYNT'),
    ).rejects.toMatchObject({
      status: 503,
      code: 'PROVIDER_UNAVAILABLE',
    });
  });
  it('과대 응답·CIK 불일치·형식 오류·통신 오류를 안전하게 실패 처리한다', async () => {
    await expect(
      adapter(transport(companyFacts({ cik: 9 }))).statements('SYNT'),
    ).rejects.toMatchObject({
      code: 'PROVIDER_SCHEMA_INVALID',
    });
    await expect(
      adapter(
        transport(undefined, { tickersBody: { 0: { cik_str: 'x', ticker: 'A', title: 'B' } } }),
      ).statements('SYNT'),
    ).rejects.toMatchObject({ code: 'PROVIDER_SCHEMA_INVALID' });
    const leaking = vi.fn(async () => {
      throw new Error(`failed with ${AGENT}`);
    }) as unknown as typeof fetch;
    const error = await adapter(leaking)
      .statements('SYNT')
      .catch((caught) => caught);
    expect(error.code).toBe('PROVIDER_UNREACHABLE');
    expect(error.message).not.toContain('test-contact');
    const oversize = vi.fn(
      async () =>
        new Response('x'.repeat(10), {
          headers: { 'content-length': String(secLimits.tickersBytes + 1) },
        }),
    ) as unknown as typeof fetch;
    await expect(adapter(oversize).statements('SYNT')).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE_TOO_LARGE',
    });
    expect(() => parseTickers({})).toThrow();
  });
  it('연락처가 있는 User-Agent가 없으면 어댑터를 만들지 않는다', () => {
    expect(secFromEnvironment({})).toBeUndefined();
    expect(secFromEnvironment({ SEC_USER_AGENT: 'no-contact-agent' })).toBeUndefined();
    expect(secFromEnvironment({ SEC_USER_AGENT: 'bad\nheader@example.invalid' })).toBeUndefined();
    expect(secFromEnvironment({ SEC_USER_AGENT: AGENT })).toBeInstanceOf(SecAdapter);
    expect(validSecUserAgent('https://example.invalid/contact')).toBe(true);
    expect(() => new SecAdapter({ userAgent: 'x' })).toThrow();
  });
  it('요청 간격 제한기는 초당 4건 이하로 간격을 둔다', async () => {
    let time = 1000;
    const sleeps: number[] = [];
    const limiter = new RateLimiter(
      secLimits.minimumIntervalMs,
      async (ms) => {
        sleeps.push(ms);
        time += ms;
      },
      () => time,
    );
    await Promise.all([limiter.wait(), limiter.wait(), limiter.wait()]);
    expect(sleeps).toEqual([250, 250]); // each call waits for the slot after the previous one
    expect(1000 / secLimits.minimumIntervalMs).toBeLessThanOrEqual(5);
  });
});
