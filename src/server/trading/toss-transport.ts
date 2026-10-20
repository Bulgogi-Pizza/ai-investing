import {
  TransportNetworkError,
  type OrderTransport,
  type TransportRequest,
} from './toss-orders.js';
import type { TossClient } from '../toss.js';

/**
 * `OrderTransport` over the existing Toss authentication (plan stage 7e). The order client owns
 * retry, idempotency and error interpretation; this adapter owns the wire:
 *
 * - fixed host and bearer + `X-Tossinvest-Account` (both inside `TossClient.authorizedRequest`);
 * - HTTP error statuses are RETURNED with their parsed body (the order client reads documented error
 *   fields such as the tick-size `data`); only "no response" throws `TransportNetworkError`;
 * - never retries, never logs, never keeps a body, header or token;
 * - an explicit allow-list of method + path pairs: anything else is refused before a token is even
 *   requested. Order creation is the only write; there is no cancel path (nothing in the live flow
 *   cancels an order), so a bug elsewhere cannot cancel or place anything through a path that is not
 *   listed here;
 * - a minimum interval between calls keeps a burst of reads from hitting the provider rate limit
 *   (a rate-limit answer is a refusal, never something this adapter retries).
 */
const ORDER_ID = '[A-Za-z0-9_\\-=.~%]{1,256}';
const SYMBOL = '[A-Za-z0-9.\\-]{1,30}';
const READ_PATHS: readonly RegExp[] = [
  /^\/api\/v1\/orders$/,
  new RegExp(`^/api/v1/orders/${ORDER_ID}$`),
  /^\/api\/v1\/buying-power$/,
  /^\/api\/v1\/sellable-quantity$/,
  /^\/api\/v1\/commissions$/,
  new RegExp(`^/api/v1/stocks/${SYMBOL}/warnings$`),
  /^\/api\/v1\/price-limits$/,
  /^\/api\/v1\/exchange-rate$/,
  /^\/api\/v1\/prices$/,
];
const CREATE_ORDER_PATH = /^\/api\/v1\/orders$/;

/** True for exactly the requests this adapter may send. */
export function transportAllows(request: TransportRequest): boolean {
  if (!request || typeof request.path !== 'string') return false;
  if (request.path.split('/').some((segment) => segment === '.' || segment === '..')) return false;
  if (request.method === 'GET')
    return request.body === undefined && READ_PATHS.some((p) => p.test(request.path));
  if (request.method === 'POST')
    return CREATE_ORDER_PATH.test(request.path) && request.query === undefined;
  return false;
}

export type TossTransportOptions = {
  /** Per-request timeout. Default 8 s (the provider adapter's own limit). */
  timeoutMs?: number;
  /** Response size cap. Default 1 MiB. */
  maxBytes?: number;
  /** Minimum delay between two calls. Default 120 ms. */
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export class TossOrderTransport implements OrderTransport {
  private last = 0;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(
    private readonly client: Pick<TossClient, 'authorizedRequest'>,
    options: TossTransportOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    this.minIntervalMs = options.minIntervalMs ?? 120;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async send(request: TransportRequest) {
    // A request outside the allow-list is a programming error. It is reported like "no response" so
    // the order client treats a write as unconfirmed (it can never be sent anyway).
    if (!transportAllows(request)) throw new TransportNetworkError();
    const wait = this.last + this.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.last = this.now();
    try {
      const response = await this.client.authorizedRequest(
        {
          method: request.method,
          path: request.path,
          ...(request.query ? { query: request.query } : {}),
          ...(request.body ? { body: request.body } : {}),
        },
        { timeoutMs: this.timeoutMs, maxBytes: this.maxBytes },
      );
      return {
        status: response.status,
        body: response.body,
        retryAfterSeconds: response.retryAfterSeconds,
      };
    } catch {
      // Connection failure, timeout, oversized or unreadable body, token unavailable: no usable
      // response. Nothing about the failure (it may contain URLs) is kept.
      throw new TransportNetworkError();
    }
  }
}
