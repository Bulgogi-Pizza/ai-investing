import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  MemoryNotificationRepository,
  NotificationService,
  TelegramNotifier,
  createNotificationsRouter,
  formatNotification,
  notifierFromEnvironment,
  sanitizeNotificationText,
  type NotificationEvent,
  type NotificationRecord,
  type NotificationRepository,
} from '../src/server/notify';

const origin = 'https://investing-1234567890.asia-northeast3.run.app';
const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const chatId = '987654321';
const now = () => new Date('2026-10-21T01:00:00Z');
const fillEvent: NotificationEvent = {
  kind: 'fill',
  mode: 'live',
  symbol: '005930',
  side: 'buy',
  status: 'filled',
  algorithmName: '모멘텀 A',
};
function okTransport() {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as ReturnType<typeof vi.fn> & typeof fetch;
}
function notifier(transport: typeof fetch, timeoutMs?: number) {
  return new TelegramNotifier({ botToken: token, chatId, transport, timeoutMs });
}
function service(repository: NotificationRepository, transport?: typeof fetch) {
  let counter = 0;
  return new NotificationService({
    repository,
    notifier: transport ? notifier(transport, 50) : undefined,
    appOrigin: origin,
    now,
    newId: () => `id-${++counter}`,
  });
}

describe('알림 메시지 정리', () => {
  it('이메일·외부 URL·긴 숫자·토큰을 제거한다', () => {
    const dirty =
      '문의 owner@example.com https://evil.example/x?a=1 tg://resolve?domain=x www.evil.com ' +
      '계좌 1234567890 123-456-789012 1234 5678 ８８８８８８８８ 키 ' +
      `${token} abcdefghijklmnopqrstuvwxyz012345 @handle evil.org/path 정상문장`;
    const clean = sanitizeNotificationText(dirty, 500);
    expect(clean).toContain('정상문장');
    expect(clean).not.toMatch(/@|https?:|tg:|evil|example|\.com|\.org|www/i);
    expect(clean).not.toMatch(/\d{8}/);
    expect(clean).not.toContain('AAHdq');
    expect(clean).not.toContain('abcdefghijklmnop');
    expect(clean).not.toMatch(/\d(?:[ ,-]?\d){7}/);
  });
  it('짧은 숫자(종목코드, 금리)는 유지하고 길이를 제한한다', () => {
    expect(sanitizeNotificationText('005930 금리 3.5% 인상')).toBe('005930 금리 3.5% 인상');
    expect(Array.from(sanitizeNotificationText('가'.repeat(500), 20))).toHaveLength(20);
    expect(sanitizeNotificationText({} as unknown as string)).toBe('');
  });
  it('제어문자와 줄바꿈을 한 줄 공백으로 바꾼다', () => {
    const rightToLeftOverride = String.fromCharCode(0x202e);
    expect(sanitizeNotificationText(`a\u0000\n\r\tb${rightToLeftOverride}c`)).toBe('a b c');
  });
  it('악의적인 입력이 있어도 화면 링크 외 URL·식별값이 메시지에 없다', () => {
    const events: NotificationEvent[] = [
      {
        kind: 'fill',
        mode: 'paper',
        symbol: 'https://evil.example',
        side: 'sell',
        status: 'partially-filled',
        algorithmName: 'a@b.com 1234567890123 https://evil.example/x',
      },
      { kind: 'job-failure', jobName: 'job 99999999 token ' + token },
      { kind: 'morning-brief', summary: `요약 ${token} http://evil.example 계좌 12345678901` },
      {
        kind: 'algorithm-auto-stop',
        mode: 'live',
        algorithmName: 'x',
        reason: 'provider says: <b>secret</b>' as never,
      },
      { kind: 'bogus' } as unknown as NotificationEvent,
    ];
    for (const event of events) {
      const { message } = formatNotification(event, origin);
      const body = message.slice(0, message.lastIndexOf('\n화면: '));
      const lastLine = message.slice(message.lastIndexOf('\n') + 1);
      expect([
        `화면: ${origin}/`,
        `화면: ${origin}/algorithms`,
        `화면: ${origin}/calendar`,
      ]).toContain(lastLine);
      expect(body).not.toMatch(/@|https?:|evil|example|\.com/i);
      expect(body).not.toMatch(/\d{8}/);
      expect(body).not.toContain(token);
      expect(body).not.toContain('secret');
      expect(message.length).toBeLessThan(1200);
    }
  });
  it('모의와 실전을 문구로 분명히 구분한다', () => {
    const live = formatNotification(fillEvent, origin);
    const paper = formatNotification({ ...fillEvent, mode: 'paper' }, origin);
    expect(live.mode).toBe('live');
    expect(live.message).toContain('[실전 주문·실제 체결]');
    expect(live.message).toContain('실제 주문입니다.');
    expect(paper.mode).toBe('paper');
    expect(paper.message).toContain('[모의 운용·가상 체결]');
    expect(paper.message).toContain('실제 주문이 아닙니다');
    expect(paper.message).not.toContain('실전');
    expect(live.message).toContain('종목: 005930');
    expect(live.message).toContain('방향: 매수');
    expect(live.message).toContain('알고리즘: 모멘텀 A');
  });
  it('설계의 모든 알림 종류를 최소 문구로 만든다', () => {
    const cases: [NotificationEvent, string][] = [
      [
        { kind: 'algorithm-auto-stop', mode: 'live', algorithmName: 'A', reason: 'loss-limit' },
        '자동 정지',
      ],
      [
        { kind: 'order-rejected', mode: 'live', symbol: 'AAPL', side: 'sell', algorithmName: 'A' },
        '주문 거부',
      ],
      [{ kind: 'data-error', source: 'quote', symbol: 'AAPL' }, '데이터 오류'],
      [{ kind: 'job-failure', jobName: 'investing-morning' }, '작업 실패'],
      [{ kind: 'morning-brief', summary: '기준금리 동결' }, '기준금리 동결'],
      [
        { kind: 'setting-risk-increase', change: 'live-enabled', algorithmName: 'A' },
        '실전 매매 켜기',
      ],
      [{ kind: 'setting-risk-increase', change: 'budget-raised' }, '운용 금액 한도 상향'],
      [{ kind: 'setting-risk-increase', change: 'emergency-stop-released' }, '긴급 정지 해제'],
      [
        {
          kind: 'algorithm-auto-stop',
          mode: 'live',
          algorithmName: 'A',
          reason: 'order-permission',
        },
        '주문 권한 문제',
      ],
      [
        {
          kind: 'algorithm-auto-stop',
          mode: 'live',
          algorithmName: 'A',
          reason: 'first-order-rejected',
        },
        '첫 실전 주문이 증권사에 거부됨',
      ],
      [
        {
          kind: 'live-order-unconfirmed',
          mode: 'live',
          symbol: '005930',
          side: 'buy',
          algorithmName: 'A',
        },
        '접수 여부 미확인',
      ],
    ];
    for (const [event, expected] of cases)
      expect(formatNotification(event, origin).message).toContain(expected);
    expect(formatNotification({ kind: 'morning-brief' }, origin).message).toContain(
      `화면: ${origin}/calendar`,
    );
  });
  it('위험을 늘리는 설정 변경은 종류마다 고유한 문구를 쓴다', () => {
    const changes = [
      ['live-enabled', '실전 매매 켜기'],
      ['budget-raised', '운용 금액 한도 상향'],
      ['emergency-stop-released', '긴급 정지 해제'],
      ['algorithm-stop-released', '알고리즘 자동 정지 해제'],
      ['max-orders-raised', '하루 최대 주문 횟수 상향'],
      ['min-holding-lowered', '최소 보유 기간 단축'],
      ['loss-stop-loosened', '누적 손실 정지 기준 완화'],
      ['liquidity-lowered', '최소 거래대금 기준 하향'],
    ] as const;
    const seen = new Set<string>();
    for (const [change, text] of changes) {
      const { message } = formatNotification({ kind: 'setting-risk-increase', change }, origin);
      expect(message).toContain(`[위험 증가 설정 변경] ${text}`);
      expect(message).toContain('긴급 정지를 누르세요');
      expect(message).not.toContain('확인 필요');
      seen.add(message);
    }
    expect(seen.size).toBe(changes.length);
    // An unknown change never leaks its value: a neutral phrase instead.
    const unknown = formatNotification(
      { kind: 'setting-risk-increase', change: 'drop@example.com' as never },
      origin,
    ).message;
    expect(unknown).toContain('설정 변경');
    expect(unknown).not.toContain('example');
  });
  it('접수 여부 미확인 알림은 실제 주문임을 밝히고 금액·수량·계좌·원문 없이 종목·방향·이름만 담는다', () => {
    const { message, mode, kind } = formatNotification(
      {
        kind: 'live-order-unconfirmed',
        mode: 'live',
        symbol: '005930',
        side: 'sell',
        algorithmName: '모멘텀 A',
      },
      origin,
    );
    expect(kind).toBe('live-order-unconfirmed');
    expect(mode).toBe('live');
    expect(message).toContain('[실전 주문·실제 체결] 주문 접수 여부 미확인');
    expect(message).toContain('종목: 005930');
    expect(message).toContain('방향: 매도');
    expect(message).toContain('알고리즘: 모멘텀 A');
    expect(message).toContain(`화면: ${origin}/algorithms`);
    expect(message).not.toMatch(/\d{4,}원|수량|계좌/);
    // The fields are optional: a bare event still formats.
    const bare = formatNotification({ kind: 'live-order-unconfirmed', mode: 'live' }, origin);
    expect(bare.message).toContain('주문 접수 여부 미확인');
    expect(bare.message).not.toContain('종목:');
    // Hostile text in the optional fields is sanitized like every other field.
    const hostile = formatNotification(
      {
        kind: 'live-order-unconfirmed',
        mode: 'live',
        symbol: 'https://evil.example.com' as never,
        algorithmName: 'a@b.com token_abcdefghijklmnopqrstuvwxyz0123',
      },
      origin,
    ).message;
    expect(hostile).not.toMatch(/evil|@|token_abcdefghijklmnopqrstuvwxyz/);
  });
  it('앱 origin이 아니면 거부한다', () => {
    expect(() => formatNotification(fillEvent, 'https://evil.example/path')).toThrow();
    expect(() => formatNotification(fillEvent, 'http://example.com')).toThrow();
  });
});

