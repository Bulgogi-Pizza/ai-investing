/**
 * Code-fixed indicator catalog. Series ids, release ids and ECOS codes come only from here: request
 * input selects a catalog `id`, never a provider series id. Every entry was checked against the
 * official FRED series pages / the ECOS statistic code search on 2026-10-21 (see
 * docs/implementation/macro-data.md). Importance is this project's own judgement, not a provider
 * field.
 */
export type MacroSource = 'fred' | 'ecos';
export type EcosCycle = 'D' | 'M' | 'Q' | 'A';

interface CatalogBase {
  id: string;
  titleKo: string;
  country: '미국' | '한국';
  /** 3 = moves rates/FX/equities on release day, 2 = regular watch item, 1 = background. */
  importance: 1 | 2 | 3;
  importanceRationale: string;
  /** Matches the calendar category vocabulary: "경제 지표" or "금리 결정". */
  category: '경제 지표' | '금리 결정';
  unit: string;
  assets: string[];
  sourceName: string;
  sourceUrl: string;
}
export interface FredIndicator extends CatalogBase {
  source: 'fred';
  seriesId: string;
  frequency: 'daily' | 'monthly' | 'quarterly';
  /** FRED release id (series page "rid"); release dates come from fred/release/dates. */
  releaseId: number;
  releaseName: string;
}
export interface EcosIndicator extends CatalogBase {
  source: 'ecos';
  statCode: string;
  itemCode: string;
  cycle: EcosCycle;
  /** ECOS exposes no release calendar, so these entries never produce upcoming release dates. */
  releaseId?: undefined;
}
export type Indicator = FredIndicator | EcosIndicator;

const fredPage = (seriesId: string) => `https://fred.stlouisfed.org/series/${seriesId}`;
const ecosSource = 'https://ecos.bok.or.kr/api/';

