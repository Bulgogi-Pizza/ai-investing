import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import express, { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { OAuth2Client } from 'google-auth-library';
import type { AlgorithmRepository } from './algorithms.js';
import type { NotificationEvent, NotifyOutcome } from './notify.js';
import { ownerGate } from './owner.js';

/**
 * App-level monthly budget stop (docs/operations/budget.md).
 *
 * Cloud Billing publishes budget notifications to a Pub/Sub topic; a push subscription delivers
 * them to POST /api/internal/budget-alert with a Google-signed OIDC token. When the month's cost
 * reaches the budget the app stops its own cost-driving features: scheduled job work, AI calls and
 * (through the emergency stop) real orders. Billing itself is never disabled and the site and its
 * data stay up. Budget notifications arrive hours late, so this is best-effort, not a hard cap.
 *
 * State lives in one server-only Firestore document: opsControl/budget.
 */

// ---------------------------------------------------------------------------
// State and repository.
// ---------------------------------------------------------------------------
export type BudgetState = {
  stopped: boolean;
  reason: 'budget' | null;
  costAmount: number;
  budgetAmount: number;
  currency: string;
  /** ISO start of the billing interval the last notification belonged to. */
  intervalStart: string;
  /** Interval for which the warning was already announced (once per interval). */
  warnedIntervalStart?: string;
  stoppedAt?: string;
  releasedAt?: string;
  /** Interval the owner released by hand: it is not stopped again automatically. */
  releasedIntervalStart?: string;
  /** The emergency stop was applied for the current stop (retried until it is). */
  emergencyStopApplied?: boolean;
  /** The budget-stop Telegram message was claimed for the current stop (at most once). */
  stopNotified?: boolean;
  updatedAt: string;
};
export interface BudgetRepository {
  get(): Promise<BudgetState | null>;
  /**
   * Atomic read-modify-write. `change` is synchronous and side-effect free (a transaction may run
   * it more than once); returning `next: undefined` leaves the document unchanged.
   */
  update<T>(change: (current: BudgetState | null) => { next?: BudgetState; result: T }): Promise<T>;
}
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export class MemoryBudgetRepository implements BudgetRepository {
  private state: BudgetState | null = null;
  async get() {
    return this.state ? structuredClone(this.state) : null;
  }
  async update<T>(change: (current: BudgetState | null) => { next?: BudgetState; result: T }) {
    // No await between read and write: atomic within the single-threaded event loop.
    const { next, result } = change(this.state ? structuredClone(this.state) : null);
    if (next) this.state = structuredClone(next);
    return result;
  }
}
const COLLECTION = 'opsControl';
const DOCUMENT = 'budget';
export class FirestoreBudgetRepository implements BudgetRepository {
  constructor(private db = new Firestore()) {}
  private ref() {
    return this.db.collection(COLLECTION).doc(DOCUMENT);
  }
  async get() {
    const snapshot = await this.ref().get();
    return snapshot.exists ? parseState(snapshot.data()) : null;
  }
  async update<T>(change: (current: BudgetState | null) => { next?: BudgetState; result: T }) {
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(this.ref());
      const { next, result } = change(snapshot.exists ? parseState(snapshot.data()) : null);
      if (next) tx.set(this.ref(), plain(next));
      return result;
    });
  }
}
/** A malformed stored document is an error (callers treat "cannot read" as unknown), never "not stopped". */
function parseState(data: unknown): BudgetState {
  if (!data || typeof data !== 'object') throw new Error('Invalid budget state');
  const d = data as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  if (
    typeof d.stopped !== 'boolean' ||
    typeof d.costAmount !== 'number' ||
    typeof d.budgetAmount !== 'number' ||
    typeof d.currency !== 'string' ||
    typeof d.intervalStart !== 'string'
  )
    throw new Error('Invalid budget state');
  return {
    stopped: d.stopped,
    reason: d.reason === 'budget' ? 'budget' : null,
    costAmount: d.costAmount,
    budgetAmount: d.budgetAmount,
    currency: d.currency,
    intervalStart: d.intervalStart,
    ...(text(d.warnedIntervalStart) ? { warnedIntervalStart: text(d.warnedIntervalStart) } : {}),
    ...(text(d.stoppedAt) ? { stoppedAt: text(d.stoppedAt) } : {}),
    ...(text(d.releasedAt) ? { releasedAt: text(d.releasedAt) } : {}),
    ...(text(d.releasedIntervalStart)
      ? { releasedIntervalStart: text(d.releasedIntervalStart) }
      : {}),
    ...(typeof d.emergencyStopApplied === 'boolean'
      ? { emergencyStopApplied: d.emergencyStopApplied }
      : {}),
    ...(typeof d.stopNotified === 'boolean' ? { stopNotified: d.stopNotified } : {}),
    updatedAt: text(d.updatedAt) ?? '',
  };
}

