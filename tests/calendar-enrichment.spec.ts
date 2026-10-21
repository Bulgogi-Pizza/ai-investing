import { test, expect } from '@playwright/test';
import { event, mockApi, ownerUser } from './fixtures/api-mock';

// Synthetic events shaped like the calendar enrichment's output; none of this is market data.
const reaction = [
  {
    asset: 'KOSPI',
    from: { date: '2026-10-19', value: 2500.5 },
    to: { date: '2026-10-20', value: 2511 },
    change: 0.42,
    unit: '%',
    source: '테스트 지표(일봉 종가)',
  },
  {
    asset: 'KR_BOND_3Y',
    from: { date: '2026-10-19', value: 3.0 },
    to: { date: '2026-10-20', value: 2.985 },
    change: -0.015,
    unit: '%p',
    source: '테스트 지표(일봉 종가)',
  },
  {
    asset: 'USDKRW',
    from: { date: '2026-10-19', value: 1400 },
    to: { date: '2026-10-20', value: 1403.2 },
    change: 3.2,
    unit: '원',
    changePercent: 0.23,
    source: '테스트 환율(매매기준율)',
  },
  {
    asset: 'SPY',
    from: { date: '2026-10-19', value: 500 },
    to: { date: '2026-10-20', value: 500 },
    change: 0,
    unit: '%',
    source: 'SPY ETF 기준 · 테스트',
  },
];
const enriched = {
  ...event(
    21,
    '2026-10-20',
    '10:00',
    '한국은행 기준금리 동결',
    '한국',
    '공식 보도자료·통화정책',
    ['금리', '채권'],
    3,
  ),
  releaseType: '보도자료',
  titleOriginal: '[보도자료] 한국은행 기준금리 동결',
  outcome: {
    headline: '기준금리를 연 2.50%로 유지했다',
    facts: [
      { label: '기준금리', value: '2.50%', note: '출처: 테스트 ECOS, 2026-10-20 기준' },
      { label: '변동', value: '동결(0bp)' },
    ],
  },
  reaction,
  impact: [
    { asset: '채권', effect: '단기 금리 상승 압력이 완화될 수 있다' },
    { asset: '원/달러', effect: '금리 격차 부담이 줄어 환율 하락 압력' },
  ],
  explainer: '정책금리 경로는 앞으로 기준금리가 어떻게 움직일지에 대한 방향을 뜻한다.',
  enrichment: {
    model: 'Claude Sonnet 5.5',
    generatedAt: '2026-10-21T00:05:00.000Z',
    version: 1,
    aiFields: ['outcome', 'impact', 'explainer'],
  },
};
const translated = {
  ...event(
    22,
    '2026-10-20',
    '03:00',
    '연준, 은행지주회사 신청 승인 발표',
    '미국',
    '공식 보도자료·기관발표',
    ['시장전반'],
    1,
  ),
  titleOriginal: 'Federal Reserve Board announces approval of application by Example Bancorp',
  translation: { model: 'Claude Sonnet 5.5', translatedAt: '2026-10-21T00:05:00.000Z' },
  outcome: { headline: '연준 이사회가 은행지주회사의 신청을 승인했다', facts: [] },
  enrichment: {
    model: 'Claude Sonnet 5.5',
    generatedAt: '2026-10-21T00:05:00.000Z',
    version: 1,
    aiFields: ['title', 'outcome'],
  },
};
const cleanedOnly = {
  ...event(23, '2026-10-20', '09:00', '외환시장 동향', '한국', '공식 보도자료·외환', ['원화'], 2),
  releaseType: '보도참고자료',
  titleOriginal: '[보도참고자료] 외환시장 동향',
};

async function open(page: import('@playwright/test').Page, events: unknown[]) {
  await mockApi(page, { user: ownerUser });
  await page.route('**/api/calendar/events?**', (route) =>
    route.fulfill({ json: { events, truncated: false } }),
  );
  await page.route('**/api/calendar/brief', (route) => route.fulfill({ json: { brief: null } }));
  await page.goto('/');
}

