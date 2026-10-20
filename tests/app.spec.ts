import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'AUTH_REQUIRED' } }),
    }),
  );
  await page.goto('/');
});

test('calendar filters, views and month navigation remain consistent', async ({ page }) => {
  await expect(page.getByRole('heading', { name: '경제 캘린더', exact: true })).toBeVisible();
  await page.getByLabel('중요도 필터').selectOption('3');
  await page.getByLabel('시장 필터').selectOption('한국');
  await expect(page.locator('.event-chip')).toHaveCount(2);
  await page.getByLabel('자산 필터').selectOption('유가');
  await expect(page.locator('.event-chip')).toHaveCount(0);
  await page.getByRole('button', { name: '초기화', exact: true }).click();
  await expect(page.locator('.event-chip')).toHaveCount(16);
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
});

test('chart tools render calculated comparisons and validate reference lines', async ({ page }) => {
  await page.getByRole('button', { name: '차트 분석', exact: true }).click();
  await expect(page.locator('.chart-canvas svg')).toBeVisible();
  await page.getByRole('button', { name: 'KOSPI 비교', exact: true }).click();
  await expect(page.locator('.chart-price')).toContainText('기준 100');
  await page.getByRole('button', { name: 'EMA 20', exact: true }).click();
  await page.getByRole('button', { name: '볼린저 밴드', exact: true }).click();
  await page.getByRole('button', { name: 'MACD', exact: true }).click();
  await page.getByLabel('매수 검토선').fill('99000');
  await expect(page.getByText('매수 검토선은 매도 검토선보다 낮게 설정하세요.')).toBeVisible();
  await page.getByLabel('종목 선택').selectOption('Apple');
  await expect(page.locator('.chart-symbol')).toContainText('AAPL');
});

test('portfolio privacy, allocation validation and recommendation scenarios work', async ({
  page,
}) => {
  await page.getByRole('button', { name: '내 자산', exact: true }).click();
  await expect(page.getByText('예시 데이터 · 실제 계좌 아님')).toBeVisible();
  await page.getByRole('button', { name: '잔액 숨기기', exact: true }).click();
  await expect(page.locator('.invest-big-number')).toHaveText('••••••');
  await page.getByLabel('주식 목표 비중').fill('90');
  await expect(page.getByRole('button', { name: '예시 전략 적용', exact: true })).toBeDisabled();
  await page.getByLabel('주식 목표 비중').fill('55');
  await page.getByRole('button', { name: '예시 전략 적용', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('예시 전략 적용 완료');
  await page.getByRole('button', { name: /AI 인사이트/ }).click();
  await page.getByRole('button', { name: '주간', exact: true }).click();
  await expect(page.locator('.invest-insight-top')).toContainText('5 거래일');
  await page.getByRole('button', { name: '배분 시나리오 적용', exact: true }).click();
  await expect(page.locator('.invest-scenario-status')).toContainText('시나리오 적용됨');
});

test('all pages fit the viewport and login is reachable', async ({ page }) => {
  for (const name of ['경제 캘린더', '차트 분석', '내 자산', 'AI 인사이트']) {
    await page
      .getByRole('button', {
        name: name === 'AI 인사이트' ? /AI 인사이트/ : name,
        exact: name !== 'AI 인사이트',
      })
      .click();
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    );
    expect(fits, `${name}: horizontal overflow`).toBe(true);
  }
  await page.getByRole('button', { name: '로그인', exact: true }).last().click();
  await expect(page.getByRole('dialog', { name: '로그인', exact: true })).toBeVisible();
});

test('live holdings replace demo, preserve currency and convert return ratio to percent', async ({
  page,
}) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: { user: { id: 'owner-test', email: 'owner@example.test', role: 'member' } },
    }),
  );
  await page.route('**/api/strategy', (route) => route.fulfill({ json: { strategy: null } }));
  await page.route('**/api/portfolio', (route) =>
    route.fulfill({
      json: {
        source: 'Toss Securities OpenAPI',
        asOf: '2026-10-20T00:00:00Z',
        scope: 'stocks-only',
        totals: {
          KRW: { marketValue: '7200000', purchaseAmount: '6500000', profitLoss: '700000' },
          USD: { marketValue: '1785', purchaseAmount: '1553', profitLoss: '232' },
        },
        holdings: [
          {
            symbol: '005930',
            name: '계약 테스트 종목',
            market: 'KR',
            currency: 'KRW',
            quantity: '100',
            lastPrice: '72000',
            marketValue: '7200000',
            profitLoss: '700000',
            profitLossRate: '0.1077',
          },
        ],
      },
    }),
  );
  await page.reload();
  await page.getByRole('button', { name: '내 자산', exact: true }).click();
  await expect(page.getByText('실계좌 · 주식 전용')).toBeVisible();
  await expect(page.getByText('계약 테스트 종목')).toBeVisible();
  await expect(page.getByText('10.77%', { exact: true })).toBeVisible();
  await expect(page.getByText('7,200,000원', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('1,785 USD', { exact: true })).toBeVisible();
  await expect(page.getByText('미국 대형주 ETF', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '잔액 숨기기', exact: true }).first().click();
  await expect(page.locator('.invest-big-number').first()).toHaveText('••••••');
});

test('registered calendar shows provenance and multi-asset filter without demo leakage', async ({
  page,
}) => {
  const event = {
    id: 9001,
    date: '2026-10-20',
    time: '10:30',
    title: '검증용 등록 일정',
    country: '한국',
    category: '통화정책',
    assets: ['금리', '채권'],
    importance: 3,
    description: '자동 수집 없이 계약 테스트에서 주입한 일정입니다.',
    sourceUrl: 'https://www.bok.or.kr/',
    sourceName: '테스트 출처',
    impactDirection: 'mixed',
    impactHorizon: '1주',
    confidence: 'low',
    factualObservedAt: '2026-10-20T00:00:00Z',
  };
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: { user: { id: 'admin-test', email: 'admin@example.test', role: 'admin' } },
    }),
  );
  await page.route('**/api/calendar/events?*', (route) =>
    route.fulfill({ json: { events: [event], source: 'admin-curated', truncated: false } }),
  );
  await page.reload();
  await page.getByRole('button', { name: '등록 일정', exact: true }).click();
  await expect(page.locator('.event-chip')).toHaveCount(1);
  await page.getByLabel('자산 필터').selectOption('채권');
  await expect(page.locator('.event-chip')).toHaveCount(1);
  await page.locator('.event-chip').click();
  await expect(page.getByRole('link', { name: /테스트 출처/ })).toHaveAttribute(
    'href',
    'https://www.bok.or.kr/',
  );
  await expect(page.getByText('미국 소비자물가지수 (CPI)', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '일정 JSON 등록', exact: true }).click();
  await expect(page.getByRole('dialog', { name: /일정 JSON 등록/ })).toBeVisible();
});

test('capture rendered visual evidence', async ({ page }, testInfo) => {
  for (const [name, slug] of [
    ['경제 캘린더', 'calendar'],
    ['차트 분석', 'charts'],
    ['내 자산', 'portfolio'],
    ['AI 인사이트', 'insights'],
  ]) {
    await page
      .getByRole('button', {
        name: name === 'AI 인사이트' ? /AI 인사이트/ : name,
        exact: name !== 'AI 인사이트',
      })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Recharts animation only; deterministic screenshot after animation completion.
    if (await page.locator('svg.recharts-surface').count())
      await expect(page.locator('svg.recharts-surface').first()).toBeVisible();
    await page.screenshot({
      path: `.local/qa/${testInfo.project.name}-${slug}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
});
