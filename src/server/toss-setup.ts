import { pathToFileURL } from 'node:url';
import { Firestore } from '@google-cloud/firestore';
import { GoogleAuth } from 'google-auth-library';
import { FirestoreTokenCache, ProviderError, TossClient } from './toss.js';

const SECRET = 'investing-toss-account-seq';
const SAFE_PROVIDER_CODES = new Set([
  'PROVIDER_ACCESS_DENIED',
  'PROVIDER_ACCOUNT_UNAVAILABLE',
  'PROVIDER_ACCOUNT_SELECTION_REQUIRED',
  'PROVIDER_SCHEMA_INVALID',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNREACHABLE',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TOKEN_BUSY',
  'PROVIDER_TOKEN_COOLDOWN',
]);
class SetupError extends Error {
  constructor(public code: 'TOSS_SETUP_FAILED' | 'TOSS_SETUP_SECRET_STORE_FAILED') {
    super(code);
  }
}
const failure = () => new SetupError('TOSS_SETUP_FAILED');
export function safeSetupFailureCode(error: unknown): string {
  if (error instanceof SetupError) return error.code;
  if (error instanceof ProviderError && SAFE_PROVIDER_CODES.has(error.code)) return error.code;
  return 'TOSS_SETUP_FAILED';
}
export function setupConfiguration(env: NodeJS.ProcessEnv) {
  const project = env.GOOGLE_CLOUD_PROJECT;
  if (
    env.NODE_ENV !== 'production' ||
    !env.CLOUD_RUN_JOB ||
    !project ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) ||
    !env.TOSS_CLIENT_ID ||
    !env.TOSS_CLIENT_SECRET
  )
    throw failure();
  return { project, clientId: env.TOSS_CLIENT_ID, clientSecret: env.TOSS_CLIENT_SECRET };
}
export async function storeAccountSeq(
  project: string,
  accountSeq: string,
  getAccessToken: () => Promise<string | null>,
  transport: typeof fetch = fetch,
) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) || !/^[1-9]\d{0,14}$/.test(accountSeq))
    throw failure();
  try {
    const token = await getAccessToken();
    if (!token) throw failure();
    const response = await transport(
      `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${SECRET}:addVersion`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: { data: Buffer.from(accountSeq).toString('base64') } }),
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      },
    );
    // No provider/Secret Manager body is parsed or logged, including success metadata.
    await response.body?.cancel();
    if (!response.ok) throw failure();
  } catch {
    throw new SetupError('TOSS_SETUP_SECRET_STORE_FAILED');
  }
}
export async function discoverAndStore(
  discover: () => Promise<string>,
  store: (seq: string) => Promise<void>,
) {
  try {
    const seq = await discover();
    if (!/^[1-9]\d{0,14}$/.test(seq)) throw failure();
    await store(seq);
    return { accountDiscovered: true, accountSeqStored: true } as const;
  } catch (error) {
    if (error instanceof ProviderError && SAFE_PROVIDER_CODES.has(error.code)) throw error;
    if (error instanceof SetupError) throw error;
    throw failure();
  }
}
export async function runTossSetup(env: NodeJS.ProcessEnv = process.env) {
  const config = setupConfiguration(env);
  const db = new Firestore({ projectId: config.project });
  const client = new TossClient(
    { ...config, accountSeq: '0', ownerUserId: 'setup-discovery' },
    new FirestoreTokenCache(config.clientId, db),
  );
  const auth = new GoogleAuth({
    projectId: config.project,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  try {
    return await discoverAndStore(
      () => client.discoverBrokerageAccountSeq(),
      (seq) =>
        storeAccountSeq(config.project, seq, async () => (await auth.getAccessToken()) ?? null),
    );
  } finally {
    await db.terminate();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTossSetup()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error: unknown) => {
      console.error(JSON.stringify({ code: safeSetupFailureCode(error) }));
      process.exitCode = 1;
    });
}