// ---------------------------------------------------------------------------
// The flag readers use: cached, with an explicit "unknown" when it cannot be read.
// ---------------------------------------------------------------------------
export type BudgetStatus = 'running' | 'stopped' | 'unknown';
export class BudgetGuard {
  private cached: { status: BudgetStatus; expiresAt: number } | null = null;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly clock: () => number;
  constructor(
    private readonly repository: Pick<BudgetRepository, 'get'>,
    options: { ttlMs?: number; failureTtlMs?: number; clock?: () => number } = {},
  ) {
    // Never longer than a minute: a release or a stop reaches every instance within that time.
    this.ttlMs = Math.min(options.ttlMs ?? 60_000, 60_000);
    this.failureTtlMs = Math.min(options.failureTtlMs ?? 5_000, this.ttlMs);
    this.clock = options.clock ?? Date.now;
  }
  async status(): Promise<BudgetStatus> {
    const now = this.clock();
    if (this.cached && this.cached.expiresAt > now) return this.cached.status;
    let status: BudgetStatus;
    try {
      status = (await this.repository.get())?.stopped === true ? 'stopped' : 'running';
    } catch {
      status = 'unknown';
    }
    this.cached = {
      status,
      expiresAt: this.clock() + (status === 'unknown' ? this.failureTtlMs : this.ttlMs),
    };
    return status;
  }
  /** Drops the cache after this instance changed the state. */
  invalidate() {
    this.cached = null;
  }
}
/** `isBudgetStopped` for callers that fail open: only a readable "stopped" counts. */
export const isBudgetStopped = async (guard: Pick<BudgetGuard, 'status'>) =>
  (await guard.status()) === 'stopped';

/**
 * Process-wide guard for the AI call sites. The server and every job install theirs at start. AI
 * fails closed: an unreadable flag blocks; so does a production process that never installed one
 * (a wiring mistake must not become unmetered AI spend). Outside production with nothing
 * installed (tests, local scripts) nothing is blocked.
 */
let installedGuard: Pick<BudgetGuard, 'status'> | undefined;
export function installBudgetGuard(guard: Pick<BudgetGuard, 'status'> | undefined) {
  installedGuard = guard;
}
export async function aiBlockedByBudget(): Promise<boolean> {
  if (!installedGuard) return process.env.NODE_ENV === 'production';
  return (await installedGuard.status()) !== 'running';
}

// ---------------------------------------------------------------------------
// Configuration (feature is off unless both identity values are set).
// ---------------------------------------------------------------------------
export type BudgetPushConfig = {
  /** Expected OIDC audience: the service origin the subscription was created with. */
  audience: string;
  /** Expected token e-mail: the dedicated push service account. */
  serviceAccount: string;
  /** Cost / budget ratio from which the one warning per interval is sent. */
  warningRatio: number;
};
export const DEFAULT_WARNING_RATIO = 0.6667;
const serviceAccountPattern =
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
export function budgetPushConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): BudgetPushConfig | undefined {
  const audience = env.BUDGET_PUSH_AUDIENCE;
  const serviceAccount = env.BUDGET_PUSH_SERVICE_ACCOUNT;
  if (!audience || !serviceAccount) return undefined;
  try {
    if (new URL(audience).origin !== audience || !audience.startsWith('https://')) return undefined;
  } catch {
    return undefined;
  }
  if (!serviceAccountPattern.test(serviceAccount)) return undefined;
  const raw = Number(env.BUDGET_WARNING_RATIO);
  const warningRatio =
    env.BUDGET_WARNING_RATIO && Number.isFinite(raw) && raw > 0 && raw < 1
      ? raw
      : DEFAULT_WARNING_RATIO;
  return { audience, serviceAccount, warningRatio };
}

