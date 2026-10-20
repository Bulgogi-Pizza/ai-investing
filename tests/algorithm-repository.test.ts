import { describe, expect, it } from 'vitest';
import {
  FirestoreAlgorithmRepository,
  MemoryAlgorithmRepository,
  type AlgorithmRepository,
} from '../src/server/algorithms';
import { defaultSignalParams } from '../src/lib/algo';
import {
  type AlgorithmEvent,
  type AlgorithmRecord,
  inputFromTemplate,
} from '../src/lib/algorithmRecords';

// Minimal in-memory stand-in for the parts of @google-cloud/firestore the repository uses.
// It enforces what matters here: no `undefined` field values and create() on an existing doc fails.
type Doc = Record<string, unknown>;
function assertNoUndefined(value: unknown, path = ''): void {
  if (value === undefined) throw new Error(`undefined field at ${path}`);
  if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) assertNoUndefined(v, `${path}.${k}`);
}
class FakeDocRef {
  constructor(
    private db: FakeDb,
    private collection: string,
    public id: string,
  ) {}
  private get store() {
    return (
      this.db.collections.get(this.collection) ??
      this.db.collections.set(this.collection, new Map()).get(this.collection)!
    );
  }
  async get() {
    const data = this.store.get(this.id);
    return { exists: data !== undefined, data: () => structuredClone(data) };
  }
  apply(kind: 'set' | 'create' | 'delete', data?: Doc) {
    if (kind === 'delete') return void this.store.delete(this.id);
    assertNoUndefined(data);
    if (kind === 'create' && this.store.has(this.id)) throw new Error('ALREADY_EXISTS');
    this.store.set(this.id, structuredClone(data!));
  }
}
class FakeQuery {
  constructor(
    private db: FakeDb,
    private collection: string,
    private order?: [string, 'asc' | 'desc'],
    private max = Infinity,
  ) {}
  limit(n: number) {
    return new FakeQuery(this.db, this.collection, this.order, n);
  }
  orderBy(field: string, direction: 'asc' | 'desc' = 'asc') {
    return new FakeQuery(this.db, this.collection, [field, direction], this.max);
  }
  doc(id: string) {
    return new FakeDocRef(this.db, this.collection, id);
  }
  async get() {
    let rows = [...(this.db.collections.get(this.collection)?.values() ?? [])];
    if (this.order) {
      const [field, direction] = this.order;
      rows.sort(
        (a, b) =>
          String(a[field]).localeCompare(String(b[field])) * (direction === 'desc' ? -1 : 1),
      );
    }
    rows = rows.slice(0, this.max);
    return { docs: rows.map((row) => ({ data: () => structuredClone(row) })) };
  }
}
class FakeDb {
  collections = new Map<string, Map<string, Doc>>();
  collection(name: string) {
    return new FakeQuery(this, name);
  }
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>) {
    const writes: (() => void)[] = [];
    const tx = {
      get: (target: FakeQuery | FakeDocRef) => target.get(),
      create: (ref: FakeDocRef, data: Doc) => writes.push(() => ref.apply('create', data)),
      set: (ref: FakeDocRef, data: Doc) => writes.push(() => ref.apply('set', data)),
      delete: (ref: FakeDocRef) => writes.push(() => ref.apply('delete')),
    };
    const result = await fn(tx);
    for (const write of writes) write();
    return result;
  }
  batch() {
    const writes: (() => void)[] = [];
    return {
      set: (ref: FakeDocRef, data: Doc) => writes.push(() => ref.apply('set', data)),
      create: (ref: FakeDocRef, data: Doc) => writes.push(() => ref.apply('create', data)),
      commit: async () => writes.forEach((write) => write()),
    };
  }
}

const record = (
  id: string,
  name: string,
  extra: Partial<AlgorithmRecord> = {},
): AlgorithmRecord => ({
  ...inputFromTemplate('momentum', 'KR'),
  name,
  targets: ['005930'],
  id,
  currency: 'KRW',
  params: structuredClone(defaultSignalParams),
  targetsChangedAt: '2026-10-21T00:00:00.000Z',
  createdAt: `2026-10-21T00:00:0${id}.000Z`,
  updatedAt: '2026-10-21T00:00:00.000Z',
  version: 1,
  ...extra,
});
const event = (
  id: string,
  at: string,
  kind: AlgorithmEvent['kind'] = 'created',
): AlgorithmEvent => ({
  id,
  at,
  kind,
  changes: [],
});

