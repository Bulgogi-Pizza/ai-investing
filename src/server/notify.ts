import { randomUUID } from 'node:crypto';
import { Firestore, Timestamp } from '@google-cloud/firestore';
import { Router } from 'express';

// ---------------------------------------------------------------------------
// Event model. There is deliberately no field for amounts, quantities, account
// identifiers, provider error text or free-form recipients: what cannot be
// typed in cannot be leaked.
// ---------------------------------------------------------------------------
export type TradeMode = 'paper' | 'live';
export type OrderSide = 'buy' | 'sell';
/** Every setting change that can increase risk; each one is announced (no extra authentication). */
export type RiskIncreaseChange =
  | 'live-enabled'
  | 'budget-raised'
  | 'emergency-stop-released'
  | 'algorithm-stop-released'
  | 'max-orders-raised'
  | 'min-holding-lowered'
  | 'loss-stop-loosened'
  | 'liquidity-lowered'
  | 'live-strategy-changed';
export type NotificationEvent =
  | {
      kind: 'fill';
      mode: TradeMode;
      symbol: string;
      side: OrderSide;
      status: 'filled' | 'partially-filled';
      algorithmName: string;
    }
  | {
      kind: 'algorithm-auto-stop';
      mode: TradeMode;
      algorithmName: string;
      reason?:
        | 'loss-limit'
        | 'data-error'
        | 'order-permission'
        | 'first-order-rejected'
        | 'unconfirmed-order';
    }
  | {
      kind: 'order-rejected';
      mode: TradeMode;
      symbol: string;
      side: OrderSide;
      algorithmName: string;
      reason?: 'broker-rejected' | 'safety-guard';
    }
  | {
      kind: 'data-error';
      source: 'quote' | 'candles' | 'financials' | 'news' | 'calendar' | 'other';
      symbol?: string;
      algorithmName?: string;
    }
  | {
      /** A live order was sent but the broker's answer was lost: it may exist. Check the broker app. */
      kind: 'live-order-unconfirmed';
      mode: 'live';
      symbol?: string;
      side?: OrderSide;
      algorithmName?: string;
    }
  | {
      /** The owner closed out an unconfirmed live order by hand (what they found in the broker app). */
      kind: 'live-order-resolved';
      mode: 'live';
      symbol?: string;
      side?: OrderSide;
      algorithmName?: string;
      outcome: 'filled' | 'canceled' | 'not-placed';
    }
  | { kind: 'job-failure'; jobName: string }
  | { kind: 'morning-brief'; summary?: string }
  | {
      kind: 'setting-risk-increase';
      change: RiskIncreaseChange;
      algorithmName?: string;
    };
export type NotificationKind = NotificationEvent['kind'];
export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'disabled';
export type DeliveryFailureCode =
  | 'NOT_CONFIGURED'
  | 'TELEGRAM_TIMEOUT'
  | 'TELEGRAM_UNREACHABLE'
  | 'TELEGRAM_RATE_LIMITED'
  | 'TELEGRAM_REJECTED'
  | 'TELEGRAM_RESPONSE_INVALID'
  | 'MESSAGE_INVALID'
  | 'DELIVERY_ERROR';
export interface NotificationRecord {
  id: string;
  kind: NotificationKind;
  mode?: TradeMode;
  createdAt: string;
  status: NotificationStatus;
  failureCode?: DeliveryFailureCode;
  message: string;
}

// ---------------------------------------------------------------------------
// Sanitization and Korean formatting.
// ---------------------------------------------------------------------------
const maximumFieldLength = 60;
const maximumSummaryLength = 600;
const maximumBodyLength = 1000;
const invisible = new RegExp(
  '[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]',
  'g',
);

