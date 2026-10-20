// Execute only from an authorized administrator environment with ADC and least-privilege IAM.
import { FirestoreStore } from '../src/server/store.js';
import { hashPassword, normalizeEmail, validCredentials } from '../src/server/auth.js';
if (!process.env.GOOGLE_CLOUD_PROJECT) throw new Error('GOOGLE_CLOUD_PROJECT required');
const email = process.env.PROVISION_ADMIN_EMAIL;
const password = process.env.PROVISION_ADMIN_PASSWORD;
if (!validCredentials(email, password))
  throw new Error('PROVISION_ADMIN_EMAIL and a 12–256 character PROVISION_ADMIN_PASSWORD required');
const store = new FirestoreStore();
await store.createUser({
  email: normalizeEmail(email),
  passwordHash: await hashPassword(password!),
  role: 'admin',
  active: true,
  version: 1,
});
console.info('Administrator provisioned. Clear provisioning environment variables.');
