import { describe, expect, it } from 'vitest';
import { ConnectionError, connectToss } from '../scripts/connect-toss.mjs';
import {
  GcloudResolutionError,
  gcloudInvocation,
  resolveGcloud,
} from '../scripts/gcloud-command.mjs';

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

describe('gcloud launcher resolution', () => {
  const root = 'C:\\SDK\\google-cloud-sdk';
  const gcloudPy = `${root}\\lib\\gcloud.py`;
  const bundled = `${root}\\platform\\bundledpython\\python.exe`;
  const sdkFiles = [`${root}\\bin\\gcloud.cmd`, gcloudPy, bundled];
  const winEnv = { PATH: `C:\\Windows;"${root}\\bin"` };
  const files = (...paths: string[]) => {
    const set = new Set(paths);
    return (path: string) => set.has(path);
  };

  it('runs plain gcloud on non-Windows platforms without touching the filesystem', () => {
    for (const platform of ['linux', 'darwin']) {
      const resolved = resolveGcloud({
        platform,
        env: {},
        exists: () => {
          throw new Error('must not probe the filesystem');
        },
      });
      expect(resolved).toEqual({ file: 'gcloud', prefixArgs: [], env: null });
    }
  });

  it('derives the SDK root from gcloud.cmd and uses the bundled Python on Windows', () => {
    const resolved = resolveGcloud({
      platform: 'win32',
      env: winEnv,
      exists: files(...sdkFiles),
    });
    expect(resolved.file).toBe(bundled);
    expect(resolved.prefixArgs).toEqual(['-S', gcloudPy]);
    expect(resolved.env).toEqual({ CLOUDSDK_PYTHON: bundled, PYTHONHOME: null });
  });

  it('honors CLOUDSDK_PYTHON (any name case) and keeps site packages when requested', () => {
    const python = 'D:\\Python312\\python.exe';
    const resolved = resolveGcloud({
      platform: 'win32',
      env: { Path: winEnv.PATH, CloudSdk_Python: python, VIRTUAL_ENV: 'D:\\venv' },
      exists: files(`${root}\\bin\\gcloud.cmd`, gcloudPy, python),
    });
    expect(resolved.file).toBe(python);
    expect(resolved.prefixArgs).toEqual([gcloudPy]);
    expect(resolved.env).toMatchObject({ CLOUDSDK_PYTHON: python });
  });

  it('fails with a clear static message when the SDK or interpreter cannot be resolved', () => {
    const secret = 'sentinel-secret-value';
    const cases: Array<[Record<string, string>, string[]]> = [
      [{ PATH: 'C:\\Windows', SENTINEL: secret }, []],
      [winEnv, [`${root}\\bin\\gcloud.cmd`]],
      [winEnv, [`${root}\\bin\\gcloud.cmd`, gcloudPy]],
      [{ ...winEnv, CLOUDSDK_PYTHON: 'D:\\missing\\python.exe' }, sdkFiles],
      [{ ...winEnv, CLOUDSDK_PYTHON: 'D:\\tools\\python.cmd' }, sdkFiles],
    ];
    for (const [env, present] of cases) {
      let failure: unknown;
      try {
        resolveGcloud({
          platform: 'win32',
          env,
          exists: files(...present, 'D:\\tools\\python.cmd'),
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(GcloudResolutionError);
      const message = (failure as Error).message;
      expect(message).toContain('WSL');
      for (const value of Object.values(env)) expect(message).not.toContain(value);
      expect(message).not.toContain(secret);
    }
  });

  it('ignores relative PATH entries so a planted gcloud.cmd cannot pick the interpreter', () => {
    expect(() =>
      resolveGcloud({
        platform: 'win32',
        env: { PATH: `.;bin;${'C:\\Windows'}` },
        exists: files('.\\gcloud.cmd', 'bin\\gcloud.cmd', 'lib\\gcloud.py', 'python.exe'),
      }),
    ).toThrow(GcloudResolutionError);
  });

  it('passes arguments as separate elements and overrides env case-insensitively', () => {
    const args = ['secrets', 'versions', 'add', 'a b', '--format=value(name)', '--x=$(y) & "z"'];
    const env = { ...winEnv, Pythonhome: 'C:\\other', KEEP: '1' };
    const invocation = gcloudInvocation(args, {
      platform: 'win32',
      env,
      exists: files(...sdkFiles),
    });
    expect(invocation.file).toBe(bundled);
    expect(invocation.args).toEqual(['-S', gcloudPy, ...args]);
    expect(invocation.env).toEqual({ ...winEnv, KEEP: '1', CLOUDSDK_PYTHON: bundled });
    expect(env.Pythonhome).toBe('C:\\other');
    expect(gcloudInvocation(args, { platform: 'linux', env: {} })).toEqual({
      file: 'gcloud',
      args,
      env: undefined,
    });
  });

  it('shows the resolution message instead of the generic failure', () => {
    const runner = () => {
      throw new GcloudResolutionError('static resolution message');
    };
    expect(() => connectToss(config, { runner, progress: () => {} })).toThrow(
      'static resolution message',
    );
  });
});
