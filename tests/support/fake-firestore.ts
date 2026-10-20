// TEST SUPPORT ONLY (never imported by src/).
// ---------------------------------------------------------------------------
// A tiny in-memory Firestore with optimistic transactions (reads are validated at commit and the
// callback is re-run on conflict, like the real client). It rejects `undefined` values the way the
// real client does by default.
// ---------------------------------------------------------------------------
type Stored = { data: Record<string, unknown>; version: number };
class FakeSnapshot {
  constructor(
    readonly exists: boolean,
    private readonly value: Record<string, unknown> | undefined,
    readonly id: string,
  ) {}
  data() {
    return this.value === undefined ? undefined : structuredClone(this.value);
  }
}
function assertNoUndefined(value: unknown, path = ''): void {
  if (value === undefined) throw new Error(`Cannot use undefined as a Firestore value (${path})`);
  if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) assertNoUndefined(v, `${path}.${k}`);
}
class FakeQuery {
  constructor(
    private readonly db: FakeFirestore,
    readonly collectionName: string,
    private readonly field: string,
    private readonly op: string,
    private readonly value: unknown,
  ) {}
  async get() {
    return this.db.query(this.collectionName, this.field, this.op, this.value);
  }
}
export class FakeFirestore {
  readonly docs = new Map<string, Stored>();
  readonly collectionVersions = new Map<string, number>();
  transactionRuns = 0;
  collection(name: string) {
    return {
      doc: (id: string) => {
        if (!id || id.includes('/')) throw new Error('Invalid document id');
        return new FakeRef(this, `${name}/${id}`);
      },
      where: (field: string, op: string, value: unknown) =>
        new FakeQuery(this, name, field, op, value),
    };
  }
  query(name: string, field: string, op: string, value: unknown) {
    return {
      docs: [...this.docs.entries()]
        .filter(([path]) => path.startsWith(`${name}/`))
        .filter(([, s]) =>
          op === '==' ? s.data[field] === value : (value as unknown[]).includes(s.data[field]),
        )
        .map(([path, s]) => new FakeSnapshot(true, s.data, path.split('/')[1])),
    };
  }
  snapshot(path: string) {
    const s = this.docs.get(path);
    return new FakeSnapshot(!!s, s?.data, path.split('/')[1]);
  }
  version(path: string) {
    if (path.startsWith('col:')) return this.collectionVersions.get(path) ?? 0;
    return this.docs.get(path)?.version ?? 0;
  }
  private bump(path: string) {
    const key = `col:${path.split('/')[0]}`;
    this.collectionVersions.set(key, (this.collectionVersions.get(key) ?? 0) + 1);
  }
  write(path: string, data: Record<string, unknown>, merge = false, create = false) {
    assertNoUndefined(data, path);
    const current = this.docs.get(path);
    if (create && current) throw new Error('ALREADY_EXISTS');
    this.docs.set(path, {
      data:
        merge && current ? { ...current.data, ...structuredClone(data) } : structuredClone(data),
      version: (current?.version ?? 0) + 1,
    });
    this.bump(path);
  }
  delete(path: string) {
    const current = this.docs.get(path);
    this.docs.delete(path);
    // Deleted documents keep counting as "changed" for optimistic concurrency.
    this.docs.size; // no-op
    this.deleted.set(path, (current?.version ?? this.deleted.get(path) ?? 0) + 1);
    this.bump(path);
  }
  readonly deleted = new Map<string, number>();
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 10; attempt++) {
      this.transactionRuns++;
      const reads = new Map<string, number>();
      const writes: Array<() => void> = [];
      const tx = {
        get: async (target: FakeRef | FakeQuery) => {
          // Read first, then yield: concurrent transactions all see the same starting state.
          let result: unknown;
          if (target instanceof FakeQuery) {
            const key = `col:${target.collectionName}`;
            reads.set(key, this.version(key));
            result = await target.get();
          } else {
            reads.set(target.path, this.version(target.path));
            result = this.snapshot(target.path);
          }
          await new Promise((r) => setTimeout(r, 0));
          return result;
        },
        set: (ref: FakeRef, data: Record<string, unknown>, options?: { merge?: boolean }) => {
          assertNoUndefined(data);
          writes.push(() => this.write(ref.path, data, options?.merge));
        },
        create: (ref: FakeRef, data: Record<string, unknown>) => {
          assertNoUndefined(data);
          writes.push(() => this.write(ref.path, data, false, true));
        },
        delete: (ref: FakeRef) => {
          writes.push(() => this.delete(ref.path));
        },
      };
      const result = await fn(tx);
      if ([...reads].some(([path, v]) => this.version(path) !== v)) continue; // conflict: retry
      writes.forEach((w) => w());
      return result;
    }
    throw new Error('Too much contention');
  }
}
class FakeRef {
  constructor(
    private readonly db: FakeFirestore,
    readonly path: string,
  ) {}
  async get() {
    return this.db.snapshot(this.path);
  }
  async set(data: Record<string, unknown>, options?: { merge?: boolean }) {
    this.db.write(this.path, data, options?.merge);
  }
}
