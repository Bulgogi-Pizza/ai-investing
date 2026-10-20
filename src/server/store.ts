import { randomUUID } from 'node:crypto';
import { Firestore, Timestamp } from '@google-cloud/firestore';

export type User = {
  id: string;
  email: string;
  passwordHash: string;
  role: 'admin' | 'member';
  active: boolean;
  version: number;
};
export type Session = { userId: string; userVersion: number; expiresAt: number };
export type Strategy = {
  name: string;
  horizon: string;
  benchmark: string;
  riskTolerance: 'low' | 'medium' | 'high';
  targetAllocations: { asset: string; percentage: number }[];
  notes: string;
};
export interface Store {
  findUser(email: string): Promise<User | null>;
  listUsers(): Promise<User[]>;
  getUser(id: string): Promise<User | null>;
  createUser(user: Omit<User, 'id'>): Promise<User>;
  revokeUser(id: string): Promise<boolean>;
  putSession(hash: string, session: Session): Promise<void>;
  getSession(hash: string): Promise<Session | null>;
  deleteSession(hash: string): Promise<void>;
  getStrategy(userId: string): Promise<Strategy | null>;
  putStrategy(userId: string, strategy: Strategy): Promise<void>;
}
export class MemoryStore implements Store {
  private users = new Map<string, User>();
  private sessions = new Map<string, Session>();
  private strategies = new Map<string, Strategy>();
  async listUsers() {
    return structuredClone(
      [...this.users.values()].sort((a, b) => a.email.localeCompare(b.email)).slice(0, 100),
    );
  }
  async findUser(email: string) {
    return structuredClone([...this.users.values()].find((u) => u.email === email) ?? null);
  }
  async getUser(id: string) {
    return structuredClone(this.users.get(id) ?? null);
  }
  async createUser(input: Omit<User, 'id'>) {
    if ([...this.users.values()].some((u) => u.email === input.email))
      throw new Error('Duplicate user');
    const user = { ...input, id: randomUUID() };
    this.users.set(user.id, structuredClone(user));
    return user;
  }
  async revokeUser(id: string) {
    const user = this.users.get(id);
    if (!user) return false;
    user.active = false;
    user.version++;
    return true;
  }
  async putSession(hash: string, session: Session) {
    this.sessions.set(hash, session);
  }
  async getSession(hash: string) {
    const session = this.sessions.get(hash);
    if (session && session.expiresAt <= Date.now()) {
      this.sessions.delete(hash);
      return null;
    }
    return session ?? null;
  }
  async deleteSession(hash: string) {
    this.sessions.delete(hash);
  }
  async getStrategy(id: string) {
    return structuredClone(this.strategies.get(id) ?? null);
  }
  async putStrategy(id: string, strategy: Strategy) {
    this.strategies.set(id, structuredClone(strategy));
  }
}
export class FirestoreStore implements Store {
  constructor(private db = new Firestore()) {}
  async listUsers() {
    const result = await this.db.collection('users').orderBy('email').limit(100).get();
    return result.docs.map((doc) => doc.data() as User);
  }
  async findUser(email: string) {
    const results = await this.db.collection('users').where('email', '==', email).limit(1).get();
    return results.empty ? null : (results.docs[0].data() as User);
  }
  async getUser(id: string) {
    const doc = await this.db.collection('users').doc(id).get();
    return doc.exists ? (doc.data() as User) : null;
  }
  async createUser(input: Omit<User, 'id'>) {
    const user = { ...input, id: randomUUID() };
    // Email reservation and account creation are atomic, including concurrent bootstrap requests.
    const key = Buffer.from(input.email).toString('base64url');
    await this.db.runTransaction(async (tx) => {
      const reservation = this.db.collection('userEmails').doc(key);
      if ((await tx.get(reservation)).exists) throw new Error('Duplicate user');
      tx.create(reservation, { userId: user.id });
      tx.create(this.db.collection('users').doc(user.id), user);
    });
    return user;
  }
  async revokeUser(id: string) {
    return this.db.runTransaction(async (tx) => {
      const ref = this.db.collection('users').doc(id);
      const doc = await tx.get(ref);
      if (!doc.exists) return false;
      tx.update(ref, { active: false, version: (doc.data()?.version ?? 0) + 1 });
      return true;
    });
  }
  async putSession(hash: string, session: Session) {
    await this.db
      .collection('sessions')
      .doc(hash)
      .set({ ...session, ttlAt: Timestamp.fromMillis(session.expiresAt) });
  }
  async getSession(hash: string) {
    const doc = await this.db.collection('sessions').doc(hash).get();
    return doc.exists ? (doc.data() as Session) : null;
  }
  async deleteSession(hash: string) {
    await this.db.collection('sessions').doc(hash).delete();
  }
  async getStrategy(id: string) {
    const doc = await this.db.collection('strategies').doc(id).get();
    return doc.exists ? (doc.data() as Strategy) : null;
  }
  async putStrategy(id: string, strategy: Strategy) {
    await this.db.collection('strategies').doc(id).set(strategy);
  }
}
