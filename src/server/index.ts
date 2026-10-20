import { FirestoreCalendarRepository, MemoryCalendarRepository } from './calendar.js';
import { tossFromEnvironment } from './toss.js';
import { createApp } from './app.js';
import { FirestoreStore, MemoryStore } from './store.js';
import { hashPassword, normalizeEmail, validCredentials } from './auth.js';
const production = process.env.NODE_ENV === 'production';
if (production && !process.env.GOOGLE_CLOUD_PROJECT)
  throw new Error('GOOGLE_CLOUD_PROJECT required');
if (production && (process.env.ADMIN_EMAIL || process.env.ADMIN_PASSWORD))
  throw new Error('Use provisioning script instead of bootstrap credentials in production');
const store = production ? new FirestoreStore() : new MemoryStore();
if (!production && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  if (!validCredentials(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD))
    throw new Error('Invalid development bootstrap credentials');
  await store.createUser({
    email: normalizeEmail(process.env.ADMIN_EMAIL),
    passwordHash: await hashPassword(process.env.ADMIN_PASSWORD),
    role: 'admin',
    active: true,
    version: 1,
  });
}
const app = createApp({
  store,
  production,
  staticDirectory: 'dist',
  toss: tossFromEnvironment(production),
  calendarRepository: production
    ? new FirestoreCalendarRepository()
    : new MemoryCalendarRepository(),
});
const port = Number(process.env.PORT ?? 8080);
app.listen(port, '0.0.0.0', () => console.info(`Application listening on port ${port}`));