export const indicatorCatalog: readonly Indicator[] = [
  {
    id: 'us-cpi',
    source: 'fred',
    seriesId: 'CPIAUCSL',
    frequency: 'monthly',
    releaseId: 10,
    releaseName: 'Consumer Price Index',
    titleKo: '미국 소비자물가지수(CPI, 계절조정)',
    country: '미국',
    importance: 3,
    importanceRationale: '연준 금리 경로 기대를 직접 움직이는 대표 물가 지표',
    category: '경제 지표',
    unit: '지수(1982-1984=100)',
    assets: ['금리', '채권', '달러', '주식'],
    sourceName: 'FRED(미국 노동통계국 원자료)',
    sourceUrl: fredPage('CPIAUCSL'),
  },
  {
    id: 'us-core-cpi',
    source: 'fred',
    seriesId: 'CPILFESL',
    frequency: 'monthly',
    releaseId: 10,
    releaseName: 'Consumer Price Index',
    titleKo: '미국 근원 CPI(식품·에너지 제외, 계절조정)',
    country: '미국',
    importance: 3,
    importanceRationale: '변동성 큰 항목을 뺀 기조 물가로 금리 기대에 헤드라인보다 큰 영향',
    category: '경제 지표',
    unit: '지수(1982-1984=100)',
    assets: ['금리', '채권', '달러', '주식'],
    sourceName: 'FRED(미국 노동통계국 원자료)',
    sourceUrl: fredPage('CPILFESL'),
  },
  {
    id: 'us-unemployment',
    source: 'fred',
    seriesId: 'UNRATE',
    frequency: 'monthly',
    releaseId: 50,
    releaseName: 'Employment Situation',
    titleKo: '미국 실업률(계절조정)',
    country: '미국',
    importance: 3,
    importanceRationale: '고용 보고서의 핵심 값으로 발표일 변동성이 큰 편',
    category: '경제 지표',
    unit: '%',
    assets: ['금리', '달러', '주식'],
    sourceName: 'FRED(미국 노동통계국 원자료)',
    sourceUrl: fredPage('UNRATE'),
  },
  {
    id: 'us-nonfarm-payrolls',
    source: 'fred',
    seriesId: 'PAYEMS',
    frequency: 'monthly',
    releaseId: 50,
    releaseName: 'Employment Situation',
    titleKo: '미국 비농업 고용자 수(계절조정)',
    country: '미국',
    importance: 3,
    importanceRationale: '월간 고용 증감의 대표 지표로 금리·환율 반응이 큼',
    category: '경제 지표',
    unit: '천 명',
    assets: ['금리', '달러', '주식'],
    sourceName: 'FRED(미국 노동통계국 원자료)',
    sourceUrl: fredPage('PAYEMS'),
  },
  {
    id: 'us-gdp',
    source: 'fred',
    seriesId: 'GDPC1',
    frequency: 'quarterly',
    releaseId: 53,
    releaseName: 'Gross Domestic Product',
    titleKo: '미국 실질 GDP(계절조정 연율)',
    country: '미국',
    importance: 2,
    importanceRationale: '분기 지표라 빈도가 낮고 속보치 이후 수정이 잦아 영향은 보통',
    category: '경제 지표',
    unit: '십억 2017년 연쇄 달러',
    assets: ['주식', '달러'],
    sourceName: 'FRED(미국 경제분석국 원자료)',
    sourceUrl: fredPage('GDPC1'),
  },
  {
    id: 'us-pce',
    source: 'fred',
    seriesId: 'PCEPI',
    frequency: 'monthly',
    releaseId: 54,
    releaseName: 'Personal Income and Outlays',
    titleKo: '미국 PCE 물가지수(계절조정)',
    country: '미국',
    importance: 2,
    importanceRationale: '연준 선호 물가 지표이나 CPI 이후 발표되어 선반영되는 경우가 많음',
    category: '경제 지표',
    unit: '지수(2017=100)',
    assets: ['금리', '채권', '달러'],
    sourceName: 'FRED(미국 경제분석국 원자료)',
    sourceUrl: fredPage('PCEPI'),
  },
  {
    id: 'us-core-pce',
    source: 'fred',
    seriesId: 'PCEPILFE',
    frequency: 'monthly',
    releaseId: 54,
    releaseName: 'Personal Income and Outlays',
    titleKo: '미국 근원 PCE 물가지수(식품·에너지 제외)',
    country: '미국',
    importance: 3,
    importanceRationale: '연준이 기조 물가 판단에 쓰는 지표라 금리 기대에 영향이 큼',
    category: '경제 지표',
    unit: '지수(2017=100)',
    assets: ['금리', '채권', '달러', '주식'],
    sourceName: 'FRED(미국 경제분석국 원자료)',
    sourceUrl: fredPage('PCEPILFE'),
  },
  {
    id: 'us-fed-funds-upper',
    source: 'fred',
    seriesId: 'DFEDTARU',
    frequency: 'daily',
    releaseId: 101,
    releaseName: 'FOMC Press Release',
    titleKo: '미국 연방기금금리 목표 범위 상단',
    country: '미국',
    importance: 3,
    importanceRationale: '정책금리 자체이며 결정일에 전 자산이 반응',
    category: '금리 결정',
    unit: '%',
    assets: ['금리', '채권', '달러', '주식'],
    sourceName: 'FRED(연방준비제도 이사회 원자료)',
    sourceUrl: fredPage('DFEDTARU'),
  },
  {
    id: 'us-fed-funds-lower',
    source: 'fred',
    seriesId: 'DFEDTARL',
    frequency: 'daily',
    releaseId: 101,
    releaseName: 'FOMC Press Release',
    titleKo: '미국 연방기금금리 목표 범위 하단',
    country: '미국',
    importance: 3,
    importanceRationale: '정책금리 자체이며 결정일에 전 자산이 반응',
    category: '금리 결정',
    unit: '%',
    assets: ['금리', '채권', '달러', '주식'],
    sourceName: 'FRED(연방준비제도 이사회 원자료)',
    sourceUrl: fredPage('DFEDTARL'),
  },
  {
    id: 'kr-base-rate',
    source: 'ecos',
    statCode: '722Y001',
    itemCode: '0101000',
    cycle: 'D',
    titleKo: '한국은행 기준금리',
    country: '한국',
    importance: 3,
    importanceRationale: '국내 정책금리 자체이며 결정일에 채권·환율·주식이 반응',
    category: '금리 결정',
    unit: '연 %',
    assets: ['금리', '채권', '원화', '주식'],
    sourceName: '한국은행 ECOS',
    sourceUrl: ecosSource,
  },
  {
    id: 'kr-cpi',
    source: 'ecos',
    statCode: '901Y009',
    itemCode: '0',
    cycle: 'M',
    titleKo: '한국 소비자물가지수(총지수, 2020=100)',
    country: '한국',
    importance: 2,
    importanceRationale: '국내 금리 경로와 물가 흐름을 보는 월간 지표',
    category: '경제 지표',
    unit: '지수(2020=100)',
    assets: ['금리', '채권', '원화'],
    sourceName: '한국은행 ECOS',
    sourceUrl: ecosSource,
  },
  {
    id: 'kr-usdkrw',
    source: 'ecos',
    statCode: '731Y001',
    itemCode: '0000001',
    cycle: 'D',
    titleKo: '원/달러 환율(매매기준율)',
    country: '한국',
    importance: 2,
    importanceRationale: '차트 비교용 일별 환율. 발표 일정이 있는 이벤트가 아니다',
    category: '경제 지표',
    unit: '원',
    assets: ['원화', '달러'],
    sourceName: '한국은행 ECOS',
    sourceUrl: ecosSource,
  },
];

