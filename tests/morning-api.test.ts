import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { cleanEvent, createCalendarRouter, MemoryCalendarRepository } from '../src/server/calendar';
import {
  MemoryMorningRunRepository,
  createMorningRouter,
  type MorningRun,
} from '../src/server/morning';

const event = {
  id: 9,
  date: '2026-10-20',
  time: '',
  title: '미국 소비자물가지수(CPI) 발표',
  country: '미국',
  category: '경제 지표',
  assets: ['금리'],
  importance: 3,
  description: '발표 시각은 제공되지 않는다.',
  sourceUrl: 'https://fred.stlouisfed.org/release?rid=10',
  sourceName: 'FRED',
  impactDirection: 'unknown',
  impactHorizon: '발표 직후',
  confidence: 'low',
  factualObservedAt: '2026-10-21T00:00:00Z',
};
const value = {
  indicatorId: 'us-cpi',
  label: 'CPI',
  actual: '324.368',
  previous: '323.364',
  unit: '지수',
  period: '2026-09-01',
  previousPeriod: '2026-08-01',
  source: 'FRED',
  observedAt: '2026-10-21T00:00:00.000Z',
};

describe('캘린더 모델 확장(아침 작업)', () => {
  it('시각이 없는 일정("")을 허용하되 형식이 틀린 시각은 계속 거부한다', () => {
    expect(cleanEvent(event)?.time).toBe('');
    expect(cleanEvent({ ...event, time: '24:01' })).toBeNull();
    expect(cleanEvent({ ...event, time: ' ' })).toBeNull();
  });
  it('값·AI 요약·번역 필드를 검증하고 알 수 없는 필드는 버린다', () => {
    const full = cleanEvent({
      ...event,
      indicatorIds: ['us-cpi'],
      values: [value],
      aiSummary: { text: '요약', model: 'm', generatedAt: '2026-10-21T00:00:00Z' },
      titleOriginal: 'Original',
      translation: { model: 'm', translatedAt: '2026-10-21T00:00:00Z' },
      authorId: 'secret-author',
    });
    expect(full).toMatchObject({
      indicatorIds: ['us-cpi'],
      values: [value],
      titleOriginal: 'Original',
    });
    expect(full).not.toHaveProperty('authorId');
    expect(cleanEvent({ ...event, aiSummary: null })?.aiSummary).toBeNull();
    expect(cleanEvent(event)).not.toHaveProperty('aiSummary');
    for (const bad of [
      { values: [{ ...value, actual: 'abc' }] },
      { values: [{ ...value, observedAt: 'yesterday' }] },
      { values: [{ ...value, period: '2026-13-01' }] },
      { values: [value, value] },
      { values: [{ ...value, indicatorId: 'UPPER CASE' }] },
      { indicatorIds: [] },
      { indicatorIds: ['a', 'a'] },
      { aiSummary: { text: '', model: 'm', generatedAt: '2026-10-21T00:00:00Z' } },
      { aiSummary: { text: 'x', model: 'm', generatedAt: 'nope' } },
      { titleOriginal: 'Original' },
      { translation: { model: 'm', translatedAt: '2026-10-21T00:00:00Z' } },
    ])
      expect(cleanEvent({ ...event, ...bad }), JSON.stringify(bad)).toBeNull();
  });
});

