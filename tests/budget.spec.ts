import { test, expect } from '@playwright/test';
import { mockApi, memberUser } from './fixtures/api-mock';

const fits = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test.describe('monthly budget banner', () => {
  test('shows no banner when the budget is fine or the endpoint is owner-only', async ({
    page,
  }) => {
    await mockApi(page, { budget: 'running' });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '경제 캘린더', exact: true })).toBeVisible();
    await expect(page.getByTestId('budget-stop')).toHaveCount(0);
    await expect(page.getByTestId('budget-warn')).toHaveCount(0);
  });

  test('a stopped budget is announced and can be released after a confirmation', async ({
    page,
  }) => {
    const api = await mockApi(page, { budget: 'stopped' });
    await page.goto('/');
    const banner = page.getByTestId('budget-stop');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(
      '월 예산 한도(3만 원)에 도달해 예약 작업·AI·실전 주문을 멈췄습니다',
    );
    expect(await fits(page)).toBe(true);
    await banner.getByRole('button', { name: '월 예산 정지 해제' }).click();
    const dialog = page.getByRole('dialog', { name: '월 예산 정지를 해제할까요?' });
    await expect(dialog).toContainText('긴급 정지는 해제되지 않습니다');
    // Cancelling changes nothing.
    await dialog.getByRole('button', { name: '취소' }).click();
    expect(api.requests.some((r) => r.startsWith('POST /api/ops/budget/release'))).toBe(false);
    await banner.getByRole('button', { name: '월 예산 정지 해제' }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '월 예산 정지 해제', exact: true })
      .click();
    await expect(page.getByTestId('budget-stop')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: '긴급 정지는 그대로' })).toBeVisible();
    expect(api.requests.filter((r) => r.startsWith('POST /api/ops/budget/release'))).toHaveLength(
      1,
    );
  });

  test('a warning badge shows without a release button', async ({ page }) => {
    await mockApi(page, { budget: 'warned' });
    await page.goto('/');
    const warn = page.getByTestId('budget-warn');
    await expect(warn).toContainText('월 예산 경고 기준에 도달');
    await expect(warn.getByRole('button')).toHaveCount(0);
  });

  test('a member account sees nothing (owner-only endpoint answers 404 in the mock)', async ({
    page,
  }) => {
    await mockApi(page, { user: memberUser });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '경제 캘린더', exact: true })).toBeVisible();
    await expect(page.getByTestId('budget-stop')).toHaveCount(0);
  });
});