function truncate(value: string, max: number) {
  const characters = Array.from(value);
  return characters.length > max ? `${characters.slice(0, max - 1).join('')}…` : value;
}
function stripOnce(value: string) {
  return (
    value
      .normalize('NFKC')
      .replace(invisible, ' ')
      .replace(/\s+/g, ' ')
      // Anything URL-like, including schemes without "//" that clients may auto-link.
      .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, ' ')
      .replace(/\b(?:mailto|tg|javascript|data|file|ftp):\S*/gi, ' ')
      // Emails (and anything shaped like one), then stray @ handles.
      .replace(/\S*@\S*/g, ' ')
      .replace(/@/g, ' ')
      .replace(/\bwww\.\S+/gi, ' ')
      .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b(?:\/\S*)?/gi, ' ')
      // Opaque keys/tokens.
      .replace(/[A-Za-z0-9_-]{24,}/g, ' ')
      .replace(/\s+/g, ' ')
      // Digit runs of 8+, also when split by single spaces, commas or hyphens (account numbers, amounts, dates).
      .replace(/\d(?:[ ,-]?\d){7,}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
/** Single-line plain text safe to send: no emails, URLs, handles, long digit runs or tokens. */
export function sanitizeNotificationText(value: unknown, max = maximumFieldLength): string {
  if (typeof value !== 'string') return '';
  let current = value;
  for (let i = 0; i < 4; i++) {
    const next = stripOnce(current);
    if (next === current) break;
    current = next;
  }
  return truncate(current, max);
}
function symbolText(value: unknown) {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9.-]{0,11}$/.test(value) &&
    sanitizeNotificationText(value, 12) === value
    ? value
    : '(종목 확인 필요)';
}
const text = (value: unknown, fallback: string, max = maximumFieldLength) =>
  sanitizeNotificationText(value, max) || fallback;
const pick = <T extends string>(table: Record<T, string>, key: unknown, fallback = '확인 필요') =>
  typeof key === 'string' && Object.hasOwn(table, key) ? table[key as T] : fallback;
const sideLabel: Record<OrderSide, string> = { buy: '매수', sell: '매도' };
const modeHeader: Record<TradeMode, string> = {
  paper: '[모의 운용·가상 체결]',
  live: '[실전 주문·실제 체결]',
};
const modeNote = (mode: unknown) =>
  mode === 'live' ? '실제 주문입니다.' : '가상 기록이며 실제 주문이 아닙니다.';
