import { createHash } from 'node:crypto';
import { Firestore, Timestamp } from '@google-cloud/firestore';

const WINDOW_MS = 15 * 60 * 1000;
const LIMITS = [10, 5] as const;
type Counter = { count: number; resetAt: number };
export type LoginAttempt = { allowed: boolean; retryAfter: number };
export interface LoginThrottle {
  consume(ip: string, email: string): Promise<LoginAttempt>;
}
function keys(ip: string, email: string) {
  if (!ip || ip.length > 128 || !email || email.length > 254)
    throw new Error('Invalid throttle input');
  return [`ip:${ip}`, `email:${email.trim().toLowerCase()}`].map((value) =>
    createHash('sha256').update(value).digest('hex'),
  );
}
function currentCounter(value: unknown, now: number): Counter {
  if (!value) return { count: 0, resetAt: now + WINDOW_MS };
  const counter = value as Counter;
  if (
    !Number.isSafeInteger(counter.count) ||
    counter.count < 0 ||
    !Number.isFinite(counter.resetAt)
  )
    throw new Error('Invalid throttle state');
  return counter.resetAt <= now ? { count: 0, resetAt: now + WINDOW_MS } : counter;
}
function result(counters: Counter[], now: number): LoginAttempt {
  const blocked = counters.filter((counter, index) => counter.count >= LIMITS[index]);
  return {
    allowed: blocked.length === 0,
    retryAfter: blocked.length
      ? Math.max(
          1,
          Math.ceil((Math.max(...blocked.map((counter) => counter.resetAt)) - now) / 1000),
        )
      : 0,
  };
}
export class MemoryLoginThrottle implements LoginThrottle {
  private counters = new Map<string, Counter>();
  constructor(private clock: () => number = Date.now) {}
  async consume(ip: string, email: string) {
    const now = this.clock();
    const ids = keys(ip, email);
    const counters = ids.map((id) => currentCounter(this.counters.get(id), now));
    const attempt = result(counters, now);
    if (!attempt.allowed) return attempt;
    if (this.counters.size >= 20000) {
      for (const [id, counter] of this.counters)
        if (counter.resetAt <= now) this.counters.delete(id);
      if (this.counters.size >= 20000) throw new Error('Throttle capacity exceeded');
    }
    ids.forEach((id, index) =>
      this.counters.set(id, { ...counters[index], count: counters[index].count + 1 }),
    );
    return attempt;
  }
}
export class FirestoreLoginThrottle implements LoginThrottle {
  constructor(
    private db = new Firestore(),
    private clock: () => number = Date.now,
  ) {}
  async consume(ip: string, email: string) {
    const refs = keys(ip, email).map((id) => this.db.collection('loginAttempts').doc(id));
    return this.db.runTransaction(async (tx) => {
      const snapshots = await tx.getAll(...refs);
      const now = this.clock();
      const counters = snapshots.map((snapshot) => currentCounter(snapshot.data(), now));
      const attempt = result(counters, now);
      if (!attempt.allowed) return attempt;
      refs.forEach((ref, index) => {
        const counter = counters[index];
        tx.set(ref, {
          count: counter.count + 1,
          resetAt: counter.resetAt,
          ttlAt: Timestamp.fromMillis(counter.resetAt),
        });
      });
      return attempt;
    });
  }
}