// ---------------------------------------------------------------------------
// Pub/Sub push: OIDC verification and message parsing.
// ---------------------------------------------------------------------------
export type VerifiedToken = {
  iss?: string;
  aud?: string | string[];
  email?: string;
  email_verified?: boolean;
};
/** Verifies signature, expiry and audience of a Google ID token; returns its claims or throws. */
export type PushVerifier = (idToken: string, audience: string) => Promise<VerifiedToken | null>;
export function googleOidcVerifier(
  client: Pick<OAuth2Client, 'verifyIdToken'> = new OAuth2Client(),
) {
  const verify: PushVerifier = async (idToken, audience) => {
    const ticket = await client.verifyIdToken({ idToken, audience });
    return ticket.getPayload() ?? null;
  };
  return verify;
}
const bearer = /^Bearer ([A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096})$/;
const issuers = new Set(['accounts.google.com', 'https://accounts.google.com']);
/** True only for a token Google signed for this audience and this exact service account. */
export async function authorizePush(
  header: string | undefined,
  config: BudgetPushConfig,
  verify: PushVerifier,
): Promise<boolean> {
  const token = header === undefined ? undefined : bearer.exec(header)?.[1];
  if (!token) return false;
  let claims: VerifiedToken | null;
  try {
    claims = await verify(token, config.audience);
  } catch {
    return false;
  }
  if (!claims || typeof claims.iss !== 'string' || !issuers.has(claims.iss)) return false;
  const audience = claims.aud;
  if (
    audience !== config.audience &&
    !(Array.isArray(audience) && audience.includes(config.audience))
  )
    return false;
  return claims.email_verified === true && claims.email === config.serviceAccount;
}

export type BudgetUpdate = {
  costAmount: number;
  budgetAmount: number;
  currency: string;
  intervalStart: string;
  /** Only present when the notification was caused by a threshold being crossed. */
  thresholdExceeded?: number;
};
/**
 * Pub/Sub push envelope (message.data is base64 of the JSON budget notification:
 * budgetDisplayName, costAmount, costIntervalStart, budgetAmount, budgetAmountType, currencyCode and
 * optionally alertThresholdExceeded). Anything else is malformed.
 */
export function parseBudgetMessage(body: unknown, now: number = Date.now()): BudgetUpdate | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const message = (body as { message?: unknown }).message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const data = (message as { data?: unknown }).data;
  if (typeof data !== 'string' || data.length < 8 || data.length > 8192) return null;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(data)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  if (!finite(p.costAmount) || p.costAmount < 0 || p.costAmount > 1e12) return null;
  if (!finite(p.budgetAmount) || p.budgetAmount <= 0 || p.budgetAmount > 1e12) return null;
  if (typeof p.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(p.currencyCode)) return null;
  if (typeof p.costIntervalStart !== 'string' || p.costIntervalStart.length > 40) return null;
  const started = Date.parse(p.costIntervalStart);
  // A billing interval cannot start in the future: a far-future value would make every real notification "stale".
  if (!Number.isFinite(started) || started > now + 3 * 86_400_000) return null;
  if (p.budgetAmountType !== undefined && typeof p.budgetAmountType !== 'string') return null;
  if (p.budgetDisplayName !== undefined && typeof p.budgetDisplayName !== 'string') return null;
  const threshold = p.alertThresholdExceeded;
  if (threshold !== undefined && (!finite(threshold) || threshold < 0 || threshold > 100))
    return null;
  return {
    costAmount: p.costAmount,
    budgetAmount: p.budgetAmount,
    currency: p.currencyCode,
    intervalStart: new Date(started).toISOString(),
    ...(threshold === undefined ? {} : { thresholdExceeded: threshold }),
  };
}