const headerFor = (mode: unknown) => (mode === 'live' ? modeHeader.live : modeHeader.paper);
const screenPaths: Record<NotificationKind, string> = {
  fill: '/algorithms',
  'algorithm-auto-stop': '/algorithms',
  'order-rejected': '/algorithms',
  'live-order-unconfirmed': '/algorithms',
  'live-order-resolved': '/algorithms',
  'data-error': '/algorithms',
  'job-failure': '/algorithms',
  'morning-brief': '/calendar',
  'setting-risk-increase': '/algorithms',
};
function bodyLines(event: NotificationEvent): string[] {
  const algorithm = (name: unknown) => `알고리즘: ${text(name, '(이름 없음)')}`;
  switch (event.kind) {
    case 'fill':
      return [
        `${headerFor(event.mode)} 체결 알림`,
        `종목: ${symbolText(event.symbol)}`,
        `방향: ${pick(sideLabel, event.side)}`,
        `상태: ${event.status === 'partially-filled' ? '일부 체결' : '체결'}`,
        algorithm(event.algorithmName),
        modeNote(event.mode),
      ];
    case 'algorithm-auto-stop':
      return [
        `${headerFor(event.mode)} 알고리즘 자동 정지`,
        algorithm(event.algorithmName),
        `사유: ${pick(
          {
            'loss-limit': '누적 손실 한도 도달',
            'data-error': '데이터 오류',
            'order-permission': '증권사 주문 권한 문제(인증·권한 거부)',
            'first-order-rejected': '첫 실전 주문이 증권사에 거부됨',
            'unconfirmed-order': '접수 여부를 확인하지 못한 주문이 한 세션 넘게 남음',
          },
          event.reason,
          '자동 정지 조건 충족',
        )}`,
        ...(event.mode === 'live'
          ? ['정지해도 보유 종목은 자동으로 팔지 않습니다. 남은 보유분은 직접 관리하세요.']
          : []),
        '화면에서 상태를 확인하세요.',
      ];
    case 'order-rejected':
      return [
        `${headerFor(event.mode)} 주문 거부`,
        `종목: ${symbolText(event.symbol)}`,
        `방향: ${pick(sideLabel, event.side)}`,
        algorithm(event.algorithmName),
        `사유: ${pick({ 'broker-rejected': '증권사 거부', 'safety-guard': '안전장치 차단' }, event.reason, '주문이 거부되었습니다')}`,
      ];
    case 'live-order-unconfirmed':
      return [
        `${headerFor('live')} 주문 접수 여부 미확인`,
        ...(event.symbol === undefined ? [] : [`종목: ${symbolText(event.symbol)}`]),
        ...(event.side === undefined ? [] : [`방향: ${pick(sideLabel, event.side)}`]),
        ...(event.algorithmName === undefined ? [] : [algorithm(event.algorithmName)]),
        '주문을 보냈지만 증권사 응답을 확인하지 못했습니다. 주문이 있을 수 있으니 토스증권 앱에서 주문 내역을 확인하세요.',
        '확인될 때까지 이 종목의 새 주문은 나가지 않습니다.',
      ];
    case 'live-order-resolved':
      return [
        `${headerFor('live')} 미확인 주문을 직접 정리했습니다`,
        ...(event.symbol === undefined ? [] : [`종목: ${symbolText(event.symbol)}`]),
        ...(event.side === undefined ? [] : [`방향: ${pick(sideLabel, event.side)}`]),
        ...(event.algorithmName === undefined ? [] : [algorithm(event.algorithmName)]),
        `정리 결과: ${pick({ filled: '체결됨', canceled: '취소·미체결', 'not-placed': '접수되지 않음' }, event.outcome, '확인 필요')}`,
        '본인이 한 정리가 아니면 화면에서 바로 긴급 정지를 누르세요.',
      ];
    case 'data-error':
      return [
        '[데이터 오류]',
        `대상: ${pick({ quote: '시세', candles: '캔들', financials: '재무', news: '뉴스', calendar: '캘린더', other: '데이터' }, event.source, '데이터')}`,
        ...(event.symbol === undefined ? [] : [`종목: ${symbolText(event.symbol)}`]),
        ...(event.algorithmName === undefined ? [] : [algorithm(event.algorithmName)]),
        '데이터가 비었거나 오래되어 판단을 건너뛸 수 있습니다.',
      ];
    case 'job-failure':
      return [
        '[작업 실패]',
        `작업: ${text(event.jobName, '(이름 없음)')}`,
        '로그와 화면을 확인하세요.',
      ];
    case 'morning-brief':
      return [
        '[아침 브리핑]',
        text(event.summary, '오늘의 브리핑이 준비되었습니다.', maximumSummaryLength),
      ];
    case 'setting-risk-increase':
      return [
        `[위험 증가 설정 변경] ${pick(
          {
            'live-enabled': '실전 매매 켜기',
            'budget-raised': '운용 금액 한도 상향',
            'emergency-stop-released': '긴급 정지 해제',
            'algorithm-stop-released': '알고리즘 자동 정지 해제',
            'max-orders-raised': '하루 최대 주문 횟수 상향',
            'min-holding-lowered': '최소 보유 기간 단축',
            'loss-stop-loosened': '누적 손실 정지 기준 완화',
            'liquidity-lowered': '최소 거래대금 기준 하향',
            'live-strategy-changed': '실전 알고리즘 전략 변경(대상 종목·기준값·가중치·포지션 크기)',
          },
          event.change,
          '설정 변경',
        )}`,
        ...(event.algorithmName === undefined ? [] : [algorithm(event.algorithmName)]),
        '본인이 한 변경이 아니면 화면에서 바로 긴급 정지를 누르세요.',
      ];
    default:
      return ['[알림]'];
  }
}
export function validAppOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string') return false;
  try {
    const url = new URL(origin);
    return url.origin === origin && (url.protocol === 'https:' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}
/**
 * Builds the plain-text message. The only URL is the app origin plus a fixed path chosen from the
 * event kind; every other piece of text is sanitized field by field.
 */
export function formatNotification(event: NotificationEvent, appOrigin: string) {
  if (!validAppOrigin(appOrigin)) throw new Error('Valid APP_ORIGIN required');
  const body = truncate(
    bodyLines(event)
      .map((line) => sanitizeNotificationText(line, maximumBodyLength))
      .filter(Boolean)
      .join('\n'),
    maximumBodyLength,
  );
  const path = Object.hasOwn(screenPaths, event.kind) ? screenPaths[event.kind] : '/';
  const mode =
    'mode' in event && (event.mode === 'live' || event.mode === 'paper') ? event.mode : undefined;
  return { kind: event.kind, mode, message: `${body}\n화면: ${appOrigin}${path}` };
}

// ---------------------------------------------------------------------------
// Telegram transport (Bot API sendMessage; checked 2026-10-21).
// ---------------------------------------------------------------------------
export interface Notifier {
  send(message: string): Promise<void>;
}
export class NotificationDeliveryError extends Error {
  constructor(public code: DeliveryFailureCode) {
    // Only a fixed code: never request URLs (the bot token is in the path), bodies or provider text.
    super(code);
    this.name = 'NotificationDeliveryError';
  }
}
export interface TelegramConfig {
  botToken: string;
  chatId: string;
  transport?: typeof fetch;
  timeoutMs?: number;
}
const telegramHost = 'https://api.telegram.org';
const maximumResponseBytes = 64 * 1024;
const maximumTelegramText = 4000; // API limit is 4096 characters; keep headroom.
const tokenPattern = /^\d{3,20}:[A-Za-z0-9_-]{20,128}$/;
const chatIdPattern = /^-?\d{1,19}$/;
export function validTelegramConfig(botToken: unknown, chatId: unknown) {
  return (
    typeof botToken === 'string' &&
    tokenPattern.test(botToken) &&
    typeof chatId === 'string' &&
    chatIdPattern.test(chatId)
  );
}
async function readLimited(response: Response) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximumResponseBytes)) {
    await response.body?.cancel();
    throw new NotificationDeliveryError('TELEGRAM_RESPONSE_INVALID');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumResponseBytes) {
        await reader.cancel();
        throw new NotificationDeliveryError('TELEGRAM_RESPONSE_INVALID');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}
