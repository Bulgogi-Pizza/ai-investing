// Display formatting for the 종목 분석 tab. Money values arrive as decimal strings; these helpers
// only format and never round away information the provider sent without saying so.
export type Currency = 'KRW' | 'USD';

const integer = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const decimals = (digits: number) =>
  new Intl.NumberFormat('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** KRW in whole won, USD in dollars and cents; the unit is the currency the provider reported. */
export function formatPrice(value: number | string, currency: Currency): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return currency === 'KRW' ? `${integer.format(n)}원` : `$${decimals(2).format(n)}`;
}

/** Signed amount with the currency symbol, e.g. +1,234원 / -$1.20. */
export function formatSignedPrice(value: number, currency: Currency): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return sign + formatPrice(Math.abs(value), currency);
}

/** Ratio (0.0123) as a signed percentage with two decimals. */
export function formatSignedPercent(rate: number): string {
  const sign = rate > 0 ? '+' : rate < 0 ? '-' : '';
  return `${sign}${decimals(2).format(Math.abs(rate) * 100)}%`;
}
export const formatPercent = (rate: number, digits = 2) =>
  `${decimals(digits).format(rate * 100)}%`;

/** Whole numbers with thousands separators (shares, volumes). Missing input shows a dash. */
export function formatCount(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '–';
  const n = Number(value);
  return Number.isFinite(n) ? integer.format(n) : '–';
}
export function formatSignedCount(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '–';
  const n = Number(value);
  if (!Number.isFinite(n)) return '–';
  return (n > 0 ? '+' : '') + integer.format(n);
}

/** Large KRW amounts as 조/억: 425조 3,210억 원. Below 1억 the whole number is shown. */
export function formatKrwLarge(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const jo = Math.floor(abs / 1e12);
  const eok = Math.floor((abs % 1e12) / 1e8);
  if (jo > 0) return `${sign}${integer.format(jo)}조${eok ? ` ${integer.format(eok)}억` : ''} 원`;
  if (eok > 0) return `${sign}${integer.format(eok)}억 원`;
  return `${sign}${integer.format(abs)}원`;
}
export function formatUsdLarge(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
  ];
  for (const [size, label] of units)
    if (abs >= size) return `${sign}$${decimals(2).format(abs / size)}${label}`;
  return `${sign}$${decimals(2).format(abs)}`;
}
export const formatMarketCap = (value: number, currency: Currency) =>
  currency === 'KRW' ? formatKrwLarge(value) : formatUsdLarge(value);

/**
 * Statement amounts: KRW in 억 원, USD in 백만 달러 (the column header states the unit). Values
 * between zero and ten units keep one decimal so a small value never reads as 0.
 */
export function formatStatementAmount(value: string | null, currency: string): string {
  if (value === null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const scaled = currency === 'KRW' ? n / 1e8 : n / 1e6;
  const digits = Math.abs(scaled) < 10 && scaled !== 0 && !Number.isInteger(scaled) ? 1 : 0;
  return decimals(digits).format(scaled);
}
export const statementUnit = (currency: string) =>
  currency === 'KRW' ? '억 원' : currency === 'USD' ? '백만 달러' : currency;

export const formatRatioTimes = (value: number) => `${decimals(2).format(value)}배`;
