import { expect, test, type Page } from '@playwright/test';
import { memberUser, mockApi, ownerUser, type MockOptions } from './fixtures/api-mock';

// Browser tests for the 종목 분석 tab. The API is faked with page.route (tests/fixtures);
// every value is synthetic and none of it is a market fact.
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function start(page: Page, options: MockOptions = {}, symbol?: string) {
  const api = await mockApi(page, { user: ownerUser, ...options });
  await page.goto('/');
  await page.getByRole('button', { name: '종목 분석', exact: true }).click();
  if (symbol) await search(page, symbol);
  return api;
}
async function search(page: Page, symbol: string) {
  await page.getByLabel('종목 코드로 조회', { exact: false }).fill(symbol);
  await page.getByRole('button', { name: '조회', exact: true }).click();
}
const error = (code: string, message: string) => ({ error: { code, message } });
const forbidden = error(
  'TOSS_PERMISSION_DENIED',
  '토스 Open API 키에 이 데이터를 조회할 권한이 없습니다.',
);
const tab = (page: Page, name: string) => page.getByRole('tab', { name });
const toggle = (page: Page, id: string) => page.locator(`[data-indicator="${id}"]`);

test.describe('summary', () => {
  test('Korean stock: price, change basis, market cap, PER/PBR provenance and badges', async ({
    page,
  }) => {
    await start(page);
    await expect(page.getByRole('heading', { level: 1, name: '종목 분석' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '테스트전자' })).toBeVisible();
    await expect(page.getByTestId('last-price')).toHaveText('71,234원');
    // Fixture: today's candle exists, so the reference is the candle before it (74,520).
    await expect(page.getByTestId('price-change')).toContainText('-3,286원 (-4.41%)');
    await expect(page.getByTestId('price-basis')).toContainText(
      '전일 종가 74,520원(2026-10-19 일봉 수정주가 종가) 대비',
    );
    await expect(page.getByTestId('price-basis')).toContainText('KST');
    await expect(page.getByTestId('market-cap')).toContainText('425조 2,514억 원');
    await expect(page.getByTestId('market-cap')).toContainText('현재가 × 발행주식수');
    await expect(page.getByTestId('per')).toContainText('17.81배');
    await expect(page.getByTestId('per')).toContainText('재무 공시일 2026-08-14');
    await expect(page.getByTestId('per')).toContainText('계산 2026');
    await expect(page.getByTestId('pbr')).toContainText('1.42배');
    await expect(page.getByTestId('warnings')).toContainText('투자경고');
    // 71,234 is 1.00 % below the 71,950 upper limit: within the 2 % rule.
    await expect(page.getByTestId('limit-badge')).toContainText('상한가 근접');
    await expect(page.getByTestId('limit-badge')).toContainText('1.00%');
    expect(await fits(page)).toBe(true);
  });

  test('US stock: change against the latest session candle, no price limits', async ({ page }) => {
    await start(page, {}, 'aapl');
    await expect(page.getByRole('heading', { name: '테스트애플' })).toBeVisible();
    await expect(page.getByTestId('last-price')).toHaveText('$236.00');
    await expect(page.getByTestId('price-change')).toContainText('+$1.24 (+0.53%)');
    await expect(page.getByTestId('price-basis')).toContainText(
      '전일 종가 $234.76(2026-10-19 일봉 수정주가 종가)',
    );
    await expect(page.getByTestId('market-cap')).toContainText('$3.54T');
    await expect(page.getByTestId('limit-badge')).toHaveCount(0);
    await expect(page.getByText('이 종목은 가격 제한이 없어 판단하지 않습니다')).toBeVisible();
    await expect(page.getByTestId('per')).toContainText('59.00배');
  });

  test('search validates the code and reports an unknown symbol', async ({ page }) => {
    await start(page);
    await search(page, 'bad code!');
    await expect(page.getByRole('alert')).toContainText('종목 코드는 영문·숫자');
    await search(page, 'ZZZZ');
    await expect(page.getByRole('heading', { name: '종목을 찾지 못했습니다' })).toBeVisible();
    await expect(page.locator('.analysis-chart-main')).toHaveCount(0);
  });
});

