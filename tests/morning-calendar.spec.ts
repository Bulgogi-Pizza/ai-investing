import { test, expect } from '@playwright/test';
import { event, mockApi, ownerUser } from './fixtures/api-mock';

// Synthetic events shaped like the morning job's output (stage 6b); none of this is market data.
const withValues = {
  ...event(11, '2026-10-20', '', '테스트 소비자물가 발표', '미국', '경제 지표', ['금리'], 3),
  sourceName: '테스트 FRED',
  values: [
    {
      indicatorId: 'us-cpi',
      label: '테스트 물가지수',
      actual: '324.368',
      previous: '323.364',
      unit: '지수',
      period: '2026-09-01',
      previousPeriod: '2026-08-01',
      source: '테스트 FRED',
      observedAt: '2026-10-21T00:00:00.000Z',
    },
  ],
  aiSummary: {
    text: '발표값은 이전보다 높게 나왔다. 금리 기대에 영향을 줄 수 있다.',
    model: 'test-model',
    generatedAt: '2026-10-21T00:05:00.000Z',
  },
};
const translated = {
  ...event(
    12,
    '2026-10-20',
    '11:00',
    '연준 이사회, 최종 규칙 승인 발표',
    '미국',
    '기관발표',
    ['금리'],
    1,
  ),
  titleOriginal: 'Federal Reserve Board announces approval of final rule',
  translation: { model: 'test-model', translatedAt: '2026-10-21T00:05:00.000Z' },
};
const plain = event(13, '2026-10-20', '09:00', '값이 아직 없는 일정', '한국', '물가', ['원화'], 2);
const brief = {
  brief: {
    date: '2026-10-21',
    text: '10월 21일 아침 브리핑. 이번 주 주요 일정: 10월 24일 테스트 일정 (발표 시각 미확인 포함).',
    generatedAt: '2026-10-21T00:01:00.000Z',
    aiUsed: true,
  },
};

async function open(
  page: import('@playwright/test').Page,
  events: unknown[],
  body: unknown = brief,
) {
  await mockApi(page, { user: ownerUser });
  await page.route('**/api/calendar/events?**', (route) =>
    route.fulfill({ json: { events, truncated: false } }),
  );
  await page.route('**/api/calendar/brief', (route) => route.fulfill({ json: body }));
  await page.goto('/');
}

test('released values, AI summary block and unknown release time are shown with their sources', async ({
  page,
}) => {
  await open(page, [withValues, translated, plain]);
  await expect(page.locator('.morning-brief')).toContainText('10월 21일 아침 브리핑');
  await expect(page.locator('.morning-brief')).toContainText('AI 요약 포함');
  const chip = page.locator('.event-chip', { hasText: '테스트 소비자물가 발표' });
  await expect(chip).toContainText('시각 미확인');
  await chip.click();
  await expect(page.locator('.detail-title')).toContainText('발표 시각 미확인');
  const values = page.getByRole('list', { name: '발표 결과' });
  await expect(values).toContainText('테스트 물가지수');
  await expect(values).toContainText('324.368');
  await expect(values).toContainText('323.364');
  await expect(values).toContainText('출처 테스트 FRED');
  await expect(values).toContainText('KST 확인');
  const ai = page.locator('.ai-summary');
  await expect(ai).toBeVisible();
  await expect(ai).toContainText('AI 요약');
  await expect(ai).toContainText('금리 기대에 영향을 줄 수 있다');
  await expect(ai).toContainText('test-model');
  await expect(ai).toContainText('KST');
});

test('the AI block and values appear only when the event has them', async ({ page }) => {
  await open(page, [plain]);
  await page.locator('.event-chip', { hasText: '값이 아직 없는 일정' }).click();
  await expect(page.locator('.detail-title')).toContainText('09:00 KST');
  await expect(page.locator('.ai-summary')).toHaveCount(0);
  await expect(page.getByRole('list', { name: '발표 결과' })).toHaveCount(0);
  await expect(page.locator('.original-title')).toHaveCount(0);
});

test('a translated title can show and hide the original', async ({ page }) => {
  await open(page, [translated]);
  await page.locator('.event-chip', { hasText: '연준 이사회' }).click();
  const original = page.locator('.original-title');
  await expect(original).toContainText('AI 번역');
  await expect(original.locator('q')).toHaveCount(0);
  await original.getByRole('button', { name: '원문 제목 보기' }).click();
  await expect(original.locator('q')).toHaveText(/Federal Reserve Board announces approval/);
  await original.getByRole('button', { name: '원문 제목 숨기기' }).click();
  await expect(original.locator('q')).toHaveCount(0);
});

test('brief states are explicit: empty and unavailable never block the calendar', async ({
  page,
}) => {
  await open(page, [plain], { brief: null });
  await expect(page.locator('.morning-brief')).toContainText('아직 저장된 브리핑이 없습니다');
  await expect(page.locator('.event-chip')).toHaveCount(1);
  await page.unroute('**/api/calendar/brief');
  await page.route('**/api/calendar/brief', (route) =>
    route.fulfill({ status: 500, json: { error: { code: 'BRIEF_UNAVAILABLE', message: 'x' } } }),
  );
  await page.reload();
  await expect(page.locator('.morning-brief')).toContainText('불러오지 못했습니다');
  await expect(page.locator('.event-chip')).toHaveCount(1);
});

test('events without a release time are listed in their own hourly row', async ({ page }) => {
  await open(page, [withValues, plain]);
  await page.getByRole('button', { name: '시간별', exact: true }).click();
  await expect(page.locator('.hour-row', { hasText: '발표 시각 미확인' })).toContainText(
    '테스트 소비자물가 발표',
  );
  await expect(page.locator('.hour-row', { hasText: '09:00' })).toContainText(
    '값이 아직 없는 일정',
  );
});
