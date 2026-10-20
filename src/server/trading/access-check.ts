import { OrderApiError, type TossOrderReads } from './toss-orders.js';

/**
 * Read-only order-API access check (design "주문 권한 확인" step 1; plan stage 7d). UNWIRED.
 *
 * It calls only GET buying-power (KRW, USD), GET commissions and GET orders?status=OPEN. The
 * parameter type is `Pick<TossOrderReads, ...>`, so a client's write methods are not even
 * reachable from here, and the tests prove no POST ever reaches the transport. Nothing from a
 * response body is returned: no amounts, no account identifiers, no raw errors — only booleans and
 * sanitized codes.
 */
export type AccessProbe = {
  ok: boolean;
  /** Sanitized code when not ok: a provider code like `forbidden`, `http-403`, `network-error`. */
  code?: string;
  status?: number | null;
};
export type OrderAccessReport = {
  checkedAt: string;
  buyingPowerKrw: AccessProbe;
  buyingPowerUsd: AccessProbe;
  commissions: AccessProbe;
  openOrders: AccessProbe;
  /** True only when every probe succeeded. */
  allOk: boolean;
  /** True when any probe was refused with 401/403 (credentials or permission). */
  permissionDenied: boolean;
};

type ReadOnlyOrderApi = Pick<TossOrderReads, 'getBuyingPower' | 'getCommissions' | 'listOrders'>;

async function probe(call: () => Promise<unknown>): Promise<AccessProbe> {
  try {
    await call();
    return { ok: true };
  } catch (error) {
    if (error instanceof OrderApiError)
      return { ok: false, code: error.info.code, status: error.info.status };
    // Local input errors and anything unexpected: a fixed code, never the message.
    return { ok: false, code: 'check-error', status: null };
  }
}

export async function checkOrderAccess(
  api: ReadOnlyOrderApi,
  now: () => Date = () => new Date(),
): Promise<OrderAccessReport> {
  // Sequential on purpose: four small reads, no burst against the rate limiter.
  const buyingPowerKrw = await probe(() => api.getBuyingPower('KRW'));
  const buyingPowerUsd = await probe(() => api.getBuyingPower('USD'));
  const commissions = await probe(() => api.getCommissions());
  const openOrders = await probe(() => api.listOrders({ status: 'OPEN' }));
  const probes = [buyingPowerKrw, buyingPowerUsd, commissions, openOrders];
  return {
    checkedAt: now().toISOString(),
    buyingPowerKrw,
    buyingPowerUsd,
    commissions,
    openOrders,
    allOk: probes.every((p) => p.ok),
    permissionDenied: probes.some((p) => p.status === 401 || p.status === 403),
  };
}