const implementations: [string, () => AlgorithmRepository][] = [
  ['memory', () => new MemoryAlgorithmRepository()],
  [
    'firestore (fake client)',
    () =>
      new FirestoreAlgorithmRepository(
        new FakeDb() as unknown as ConstructorParameters<typeof FirestoreAlgorithmRepository>[0],
      ),
  ],
];

describe.each(implementations)('algorithm repository: %s', (_name, make) => {
  it('stores, lists in creation order, updates and removes algorithms with their events', async () => {
    const repo = make();
    for (const [i, name] of ['a', 'b'].entries())
      expect(
        await repo.mutate(String(i + 1), () => ({
          write: record(String(i + 1), name),
          event: event(`e${i + 1}`, `2026-10-21T00:00:0${i + 1}.000Z`),
        })),
      ).toMatchObject({ ok: true });
    expect((await repo.list()).map((a) => a.name)).toEqual(['a', 'b']);
    expect((await repo.get('1'))?.name).toBe('a');
    expect(await repo.get('missing')).toBeNull();
    await repo.mutate('1', (current) => ({
      write: { ...current!, name: 'a2', version: 2, dualMomentum: undefined },
      event: event('e3', '2026-10-21T00:00:03.000Z', 'updated'),
    }));
    expect((await repo.get('1'))?.name).toBe('a2');
    await repo.mutate('2', () => ({
      remove: '2',
      event: event('e4', '2026-10-21T00:00:04.000Z', 'deleted'),
    }));
    expect((await repo.list()).map((a) => a.id)).toEqual(['1']);
    expect((await repo.listEvents(10)).map((e) => e.id)).toEqual(['e4', 'e3', 'e2', 'e1']);
    expect((await repo.listEvents(2)).map((e) => e.id)).toEqual(['e4', 'e3']);
  });
  it('a rejected plan writes neither the algorithm nor an event, and sees every algorithm', async () => {
    const repo = make();
    await repo.mutate('1', () => ({
      write: record('1', 'a'),
      event: event('e1', '2026-10-21T00:00:01.000Z'),
    }));
    let seen = 0;
    const result = await repo.mutate('2', (_current, all) => {
      seen = all.length;
      return { reject: { status: 409, code: 'X', message: 'no' } };
    });
    expect(result).toEqual({ ok: false, status: 409, code: 'X', message: 'no' });
    expect(seen).toBe(1);
    expect(await repo.get('2')).toBeNull();
    expect(await repo.listEvents(10)).toHaveLength(1);
  });
  it('keeps the emergency-stop flag and returns the previous value atomically with its event', async () => {
    const repo = make();
    expect(await repo.getControl()).toEqual({ emergencyStop: false, updatedAt: null });
    expect(
      await repo.setControl(
        true,
        '2026-10-21T00:00:01.000Z',
        event('s1', '2026-10-21T00:00:01.000Z', 'emergency-stop'),
      ),
    ).toBe(false);
    expect(await repo.getControl()).toEqual({
      emergencyStop: true,
      updatedAt: '2026-10-21T00:00:01.000Z',
    });
    expect(
      await repo.setControl(
        false,
        '2026-10-21T00:00:02.000Z',
        event('s2', '2026-10-21T00:00:02.000Z', 'emergency-release'),
      ),
    ).toBe(true);
    expect((await repo.listEvents(5)).map((e) => e.kind)).toEqual([
      'emergency-release',
      'emergency-stop',
    ]);
  });
  it('keeps cost settings, empty by default', async () => {
    const repo = make();
    expect(await repo.getCosts()).toEqual({
      commissionRate: null,
      sellTaxRate: null,
      capitalGainsTax: null,
      updatedAt: null,
    });
    const costs = {
      commissionRate: 0.0002,
      sellTaxRate: null,
      capitalGainsTax: { rate: 0.22, annualDeduction: 100 },
      updatedAt: '2026-10-21T00:00:00.000Z',
    };
    await repo.putCosts(costs, event('c1', '2026-10-21T00:00:00.000Z', 'costs-updated'));
    expect(await repo.getCosts()).toEqual(costs);
  });
});
