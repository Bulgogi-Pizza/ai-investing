import { aiFromEnvironment } from './ai.js';
import { FirestoreLoginThrottle, MemoryLoginThrottle } from './login-throttle.js';
import { FirestoreCalendarRepository, MemoryCalendarRepository } from './calendar.js';
import { FirestoreMorningRunRepository, MemoryMorningRunRepository } from './morning.js';
import { FirestoreSnapshotRepository, MemorySnapshotRepository } from './snapshots.js';
import { dartFromEnvironment, secFromEnvironment } from './fundamentals/index.js';
import { tossFromEnvironment } from './toss.js';
import { createApp } from './app.js';
import { FirestoreAlgorithmRepository, MemoryAlgorithmRepository } from './algorithms.js';
import {
  FirestoreNotificationRepository,
  MemoryNotificationRepository,
  NotificationService,
  notifierFromEnvironment,
  validAppOrigin,
} from './notify.js';
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
const notificationRepository = production
  ? new FirestoreNotificationRepository()
  : new MemoryNotificationRepository();
const appOrigin = process.env.APP_ORIGIN ?? (production ? '' : 'http://127.0.0.1:5173');
// createApp rejects an invalid APP_ORIGIN in production; without a valid one nothing is sent.
const notifications = validAppOrigin(appOrigin)
  ? new NotificationService({
      repository: notificationRepository,
      notifier: notifierFromEnvironment(),
      appOrigin,
    })
  : undefined;
const app = createApp({
  store,
  production,
  ai: aiFromEnvironment(production),
  loginThrottle: production ? new FirestoreLoginThrottle() : new MemoryLoginThrottle(),
  staticDirectory: 'dist',
  toss: tossFromEnvironment(production),
  // Fundamentals providers: DART_API_KEY (secret) and SEC_USER_AGENT (contact, not secret).
  // A missing or malformed value leaves that market answering 503 instead of guessing.
  dart: dartFromEnvironment(),
  sec: secFromEnvironment(),
  // Same value the Toss client is bound to; owner-only routes fail closed when unset.
  ownerUserId: process.env.TOSS_OWNER_USER_ID,
  algorithmRepository: production
    ? new FirestoreAlgorithmRepository()
    : new MemoryAlgorithmRepository(),
  notificationRepository,
  notifications,
  calendarRepository: production
    ? new FirestoreCalendarRepository()
    : new MemoryCalendarRepository(),
  snapshotRepository: production
    ? new FirestoreSnapshotRepository()
    : new MemorySnapshotRepository(),
  morningRepository: production
    ? new FirestoreMorningRunRepository()
    : new MemoryMorningRunRepository(),
});
const port = Number(process.env.PORT ?? 8080);
app.listen(port, '0.0.0.0', () => console.info(`Application listening on port ${port}`));