test.describe('indicators', () => {
  test('every indicator has an accessible ⓘ tooltip that opens on focus', async ({ page }) => {
    await start(page);
    await expect(page.locator('.analysis-chart-main svg').first()).toBeVisible();
    const tips = page.getByRole('button', { name: / 설명$/ });
    await expect(tips).toHaveCount(15);
    const ichimoku = page.getByRole('button', { name: '일목균형표 설명' });
    const id = await ichimoku.getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    const bubble = page.locator(`[id="${id}"]`);
    await expect(bubble).toBeHidden();
    await ichimoku.focus();
    await expect(bubble).toBeVisible();
    await expect(bubble).toContainText('구름대');
    await expect(bubble).toHaveAttribute('role', 'tooltip');
    await page.keyboard.press('Escape');
    await expect(bubble).toBeHidden();
    // Hover works too.
    await ichimoku.hover();
    await expect(bubble).toBeVisible();
    const box = await bubble.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  });

  test('keyboard: tab reaches the toggle, then its ⓘ, and the toggle changes the chart', async ({
    page,
  }) => {
    await start(page);
    const ema = toggle(page, 'ema');
    await ema.focus();
    await page.keyboard.press('Enter');
    await expect(ema).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '지수 이동평균(EMA) 설명' })).toBeFocused();
    await expect(page.getByText('EMA 20', { exact: true }).first()).toBeVisible();
  });

  test('Ichimoku draws the future cloud and separate panes appear', async ({ page }) => {
    await start(page);
    await toggle(page, 'ichimoku').click();
    await toggle(page, 'stochastic').click();
    await toggle(page, 'atr').click();
    await expect(page.locator('.analysis-chart-main .recharts-area-area').first()).toBeVisible();
    // The last tick is the 26th future position, not a date.
    await expect(page.locator('.analysis-chart-main').getByText('+26봉')).toBeVisible();
    await expect(page.getByText(/선행스팬\(구름대\)은 26봉 앞으로/)).toBeVisible();
    for (const name of ['RSI', '스토캐스틱', '평균 진폭'])
      await expect(
        page.getByRole('region', { name: new RegExp(`^${name}.* 패널$`) }),
      ).toBeVisible();
    expect(await fits(page)).toBe(true);
  });

  test('a long period pages older candles with before and caps the pages', async ({ page }) => {
    const api = await start(page);
    await expect(page.locator('.analysis-chart-main svg').first()).toBeVisible();
    // Older pages only: `before` is the previous page's nextBefore (the dev server runs effects
    // twice, so the first page is not counted).
    const older = () =>
      api.requests.filter((r) => r.includes('/api/market/candles') && r.includes('before=')).length;
    expect(older()).toBe(0);
    await page.getByRole('button', { name: '1년', exact: true }).click();
    await expect.poll(older).toBe(1);
    expect(api.requests.some((r) => r.includes('before=2'))).toBe(true);
    await page.getByRole('button', { name: '3년', exact: true }).click();
    await expect(page.getByText(/제공된 일봉은 600개/)).toBeVisible();
    // The fixture has 600 daily candles (3 pages); the cap is 5 pages.
    await expect.poll(older).toBe(2);
    expect(await fits(page)).toBe(true);
  });
});

