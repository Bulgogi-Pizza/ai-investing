import type { EconomicEvent } from './calendar.js';
import type { EnrichFact } from './calendar-enrich.js';
import type { EcosObservation } from './macro/ecos.js';

/**
 * Official figures for recurring Bank of Korea statistics releases (deterministic, no AI). The
 * press-release feed gives only a title such as "2026년 9월 생산자물가지수(잠정)", so the month in
 * the title selects the ECOS observation and the code computes the changes from two official
 * observations. ECOS has no vintages: values are the current published ones (revisions included),
 * which the first fact's note says.
 *
 * Returns null when the release maps to a series but the titled month is not in ECOS yet (the
 * caller defers AI so the outcome is written with the numbers), [] when the release has no series.
 */
export type ReleaseFactsSource = {
  observations(id: string, range: { from: string; to: string }): Promise<EcosObservation[]>;
};
type Kind = 'index' | 'sentiment' | 'usd-million' | 'usd-thousand' | 'krw-billion' | 'rate';
type Series = { id: string; label: string; kind: Kind };
const RULES: { pattern: RegExp; series: Series[] }[] = [
  {
    pattern: /생산자물가지수/,
    series: [{ id: 'kr-ppi', label: '생산자물가지수(2020=100)', kind: 'index' }],
  },
  {
    pattern: /수출입물가지수/,
    series: [
      { id: 'kr-export-price', label: '수출물가지수(원화기준)', kind: 'index' },
      { id: 'kr-import-price', label: '수입물가지수(원화기준)', kind: 'index' },
    ],
  },
  {
    pattern: /소비자동향조사/,
    series: [{ id: 'kr-ccsi', label: '소비자심리지수(CCSI)', kind: 'sentiment' }],
  },
  {
    pattern: /경제심리지수|ESI/,
    series: [{ id: 'kr-esi', label: '경제심리지수(ESI)', kind: 'sentiment' }],
  },
  {
    pattern: /국제수지\(/,
    series: [{ id: 'kr-current-account', label: '경상수지(계절조정)', kind: 'usd-million' }],
  },
  {
    pattern: /외환보유액/,
    series: [{ id: 'kr-fx-reserves', label: '외환보유액', kind: 'usd-thousand' }],
  },
  {
    pattern: /통화 및 유동성/,
    series: [{ id: 'kr-m2', label: 'M2(평잔, 계절조정)', kind: 'krw-billion' }],
  },
  {
    pattern: /가중평균금리/,
    series: [{ id: 'kr-loan-rate', label: '예금은행 대출금리(신규, 평균)', kind: 'rate' }],
  },
];

/** Series a release maps to (title only, no network): the Bank of Korea feed only. */
export function releaseSeries(event: EconomicEvent): Series[] {
  if (event.country !== '한국' || !/한국은행/.test(event.sourceName)) return [];
  return RULES.find((rule) => rule.pattern.test(event.title))?.series ?? [];
}
/** "2026년 9월" / "2026년 9월말" in the title -> 2026-09-01. */
export function titledMonth(title: string): string | null {
  const match = /(\d{4})년\s*(\d{1,2})월/.exec(title);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${match[1]}-${String(month).padStart(2, '0')}-01`;
}
const shiftMonth = (date: string, months: number) => {
  const [year, month] = date.split('-').map(Number);
  const index = year * 12 + month - 1 + months;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`;
};
const fixed = (value: number, digits: number) => {
  const text = value.toFixed(digits);
  return /^-0(?:\.0+)?$/.test(text) ? (0).toFixed(digits) : text;
};
const signed = (value: number, digits: number, unit: string) => {
  const text = fixed(value, digits);
  return `${Number(text) > 0 ? '+' : ''}${text}${unit}`;
};
const percent = (now: number, then: number) => ((now - then) / Math.abs(then)) * 100;

function seriesFacts(series: Series, now: number, prev: number | null, yearAgo: number | null) {
  const facts: EnrichFact[] = [];
  const add = (label: string, value: string) => facts.push({ label, value });
  switch (series.kind) {
    case 'index':
      add(series.label, fixed(now, 2));
      if (prev !== null) add('전월 대비', signed(percent(now, prev), 1, '%'));
      if (yearAgo !== null) add('전년 동월 대비', signed(percent(now, yearAgo), 1, '%'));
      break;
    case 'sentiment':
      add(series.label, fixed(now, 1));
      if (prev !== null) add('전월 대비', signed(now - prev, 1, 'p'));
      break;
    case 'usd-million':
      add(series.label, `${signed(now / 100, 1, '')}억 달러`);
      if (prev !== null) add('전월', `${signed(prev / 100, 1, '')}억 달러`);
      break;
    case 'usd-thousand':
      add(series.label, `${fixed(now / 100_000, 1)}억 달러`);
      if (prev !== null) add('전월 대비', `${signed((now - prev) / 100_000, 1, '')}억 달러`);
      break;
    case 'krw-billion':
      add(series.label, `${fixed(now / 1000, 1)}조 원`);
      if (prev !== null) add('전월 대비', signed(percent(now, prev), 1, '%'));
      if (yearAgo !== null) add('전년 동월 대비', signed(percent(now, yearAgo), 1, '%'));
      break;
    case 'rate':
      add(series.label, `${fixed(now, 2)}%`);
      if (prev !== null) add('전월 대비', signed(now - prev, 2, '%p'));
      break;
  }
  return facts;
}

export function releaseFactsProvider(source: ReleaseFactsSource) {
  return async (event: EconomicEvent): Promise<EnrichFact[] | null> => {
    const series = releaseSeries(event);
    const month = titledMonth(event.title);
    if (!series.length || !month) return [];
    const facts: EnrichFact[] = [];
    for (const entry of series) {
      const rows = await source.observations(entry.id, { from: shiftMonth(month, -12), to: month });
      const at = (date: string) => {
        const value = rows.find((row) => row.date === date)?.value;
        return value === null || value === undefined ? null : Number(value);
      };
      const now = at(month);
      if (now === null || !Number.isFinite(now)) return null;
      const rowsFor = seriesFacts(
        entry,
        now,
        at(shiftMonth(month, -1)),
        at(shiftMonth(month, -12)),
      );
      // A pair of series shares the change labels: prefix them with the series name.
      const prefix = series.length > 1 ? `${entry.label.replace(/\(.*$/, '')} ` : '';
      facts.push(
        ...rowsFor.map((fact, index) =>
          index === 0 ? fact : { ...fact, label: `${prefix}${fact.label}` },
        ),
      );
    }
    if (facts.length)
      facts[0] = {
        ...facts[0],
        note: `출처: 한국은행 ECOS, ${Number(month.slice(0, 4))}년 ${Number(month.slice(5, 7))}월(현재 공표값)`,
      };
    return facts.slice(0, 8);
  };
}