// ---------------------------------------------------------------------------
// Service: threshold logic and side effects.
// ---------------------------------------------------------------------------
export type BudgetHandleResult = {
  action: 'stale' | 'stopped' | 'already-stopped' | 'suppressed' | 'warned' | 'resumed' | 'none';
};
export type BudgetServiceOptions = {
  repository: BudgetRepository;
  algorithms: Pick<AlgorithmRepository, 'getControl' | 'setControl' | 'recordEvent'>;
  notify?: (event: NotificationEvent) => Promise<NotifyOutcome>;
  guard?: Pick<BudgetGuard, 'invalidate'>;
  warningRatio?: number;
  now?: () => Date;
  newId?: () => string;
};
export class BudgetService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly warningRatio: number;
  constructor(private readonly options: BudgetServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.warningRatio = options.warningRatio ?? DEFAULT_WARNING_RATIO;
  }
  get repository() {
    return this.options.repository;
  }
  private async send(event: NotificationEvent) {
    try {
      await this.options.notify?.(event);
    } catch {
      // Delivery problems never change the stop: the state is already stored.
    }
  }
  /** Sets the global emergency stop once (never releases it). Throws so the push is retried. */
  private async applyEmergencyStop() {
    const control = await this.options.algorithms.getControl();
    if (control.emergencyStop) return;
    const at = this.now().toISOString();
    await this.options.algorithms.setControl(true, at, {
      id: this.newId(),
      at,
      kind: 'budget-stop',
      changes: [{ field: 'emergencyStop', from: 'false', to: 'true' }],
    });
  }
  async handle(update: BudgetUpdate): Promise<BudgetHandleResult> {
    const at = this.now().toISOString();
    const ratio = update.costAmount / update.budgetAmount;
    const exceeded = update.thresholdExceeded ?? 0;
    const over = ratio >= 1 || exceeded >= 1;
    const warn = ratio >= this.warningRatio || exceeded >= this.warningRatio;
    const decision = await this.options.repository.update<{
      action: BudgetHandleResult['action'];
      finalize: boolean;
    }>((current) => {
      if (current && update.intervalStart < current.intervalStart)
        return { result: { action: 'stale', finalize: false } };
      const newInterval = !current || update.intervalStart > current.intervalStart;
      const next: BudgetState = {
        stopped: current?.stopped ?? false,
        reason: current?.reason ?? null,
        costAmount: newInterval
          ? update.costAmount
          : Math.max(current?.costAmount ?? 0, update.costAmount),
        budgetAmount: update.budgetAmount,
        currency: update.currency,
        intervalStart: update.intervalStart,
        ...(current?.warnedIntervalStart
          ? { warnedIntervalStart: current.warnedIntervalStart }
          : {}),
        ...(current?.stoppedAt ? { stoppedAt: current.stoppedAt } : {}),
        ...(current?.releasedAt ? { releasedAt: current.releasedAt } : {}),
        ...(current?.releasedIntervalStart
          ? { releasedIntervalStart: current.releasedIntervalStart }
          : {}),
        ...(current?.emergencyStopApplied !== undefined
          ? { emergencyStopApplied: current.emergencyStopApplied }
          : {}),
        ...(current?.stopNotified !== undefined ? { stopNotified: current.stopNotified } : {}),
        updatedAt: at,
      };
      let action: BudgetHandleResult['action'] = 'none';
      if (current?.stopped && newInterval && !over) {
        // A new billing interval that is under budget lifts the automatic stop (not the emergency stop).
        next.stopped = false;
        next.reason = null;
        next.releasedAt = at;
        action = 'resumed';
      }
      if (over) {
        if (next.stopped) action = 'already-stopped';
        else if (next.releasedIntervalStart === update.intervalStart) action = 'suppressed';
        else {
          next.stopped = true;
          next.reason = 'budget';
          next.stoppedAt = at;
          next.emergencyStopApplied = false;
          next.stopNotified = false;
          next.warnedIntervalStart = update.intervalStart;
          action = 'stopped';
        }
      } else if (warn && action === 'none' && next.warnedIntervalStart !== update.intervalStart) {
        next.warnedIntervalStart = update.intervalStart;
        action = 'warned';
      }
      const finalize = next.stopped && (!next.emergencyStopApplied || !next.stopNotified);
      return { next, result: { action, finalize } };
    });
    this.options.guard?.invalidate();
    if (decision.action === 'resumed') await this.send({ kind: 'budget-resumed' });
    if (decision.action === 'warned') await this.send({ kind: 'budget-warning' });
    if (decision.finalize) await this.finalizeStop();
    return { action: decision.action };
  }
  /** Emergency stop first (throws => push retried), then the single stop message. */
  private async finalizeStop() {
    await this.applyEmergencyStop();
    const claimed = await this.options.repository.update((current) => {
      if (!current?.stopped) return { result: false };
      const first = current.stopNotified !== true;
      return {
        next: { ...current, emergencyStopApplied: true, stopNotified: true },
        result: first,
      };
    });
    if (claimed) await this.send({ kind: 'budget-stop' });
  }
  /** Owner release: clears the automatic stop for this interval; the emergency stop is untouched. */
  async release(): Promise<{ released: boolean; state: BudgetState | null }> {
    const at = this.now().toISOString();
    const released = await this.options.repository.update((current) => {
      if (!current?.stopped) return { result: false };
      return {
        next: {
          ...current,
          stopped: false,
          reason: null,
          releasedAt: at,
          releasedIntervalStart: current.intervalStart,
          updatedAt: at,
        },
        result: true,
      };
    });
    this.options.guard?.invalidate();
    if (released) {
      try {
        await this.options.algorithms.recordEvent({
          id: this.newId(),
          at,
          kind: 'budget-stop-released',
          changes: [{ field: 'budgetStop', from: 'true', to: 'false' }],
        });
      } catch {
        // History is best effort here: the release itself is already stored.
      }
    }
    return { released, state: await this.options.repository.get() };
  }
  notifyReleased() {
    return this.options.notify?.({
      kind: 'setting-risk-increase',
      change: 'budget-stop-released',
    });
  }
}

// ---------------------------------------------------------------------------
// Routers.
// ---------------------------------------------------------------------------
const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });
export const BUDGET_ALERT_PATH = '/api/internal/budget-alert';

