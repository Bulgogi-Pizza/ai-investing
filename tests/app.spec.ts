import { test, expect, type Page } from '@playwright/test';
import {
  adminUser,
  forbiddenText,
  memberUser,
  mockApi,
  ownerUser,
  type MockOptions,
} from './fixtures/api-mock';

const pages = [
  ['경제 캘린더', 'calendar'],
  ['차트 분석', 'charts'],
  ['내 자산', 'portfolio'],
  ['AI 인사이트', 'insights'],
] as const;
const open = (page: Page, name: string) =>
  page
    .getByRole('button', {
      name: name === 'AI 인사이트' ? /AI 인사이트/ : name,
      exact: name !== 'AI 인사이트',
    })
    .click();
async function start(page: Page, options: MockOptions = {}) {
  const api = await mockApi(page, options);
  await page.goto('/');
  return api;
}
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test.describe('signed out', () => {
  test('shows only the login screen and never data or navigation', async ({ page }) => {
    const api = await start(page, { user: null, loginAs: ownerUser });
    const login = page.getByRole('region', { name: '나의 투자 공간에 로그인' });
    await expect(login).toBeVisible();
    await expect(page.getByLabel('이메일')).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expect(page.locator('.market-strip')).toHaveCount(0);
    await expect(page.locator('.sidebar')).toHaveCount(0);
    for (const text of forbiddenText) await expect(page.getByText(text)).toHaveCount(0);
    // Only the session check ran: no private data was requested before login.
    expect(api.requests.filter((r) => !r.endsWith('/api/auth/me'))).toEqual([]);
    expect(await fits(page)).toBe(true);
    await login.getByLabel('이메일').fill('owner@example.test');
    await login.getByLabel('비밀번호').fill('Test-only lengthy password');
    await login.getByRole('button', { name: '로그인', exact: true }).click();
    await expect(page.getByRole('heading', { name: '경제 캘린더', exact: true })).toBeVisible();
    await expect(page.locator('.market-strip')).toContainText('2,812.45');
  });
  test('failed login keeps the login screen and shows an alert', async ({ page }) => {
    await start(page, { user: null });
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        status: 401,
        json: { error: { code: 'INVALID_CREDENTIALS', message: 'x' } },
      }),
    );
    await page.getByLabel('이메일').fill('owner@example.test');
    await page.getByLabel('비밀번호').fill('wrong password long');
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('이메일 또는 비밀번호');
    await expect(page.locator('.sidebar')).toHaveCount(0);
  });
  test('an unreachable server shows a retryable error instead of data', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.abort());
    await page.goto('/');
    await expect(page.getByRole('alert')).toContainText('서버에 연결할 수 없습니다');
    await expect(page.getByRole('button', { name: '다시 시도', exact: true })).toBeVisible();
    await expect(page.locator('.sidebar')).toHaveCount(0);
  });
});

