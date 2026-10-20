import { createHash, randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';

const BASE = 'https://openapi.tossinvest.com';
export class ProviderError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}
type Token = { value: string; expiresAt: number };
export interface TokenCache {
  get(issue: () => Promise<Token>): Promise<string>;
}
export class MemoryTokenCache implements TokenCache {
  private token?: Token;
  private pending?: Promise<Token>;
  private blockedUntil = 0;
  async get(issue: () => Promise<Token>) {
    if (this.token && this.token.expiresAt > Date.now() + 60000) return this.token.value;
    if (this.blockedUntil > Date.now())
      throw new ProviderError(503, 'PROVIDER_TOKEN_COOLDOWN', '인증 재시도 대기 중입니다.', 60);
    if (!this.pending)
      this.pending = issue()
        .then((token) => {
          this.token = token;
          return token;
        })
        .catch((error) => {
          this.blockedUntil = Date.now() + 60000;
          throw error;
        })
        .finally(() => {
          this.pending = undefined;
        });
    return (await this.pending).value;
  }
}
// Shared lease prevents token issuance races across Cloud Run instances/revisions.
// This server-only collection contains bearer credentials: deny all client SDK access.
export class FirestoreTokenCache implements TokenCache {
  private pending?: Promise<string>;
  private ref;
  constructor(
    clientId: string,
    private db = new Firestore(),
  ) {
    this.ref = db
      .collection('providerTokens')
      .doc(createHash('sha256').update(clientId).digest('hex'));
  }
  get(issue: () => Promise<Token>) {
    if (!this.pending)
      this.pending = this.acquire(issue).finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async acquire(issue: () => Promise<Token>) {
    const owner = randomUUID();
    const cached = await this.db.runTransaction(async (tx) => {
      const state = (await tx.get(this.ref)).data();
      if (typeof state?.value === 'string' && state.expiresAt > Date.now() + 60000)
        return state.value as string;
      if (state?.leaseUntil > Date.now())
        throw new ProviderError(503, 'PROVIDER_TOKEN_BUSY', '인증 갱신 대기 중입니다.', 60);
      tx.set(this.ref, { leaseOwner: owner, leaseUntil: Date.now() + 60000 }, { merge: true });
      return null;
    });
    if (cached) return cached;
    // An uncertain/failed issuance keeps its lease for 60s; never issue automatic retries.
    const token = await issue();
    await this.db.runTransaction(async (tx) => {
      const state = (await tx.get(this.ref)).data();
      if (state?.leaseOwner !== owner || state.leaseUntil <= Date.now())
        throw new ProviderError(503, 'PROVIDER_TOKEN_BUSY', '인증 갱신 대기 중입니다.', 60);
      tx.set(this.ref, { ...token, leaseUntil: 0, leaseOwner: '' });
    });
    return token.value;
  }
}
export type TossConfig = {
  clientId: string;
  clientSecret: string;
  accountSeq: string;
  ownerUserId: string;
};
export type NormalizedHolding = {
  symbol: string;
  name: string;
  market: 'KR' | 'US';
  currency: 'KRW' | 'USD';
  quantity: string;
  lastPrice: string;
  averagePurchasePrice: string;
  marketValue: string;
  profitLoss: string;
  profitLossRate: string;
};
export type PortfolioResponse = {
  source: string;
  asOf: string;
  scope: 'stocks-only';
  totals: Record<
    'KRW' | 'USD',
    { marketValue: string | null; purchaseAmount: string | null; profitLoss: string | null }
  >;
  holdings: NormalizedHolding[];
};
const invalid = () =>
  new ProviderError(502, 'PROVIDER_SCHEMA_INVALID', '제공자 응답 형식을 확인하지 못했습니다.');
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 200): string {
  if (typeof value !== 'string' || value.length > max) throw invalid();
  return value;
}
function decimal(value: unknown): string {
  const result = text(value, 100);
  if (!/^-?\d+(\.\d+)?$/.test(result)) throw invalid();
  return result;
}
function nullableDecimal(value: unknown) {
  return value === null ? null : decimal(value);
}
export function normalizeHoldings(value: unknown): PortfolioResponse {
  const v = record(value);
  if (!Array.isArray(v.items) || v.items.length > 10000) throw invalid();
  const purchase = record(v.totalPurchaseAmount);
  const amounts = record(record(v.marketValue).amount);
  const profits = record(record(v.profitLoss).amount);
  const total = (currency: string) => ({
    marketValue: nullableDecimal(amounts[currency]),
    purchaseAmount: nullableDecimal(purchase[currency]),
    profitLoss: nullableDecimal(profits[currency]),
  });
  const holdings = v.items.map((item) => {
    const h = record(item);
    if (
      !['KR', 'US'].includes(h.marketCountry as string) ||
      !['KRW', 'USD'].includes(h.currency as string)
    )
      throw invalid();
    return {
      symbol: text(h.symbol, 30),
      name: text(h.name),
      market: h.marketCountry as 'KR' | 'US',
      currency: h.currency as 'KRW' | 'USD',
      quantity: decimal(h.quantity),
      lastPrice: decimal(h.lastPrice),
      averagePurchasePrice: decimal(h.averagePurchasePrice),
      marketValue: decimal(record(h.marketValue).amount),
      profitLoss: decimal(record(h.profitLoss).amount),
      profitLossRate: decimal(record(h.profitLoss).rate),
    };
  });
  return {
    source: 'Toss Securities OpenAPI',
    asOf: new Date().toISOString(),
    scope: 'stocks-only',
    totals: { KRW: total('krw'), USD: total('usd') },
    holdings,
  };
}
export class TossClient {
  private cooldownUntil = 0;
  private reads = new Map<string, { expiresAt: number; value: unknown }>();
  private pending = new Map<string, Promise<unknown>>();
  constructor(
    private config: TossConfig,
    private tokens: TokenCache,
    private transport: typeof fetch = fetch,
  ) {
    if (
      !config.clientId ||
      !config.clientSecret ||
      !/^\d{1,15}$/.test(config.accountSeq) ||
      !config.ownerUserId
    )
      throw new Error('Invalid Toss configuration');
  }
  private async request(path: string, init: RequestInit = {}) {
    if (this.cooldownUntil > Date.now())
      throw new ProviderError(
        503,
        'PROVIDER_RATE_LIMITED',
        '제공자 요청 한도로 잠시 대기해야 합니다.',
        Math.ceil((this.cooldownUntil - Date.now()) / 1000),
      );
    let response: Response;
    try {
      response = await this.transport(BASE + path, {
        ...init,
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
    } catch {
      throw new ProviderError(503, 'PROVIDER_UNREACHABLE', '금융 제공자에 연결할 수 없습니다.');
    }
    if (!response.ok) {
      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        this.cooldownUntil =
          Date.now() +
          (Number.isInteger(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 60) * 1000;
        throw new ProviderError(
          503,
          'PROVIDER_RATE_LIMITED',
          '제공자 요청 한도로 잠시 대기해야 합니다.',
          Number.isInteger(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 60,
        );
      }
      throw new ProviderError(
        503,
        response.status === 401 || response.status === 403
          ? 'PROVIDER_ACCESS_DENIED'
          : 'PROVIDER_UNAVAILABLE',
        '제공자 인증·허용 IP·서비스 상태를 확인하세요.',
      );
    }
    try {
      const reader = response.body?.getReader();
      if (!reader) throw invalid();
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          throw invalid();
        }
        chunks.push(value);
      }
      return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      throw invalid();
    }
  }
  private async bearer() {
    return this.tokens.get(async () => {
      const result = await this.request('/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
      });
      if (
        typeof result.access_token !== 'string' ||
        !result.access_token ||
        result.access_token.length > 16384 ||
        result.token_type !== 'Bearer' ||
        typeof result.expires_in !== 'number' ||
        !Number.isInteger(result.expires_in) ||
        result.expires_in <= 60 ||
        result.expires_in > 604800
      )
        throw invalid();
      return { value: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };
    });
  }
  private async get(path: string, account = false) {
    return (
      await this.request(path, {
        headers: {
          Authorization: `Bearer ${await this.bearer()}`,
          ...(account ? { 'X-Tossinvest-Account': this.config.accountSeq } : {}),
        },
      })
    ).result;
  }
  private async cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    const cached = this.reads.get(key);
    if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.value) as T;
    let pending = this.pending.get(key);
    if (!pending) {
      if (this.pending.size >= 32)
        throw new ProviderError(
          503,
          'PROVIDER_BUSY',
          '조회 요청이 많습니다. 잠시 후 시도하세요.',
          30,
        );
      pending = read()
        .then((value) => {
          if (this.reads.size >= 100) this.reads.delete(this.reads.keys().next().value!);
          this.reads.set(key, { value, expiresAt: Date.now() + 30000 });
          return value;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return structuredClone(await pending) as T;
  }
  // Setup job only: share the production bearer lease and never expose raw account data.
  async discoverBrokerageAccountSeq(): Promise<string> {
    const accounts = await this.get('/api/v1/accounts');
    if (!Array.isArray(accounts) || accounts.length > 1000) throw invalid();
    const brokerage = accounts.filter((value) => record(value).accountType === 'BROKERAGE');
    if (brokerage.length !== 1)
      throw new ProviderError(
        503,
        brokerage.length === 0
          ? 'PROVIDER_ACCOUNT_UNAVAILABLE'
          : 'PROVIDER_ACCOUNT_SELECTION_REQUIRED',
        '자동 연결할 단일 거래 계좌를 확인하지 못했습니다.',
      );
    const seq = record(brokerage[0]).accountSeq;
    // Official schema is integer/int64. Reject lossy JS numbers and unexpected strings.
    if (
      typeof seq !== 'number' ||
      !Number.isSafeInteger(seq) ||
      seq <= 0 ||
      String(seq).length > 15
    )
      throw invalid();
    return String(seq);
  }
  async portfolio(userId: string) {
    if (userId !== this.config.ownerUserId)
      throw new ProviderError(403, 'PORTFOLIO_OWNER_REQUIRED', '이 계정에 연결된 자산이 없습니다.');
    return this.cached('portfolio', async () => {
      const accounts = await this.get('/api/v1/accounts');
      if (
        !Array.isArray(accounts) ||
        !accounts.some((a) => {
          const account = record(a);
          return (
            String(account.accountSeq) === this.config.accountSeq &&
            account.accountType === 'BROKERAGE'
          );
        })
      )
        throw new ProviderError(
          503,
          'PROVIDER_ACCOUNT_UNAVAILABLE',
          '연결된 거래 계좌를 확인하세요.',
        );
      return normalizeHoldings(await this.get('/api/v1/holdings', true));
    });
  }
  async candles(symbol: string, interval: string, count: number) {
    if (
      !/^[A-Za-z0-9.\-]{1,30}$/.test(symbol) ||
      !['1m', '1d'].includes(interval) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 200
    )
      throw new ProviderError(400, 'INVALID_MARKET_QUERY', '종목·주기·조회 개수를 확인하세요.');
    const query = new URLSearchParams({ symbol, interval, count: String(count), adjusted: 'true' });
    return this.cached(`candles:${query}`, async () => {
      const result = record(await this.get(`/api/v1/candles?${query}`));
      if (!Array.isArray(result.candles) || result.candles.length > 200) throw invalid();
      const candles = result.candles.map((value) => {
        const c = record(value);
        const timestamp = text(c.timestamp, 50);
        if (
          !Number.isFinite(Date.parse(timestamp)) ||
          !['KRW', 'USD'].includes(c.currency as string)
        )
          throw invalid();
        return {
          timestamp,
          open: decimal(c.openPrice),
          high: decimal(c.highPrice),
          low: decimal(c.lowPrice),
          close: decimal(c.closePrice),
          volume: decimal(c.volume),
          currency: c.currency as string,
        };
      });
      return {
        source: 'Toss Securities OpenAPI',
        asOf: new Date().toISOString(),
        symbol,
        interval,
        adjusted: true,
        candles: candles.reverse(),
      };
    });
  }
}
export function tossFromEnvironment(production: boolean) {
  const {
    TOSS_CLIENT_ID: clientId,
    TOSS_CLIENT_SECRET: clientSecret,
    TOSS_ACCOUNT_SEQ: accountSeq,
    TOSS_OWNER_USER_ID: ownerUserId,
  } = process.env;
  if (!clientId || !clientSecret || !accountSeq || !ownerUserId) return undefined;
  return new TossClient(
    { clientId, clientSecret, accountSeq, ownerUserId },
    production ? new FirestoreTokenCache(clientId) : new MemoryTokenCache(),
  );
}
