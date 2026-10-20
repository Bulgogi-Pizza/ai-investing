import type { EventImportance, EventKind } from '../../lib/chartEvents.js';
import { isoDateOnly, record, schemaInvalid, text } from './shared.js';

/**
 * Filing lists for the chart's event lines (stage 5d). Pure parsing and classification; the
 * adapters (dart.ts, sec.ts) do the HTTP. Rules are documented in docs/implementation/charts.md.
 */
export interface Filing {
  /** Date the provider stamped on the filing: KST (DART `rcept_dt`) or US Eastern (SEC `filingDate`). */
  date: string;
  title: string;
  titleLanguage: 'ko' | 'original';
  kind: EventKind;
  importance: EventImportance;
  /** Provider's id of the filing (DART `rcept_no`, SEC accession number). */
  key: string;
  url: string;
}

// ---- DART ----------------------------------------------------------------------------------

/** DART `pblntf_ty` categories read for the chart: A periodic, B major matters, I exchange. */
export type DartCategory = 'A' | 'B' | 'I';
export const dartCategories: readonly DartCategory[] = ['A', 'B', 'I'];

/** DART viewer page of a filing (opened with the 14-digit receipt number, per the DART guide). */
export const dartViewerUrl = (receiptNo: string) =>
  `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${receiptNo}`;

/**
 * Classifies one DART list row, or returns null for rows that are not drawn.
 * - A (정기공시): 사업보고서 = earnings, importance 3; 반기·분기보고서 = earnings, 2; other A = 공시, 1.
 * - B (주요사항보고): 공시, 2.
 * - I (거래소공시): only 영업(잠정)실적 = earnings, 3 (the first earnings disclosure). Every other
 *   exchange disclosure is skipped: there are dozens per quarter and they would bury the chart.
 */
export function classifyDart(
  category: DartCategory,
  reportName: string,
): { kind: EventKind; importance: EventImportance } | null {
  if (category === 'A') {
    if (reportName.includes('사업보고서')) return { kind: 'earnings', importance: 3 };
    if (/(반기|분기)보고서/.test(reportName)) return { kind: 'earnings', importance: 2 };
    return { kind: 'disclosure', importance: 1 };
  }
  if (category === 'B') return { kind: 'disclosure', importance: 2 };
  return reportName.includes('잠정') && reportName.includes('실적')
    ? { kind: 'earnings', importance: 3 }
    : null;
}

/** One `list.json` page. Row fields used: report_nm, rcept_no, rcept_dt (DART guide DS001/2019001). */
export function parseDartList(rows: unknown, category: DartCategory): Filing[] {
  if (!Array.isArray(rows) || rows.length > 100) throw schemaInvalid();
  const filings: Filing[] = [];
  for (const item of rows) {
    const row = record(item);
    const receipt = text(row.rcept_no, 14);
    const received = text(row.rcept_dt, 8);
    const reportName = text(row.report_nm, 300).trim();
    if (!/^\d{14}$/.test(receipt) || !/^\d{8}$/.test(received) || !reportName)
      throw schemaInvalid();
    const date = `${received.slice(0, 4)}-${received.slice(4, 6)}-${received.slice(6)}`;
    const verdict = classifyDart(category, reportName);
    if (!verdict || Number.isNaN(Date.parse(date))) continue;
    filings.push({
      date,
      title: reportName,
      titleLanguage: 'ko',
      ...verdict,
      key: receipt,
      url: dartViewerUrl(receipt),
    });
  }
  return filings;
}

// ---- SEC -----------------------------------------------------------------------------------

/** Forms drawn: annual and quarterly reports and current reports (8-K). Amendments are skipped. */
export const secForms = new Set(['10-K', '10-Q', '8-K']);

/** EDGAR filing index page, built from the CIK and the accession number. */
export const secIndexUrl = (cik: number, accession: string) =>
  `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replaceAll('-', '')}/${accession}-index.htm`;

/**
 * - 10-K: earnings, 3. 10-Q: earnings, 2.
 * - 8-K that carries Item 2.02 (Results of Operations and Financial Condition): earnings, 3 (the
 *   earnings release itself). Any other 8-K: 공시, 1.
 */
export function classifySec(
  form: string,
  items: string,
): { kind: EventKind; importance: EventImportance; title: string } | null {
  if (form === '10-K')
    return { kind: 'earnings', importance: 3, title: '연간 보고서(10-K) 제출 · 원제 Form 10-K' };
  if (form === '10-Q')
    return { kind: 'earnings', importance: 2, title: '분기 보고서(10-Q) 제출 · 원제 Form 10-Q' };
  if (form === '8-K') {
    const list = items
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (list.includes('2.02'))
      return {
        kind: 'earnings',
        importance: 3,
        title: `실적 발표(8-K 항목 2.02)${list.length > 1 ? ` · 항목 ${list.join(', ')}` : ''}`,
      };
    return {
      kind: 'disclosure',
      importance: 1,
      title: `수시 보고(8-K)${list.length ? ` · 항목 ${list.join(', ')}` : ''}`,
    };
  }
  return null;
}

/**
 * `filings.recent` of data.sec.gov/submissions/CIK##########.json: parallel arrays. Used fields:
 * accessionNumber, filingDate, form and (optional) items. The SEC pages read on 2026-10-21 describe
 * the file only as a "compact columnar data array"; these names are the widely used response shape
 * and must be confirmed at the first live call. A response without them fails as a schema error.
 */
export function parseSecSubmissions(json: Record<string, unknown>, cik: number): Filing[] {
  if (json.cik !== undefined && Number(json.cik) !== cik) throw schemaInvalid();
  const recent = record(record(json.filings).recent);
  const accession = recent.accessionNumber;
  const dates = recent.filingDate;
  const forms = recent.form;
  const items = recent.items;
  if (
    !Array.isArray(accession) ||
    !Array.isArray(dates) ||
    !Array.isArray(forms) ||
    accession.length > 5000 ||
    dates.length !== accession.length ||
    forms.length !== accession.length ||
    (items !== undefined && (!Array.isArray(items) || items.length !== accession.length))
  )
    throw schemaInvalid();
  const filings: Filing[] = [];
  for (let i = 0; i < accession.length; i++) {
    const form = text(forms[i], 30);
    if (!secForms.has(form)) continue;
    const accessionNumber = text(accession[i], 30);
    if (!/^\d{10}-\d{2}-\d{6}$/.test(accessionNumber)) throw schemaInvalid();
    const verdict = classifySec(form, items === undefined ? '' : text(items[i] ?? '', 200));
    if (!verdict) continue;
    filings.push({
      date: isoDateOnly(dates[i]),
      title: verdict.title,
      titleLanguage: 'ko',
      kind: verdict.kind,
      importance: verdict.importance,
      key: accessionNumber,
      url: secIndexUrl(cik, accessionNumber),
    });
  }
  return filings;
}

/** Oldest date in `filings.recent` and whether older filings live in extra files (not read here). */
export function secRecentCoverage(json: Record<string, unknown>): {
  oldest: string | null;
  hasOlder: boolean;
} {
  const filings = record(json.filings);
  const dates = record(filings.recent).filingDate;
  if (!Array.isArray(dates)) throw schemaInvalid();
  const older = filings.files;
  return {
    oldest: dates.length ? dates.map(isoDateOnly).sort()[0] : null,
    hasOlder: Array.isArray(older) && older.length > 0,
  };
}
