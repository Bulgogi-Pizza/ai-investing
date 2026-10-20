import { test, expect } from '@playwright/test';
import { liveInsight, mockApi, ownerUser } from './fixtures/api-mock';

test.beforeEach(async ({ page }) => {
  await mockApi(page, { user: ownerUser });
  await page.goto('/');
});
const openInsights = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: 'AI 인사이트', exact: false }).click();
const analyze = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: '분석 실행', exact: true }).click();
test('AI 인사이트 shows sourced rules and reloads by horizon without demo evidence', async ({
  page,
}, info) => {
  await page.route('**/api/recommendations?**', (route) => {
    const period = new URL(route.request().url()).searchParams.get('period') || 'daily';
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ...liveInsight,
        period,
        horizon: {
          tradingDays: period === 'weekly' ? 5 : 1,
          calendarDays: period === 'weekly' ? 7 : 1,
        },
      }),
    });
  });
  await openInsights(page);
  await analyze(page);
  await expect(page.getByRole('heading', { name: '저장된 투자 원칙 점검' })).toBeVisible();
  await expect(page.getByText('Toss Securities OpenAPI', { exact: true })).toBeVisible();
  await expect(page.getByText('검증용 등록 경제 일정', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /공식 발표 출처/ })).toHaveAttribute(
    'href',
    'https://example.com/release',
  );
  await expect(
    page.getByText('일정 관련성 기준: 한국 시장 또는 글로벌 일정과 해당 종목 직접 태그'),
  ).toBeVisible();
  await expect(page.getByText('관련성 기준에 따라 제외한 일정: 2건')).toBeVisible();
  await expect(page.getByRole('heading', { name: '판단의 전제와 위험' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '배분 시나리오 적용' })).toHaveCount(0);
  await page.getByRole('button', { name: '주간', exact: true }).click();
  await analyze(page);
  await expect(page.getByText('5거래일 관찰', { exact: true })).toBeVisible();
  await expect(
    page.getByText('과거 가격 변화는 미래 수익을 보장하지 않습니다.', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath('recommendations-live.png'),
    fullPage: true,
  });
  await expect(page.getByRole('button', { name: '합성 예시' })).toHaveCount(0);
});
test('AI 인사이트 errors stay explicit and never substitute synthetic analysis', async ({
  page,
}) => {
  await page.route('**/api/recommendations?**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'VERIFIED_DATA_REQUIRED', message: '검증된 실제 시장 데이터가 필요합니다.' },
      }),
    }),
  );
  await openInsights(page);
  await analyze(page);
  await expect(page.locator('.invest-page').getByRole('alert')).toContainText(
    '검증된 실제 시장 데이터가 필요합니다.',
  );
  await expect(page.getByText('예시 값으로 대체하지 않습니다.')).toHaveCount(0);
  await expect(page.locator('.invest-insight-hero')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '다시 시도' })).toBeVisible();
});
