import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { createCalendarRouter, MemoryCalendarRepository } from '../src/server/calendar';
const event = {
  id: 1,
  date: '2026-10-20',
  time: '09:00',
  title: '물가 발표',
  country: '한국',
  category: '물가',
  assets: ['금리', '원화'],
  importance: 3,
  forecast: '2%',
  previous: '1%',
  description: '시장 영향은 불확실합니다.',
  sourceUrl: 'https://example.com/release',
  sourceName: '발표기관',
  impactDirection: 'mixed',
  impactHorizon: '1주',
  confidence: 'low',
  factualObservedAt: '2026-10-20T00:00:00Z',
};
function app(
  role: 'admin' | 'member' | null,
  repository = new MemoryCalendarRepository(),
  userId = 'test-user',
) {
  const server = express();
  server.use(express.json());
  server.use((_req, res, next) => {
    if (role) res.locals.user = { id: userId, role, active: true };
    next();
  });
  server.use(createCalendarRouter({ repository, ownerUserId: 'test-user' }));
  return server;
}
const query = '/api/calendar/events?from=2026-10-01&to=2026-10-31';
describe('검증된 실제 일정 API 경계', () => {
  it('미인증 조회/등록과 일반회원 등록을 거부한다', async () => {
    expect((await request(app(null)).get(query)).status).toBe(401);
    expect(
      (
        await request(app(null))
          .post('/api/admin/calendar/events')
          .send({ events: [event] })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app('member'))
          .post('/api/admin/calendar/events')
          .send({ events: [event] })
      ).status,
    ).toBe(403);
  });
  it('빈 저장소에서 예시를 만들어 넣지 않는다', async () => {
    expect((await request(app('member')).get(query)).body.events).toEqual([]);
  });
  it('관리자 upsert와 AND 필터 및 공개 응답 투영을 지원한다', async () => {
    const repository = new MemoryCalendarRepository();
    const admin = app('admin', repository);
    expect(
      (
        await request(admin)
          .post('/api/admin/calendar/events')
          .send({ events: [{ ...event, authorId: 'must-not-leak' }] })
      ).status,
    ).toBe(200);
    const member = app('member', repository);
    const result = await request(member).get(
      `${query}&importance=3&category=${encodeURIComponent('물가')}&asset=${encodeURIComponent('원화')}&market=${encodeURIComponent('한국')}`,
    );
    expect(result.body.events).toHaveLength(1);
    expect(result.body.events[0]).not.toHaveProperty('authorId');
    expect((await request(member).get(`${query}&importance=1`)).body.events).toEqual([]);
    await request(admin)
      .post('/api/admin/calendar/events')
      .send({ events: [{ ...event, title: '수정된 일정' }] });
    expect((await request(member).get(query)).body.events[0].title).toBe('수정된 일정');
  });
  it('잘못된 날짜·범위·배열필터를 거부한다', async () => {
    for (const url of [
      '/api/calendar/events?from=2026-02-30&to=2026-03-01',
      '/api/calendar/events?from=2026-13-01&to=2026-13-02',
      '/api/calendar/events?from=2026-10-01&to=2028-01-01',
      `${query}&importance=2&importance=3`,
      '/api/calendar/events?from=2026-11-01&to=2026-10-01',
    ])
      expect((await request(app('member')).get(url)).status).toBe(400);
  });
  it('출처 프로토콜/인증정보·비정상 필드·중복·대량입력을 거부한다', async () => {
    for (const events of [
      [{ ...event, sourceUrl: 'javascript:alert(1)' }],
      [{ ...event, sourceUrl: 'https://user:password@example.com/' }],
      [{ ...event, date: '2026-02-30' }],
      [{ ...event, time: '24:01' }],
      [{ ...event, importance: '3' }],
      [{ ...event, confidence: ['low'] }],
      [{ ...event, factualObservedAt: '2026-10-20T24:00:00Z' }],
      [event, event],
      Array.from({ length: 101 }, (_, index) => ({ ...event, id: index + 1 })),
    ])
      expect(
        (await request(app('admin')).post('/api/admin/calendar/events').send({ events })).status,
      ).toBe(400);
  });
  it('외부 마크업을 실행하지 않고 텍스트로 보존한다', async () => {
    const repository = new MemoryCalendarRepository();
    const title = '<img src=x onerror=alert(1)>';
    await request(app('admin', repository))
      .post('/api/admin/calendar/events')
      .send({ events: [{ ...event, title }] });
    const result = await request(app('member', repository)).get(query);
    expect(result.headers['content-type']).toContain('application/json');
    expect(result.body.events[0].title).toBe(title);
  });
  it('소유자가 아닌 계정은 조회·등록 모두 403이고 소유자 미설정이면 닫는다', async () => {
    const repository = new MemoryCalendarRepository();
    await repository.upsert([event as never], 'test-user');
    const other = app('member', repository, 'someone-else');
    const read = await request(other).get(query);
    expect(read.status).toBe(403);
    expect(read.body.error.code).toBe('OWNER_REQUIRED');
    expect(JSON.stringify(read.body)).not.toContain('물가 발표');
    const otherAdmin = app('admin', repository, 'someone-else');
    expect(
      (
        await request(otherAdmin)
          .post('/api/admin/calendar/events')
          .send({ events: [event] })
      ).status,
    ).toBe(403);
    expect((await request(app('member', repository)).get(query)).status).toBe(200);
    const unconfigured = express();
    unconfigured.use((_req, res, next) => {
      res.locals.user = { id: 'test-user', role: 'admin', active: true };
      next();
    });
    unconfigured.use(createCalendarRouter({ repository }));
    expect((await request(unconfigured).get(query)).status).toBe(503);
  });
});
