import { describe, expect, it } from 'vitest';
import {
  EXIT,
  JobConfigError,
  createJobLogger,
  runJob,
  safeErrorCode,
  sanitizeLogFields,
} from '../src/jobs/runner';
import { ProviderError } from '../src/server/toss';

describe('job log sanitizing', () => {
  it('keeps allowed keys with safe values and drops everything else', () => {
    expect(
      sanitizeLogFields({
        step: 'candles',
        market: 'KR',
        date: '2026-10-21',
        code: 'PROVIDER_FORBIDDEN',
        count: 3,
        codes: { PROVIDER_UNAVAILABLE: 2, 'bad code': 1 },
        // Everything below must be dropped.
        token: 'Bearer abc.def',
        accountSeq: '12345',
        body: '{"error":"raw"}',
        error: new Error('boom'),
      }),
    ).toEqual({
      step: 'candles',
      market: 'KR',
      date: '2026-10-21',
      code: 'PROVIDER_FORBIDDEN',
      count: 3,
      codes: { PROVIDER_UNAVAILABLE: 2 },
    });
  });
  it('drops free text and long or oddly shaped values even under allowed keys', () => {
    expect(
      sanitizeLogFields({
        step: 'raw provider message with spaces',
        status: 'x'.repeat(65),
        code: 'lowercase message',
        count: Number.NaN,
        market: 'Bearer abc',
      }),
    ).toEqual({});
  });
  it('writes one JSON object per line with severity, message and the job name', () => {
    const lines: string[] = [];
    const log = createJobLogger('daily-snapshot', (line) => lines.push(line));
    log.info('step-finished', { step: 'candles', ok: 2, token: 'secret' } as never);
    log.warn('not a token because spaces' as never);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      severity: 'INFO',
      message: 'step-finished',
      job: 'daily-snapshot',
      step: 'candles',
      ok: 2,
    });
    expect(() => createJobLogger('bad job name!')).toThrow();
  });
});

describe('safeErrorCode and exit codes', () => {
  it('passes only codes this code base assigned and collapses the rest', () => {
    expect(safeErrorCode(new ProviderError(503, 'PROVIDER_FORBIDDEN', 'm'))).toBe(
      'PROVIDER_FORBIDDEN',
    );
    expect(safeErrorCode(new JobConfigError())).toBe('JOB_CONFIG_INVALID');
    expect(safeErrorCode(new Error('Bearer abc.def secret'))).toBe('JOB_FAILED');
    expect(safeErrorCode('string')).toBe('JOB_FAILED');
    expect(safeErrorCode(new ProviderError(503, 'has spaces and secret', 'm'))).toBe('JOB_FAILED');
  });
  it('maps outcomes to exit codes and never logs error text', async () => {
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    expect(await runJob('job', async () => 'ok', write)).toBe(EXIT.OK);
    expect(await runJob('job', async () => 'partial', write)).toBe(EXIT.PARTIAL);
    expect(await runJob('job', async () => 'failed', write)).toBe(EXIT.FAILED);
    expect(
      await runJob(
        'job',
        async () => {
          throw new Error('SECRET-MARKER stack details');
        },
        write,
      ),
    ).toBe(EXIT.FAILED);
    expect(
      await runJob(
        'job',
        async () => {
          throw new JobConfigError();
        },
        write,
      ),
    ).toBe(EXIT.CONFIG);
    expect(lines.join('\n')).not.toContain('SECRET-MARKER');
    expect(lines.some((line) => line.includes('"code":"JOB_FAILED"'))).toBe(true);
    expect(lines.some((line) => line.includes('"code":"JOB_CONFIG_INVALID"'))).toBe(true);
  });
  it('uses distinct exit codes', () => {
    expect(new Set(Object.values(EXIT)).size).toBe(4);
    expect(EXIT.OK).toBe(0);
  });
});
