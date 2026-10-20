import type { NotificationEvent } from '../notify.js';
import type { TradeSide } from './toss-orders.js';

/**
 * The ONE place where live-trading situations are mapped to notification events. Stage 7e adds a
 * dedicated `live-order-unconfirmed` event kind and a permission-stop reason to `notify.ts`; only
 * this function has to change then. Until then:
 * - "sent but unconfirmed" is surfaced as a `job-failure`,
 * - a permission/first-order stop is an `algorithm-auto-stop` without a reason,
 * - a purely local input failure is a `job-failure`.
 * Events carry no amounts, quantities, account identifiers or provider text (the notify module
 * has no field for them).
 */
export type { NotificationEvent };

export type LiveAlert =
  | { type: 'safety-guard-refusal'; symbol: string; side: TradeSide; algorithmName: string }
  | { type: 'broker-rejected'; symbol: string; side: TradeSide; algorithmName: string }
  | {
      type: 'algorithm-stopped';
      why: 'loss-limit' | 'order-permission' | 'first-order-rejected';
      algorithmName: string;
    }
  | { type: 'order-unconfirmed' }
  | { type: 'local-input-failure' }
  | {
      type: 'fill';
      symbol: string;
      side: TradeSide;
      status: 'filled' | 'partially-filled';
      algorithmName: string;
    };

export function liveAlertEvent(alert: LiveAlert): NotificationEvent {
  switch (alert.type) {
    case 'safety-guard-refusal':
      return {
        kind: 'order-rejected',
        mode: 'live',
        symbol: alert.symbol,
        side: alert.side,
        algorithmName: alert.algorithmName,
        reason: 'safety-guard',
      };
    case 'broker-rejected':
      return {
        kind: 'order-rejected',
        mode: 'live',
        symbol: alert.symbol,
        side: alert.side,
        algorithmName: alert.algorithmName,
        reason: 'broker-rejected',
      };
    case 'algorithm-stopped':
      return {
        kind: 'algorithm-auto-stop',
        mode: 'live',
        algorithmName: alert.algorithmName,
        ...(alert.why === 'loss-limit' ? { reason: 'loss-limit' as const } : {}),
      };
    case 'order-unconfirmed':
      return { kind: 'job-failure', jobName: 'live-order-unconfirmed' };
    case 'local-input-failure':
      return { kind: 'job-failure', jobName: 'live-order-input-invalid' };
    case 'fill':
      return {
        kind: 'fill',
        mode: 'live',
        symbol: alert.symbol,
        side: alert.side,
        status: alert.status,
        algorithmName: alert.algorithmName,
      };
  }
}