/**
 * Unauthenticated-by-session webhook. app.ts mounts it before the origin and session middlewares;
 * it is protected by the Google OIDC check instead, a strict rate limit that only counts rejected
 * calls, and its own small body limit (parsed only after the token was accepted).
 */
export function createBudgetWebhookRouter(options: {
  /** Undefined = feature off: the route answers 404 like any unknown path. */
  config?: BudgetPushConfig;
  verifier?: PushVerifier;
  service: Pick<BudgetService, 'handle'>;
}) {
  const router = Router();
  const verifier = options.verifier ?? googleOidcVerifier();
  router.post(
    BUDGET_ALERT_PATH,
    (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!options.config) return fail(res, 404, 'NOT_FOUND', '요청한 API를 찾을 수 없습니다.');
      next();
    },
    rateLimit({
      windowMs: 60 * 1000,
      limit: 20,
      // Legitimate pushes (a few per hour) never count; only rejected requests do.
      skipSuccessfulRequests: true,
      standardHeaders: false,
      legacyHeaders: false,
    }),
    async (req: Request, res: Response, next) => {
      let ok = false;
      try {
        ok = await authorizePush(req.get('authorization'), options.config!, verifier);
      } catch {
        ok = false;
      }
      // One answer for every rejection reason: no hint about which check failed.
      if (!ok) return fail(res, 401, 'UNAUTHORIZED', '인증하지 못했습니다.');
      next();
    },
    express.json({ limit: '16kb', type: 'application/json' }),
    async (req: Request, res: Response) => {
      const update = parseBudgetMessage(req.body);
      if (!update) return fail(res, 400, 'INVALID_MESSAGE', '메시지 형식이 올바르지 않습니다.');
      try {
        await options.service.handle(update);
      } catch {
        // Not acknowledged: Pub/Sub retries, and the stored state makes the retry idempotent.
        return fail(res, 500, 'BUDGET_HANDLER_FAILED', '요청을 처리하지 못했습니다.');
      }
      res.sendStatus(204);
    },
  );
  return router;
}

const publicState = (state: BudgetState | null) => ({
  stopped: state?.stopped === true,
  reason: state?.stopped ? (state.reason ?? 'budget') : null,
  costAmount: state?.costAmount ?? null,
  budgetAmount: state?.budgetAmount ?? null,
  currency: state?.currency ?? null,
  intervalStart: state?.intervalStart ?? null,
  warned:
    state?.warnedIntervalStart !== undefined && state.warnedIntervalStart === state.intervalStart,
  stoppedAt: state?.stoppedAt ?? null,
  releasedAt: state?.releasedAt ?? null,
  updatedAt: state?.updatedAt || null,
});

/** Owner-only state and release. Mounted after authentication and the same-origin check. */
export function createBudgetRouter(options: {
  service: BudgetService;
  algorithms: Pick<AlgorithmRepository, 'getControl'>;
  ownerUserId: string | undefined;
  /** True when the Pub/Sub webhook is configured (BUDGET_PUSH_* set). */
  enabled: boolean;
}) {
  const router = Router();
  router.use('/api/ops', ownerGate(options.ownerUserId));
  router.get('/api/ops/budget', async (_req, res) => {
    try {
      const [state, control] = await Promise.all([
        options.service.repository.get(),
        options.algorithms.getControl(),
      ]);
      res.json({
        budget: publicState(state),
        emergencyStop: control.emergencyStop,
        enabled: options.enabled,
      });
    } catch {
      fail(res, 503, 'BUDGET_UNAVAILABLE', '월 예산 상태를 불러오지 못했습니다.');
    }
  });
  router.post('/api/ops/budget/release', async (_req, res) => {
    let result: Awaited<ReturnType<BudgetService['release']>>;
    try {
      result = await options.service.release();
    } catch {
      return fail(res, 503, 'BUDGET_UNAVAILABLE', '월 예산 정지를 해제하지 못했습니다.');
    }
    if (!result.released)
      return fail(res, 409, 'BUDGET_NOT_STOPPED', '월 예산 정지가 걸려 있지 않습니다.');
    const outcome = await options.service.notifyReleased();
    let emergencyStop = true;
    try {
      emergencyStop = (await options.algorithms.getControl()).emergencyStop;
    } catch {
      // Unknown: the screen keeps telling the owner to check the emergency stop.
    }
    res.json({
      budget: publicState(result.state),
      emergencyStop,
      notification: outcome
        ? {
            status: outcome.status,
            ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
          }
        : { status: 'disabled', failureCode: 'NOT_CONFIGURED' },
    });
  });
  return router;
}
