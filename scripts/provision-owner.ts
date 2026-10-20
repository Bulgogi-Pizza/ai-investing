// One-time owner bootstrap. Uses only the explicitly authorized personal gcloud identity.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { hashPassword, normalizeEmail, validCredentials } from '../src/server/auth.js';

const config = JSON.parse(readFileSync(resolve('.local/deployment.json'), 'utf8'));
if (config.personalOnly !== true || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.project))
  throw new Error('Authorized personal deployment configuration required');
const email = normalizeEmail(config.account);
const password = randomBytes(32).toString('base64url');
if (!validCredentials(email, password)) throw new Error('Valid personal account required');
const destination = resolve('.local/owner-access.json');
if (existsSync(destination))
  throw new Error('Owner access file already exists; refusing duplicate bootstrap');
const token = execFileSync(
  'gcloud',
  ['auth', 'print-access-token', `--account=${config.account}`],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
).trim();
const id = randomUUID();
const hash = await hashPassword(password);
const base = `projects/${config.project}/databases/(default)/documents`;
const text = (value: string) => ({ stringValue: value });
const writes = [
  {
    update: {
      name: `${base}/userEmails/${Buffer.from(email).toString('base64url')}`,
      fields: { userId: text(id) },
    },
    currentDocument: { exists: false },
  },
  {
    update: {
      name: `${base}/users/${id}`,
      fields: {
        id: text(id),
        email: text(email),
        passwordHash: text(hash),
        role: text('admin'),
        active: { booleanValue: true },
        version: { integerValue: '1' },
      },
    },
    currentDocument: { exists: false },
  },
];
const access = {
  email,
  password,
  userId: id,
  project: config.project,
  createdAt: new Date().toISOString(),
  provisioningStatus: 'pending',
};
// Preserve recovery material before the network call: a timeout may follow a successful commit.
writeFileSync(destination, JSON.stringify(access, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const response = await fetch(`https://firestore.googleapis.com/v1/${base}:commit`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ writes }),
  signal: AbortSignal.timeout(30_000),
  redirect: 'error',
});
if (!response.ok)
  throw new Error(
    `Owner bootstrap was not confirmed (HTTP${response.status}). No credentials were printed. Check account existence before retrying.`,
  );
writeFileSync(
  destination,
  JSON.stringify({ ...access, provisioningStatus: 'created' }, null, 2) + '\n',
  { mode: 0o600 },
);
console.log(
  'Owner account created. Initial access is stored only in ignored .local/owner-access.json with permissions0600.',
);
