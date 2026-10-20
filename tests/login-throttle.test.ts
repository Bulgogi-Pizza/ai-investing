import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Firestore } from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import { FirestoreLoginThrottle, MemoryLoginThrottle } from '../src/server/login-throttle';
import { MemoryStore } from '../src/server/store';
import { createApp } from '../src/server/app';
import { hashPassword } from '../src/server/auth';
function fakeFirestore() {
  const documents = new Map<string, Record<string, unknown>>();
  let tail: Promise<unknown> = Promise.resolve();
  const db = {
    collection: (name: string) => ({ doc: (id: string) => `${name}/${id}` }),
    runTransaction: (run: (tx: unknown) => Promise<unknown>) => {
      const next = tail.then(() =>
        run({
          getAll: async (...refs: string[]) =>
            refs.map((ref) => ({ data: () => documents.get(ref) })),
          set: (ref: string, value: Record<string, unknown>) => documents.set(ref, value),
        }),
      );
      tail = next.catch(() => undefined);
      return next;
    },
  } as unknown as Firestore;
  return { db, documents };
}
describe('persistent login attempt protection', () => {
  it('enforces atomic IP and normalized-email limits across independent instances and expiry', async () => {
    const { db, documents } = fakeFirestore();
    let now = 1000000;
    const first = new FirestoreLoginThrottle(db, () => now);
    const second = new FirestoreLoginThrottle(db, () => now);
    const attempts = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        (i % 2 ? first : second).consume(
          `192.0.2.${i}`,
          i % 2 ? 'OWNER@EXAMPLE.TEST' : 'owner@example.test',
        ),
      ),
    );
    expect(attempts.filter((result) => result.allowed)).toHaveLength(5);
    expect(attempts[5].retryAfter).toBe(900);
    for (const [key, value] of documents) {
      expect(key).toMatch(/^loginAttempts\/[a-f0-9]{64}$/);
      expect(JSON.stringify(value)).not.toContain('owner@');
      expect(JSON.stringify(value)).not.toContain('192.0.2');
      expect(value.ttlAt).toBeInstanceOf(Timestamp);
    }
    now += 900001;
    expect((await second.consume('192.0.2.9', 'owner@example.test')).allowed).toBe(true);
    for (let i = 0; i < 10; i++)
      expect((await first.consume('192.0.2.100', `different${i}@example.test`)).allowed).toBe(true);
    expect((await second.consume('192.0.2.100', 'last@example.test')).allowed).toBe(false);
  });
  it('retains a budget across apps/restarts and different IPs; successful logins count too', async () => {
    const { db } = fakeFirestore();
    const store = new MemoryStore();
    const password = 'fixture long password';
    const email = 'owner@example.test';
    await store.createUser({
      email,
      passwordHash: await hashPassword(password),
      role: 'member',
      active: true,
      version: 1,
    });
    const first = createApp({
      store,
      production: true,
      origin: 'https://example.test',
      loginThrottle: new FirestoreLoginThrottle(db),
    });
    const second = createApp({
      store,
      production: true,
      origin: 'https://example.test',
      loginThrottle: new FirestoreLoginThrottle(db),
    });
    for (let i = 0; i < 5; i++)
      expect(
        (
          await request(i % 2 ? first : second)
            .post('/api/auth/login')
            .set('Origin', 'https://example.test')
            .set('X-Forwarded-For', `192.0.2.${i}`)
            .send({ email, password })
        ).status,
      ).toBe(200);
    const blocked = await request(second)
      .post('/api/auth/login')
      .set('Origin', 'https://example.test')
      .set('X-Forwarded-For', '192.0.2.99')
      .send({ email: 'OWNER@EXAMPLE.TEST', password });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(
      (
        await request(first)
          .post('/api/auth/login')
          .set('Origin', 'https://example.test')
          .set('X-Forwarded-For', '192.0.2.99')
          .send({ email: 'other@example.test', password })
      ).status,
    ).toBe(401);
  });
  it('fails closed before account lookup when shared storage fails', async () => {
    const store = new MemoryStore();
    const lookup = vi.spyOn(store, 'findUser');
    const app = createApp({
      store,
      loginThrottle: {
        consume: async () => {
          throw new Error('private storage details');
        },
      },
    });
    const response = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://127.0.0.1:5173')
      .send({ email: 'owner@example.test', password: 'fixture lengthy password' });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('LOGIN_PROTECTION_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toContain('private storage');
    expect(lookup).not.toHaveBeenCalled();
  });
  it('memory development implementation uses the same window and thresholds', async () => {
    let now = 0;
    const limiter = new MemoryLoginThrottle(() => now);
    for (let i = 0; i < 5; i++)
      expect((await limiter.consume(`ip${i}`, 'owner@example.test')).allowed).toBe(true);
    expect((await limiter.consume('another', 'owner@example.test')).allowed).toBe(false);
    now = 900001;
    expect((await limiter.consume('another', 'owner@example.test')).allowed).toBe(true);
  });
});
