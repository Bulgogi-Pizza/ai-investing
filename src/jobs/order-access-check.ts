import { pathToFileURL } from 'node:url';
import { Firestore } from '@google-cloud/firestore';
import { checkOrderAccess, type OrderAccessReport } from '../server/trading/access-check.js';
import { FirestoreTradingStore } from '../server/trading/firestore-store.js';
import type { AccessCheckStatus, TradingStatusStore } from '../server/trading/stores.js';
import { TossOrderClient, type TossOrderReads } from '../server/trading/toss-orders.js';
import { TossOrderTransport } from '../server/trading/toss-transport.js';
import { FirestoreTokenCache, TossClient, type TossConfig } from '../server/toss.js';
import {
  JobConfigError,
  runJob,
  safeErrorCode,
  type JobLogger,
  type JobOutcome,
} from './runner.js';
import { budgetJobGate } from './budget-gate.js';

/**
 * One-off, READ-ONLY order-API access check (design "주문 권한 확인" step 1, plan stage 7e).
 *
 * It calls only `GET /buying-power` (KRW and USD), `GET /commissions` and `GET /orders?status=OPEN`
 * through the fixed-egress-IP job network, and nothing else: no order is created or cancelled, and
 * the order client's write methods are not even reachable from here (the dependency type is
 * `Pick<TossOrderReads, ...>`; a static test keeps every write path out of this file). Nothing from a
 * response body is kept, logged or printed: the log carries booleans as a status word and sanitized
 * upper-snake codes, and the stored status (read by the live-enable panel) has the same content.
 *
 * Run it by hand (docs/operations/jobs.md):
 *   gcloud run jobs execute investing-order-access-check --project=PROJECT --region=REGION --wait
 */
export const JOB_NAME = 'order-access-check';

export type OrderAccessCheckDependencies = {
  client: Pick<TossOrderReads, 'getBuyingPower' | 'getCommissions' | 'listOrders'>;
  status: Pick<TradingStatusStore, 'putAccessCheck'>;
  now?: () => Date;
  log: JobLogger;
};

/** `forbidden` -> `FORBIDDEN`, `http-403` -> `HTTP_403`: the log-safe code alphabet. */
const logCode = (code: string | undefined) => {
  const converted = (code ?? 'CHECK_ERROR').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(converted) ? converted : 'CHECK_ERROR';
};

export function statusOf(report: OrderAccessReport): AccessCheckStatus {
  return {
    checkedAt: report.checkedAt,
    allOk: report.allOk,
    permissionDenied: report.permissionDenied,
    probes: {
      buyingPowerKrw: report.buyingPowerKrw,
      buyingPowerUsd: report.buyingPowerUsd,
      commissions: report.commissions,
      openOrders: report.openOrders,
    },
  };
}

export async function runOrderAccessCheck(deps: OrderAccessCheckDependencies): Promise<JobOutcome> {
  const report = await checkOrderAccess(deps.client, deps.now);
  const probes = [
    report.buyingPowerKrw,
    report.buyingPowerUsd,
    report.commissions,
    report.openOrders,
  ];
  const codes: Record<string, number> = {};
  for (const p of probes) if (!p.ok) codes[logCode(p.code)] = (codes[logCode(p.code)] ?? 0) + 1;
  deps.log.info('access-checked', {
    status: report.allOk ? 'all-ok' : report.permissionDenied ? 'denied' : 'failed',
    ok: probes.filter((p) => p.ok).length,
    failed: probes.filter((p) => !p.ok).length,
    ...(Object.keys(codes).length ? { codes } : {}),
  });
  try {
    await deps.status.putAccessCheck(statusOf(report));
  } catch (error) {
    deps.log.error('status-write-failed', { code: safeErrorCode(error) });
    return 'failed';
  }
  return report.allOk ? 'ok' : 'failed';
}

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export function jobConfiguration(env: NodeJS.ProcessEnv): { project: string; toss: TossConfig } {
  const project = env.GOOGLE_CLOUD_PROJECT;
  const { TOSS_CLIENT_ID, TOSS_CLIENT_SECRET, TOSS_ACCOUNT_SEQ, TOSS_OWNER_USER_ID } = env;
  if (
    env.NODE_ENV !== 'production' ||
    !env.CLOUD_RUN_JOB ||
    !project ||
    !PROJECT.test(project) ||
    !TOSS_CLIENT_ID ||
    !TOSS_CLIENT_SECRET ||
    !TOSS_ACCOUNT_SEQ ||
    !/^\d{1,15}$/.test(TOSS_ACCOUNT_SEQ) ||
    !TOSS_OWNER_USER_ID
  )
    throw new JobConfigError();
  return {
    project,
    toss: {
      clientId: TOSS_CLIENT_ID,
      clientSecret: TOSS_CLIENT_SECRET,
      accountSeq: TOSS_ACCOUNT_SEQ,
      ownerUserId: TOSS_OWNER_USER_ID,
    },
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env) {
  return runJob(JOB_NAME, async ({ log }) => {
    const config = jobConfiguration(env);
    const db = new Firestore({ projectId: config.project });
    try {
      const skipped = await budgetJobGate(db, log, { failClosed: false });
      if (skipped) return skipped;
      const toss = new TossClient(config.toss, new FirestoreTokenCache(config.toss.clientId, db));
      return await runOrderAccessCheck({
        // Read-only transport: the allow-list has no write path at all (defence in depth).
        client: new TossOrderClient(new TossOrderTransport(toss, { readOnly: true })),
        status: new FirestoreTradingStore(db),
        log,
      });
    } finally {
      await db.terminate();
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
