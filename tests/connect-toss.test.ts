import { describe, expect, it } from 'vitest';
import { ConnectionError, connectToss } from '../scripts/connect-toss.mjs';

const config = {
  account: 'operator@example.test',
  project: 'personal-test-123',
  userId: 'owner-1',
};
const image = `asia-northeast3-docker.pkg.dev/personal-test-123/ai-investing/app@sha256:${'a'.repeat(64)}`;

function fakeCloud({ ip = '203.0.113.10', jobFails = false } = {}) {
  const calls: string[][] = [];
  const runner = (argv: string[]) => {
    calls.push(argv);
    const command = argv.slice(0, 3).join(' ');
    const format = argv.find((arg) => arg.startsWith('--format=')) ?? '';
    if (command === 'secrets versions list') {
      if (argv[3].endsWith('owner-user-id') && !calls.some((c) => c[2] === 'add')) return '';
      return `projects/1/secrets/${argv[3]}/versions/1\n`;
    }
    if (command === 'secrets versions access') return config.userId;
    if (command === 'secrets versions add') return '';
    if (command === 'run services describe')
      return format.includes('latestReadyRevisionName') ? 'rev-1 rev-1\n' : `${image}\n`;
    if (command === 'compute addresses describe') return `${ip}\n`;
    if (command === 'run jobs deploy') {
      if (jobFails) throw new Error('provider detail must stay hidden');
      return '';
    }
    if (command === 'run services update') return '';
    throw new Error(`unexpected ${command}`);
  };
  return { calls, runner };
}

describe('connect-toss operator guidance', () => {
  it('shows the allowlist IP and the next step after preflight', () => {
    const { runner, calls } = fakeCloud();
    const progress: string[] = [];
    expect(
      connectToss(config, { runner, progress: (line: string) => progress.push(line) }),
    ).toEqual({
      preflight: true,
      executed: false,
    });
    expect(progress[0]).toContain('[3/5]');
    expect(progress.join('\n')).toContain('203.0.113.10');
    expect(progress.at(-1)).toContain('[4/5]');
    expect(progress.at(-1)).toContain('--execute');
    expect(calls.every((argv) => argv.includes('--account=operator@example.test'))).toBe(true);
    expect(calls.some((argv) => argv[2] === 'add' || argv[1] === 'jobs')).toBe(false);
  });

  it('rejects a missing or non-IPv4 egress address before any change', () => {
    for (const ip of ['', '2001:db8::1', 'not-an-ip']) {
      const { runner } = fakeCloud({ ip });
      expect(() => connectToss(config, { runner, execute: true, progress: () => {} })).toThrow(
        ConnectionError,
      );
    }
  });

  it('points to the allowlist IP when the discovery job fails and leaves the service untouched', () => {
    const { runner, calls } = fakeCloud({ jobFails: true });
    let failure: unknown;
    try {
      connectToss(config, { runner, execute: true, progress: () => {} });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ConnectionError);
    expect(String(failure)).toContain('203.0.113.10');
    expect(String(failure)).not.toContain('provider detail');
    expect(calls.some((argv) => argv[1] === 'services' && argv[2] === 'update')).toBe(false);
  });

  it('ends with the login verification step after a successful connection', () => {
    const { runner } = fakeCloud();
    const progress: string[] = [];
    connectToss(config, { runner, execute: true, progress: (line: string) => progress.push(line) });
    expect(progress.at(-1)).toContain('[5/5]');
  });
});