test('detail shows the Korean title, result table, measured reaction, impact, explainer and provenance', async ({
  page,
}) => {
  await open(page, [enriched, translated, cleanedOnly]);
  await page.locator('.event-chip', { hasText: '한국은행 기준금리 동결' }).click();
  await expect(page.locator('.detail-title h3')).toContainText('한국은행 기준금리 동결');
  await expect(page.locator('.detail-title .release-type')).toHaveText('보도자료');

  const outcome = page.getByRole('region', { name: '결과' });
  await expect(outcome).toContainText('기준금리를 연 2.50%로 유지했다');
  const facts = outcome.getByRole('table', { name: '결과 수치' });
  await expect(facts.getByRole('row', { name: /기준금리/ })).toContainText('2.50%');
  await expect(facts).toContainText('동결(0bp)');
  await expect(facts).toContainText('출처: 테스트 ECOS');

  const table = page.getByRole('table', { name: '시장 반응 수치' });
  await expect(table.locator('caption')).toContainText('직전 종가와 직후 종가');
  const kospi = table.getByRole('row', { name: /코스피/ });
  await expect(kospi).toContainText('2,500.5 → 2,511');
  await expect(kospi).toContainText('10.19 → 10.20 종가');
  await expect(kospi.locator('.change')).toHaveText('+0.42%');
  await expect(kospi.locator('.change')).toHaveClass(/rise/);
  const bond = table.getByRole('row', { name: /국고채 3년/ });
  await expect(bond.locator('.change')).toHaveText('-0.015%p');
  await expect(bond.locator('.change')).toHaveClass(/fall/);
  const fx = table.getByRole('row', { name: /원\/달러/ });
  await expect(fx.locator('.change')).toHaveText('+3.20원 (+0.23%)');
  const spy = table.getByRole('row', { name: /SPY/ });
  await expect(spy).toContainText('S&P 500 (SPY ETF 기준)');
  await expect(spy.locator('.change')).toHaveText('0.00%');
  await expect(spy.locator('.change')).toHaveClass(/flat/);
  // Numbers are right-aligned.
  await expect(kospi.locator('td.num').first()).toHaveCSS('text-align', 'right');
  await expect(kospi.locator('.change')).toHaveCSS('text-align', 'right');

  const impact = page.getByRole('region', { name: '영향' });
  await expect(impact).toContainText('단기 금리 상승 압력이 완화될 수 있다');
  await expect(impact.getByRole('listitem')).toHaveCount(2);
  const explainer = page.getByRole('region', { name: '설명' });
  await expect(explainer).toContainText('정책금리 경로');

  const provenance = page.locator('.enrich-provenance');
  await expect(provenance).toContainText('AI 작성(Claude Sonnet 5.5)');
  await expect(provenance).toContainText('결과·영향·설명');
  await expect(provenance).toContainText('KST');
  await expect(provenance).toContainText(
    '수치 출처: 테스트 지표(일봉 종가), 테스트 환율(매매기준율)',
  );
  await expect(provenance).toContainText('원인을 뜻하지 않습니다');
});

test('no horizontal page scroll on the detail view, numbers stay readable', async ({ page }) => {
  await open(page, [enriched]);
  await page.locator('.event-chip', { hasText: '한국은행 기준금리 동결' }).click();
  await expect(page.getByRole('table', { name: '시장 반응 수치' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  // Every table fits inside its card (no clipped column).
  const clipped = await page.evaluate(
    () =>
      [...document.querySelectorAll('.enrich-table')].filter((table) => {
        const parent = table.parentElement!.getBoundingClientRect();
        return table.getBoundingClientRect().right > parent.right + 1;
      }).length,
  );
  expect(clipped).toBe(0);
});

test('a translated title shows AI provenance and the original; a cleaned title shows the source title', async ({
  page,
}) => {
  await open(page, [translated, cleanedOnly]);
  await page.locator('.event-chip', { hasText: '연준, 은행지주회사' }).click();
  const original = page.locator('.original-title');
  await expect(original).toContainText('AI 번역 · Claude Sonnet 5.5');
  await original.getByRole('button', { name: '원문 제목 보기' }).click();
  await expect(original.locator('q')).toHaveText(/Federal Reserve Board announces approval/);
  await expect(page.getByRole('region', { name: '결과' })).toContainText(
    '은행지주회사의 신청을 승인했다',
  );
  // No reaction and no impact: those blocks are absent, not empty.
  await expect(page.getByRole('table', { name: '시장 반응 수치' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '영향' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '설명' })).toHaveCount(0);

  await page.locator('.event-chip', { hasText: '외환시장 동향' }).click();
  const cleaned = page.locator('.original-title');
  await expect(cleaned).toContainText('공식 원문 제목(정리 전)');
  await expect(cleaned).not.toContainText('AI 번역');
  await cleaned.getByRole('button', { name: '원문 제목 보기' }).click();
  await expect(cleaned.locator('q')).toHaveText('[보도참고자료] 외환시장 동향');
  await expect(page.locator('.detail-title .release-type')).toHaveText('보도참고자료');
  // No enrichment at all: the detail block is not rendered.
  await expect(page.locator('.event-enrichment')).toHaveCount(0);
});
