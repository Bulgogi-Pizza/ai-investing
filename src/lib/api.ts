import { useEffect, useRef, useState } from 'react';

/** Error from the application API. Never carries provider raw text; messages come from our server. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
/** Valid response whose content cannot be shown (for example an empty candle list). */
export class NoDataError extends Error {}

export type DataIssueKind = 'not-connected' | 'owner-only' | 'no-data' | 'error';
export type DataIssue = { kind: DataIssueKind; message: string; retryable: boolean };

export async function apiGet(url: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, 'NETWORK_ERROR', '서버에 연결할 수 없습니다. 네트워크를 확인해 주세요.');
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON bodies (proxy or rate-limit pages) are reported generically below.
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const fallback =
      response.status === 429
        ? '요청이 많습니다. 잠시 후 다시 시도해 주세요.'
        : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
    throw new ApiError(
      response.status,
      typeof error?.code === 'string' ? error.code.slice(0, 80) : 'REQUEST_FAILED',
      typeof error?.message === 'string' ? error.message.slice(0, 300) : fallback,
    );
  }
  if (body === null)
    throw new ApiError(502, 'INVALID_RESPONSE', '서버 응답 형식을 확인하지 못했습니다.');
  return body;
}

/** Maps an error to one of the four user-visible data states. */
export function issueOf(error: unknown): DataIssue {
  if (error instanceof NoDataError)
    return { kind: 'no-data', message: error.message, retryable: true };
  if (error instanceof ApiError) {
    if (error.code === 'TOSS_INTEGRATION_UNAVAILABLE')
      return { kind: 'not-connected', message: error.message, retryable: true };
    if (error.code === 'OWNER_REQUIRED')
      return { kind: 'owner-only', message: error.message, retryable: false };
    if (error.code === 'PROVIDER_NOT_FOUND')
      return { kind: 'no-data', message: error.message, retryable: true };
    return {
      kind: 'error',
      message: error.message,
      retryable: ![400, 401, 403, 409].includes(error.status),
    };
  }
  return {
    kind: 'error',
    message: error instanceof Error ? error.message : '데이터를 불러오지 못했습니다.',
    retryable: true,
  };
}

export type Resource<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'issue'; issue: DataIssue };

/** Loads a JSON resource. `parse` validates the body and may throw (ApiError/NoDataError/Error). */
export function useApiResource<T>(url: string | null, parse: (body: unknown) => T) {
  const [state, setState] = useState<Resource<T>>({ status: url ? 'loading' : 'idle' });
  const [attempt, setAttempt] = useState(0);
  const parseRef = useRef(parse);
  parseRef.current = parse;
  useEffect(() => {
    if (!url) {
      setState({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    apiGet(url, controller.signal)
      .then((body) => {
        const data = parseRef.current(body);
        if (!controller.signal.aborted) setState({ status: 'ready', data });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ status: 'issue', issue: issueOf(error) });
      });
    return () => controller.abort();
  }, [url, attempt]);
  return { state, retry: () => setAttempt((value) => value + 1) };
}
