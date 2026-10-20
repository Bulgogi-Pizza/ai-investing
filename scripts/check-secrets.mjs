import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
const skip = new Set([
  'node_modules',
  '.git',
  'dist',
  '.local',
  '.terraform',
  'test-results',
  'playwright-report',
]);
function walk(dir = '.') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    skip.has(e.name)
      ? []
      : e.isDirectory()
        ? walk(path.join(dir, e.name))
        : [path.join(dir, e.name)],
  );
}
let files;
try {
  files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);
} catch {
  files = walk();
}
const bad = [];
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /"type"\s*:\s*"service_account"/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/,
];
for (const f of files) {
  if (!existsSync(f)) continue;
  if (/(^|\/)\.env(?:\.|$)/.test(f) && !f.endsWith('.env.example')) {
    bad.push(`${f}: environment file`);
    continue;
  }
  if (/\.(tfstate|pem|p12|key)(\.|$)/.test(f)) {
    bad.push(`${f}: sensitive file type`);
    continue;
  }
  if (patterns.some((p) => p.test(readFileSync(f, 'utf8')))) bad.push(`${f}: potential credential`);
}
if (bad.length) {
  process.stderr.write(bad.join('\n') + '\n');
  process.exit(1);
}
console.log(
  `Secret patterns checked in ${files.length} source files. This is heuristic; review diffs and use GitHub secret scanning.`,
);
