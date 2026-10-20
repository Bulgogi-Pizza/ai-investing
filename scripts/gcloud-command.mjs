// Shared gcloud launcher. macOS/Linux run `gcloud` directly. On Windows the SDK entry point is
// `gcloud.cmd`, which Node cannot run without a shell (and a shell would make argument and
// secret handling injectable). Instead run the SDK's Python entry point exactly as gcloud.cmd
// does: `<python> [-S] <sdk>/lib/gcloud.py <args...>`. Never uses a shell, never builds a
// command line string, never puts environment values or arguments into error messages.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

export class GcloudResolutionError extends Error {}

const WINDOWS_HINT = 'WSL, macOS 또는 Linux에서 실행하거나 Google Cloud SDK 설치를 확인하세요.';
const MESSAGES = {
  notFound: `PATH에서 gcloud.cmd를 찾지 못했습니다. Google Cloud SDK를 설치하고 PATH에 추가하세요. ${WINDOWS_HINT}`,
  brokenSdk: `Google Cloud SDK의 lib/gcloud.py를 찾지 못했습니다. SDK 설치 상태를 확인하세요. ${WINDOWS_HINT}`,
  noPython: `gcloud용 Python을 찾지 못했습니다. SDK 번들 Python을 복구하거나 CLOUDSDK_PYTHON에 python.exe 경로를 지정하세요. ${WINDOWS_HINT}`,
  badPython: `CLOUDSDK_PYTHON은 python.exe 같은 실행 파일이어야 합니다(.cmd/.bat 불가). ${WINDOWS_HINT}`,
};

// Windows environment variable names are case-insensitive; injected plain objects are not.
const findKey = (env, name) =>
  Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase());
const readEnv = (env, name) => {
  const key = findKey(env, name);
  const value = key === undefined ? undefined : env[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

function findGcloudCmd(path, exists) {
  for (const raw of path.split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    // Relative entries (for example ".") would let a planted gcloud.cmd choose the interpreter.
    if (!dir || !win32.isAbsolute(dir)) continue;
    const candidate = win32.join(dir, 'gcloud.cmd');
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * @typedef {{ platform?: string, env?: Record<string, string | undefined>, exists?: (path: string) => boolean }} Deps
 */

/**
 * Decide how to start gcloud. Returns { file, prefixArgs, env }:
 * `env` is null when the inherited environment is used unchanged (non-Windows),
 * otherwise a map of overrides (a value of null removes the variable).
 */
export function resolveGcloud(
  /** @type {Deps} */ {
    platform = process.platform,
    env = process.env,
    exists = (path) => existsSync(path),
  } = {},
) {
  if (platform !== 'win32') return { file: 'gcloud', prefixArgs: [], env: null };

  const cmdPath = findGcloudCmd(readEnv(env, 'PATH') ?? '', exists);
  if (!cmdPath) throw new GcloudResolutionError(MESSAGES.notFound);
  // gcloud.cmd lives in <root>\bin (or directly in <root>).
  const binDir = win32.dirname(cmdPath);
  const root = [win32.dirname(binDir), binDir].find((dir) =>
    exists(win32.join(dir, 'lib', 'gcloud.py')),
  );
  if (!root) throw new GcloudResolutionError(MESSAGES.brokenSdk);

  let python = readEnv(env, 'CLOUDSDK_PYTHON');
  if (python) {
    if (/\.(cmd|bat)$/i.test(python)) throw new GcloudResolutionError(MESSAGES.badPython);
    // A bare name such as "python" is resolved through PATH by the OS, like gcloud.cmd does.
    if (win32.isAbsolute(python) && !exists(python))
      throw new GcloudResolutionError(MESSAGES.noPython);
  } else {
    python = win32.join(root, 'platform', 'bundledpython', 'python.exe');
    if (!exists(python)) throw new GcloudResolutionError(MESSAGES.noPython);
  }

  // gcloud.cmd passes -S (no site-packages) unless site packages were requested or a venv is active.
  const sitePackages =
    readEnv(env, 'CLOUDSDK_PYTHON_SITEPACKAGES') !== undefined ||
    readEnv(env, 'VIRTUAL_ENV') !== undefined;
  const overrides = { CLOUDSDK_PYTHON: python, PYTHONHOME: null };
  const encoding = readEnv(env, 'CLOUDSDK_ENCODING');
  if (encoding) overrides.PYTHONIOENCODING = encoding;
  return {
    file: python,
    prefixArgs: [...(sitePackages ? [] : ['-S']), win32.join(root, 'lib', 'gcloud.py')],
    env: overrides,
  };
}

function applyOverrides(base, overrides) {
  const result = { ...base };
  for (const [name, value] of Object.entries(overrides)) {
    for (const key of Object.keys(result))
      if (key.toUpperCase() === name.toUpperCase()) delete result[key];
    if (value !== null) result[name] = value;
  }
  return result;
}

/** Build the execFile arguments for one gcloud invocation: { file, args, env }. */
export function gcloudInvocation(args, /** @type {Deps} */ deps = {}) {
  const { file, prefixArgs, env } = resolveGcloud(deps);
  return {
    file,
    args: [...prefixArgs, ...args],
    env: env === null ? undefined : applyOverrides(deps.env ?? process.env, env),
  };
}

/**
 * execFileSync wrapper. Caller options (stdio, input, timeout, ...) are passed through.
 * @param {string[]} args
 * @param {Record<string, unknown>} [options]
 * @param {Deps} [deps]
 * @returns {string}
 */
export function execGcloudSync(args, options = {}, deps = {}) {
  const { file, args: fullArgs, env } = gcloudInvocation(args, deps);
  return /** @type {string} */ (
    /** @type {unknown} */ (execFileSync(file, fullArgs, env ? { ...options, env } : options))
  );
}