test.describe('owner with live data', () => {
  test.beforeEach(async ({ page }) => {
    await start(page);
  });
  test('top strip shows real indices and USD/KRW; watchlist shows quoted prices', async ({
    page,
  }) => {
    const strip = page.getByRole('region', { name: '시장 지표' });
    await expect(strip).toContainText('코스피');
    await expect(strip).toContainText('2,812.45');
    await expect(strip).toContainText('국채 10년');
    await expect(strip).toContainText('3.25%');
    await expect(strip).toContainText('USD/KRW');
    await expect(strip).toContainText('1,375.00');
    await expect(strip).toContainText('조회 ');
    await expect(page.locator('.watch-price').first()).toHaveText('71,234원');
    await expect(page.locator('.watch-price').nth(1)).toHaveText('$234.76');
    for (const text of forbiddenText) await expect(page.getByText(text)).toHaveCount(0);
  });
  test('calendar filters, views and month navigation remain consistent', async ({ page }) => {
    await expect(page.getByRole('heading', { name: '경제 캘린더', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '2026년 10월' })).toBeVisible();
    await expect(page.locator('.event-chip')).toHaveCount(8);
    await page.getByLabel('중요도 필터').selectOption('3');
    await page.getByLabel('시장 필터').selectOption('한국');
    await expect(page.locator('.event-chip')).toHaveCount(1);
    await page.getByLabel('자산 필터').selectOption('유가');
    await expect(page.locator('.event-chip')).toHaveCount(0);
    await page.getByRole('button', { name: '초기화', exact: true }).click();
    await expect(page.locator('.event-chip')).toHaveCount(8);
    await page.getByRole('button', { name: '주간', exact: true }).click();
    await expect(page.locator('.agenda-heading')).toContainText('18');
    await page.getByRole('button', { name: '일간', exact: true }).click();
    await expect(page.locator('.agenda-event')).toHaveCount(2);
    await page.getByRole('button', { name: '시간별', exact: true }).click();
    await expect(page.locator('.hour-row')).toHaveCount(24);
    await page.getByRole('button', { name: '월간', exact: true }).click();
    await page.getByRole('button', { name: '다음 기간', exact: true }).click();
    await expect(page.getByRole('heading', { name: '2026년 11월' })).toBeVisible();
    await expect(page.locator('.event-chip')).toHaveCount(0);
    await page.getByRole('button', { name: '오늘', exact: true }).click();
    await expect(page.getByRole('heading', { name: '2026년 10월' })).toBeVisible();
  });
  test('calendar shows provenance for a selected registered event', async ({ page }) => {
    await page.getByLabel('자산 필터').selectOption('채권');
    await expect(page.locator('.event-chip')).toHaveCount(2);
    await page.locator('.event-chip').first().click();
    await expect(page.getByRole('link', { name: /테스트 출처/ })).toHaveAttribute(
      'href',
      'https://example.test/release',
    );
  });
  test('chart renders fetched candles, indicators and validates reference lines', async ({
    page,
  }) => {
    await open(page, '차트 분석');
    await expect(page.locator('.chart-canvas svg')).toBeVisible();
    await expect(page.locator('.chart-price')).toContainText('원');
    await expect(page.locator('.chart-footnote')).toContainText('Test quote provider');
    await page.getByRole('button', { name: 'EMA 20', exact: true }).click();
    await page.getByRole('button', { name: '볼린저 밴드', exact: true }).click();
    await page.getByRole('button', { name: 'MACD', exact: true }).click();
    await page.getByLabel('매수 검토선').fill('99000');
    await page.getByLabel('매도 검토선').fill('88000');
    await expect(page.getByText('매수 검토선은 매도 검토선보다 낮게 설정하세요.')).toBeVisible();
    await page.getByLabel('종목 선택').selectOption('Apple');
    await expect(page.locator('.chart-symbol')).toContainText('AAPL');
    await expect(page.locator('.chart-price')).toContainText('234.76');
    await expect(page.locator('.chart-price')).toContainText('USD');
    await expect(page.getByLabel('매수 검토선')).toHaveValue('');
    await expect(page.getByRole('button', { name: 'KOSPI 비교' })).toHaveCount(0);
  });
  test('portfolio privacy toggle and strategy validation/saving work', async ({ page }) => {
    await open(page, '내 자산');
    await expect(page.getByText('실계좌 · 주식 전용')).toBeVisible();
    await expect(page.getByText('계약 테스트 종목')).toBeVisible();
    await expect(page.getByText('10.77%', { exact: true })).toBeVisible();
    await expect(page.getByText('7,200,000원', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('1,785 USD', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '잔액 숨기기', exact: true }).first().click();
    await expect(page.locator('.invest-big-number').first()).toHaveText('••••••');
    await page.getByLabel('주식 목표 비중').fill('90');
    await expect(page.getByRole('button', { name: '내 전략 저장', exact: true })).toBeDisabled();
    await page.getByLabel('주식 목표 비중').fill('55');
    await page.getByRole('button', { name: '내 전략 저장', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '내 계정에 전략을 저장' }),
    ).toBeVisible();
  });
  test('AI insight loads for the selected horizon with sources', async ({ page }) => {
    await open(page, 'AI 인사이트');
    await expect(page.getByRole('heading', { name: '저장된 투자 원칙 점검' })).toBeVisible();
    await page.getByRole('button', { name: '주간', exact: true }).click();
    await expect(page.getByText('5거래일 관찰', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '합성 예시' })).toHaveCount(0);
  });
  test('all pages fit the viewport and no demo wording appears', async ({ page }) => {
    for (const [name] of pages) {
      await open(page, name);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await fits(page), `${name}: horizontal overflow`).toBe(true);
      for (const text of forbiddenText) await expect(page.getByText(text)).toHaveCount(0);
    }
  });
  test('logout returns to the login screen', async ({ page }) => {
    await page.getByRole('button', { name: '로그아웃', exact: true }).last().click();
    await expect(page.getByRole('region', { name: '나의 투자 공간에 로그인' })).toBeVisible();
    await expect(page.locator('.sidebar')).toHaveCount(0);
  });
});

