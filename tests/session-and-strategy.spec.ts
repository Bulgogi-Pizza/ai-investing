import { test, expect, type Page } from '@playwright/test';
import { event, liveInsight, mockApi, ownerUser } from './fixtures/api-mock';

const stored = {
  name: '나의 투자 전략',
  horizon: '3',
  benchmark: 'KOSPI 200',
  riskTolerance: 'low',
  targetAllocations: [
    { asset: 'stock', percentage: 40 },
    { asset: 'bond', percentage: 40 },
    { asset: 'gold', percentage: 10 },
    { asset: 'cash', percentage: 10 },
  ],
  notes: '배당 선호',
};
const open = (page: Page, name: string | RegExp) =>
  page.getByRole('button', { name, exact: typeof name === 'string' }).click();

test.describe('strategy editor never shows defaults as the saved strategy', () => {
  test('failed load shows retry and no editor or save button', async ({ page }) => {
    await mockApi(page, { user: ownerUser, strategy: stored });
    let fail = true;
    await page.route('**/api/strategy', (route) =>
      fail
        ? route.fulfill({
            status: 500,
            json: { error: { code: 'REQUEST_FAILED', message: '요청을 처리하지 못했습니다.' } },
          })
        : route.fulfill({ json: { strategy: stored } }),
    );
    await page.goto('/');
    await open(page, '내 자산');
    const alert = page.getByRole('alert').filter({ hasText: '내 전략을 불러오지 못했습니다' });
    await expect(alert).toBeVisible();
    await expect(page.getByLabel('주식 목표 비중')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '내 전략 저장' })).toHaveCount(0);
    fail = false;
    await alert.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect(page.getByLabel('주식 목표 비중')).toHaveValue('40');
    await expect(page.getByRole('button', { name: '내 전략 저장' })).toBeEnabled();
  });
  test('slow load shows no editor until the stored strategy arrives; save keeps stored values', async ({
    page,
  }) => {
    await mockApi(page, { user: ownerUser });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const bodies: unknown[] = [];
    await page.route('**/api/strategy', async (route) => {
      if (route.request().method() === 'PUT') {
        bodies.push(route.request().postDataJSON());
        return route.fulfill({ json: { strategy: stored } });
      }
      await gate;
      return route.fulfill({ json: { strategy: stored } });
    });
    await page.goto('/');
    await open(page, '내 자산');
    await expect(page.getByText('저장된 전략을 불러오는 중…')).toBeVisible();
    await expect(page.getByLabel('주식 목표 비중')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '내 전략 저장' })).toHaveCount(0);
    release();
    await expect(page.getByLabel('주식 목표 비중')).toHaveValue('40');
    await expect(page.getByText('내 계정 전략', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '내 전략 저장' }).click();
    await expect(page.getByText('내 계정에 전략을 저장했습니다.')).toBeVisible();
    expect(bodies).toHaveLength(1);
    expect(
      (
        bodies[0] as {
          strategy: { riskTolerance: string; targetAllocations: { percentage: number }[] };
        }
      ).strategy,
    ).toMatchObject({
      riskTolerance: 'low',
      targetAllocations: [
        { percentage: 40 },
        { percentage: 40 },
        { percentage: 10 },
        { percentage: 10 },
      ],
    });
  });
  test('first use (strategy null) starts from labeled defaults', async ({ page }) => {
    await mockApi(page, { user: ownerUser, strategy: null });
    await page.goto('/');
    await open(page, '내 자산');
    await expect(page.getByText('새 전략 · 기본값')).toBeVisible();
    await expect(page.getByLabel('주식 목표 비중')).toHaveValue('55');
  });
  test('an unreadable stored strategy blocks editing instead of offering defaults', async ({
    page,
  }) => {
    await mockApi(page, { user: ownerUser });
    await page.route('**/api/strategy', (route) =>
      route.fulfill({ json: { strategy: { targetAllocations: 'broken' } } }),
    );
    await page.goto('/');
    await open(page, '내 자산');
    await expect(page.getByRole('alert').filter({ hasText: '편집을 막았습니다' })).toBeVisible();
    await expect(page.getByLabel('주식 목표 비중')).toHaveCount(0);
  });
});

