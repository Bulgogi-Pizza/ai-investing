import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static guarantees about the trading module (plan stages 7d-7f): it never asks for the high-value
 * confirmation, only builds quantity-based LIMIT + DAY orders, orders are created in one place, and
 * only the live job, the access check job and the owner-only screen API are wired to it.
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

describe('where the trading module is wired (stage 7e/7f)', () => {
  const importsTrading = (text: string) =>
    /(?:from|import|require)\s*\(?\s*['"][^'"]*\btrading\/[^'"]*['"]/.test(text) ||
    /['"][^'"]*\/trading['"]/.test(text);
  const srcFiles = () =>
    walk(join(root, 'src')).filter(
      (f) => /\.(ts|tsx|js|mjs)$/.test(f) && !f.startsWith(tradingDir + sep),
    );
  const without = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('only the live job, the access check job and the owner-only web server import it', () => {
    const importers = srcFiles()
      .filter((f) => importsTrading(read(f)))
      .map(rel)
      .sort();
    expect(importers).toEqual([
      'src/jobs/algo-live-data.ts',
      'src/jobs/algo-live.ts',
      'src/jobs/order-access-check.ts',
      'src/server/app.ts',
      'src/server/index.ts',
      'src/server/live.ts',
    ]);
  });
  it('no script or config outside src reads the module path', () => {
    const candidates = [
      ...walk(join(root, 'scripts')),
      ...['vite.config.ts', 'playwright.config.ts', 'package.json', 'index.html'].map((f) =>
        join(root, f),
      ),
    ].filter((f) => existsSync(f));
    for (const file of candidates) expect(read(file), rel(file)).not.toMatch(/server\/trading/);
  });
  it('the web server and the screen can read orders but never place them', () => {
    const web = [
      'app.ts',
      'index.ts',
      'live.ts',
      'algorithms.ts',
      'algorithm-fills.ts',
      'paper.ts',
    ];
    for (const name of web) {
      const text = without(read(join(root, 'src', 'server', name)));
      expect(text, name).not.toMatch(
        /placeOrder|cancelOrder|LiveOrderExecutor|TossOrderClient|TossOrderTransport|authorizedRequest/,
      );
      expect(text, name).not.toMatch(/trading\/executor|trading\/toss-transport/);
    }
    // live.ts may only take the display helper (and types) from the order client module.
    const live = read(join(root, 'src', 'server', 'live.ts'));
    const imports = [...live.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/trading\/toss-orders'/g)];
    expect(imports).toHaveLength(1);
    expect(
      imports[0][1]
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x && !x.startsWith('type ')),
    ).toEqual(['describeOrderError']);
    // The front end never imports anything trading-related at runtime (type imports are erased).
    for (const file of walk(join(root, 'src', 'features')).filter((f) => /\.tsx?$/.test(f)))
      expect(read(file), rel(file)).not.toMatch(/^import\s+(?!type)[^;]*server\/(trading|live)/m);
  });
  it('orders are created in exactly one place: executor.ts calls placeOrder, nobody else does', () => {
    const all = [...srcFiles(), ...tradingFiles];
    expect(
      all
        .filter((f) => /\.placeOrder\(/.test(without(read(f))))
        .map(rel)
        .sort(),
    ).toEqual(['src/server/trading/executor.ts']);
    expect(all.filter((f) => /\.cancelOrder\(/.test(without(read(f)))).map(rel)).toEqual([]);
  });
  it('the order endpoint path appears only in the order client and the transport allow-list', () => {
    const offenders = [...srcFiles(), ...tradingFiles]
      .filter((f) => /api\\?\/v1\\?\/orders/.test(read(f)))
      .map(rel)
      .sort();
    expect(offenders).toEqual([
      'src/server/trading/toss-orders.ts',
      'src/server/trading/toss-transport.ts',
    ]);
  });
  it('no POST request is built in the jobs, the live screen API or the other trading modules', () => {
    const files = [
      'src/jobs/algo-live.ts',
      'src/jobs/algo-live-data.ts',
      'src/jobs/order-access-check.ts',
      'src/server/live.ts',
      'src/server/trading/executor.ts',
      'src/server/trading/pre-trade.ts',
      'src/server/trading/stores.ts',
      'src/server/trading/firestore-store.ts',
      'src/server/trading/toss-transport.ts',
      'src/server/trading/access-check.ts',
      'src/server/trading/alerts.ts',
      'src/server/trading/ledger-pnl.ts',
    ];
    for (const f of files)
      expect(without(read(join(root, f))), f).not.toMatch(
        /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/,
      );
  });
  it('the transport sends only the allow-listed requests: reads plus order creation, no cancel, no token endpoint', () => {
    const code = without(read(join(tradingDir, 'toss-transport.ts')));
    expect(code).toContain('CREATE_ORDER_PATH');
    expect(code).not.toMatch(/\/cancel/);
    expect(code).not.toMatch(/oauth2/);
  });
  it('the live job refuses to start without the exact kill-switch value, before anything else', () => {
    const text = read(join(root, 'src', 'jobs', 'algo-live.ts'));
    expect(text).toContain("LIVE_KILL_SWITCH_ENV = 'LIVE_TRADING_ENABLED'");
    expect(text).toMatch(/env\[LIVE_KILL_SWITCH_ENV\] === 'true'/);
    const config = text.slice(text.indexOf('export function jobConfiguration'));
    expect(config.indexOf('!liveTradingEnabled(env)')).toBeGreaterThan(-1);
    expect(config.indexOf('!liveTradingEnabled(env)')).toBeLessThan(config.indexOf('NODE_ENV'));
    // main() builds the configuration before it touches Firestore, Toss or anything else.
    const main = text.slice(text.indexOf('export async function main'));
    expect(main.indexOf('jobConfiguration(env)')).toBeGreaterThan(-1);
    expect(main.indexOf('jobConfiguration(env)')).toBeLessThan(main.indexOf('new Firestore'));
  });
  it('the kill switch is set on the live job deployment only', () => {
    // Comments are dropped: the explanation of the next step trails the previous step's text.
    const deploy = readFileSync(join(root, '.github', 'workflows', 'deploy.yml'), 'utf8').replace(
      /^\s*#.*$/gm,
      '',
    );
    const steps = deploy.split(/\n {6}- name: /).slice(1);
    const withFlag = steps.filter((step) => step.includes('LIVE_TRADING_ENABLED'));
    expect(withFlag).toHaveLength(1);
    expect(withFlag[0]).toMatch(/^Deploy live algorithm job/);
    // The value comes from the repository variable; an absent variable deploys the switch OFF.
    expect(withFlag[0]).toContain("vars.LIVE_TRADING_ENABLED == 'true' && 'true' || 'false'");
    expect(withFlag[0]).toContain('LIVE_TRADING_ENABLED=$LIVE_FLAG');
    expect(withFlag[0]).not.toMatch(/LIVE_TRADING_ENABLED=true/);
    expect(withFlag[0]).toContain('ALGO_AI_ENABLED=false');
    expect(withFlag[0]).toContain('src/jobs/algo-live.ts');
    expect(withFlag[0]).toContain('--max-retries=0');
    const check = steps.find((step) => step.startsWith('Deploy order access check job'))!;
    expect(check).toContain('src/jobs/order-access-check.ts');
    expect(check).not.toMatch(/run\.invoker|LIVE_|TELEGRAM/);
    // Nothing else in the repository's runtime configuration turns the switch on.
    for (const file of [...walk(join(root, 'infra')), join(root, 'Dockerfile')].filter(existsSync))
      expect(read(file), rel(file)).not.toMatch(/LIVE_TRADING_ENABLED\s*[=:]\s*"?true/);
  });
  it('the Terraform live schedule is paused by default and adds no secret access or access-check trigger', () => {
    const tf = read(join(root, 'infra', 'gcp', 'jobs-live.tf'));
    expect(tf).toMatch(/variable "live_schedules_enabled" \{[^}]*default\s+= false/s);
    expect(tf.match(/paused\s+= !var\.live_schedules_enabled/g)).toHaveLength(2);
    expect(tf).toContain('"5 9 * * 1-5"');
    expect(tf).toContain('"35 22,23 * * 1-5"');
    expect(tf).toContain('jobs/${local.algo_live_job}:run');
    expect(without(tf.replace(/^\s*#.*$/gm, ''))).not.toMatch(
      /google_secret_manager|iam_member|access-check/,
    );
  });
  it('the access check job cannot reach any write path', () => {
    const code = without(read(join(root, 'src', 'jobs', 'order-access-check.ts')));
    expect(code).not.toMatch(/placeOrder|cancelOrder|POST|TossOrderWrites|LiveOrderExecutor/);
    expect(code).toMatch(/checkOrderAccess/);
  });
  it('the operator documents show the access check command', () => {
    const jobs = read(join(root, 'docs', 'operations', 'jobs.md'));
    expect(jobs).toMatch(/gcloud run jobs execute investing-order-access-check/);
  });
  it('the high-value confirmation flag appears nowhere in src, infra or workflows', () => {
    const files = [
      ...walk(join(root, 'src')),
      ...walk(join(root, 'infra')),
      ...walk(join(root, '.github')),
    ].filter((f) => existsSync(f));
    for (const file of files) expect(read(file), rel(file)).not.toMatch(/confirmHighValueOrder/i);
  });
  it('the module imports no web framework, scheduler or app code', () => {
    for (const file of tradingFiles) {
      const text = read(file);
      expect(text, rel(file)).not.toMatch(
        /from\s+['"](?:express|node-cron|\.\.\/app|\.\.\/index|\.\.\/store)(?:\.js)?['"]/,
      );
      // Type-only server imports: the notification event shape and the Toss client type for the
      // transport. No Firestore client, Telegram code or credentials are loaded through them.
      for (const m of text.matchAll(/from\s+['"](\.\.\/[^'"]+)['"]/g))
        expect(
          ['../notify.js', '../toss.js', '../../lib/algo/index.js'],
          `${rel(file)} -> ${m[1]}`,
        ).toContain(m[1]);
    }
    for (const file of tradingFiles.filter((f) => /from\s+['"]\.\.\/toss\.js['"]/.test(read(f)))) {
      expect(rel(file)).toBe('src/server/trading/toss-transport.ts');
      expect(read(file)).toMatch(/import type \{ TossClient \} from '\.\.\/toss\.js'/);
    }
    const importers = tradingFiles.filter((f) => /from\s+['"]\.\.\/notify\.js['"]/.test(read(f)));
    expect(importers.map(rel)).toEqual(['src/server/trading/alerts.ts']);
    expect(read(importers[0])).toMatch(
      /import type \{ NotificationEvent \} from '\.\.\/notify\.js'/,
    );
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