describe('TelegramNotifier 전송', () => {
  it('고정 호스트에 POST JSON으로 문서화된 파라미터만 보내고 리다이렉트를 금지한다', async () => {
    const transport = okTransport();
    await notifier(transport).send('안녕');
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      chat_id: 987654321,
      text: '안녕',
      link_preview_options: { is_disabled: true },
    });
    expect(body.parse_mode).toBeUndefined();
  });
  it('토큰과 chat ID 형식이 잘못되면 생성을 거부하고 값을 노출하지 않는다', () => {
    for (const [botToken, id] of [
      ['../x', chatId],
      [token, '@someone'],
      [token, '12 34'],
      ['', chatId],
    ])
      expect(() => new TelegramNotifier({ botToken, chatId: id })).toThrow(
        /^Invalid Telegram configuration$/,
      );
    const instance = notifier(okTransport());
    expect(JSON.stringify(instance)).not.toContain('AAHdq');
    expect(Object.keys(instance)).toEqual([]);
  });
  it('환경변수에서만 만들고 없거나 잘못되면 만들지 않는다', () => {
    expect(notifierFromEnvironment({})).toBeUndefined();
    expect(notifierFromEnvironment({ TELEGRAM_BOT_TOKEN: token })).toBeUndefined();
    expect(
      notifierFromEnvironment({ TELEGRAM_BOT_TOKEN: 'bad', TELEGRAM_CHAT_ID: chatId }),
    ).toBeUndefined();
    expect(
      notifierFromEnvironment({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId }),
    ).toBeInstanceOf(TelegramNotifier);
  });
  it('실패 오류에 URL·토큰·응답 본문이 담기지 않는다', async () => {
    const transport = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error_code: 400, description: 'SECRET-DETAIL' }), {
          status: 400,
        }),
    ) as unknown as typeof fetch;
    const error = await notifier(transport)
      .send('x')
      .catch((e: Error) => e);
    expect(error).toMatchObject({ code: 'TELEGRAM_REJECTED' });
    const dump = `${(error as Error).message}${(error as Error).stack}${JSON.stringify(error)}`;
    expect(dump).not.toContain('SECRET-DETAIL');
    expect(dump).not.toContain('AAHdq');
    expect(dump).not.toContain('api.telegram.org');
  });
  it('429, 형식 오류, 과대 응답, 리다이렉트, 연결 실패를 구분한다', async () => {
    const code = async (transport: typeof fetch) =>
      (
        await notifier(transport)
          .send('x')
          .catch((e) => e)
      ).code;
    expect(
      await code(
        (async () =>
          new Response(
            JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 5 } }),
            { status: 429 },
          )) as unknown as typeof fetch,
      ),
    ).toBe('TELEGRAM_RATE_LIMITED');
    expect(
      await code((async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch),
    ).toBe('TELEGRAM_RESPONSE_INVALID');
    expect(
      await code(
        (async () =>
          new Response(JSON.stringify({ ok: true }), { status: 500 })) as unknown as typeof fetch,
      ),
    ).toBe('TELEGRAM_REJECTED');
    expect(
      await code(
        (async () =>
          new Response('x'.repeat(70 * 1024), { status: 200 })) as unknown as typeof fetch,
      ),
    ).toBe('TELEGRAM_RESPONSE_INVALID');
    expect(
      await code((async () => {
        const response = new Response(JSON.stringify({ ok: true }));
        Object.defineProperty(response, 'redirected', { value: true });
        return response;
      }) as unknown as typeof fetch),
    ).toBe('TELEGRAM_RESPONSE_INVALID');
    expect(
      await code((async () =>
        Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch),
    ).toBe('TELEGRAM_UNREACHABLE');
  });
  it('시간 제한이 지나면 TIMEOUT으로 실패한다', async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) =>
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
      )) as unknown as typeof fetch;
    const error = await notifier(hanging, 20)
      .send('x')
      .catch((e) => e);
    expect(error.code).toBe('TELEGRAM_TIMEOUT');
  });
  it('빈 메시지와 너무 긴 메시지는 보내지 않는다', async () => {
    const transport = okTransport();
    for (const message of ['', '   ', 'a'.repeat(4001)])
      await expect(notifier(transport).send(message)).rejects.toMatchObject({
        code: 'MESSAGE_INVALID',
      });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('NotificationService', () => {
  it('먼저 기록하고 전송 성공을 sent로 갱신한다', async () => {
    const repository = new MemoryNotificationRepository();
    const events: string[] = [];
    const original = repository.create.bind(repository);
    repository.create = async (record: NotificationRecord) => {
      events.push(`create:${record.status}`);
      return original(record);
    };
    const transport = vi.fn(async () => {
      events.push('send');
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;
    const outcome = await service(repository, transport).notify(fillEvent);
    expect(outcome).toEqual({ status: 'sent', recorded: true });
    expect(events).toEqual(['create:pending', 'send']);
    const [record] = await repository.listRecent(10);
    expect(record).toMatchObject({
      id: 'id-1',
      kind: 'fill',
      mode: 'live',
      status: 'sent',
      createdAt: '2026-10-21T01:00:00.000Z',
    });
    expect(record.message).toContain('[실전 주문·실제 체결]');
    expect(JSON.stringify(record)).not.toContain('AAHdq');
    expect(JSON.stringify(record)).not.toContain(chatId);
  });
  it('연결 실패·시간 초과·거부를 failed로 기록하고 던지지 않는다', async () => {
    for (const [transport, code] of [
      [
        (async () => Promise.reject(new Error('boom SECRET'))) as unknown as typeof fetch,
        'TELEGRAM_UNREACHABLE',
      ],
      [
        ((_u: string, init: RequestInit) =>
          new Promise((_r, reject) =>
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
          )) as unknown as typeof fetch,
        'TELEGRAM_TIMEOUT',
      ],
      [
        (async () =>
          new Response(JSON.stringify({ ok: false, description: 'SECRET' }), {
            status: 403,
          })) as unknown as typeof fetch,
        'TELEGRAM_REJECTED',
      ],
    ] as const) {
      const repository = new MemoryNotificationRepository();
      const outcome = await service(repository, transport).notify(fillEvent);
      expect(outcome).toEqual({ status: 'failed', failureCode: code, recorded: true });
      const [record] = await repository.listRecent(1);
      expect(record).toMatchObject({ status: 'failed', failureCode: code });
      expect(JSON.stringify(record)).not.toContain('SECRET');
    }
  });
  it('전송기가 임의 오류를 던져도 DELIVERY_ERROR로만 기록한다', async () => {
    const repository = new MemoryNotificationRepository();
    const instance = new NotificationService({
      repository,
      notifier: {
        send: async () => {
          throw new Error('raw provider text 12345678');
        },
      },
      appOrigin: origin,
      now,
    });
    const outcome = await instance.notify(fillEvent);
    expect(outcome.failureCode).toBe('DELIVERY_ERROR');
    expect(JSON.stringify(await repository.listRecent(1))).not.toContain('raw provider');
  });
  it('설정이 없으면 disabled로 기록하고 전송하지 않는다', async () => {
    const repository = new MemoryNotificationRepository();
    const outcome = await service(repository).notify({
      kind: 'job-failure',
      jobName: 'investing-morning',
    });
    expect(outcome).toEqual({ status: 'disabled', failureCode: 'NOT_CONFIGURED', recorded: true });
    expect(await repository.listRecent(5)).toMatchObject([
      { kind: 'job-failure', status: 'disabled', failureCode: 'NOT_CONFIGURED' },
    ]);
  });
  it('저장소가 실패해도 전송을 시도하고 던지지 않는다', async () => {
    const broken: NotificationRepository = {
      create: async () => {
        throw new Error('firestore down');
      },
      update: async () => {
        throw new Error('firestore down');
      },
      listRecent: async () => [],
    };
    const transport = okTransport();
    expect(await service(broken, transport).notify(fillEvent)).toEqual({
      status: 'sent',
      recorded: false,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await service(broken).notify(fillEvent)).toMatchObject({ status: 'disabled' });
  });
  it('저장소 갱신만 실패해도 던지지 않는다', async () => {
    const repository = new MemoryNotificationRepository();
    repository.update = async () => {
      throw new Error('firestore down');
    };
    const outcome = await service(repository, okTransport()).notify(fillEvent);
    expect(outcome).toEqual({ status: 'sent', recorded: false });
  });
  it('잘못된 이벤트도 던지지 않고 안전한 기본 문구로 처리한다', async () => {
    const repository = new MemoryNotificationRepository();
    const outcome = await service(repository).notify({
      kind: 'bogus',
    } as unknown as NotificationEvent);
    expect(outcome.status).toBe('disabled');
    expect(() => service(repository)).not.toThrow();
    expect(
      () => new NotificationService({ repository, appOrigin: 'https://evil.example/x' }),
    ).toThrow();
  });
});

function app(user: { id: string; role?: string; active?: boolean } | null, ownerId = 'owner-1') {
  const repository = new MemoryNotificationRepository();
  const server = express();
  server.use((_req, res, next) => {
    if (user) res.locals.user = user;
    next();
  });
  server.use(createNotificationsRouter({ repository, ownerUserId: ownerId }));
  return { server, repository };
}
async function seed(repository: NotificationRepository, count: number) {
  const instance = new NotificationService({
    repository,
    appOrigin: origin,
    now: (() => {
      let tick = 0;
      return () => new Date(Date.UTC(2026, 9, 21, 0, 0, tick++));
    })(),
  });
  for (let i = 0; i < count; i++)
    await instance.notify({ kind: 'job-failure', jobName: `job-${i}` });
}
describe('GET /api/notifications', () => {
  it('소유자가 아니면 403 OWNER_REQUIRED, 관리자도 예외 없다', async () => {
    for (const user of [
      { id: 'other', role: 'member' },
      { id: 'admin-1', role: 'admin' },
    ]) {
      const { server } = app(user);
      const response = await request(server).get('/api/notifications');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('OWNER_REQUIRED');
    }
    const empty = app({ id: '' }, '');
    expect((await request(empty.server).get('/api/notifications')).status).toBe(403);
  });
  it('로그인 정보가 없거나 비활성이면 라우터도 401로 막는다', async () => {
    expect((await request(app(null).server).get('/api/notifications')).status).toBe(401);
    expect(
      (await request(app({ id: 'owner-1', active: false }).server).get('/api/notifications'))
        .status,
    ).toBe(401);
  });
  it('소유자에게 최근 순으로 최대 limit개를 돌려주고 민감 필드를 노출하지 않는다', async () => {
    const { server, repository } = app({ id: 'owner-1' });
    await seed(repository, 60);
    const response = await request(server).get('/api/notifications');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.limit).toBe(20);
    expect(response.body.notifications).toHaveLength(20);
    expect(response.body.notifications[0].message).toContain('job-59');
    expect(response.body.notifications[1].message).toContain('job-58');
    expect(Object.keys(response.body.notifications[0]).sort()).toEqual(
      ['createdAt', 'failureCode', 'id', 'kind', 'message', 'status'].sort(),
    );
    const max = await request(server).get('/api/notifications?limit=50');
    expect(max.body.notifications).toHaveLength(50);
    expect(
      (await request(server).get('/api/notifications?limit=3')).body.notifications,
    ).toHaveLength(3);
  });
  it('limit과 쿼리를 검증한다', async () => {
    const { server } = app({ id: 'owner-1' });
    for (const query of [
      'limit=0',
      'limit=51',
      'limit=-1',
      'limit=abc',
      'limit=1.5',
      'limit=1&limit=2',
      'limit=',
      'limit[a]=1',
      'limit=10&chatId=1',
      'chat_id=1',
    ]) {
      const response = await request(server).get(`/api/notifications?${query}`);
      expect(response.status, query).toBe(400);
      expect(response.body.error.code).toBe('INVALID_NOTIFICATION_QUERY');
    }
  });
  it('저장소 오류는 상세 없이 503으로 돌려준다', async () => {
    const server = express();
    server.use((_req, res, next) => {
      res.locals.user = { id: 'owner-1' };
      next();
    });
    server.use(
      createNotificationsRouter({
        ownerUserId: 'owner-1',
        repository: {
          create: async () => {},
          update: async () => {},
          listRecent: async () => {
            throw new Error('SECRET firestore detail');
          },
        },
      }),
    );
    const response = await request(server).get('/api/notifications');
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain('SECRET');
  });
});

describe('알림: 미확인 주문 정리·전략 변경·자동 정지 안내', () => {
  const origin = 'https://invest.example.test';
  it('실전 자동 정지는 보유 종목을 자동으로 팔지 않는다고 알리고, 모의 정지에는 그 문구가 없다', () => {
    const live = formatNotification(
      { kind: 'algorithm-auto-stop', mode: 'live', algorithmName: 'A', reason: 'loss-limit' },
      origin,
    ).message;
    expect(live).toContain('보유 종목은 자동으로 팔지 않습니다');
    expect(live).toContain('직접 관리하세요');
    const paper = formatNotification(
      { kind: 'algorithm-auto-stop', mode: 'paper', algorithmName: 'A', reason: 'loss-limit' },
      origin,
    ).message;
    expect(paper).not.toContain('직접 관리');
    const unconfirmed = formatNotification(
      {
        kind: 'algorithm-auto-stop',
        mode: 'live',
        algorithmName: 'A',
        reason: 'unconfirmed-order',
      },
      origin,
    ).message;
    expect(unconfirmed).toContain('접수 여부를 확인하지 못한 주문이 한 세션 넘게 남음');
  });
  it('미확인 주문 정리 알림은 결과를 말하고 금액·수량을 담지 않는다', () => {
    for (const [outcome, text] of [
      ['filled', '체결됨'],
      ['canceled', '취소·미체결'],
      ['not-placed', '접수되지 않음'],
    ] as const) {
      const { message, mode } = formatNotification(
        {
          kind: 'live-order-resolved',
          mode: 'live',
          symbol: '005930',
          side: 'buy',
          algorithmName: '모멘텀 A',
          outcome,
        },
        origin,
      );
      expect(mode).toBe('live');
      expect(message).toContain('[실전 주문·실제 체결] 미확인 주문을 직접 정리했습니다');
      expect(message).toContain(`정리 결과: ${text}`);
      expect(message).toContain('종목: 005930');
      expect(message).toContain('긴급 정지를 누르세요');
      expect(message).toContain(`화면: ${origin}/algorithms`);
    }
    expect(
      formatNotification(
        { kind: 'live-order-resolved', mode: 'live', outcome: 'drop@x.com' as never },
        origin,
      ).message,
    ).toContain('정리 결과: 확인 필요');
  });
  it('실전 전략 변경은 위험 증가 설정 변경으로 알린다', () => {
    const { message } = formatNotification(
      { kind: 'setting-risk-increase', change: 'live-strategy-changed', algorithmName: 'A' },
      origin,
    );
    expect(message).toContain('[위험 증가 설정 변경] 실전 알고리즘 전략 변경');
    expect(message).toContain('긴급 정지를 누르세요');
  });
});
