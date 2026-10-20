import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { hashPassword } from '../src/server/auth';
import { MemoryAlgorithmRepository } from '../src/server/algorithms';
import { MemoryPaperRepository, listFills, toTrade, type AlgorithmRun } from '../src/server/paper';
import { MemoryStore } from '../src/server/store';
import { createPaperLedger, runPaperDay, type PaperQuote } from '../src/lib/algo';
import { inputFromTemplate } from '../src/lib/algorithmRecords';

// Synthetic data only; no network.
const origin = 'https://invest.example.test';
const password = 'Test-only lengthy password';
let store: MemoryStore;
let ownerId: string;
let algorithms: MemoryAlgorithmRepository;
let paper: MemoryPaperRepository;

const app = (ai = false) =>
  createApp({
    store,
    origin,
    ownerUserId: ownerId,
    algorithmRepository: algorithms,
    paperRepository: paper,
    algorithmAiEnabled: ai,
  });
async function login(a: ReturnType<typeof createApp>, email = 'owner@example.test') {
  const response = await request(a)
    .post('/api/auth/login')
    .set('Origin', origin)
    .send({ email, password });
  expect(response.status).toBe(200);
  return response.headers['set-cookie'][0].split(';')[0] as string;
}
async function createAlgorithm(a: ReturnType<typeof createApp>, cookie: string, patch = {}) {
  const response = await request(a)
    .post('/api/algorithms')
    .set('Origin', origin)
    .set('Cookie', cookie)
    .send({
      algorithm: {
        ...inputFromTemplate('momentum', 'KR'),
        name: '모멘텀 A',
        targets: ['005930'],
        mode: 'paper',
        budget: 10_000_000,
        ...patch,
      },
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.algorithm as { id: string; name: string; targetsChangedAt: string };
}

beforeEach(async () => {
  store = new MemoryStore();
  algorithms = new MemoryAlgorithmRepository();
  paper = new MemoryPaperRepository();
  const passwordHash = await hashPassword(password);
  ownerId = (
    await store.createUser({
      email: 'owner@example.test',
      passwordHash,
      role: 'member',
      active: true,
      version: 1,
    })
  ).id;
  await store.createUser({
    email: 'member@example.test',
    passwordHash,
    role: 'member',
    active: true,
    version: 1,
  });
});

describe('GET /api/algorithms/:id/paper access', () => {
  const path = '/api/algorithms/00000000-0000-4000-8000-000000000000/paper';
  it('401 anonymous, 403 for a non-owner, 404 for an unknown or malformed id', async () => {
    const a = app();
    expect((await request(a).get(path).set('Origin', origin)).status).toBe(401);
    const member = await login(a, 'member@example.test');
    const forbidden = await request(a).get(path).set('Cookie', member);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('OWNER_REQUIRED');
    const owner = await login(a);
    expect((await request(a).get(path).set('Cookie', owner)).status).toBe(404);
    expect(
      (await request(a).get('/api/algorithms/not-an-id/paper').set('Cookie', owner)).status,
    ).toBe(404);
  });

  it('fails closed (503) when no owner is configured', async () => {
    const a = createApp({ store, origin, algorithmRepository: algorithms, paperRepository: paper });
    const cookie = await login(a);
    expect((await request(a).get(path).set('Cookie', cookie)).status).toBe(503);
  });
});

describe('GET /api/algorithms/:id/paper content', () => {
  it('an algorithm without any run: no ledger, virtual notes, nothing invented', async () => {
    const a = app();
    const cookie = await login(a);
    const record = await createAlgorithm(a, cookie);
    const response = await request(a)
      .get(`/api/algorithms/${record.id}/paper`)
      .set('Cookie', cookie);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      virtual: true,
      ledger: null,
      metrics: null,
      trades: [],
      runs: [],
      equityCurve: [],
      ai: null,
    });
    expect(response.body.notes[0]).toContain('가상');
  });

  it("shows the ledger, positions, metrics, recent fills and this algorithm's run history", async () => {
    const a = app();
    const cookie = await login(a);
    const record = await createAlgorithm(a, cookie);
    const ledger = createPaperLedger({
      algorithmId: record.id,
      market: 'KR',
      budget: 10_000_000,
      startedOn: '2026-10-21',
      now: '2026-10-21T00:05:00.000Z',
    });
    const completed = Array.from({ length: 5 }, (_, i) => ({
      date: `2026-10-${String(15 + i).padStart(2, '0')}`,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1e9,
    }));
    const quotes: PaperQuote[] = [{ symbol: '005930', price: 110, completed }];
    const day = runPaperDay({
      ledger,
      algorithm: {
        name: 'x',
        method: 'formula',
        template: 'custom',
        market: 'KR',
        symbols: ['005930'],
        signals: [{ id: 'momentum', weight: 1 }],
        params: {
          trend: {
            fastPeriod: 20,
            slowPeriod: 50,
            crossScale: 0.05,
            priceScale: 0.1,
            adxPeriod: 14,
            adxFull: 40,
          },
          momentum: { lookbackDays: 1, scale: 0.1 },
          meanReversion: { rsiPeriod: 14, bbPeriod: 20, bbK: 2, rsiScale: 30 },
          value: { window: 12, minHistory: 4, maxAgeDays: 400 },
        },
        buyThreshold: 0.4,
        sellThreshold: -0.4,
        budget: 10_000_000,
      },
      usedSignals: [{ id: 'momentum', weight: 1 }],
      date: '2026-10-21',
      runId: 'KR_2026-10-21',
      now: '2026-10-21T00:05:00.000Z',
      quotes,
      costs: { commissionRate: 0.001 },
      stats: {
        width: 0.1,
        buckets: {
          '9': { index: 9, lower: 0.9, upper: 1, count: 30, sumReturn: 3, meanReturn: 0.1 },
        },
      },
      safeguards: { liquidityWindow: 1, liquidityMinAvgValue: 0 },
    });
    expect(day.fills).toHaveLength(1);
    await paper.commitDay(
      day.ledger,
      day.fills.map((fill) =>
        toTrade(fill, {
          ledger: day.ledger,
          runId: 'KR_2026-10-21',
          date: '2026-10-21',
          createdAt: '2026-10-21T00:05:01.000Z',
          targetsChangedAt: record.targetsChangedAt,
        }),
      ),
    );
    const run: AlgorithmRun = {
      id: 'KR_2026-10-21',
      market: 'KR',
      date: '2026-10-21',
      status: 'complete',
      trigger: 'scheduler',
      attempts: 1,
      startedAt: '2026-10-21T00:05:00.000Z',
      finishedAt: '2026-10-21T00:05:02.000Z',
      sessionOpen: '2026-10-21T00:00:00.000Z',
      skipCode: null,
      results: {
        [record.id]: {
          status: 'applied',
          code: null,
          reason: null,
          fills: 1,
          stoppedNow: false,
          decisions: { buy: 1, sell: 0, hold: 0 },
          rejections: {},
          heldBack: { insufficientHistory: 0, expectedBelowCost: 0 },
          excludedSignals: ['가치: 재무 데이터 연결 전이라 제외'],
          notes: [],
        },
        'someone-else': {
          status: 'skipped',
          code: 'EMERGENCY_STOP',
          reason: '긴급 정지',
          fills: 0,
          stoppedNow: false,
          decisions: { buy: 0, sell: 0, hold: 0 },
          rejections: {},
          heldBack: { insufficientHistory: 0, expectedBelowCost: 0 },
          excludedSignals: [],
          notes: [],
        },
      },
    };
    await paper.finishRun(run);

    const response = await request(a)
      .get(`/api/algorithms/${record.id}/paper`)
      .set('Cookie', cookie);
    expect(response.status).toBe(200);
    const body = response.body;
    expect(body.virtual).toBe(true);
    expect(body.ledger).toMatchObject({
      status: 'running',
      startedOn: '2026-10-21',
      budget: 10_000_000,
    });
    expect(body.ledger.positions).toHaveLength(1);
    expect(body.ledger.positions[0]).toMatchObject({ symbol: '005930', markPrice: 110 });
    expect(body.metrics).toMatchObject({ since: '2026-10-21', fills: 1, roundTrips: 0 });
    expect(body.metrics.costs.commission).toBeGreaterThan(0);
    expect(body.metrics.netReturn).toBeLessThan(0);
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0]).toMatchObject({ symbol: '005930', side: 'buy', date: '2026-10-21' });
    expect(body.trades[0].costs.commission).toBeGreaterThan(0);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].result.excludedSignals).toEqual(['가치: 재무 데이터 연결 전이라 제외']);
    expect(JSON.stringify(body)).not.toContain('someone-else');
    // No account identifier, token or provider text can be in the payload.
    expect(JSON.stringify(body)).not.toMatch(/token|secret|accountSeq/i);
  });

  it('AI algorithms say "AI 비용 승인 대기" while the job switch is off', async () => {
    const a = app(false);
    const cookie = await login(a);
    const record = await createAlgorithm(a, cookie, { method: 'ai', mode: 'paper' });
    const response = await request(a)
      .get(`/api/algorithms/${record.id}/paper`)
      .set('Cookie', cookie);
    expect(response.body.ai).toEqual({ enabled: false, message: 'AI 비용 승인 대기' });
    expect(response.body.notes.join(' ')).toContain('AI 비용 승인 대기');
    const enabled = app(true);
    const cookie2 = await login(enabled);
    const again = await request(enabled)
      .get(`/api/algorithms/${record.id}/paper`)
      .set('Cookie', cookie2);
    expect(again.body.ai.enabled).toBe(true);
    expect(again.body.notes.join(' ')).not.toContain('모의 판단도 하지 않습니다');
  });

  it('a non-paper algorithm tells how to start', async () => {
    const a = app();
    const cookie = await login(a);
    const record = await createAlgorithm(a, cookie, { mode: 'simulation' });
    const response = await request(a)
      .get(`/api/algorithms/${record.id}/paper`)
      .set('Cookie', cookie);
    expect(response.body.notes.join(' ')).toContain('"모의"로 저장');
  });

  it('a storage failure answers 503 without details', async () => {
    const a = app();
    const cookie = await login(a);
    const record = await createAlgorithm(a, cookie);
    paper.getLedger = async () => {
      throw new Error('firestore secret detail');
    };
    const response = await request(a)
      .get(`/api/algorithms/${record.id}/paper`)
      .set('Cookie', cookie);
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain('secret detail');
  });
});

