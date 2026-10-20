import { test, expect } from '@playwright/test';
import { adminUser, event, mockApi, ownerUser } from './fixtures/api-mock';

const registered = (id: number, date: string, title: string, importance = 1) => ({
  ...event(id, date, '09:00', title, '한국', '물가', ['원화', '채권'], importance),
  sourceUrl: 'https://example.test/economic-release',
  sourceName: '테스트 제공기관',
  impactDirection: 'unknown',
  impactHorizon: '발표 후 1일',
});
test('low importance remains low in details and truncated results are disclosed', async ({
  page,
}) => {
  await mockApi(page, { user: ownerUser });
  await page.route('**/api/calendar/events?**', (route) =>
    route.fulfill({
      json: {
        events: [registered(20, '2026-10-20', '낮은 중요도 확인 일정')],
        truncated: true,
        limit: 2000,
      },
    }),
  );
  await page.goto('/');
  await expect(
    page.getByText('일정 조회 한도를 초과해 일부 일정만 표시됩니다.', { exact: false }),
  ).toBeVisible();
  await page.locator('.event-chip').click();
  await expect(page.locator('.detail-values')).toContainText('낮음');
  await expect(page.locator('.detail-values')).toContainText('● ○ ○');
  await page.getByRole('button', { name: '일간', exact: true }).click();
  await expect(page.locator('.agenda-event .badge')).toHaveText('낮음');
});
test('weekly agenda preserves chronology through the year boundary', async ({ page }) => {
  await mockApi(page, { user: ownerUser });
  await page.route('**/api/calendar/events?**', (route) =>
    route.fulfill({
      json: {
        events: [
          registered(2, '2027-01-01', '새해 첫 일정'),
          registered(1, '2026-12-31', '연말 마지막 일정'),
        ],
        truncated: false,
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: '다음 기간', exact: true }).click();
  await page.getByRole('button', { name: '다음 기간', exact: true }).click();
  await page.getByRole('button', { name: '12월 31일 일정', exact: true }).click();
  await page.getByRole('button', { name: '주간', exact: true }).click();
  await expect(page.locator('.agenda-event')).toHaveCount(2);
  await expect(page.locator('.agenda-event').nth(0)).toContainText('연말 마지막 일정');
  await expect(page.locator('.agenda-event').nth(1)).toContainText('새해 첫 일정');
});
test('calendar with no registered events says so instead of showing example events', async ({
  page,
}) => {
  await mockApi(page, { user: ownerUser, events: [] });
  await page.goto('/');
  await expect(page.locator('[data-state="no-data"]')).toContainText('등록된 일정이 없습니다');
  await expect(page.locator('.event-chip')).toHaveCount(0);
});
test('calendar load failure is explicit and retryable', async ({ page }) => {
  await mockApi(page, { user: ownerUser });
  let fail = true;
  await page.route('**/api/calendar/events?**', (route) =>
    fail
      ? route.fulfill({
          status: 500,
          json: { error: { code: 'REQUEST_FAILED', message: '요청을 처리하지 못했습니다.' } },
        })
      : route.fulfill({
          json: { events: [registered(1, '2026-10-20', '복구된 일정')], truncated: false },
        }),
  );
  await page.goto('/');
  const alert = page.getByRole('alert').filter({ hasText: '일시적인 오류' });
  await expect(alert).toBeVisible();
  fail = false;
  await alert.getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect(page.locator('.event-chip')).toHaveCount(1);
});
test('administrator header fits the viewport and account controls remain reachable', async ({
  page,
}) => {
  await mockApi(page, { user: adminUser });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '계정 등록', exact: true })).toBeVisible();
  for (const name of ['경제 캘린더', '종목 분석', '내 자산', 'AI 인사이트']) {
    await page
      .getByRole('button', {
        name: name === 'AI 인사이트' ? /AI 인사이트/ : name,
        exact: name !== 'AI 인사이트',
      })
      .click();
    const sizes = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      headerRight: document.querySelector('.top-actions')!.getBoundingClientRect().right,
    }));
    expect(sizes.document, `${name} admin document overflow`).toBeLessThanOrEqual(
      sizes.viewport + 1,
    );
    expect(sizes.headerRight, `${name} admin header outside viewport`).toBeLessThanOrEqual(
      sizes.viewport + 1,
    );
    await expect(page.getByRole('button', { name: '로그아웃', exact: true }).first()).toBeVisible();
  }
  await page.getByRole('button', { name: '계정 등록', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});