test.describe('signed-in member who is not the owner', () => {
  test.beforeEach(async ({ page }) => {
    await start(page, { user: memberUser, market: 'owner-only' });
  });
  test('sees the owner-only notice on every Toss-backed screen and no data', async ({ page }) => {
    await expect(page.getByRole('region', { name: '시장 지표' })).toHaveCount(0);
    await expect(page.locator('.market-strip-state [data-state="owner-only"]')).toBeVisible();
    // Calendar and strategy are owner-only too: only the notice, no events and no editor.
    await expect(page.locator('main [data-state="owner-only"]').last()).toContainText(
      '소유자 계정 전용 기능입니다',
    );
    await expect(page.locator('.calendar-card')).toHaveCount(0);
    await expect(page.locator('.event-chip')).toHaveCount(0);
    for (const name of ['차트 분석', '내 자산', 'AI 인사이트']) {
      await open(page, name);
      const state = page.locator(
        'main > [data-state="owner-only"], .invest-page > [data-state="owner-only"], .chart-panel [data-state="owner-only"]',
      );
      await expect(state.first()).toContainText('소유자 계정 전용 기능입니다');
      await expect(page.getByText('계약 테스트 종목')).toHaveCount(0);
      await expect(page.getByLabel('주식 목표 비중')).toHaveCount(0);
      expect(await fits(page), `${name}: overflow`).toBe(true);
    }
    await expect(page.getByRole('button', { name: '다시 시도' })).toHaveCount(0);
  });
});

test.describe('Toss not connected (503)', () => {
  test('every Toss-backed screen explains the missing connection and never shows demo data', async ({
    page,
  }) => {
    await start(page, { market: 'not-connected' });
    await expect(page.locator('.market-strip-state [data-state="not-connected"]')).toBeVisible();
    for (const name of ['차트 분석', '내 자산', 'AI 인사이트']) {
      await open(page, name);
      await expect(page.locator('main [data-state="not-connected"]').last()).toContainText(
        '토스 계좌가 연결되지 않았습니다',
      );
      for (const text of forbiddenText) await expect(page.getByText(text)).toHaveCount(0);
    }
    await open(page, '내 자산');
    await expect(page.getByText('계약 테스트 종목')).toHaveCount(0);
    await expect(page.locator('.invest-big-number')).toHaveCount(0);
  });
});

test.describe('empty provider data', () => {
  test.beforeEach(async ({ page }) => {
    await start(page, { market: 'empty' });
  });
  test('chart and portfolio say that there is no data instead of drawing anything', async ({
    page,
  }) => {
    await open(page, '차트 분석');
    await expect(page.locator('.chart-panel [data-state="no-data"]')).toContainText(
      '표시할 데이터가 없습니다',
    );
    await expect(page.locator('.chart-canvas')).toHaveCount(0);
    await open(page, '내 자산');
    await expect(page.locator('[data-state="no-data"]')).toContainText('보유 중인 주식이 없습니다');
    await open(page, 'AI 인사이트');
    await expect(page.locator('main [data-state="no-data"]').last()).toBeVisible();
  });
  test('watchlist shows dashes when no price is returned', async ({ page }) => {
    await expect(page.locator('.watch-price').first()).toHaveText('—');
  });
});

test.describe('transient provider error', () => {
  test('chart shows an alert and recovers after retry', async ({ page }) => {
    const api = await start(page, { market: 'transient' });
    await open(page, '차트 분석');
    const alert = page.locator('.chart-panel').getByRole('alert');
    await expect(alert).toContainText('일시적인 오류');
    await expect(page.locator('.chart-canvas')).toHaveCount(0);
    api.state.failing = false;
    await alert.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect(page.locator('.chart-canvas svg')).toBeVisible();
    await expect(page.locator('.chart-panel').getByRole('alert')).toHaveCount(0);
  });
  test('top strip recovers through its refresh control', async ({ page }) => {
    const api = await start(page, { market: 'transient' });
    const retry = page.locator('.market-strip-state').getByRole('button', { name: '다시 시도' });
    await expect(retry).toBeVisible();
    api.state.failing = false;
    await retry.click();
    await expect(page.getByRole('region', { name: '시장 지표' })).toContainText('2,812.45');
  });
  test('insight failure never substitutes a synthetic analysis', async ({ page }) => {
    const api = await start(page, { market: 'transient' });
    await open(page, 'AI 인사이트');
    const alert = page.locator('.invest-page').getByRole('alert');
    await expect(alert).toContainText('일시적인 오류');
    await expect(page.locator('.invest-insight-hero')).toHaveCount(0);
    api.state.failing = false;
    await alert.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect(page.getByRole('heading', { name: '저장된 투자 원칙 점검' })).toBeVisible();
  });
});

test('administrator without the owner connection keeps account tools but sees the owner notice', async ({
  page,
}) => {
  await start(page, { user: adminUser, market: 'owner-only' });
  await expect(page.getByRole('button', { name: '계정 등록', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '계정 등록', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '계정 등록' })).toBeVisible();
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(page.locator('.calendar-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '공식 뉴스 수집' })).toHaveCount(0);
  await open(page, '내 자산');
  await expect(page.locator('[data-state="owner-only"]').last()).toBeVisible();
});

test('capture rendered visual evidence', async ({ page }, testInfo) => {
  await start(page);
  for (const [name, slug] of pages) {
    await open(page, name);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if (slug === 'charts') await expect(page.locator('svg.recharts-surface').first()).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`${testInfo.project.name}-${slug}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
});