const byId = new Map(indicatorCatalog.map((entry) => [entry.id, entry]));

export function indicatorById(id: unknown): Indicator | undefined {
  return typeof id === 'string' ? byId.get(id) : undefined;
}
export function fredIndicator(id: unknown): FredIndicator | undefined {
  const entry = indicatorById(id);
  return entry?.source === 'fred' ? entry : undefined;
}
export function ecosIndicator(id: unknown): EcosIndicator | undefined {
  const entry = indicatorById(id);
  return entry?.source === 'ecos' ? entry : undefined;
}
/** FRED release id -> catalog entries that share it (one release date covers all of them). */
export function indicatorsByRelease(): Map<number, FredIndicator[]> {
  const groups = new Map<number, FredIndicator[]>();
  for (const entry of indicatorCatalog)
    if (entry.source === 'fred')
      groups.set(entry.releaseId, [...(groups.get(entry.releaseId) ?? []), entry]);
  return groups;
}

export interface ReleaseEntry {
  releaseId: number;
  releaseName: string;
  titleKo: string;
  importance: 1 | 2 | 3;
  category: FredIndicator['category'];
  assets: string[];
  indicatorIds: string[];
  sourceUrl: string;
}
/**
 * FRED release 101 ("FOMC Press Release") carries the daily target-range series, so FRED lists a
 * release date on almost every business day. Its events come from the Fed's own meeting calendar
 * instead: the statement day (second day, New York date) of each scheduled meeting, released at
 * 14:00 New York time. Checked against the source on 2026-10-21; the Fed marks them tentative
 * until the preceding meeting, and the list must be extended when the next year is published.
 */
export const fomcCalendarUrl = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
export const officialReleaseSchedules: Record<
  number,
  { dates: readonly string[]; nyTime: string }
> = {
  101: {
    nyTime: '14:00',
    dates: [
      '2026-01-28',
      '2026-03-18',
      '2026-04-29',
      '2026-06-17',
      '2026-07-29',
      '2026-09-16',
      '2026-10-28',
      '2026-12-09',
      '2027-01-27',
      '2027-03-17',
      '2027-04-28',
      '2027-06-09',
      '2027-07-28',
      '2027-09-15',
      '2027-10-27',
      '2027-12-08',
    ],
  },
};

const seoulClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const newYorkHour = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  hourCycle: 'h23',
});
/** New York wall-clock date/time -> KST date and HH:MM (handles EDT/EST). */
export function newYorkToKst(date: string, time: string): { date: string; time: string } {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  // EDT is UTC-4, EST is UTC-5: take the offset whose New York hour matches.
  let instant = new Date(Date.UTC(year, month - 1, day, hour + 4, minute));
  if (Number(newYorkHour.format(instant)) !== hour)
    instant = new Date(Date.UTC(year, month - 1, day, hour + 5, minute));
  const parts = Object.fromEntries(seoulClock.formatToParts(instant).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

/** One entry per catalog FRED release: importance is the highest of its indicators. */
export function releaseCatalog(): ReleaseEntry[] {
  const titles: Record<number, string> = {
    10: '미국 소비자물가지수(CPI) 발표',
    50: '미국 고용 보고서(실업률·비농업 고용) 발표',
    53: '미국 GDP 발표',
    54: '미국 개인소득·지출(PCE 물가) 발표',
    101: '미국 FOMC 성명(금리 결정)',
  };
  return [...indicatorsByRelease()].map(([releaseId, entries]) => ({
    releaseId,
    releaseName: entries[0].releaseName,
    titleKo: titles[releaseId] ?? entries[0].releaseName,
    importance: Math.max(...entries.map((entry) => entry.importance)) as 1 | 2 | 3,
    category: entries[0].category,
    assets: [...new Set(entries.flatMap((entry) => entry.assets))],
    indicatorIds: entries.map((entry) => entry.id),
    sourceUrl: `https://fred.stlouisfed.org/release?rid=${releaseId}`,
  }));
}