describe('아침 브리핑 API', () => {
  const run = (date: string, text: string | null): MorningRun => ({
    id: date,
    date,
    status: 'complete',
    trigger: 'scheduler',
    attempts: 1,
    startedAt: `${date}T07:00:00+09:00`,
    finishedAt: `${date}T07:01:00+09:00`,
    steps: {},
    ai: {
      enabled: false,
      model: null,
      calls: 0,
      tokens: { prompt: 0, output: 0, thoughts: 0, total: 0 },
    },
    brief: text ? { text, generatedAt: `${date}T07:01:00+09:00`, aiUsed: false } : null,
    notification: null,
  });
  async function app(role: 'owner' | 'other' | null) {
    const repository = new MemoryMorningRunRepository();
    await repository.saveRun(run('2026-10-20', '어제 브리핑'));
    await repository.saveRun(run('2026-10-21', '10월 21일 아침 브리핑.'));
    await repository.saveRun(run('2026-10-22', null));
    const server = express();
    server.use((_req, res, next) => {
      if (role) res.locals.user = { id: role === 'owner' ? 'owner-1' : 'other-1', active: true };
      next();
    });
    server.use(createMorningRouter({ repository, ownerUserId: 'owner-1' }));
    return server;
  }
  it('로그인과 소유자 검사를 서버에서 한다', async () => {
    expect((await request(await app(null)).get('/api/calendar/brief')).status).toBe(401);
    expect((await request(await app('other')).get('/api/calendar/brief')).status).toBe(403);
  });
  it('브리핑이 있는 가장 최근 실행의 텍스트만 돌려준다', async () => {
    const response = await request(await app('owner')).get('/api/calendar/brief');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      brief: {
        date: '2026-10-21',
        text: '10월 21일 아침 브리핑.',
        generatedAt: '2026-10-21T07:01:00+09:00',
        aiUsed: false,
      },
    });
  });
  it('소유자 ID가 설정되지 않으면 닫힌다', async () => {
    const server = express();
    server.use((_req, res, next) => {
      res.locals.user = { id: 'owner-1', active: true };
      next();
    });
    server.use(
      createMorningRouter({ repository: new MemoryMorningRunRepository(), ownerUserId: undefined }),
    );
    expect((await request(server).get('/api/calendar/brief')).status).toBe(503);
  });
  it('관리자 일정 등록 경로도 시각 없는 일정을 받는다', async () => {
    const server = express();
    server.use(express.json());
    server.use((_req, res, next) => {
      res.locals.user = { id: 'owner-1', role: 'admin', active: true };
      next();
    });
    server.use(
      createCalendarRouter({ repository: new MemoryCalendarRepository(), ownerUserId: 'owner-1' }),
    );
    const response = await request(server)
      .post('/api/admin/calendar/events')
      .send({ events: [event] });
    expect(response.status).toBe(200);
  });
});

describe('인프라 정의(정적 검사; terraform validate는 별도로 실행)', () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const tf = read('infra/gcp/jobs-morning.tf');
  const deploy = read('.github/workflows/deploy.yml');
  it('Scheduler는 매일 07:00 KST이고 기본은 일시 정지다', () => {
    expect(tf).toContain('schedule         = "0 7 * * *"');
    expect(tf).toContain('time_zone        = "Asia/Seoul"');
    expect(tf).toContain('paused           = !var.morning_schedule_enabled');
    expect(tf).toMatch(/variable "morning_schedule_enabled" \{[^}]*default\s+= false/s);
    expect(tf).toContain('jobs/${local.morning_calendar_job}:run');
  });
  it('필요한 비밀 4개에만 비밀 단위 접근을 주고 프로젝트 단위 비밀 권한은 없다', () => {
    for (const name of [
      'investing-fred-api-key',
      'investing-ecos-api-key',
      'investing-telegram-bot-token',
      'investing-telegram-chat-id',
    ])
      expect(tf).toContain(`"${name}"`);
    expect(tf).not.toMatch(/google_project_iam_member"[^{]*\{[^}]*secretAccessor/s);
    expect(tf).not.toContain('investing-toss');
    expect(tf).not.toContain('investing-dart');
  });
  it('Vertex 권한은 변수로 막혀 있고 기본은 부여하지 않는다', () => {
    expect(tf).toMatch(/variable "morning_ai_enabled" \{[^}]*default\s+= false/s);
    expect(tf).toContain('count   = var.morning_ai_enabled ? 1 : 0');
    expect(tf).toContain('roles/aiplatform.user');
  });
  it('배포 단계는 AI를 명시적으로 끄고 토스 비밀 없이 같은 이미지·계정·VPC로 job을 만든다', () => {
    const start = deploy.indexOf('- name: Deploy morning calendar job');
    const next = deploy.indexOf('- name: ', start + 1);
    // Only this step: later job steps (e.g. the paper algorithm job) legitimately use Toss secrets.
    const step = deploy.slice(start, next === -1 ? undefined : next);
    expect(step).toContain('MORNING_AI_ENABLED=false');
    expect(step).toContain('--image="$DEPLOY_IMAGE"');
    expect(step).toContain('--service-account="investing-jobs@$PROJECT.iam.gserviceaccount.com"');
    expect(step).toContain('src/jobs/morning-calendar.ts');
    expect(step).toContain(
      '--network=investing-network --subnet=investing-subnet --vpc-egress=all-traffic',
    );
    expect(step).toContain('--role=roles/run.invoker');
    expect(step).toContain('--member="serviceAccount:investing-scheduler@');
    expect(step).not.toMatch(/TOSS_/);
    expect(step).not.toContain('MORNING_AI_ENABLED=true');
    // Appended after the snapshot job step, which is untouched.
    expect(deploy.indexOf('Deploy daily snapshot job')).toBeLessThan(
      deploy.indexOf('Deploy morning calendar job'),
    );
  });
});
