import { test, expect } from '@playwright/test';
const registeredEvent = (id: number, date: string, title: string) => ({
  id,
  date,
  time: '09:00',
  title,
  country: '한국',
  category: '물가',
  assets: ['원화', '채권'],
  importance: 1,
  description: '회복 여부에 따라 영향은 달라질 수 있습니다.',
  sourceUrl: 'https://example.test/economic-release',
  sourceName: '테스트 제공기관',
  impactDirection: 'unknown',
  impactHorizon: '발표 후 1일',
  confidence: 'low',
  factualObservedAt: '2026-10-20T00:00:00Z',
});
test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: { user: { id: 'test-reader', email: 'reader@example.test', role: 'member' } },
    }),
  );
});
test('low importance remains low in details and truncated results are disclosed', async ({
  page,
}) => {
  await page.route('**/api/calendar/events?**', (route) =>
    route.fulfill({
      json: {
        events: [registeredEvent(20, '2026-10-20', '낮은 중요도 확인 일정')],
        truncated: true,
        limit: 2000,
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: '등록 일정', exact: true }).click();
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
  await page.route('**/api/calendar/events?**', (route) =>
    route.fulfill({
      json: {
        events: [
          registeredEvent(2, '2027-01-01', '새해 첫 일정'),
          registeredEvent(1, '2026-12-31', '연말 마지막 일정'),
        ],
        truncated: false,
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: '등록 일정', exact: true }).click();
  await page.getByRole('button', { name: '다음 기간', exact: true }).click();
  await page.getByRole('button', { name: '다음 기간', exact: true }).click();
  await page.getByRole('button', { name: '12월 31일 일정', exact: true }).click();
  await page.getByRole('button', { name: '주간', exact: true }).click();
  await expect(page.locator('.agenda-event')).toHaveCount(2);
  await expect(page.locator('.agenda-event').nth(0)).toContainText('연말 마지막 일정');
  await expect(page.locator('.agenda-event').nth(1)).toContainText('새해 첫 일정');
});
test('actual USD closing quote retains its cents', async ({ page }) => {
  await page.route('**/api/market/candles?**', (route) =>
    route.fulfill({
      json: {
        source: 'Test quote provider',
        asOf: '2026-10-20T00:00:00Z',
        symbol: 'AAPL',
        interval: '1d',
        adjusted: true,
        candles: [
          {
            timestamp: '2026-10-19T00:00:00Z',
            open: '230',
            high: '235',
            low: '229',
            close: '231.25',
            volume: '100',
            currency: 'USD',
          },
          {
            timestamp: '2026-10-20T00:00:00Z',
            open: '232',
            high: '236',
            low: '231',
            close: '234.76',
            volume: '100',
            currency: 'USD',
          },
        ],
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: '차트 분석', exact: true }).click();
  await page.getByLabel('종목 선택').selectOption('Apple');
  await page.getByRole('button', { name: '토스 API 시세 연결', exact: true }).click();
  await expect(page.locator('.chart-price')).toContainText('234.76');
  await expect(page.locator('.chart-price')).toContainText('USD');
});
