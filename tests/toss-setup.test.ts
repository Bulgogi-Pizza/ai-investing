import { describe, expect, it, vi } from 'vitest';
import {
  discoverAndStore,
  safeSetupFailureCode,
  setupConfiguration,
  storeAccountSeq,
} from '../src/server/toss-setup';
import { MemoryTokenCache, ProviderError, TossClient } from '../src/server/toss';

const env = {
  NODE_ENV: 'production',
  CLOUD_RUN_JOB: 'fixture-discovery',
  GOOGLE_CLOUD_PROJECT: 'fixture-project',
  TOSS_CLIENT_ID: 'fixture-client',
  TOSS_CLIENT_SECRET: 'fixture-secret',
};
function clientFor(result: unknown) {
  const transport = vi.fn(async (url: string | URL | Request) =>
    String(url).endsWith('/oauth2/token')
      ? Response.json({ access_token: 'fixture-token', token_type: 'Bearer', expires_in: 86400 })
      : Response.json({ result }),
  ) as unknown as typeof fetch;
  return {
    transport,
    client: new TossClient(
      {
        clientId: 'fixture',
        clientSecret: 'fixture',
        accountSeq: '0',
        ownerUserId: 'setup-discovery',
      },
      new MemoryTokenCache(),
      transport,
    ),
  };
}
describe('one-off private Toss account discovery job', () => {
  it('requires explicit production Cloud Run job and project, with no default identity fallback', () => {
    expect(setupConfiguration(env).project).toBe('fixture-project');
    for (const field of [
      'NODE_ENV',
      'CLOUD_RUN_JOB',
      'GOOGLE_CLOUD_PROJECT',
      'TOSS_CLIENT_ID',
      'TOSS_CLIENT_SECRET',
    ])
      expect(() => setupConfiguration({ ...env, [field]: '' })).toThrow('TOSS_SETUP_FAILED');
    expect(() => setupConfiguration({ ...env, GOOGLE_CLOUD_PROJECT: '../other' })).toThrow();
  });
  it('returns only the single valid brokerage seq without sending an account header', async () => {
    const { client, transport } = clientFor([
      { accountSeq: 123, accountType: 'BROKERAGE', accountNo: 'private-fixture' },
      { accountSeq: 456, accountType: 'PENSION_SAVINGS', accountNo: 'private-fixture' },
    ]);
    expect(await client.discoverBrokerageAccountSeq()).toBe('123');
    const request = vi.mocked(transport).mock.calls[1];
    expect(String(request[0])).toBe('https://openapi.tossinvest.com/api/v1/accounts');
    expect(request[1]?.headers).toEqual({ Authorization: 'Bearer fixture-token' });
  });
  it.each([
    [],
    [{ accountSeq: 1, accountType: 'PENSION_SAVINGS' }],
    [
      { accountSeq: 1, accountType: 'BROKERAGE' },
      { accountSeq: 2, accountType: 'BROKERAGE' },
    ],
    [{ accountSeq: '1', accountType: 'BROKERAGE' }],
    [{ accountSeq: 0, accountType: 'BROKERAGE' }],
    [{ accountSeq: -1, accountType: 'BROKERAGE' }],
    [{ accountSeq: 1.5, accountType: 'BROKERAGE' }],
    [{ accountSeq: 1000000000000000, accountType: 'BROKERAGE' }],
    [{ accountSeq: 9007199254740992, accountType: 'BROKERAGE' }],
    [null],
    {},
  ])('fails closed for empty, ambiguous or malformed account results %#', async (result) => {
    const { client } = clientFor(result);
    await expect(client.discoverBrokerageAccountSeq()).rejects.toThrow();
  });
  it('writes only to the fixed secret within the explicit project, with bounded request', async () => {
    const transport = vi.fn(async () =>
      Response.json({ name: 'not-read' }),
    ) as unknown as typeof fetch;
    await storeAccountSeq('fixture-project', '123', async () => 'fixture-google-token', transport);
    const [url, request] = vi.mocked(transport).mock.calls[0];
    expect(url).toBe(
      'https://secretmanager.googleapis.com/v1/projects/fixture-project/secrets/investing-toss-account-seq:addVersion',
    );
    expect(request).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: 'Bearer fixture-google-token' },
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      payload: { data: Buffer.from('123').toString('base64') },
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    await expect(
      storeAccountSeq('../other', '123', async () => 'token', transport),
    ).rejects.toThrow('TOSS_SETUP_FAILED');
    await expect(
      storeAccountSeq('fixture-project', '0', async () => 'token', transport),
    ).rejects.toThrow('TOSS_SETUP_FAILED');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('never returns account data and sanitizes upstream failures', async () => {
    const store = vi.fn(async () => undefined);
    expect(await discoverAndStore(async () => '123', store)).toEqual({
      accountDiscovered: true,
      accountSeqStored: true,
    });
    expect(store).toHaveBeenCalledWith('123');
    const failing = vi.fn(async () => {
      throw new Error('private-fixture-provider-body');
    });
    await expect(discoverAndStore(failing, store)).rejects.toThrow(/^TOSS_SETUP_FAILED$/);
    expect(store).toHaveBeenCalledTimes(1);
    const transport = vi.fn(
      async () => new Response('private-fixture-secret-body', { status: 403 }),
    ) as unknown as typeof fetch;
    await expect(
      storeAccountSeq('fixture-project', '123', async () => 'fixture-token', transport),
    ).rejects.toThrow(/^TOSS_SETUP_SECRET_STORE_FAILED$/);
  });
  it('logs only whitelisted fixed error codes, never arbitrary codes, messages or objects', async () => {
    for (const code of [
      'PROVIDER_ACCESS_DENIED',
      'PROVIDER_ACCOUNT_UNAVAILABLE',
      'PROVIDER_ACCOUNT_SELECTION_REQUIRED',
    ]) {
      const error = new ProviderError(503, code, 'private-fixture-error-body');
      await expect(
        discoverAndStore(
          async () => {
            throw error;
          },
          async () => {},
        ),
      ).rejects.toBe(error);
      expect(safeSetupFailureCode(error)).toBe(code);
    }
    expect(safeSetupFailureCode(new ProviderError(503, 'private-fixture-code', 'body'))).toBe(
      'TOSS_SETUP_FAILED',
    );
    expect(safeSetupFailureCode({ code: 'PROVIDER_ACCESS_DENIED' })).toBe('TOSS_SETUP_FAILED');
    expect(safeSetupFailureCode(new Error('private-fixture-error-body'))).toBe('TOSS_SETUP_FAILED');
    try {
      await storeAccountSeq('fixture-project', '123', async () => null);
    } catch (error) {
      expect(safeSetupFailureCode(error)).toBe('TOSS_SETUP_SECRET_STORE_FAILED');
    }
  });
});