test.describe('analysis tabs', () => {
  test('value tab: statements with sources, per-share metrics and the sector comparison', async ({
    page,
  }) => {
    await start(page);
    const statements = page.getByTestId('statements');
    await expect(statements).toContainText('2025 연간');
    await expect(statements).toContainText('30,000');
    await expect(statements.getByRole('link', { name: 'DART' }).first()).toHaveAttribute(
      'href',
      /^https:\/\/dart\.example\.test\//,
    );
    await expect(page.getByTestId('eps')).toContainText('4,000원');
    await expect(page.getByTestId('roe')).toContainText('9.12%');
    await page.getByRole('button', { name: '분기', exact: true }).click();
    await expect(statements).toContainText('2025 4분기 *');
    await page.getByRole('button', { name: '업종 비교 계산' }).click();
    const result = page.getByTestId('sector-result');
    await expect(result).toBeVisible();
    await expect(result).toContainText('테스트 기술 › 테스트 반도체');
    const table = page.getByTestId('sector-table');
    // PER peers: 10, 20, 50, 60 (one with negative EPS, one without filings are excluded).
    await expect(table.getByRole('row', { name: /PER/ })).toContainText('35.00배');
    await expect(table.getByRole('row', { name: /PER/ })).toContainText('4 / 6');
    await expect(table.getByRole('row', { name: /PER/ })).toContainText('적자');
    await expect(table.getByRole('row', { name: /PER/ })).toContainText('재무 조회 실패 1');
    await expect(table.getByRole('row', { name: /PBR/ })).toContainText('5 / 6');
    await expect(page.getByText(/시가총액 상위 6개를 비교군으로 사용/)).toBeVisible();
    expect(await fits(page)).toBe(true);
  });

  test('value tab for a US stock uses SEC EDGAR and million-dollar units', async ({ page }) => {
    await start(page, {}, 'AAPL');
    await expect(page.getByTestId('statements')).toContainText('SEC EDGAR');
    await expect(page.getByText('단위: 백만 달러')).toBeVisible();
    await expect(page.getByTestId('statements')).toContainText('30');
  });

  test('flow tab (KR): investor trends, short selling, credit and program trades', async ({
    page,
  }) => {
    await start(page);
    await tab(page, '수급').click();
    const investor = page.getByTestId('flow-investor');
    await expect(investor).toContainText('+400,000');
    await expect(investor).toContainText('-300,000');
    // Today's individual and other-corporation values have no provisional figure: a dash.
    await expect(investor.locator('tbody tr').first()).toContainText('–');
    await expect(page.getByText(/KRX·NXT 통합/)).toBeVisible();
    await page.getByRole('button', { name: '공매도', exact: true }).click();
    await expect(page.getByTestId('flow-short')).toContainText('3.22%');
    await page.getByRole('button', { name: '신용거래', exact: true }).click();
    await expect(page.getByTestId('flow-credit')).toContainText('500,000');
    await page.getByRole('button', { name: '프로그램매매', exact: true }).click();
    await expect(page.getByTestId('flow-program')).toContainText('+600');
    expect(await fits(page)).toBe(true);
  });

  test('flow tab (US): says Toss does not provide it and requests nothing', async ({ page }) => {
    const api = await start(page, {}, 'AAPL');
    await tab(page, '수급').click();
    await expect(
      page.getByText('미국 종목은 토스가 제공하지 않습니다', { exact: false }),
    ).toBeVisible();
    expect(
      api.requests.some((r) =>
        /investor-trading|short-selling|credit-trades|program-trades/.test(r),
      ),
    ).toBe(false);
  });

  test('quote tab: snapshot refreshes only when the button is pressed', async ({ page }) => {
    const api = await start(page);
    await tab(page, '호가·체결').click();
    await expect(page.getByTestId('orderbook')).toContainText('71,300원');
    await expect(page.getByTestId('trades')).toContainText('71,250원');
    const count = () => api.requests.filter((r) => /orderbook|\/trades/.test(r)).length;
    const loaded = count();
    expect(loaded).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(1500);
    expect(count()).toBe(loaded); // no polling
    await page.getByRole('button', { name: '새로 고침' }).click();
    await expect.poll(count).toBe(loaded + 2);
    expect(await fits(page)).toBe(true);
  });

  test('tabs follow the keyboard pattern (arrows move and select)', async ({ page }) => {
    await start(page);
    await tab(page, '가치·재무').focus();
    await page.keyboard.press('ArrowRight');
    await expect(tab(page, '수급')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, '수급')).toBeFocused();
    await page.keyboard.press('End');
    await expect(tab(page, '호가·체결')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      'analysis-tab-quote',
    );
  });
});

