import { Sparkles } from 'lucide-react';
import type { EventReaction, MarketEvent } from '../../lib/market';
import { formatKst } from '../../lib/kst';
import './calendar-enrichment.css';

/**
 * Per-event Korean detail written by the calendar enrichment (src/server/calendar-enrich.ts):
 * 결과 (what the release decided/showed), 시장 반응 (measured moves, deterministic), 영향 (what it can
 * affect), an optional 설명 for hard concepts, and a provenance line that separates AI-written text
 * from numbers with their source and date.
 */
const ASSET_LABEL: Record<EventReaction['asset'], string> = {
  KOSPI: '코스피',
  KOSDAQ: '코스닥',
  KR_BOND_3Y: '국고채 3년 금리',
  KR_BOND_10Y: '국고채 10년 금리',
  USDKRW: '원/달러 환율',
  SPY: 'S&P 500 (SPY ETF 기준)',
};
const FIELD_LABEL = { title: '제목', outcome: '결과', impact: '영향', explainer: '설명' } as const;
const number = (value: number, digits = 3) =>
  value.toLocaleString('ko-KR', { maximumFractionDigits: digits });
const signed = (value: number, digits: number) =>
  `${value > 0 ? '+' : value < 0 ? '-' : ''}${Math.abs(value).toLocaleString('ko-KR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
/** "2026-10-19" -> "10.19" */
const shortDate = (date: string) => `${date.slice(5, 7)}.${date.slice(8, 10)}`;
export function formatReactionChange(row: EventReaction): string {
  if (row.unit === '%p') return `${signed(row.change, 3)}%p`;
  if (row.unit === '원')
    return `${signed(row.change, 2)}원${row.changePercent === undefined ? '' : ` (${signed(row.changePercent, 2)}%)`}`;
  return `${signed(row.change, 2)}%`;
}
const tone = (row: EventReaction) => (row.change > 0 ? 'rise' : row.change < 0 ? 'fall' : 'flat');

export function EventEnrichmentDetail({ event }: { event: MarketEvent }) {
  const { outcome, reaction, impact, explainer, enrichment } = event;
  if (!outcome && !reaction?.length && !impact?.length && !explainer) return null;
  const aiFields = (enrichment?.aiFields ?? []).map((field) => FIELD_LABEL[field]).join('·');
  const sources = [...new Set((reaction ?? []).map((row) => row.source))];
  return (
    <div className="event-enrichment">
      {outcome && (
        <section aria-label="결과">
          <h4>결과</h4>
          <p className="enrich-headline">{outcome.headline}</p>
          {outcome.facts.length > 0 && (
            <table className="enrich-table" aria-label="결과 수치">
              <thead>
                <tr>
                  <th scope="col">항목</th>
                  <th scope="col" className="num">
                    값
                  </th>
                </tr>
              </thead>
              <tbody>
                {outcome.facts.map((fact) => (
                  <tr key={fact.label}>
                    <th scope="row">{fact.label}</th>
                    <td className="num">
                      {fact.value}
                      {fact.note && <small>{fact.note}</small>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      {reaction && reaction.length > 0 && (
        <section aria-label="시장 반응">
          <h4>시장 반응</h4>
          <table className="enrich-table reaction-table" aria-label="시장 반응 수치">
            <caption>발표 직전 종가와 직후 종가의 비교</caption>
            <thead>
              <tr>
                <th scope="col">자산</th>
                <th scope="col" className="num">
                  전 → 후 (기준일)
                </th>
                <th scope="col" className="num">
                  변화
                </th>
              </tr>
            </thead>
            <tbody>
              {reaction.map((row) => (
                <tr key={row.asset}>
                  <th scope="row">{ASSET_LABEL[row.asset]}</th>
                  <td className="num">
                    <span className="pair">
                      {number(row.from.value)} → {number(row.to.value)}
                    </span>
                    <small>
                      {shortDate(row.from.date)} → {shortDate(row.to.date)} 종가
                    </small>
                  </td>
                  <td className={`num change ${tone(row)}`}>{formatReactionChange(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {impact && impact.length > 0 && (
        <section aria-label="영향">
          <h4>영향</h4>
          <ul className="enrich-impact">
            {impact.map((row) => (
              <li key={row.asset}>
                <strong>{row.asset}</strong>
                <span>{row.effect}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {explainer && (
        <section className="enrich-explainer" aria-label="설명">
          <h4>설명</h4>
          <p>{explainer}</p>
        </section>
      )}
      <p className="enrich-provenance">
        {enrichment && (
          <span>
            <Sparkles size={11} /> AI 작성({enrichment.model}) · {aiFields} ·{' '}
            {formatKst(enrichment.generatedAt)} KST.{' '}
          </span>
        )}
        {sources.length > 0 && <span>수치 출처: {sources.join(', ')} (종가 기준, 추정 없음).</span>}
        {!enrichment && !sources.length && <span>수치는 공식 자료에서 가져왔습니다.</span>}
        <span> 시장 반응은 같은 시기의 다른 요인이 섞인 관측이며 원인을 뜻하지 않습니다.</span>
      </p>
    </div>
  );
}
