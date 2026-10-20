import { ProviderError } from '../server/toss.js';

/**
 * Small runner shared by scheduled jobs (daily snapshot now, morning calendar and algorithm runs
 * later). It gives every job structured exit codes and a log line format that cannot carry secrets:
 * only a fixed set of keys and token-shaped values are ever written.
 */
export const EXIT = {
  /** Finished (including "nothing to do today"). */
  OK: 0,
  /** Unexpected failure, or nothing could be stored. */
  FAILED: 1,
  /** Missing or invalid configuration; retrying cannot help. */
  CONFIG: 2,
  /** Finished, but some steps failed; the run record lists which. */
  PARTIAL: 3,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
export type JobOutcome = 'ok' | 'partial' | 'failed';
export const exitCodeFor = (outcome: JobOutcome): ExitCode =>
  outcome === 'ok' ? EXIT.OK : outcome === 'partial' ? EXIT.PARTIAL : EXIT.FAILED;
export class JobConfigError extends Error {
  constructor() {
    super('JOB_CONFIG_INVALID');
  }
}
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const TOKEN = /^[A-Za-z0-9_:.\-]{1,64}$/;
const NUMBER_KEYS = new Set([
  'attempts',
  'count',
  'ok',
  'failed',
  'forbidden',
  'stale',
  'empty',
  'skipped',
  'targets',
  'symbols',
  'written',
  'pages',
  'durationMs',
]);
const TOKEN_KEYS = new Set(['step', 'market', 'date', 'status', 'trigger']);
export type JobLogFields = {
  step?: string;
  market?: string;
  date?: string;
  status?: string;
  trigger?: string;
  /** Sanitized code (upper snake case) only. */
  code?: string;
  /** Code -> count. */
  codes?: Record<string, number>;
  attempts?: number;
  count?: number;
  ok?: number;
  failed?: number;
  forbidden?: number;
  stale?: number;
  empty?: number;
  skipped?: number;
  targets?: number;
  symbols?: number;
  written?: number;
  pages?: number;
  durationMs?: number;
};
export type JobLogger = {
  info(event: string, fields?: JobLogFields): void;
  warn(event: string, fields?: JobLogFields): void;
  error(event: string, fields?: JobLogFields): void;
};
/** Drops anything that is not an allowed key with a safe, short, token-shaped value. */
export function sanitizeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'code' && typeof value === 'string' && CODE.test(value)) out[key] = value;
    else if (NUMBER_KEYS.has(key) && typeof value === 'number' && Number.isFinite(value))
      out[key] = value;
    else if (TOKEN_KEYS.has(key) && typeof value === 'string' && TOKEN.test(value))
      out[key] = value;
    else if (key === 'codes' && value && typeof value === 'object' && !Array.isArray(value)) {
      const codes = Object.entries(value).filter(
        ([k, v]) => CODE.test(k) && typeof v === 'number' && Number.isFinite(v),
      );
      if (codes.length) out[key] = Object.fromEntries(codes);
    }
  }
  return out;
}
/** One JSON object per line; Cloud Logging reads `severity` and `message` from stdout. */
export function createJobLogger(
  job: string,
  write: (line: string) => void = (line) => console.log(line),
): JobLogger {
  if (!TOKEN.test(job)) throw new JobConfigError();
  const emit = (severity: string, event: string, fields: JobLogFields = {}) => {
    if (!TOKEN.test(event)) return;
    write(JSON.stringify({ severity, message: event, job, ...sanitizeLogFields({ ...fields }) }));
  };
  return {
    info: (event, fields) => emit('INFO', event, fields),
    warn: (event, fields) => emit('WARNING', event, fields),
    error: (event, fields) => emit('ERROR', event, fields),
  };
}
/**
 * Maps any thrown value to a code that is safe to log. Provider errors carry codes this codebase
 * assigns itself (never provider text); everything else collapses to a fixed code.
 */
export function safeErrorCode(error: unknown): string {
  if (error instanceof JobConfigError) return 'JOB_CONFIG_INVALID';
  if (error instanceof ProviderError && CODE.test(error.code)) return error.code;
  return 'JOB_FAILED';
}
export type JobContext = { log: JobLogger };
/**
 * Runs a job body. The body reports its outcome; an unexpected throw is logged as a single code
 * (never the message or stack) and exits 1, a configuration error exits 2.
 */
export async function runJob(
  name: string,
  body: (context: JobContext) => Promise<JobOutcome>,
  write?: (line: string) => void,
): Promise<ExitCode> {
  const log = createJobLogger(name, write);
  const started = Date.now();
  log.info('job-started');
  try {
    const outcome = await body({ log });
    log.info('job-finished', { status: outcome, durationMs: Date.now() - started });
    return exitCodeFor(outcome);
  } catch (error) {
    const code = safeErrorCode(error);
    log.error('job-failed', { code, durationMs: Date.now() - started });
    return error instanceof JobConfigError ? EXIT.CONFIG : EXIT.FAILED;
  }
}
