import { expect, test, type Page } from '@playwright/test';
import { mockApi, ownerUser, type MockOptions } from './fixtures/api-mock';

// Browser tests for the 종목 분석 event lines (5d) and market comparison / own trades (5e).
// The API is faked with page.route; every event, series and fill is synthetic test data.
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function start(page: Page, options: MockOptions = {}, symbol?: string) {
  const api = await mockApi(page, { user: ownerUser, ...options });
  await page.goto('/');
  await page.getByRole('button', { name: '종목 분석', exact: true }).click();
  if (symbol) {
    await page.getByLabel('종목 코드로 조회', { exact: false }).fill(symbol);
    await page.getByRole('button', { name: '조회', exact: true }).click();
  }
  await expect(page.locator('.analysis-chart-main svg').first()).toBeVisible();
  return api;
}
const anchors = (page: Page) => page.getByTestId('event-anchor');
const filter = (page: Page, id: string) => page.locator(`[data-filter="${id}"]`);
const compare = (page: Page, id: string) => page.locator(`[data-compare="${id}"]`);
const trade = (page: Page, id: string) => page.locator(`[data-trade="${id}"]`);
const eventRequests = (requests: string[]) =>
  requests.filter((r) => r.startsWith('GET /api/analysis/events'));
const yTicks = (page: Page) =>
  page
    .locator('.analysis-chart-main .recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value')
    .allTextContents();

