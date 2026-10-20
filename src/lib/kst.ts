/** Calendar date in Asia/Seoul; month is zero-based like Date. */
export function kstToday(now: Date = new Date()) {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number);
  return { year, month: month - 1, day };
}
export function formatKst(value: string): string {
  return new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}
export function formatKstTime(value: string): string {
  return new Date(value).toLocaleTimeString('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
  });
}
