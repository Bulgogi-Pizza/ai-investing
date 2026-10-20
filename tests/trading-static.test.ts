import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static guarantees about the trading module (plan stage 7d): it never asks for the high-value
 * confirmation, only builds quantity-based LIMIT + DAY orders, and nothing in the application,
 * jobs or scripts imports it yet (wiring is stages 7e/7f).
 */
const root = resolve(__dirname, '..');
const tradingDir = join(root, 'src', 'server', 'trading');

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (
      ['node_modules', 'dist', '.git', '.local', 'test-results', 'playwright-report'].includes(name)
    )
      return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const rel = (p: string) => relative(root, p).split(sep).join('/');
const tradingFiles = walk(tradingDir).filter((f) => /\.(ts|tsx|js|mjs)$/.test(f));
const productionFiles = tradingFiles.filter((f) => !f.endsWith(`${sep}testing.ts`));
const read = (f: string) => readFileSync(f, 'utf8');

describe('no path can set the high-value confirmation flag', () => {
  it('has trading sources to scan', () => {
    expect(tradingFiles.map(rel)).toEqual(
      expect.arrayContaining([
        'src/server/trading/toss-orders.ts',
        'src/server/trading/pre-trade.ts',
        'src/server/trading/executor.ts',
      ]),
    );
  });
  it('the field name does not appear anywhere in src/server/trading (so it can never be set to true)', () => {
    for (const file of tradingFiles)
      expect(read(file), rel(file)).not.toMatch(/confirmHighValueOrder/i);
  });
  it('no confirm-flag-like key or truthy assignment either', () => {
    for (const file of tradingFiles) {
      const text = read(file);
      expect(text, rel(file)).not.toMatch(/confirm[A-Za-z]*\s*[:=]\s*true/i);
      expect(text, rel(file)).not.toMatch(/['"]confirm[A-Za-z]*['"]\s*:/i);
    }
  });
});

describe('orders are quantity-based LIMIT + DAY only', () => {
  it('no market, amount-based, closing or opening order construction in production code', () => {
    for (const file of productionFiles) {
      const text = read(file);
      expect(text, rel(file)).not.toMatch(/['"`]MARKET['"`]/);
      expect(text, rel(file)).not.toMatch(/orderAmount/);
      expect(text, rel(file)).not.toMatch(/['"`](CLS|OPG)['"`]/);
    }
  });
  it('the only order body is built in one place with fixed LIMIT and DAY literals', () => {
    const text = read(join(tradingDir, 'toss-orders.ts'));
    expect(text.match(/orderType: 'LIMIT'/g)).toHaveLength(1);
    expect(text.match(/timeInForce: 'DAY'/g)).toHaveLength(1);
  });
  it('POST exists only for creating and cancelling orders', () => {
    const text = read(join(tradingDir, 'toss-orders.ts'));
    const posts = [...text.matchAll(/method:\s*'POST'/g)];
    expect(posts).toHaveLength(2);
    expect(text).toContain("path: '/api/v1/orders'");
    expect(text).toMatch(/\/cancel`/);
    for (const file of productionFiles.filter((f) => !f.endsWith('toss-orders.ts')))
      expect(read(file), rel(file)).not.toMatch(/method:\s*['"]POST['"]/);
  });
  it('the access check cannot reach any write operation', () => {
    const text = read(join(tradingDir, 'access-check.ts'));
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/placeOrder|cancelOrder|POST|TossOrderWrites|TossOrderClient/);
  });
});

describe('the module is not wired anywhere', () => {
  const importsTrading = (text: string) =>
    /(?:from|import|require)\s*\(?\s*['"][^'"]*\btrading\/[^'"]*['"]/.test(text) ||
    /['"][^'"]*\/trading['"]/.test(text);

  it('src/server/app.ts, src/server/index.ts and any src/jobs/** do not import it', () => {
    const files = [
      join(root, 'src', 'server', 'app.ts'),
      join(root, 'src', 'server', 'index.ts'),
      ...walk(join(root, 'src', 'jobs')),
    ].filter(existsSync);
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of files) expect(importsTrading(read(file)), rel(file)).toBe(false);
  });
  it('no source, script or config outside the module and its tests references it', () => {
    const candidates = [
      ...walk(join(root, 'src')),
      ...walk(join(root, 'scripts')),
      ...['vite.config.ts', 'playwright.config.ts', 'Dockerfile', 'package.json', 'index.html'].map(
        (f) => join(root, f),
      ),
    ]
      .filter((f) => existsSync(f) && !f.startsWith(tradingDir + sep))
      .filter((f) => /\.(ts|tsx|js|mjs|cjs|json|html)$|Dockerfile$/.test(f));
    expect(candidates.length).toBeGreaterThan(10);
    const offenders = candidates.filter(
      (f) => importsTrading(read(f)) || /server\/trading/.test(read(f)),
    );
    expect(offenders.map(rel)).toEqual([]);
  });
  it('the module imports no web framework, scheduler or app code', () => {
    for (const file of tradingFiles) {
      const text = read(file);
      expect(text, rel(file)).not.toMatch(
        /from\s+['"](?:express|node-cron|\.\.\/app|\.\.\/index|\.\.\/store|\.\.\/toss)(?:\.js)?['"]/,
      );
      // Type-only import of the notification event shape is the single allowed server import.
      for (const m of text.matchAll(/from\s+['"](\.\.\/[^'"]+)['"]/g))
        expect(['../notify.js', '../../lib/algo/index.js'], `${rel(file)} -> ${m[1]}`).toContain(
          m[1],
        );
    }
  });
  it('the notify import exists only in alerts.ts and is type-only (no Firestore client or Telegram code is loaded)', () => {
    const importers = tradingFiles.filter((f) => /from\s+['"]\.\.\/notify\.js['"]/.test(read(f)));
    expect(importers.map(rel)).toEqual(['src/server/trading/alerts.ts']);
    const text = read(importers[0]);
    expect(text).toMatch(/import type \{ NotificationEvent \} from '\.\.\/notify\.js'/);
    expect(text).not.toMatch(/^import \{[^}]*\} from '\.\.\/notify\.js'/m);
  });
});

describe('test support stays out of src', () => {
  it('the fake Toss server lives under tests/support, not under src', () => {
    expect(existsSync(join(root, 'tests', 'support', 'fake-toss.ts'))).toBe(true);
    expect(existsSync(join(tradingDir, 'testing.ts'))).toBe(false);
  });
  it('no file under src/ imports test support, FakeToss, or anything under tests/', () => {
    const offenders = walk(join(root, 'src'))
      .filter((f) => /\.(ts|tsx|js|mjs)$/.test(f))
      .filter((f) => {
        const text = read(f);
        return (
          /(?:from|import|require)\s*\(?\s*['"][^'"]*(?:\/testing|fake-toss|\/tests\/|\.\.\/tests)[^'"]*['"]/.test(
            text,
          ) || /\bFakeToss\b/.test(text)
        );
      });
    expect(offenders.map(rel)).toEqual([]);
  });
});
