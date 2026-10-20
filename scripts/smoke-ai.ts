// One explicitly authorized transport smoke test using PUBLIC SYNTHETIC inputs.
// Never load account holdings, user credentials, or default/company ADC here.
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MemoryAiQuota, VertexAiEnricher, type AiRules } from '../src/server/ai.js';

async function main() {
  const deployment = JSON.parse(await readFile('.local/deployment.json', 'utf8'));
  const designation = await readFile('.local/deployment-account.md', 'utf8');
  if (
    deployment.personalOnly !== true ||
    typeof deployment.account !== 'string' ||
    typeof deployment.project !== 'string' ||
    !designation.includes(deployment.account) ||
    !designation.includes(deployment.project)
  )
    throw new Error('Personal identity designation required');
  const model = 'gemini-3.1-flash-lite';
  const { stdout } = await promisify(execFile)(
    'gcloud',
    [
      'auth',
      'print-access-token',
      `--account=${deployment.account}`,
      `--project=${deployment.project}`,
      `--billing-project=${deployment.project}`,
      '--quiet',
    ],
    {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 32768,
      env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' },
    },
  );
  const token = stdout.trim();
  if (!token) throw new Error('Personal token unavailable');
  const now = new Date().toISOString();
  // dataMode satisfies the production rules interface only; every source below
  // explicitly identifies synthetic input. This object is never served to users.
  const fixture = {
    engine: 'rules-v1',
    dataMode: 'live',
    period: 'daily',
    symbol: '005930',
    horizon: { tradingDays: 1, calendarDays: 1 },
    strategy: {
      name: 'PUBLIC SYNTHETIC SMOKE',
      horizon: '5년',
      benchmark: 'PUBLIC SYNTHETIC',
      riskTolerance: 'medium',
      targetAllocations: [
        { asset: '주식', percentage: 60 },
        { asset: '채권', percentage: 40 },
      ],
      notes: 'SYNTHETIC ONLY',
    },
    metrics: { returnPercent: 0, sma20: 100, rsi14: 50, latestClose: 100, latestTimestamp: now },
    decision: {
      action: 'hold-plan',
      title: 'PUBLIC SYNTHETIC SMOKE',
      thresholdPercent: 4,
      rationale: 'Transport test only, not an investment recommendation',
    },
    evidence: {
      market: {
        source: 'PUBLIC SYNTHETIC SMOKE FIXTURE; NOT LIVE FINANCIAL DATA',
        asOf: now,
        symbol: '005930',
        interval: '1d',
        adjusted: true,
        candles: [],
      },
      calendar: {
        from: now.slice(0, 10),
        to: now.slice(0, 10),
        source: 'admin-curated',
        events: [],
        truncated: false,
        coverageWarning: 'PUBLIC SYNTHETIC TRANSPORT TEST ONLY',
        relevanceRule: 'No real events used',
        excludedCount: 0,
      },
    },
  } as AiRules;
  // Exactly one generation attempt; no production quota bypass in application code.
  const adapter = new VertexAiEnricher(
    { project: deployment.project, model, location: 'global' },
    new MemoryAiQuota(),
    fetch,
    { getAccessToken: async () => token },
  );
  const { ai } = await adapter.enrich(fixture, 'public-synthetic-smoke');
  console.info(
    JSON.stringify({ status: ai.status, model, input: 'public-synthetic-fixture', attempts: 1 }),
  );
  if (ai.status !== 'ready') process.exitCode = 1;
}
main().catch(() => {
  console.error('AI smoke unavailable; no provider details printed.');
  process.exitCode = 1;
});