test.describe('states', () => {
  test('owner-only account sees one notice and no data', async ({ page }) => {
    await start(page, { user: memberUser, market: 'owner-only' });
    await expect(page.locator('.analysis [data-state="owner-only"]')).toHaveCount(1);
    await expect(page.locator('.analysis-chart-main')).toHaveCount(0);
    await expect(page.getByTestId('last-price')).toHaveCount(0);
  });

  test('Toss not connected is stated once, never replaced by example values', async ({ page }) => {
    await start(page, { market: 'not-connected' });
    await expect(page.locator('.analysis [data-state="not-connected"]')).toHaveCount(1);
    await expect(page.locator('.analysis')).toContainText('토스 계좌가 연결되지 않았습니다');
  });

  test('403 on Stock Info shows 토스 권한 없음 for that part and keeps the rest', async ({
    page,
  }) => {
    await mockApi(page, { user: ownerUser });
    await page.route('**/api/analysis/warnings**', (route) =>
      route.fulfill({ status: 403, json: forbidden }),
    );
    await page.route('**/api/analysis/stocks**', (route) =>
      route.fulfill({ status: 403, json: forbidden }),
    );
    await page.route('**/api/analysis/investor-trading**', (route) =>
      route.fulfill({ status: 403, json: forbidden }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: '종목 분석', exact: true }).click();
    await expect(page.getByTestId('warnings').locator('[data-state="permission"]')).toContainText(
      '토스 권한 없음',
    );
    await expect(page.locator('.analysis [data-state="permission"]').first()).toBeVisible();
    // Price, chart and market (from currency) still work; market cap is not invented.
    await expect(page.getByTestId('last-price')).toHaveText('71,234원');
    await expect(page.locator('.analysis-chart-main svg').first()).toBeVisible();
    await expect(page.getByTestId('market-cap')).toContainText('—');
    await tab(page, '수급').click();
    await expect(
      page.getByRole('heading', { name: /투자자별 매매동향 · 토스 권한 없음/ }),
    ).toBeVisible();
    // 403 is not offered a retry.
    await expect(page.locator('[data-state="permission"]').getByRole('button')).toHaveCount(0);
  });

  test('DART not configured is distinct from a Toss problem', async ({ page }) => {
    await mockApi(page, { user: ownerUser });
    await page.route('**/api/fundamentals**', (route) =>
      route.fulfill({
        status: 503,
        json: error('DART_UNAVAILABLE', '국내 재무 데이터(DART)가 설정되지 않았습니다.'),
      }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: '종목 분석', exact: true }).click();
    await expect(page.getByTestId('per')).toContainText('DART');
    await expect(
      page.getByRole('heading', { name: /데이터 제공자가 연결되지 않았습니다/ }),
    ).toBeVisible();
    await expect(page.getByTestId('last-price')).toHaveText('71,234원');
  });

  test('empty order book, transient trade error and retry', async ({ page }) => {
    await mockApi(page, { user: ownerUser });
    await page.route('**/api/analysis/orderbook**', (route) =>
      route.fulfill({
        status: 404,
        json: error('PROVIDER_NOT_FOUND', '제공자에 해당 종목 데이터가 없습니다.'),
      }),
    );
    let failing = true;
    await page.route('**/api/analysis/trades**', (route) =>
      failing
        ? route.fulfill({
            status: 503,
            json: error('PROVIDER_UNAVAILABLE', '제공자 상태를 확인하세요.'),
          })
        : route.fallback(),
    );
    await page.goto('/');
    await page.getByRole('button', { name: '종목 분석', exact: true }).click();
    await tab(page, '호가·체결').click();
    await expect(page.locator('[data-state="no-data"]').filter({ hasText: '호가' })).toBeVisible();
    const alert = page.getByRole('alert').filter({ hasText: '체결' });
    await expect(alert).toContainText('일시적인 오류');
    failing = false;
    await alert.getByRole('button', { name: '다시 시도' }).click();
    await expect(page.getByTestId('trades')).toContainText('71,250원');
  });
});

test.describe('rendered layout', () => {
  test('captures the whole tab and checks overflow and chart width', async ({ page }, testInfo) => {
    await start(page);
    await toggle(page, 'ichimoku').click();
    await toggle(page, 'stochastic').click();
    await expect(page.locator('.analysis-chart-main svg').first()).toBeVisible();
    await page.getByRole('button', { name: '업종 비교 계산' }).click();
    await expect(page.getByTestId('sector-result')).toBeVisible();
    expect(await fits(page)).toBe(true);
    const chart = await page.locator('.analysis-chart-main').boundingBox();
    expect(chart!.width).toBeGreaterThan(testInfo.project.name === 'mobile' ? 280 : 700);
    await page.screenshot({
      path: testInfo.outputPath(`${testInfo.project.name}-analysis-value.png`),
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: /^일목균형표 설명/ }).focus();
    await page.screenshot({
      path: testInfo.outputPath(`${testInfo.project.name}-analysis-tooltip.png`),
      animations: 'disabled',
    });
    await tab(page, '수급').click();
    await expect(page.getByTestId('flow-investor')).toBeVisible();
    expect(await fits(page)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`${testInfo.project.name}-analysis-flow.png`),
      fullPage: true,
      animations: 'disabled',
    });
    await tab(page, '호가·체결').click();
    await expect(page.getByTestId('orderbook')).toBeVisible();
    expect(await fits(page)).toBe(true);
  });
});