export class TelegramNotifier implements Notifier {
  // Private fields are not enumerable, so the token cannot leak through JSON or inspection.
  readonly #botToken: string;
  readonly #chatId: number | string;
  readonly #transport: typeof fetch;
  readonly #timeoutMs: number;
  constructor(config: TelegramConfig) {
    if (!validTelegramConfig(config.botToken, config.chatId))
      throw new Error('Invalid Telegram configuration');
    this.#botToken = config.botToken;
    // sendMessage accepts chat_id as Integer or String; use an integer when it is exactly safe.
    const numeric = Number(config.chatId);
    this.#chatId = Number.isSafeInteger(numeric) ? numeric : config.chatId;
    this.#transport = config.transport ?? fetch;
    this.#timeoutMs = config.timeoutMs ?? 8000;
  }
  async send(message: string): Promise<void> {
    if (typeof message !== 'string' || !message.trim() || message.length > maximumTelegramText)
      throw new NotificationDeliveryError('MESSAGE_INVALID');
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    let raw: string;
    try {
      response = await this.#transport(`${telegramHost}/bot${this.#botToken}/sendMessage`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'Content-Type': 'application/json' },
        // Documented sendMessage parameters only. No parse_mode: plain text cannot carry markup.
        body: JSON.stringify({
          chat_id: this.#chatId,
          text: message,
          link_preview_options: { is_disabled: true },
        }),
      });
      if (response.redirected) {
        await response.body?.cancel();
        throw new NotificationDeliveryError('TELEGRAM_RESPONSE_INVALID');
      }
      raw = await readLimited(response);
    } catch (error) {
      if (error instanceof NotificationDeliveryError) throw error;
      const name = error instanceof Error ? error.name : '';
      throw new NotificationDeliveryError(
        signal.aborted || name === 'TimeoutError' || name === 'AbortError'
          ? 'TELEGRAM_TIMEOUT'
          : 'TELEGRAM_UNREACHABLE',
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = undefined;
    }
    const ok =
      payload && typeof payload === 'object' ? (payload as { ok?: unknown }).ok : undefined;
    if (typeof ok !== 'boolean') throw new NotificationDeliveryError('TELEGRAM_RESPONSE_INVALID');
    if (ok && response.ok) return;
    // error_code and description are not trusted or stored; the HTTP status is enough to classify.
    throw new NotificationDeliveryError(
      response.status === 429 ? 'TELEGRAM_RATE_LIMITED' : 'TELEGRAM_REJECTED',
    );
  }
}
/** Mirrors tossFromEnvironment: token and chat ID come from the environment only. */
export function notifierFromEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const { TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_CHAT_ID: chatId } = env;
  // Missing or malformed values disable delivery (recorded as "disabled") instead of failing boot.
  if (!validTelegramConfig(botToken, chatId)) return undefined;
  return new TelegramNotifier({ botToken: botToken!, chatId: chatId! });
}

