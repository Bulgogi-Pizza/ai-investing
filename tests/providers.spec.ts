import { test, expect } from '@playwright/test';
import { adminUser, mockApi } from './fixtures/api-mock';
const user = adminUser;
const source = {
  id: 'fed-press',
  name: '공식 RSS 테스트 출처 ' + '긴출처식별자'.repeat(14),
  feedUrl: 'https://example.test/feed',
  country: '미국',
  coverage: '공식 발표 보도자료만 포함',
};
const event = {
  id: 840,
  date: '2026-10-20',
  time: '09:00',
  title: '수집된 공식 발표 테스트',
  country: '미국',
  category: '통화정책',
  assets: ['달러'],
  importance: 1,
  description: '테스트용 출처 분류이며 영향 미정.',
  sourceName: source.name,
  sourceUrl: 'https://example.test/release',
  impactDirection: 'unknown',
  impactHorizon: '발표 후 1일',
  confidence: 'low',
  factualObservedAt: '2026-10-20T00:00:00Z',
};
const insight = {
  engine: 'rules-v1',
  dataMode: 'live',
  asOf: '2026-10-20T00:00:00Z',
  period: 'daily',
  symbol: '005930',
  horizon: { tradingDays: 1, calendarDays: 1 },
  strategy: {
    name: '검증 전략',
    horizon: '5',
    benchmark: 'KOSPI200',
    riskTolerance: 'medium',
    targetAllocations: [{ asset: 'stock', percentage: 100 }],
    notes: '분산',
  },
  decision: {
    action: 'hold-plan',
    title: '규칙 판단 유지',
    rationale: '저장된 전략의 목표 비중을 점검합니다.',
    thresholdPercent: 4,
  },
  metrics: {
    returnPercent: 1,
    sma20: 70000,
    rsi14: 50,
    latestClose: 71000,
    latestTimestamp: '2026-10-20T00:00:00Z',
  },
  evidence: {
    news: {
      from: '2026-10-19',
      to: '2026-10-20',
      source: 'official-rss',
      events: [{ ...event, eventKind: 'news-release' }],
      truncated: false,
      coverageWarning: '공식 RSS 발표 뉴스만 포함',
      relevanceRule: '시장과 자산 관련성',
    },
    market: {
      source: '테스트 시세',
      asOf: '2026-10-20T00:00:00Z',
      candles: [{ timestamp: '2026-10-20T00:00:00Z', currency: 'KRW' }],
    },
    calendar: {
      from: '2026-10-20',
      to: '2026-10-21',
      source: 'admin-curated',
      events: [],
      truncated: false,
      coverageWarning: '등록 자료만 포함',
    },
  },
  scenarios: ['목표 비중 유지'],
  risks: ['미래 수익 보장 없음'],
  stockExposureByCurrency: [],
};
test.beforeEach(async ({ page }) => {
  await mockApi(page, { user });
  await page.route('**/api/news/sources', (route) =>
    route.fulfill({
      json: { sources: [source], warnings: ['발표 시각 기준 뉴스이며 미래 일정 아님'] },
    }),
  );
});
test('administrator syncs official news with coverage and refreshes registered events', async ({
  page,
}) => {
  await page.route('**/api/calendar/events?**', (route) =>
    route.fulfill({ json: { events: [event], truncated: false } }),
  );
  await page.route('**/api/admin/news/sync', (route) => {
    expect(route.request().postDataJSON()).toEqual({ sourceIds: ['fed-press'] });
    return route.fulfill({
      json: {
        count: 1,
        sources: [{ id: source.id, name: source.name, status: 'synced', count: 1 }],
        warnings: ['중요도와 영향 태그는 규칙 추정'],
      },
    });
  });
  await page.goto('/');
  await expect(
    page
      .getByRole('region', { name: '공식 뉴스 수집 관리' })
      .getByRole('link', { name: /공식 RSS 테스트 출처/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: '공식 뉴스 수집', exact: true }).click();
  await expect(page.locator('.news-sync-summary')).toContainText('추가·갱신 1건');
  await expect(page.locator('.news-sync-summary')).toContainText('규칙 추정');
  await expect(page.locator('.event-chip')).toHaveCount(1);
  if ((page.viewportSize()?.width ?? 0) <= 600) {
    const provider = page.getByRole('region', { name: '공식 뉴스 수집 관리' });
    await expect(provider.locator('.subtle').first()).toHaveCSS('font-size', '11px');
    await expect(provider.locator('.news-sync-summary .subtle').first()).toHaveCSS(
      'font-size',
      '12px',
    );
    await expect(provider.locator('.tag-row a')).toHaveCSS('font-size', '11px');
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await expect(page.locator('.event-chip')).toContainText('수집된 공식 발표 테스트');
  await expect(page.getByRole('region', { name: '공식 뉴스 수집 관리' })).toContainText(
    '미래 경제 일정이 아니며',
  );
});
test('failed source sync does not report imported news or invent events', async ({ page }) => {
  await page.route('**/api/admin/news/sync', (route) =>
    route.fulfill({
      status: 503,
      json: {
        count: 0,
        sources: [{ id: source.id, name: source.name, status: 'failed', count: 0 }],
        warnings: ['출처 응답 없음'],
        error: { code: 'NEWS_SYNC_FAILED', message: '공식 뉴스 수집에 실패했습니다.' },
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: '공식 뉴스 수집', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('공식 뉴스 수집에 실패했습니다.');
  await expect(page.locator('.news-sync-summary')).toContainText('수집 실패');
  await expect(page.locator('.event-chip')).toHaveCount(8);
});
test('Vertex narrative is separate from deterministic rules and cites sources', async ({
  page,
}) => {
  await page.route('**/api/recommendations?**', (route) =>
    route.fulfill({
      json: {
        ...insight,
        ai: {
          status: 'ready',
          type: 'llm',
          provider: 'vertex',
          model: 'gemini-test-fixture',
          asOf: '2026-10-20T00:00:00Z',
          summary: '입력된 자료 범위에서 목표 비중을 다시 확인하세요.',
          actions: ['다음 발표 후 전략을 점검하세요.'],
          counterScenario: '물가가 반대로 움직이면 기존 해석을 재검토합니다.',
          dataGaps: ['환율 변동의 영향은 평가하지 않았습니다.'],
          confidenceExplanation: '입력 자료가 제한되어 확신은 낮습니다.',
          sourceIds: ['price:005930'],
          sources: [
            { id: 'price:005930', title: '조회 가격 근거', url: 'https://example.test/quote' },
          ],
        },
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: /AI 인사이트/ }).click();
  await expect(page.getByRole('heading', { name: '규칙 판단 유지' })).toBeVisible();
  const newsCard = page.getByRole('region', { name: '공식 발표 뉴스 근거' });
  await expect(newsCard).toContainText('수집된 공식 발표 테스트');
  await expect(newsCard).toContainText('발표 2026-10-20 09:00 KST');
  await expect(newsCard).toContainText('미래 경제 일정이 아닙니다.');
  const card = page.getByRole('region', { name: 'Gemini AI 해석' });
  await expect(card).toContainText('gemini-test-fixture');
  if ((page.viewportSize()?.width ?? 0) <= 600) {
    await expect(card.locator('.invest-section-title p')).toHaveCSS('font-size', '11px');
    await expect(card.locator('.invest-live-list li').first()).toHaveCSS('font-size', '12px');
    await expect(newsCard.locator('.invest-event-evidence small').first()).toHaveCSS(
      'font-size',
      '11px',
    );
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await expect(card).toContainText('반대 시나리오');
  await expect(card).toContainText('확신은 낮습니다');
  await expect(card.getByRole('link', { name: '원문 확인 ↗' })).toHaveAttribute(
    'href',
    'https://example.test/quote',
  );
});
test('unavailable Vertex keeps rules and explicitly shows pending AI', async ({ page }) => {
  await page.route('**/api/recommendations?**', (route) =>
    route.fulfill({
      json: {
        ...insight,
        ai: {
          status: 'unavailable',
          type: 'llm',
          provider: 'vertex',
          message: 'AI 해석을 제공할 수 없습니다. 잠시 후 다시 시도하세요.',
        },
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: /AI 인사이트/ }).click();
  await expect(page.getByRole('heading', { name: '규칙 판단 유지' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'LLM 연결 대기' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Gemini AI 해석' })).toHaveCount(0);
});

test.afterEach(async ({ page }, info) => {
  if (info.title.startsWith('administrator syncs') || info.title.startsWith('Vertex narrative'))
    await page.screenshot({
      path: info.outputPath(
        `${info.project.name}-${info.title.startsWith('administrator') ? 'news-provider' : 'ai-provider'}.png`,
      ),
      fullPage: true,
      animations: 'disabled',
    });
});
