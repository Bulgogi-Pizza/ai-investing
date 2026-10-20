import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiGet, issueOf, type DataIssue } from '../../lib/api';
import type { AlgorithmMode, Currency } from '../../lib/algorithmRecords';

export const modeLabels: Record<AlgorithmMode, string> = {
  simulation: '시뮬레이션',
  paper: '모의',
  live: '실전',
};
export const modeDescriptions: Record<AlgorithmMode, string> = {
  simulation: '과거 일봉으로 계산만 해 보는 단계입니다. 서버에서 따로 실행하지 않습니다.',
  paper: '오늘부터 실제 시세로 매일 판단하고 가상 기록만 쌓습니다. 실제 주문은 나가지 않습니다.',
  live: '실제 주문이 나가는 모드입니다.',
};
export const liveUnavailableText = '실전 운용은 주문 기능 단계(7d–7f) 이후에 켤 수 있습니다.';

export function money(value: number, currency: Currency, fractionDigits?: number) {
  return currency === 'KRW'
    ? `${value.toLocaleString('ko-KR', { maximumFractionDigits: fractionDigits ?? 0 })}원`
    : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: fractionDigits ?? 2 })}`;
}
export const percent = (value: number | null, digits = 2) =>
  value === null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(digits)}%`;
export const signedPercent = (value: number | null, digits = 2) =>
  value === null || !Number.isFinite(value)
    ? '—'
    : `${value > 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`;

/** Decimal fraction <-> percent text without floating point noise (0.00015 <-> 0.015). */
export const fractionToPercent = (fraction: number | null) =>
  fraction === null ? '' : String(Number((fraction * 100).toPrecision(10)));
export const percentToFraction = (text: string): number | null | 'invalid' => {
  if (text.trim() === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? Number((n / 100).toPrecision(10)) : 'invalid';
};

export type LiveResource<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'issue'; issue: DataIssue };

/**
 * Like useApiResource, but a refresh keeps showing the previous data instead of flashing a
 * loading state, so a list does not jump after every save. `refreshKey` triggers a reload.
 */
export function useLiveResource<T>(url: string, parse: (body: unknown) => T, refreshKey = 0) {
  const [state, setState] = useState<LiveResource<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const parseRef = useRef(parse);
  parseRef.current = parse;
  useEffect(() => {
    const controller = new AbortController();
    apiGet(url, controller.signal)
      .then((body) => {
        const data = parseRef.current(body);
        if (!controller.signal.aborted) setState({ status: 'ready', data });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ status: 'issue', issue: issueOf(error) });
      });
    return () => controller.abort();
  }, [url, refreshKey, attempt]);
  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((value) => value + 1);
  }, []);
  return { state, retry };
}

export const invalidResponse = (what: string) =>
  new ApiError(502, 'INVALID_RESPONSE', `${what} 응답 형식을 확인하지 못했습니다.`);
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