// ---------------------------------------------------------------------------
// Repository.
// ---------------------------------------------------------------------------
export interface NotificationRepository {
  create(record: NotificationRecord): Promise<void>;
  update(
    id: string,
    patch: { status: NotificationStatus; failureCode?: DeliveryFailureCode },
  ): Promise<void>;
  listRecent(limit: number): Promise<NotificationRecord[]>;
}
export const notificationRetentionDays = 90;
const maximumMemoryRecords = 500;
const kinds = Object.keys(screenPaths);
const statuses: NotificationStatus[] = ['pending', 'sent', 'failed', 'disabled'];
function project(input: unknown): NotificationRecord | null {
  if (!input || typeof input !== 'object') return null;
  const item = input as Record<string, unknown>;
  if (
    typeof item.id !== 'string' ||
    typeof item.kind !== 'string' ||
    !kinds.includes(item.kind) ||
    typeof item.createdAt !== 'string' ||
    typeof item.message !== 'string' ||
    typeof item.status !== 'string' ||
    !statuses.includes(item.status as NotificationStatus)
  )
    return null;
  // Explicit projection: nothing but these fields ever leaves the repository.
  return {
    id: item.id,
    kind: item.kind as NotificationKind,
    ...(item.mode === 'paper' || item.mode === 'live' ? { mode: item.mode } : {}),
    createdAt: item.createdAt,
    status: item.status as NotificationStatus,
    ...(typeof item.failureCode === 'string'
      ? { failureCode: item.failureCode as DeliveryFailureCode }
      : {}),
    message: item.message,
  };
}
export class MemoryNotificationRepository implements NotificationRepository {
  private records: NotificationRecord[] = [];
  async create(record: NotificationRecord) {
    this.records.push(structuredClone(record));
    if (this.records.length > maximumMemoryRecords) this.records.shift();
  }
  async update(
    id: string,
    patch: { status: NotificationStatus; failureCode?: DeliveryFailureCode },
  ) {
    const record = this.records.find((item) => item.id === id);
    if (!record) return;
    record.status = patch.status;
    if (patch.failureCode) record.failureCode = patch.failureCode;
    else delete record.failureCode;
  }
  async listRecent(limit: number) {
    return structuredClone(
      this.records
        .map((record, index) => ({ record, index }))
        .sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt) || b.index - a.index)
        .slice(0, limit)
        .map(({ record }) => record),
    );
  }
}
export class FirestoreNotificationRepository implements NotificationRepository {
  constructor(private db = new Firestore()) {}
  async create(record: NotificationRecord) {
    await this.db
      .collection('notifications')
      .doc(record.id)
      .set({
        ...record,
        ttlAt: Timestamp.fromMillis(
          Date.parse(record.createdAt) + notificationRetentionDays * 86400000,
        ),
      });
  }
  async update(
    id: string,
    patch: { status: NotificationStatus; failureCode?: DeliveryFailureCode },
  ) {
    await this.db
      .collection('notifications')
      .doc(id)
      .update({ status: patch.status, failureCode: patch.failureCode ?? null });
  }
  async listRecent(limit: number) {
    const snapshot = await this.db
      .collection('notifications')
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs
      .map((doc) => project({ ...doc.data(), failureCode: doc.data().failureCode ?? undefined }))
      .filter((record): record is NotificationRecord => record !== null);
  }
}

