import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  EcosAdapter,
  ecosFromEnvironment,
  ecosResult,
  periodArgument,
  periodStart,
} from '../src/server/macro/ecos';
import { RateLimiter } from '../src/server/fundamentals/shared';
import { ProviderError } from '../src/server/toss';

const KEY = 'TESTKEY0123456789ABCDEF';
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/macro/${name}`, import.meta.url), 'utf8'));
const NOW = new Date('2026-10-21T03:00:00Z');

function reply(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
function adapter(transport: ReturnType<typeof vi.fn>) {
  return new EcosAdapter({
    apiKey: KEY,
    transport: transport as unknown as typeof fetch,
    now: () => NOW,
    limiter: new RateLimiter(0),
  });
}
const calls = (transport: unknown) =>
  (transport as { mock: { calls: [string, RequestInit | undefined][] } }).mock.calls;
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected failure');
};
const range = { from: '2026-10-12', to: '2026-10-15' };

describe('ECOS 일별 시리즈', () => {
  it('키를 경로에 넣은 문서 형식 URL로 요청하고 날짜·값을 정규화한다', async () => {
    const transport = vi.fn(async () => reply(fixture('ecos-usdkrw.json')));
    const rows = await adapter(transport).dailySeries('kr-usdkrw', range.from, range.to);
    expect(String(calls(transport)[0][0])).toBe(
      `https://ecos.bok.or.kr/api/StatisticSearch/${KEY}/json/kr/1/1000/731Y001/D/20261012/20261015/0000001/`,
    );
    expect(calls(transport)[0][1]!.redirect).toBe('error');
    expect(rows).toEqual([
      { date: '2026-10-12', period: '20261012', value: '1400.5', unit: '원' },
      { date: '2026-10-13', period: '20261013', value: '1402.25', unit: '원' },
      { date: '2026-10-14', period: '20261014', value: null, unit: '원' },
      { date: '2026-10-15', period: '20261015', value: '1398', unit: '원' },
    ]);
  });

  it('일별이 아닌 지표와 카탈로그 밖 id는 거부한다', async () => {
    const transport = vi.fn(async () => reply(fixture('ecos-usdkrw.json')));
    const ecos = adapter(transport);
    for (const id of ['kr-cpi', 'us-cpi', '731Y001', 'kr-usdkrw/../x'])
      await expect(ecos.dailySeries(id, range.from, range.to)).rejects.toThrow(RangeError);
    await expect(ecos.dailySeries('kr-usdkrw', '2026-10-15', '2026-10-12')).rejects.toThrow(
      RangeError,
    );
    await expect(ecos.dailySeries('kr-usdkrw', '20261012', '2026-10-15')).rejects.toThrow(
      RangeError,
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it('월별 지표는 YYYYMM 형식으로 요청하고 월 첫날로 환산한다', async () => {
    const transport = vi.fn(async () => reply(fixture('ecos-cpi-monthly.json')));
    const rows = await adapter(transport).observations('kr-cpi', {
      from: '2026-08-15',
      to: '2026-10-01',
    });
    expect(String(calls(transport)[0][0])).toContain('/901Y009/M/202608/202610/0/');
    expect(rows.map((row) => [row.date, row.value])).toEqual([
      ['2026-08-01', '118.4'],
      ['2026-09-01', '118.9'],
    ]);
  });

  it('두 단계 항목 코드가 있는 표는 둘째 코드를 경로에 붙이고 응답 행에서도 확인한다', async () => {
    const line = (code2: string) => ({
      STAT_CODE: '402Y014',
      ITEM_CODE1: '*AA',
      ITEM_CODE2: code2,
      TIME: '202609',
      DATA_VALUE: '182.29',
      UNIT_NAME: '2020=100',
    });
    const ok = vi.fn(async () =>
      reply({ StatisticSearch: { list_total_count: 1, row: [line('W')] } }),
    );
    const rows = await adapter(ok).observations('kr-export-price', {
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(String(calls(ok)[0][0])).toContain('/402Y014/M/202609/202609/*AA/W/');
    expect(rows.map((item) => item.value)).toEqual(['182.29']);
    const wrong = vi.fn(async () =>
      reply({ StatisticSearch: { list_total_count: 1, row: [line('D')] } }),
    );
    const error = await failure(
      adapter(wrong).observations('kr-export-price', { from: '2026-09-01', to: '2026-09-30' }),
    );
    expect((error as ProviderError).code).toBe('PROVIDER_SCHEMA_INVALID');
  });
  it('주기별 날짜 형식(문서: 2020, 2020Q1, 202001, 20200101) 변환', () => {
    expect(periodArgument('2026-10-12', 'D')).toBe('20261012');
    expect(periodArgument('2026-10-12', 'M')).toBe('202610');
    expect(periodArgument('2026-10-12', 'Q')).toBe('2026Q4');
    expect(periodArgument('2026-03-31', 'Q')).toBe('2026Q1');
    expect(periodArgument('2026-10-12', 'A')).toBe('2026');
    expect(periodStart('2026Q3', 'Q')).toBe('2026-07-01');
    expect(periodStart('2026', 'A')).toBe('2026-01-01');
    expect(() => periodStart('2026Q5', 'Q')).toThrow();
    expect(() => periodStart('20261340', 'D')).toThrow();
    expect(() => periodStart('202613', 'M')).toThrow();
    expect(() => periodStart('202610', 'D')).toThrow();
  });

  it('데이터 없음(정보-200)은 빈 배열이다', async () => {
    const transport = vi.fn(async () => reply(fixture('ecos-no-data.json')));
    await expect(
      adapter(transport).dailySeries('kr-usdkrw', range.from, range.to),
    ).resolves.toEqual([]);
  });

  it('1000건을 넘으면 다음 쪽 범위로 이어서 받고 날짜 중복을 합친다', async () => {
    const rowFor = (index: number) => {
      const date = new Date(Date.UTC(2020, 0, 1) + index * 86400000);
      return {
        STAT_CODE: '731Y001',
        ITEM_CODE1: '0000001',
        UNIT_NAME: '원',
        TIME: date.toISOString().slice(0, 10).replaceAll('-', ''),
        DATA_VALUE: String(1000 + index),
      };
    };
    const transport = vi.fn(async (input: string) => {
      const start = Number(input.split('/kr/')[1].split('/')[0]);
      const rows = Array.from({ length: start === 1 ? 1000 : 500 }, (_, i) =>
        rowFor(start - 1 + i),
      );
      return reply({ StatisticSearch: { list_total_count: 1500, row: rows } });
    });
    const rows = await adapter(transport).dailySeries('kr-usdkrw', '2020-01-01', '2024-03-01');
    expect(rows).toHaveLength(1500);
    expect(String(calls(transport)[1][0])).toContain('/kr/1001/2000/');
    expect(rows[0].value).toBe('1000');
    expect(rows.at(-1)?.value).toBe('2499');
  });

  it('결과가 한도를 넘으면 계속 받지 않고 실패한다', async () => {
    const rowFor = (index: number) => ({
      STAT_CODE: '731Y001',
      ITEM_CODE1: '0000001',
      TIME: new Date(Date.UTC(1990, 0, 1) + index * 86400000)
        .toISOString()
        .slice(0, 10)
        .replaceAll('-', ''),
      DATA_VALUE: '1',
    });
    let offset = 0;
    const transport = vi.fn(async () => {
      const rows = Array.from({ length: 1000 }, (_, i) => rowFor(offset + i));
      offset += 1000;
      return reply({ StatisticSearch: { list_total_count: 99999, row: rows } });
    });
    const error = (await failure(
      adapter(transport).dailySeries('kr-usdkrw', '1990-01-01', '2026-10-01'),
    )) as ProviderError;
    expect(error.code).toBe('PROVIDER_RESPONSE_TOO_LARGE');
    expect(transport).toHaveBeenCalledTimes(10);
  });

  it('같은 조회는 캐시한다', async () => {
    const transport = vi.fn(async () => reply(fixture('ecos-usdkrw.json')));
    const ecos = adapter(transport);
    await Promise.all([
      ecos.dailySeries('kr-usdkrw', range.from, range.to),
      ecos.dailySeries('kr-usdkrw', range.from, range.to),
    ]);
    await ecos.dailySeries('kr-usdkrw', range.from, range.to);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('ECOS 응답 검증', () => {
  const row = (patch: Record<string, unknown>) => ({
    STAT_CODE: '731Y001',
    ITEM_CODE1: '0000001',
    UNIT_NAME: '원',
    TIME: '20261012',
    DATA_VALUE: '1400',
    ...patch,
  });
  it('형식이 다른 응답은 PROVIDER_SCHEMA_INVALID로 실패한다', async () => {
    const bad = [
      {},
      { StatisticSearch: {} },
      { StatisticSearch: { list_total_count: 'x', row: [] } },
      { StatisticSearch: { list_total_count: 1, row: 'x' } },
      { StatisticSearch: { list_total_count: 1, row: [row({ STAT_CODE: '999Y999' })] } },
      { StatisticSearch: { list_total_count: 1, row: [row({ ITEM_CODE1: '0000002' })] } },
      { StatisticSearch: { list_total_count: 1, row: [row({ TIME: '2026-10-12' })] } },
      { StatisticSearch: { list_total_count: 1, row: [row({ TIME: '20261340' })] } },
      { StatisticSearch: { list_total_count: 1, row: [row({ DATA_VALUE: 'N/A' })] } },
      { StatisticSearch: { list_total_count: 1, row: [row({ DATA_VALUE: '1,400' })] } },
      { RESULT: { CODE: 'WHAT-999' } },
      { RESULT: {} },
    ];
    for (const body of bad) {
      const transport = vi.fn(async () => reply(body));
      const error = await failure(
        adapter(transport).dailySeries('kr-usdkrw', range.from, range.to),
      );
      expect(error, JSON.stringify(body)).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe('PROVIDER_SCHEMA_INVALID');
    }
    const notJson = vi.fn(async () => reply('<RESULT/>'));
    expect(
      (
        (await failure(
          adapter(notJson).dailySeries('kr-usdkrw', range.from, range.to),
        )) as ProviderError
      ).code,
    ).toBe('PROVIDER_SCHEMA_INVALID');
  });

  it('숫자 값은 소수 문자열로, 빈 값은 null로 바꾼다', async () => {
    const transport = vi.fn(async () =>
      reply({
        StatisticSearch: {
          list_total_count: 3,
          row: [
            row({ DATA_VALUE: 1400.5 }),
            row({ TIME: '20261013', DATA_VALUE: null }),
            row({ TIME: '20261014', DATA_VALUE: '-0.25' }),
          ],
        },
      }),
    );
    const rows = await adapter(transport).dailySeries('kr-usdkrw', range.from, range.to);
    expect(rows.map((item) => item.value)).toEqual(['1400.5', null, '-0.25']);
  });
});

describe('ECOS 오류 코드', () => {
  it('문서의 정보/에러 코드를 앱 오류로 옮긴다', () => {
    const code = (value: string) => {
      const result = ecosResult(value);
      return result === 'no-data' ? result : result.code;
    };
    expect(code('INFO-100')).toBe('PROVIDER_ACCESS_DENIED');
    expect(code('정보-100')).toBe('PROVIDER_ACCESS_DENIED');
    expect(code('INFO-200')).toBe('no-data');
    expect(code('정보-200')).toBe('no-data');
    for (const rejected of ['100', '101', '200', '300', '301'])
      expect(code(`ERROR-${rejected}`)).toBe('PROVIDER_REQUEST_REJECTED');
    for (const unavailable of ['400', '500', '600', '601'])
      expect(code(`ERROR-${unavailable}`)).toBe('PROVIDER_UNAVAILABLE');
    expect(code('에러-602')).toBe('PROVIDER_RATE_LIMITED');
    for (const unknown of ['ERROR-999', 'INFO-300', 'nonsense', ''])
      expect(code(unknown)).toBe('PROVIDER_SCHEMA_INVALID');
  });

  it('요청 중 받은 오류 코드가 앱 오류로 나오고 키·제공자 문구는 남지 않는다', async () => {
    for (const [body, expected] of [
      [fixture('ecos-error-key.json'), 'PROVIDER_ACCESS_DENIED'],
      [
        { RESULT: { CODE: 'ERROR-101', MESSAGE: 'secret-provider-text' } },
        'PROVIDER_REQUEST_REJECTED',
      ],
      [{ RESULT: { CODE: 'ERROR-602', MESSAGE: 'secret-provider-text' } }, 'PROVIDER_RATE_LIMITED'],
      [{ RESULT: { CODE: 'ERROR-500', MESSAGE: 'secret-provider-text' } }, 'PROVIDER_UNAVAILABLE'],
    ] as const) {
      const transport = vi.fn(async () => reply(body));
      const error = (await failure(
        adapter(transport).dailySeries('kr-usdkrw', range.from, range.to),
      )) as ProviderError;
      expect(error.code).toBe(expected);
      const dump = JSON.stringify(error) + error.message + String(error.stack);
      expect(dump).not.toContain(KEY);
      expect(dump).not.toContain('secret-provider-text');
      expect(dump).not.toContain('ecos.bok.or.kr');
    }
  });

  it('요청 한도(에러-602) 뒤에는 대기 시간 동안 제공자를 다시 부르지 않는다', async () => {
    const transport = vi.fn(async () => reply({ RESULT: { CODE: 'ERROR-602' } }));
    const ecos = adapter(transport);
    await failure(ecos.dailySeries('kr-usdkrw', range.from, range.to));
    const second = (await failure(ecos.observations('kr-base-rate', range))) as ProviderError;
    expect(second.code).toBe('PROVIDER_RATE_LIMITED');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('HTTP 오류와 전송 오류에서도 URL(키 포함)을 내보내지 않는다', async () => {
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      const transport = vi.fn(async () => reply('nope', status));
      const error = (await failure(
        adapter(transport).dailySeries('kr-usdkrw', range.from, range.to),
      )) as ProviderError;
      expect(error, String(status)).toBeInstanceOf(ProviderError);
      expect(JSON.stringify(error) + error.message + String(error.stack)).not.toContain(KEY);
    }
    const transport = vi.fn(async (input: string) => {
      throw new TypeError(`request to ${input} failed`);
    });
    const error = (await failure(
      adapter(transport).dailySeries('kr-usdkrw', range.from, range.to),
    )) as ProviderError;
    expect(error.code).toBe('PROVIDER_UNREACHABLE');
    expect(JSON.stringify(error) + error.message + String(error.stack)).not.toContain(KEY);
    expect(error.cause).toBeUndefined();
  });
});

describe('ECOS 최신값과 설정', () => {
  it('결측을 건너뛰고 최신값·이전값을 돌려준다', async () => {
    const transport = vi.fn(async () => reply(fixture('ecos-usdkrw.json')));
    const [fx] = await adapter(transport).latestObservations(['kr-usdkrw'], '2026-10-16');
    expect(fx.latest).toMatchObject({ date: '2026-10-15', value: '1398' });
    expect(fx.previous).toMatchObject({ date: '2026-10-13', value: '1402.25' });
    expect(String(calls(transport)[0][0])).toContain('/731Y001/D/20260901/20261016/0000001/');
  });

  it('asOf 이후 날짜는 버리고 입력을 검증한다', async () => {
    const transport = vi.fn(async () => reply(fixture('ecos-usdkrw.json')));
    const ecos = adapter(transport);
    const [fx] = await ecos.latestObservations(['kr-usdkrw'], '2026-10-13');
    expect(fx.latest?.date).toBe('2026-10-13');
    await expect(ecos.latestObservations([], '2026-10-13')).rejects.toThrow(RangeError);
    await expect(ecos.latestObservations(['us-cpi'], '2026-10-13')).rejects.toThrow(RangeError);
    await expect(ecos.latestObservations(['kr-cpi'], 'x')).rejects.toThrow(RangeError);
  });

  it('asOf를 생략하면 KST 오늘을 쓴다', async () => {
    const transport = vi.fn(async () => reply({ RESULT: { CODE: 'INFO-200' } }));
    const [fx] = await adapter(transport).latestObservations(['kr-base-rate']);
    expect(fx).toEqual({ id: 'kr-base-rate', asOf: '2026-10-21', latest: null, previous: null });
    expect(String(calls(transport)[0][0])).toContain('/722Y001/D/');
  });

  it('경로에 들어가므로 키는 안전한 문자만 허용하고 환경 변수에서 만든다', () => {
    for (const key of [
      '',
      'short',
      'AAAAAAAAAA/../x',
      'AAAAAAAAAA?x=1',
      'AAAAAAAAAA AAAA',
      'A'.repeat(65),
    ])
      expect(() => new EcosAdapter({ apiKey: key }), key).toThrow('Invalid ECOS configuration');
    expect(ecosFromEnvironment({})).toBeUndefined();
    expect(ecosFromEnvironment({ ECOS_API_KEY: 'a/b' })).toBeUndefined();
    expect(ecosFromEnvironment({ ECOS_API_KEY: KEY })).toBeInstanceOf(EcosAdapter);
  });
});