describe('listFills (chart markers)', () => {
  it('returns the fills of one symbol, newest first, and [] for bad input or storage errors', async () => {
    const fill = (id: string, symbol: string, date: string) =>
      paper.commitDay(
        createPaperLedger({ algorithmId: id, market: 'KR', budget: 1, startedOn: date, now: date }),
        [
          {
            id: `${id}_${date}_001`,
            algorithmId: id,
            market: 'KR',
            symbol,
            side: 'buy',
            quantity: 3,
            price: 100,
            referencePrice: 100,
            notional: 300,
            costs: { commission: 0, tax: 0, slippage: 0 },
            score: 0.5,
            reasons: [],
            runId: `KR_${date}`,
            date,
            createdAt: `${date}T00:05:00.000Z`,
            mode: 'paper',
            virtual: true,
            targetsChangedAt: date,
          },
        ],
      );
    await fill('algo-a', '005930', '2026-10-20');
    await fill('algo-b', '005930', '2026-10-21');
    await fill('algo-c', '000660', '2026-10-21');
    const fills = await listFills(paper, '005930');
    expect(fills.map((f) => [f.date, f.algorithmId, f.mode, f.side])).toEqual([
      ['2026-10-21', 'algo-b', 'paper', 'buy'],
      ['2026-10-20', 'algo-a', 'paper', 'buy'],
    ]);
    expect(await listFills(paper, '../etc')).toEqual([]);
    expect(await listFills(paper, '')).toEqual([]);
    paper.listTradesBySymbol = async () => {
      throw new Error('down');
    };
    expect(await listFills(paper, '005930')).toEqual([]);
  });
});