// ---------------------------------------------------------------------------
// Service: record first, then deliver; never throws to the caller.
// ---------------------------------------------------------------------------
export interface NotifyOutcome {
  status: Exclude<NotificationStatus, 'pending'>;
  failureCode?: DeliveryFailureCode;
  recorded: boolean;
}
export interface NotificationServiceOptions {
  repository: NotificationRepository;
  notifier?: Notifier;
  appOrigin: string;
  now?: () => Date;
  newId?: () => string;
}
export class NotificationService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  constructor(private readonly options: NotificationServiceOptions) {
    if (!validAppOrigin(options.appOrigin)) throw new Error('Valid APP_ORIGIN required');
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }
  /** True when a Telegram notifier is configured (alerts can actually be delivered). */
  configured(): boolean {
    return this.options.notifier !== undefined;
  }
  async notify(event: NotificationEvent): Promise<NotifyOutcome> {
    let formatted: ReturnType<typeof formatNotification>;
    try {
      formatted = formatNotification(event, this.options.appOrigin);
    } catch {
      return { status: 'failed', failureCode: 'MESSAGE_INVALID', recorded: false };
    }
    const { notifier, repository } = this.options;
    const record: NotificationRecord = {
      id: this.newId(),
      kind: formatted.kind,
      ...(formatted.mode ? { mode: formatted.mode } : {}),
      createdAt: this.now().toISOString(),
      status: notifier ? 'pending' : 'disabled',
      ...(notifier ? {} : { failureCode: 'NOT_CONFIGURED' as const }),
      message: formatted.message,
    };
    let recorded = true;
    try {
      await repository.create(record);
    } catch {
      recorded = false;
    }
    if (!notifier) return { status: 'disabled', failureCode: 'NOT_CONFIGURED', recorded };
    let outcome: NotifyOutcome;
    try {
      await notifier.send(formatted.message);
      outcome = { status: 'sent', recorded };
    } catch (error) {
      outcome = {
        status: 'failed',
        failureCode: error instanceof NotificationDeliveryError ? error.code : 'DELIVERY_ERROR',
        recorded,
      };
    }
    if (recorded) {
      try {
        await repository.update(record.id, {
          status: outcome.status,
          ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
        });
      } catch {
        outcome.recorded = false;
      }
    }
    return outcome;
  }
}

// ---------------------------------------------------------------------------
// Router: owner-only recent notification list.
// ---------------------------------------------------------------------------
const defaultLimit = 20;
const maximumLimit = 50;
export function createNotificationsRouter({
  repository,
  ownerUserId,
}: {
  repository: NotificationRepository;
  ownerUserId: string;
}) {
  const router = Router();
  router.use('/api/notifications', (_req, res, next) => {
    if (!res.locals.user || res.locals.user.active === false) {
      res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: '로그인이 필요합니다.' } });
      return;
    }
    if (!ownerUserId || res.locals.user.id !== ownerUserId) {
      res
        .status(403)
        .json({ error: { code: 'OWNER_REQUIRED', message: '소유자 권한이 필요합니다.' } });
      return;
    }
    next();
  });
  router.get('/api/notifications', async (req, res) => {
    const query = req.query;
    const keys = Object.keys(query);
    const raw = query.limit;
    if (
      keys.some((key) => key !== 'limit') ||
      (raw !== undefined &&
        (typeof raw !== 'string' ||
          !/^\d{1,3}$/.test(raw) ||
          Number(raw) < 1 ||
          Number(raw) > maximumLimit))
    ) {
      res.status(400).json({
        error: {
          code: 'INVALID_NOTIFICATION_QUERY',
          message: `limit은 1~${maximumLimit} 사이 정수로 입력하세요.`,
        },
      });
      return;
    }
    const limit = raw === undefined ? defaultLimit : Number(raw);
    try {
      const notifications = await repository.listRecent(limit);
      res.set('Cache-Control', 'no-store');
      res.json({ notifications: notifications.slice(0, limit), limit });
    } catch {
      res.status(503).json({
        error: { code: 'NOTIFICATIONS_UNAVAILABLE', message: '알림 목록을 불러오지 못했습니다.' },
      });
    }
  });
  return router;
}
