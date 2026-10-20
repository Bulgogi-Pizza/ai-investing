import { describe, expect, it } from 'vitest';
import { ApiError, NoDataError, issueOf } from '../src/lib/api';
import { kstToday } from '../src/lib/kst';
import { parseCandles } from '../src/features/analysis/candles';

describe('data state classification', () => {
  it('distinguishes not connected, owner only, no data and transient errors', () => {
    expect(issueOf(new ApiError(503, 'TOSS_INTEGRATION_UNAVAILABLE', 'm')).kind).toBe(
      'not-connected',
    );
    expect(issueOf(new ApiError(403, 'OWNER_REQUIRED', 'm'))).toMatchObject({
      kind: 'owner-only',
      retryable: false,
    });
    expect(issueOf(new ApiError(404, 'PROVIDER_NOT_FOUND', 'm')).kind).toBe('no-data');
    expect(issueOf(new NoDataError('m')).kind).toBe('no-data');
    expect(issueOf(new ApiError(503, 'PROVIDER_UNAVAILABLE', 'm'))).toMatchObject({
      kind: 'error',
      retryable: true,
    });
    expect(issueOf(new ApiError(409, 'STRATEGY_REQUIRED', 'm')).retryable).toBe(false);
    expect(issueOf(new Error('x')).kind).toBe('error');
  });
  it('treats an empty candle list as no data and a malformed one as an error', () => {
    const base = { source: 'Toss', asOf: '2026-10-20T00:00:00Z' };
    expect(() => parseCandles({ ...base, candles: [] })).toThrow(NoDataError);
    expect(() => parseCandles({ ...base, candles: [{ timestamp: 'x', close: '1' }] })).toThrow(
      ApiError,
    );
    expect(() => parseCandles({ ...base })).toThrow(ApiError);
  });
});

describe('KST dates', () => {
  it('rolls the calendar date at 15:00 UTC', () => {
    expect(kstToday(new Date('2026-10-20T14:59:00Z'))).toEqual({ year: 2026, month: 9, day: 20 });
    expect(kstToday(new Date('2026-10-20T15:00:00Z'))).toEqual({ year: 2026, month: 9, day: 21 });
    expect(kstToday(new Date('2026-12-31T15:00:00Z'))).toEqual({ year: 2027, month: 0, day: 1 });
  });
});
