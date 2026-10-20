import { test, expect } from '@playwright/test';

const liveInsight = {
  engine: 'rules-v1',
  dataMode: 'live',
  asOf: '2026-10-20T01:00:00Z',
  period: 'daily',
  symbol: '005930',
  horizon: { tradingDays: 1, calendarDays: 1 },
  strategy: {
    name: '검증용 장기 전략',
    horizon: '5',
    benchmark: 'KOSPI 200',
    riskTolerance: 'medium',
    targetAllocations: [
      { asset: 'stock', percentage: 60 },
      { asset: 'bond', percentage: 30 },
      { asset: 'cash', percentage: 10 },
    ],
    notes: '분산 투자',
  },
  decision: {
    action: 'hold-plan',
    title: '저장된 투자 원칙 점검',
    rationale: '실제 입력 계약을 모사한 응답으로 기간 수익률과 목표 배분을 점검합니다.',
    thresholdPercent: 4,
  },
  metrics: {
    returnPercent: 1.25,
    sma20: 71000,
    rsi14: 58.4,
    latestClose: 72400,
    latestTimestamp: '2026-10-20T00:00:00Z',
  },
  evidence: {
    market: {
      source: 'Toss Securities OpenAPI',
      asOf: '2026-10-20T01:00:00Z',
      candles: [{ timestamp: '2026-10-20T00:00:00Z' }],
    },
    calendar: {
      from: '2026-10-20',
      to: '2026-10-21',
      source: 'admin-curated',
      events: [
        {
          id: 4,
          date: '2026-10-20',
          time: '09:00',
          title: '검증용 등록 경제 일정',
          importance: 3,
          sourceName: '공식 발표 출처',
          sourceUrl: 'https://example.com/release',
          factualObservedAt: '2026-10-20T00:00:00Z',
        },
      ],
      truncated: false,
      coverageWarning: '관리자가 등록한 일정만 포함하며 전체 뉴스가 아닙니다.',
    },
  },
  scenarios: ['목표 비중 유지 후 다음 기간 재점검'],
  risks: ['과거 가격 변화는 미래 수익을 보장하지 않습니다.'],
  stockExposureByCurrency: [
    { currency: 'KRW', holdings: [{ symbol: '005930', weightWithinStocksPercent: 70 }] },
  ],
};
test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'AUTH_REQUIRED' } }),
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'AI 인사이트', exact: false }).click();
});
test('내 데이터 분석 shows sourced rules and reloads by horizon without demo evidence', async ({
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
  await page.getByRole('button', { name: '내 데이터 분석', exact: true }).click();
  await expect(page.getByRole('heading', { name: '저장된 투자 원칙 점검' })).toBeVisible();
  await expect(page.getByText('Toss Securities OpenAPI', { exact: true })).toBeVisible();
  await expect(page.getByText('검증용 등록 경제 일정', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /공식 발표 출처/ })).toHaveAttribute(
    'href',
    'https://example.com/release',
  );
  await expect(page.getByRole('heading', { name: '판단의 전제와 위험' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '배분 시나리오 적용' })).toHaveCount(0);
  await page.getByRole('button', { name: '주간', exact: true }).click();
  await expect(page.getByText('5거래일 관찰', { exact: true })).toBeVisible();
  await expect(
    page.getByText('과거 가격 변화는 미래 수익을 보장하지 않습니다.', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath('recommendations-live.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: '합성 예시', exact: true }).click();
  await expect(page.getByRole('button', { name: '배분 시나리오 적용' })).toBeVisible();
});
test('내 데이터 분석 errors stay explicit and never substitute synthetic analysis', async ({
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
  await page.getByRole('button', { name: '내 데이터 분석', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('검증된 실제 시장 데이터가 필요합니다.');
  await expect(page.getByText('실제 분석 실패 시 합성 추천으로 대체하지 않습니다.')).toBeVisible();
  await expect(page.locator('.invest-insight-hero')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '다시 시도' })).toBeVisible();
});