test.describe('session expiry', () => {
  test('a 401 on any panel returns to the login screen', async ({ page }) => {
    await mockApi(page, { user: ownerUser });
    await page.goto('/');
    await expect(page.locator('.market-strip')).toBeVisible();
    await page.route('**/api/market/candles?**', (route) =>
      route.fulfill({
        status: 401,
        json: { error: { code: 'AUTH_REQUIRED', message: '로그인이 필요합니다.' } },
      }),
    );
    await open(page, '차트 분석');
    await expect(page.getByRole('region', { name: '나의 투자 공간에 로그인' })).toBeVisible();
    await expect(page.locator('.sidebar')).toHaveCount(0);
  });
  test('a 401 from the calendar also ends the session view', async ({ page }) => {
    await mockApi(page, { user: ownerUser });
    await page.route('**/api/calendar/events?**', (route) =>
      route.fulfill({
        status: 401,
        json: { error: { code: 'AUTH_REQUIRED', message: '로그인이 필요합니다.' } },
      }),
    );
    await page.goto('/');
    await expect(page.getByRole('region', { name: '나의 투자 공간에 로그인' })).toBeVisible();
  });
});

test.describe('AI insight runs only on request', () => {
  test('changing period or symbol sends nothing; run is disabled while running', async ({
    page,
  }) => {
    await mockApi(page, { user: ownerUser });
    let sent = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/recommendations?**', async (route) => {
      sent += 1;
      await gate;
      return route.fulfill({ json: liveInsight });
    });
    await page.goto('/');
    await open(page, /AI 인사이트/);
    await expect(page.getByText('아직 분석하지 않았습니다')).toBeVisible();
    await page.getByRole('button', { name: '주간', exact: true }).click();
    await page.getByLabel('분석 종목').selectOption('AAPL');
    await page.getByRole('button', { name: '월간', exact: true }).click();
    expect(sent).toBe(0);
    await page.getByRole('button', { name: '데일리', exact: true }).click();
    await page.getByLabel('분석 종목').selectOption('005930');
    await page.getByRole('button', { name: '분석 실행', exact: true }).click();
    await expect(page.getByRole('button', { name: '분석 중…' })).toBeDisabled();
    release();
    await expect(page.getByRole('heading', { name: '저장된 투자 원칙 점검' })).toBeVisible();
    expect(sent).toBe(1);
    // After a result, changing inputs only marks it stale; nothing is requested.
    await page.getByRole('button', { name: '주간', exact: true }).click();
    await expect(page.getByText('선택이 바뀌었습니다.')).toBeVisible();
    expect(sent).toBe(1);
  });
  test('rate limit shows the wait time from Retry-After', async ({ page }) => {
    await mockApi(page, { user: ownerUser });
    await page.route('**/api/recommendations?**', (route) =>
      route.fulfill({
        status: 429,
        headers: { 'Retry-After': '42' },
        contentType: 'text/plain',
        body: 'Too many requests',
      }),
    );
    await page.goto('/');
    await open(page, /AI 인사이트/);
    await page.getByRole('button', { name: '분석 실행', exact: true }).click();
    await expect(page.locator('.invest-page').getByRole('alert')).toContainText('약 42초 후');
    await expect(page.getByRole('button', { name: '분석 실행', exact: true })).toBeEnabled();
  });
});

test.describe('external links', () => {
  test('only https source URLs become links', async ({ page }) => {
    const unsafe = {
      ...event(1, '2026-10-20', '09:00', '안전하지 않은 출처', '한국', '물가', ['원화'], 3),
      sourceUrl: 'javascript:alert(1)',
    };
    await mockApi(page, {
      user: ownerUser,
      events: [unsafe],
      insight: {
        ...liveInsight,
        evidence: {
          ...liveInsight.evidence,
          calendar: {
            ...liveInsight.evidence.calendar,
            events: [
              { ...liveInsight.evidence.calendar.events[0], sourceUrl: 'http://example.test/x' },
            ],
          },
        },
      },
    });
    await page.goto('/');
    await page.locator('.event-chip').click();
    await expect(page.locator('.event-provenance')).toContainText('테스트 출처');
    await expect(page.locator('.event-provenance a')).toHaveCount(0);
    await open(page, /AI 인사이트/);
    await page.getByRole('button', { name: '분석 실행', exact: true }).click();
    await expect(page.getByText('검증용 등록 경제 일정')).toBeVisible();
    await expect(page.getByRole('link', { name: /공식 발표 출처/ })).toHaveCount(0);
    await expect(page.getByText(/공식 발표 출처/)).toBeVisible();
  });
});
