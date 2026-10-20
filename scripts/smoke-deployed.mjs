// Tests the real private authentication boundary without printing credentials or creating financial data.
import { readFileSync, statSync } from 'node:fs';
const config = JSON.parse(readFileSync('.local/deployment.json', 'utf8'));
const file = '.local/owner-access.json';
if ((statSync(file).mode & 0o077) !== 0)
  throw new Error('Owner access file must be private (0600)');
const access = JSON.parse(readFileSync(file, 'utf8'));
const origin = config.origin;
if (
  config.personalOnly !== true ||
  access.project !== config.project ||
  !origin ||
  new URL(origin).origin !== origin ||
  !origin.startsWith('https://')
)
  throw new Error('Authorized deployed personal origin required');
const request = (path, options = {}) =>
  fetch(origin + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(45000) });
const health = await request('/api/health');
if (health.status !== 200) throw new Error(`Health HTTP${health.status}`);
const denied = await request('/api/portfolio');
if (denied.status !== 401) throw new Error(`Anonymous private boundary HTTP${denied.status}`);
const login = await request('/api/auth/login', {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: access.email, password: access.password }),
});
if (login.status !== 200)
  throw new Error(`Owner login HTTP${login.status}; no private response was printed`);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie?.startsWith('folio_session=')) throw new Error('Missing HttpOnly session');
const headers = { Cookie: cookie, Origin: origin };
try {
  const me = await request('/api/auth/me', { headers });
  if (me.status !== 200 || (await me.json()).user?.role !== 'admin')
    throw new Error('Owner authorization failed');
  const strategy = await request('/api/strategy', { headers });
  if (strategy.status !== 200) throw new Error(`Private strategy HTTP${strategy.status}`);
  const portfolio = await request('/api/portfolio', { headers });
  if (![200, 503].includes(portfolio.status))
    throw new Error(`Owner provider status HTTP${portfolio.status}`);
  console.log(
    JSON.stringify({
      health: 200,
      anonymousPortfolio: 401,
      ownerLogin: 200,
      adminRole: true,
      strategy: strategy.status,
      portfolio: portfolio.status,
    }),
  );
} finally {
  const logout = await request('/api/auth/logout', { method: 'POST', headers });
  if (logout.status !== 204) throw new Error(`Logout HTTP${logout.status}`);
  const revoked = await request('/api/auth/me', { headers });
  if (revoked.status !== 401) throw new Error('Logged-out session still accepted');
  console.log('Deployed session revocation verified. No credential or session token was logged.');
}