test.describe('event lines', () => {
  test('KR stock: dashed lines per event day with default filters and a per-source summary', async ({
    page,
  }) => {
    const api = await start(page);
    // Window 2026-08-19 .. 2026-10-20 (63 daily candles). Default filter: 최상·높음.
    await expect(page.getByTestId('event-summary')).toContainText('표시 7건(차트 위 6일)');
    await expect(anchors(page)).toHaveCount(6);
    await expect(page.locator('.event-mark line')).toHaveCount(6);
    for (const date of [
      '2026-08-26',
      '2026-09-16',
      '2026-10-02',
      '2026-10-08',
      '2026-10-13',
      '2026-10-15',
    ])
      await expect(page.locator(`[data-event-date="${date}"]`)).toHaveCount(1);
    // The 보통 event (감사보고서) is off by default.
    await expect(page.locator('[data-event-date="2026-10-06"]')).toHaveCount(0);
    await expect(page.getByTestId('event-source-dart')).toContainText('DART 공시(국내)');
    await expect(page.getByTestId('event-source-calendar')).toContainText('2건');
    await expect(page.getByTestId('event-source-sec')).toHaveCount(0); // 해당 없음 is not shown
    expect(eventRequests(api.requests)).toHaveLength(1);
    expect(eventRequests(api.requests)[0]).toContain(
      'market=KR&symbol=005930&from=2026-08-19&to=2026-10-20',
    );
    expect(await fits(page)).toBe(true);
  });

  test('filters (importance, kind, market) change the lines without another request', async ({
    page,
  }) => {
    const api = await start(page);
    await expect(anchors(page)).toHaveCount(6);
    await filter(page, 'importance-1').click();
    await expect(anchors(page)).toHaveCount(7);
    await filter(page, 'importance-1').click();
    await filter(page, 'importance-2').click(); // 최상 only
    await expect(anchors(page)).toHaveCount(5);
    await expect(page.locator('[data-event-date="2026-08-26"]')).toHaveCount(0);
    await filter(page, 'importance-2').click();
    await filter(page, 'kind-rate-decision').click(); // hide 금리 결정
    await expect(page.locator('[data-event-date="2026-09-16"]')).toHaveCount(0);
    await expect(page.locator('[data-event-date="2026-10-15"]')).toHaveCount(1); // DART still there
    await filter(page, 'kind-rate-decision').click();
    await filter(page, 'market-US').click(); // 국내 only
    await expect(anchors(page)).toHaveCount(3);
    await expect(page.locator('[data-event-date="2026-10-13"]')).toHaveCount(0);
    await filter(page, 'market-KR').click(); // nothing selected
    await expect(anchors(page)).toHaveCount(0);
    await expect(page.getByText('선택한 조건에 맞는 이벤트가 이 구간에 없습니다')).toBeVisible();
    expect(eventRequests(api.requests)).toHaveLength(1);
    // Filter buttons expose their state.
    await expect(filter(page, 'market-KR')).toHaveAttribute('aria-pressed', 'false');
    await expect(filter(page, 'importance-3')).toHaveAttribute('aria-pressed', 'true');
  });

  test('hover and keyboard open a tooltip with every event of the day and an https source link', async ({
    page,
  }) => {
    await start(page);
    const day = page.locator('[data-event-date="2026-10-15"]');
    await day.hover();
    const tooltip = page.getByTestId('event-tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('2026-10-15');
    await expect(tooltip).toContainText('테스트 기준금리 결정');
    await expect(tooltip).toContainText('주요사항보고서(테스트 결정)');
    await expect(tooltip).toContainText('최상');
    await expect(tooltip).toContainText('금리 결정 · 국내');
    const link = tooltip.getByRole('link', { name: '테스트 한국은행' });
    await expect(link).toHaveAttribute('href', 'https://source.example.test/calendar-2');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    // Moving the pointer away closes it.
    await page.mouse.move(5, 5);
    await expect(tooltip).toBeHidden();
    // Focus opens it without a pointer.
    const second = page.locator('[data-event-date="2026-10-13"]');
    await second.focus();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('테스트 미국 소비자물가 발표');
    await expect(tooltip).toContainText('미국');
    // Enter pins it and moves focus inside; Esc closes and gives the focus back.
    await page.keyboard.press('Enter');
    await expect(tooltip).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(tooltip.getByRole('button', { name: '이벤트 닫기' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(tooltip.getByRole('link', { name: 'FRED' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    await expect(second).toBeFocused();
    // The tooltip stays inside the viewport even next to the chart's right edge.
    await page.locator('[data-event-date="2026-10-15"]').click();
    const box = await tooltip.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  });

  test('labels never overlap and every event is also listed as text', async ({ page }) => {
    await start(page);
    await filter(page, 'importance-1').click();
    const boxes = await page.locator('.event-layer g.event-label rect').evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }),
    );
    expect(boxes.length).toBeGreaterThan(0);
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `labels ${i} and ${j}`).toBe(false);
      }
    // Text list: all 8 events, the unabridged titles included.
    await page.getByText('이벤트 목록 8건').click();
    const list = page.locator('.event-list');
    await expect(list).toContainText('연결재무제표기준영업(잠정)실적(공정공시)');
    await expect(list.getByRole('link', { name: 'DART 전자공시' }).first()).toHaveAttribute(
      'href',
      /^https:\/\/source\.example\.test\//,
    );
  });

  test('US stock reads SEC filings, not DART, and keeps the macro events', async ({ page }) => {
    const api = await start(page, {}, 'aapl');
    await expect(page.getByTestId('event-source-sec')).toContainText('SEC 공시(미국)');
    await expect(page.getByTestId('event-source-dart')).toHaveCount(0);
    expect(eventRequests(api.requests).at(-1)).toContain('market=US&symbol=AAPL');
    // SEC 8-K Item 2.02 (importance 3) is drawn; the 보통 8-K is not.
    await expect(page.locator('[data-event-date="2026-09-03"]')).toHaveCount(1);
    await expect(page.locator('[data-event-date="2026-09-20"]')).toHaveCount(0);
    await expect(page.locator('[data-event-date="2026-10-13"]')).toHaveCount(1);
  });

  test('one failing source is reported on its own and the chart still draws the rest', async ({
    page,
  }) => {
    await start(page, { chartEvents: 'dart-error' });
    const dart = page.getByTestId('event-source-dart');
    await expect(dart).toHaveAttribute('data-status', 'error');
    await expect(dart).toContainText('오류');
    await expect(page.getByTestId('event-source-calendar')).toHaveAttribute('data-status', 'ok');
    await expect(page.getByTestId('event-source-fred')).toHaveAttribute('data-status', 'ok');
    // FRED and registered events are still drawn; DART days are not.
    await expect(page.locator('[data-event-date="2026-10-13"]')).toHaveCount(1);
    await expect(page.locator('[data-event-date="2026-08-26"]')).toHaveCount(0);
    await expect(page.locator('.analysis-chart-main svg').first()).toBeVisible();
  });

  test('a provider that is not connected says so instead of drawing nothing silently', async ({
    page,
  }) => {
    await start(page, { chartEvents: 'fred-unavailable' });
    const fred = page.getByTestId('event-source-fred');
    await expect(fred).toHaveAttribute('data-status', 'unavailable');
    await expect(fred).toContainText('미연결');
    await expect(fred).toContainText('FRED');
    await expect(page.locator('[data-event-date="2026-10-13"]')).toHaveCount(0);
    await expect(page.locator('[data-event-date="2026-10-15"]')).toHaveCount(1);
  });

  test('the whole event request failing leaves the price chart in place', async ({ page }) => {
    await start(page, { chartEvents: 'fail' });
    const card = page.getByRole('region', { name: '이벤트 필터' });
    await expect(card.getByRole('alert')).toContainText('이벤트');
    await expect(card.getByRole('button', { name: '다시 시도' })).toBeVisible();
    await expect(anchors(page)).toHaveCount(0);
    await expect(page.locator('.analysis-chart-main svg').first()).toBeVisible();
    await expect(page.getByTestId('last-price')).toBeVisible();
  });

  test('no events: an explicit empty state, no lines', async ({ page }) => {
    await start(page, { chartEvents: 'empty' });
    await expect(page.getByText('선택한 조건에 맞는 이벤트가 이 구간에 없습니다')).toBeVisible();
    await expect(anchors(page)).toHaveCount(0);
  });

  test('filters and overlay choices are kept in memory only', async ({ page }) => {
    await start(page);
    await filter(page, 'importance-1').click();
    await compare(page, 'kospi').click();
    const stored = await page.evaluate(() => ({
      local: Object.keys(localStorage).filter((k) => /event|filter|compare|trade/i.test(k)),
      session: Object.keys(sessionStorage).filter((k) => /event|filter|compare|trade/i.test(k)),
    }));
    expect(stored).toEqual({ local: [], session: [] });
  });
});

test.describe('market comparison', () => {
  test('KOSPI is rebased to 100 at the first common date with its source and as-of', async ({
    page,
  }) => {
    const api = await start(page);
    expect(await yTicks(page)).not.toEqual([]);
    const before = (await yTicks(page)).map((t) => Number(t.replace(/,/g, '')));
    expect(Math.min(...before)).toBeGreaterThan(10000); // KRW prices
    // Nothing is requested for series that were never switched on.
    expect(
      api.requests.some((r) => r.includes('indicator-candles') || r.includes('/api/macro/')),
    ).toBe(false);
    expect(api.requests.some((r) => r.includes('symbol=SPY'))).toBe(false);
    await compare(page, 'kospi').click();
    await expect(page.getByTestId('compare-base')).toContainText('2026-08-19');
    await expect(page.getByTestId('compare-source-kospi')).toContainText(
      '출처: Toss Securities OpenAPI',
    );
    await expect(page.getByTestId('compare-source-kospi')).toContainText('KST');
    await expect(page.getByRole('list', { name: '범례' })).toContainText('코스피');
    await expect(page.getByRole('list', { name: '범례' })).toContainText('종가(기준 100)');
    const ticks = (await yTicks(page)).map((t) => Number(t.replace(/,/g, '')));
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      expect(tick).toBeGreaterThan(50);
      expect(tick).toBeLessThan(200);
    }
    expect(api.requests.some((r) => r.includes('/api/market/indicator-candles?symbol=KOSPI'))).toBe(
      true,
    );
    // Turning it off restores the price chart.
    await compare(page, 'kospi').click();
    await expect(page.getByTestId('compare-base')).toHaveCount(0);
    expect(
      Math.min(...(await yTicks(page)).map((t) => Number(t.replace(/,/g, '')))),
    ).toBeGreaterThan(10000);
  });

  test('all four series, S&P 500 labelled as the SPY ETF, USD/KRW from ECOS', async ({ page }) => {
    const api = await start(page);
    for (const id of ['kospi', 'kosdaq', 'sp500', 'usdkrw']) await compare(page, id).click();
    await expect(page.getByTestId('compare-source-usdkrw')).toContainText('한국은행 ECOS');
    await expect(page.getByTestId('compare-source-sp500')).toContainText('SPY');
    await expect(page.getByTestId('compare-source-sp500')).toContainText('ETF');
    await expect(compare(page, 'sp500')).toContainText('S&P 500 (SPY ETF 기준)');
    await expect(page.getByTestId('compare-source-kosdaq')).toContainText('KOSDAQ');
    await expect(page.getByTestId('compare-base')).toBeVisible();
    const legend = page.getByRole('list', { name: '범례' });
    for (const name of ['코스피', '코스닥', 'S&P 500 (SPY ETF 기준)', '원/달러 환율'])
      await expect(legend).toContainText(name);
    expect(api.requests.some((r) => r.includes('symbol=SPY&interval=1d'))).toBe(true);
    expect(api.requests.some((r) => r.includes('/api/macro/series?source=ecos&id=kr-usdkrw'))).toBe(
      true,
    );
  });

  test('a provider that is not connected shows 미연결 for that toggle and no fake line', async ({
    page,
  }) => {
    await start(page, { ecos: 'unavailable' });
    await compare(page, 'usdkrw').click();
    await expect(page.getByTestId('compare-note-usdkrw')).toHaveText('미연결');
    const source = page.getByTestId('compare-source-usdkrw');
    await expect(source).toContainText('연결되지 않았습니다');
    await expect(source).toContainText('한국은행 ECOS');
    await expect(page.getByRole('list', { name: '범례' })).not.toContainText('원/달러');
    await expect(page.getByTestId('compare-base')).toHaveCount(0);
    // The price chart is untouched and KOSPI still works next to the broken one.
    await compare(page, 'kospi').click();
    await expect(page.getByTestId('compare-base')).toBeVisible();
    await expect(page.getByRole('list', { name: '범례' })).toContainText('코스피');
    await expect(page.getByRole('list', { name: '범례' })).not.toContainText('원/달러');
  });

  test('a failing series is reported alone; the others still draw', async ({ page }) => {
    await start(page, { compareFail: ['SPY'] });
    await compare(page, 'sp500').click();
    await compare(page, 'kosdaq').click();
    await expect(page.getByTestId('compare-note-sp500')).toHaveText('오류');
    await expect(
      page.getByTestId('compare-source-sp500').getByRole('button', { name: '다시 시도' }),
    ).toBeVisible();
    await expect(page.getByTestId('compare-source-kosdaq')).toContainText('출처');
    await expect(page.getByTestId('compare-base')).toBeVisible();
    await expect(page.getByRole('list', { name: '범례' })).toContainText('코스닥');
    await expect(page.getByRole('list', { name: '범례' })).not.toContainText('S&P');
  });
});

test.describe('my trades', () => {
  test('average purchase price line from the holding, matched by symbol', async ({ page }) => {
    await start(page);
    const note = page.getByTestId('cost-note');
    await expect(note).toContainText('평균 매수가 68,000원');
    await expect(note).toContainText('보유 100주');
    await expect(note).toContainText('Toss Securities OpenAPI');
    await expect(page.locator('.analysis-chart-main')).toContainText('내 평균 매수가 68,000');
    await expect(page.getByRole('list', { name: '범례' })).toContainText('내 평균 매수가');
    // The toggle removes the line.
    await trade(page, 'cost').click();
    await expect(page.locator('.analysis-chart-main')).not.toContainText('내 평균 매수가');
  });

  test('a symbol that is not held says so and draws no line', async ({ page }) => {
    await start(page, {}, 'aapl');
    await expect(page.getByTestId('cost-note')).toContainText(
      '보유 종목에 없어 평균 매수가 선이 없습니다',
    );
    await expect(page.locator('.analysis-chart-main')).not.toContainText('내 평균 매수가');
  });

  test('algorithm fills are "미연결" until the paper-trade store exists, never invented', async ({
    page,
  }) => {
    await start(page);
    await expect(page.getByTestId('fills-unconnected')).toContainText('아직 연결되지 않았습니다');
    await expect(page.getByTestId('fill-mark')).toHaveCount(0);
  });

  test('fills draw ▲▼ marks labelled 가상 / 실제', async ({ page }) => {
    await start(page, { fills: 'some' });
    const marks = page.getByTestId('fill-mark');
    await expect(marks).toHaveCount(2);
    await expect(
      page.locator('[data-testid="fill-mark"][data-mode="paper"][data-side="buy"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-testid="fill-mark"][data-mode="live"][data-side="sell"]'),
    ).toHaveCount(1);
    const rows = page.getByTestId('fill-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('가상');
    await expect(rows.nth(0)).toContainText('매수');
    await expect(rows.nth(1)).toContainText('실제');
    await expect(rows.nth(1)).toContainText('매도');
    await expect(page.getByRole('list', { name: '범례' })).toContainText('속이 빈 표시는 가상');
    await trade(page, 'fills').click();
    await expect(page.getByTestId('fill-mark')).toHaveCount(0);
  });

  test('a failing fill source only affects its own note', async ({ page }) => {
    await start(page, { fills: 'error' });
    await expect(page.getByTestId('fills-note').getByRole('alert')).toContainText('알고리즘 체결');
    await expect(page.getByTestId('cost-note')).toContainText('평균 매수가 68,000원');
    await expect(page.locator('.analysis-chart-main svg').first()).toBeVisible();
  });

  test('comparison mode rebases the cost line and fills with the prices', async ({ page }) => {
    await start(page, { fills: 'some' });
    await compare(page, 'kospi').click();
    await expect(page.getByTestId('compare-base')).toBeVisible();
    await expect(page.getByTestId('fill-mark')).toHaveCount(2);
    await expect(page.locator('.analysis-chart-main')).toContainText('내 평균 매수가');
    for (const tick of (await yTicks(page)).map((t) => Number(t.replace(/,/g, '')))) {
      expect(tick).toBeLessThan(200);
    }
  });
});

test.describe('layout', () => {
  test('everything fits the viewport with events, comparison and trades on', async ({ page }) => {
    await start(page, { fills: 'some' });
    for (const id of ['kospi', 'sp500', 'usdkrw']) await compare(page, id).click();
    await filter(page, 'importance-1').click();
    await expect(page.getByTestId('compare-base')).toBeVisible();
    expect(await fits(page)).toBe(true);
    const chart = await page.locator('.analysis-chart-main').boundingBox();
    expect(chart!.width).toBeGreaterThan(280);
    expect(chart!.x + chart!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    await page.locator('[data-event-date="2026-10-15"]').hover();
    const tooltip = page.getByTestId('event-tooltip');
    await expect(tooltip).toBeVisible();
    const box = await tooltip.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    await page.locator('.analysis-chart-wrap').scrollIntoViewIfNeeded();
    await page.locator('.analysis-chart-wrap').screenshot({
      path: `test-results/analysis-events-chart-${test.info().project.name}.png`,
    });
    await page.screenshot({
      path: `test-results/analysis-events-${test.info().project.name}.png`,
      fullPage: true,
    });
  });
});
