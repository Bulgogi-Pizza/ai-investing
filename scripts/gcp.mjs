// Cloud operations use the user-designated personal identity, never CLI defaults.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execGcloudSync } from './gcloud-command.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(root, '.local/deployment.json');
if (!existsSync(configPath))
  throw new Error(
    'Create ignored .local/deployment.json with the user-authorized personal account and project.',
  );
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (
  config.personalOnly !== true ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.account) ||
  !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.project)
)
  throw new Error('Invalid personal deployment identity configuration.');
const action = process.argv[2];
if (!['doctor', 'init', 'plan', 'apply'].includes(action) || process.argv.length !== 3)
  throw new Error('Usage: node scripts/gcp.mjs doctor|init|plan|apply');
const gcloud = (args) =>
  execGcloudSync(
    [
      ...args,
      `--account=${config.account}`,
      `--project=${config.project}`,
      `--billing-project=${config.project}`,
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  ).trim();
const billingEnabled = () =>
  gcloud(['billing', 'projects', 'describe', config.project, '--format=value(billingEnabled)']) ===
  'True';
if (action === 'doctor') {
  console.log(`Personal project: ${config.project}; billing enabled: ${billingEnabled()}`);
  process.exit(0);
}
const infra = resolve(root, 'infra/gcp');
const plan = resolve(root, '.local/gcp.plan');
const backendPath = resolve(root, '.local/gcs-backend.hcl');
if (action === 'init') {
  // State must live in the designated personal project's bucket, never one chosen elsewhere.
  const lines = existsSync(backendPath)
    ? readFileSync(backendPath, 'utf8').trim().split(/\r?\n/)
    : [];
  if (
    lines.length !== 2 ||
    lines[0].trim() !== `bucket = "${config.project}-tfstate"` ||
    lines[1].trim() !== 'prefix = "infra/gcp"'
  )
    throw new Error(
      'Create ignored .local/gcs-backend.hcl with bucket = "<project>-tfstate" and prefix = "infra/gcp".',
    );
}
if (action === 'apply') {
  if (!billingEnabled())
    throw new Error(
      'Billing is disabled. Link an active PERSONAL billing account before resource creation.',
    );
  const parsed = JSON.parse(
    execFileSync('terraform', ['show', '-json', plan], {
      cwd: infra,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
  if (parsed.variables?.project_id?.value !== config.project)
    throw new Error(
      'Plan project does not match authorized personal project. Generate a fresh plan.',
    );
}
// Access token is memory-only; never print, write to a file or pass as a process argument.
const token = gcloud(['auth', 'print-access-token']);
const args =
  action === 'init'
    ? ['init', '-input=false', `-backend-config=${backendPath}`]
    : action === 'plan'
      ? ['plan', '-input=false', `-var=project_id=${config.project}`, `-out=${plan}`]
      : ['apply', '-input=false', plan];
const result = spawnSync('terraform', args, {
  cwd: infra,
  stdio: 'inherit',
  env: { ...process.env, GOOGLE_OAUTH_ACCESS_TOKEN: token },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
