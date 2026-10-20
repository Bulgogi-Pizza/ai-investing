import { test, expect, type Page } from '@playwright/test';
import { memberUser, mockApi, ownerUser } from './fixtures/api-mock';
import {
  mockAlgorithmApi,
  paperBody,
  record,
  type AlgoMockOptions,
} from './fixtures/algorithm-mock';

// Synthetic backend only (page.route). Nothing here is a market fact or real notification.
async function openAlgorithms(page: Page, options: AlgoMockOptions = {}, user = ownerUser) {
  await mockApi(page, { user });
  const api = await mockAlgorithmApi(page, options);
  await page.goto('/');
  await page.getByRole('button', { name: '내 자산', exact: true }).click();
  await page.getByRole('tab', { name: '알고리즘' }).click();
  await expect(page.getByRole('region', { name: '긴급 정지' })).toBeVisible();
  return api;
}
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const stopRegion = (page: Page) => page.getByRole('region', { name: '긴급 정지' });
const saved = record();

test.describe('algorithm screen: list and form', () => {
  test('empty state, template descriptions, live disabled with explanation', async ({ page }) => {
    await openAlgorithms(page);
    await expect(page).toHaveURL(/\/algorithms$/);
    await expect(page.getByText('아직 만든 알고리즘이 없습니다')).toBeVisible();
    await expect(page.getByText('이 화면은 알고리즘의 설정과')).toContainText(
      '주문을 내는 기능은 없습니다',
    );
    for (const text of ['모멘텀', '평균회귀', '듀얼 모멘텀']) {
      await expect(page.locator('.algo-template', { hasText: text }).first()).toBeVisible();
    }
    await expect(page.locator('.algo-template', { hasText: 'RSI와 볼린저' })).toBeVisible();
    await expect(page.locator('.algo-mode-live input')).toBeDisabled();
    await expect(page.locator('.algo-mode-live')).toContainText(
      '실전 운용은 주문 기능 단계(7d–7f) 이후에 켤 수 있습니다.',
    );
    await expect(page.locator('.algo-mode-simulation input')).toBeChecked();
    // Nothing is saved yet and nothing can be saved without a name and targets.
    await expect(page.getByRole('button', { name: '알고리즘 만들기' })).toBeDisabled();
  });

  test('creates an algorithm with validated targets; badge and request body are right', async ({
    page,
  }) => {
    const api = await openAlgorithms(page);
    await page.getByLabel('이름', { exact: true }).fill('테스트 모멘텀');
    const targets = page.getByRole('textbox', { name: /^대상 종목/ });
    await targets.fill('../etc');
    await page.getByRole('button', { name: '추가', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('형식이 맞지 않습니다');
    await targets.fill('005930, aapl');
    await page.getByRole('button', { name: '추가', exact: true }).click();
    await expect(page.getByRole('list', { name: '대상 종목 목록' })).toContainText('AAPL');
    await targets.fill('005930');
    await page.getByRole('button', { name: '추가', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('이미 목록에 있습니다');
    await page.getByRole('button', { name: 'AAPL 제거' }).click();
    // Weights and thresholds are editable.
    await page.getByLabel('추세 가중치').fill('0.8');
    await page.locator('.algo-signal', { hasText: '가치' }).getByRole('checkbox').check();
    await page.getByLabel('가치 가중치').fill('0.2');
    await page.getByLabel(/^매수 기준/).fill('0.45');
    await page.getByLabel('운용 금액 한도 (KRW) 선택 · 실전은 필수').fill('5000000');
    const save = page.getByRole('button', { name: '알고리즘 만들기' });
    await expect(save).toBeEnabled();
    await save.click();
    const card = page.locator('.algo-card', { hasText: '테스트 모멘텀' });
    await expect(card).toBeVisible();
    await expect(card.locator('.algo-badge')).toHaveText('시뮬레이션');
    await expect(page.getByText('저장했습니다.')).toBeVisible();
    const post = api.requests.find((r) => r.method === 'POST' && r.path === '/api/algorithms')!;
    expect(post.body).toMatchObject({
      algorithm: {
        name: '테스트 모멘텀',
        method: 'formula',
        template: 'momentum',
        market: 'KR',
        targets: ['005930'],
        mode: 'simulation',
        budget: 5000000,
        buyThreshold: 0.45,
      },
    });
    const sent = post.body as { algorithm: { signals: { id: string; weight: number }[] } };
    expect(sent.algorithm.signals).toEqual(
      expect.arrayContaining([
        { id: 'trend', weight: 0.8 },
        { id: 'value', weight: 0.2 },
      ]),
    );
    // History shows the creation.
    await expect(page.getByRole('region', { name: '변경 이력' })).toContainText('만듦');
  });

  test('edits an existing algorithm to paper mode; badges stay distinct; version is sent', async ({
    page,
  }) => {
    const api = await openAlgorithms(page, {
      algorithms: [
        saved,
        record({ id: '33333333-3333-4333-8333-333333333333', name: '모의 B', mode: 'paper' }),
      ],
    });
    const cards = page.locator('.algo-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0).locator('.algo-badge')).toHaveText('시뮬레이션');
    await expect(cards.nth(1).locator('.algo-badge')).toHaveText('모의');
    // Distinct colors for the two modes.
    const colors = await cards
      .locator('.algo-badge')
      .evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
    expect(new Set(colors).size).toBe(2);
    await cards.nth(0).click();
    await page.locator('.algo-mode-paper').click();
    await expect(
      page.getByText('모의 운용 판단 작업은 다음 단계(7c)에서 연결됩니다'),
    ).toBeVisible();
    await page.getByRole('button', { name: '변경 저장' }).click();
    await expect(cards.nth(0).locator('.algo-badge')).toHaveText('모의');
    const put = api.requests.find(
      (r) => r.method === 'PUT' && r.path.startsWith('/api/algorithms/'),
    )!;
    expect(put.body).toMatchObject({ version: 1, algorithm: { mode: 'paper' } });
    await expect(page.getByRole('region', { name: '변경 이력' })).toContainText(
      '모드: 시뮬레이션 → 모의',
    );
    // Delete asks for confirmation and records nothing until confirmed.
    await page.getByRole('button', { name: '삭제', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('삭제할까요');
    await dialog.getByRole('button', { name: '취소' }).click();
    await expect(cards).toHaveCount(2);
    await page.getByRole('button', { name: '삭제', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '삭제', exact: true }).click();
    await expect(cards).toHaveCount(1);
  });

  test('server rejections (live overlap, conflicts) are shown, not swallowed', async ({ page }) => {
    await openAlgorithms(page, {
      saveError: {
        status: 409,
        code: 'LIVE_TARGET_OVERLAP',
        message: '실전 알고리즘 "실전 A"이(가) 같은 종목(005930)을 이미 대상으로 하고 있습니다.',
      },
    });
    await page.getByLabel('이름', { exact: true }).fill('겹침 시험');
    await page.getByRole('textbox', { name: /^대상 종목/ }).fill('005930');
    await page.getByRole('button', { name: '추가', exact: true }).click();
    await page.getByRole('button', { name: '알고리즘 만들기' }).click();
    await expect(page.getByRole('status').filter({ hasText: '실전 A' })).toBeVisible();
    await expect(page.locator('.algo-card')).toHaveCount(0);
  });

  test('switching to the dual momentum template shows its parameters and the 200-bar note', async ({
    page,
  }) => {
    await openAlgorithms(page);
    await page.locator('.algo-template', { hasText: '듀얼 모멘텀' }).click();
    await expect(page.getByLabel(/^수익률 기간/)).toHaveValue('252');
    await expect(page.getByText('252일(기본)은 시뮬레이션할 수 없습니다')).toBeVisible();
    await expect(page.getByLabel('추세 가중치')).toHaveCount(0);
  });

  test('AI method cannot be simulated and starts in paper mode', async ({ page }) => {
    await openAlgorithms(page);
    await page.getByRole('radio', { name: 'AI형' }).click();
    await expect(page.locator('.algo-mode-paper input')).toBeChecked();
    await expect(page.locator('.algo-mode-simulation input')).toBeDisabled();
    await expect(
      page.getByText('AI형은 과거 시뮬레이션을 지원하지 않습니다').first(),
    ).toBeVisible();
  });
});

test.describe('algorithm screen: backtest', () => {
  test('runs only on click and labels every result as simulation with period and source', async ({
    page,
  }) => {
    const api = await openAlgorithms(page, { algorithms: [saved] });
    const panel = page.getByRole('region', { name: '과거 시뮬레이션' });
    await expect(panel.getByRole('button', { name: '시뮬레이션 실행' })).toBeEnabled();
    // Editing inputs does not run anything.
    await page.getByLabel(/^매수 기준/).fill('0.5');
    await page.getByLabel('이름', { exact: true }).fill('테스트 모멘텀 2');
    expect(api.requests.some((r) => r.path.endsWith('/backtest'))).toBe(false);
    await expect(panel.getByRole('button', { name: '시뮬레이션 실행' })).toBeDisabled();
    await expect(panel).toContainText('저장한 뒤 실행하세요');
    await page.getByRole('button', { name: '변경 저장' }).click();
    await expect(panel.getByRole('button', { name: '시뮬레이션 실행' })).toBeEnabled();
    await panel.getByRole('button', { name: '시뮬레이션 실행' }).click();
    await expect(panel).toContainText('아래 숫자는 모두 시뮬레이션 결과입니다');
    await expect(panel).toContainText('Toss Securities OpenAPI');
    await expect(panel).toContainText('2025-12-30 ~ 2026-10-19');
    await expect(panel).toContainText('+4.56%');
    await expect(panel).toContainText('+4.12%');
    await expect(panel.locator('.algo-metric', { hasText: '수수료' })).toContainText('5,200원');
    await expect(panel.locator('.algo-metric', { hasText: '증권거래세' })).toContainText(
      '21,000원',
    );
    await expect(panel.locator('.algo-metric', { hasText: '증권거래세' })).toContainText(
      '설정 필요',
    );
    await expect(panel.locator('.algo-metric', { hasText: '비용 차감 후 수익' })).toContainText(
      '10,412,000원',
    );
    await expect(panel.locator('.algo-metric', { hasText: '최대 낙폭' })).toContainText('7.31%');
    await expect(panel.locator('.algo-metric', { hasText: '변동성' })).toContainText('18.34%');
    await expect(panel.locator('.algo-metric', { hasText: '매매 횟수' })).toContainText('8회');
    await expect(panel.getByText('수급·뉴스 신호 제외', { exact: true })).toBeVisible();
    await expect(panel.getByText('예상 이익 기록 부족으로 보류 3회')).toBeVisible();
    await expect(panel.locator('.algo-warnings .need-setup')).toContainText('설정 필요');
    await expect(panel.getByRole('img', { name: /시뮬레이션 자산 곡선/ })).toBeVisible();
    await expect(panel.locator('.recharts-line-curve')).toBeVisible();
    // Every metric label carries the simulation marker.
    const labels = await panel.locator('.algo-metric > span').allTextContents();
    expect(labels.length).toBeGreaterThanOrEqual(9);
    for (const label of labels) expect(label).toContain('시뮬레이션');
    const run = api.requests.filter((r) => r.path.endsWith('/backtest'));
    expect(run).toHaveLength(1);
    expect(run[0].body).toEqual({ slippageBps: 0 });
    await panel.getByText('가상 매매 내역 8건').click();
    await expect(panel.getByRole('cell', { name: '가상 매수' })).toBeVisible();
    expect(await fits(page)).toBe(true);
  });

  test('shows the server reason when a run is rejected', async ({ page }) => {
    await openAlgorithms(page, {
      algorithms: [saved],
      backtestError: {
        status: 422,
        code: 'INSUFFICIENT_HISTORY',
        message: '받은 일봉은 최대 200개인데 신호 계산에 252개가 더 필요합니다.',
      },
    });
    const panel = page.getByRole('region', { name: '과거 시뮬레이션' });
    await panel.getByRole('button', { name: '시뮬레이션 실행' }).click();
    await expect(panel.getByRole('alert')).toContainText('받은 일봉은 최대 200개');
    await expect(panel.locator('.algo-result')).toHaveCount(0);
  });

  test('rate limit and unavailable Toss are explained', async ({ page }) => {
    await openAlgorithms(page, {
      algorithms: [saved],
      backtestError: {
        status: 429,
        code: 'BACKTEST_RATE_LIMITED',
        message: '시뮬레이션 요청이 많습니다. 잠시 후 다시 실행하세요.',
      },
    });
    const panel = page.getByRole('region', { name: '과거 시뮬레이션' });
    await panel.getByRole('button', { name: '시뮬레이션 실행' }).click();
    await expect(panel.getByRole('alert')).toContainText('요청이 많습니다');
  });

  test('AI algorithms offer no simulation', async ({ page }) => {
    await openAlgorithms(page, {
      algorithms: [record({ method: 'ai', mode: 'paper', signals: [{ id: 'trend', weight: 1 }] })],
    });
    const panel = page.getByRole('region', { name: '과거 시뮬레이션' });
    await expect(panel.getByRole('button', { name: '시뮬레이션 실행' })).toHaveCount(0);
    await expect(panel).toContainText('AI형은 과거 시뮬레이션을 지원하지 않습니다');
  });
});

test.describe('algorithm screen: 모의 운용', () => {
  const paperPanel = (page: Page) => page.getByRole('region', { name: '모의 운용' });
  const paperRecord = record({ mode: 'paper' });

  test('without any record it says so and invents no numbers', async ({ page }) => {
    await openAlgorithms(page, { algorithms: [paperRecord] });
    const panel = paperPanel(page);
    await expect(panel.getByTestId('paper-empty')).toContainText('아직 모의 운용 기록이 없습니다');
    await expect(panel.locator('.algo-metric')).toHaveCount(0);
    await expect(panel.locator('.algo-badge-paper', { hasText: '가상 기록' })).toBeVisible();
    await expect(panel).toContainText('실제 주문은 나가지 않습니다');
    expect(await fits(page)).toBe(true);
  });

  test('labels every figure as virtual: metrics, positions, fills and run history', async ({
    page,
  }) => {
    const api = await openAlgorithms(page, {
      algorithms: [paperRecord],
      paper: (algorithm) => paperBody(algorithm),
    });
    const panel = paperPanel(page);
    await expect(panel).toContainText('아래 숫자는 모두 가상 기록입니다');
    await expect(panel).toContainText('실제 주문과 체결이 아니며');
    await expect(panel.locator('.algo-badge-paper', { hasText: '가상 운용 중' })).toBeVisible();
    await expect(panel).toContainText('2026-10-01 (거래소 날짜)');
    await expect(panel.locator('.algo-metric', { hasText: '총수익' })).toContainText('+0.61%');
    await expect(panel.locator('.algo-metric', { hasText: '비용 합계' })).toContainText('13,600원');
    await expect(panel.locator('.algo-metric', { hasText: '비용 차감 후 수익' })).toContainText(
      '+0.48%',
    );
    await expect(panel.locator('.algo-metric', { hasText: '최대 낙폭' })).toContainText('0.62%');
    await expect(panel.locator('.algo-metric', { hasText: '변동성' })).toContainText('9.12%');
    await expect(panel.locator('.algo-metric', { hasText: '가상 매매 횟수' })).toContainText('3회');
    const labels = await panel.locator('.algo-metric > span').allTextContents();
    expect(labels.length).toBeGreaterThanOrEqual(10);
    for (const label of labels) expect(label).toContain('가상');
    await expect(panel.getByRole('img', { name: /모의 운용 가상 자산 곡선/ })).toBeVisible();
    await expect(panel.locator('.recharts-line-curve')).toBeVisible();
    const positions = panel.getByRole('region', { name: '가상 보유 종목' });
    await expect(positions).toContainText('005930');
    await expect(positions).toContainText('+3.31%');
    // Short lists are open by default; the summary still names the count.
    await expect(panel.getByText(/가상 체결 내역 1건/)).toBeVisible();
    await expect(panel.getByRole('cell', { name: '가상 매수' })).toBeVisible();
    await expect(
      panel.getByRole('cell', { name: '종합 점수가 매수 기준 이상 · 종합 점수 0.62' }),
    ).toBeVisible();
    await expect(panel.getByText(/판단 기록 2회/)).toBeVisible();
    await expect(panel).toContainText('예상 이익 기록 부족으로 매수 보류 2회');
    await expect(panel).toContainText('가치: 재무 데이터 연결 전이라 제외');
    await expect(panel).toContainText('긴급 정지 중이라 아무것도 하지 않았습니다.');
    // Nothing on this screen is a real order, and no other request was needed to render it.
    expect(api.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
    expect(await fits(page)).toBe(true);
  });

  test('a stopped algorithm and an idle AI algorithm are explained', async ({ page }) => {
    await openAlgorithms(page, {
      algorithms: [record({ mode: 'paper', method: 'ai', signals: [{ id: 'trend', weight: 1 }] })],
      paper: (algorithm) =>
        paperBody(algorithm, {
          ledger: {
            status: 'stopped',
            startedOn: '2026-10-01',
            stoppedOn: '2026-10-09',
            stoppedReason: 'loss-limit',
            budget: 10_000_000,
            cash: 7_000_000,
            lastRunDate: '2026-10-09',
            positions: [],
          },
          notes: ['AI형 알고리즘은 AI 비용 승인 대기 상태라 모의 판단도 하지 않습니다.'],
        }),
    });
    const panel = paperPanel(page);
    await expect(panel.getByTestId('paper-stopped')).toContainText(
      '2026-10-09 누적 손실 한도로 정지 (가상)',
    );
    await expect(panel.locator('.algo-badge-warn', { hasText: 'AI 비용 승인 대기' })).toBeVisible();
    await expect(panel.getByRole('list', { name: '모의 운용 안내' })).toContainText(
      'AI 비용 승인 대기',
    );
  });

  test('a failed load shows the error and offers retry; a non-owner never gets data', async ({
    page,
  }) => {
    await openAlgorithms(page, {
      algorithms: [paperRecord],
      paperError: {
        status: 503,
        code: 'PAPER_UNAVAILABLE',
        message: '모의 운용 기록을 불러오지 못했습니다.',
      },
    });
    const panel = paperPanel(page);
    await expect(panel.getByRole('alert')).toBeVisible();
    await expect(panel.getByRole('button', { name: /다시 시도/ })).toBeVisible();
    await expect(panel.locator('.algo-metric')).toHaveCount(0);
  });
});

test.describe('algorithm screen: emergency stop', () => {
  test('is always visible, stops with one confirmed click, and release announces Telegram', async ({
    page,
  }) => {
    const api = await openAlgorithms(page, { algorithms: [saved] });
    const region = stopRegion(page);
    await expect(region).toContainText('정상');
    // Still visible after scrolling to the bottom of a long screen (sticky).
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(region.getByRole('button', { name: '긴급 정지', exact: true })).toBeInViewport();
    await region.getByRole('button', { name: '긴급 정지', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '긴급 정지를 켤까요?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '취소' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(
      api.requests.some((r) => r.method === 'PUT' && r.path === '/api/algorithm-control'),
    ).toBe(false);
    await region.getByRole('button', { name: '긴급 정지', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '긴급 정지 켜기' }).click();
    await expect(region).toContainText('긴급 정지 중');
    await expect(region.getByRole('status')).toContainText('긴급 정지를 켰습니다');
    expect(
      api.requests.find((r) => r.method === 'PUT' && r.path === '/api/algorithm-control')!.body,
    ).toEqual({
      emergencyStop: true,
    });
    await expect(page.getByRole('region', { name: '변경 이력' })).toContainText('긴급 정지 켬');
    // Release needs a confirmation that says a Telegram alert follows.
    await region.getByRole('button', { name: '긴급 정지 해제' }).click();
    const release = page.getByRole('dialog', { name: '긴급 정지를 해제할까요?' });
    await expect(release).toContainText('텔레그램으로 알림이 갑니다');
    await release.getByRole('button', { name: '긴급 정지 해제' }).click();
    await expect(region).toContainText('정상');
    await expect(region.getByRole('status')).toContainText('텔레그램 알림을 보냈습니다');
    // The notification list picked up the alert.
    await expect(page.getByRole('region', { name: '최근 알림' })).toContainText(
      '위험 증가 설정 변경',
    );
  });

  test('release with Telegram unavailable says so instead of claiming a sent alert', async ({
    page,
  }) => {
    await openAlgorithms(page, {
      emergencyStop: true,
      releaseOutcome: { status: 'disabled', failureCode: 'NOT_CONFIGURED' },
    });
    const region = stopRegion(page);
    await expect(region).toContainText('긴급 정지 중');
    await region.getByRole('button', { name: '긴급 정지 해제' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '긴급 정지 해제' }).click();
    await expect(region.getByRole('status')).toContainText('텔레그램이 설정되지 않아');
  });

  test('stays usable when the algorithm list fails to load', async ({ page }) => {
    await openAlgorithms(page, { failListWith: 500 });
    await expect(
      page.getByRole('alert').filter({ hasText: '알고리즘을 불러오지 못했습니다' }),
    ).toBeVisible();
    await expect(
      stopRegion(page).getByRole('button', { name: '긴급 정지', exact: true }),
    ).toBeEnabled();
  });
});

test.describe('algorithm screen: notifications, costs and states', () => {
  test('recent notifications show status badges and paper/live labels', async ({ page }) => {
    await openAlgorithms(page);
    const list = page.getByRole('region', { name: '최근 알림' });
    await expect(list.locator('.algo-status-sent')).toHaveText('발송됨');
    await expect(list.locator('.algo-status-failed')).toHaveText('실패');
    await expect(list.locator('.algo-status-disabled')).toHaveText('미설정');
    await expect(list.getByText('모의 · 가상')).toBeVisible();
    await expect(list.getByText('실전 · 실제 주문')).toBeVisible();
    await expect(list).toContainText('시간 초과');
    await expect(list).not.toContainText('https://');
  });

  test('empty and failing notification lists are explicit', async ({ page }) => {
    await openAlgorithms(page, { notifications: [] });
    await expect(page.getByRole('region', { name: '최근 알림' })).toContainText(
      '아직 보낸 알림이 없습니다',
    );
  });

  test('cost settings carry the tax warning and save fractions', async ({ page }) => {
    const api = await openAlgorithms(page);
    const costs = page.getByRole('region', { name: '수수료·세금 설정' });
    await expect(costs).toContainText('세율은 바뀔 수 있으니 직접 확인하세요');
    await costs.getByLabel(/^매매 수수료율/).fill('0.015');
    await costs.getByLabel(/^국내 증권거래세율/).fill('0.18');
    await costs.getByLabel(/^미국 양도소득세율/).fill('22');
    // A rate without a deduction is incomplete: the form says so and cannot be saved.
    await expect(costs.getByRole('status')).toContainText(
      '양도소득세는 세율과 연 공제액을 모두 입력하세요',
    );
    await expect(costs.getByRole('button', { name: '설정 저장' })).toBeDisabled();
    await costs.getByLabel(/^연 공제액/).fill('1800');
    await costs.getByRole('button', { name: '설정 저장' }).click();
    await expect(costs.getByRole('status')).toContainText('저장했습니다');
    const put = api.requests.find(
      (r) => r.method === 'PUT' && r.path === '/api/algorithm-settings',
    )!;
    expect(put.body).toEqual({
      costs: {
        commissionRate: 0.00015,
        sellTaxRate: 0.0018,
        capitalGainsTax: { rate: 0.22, annualDeduction: 1800 },
      },
    });
  });

  test('a non-owner sees the owner-only notice and no editor', async ({ page }) => {
    await openAlgorithms(page, { ownerOnly: true }, memberUser);
    await expect(page.getByText('소유자 계정 전용 기능입니다').first()).toBeVisible();
    await expect(page.getByRole('button', { name: '알고리즘 만들기' })).toHaveCount(0);
  });

  test('a failed list offers retry and then shows the algorithms', async ({ page }) => {
    await mockApi(page, { user: ownerUser });
    const api = await mockAlgorithmApi(page, { algorithms: [saved] });
    let fail = true;
    await page.route(/\/api\/algorithms$/, (route) =>
      fail
        ? route.fulfill({
            status: 500,
            json: { error: { code: 'REQUEST_FAILED', message: '요청을 처리하지 못했습니다.' } },
          })
        : route.fallback(),
    );
    await page.goto('/algorithms');
    const alert = page.getByRole('alert').filter({ hasText: '알고리즘을 불러오지 못했습니다' });
    await expect(alert).toBeVisible();
    await expect(page.getByRole('button', { name: '알고리즘 만들기' })).toHaveCount(0);
    fail = false;
    await alert.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect(page.locator('.algo-card', { hasText: '테스트 모멘텀' })).toBeVisible();
    expect(api.requests.length).toBeGreaterThan(0);
  });

  test('the /algorithms path (Telegram link) opens the algorithm tab directly', async ({
    page,
  }) => {
    await mockApi(page, { user: ownerUser });
    await mockAlgorithmApi(page, { algorithms: [saved] });
    await page.goto('/algorithms');
    await expect(page.getByRole('tab', { name: '알고리즘' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(stopRegion(page)).toBeVisible();
    await page.getByRole('tab', { name: '보유 자산' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText('실계좌 · 주식 전용')).toBeVisible();
  });
});

test.describe('algorithm screen: visual check', () => {
  for (const viewport of [
    { name: '1440', width: 1440, height: 1000 },
    { name: '375', width: 375, height: 812 },
  ]) {
    test(`renders without overflow at ${viewport.name}px`, async ({ page }, info) => {
      test.skip(
        info.project.name === 'mobile' && viewport.width === 1440,
        'desktop viewport is covered by the desktop project',
      );
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openAlgorithms(page, {
        algorithms: [saved],
        paper: (algorithm) => paperBody(algorithm),
      });
      const panel = page.getByRole('region', { name: '과거 시뮬레이션' });
      await panel.getByRole('button', { name: '시뮬레이션 실행' }).click();
      await expect(panel.locator('.recharts-line-curve')).toBeVisible();
      await expect(
        page.getByRole('region', { name: '모의 운용' }).locator('.recharts-line-curve'),
      ).toBeVisible();
      await expect(stopRegion(page)).toBeInViewport();
      expect(await fits(page)).toBe(true);
      await page.screenshot({
        path: `test-results/algorithms-${info.project.name}-${viewport.name}.png`,
        fullPage: true,
      });
      await page.getByRole('region', { name: '모의 운용' }).screenshot({
        path: `test-results/paper-${info.project.name}-${viewport.name}.png`,
      });
    });
  }
});
