import { useEffect, useMemo, useRef, useState } from 'react';
import { DataState, LoadingState } from '../../components/DataState';
import { SourceLink } from '../../components/SourceLink';
import { ApiError, apiGet, issueOf, useApiResource, type Resource } from '../../lib/api';
import {
  compareSector,
  describeMetric,
  reasonText,
  type Market,
  type PeerRatios,
} from '../../lib/analysis';
import {
  formatPercent,
  formatPrice,
  formatRatioTimes,
  formatStatementAmount,
  statementUnit,
  type Currency,
} from '../../lib/format';
import { formatKst } from '../../lib/kst';
import { priceRatios } from '../../lib/valuation';
import type { FinancialStatement } from '../../lib/valuation';
import type { Valuation } from './Summary';
import {
  parseFundamentals,
  parsePriceQuote,
  parseSectorPeers,
  type Fundamentals,
  type PriceQuote,
  type SectorPeers,
} from './parsers';

const kst = (value: string) => `${formatKst(value)} KST`;
const periodName = (s: FinancialStatement) =>
  s.fiscalPeriod === 'FY'
    ? `${s.fiscalYear} 연간`
    : `${s.fiscalYear} ${s.fiscalPeriod.replace('Q', '')}분기`;

/** 가치·재무 tab: statements, per-share metrics with sources, and the sector comparison. */
export function ValuePanel({
  symbol,
  market,
  fundamentals,
  retryFundamentals,
  quote,
  valuation,
}: {
  symbol: string;
  market: Market | null;
  fundamentals: Resource<Fundamentals>;
  retryFundamentals: () => void;
  quote: PriceQuote | null;
  valuation: Valuation | null;
}) {
  const [kind, setKind] = useState<'annual' | 'quarter'>('annual');
  if (fundamentals.status === 'loading' || fundamentals.status === 'idle')
    return (
      <LoadingState label="재무 공시를 불러오는 중… (국내는 첫 조회에 몇 초 걸릴 수 있습니다)" />
    );
  if (fundamentals.status === 'issue')
    return <DataState issue={fundamentals.issue} onRetry={retryFundamentals} scope="재무 데이터" />;
  const data = fundamentals.data;
  const statements = data.statements
    .filter((s) => s.periodType === kind)
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))
    .slice(0, kind === 'annual' ? 5 : 8);
  const currency = statements[0]?.currency ?? data.perShare.currency ?? 'KRW';
  const per = describeMetric(valuation?.ratios.per);
  const pbr = describeMetric(valuation?.ratios.pbr);
  const eps = describeMetric(data.perShare.eps);
  const bps = describeMetric(data.perShare.bps);
  const roe = describeMetric(data.perShare.roe);
  const priceCurrency = (quote?.currency ?? currency) as Currency;
  const money = (value: number | null) =>
    value === null ? '—' : formatPrice(value, data.perShare.currency === 'USD' ? 'USD' : 'KRW');
  return (
    <div>
      <h3>가치 지표 (직접 계산)</h3>
      <dl className="metric-grid">
        <div>
          <dt>EPS (TTM)</dt>
          <dd data-testid="eps">
            {money(eps.value)}
            <small>{eps.note || `공시일 ${data.perShare.eps.asOf ?? '—'}`}</small>
          </dd>
        </div>
        <div>
          <dt>BPS</dt>
          <dd data-testid="bps">
            {money(bps.value)}
            <small>{bps.note || `공시일 ${data.perShare.bps.asOf ?? '—'}`}</small>
          </dd>
        </div>
        <div>
          <dt>ROE (TTM)</dt>
          <dd data-testid="roe">
            {roe.value === null ? '—' : formatPercent(roe.value)}
            <small>{roe.note || `공시일 ${data.perShare.roe.asOf ?? '—'}`}</small>
          </dd>
        </div>
        <div>
          <dt>PER</dt>
          <dd>
            {per.value === null ? '—' : formatRatioTimes(per.value)}
            <small>
              {per.note ||
                `현재가 ${quote ? formatPrice(quote.lastPrice, priceCurrency) : '—'} ÷ EPS`}
            </small>
          </dd>
        </div>
        <div>
          <dt>PBR</dt>
          <dd>
            {pbr.value === null ? '—' : formatRatioTimes(pbr.value)}
            <small>
              {pbr.note ||
                `현재가 ${quote ? formatPrice(quote.lastPrice, priceCurrency) : '—'} ÷ BPS`}
            </small>
          </dd>
        </div>
      </dl>
      <p className="muted">
        출처: {data.source}(재무 공시) · 재무 조회 {kst(data.asOf)}
        {valuation ? ` · PER·PBR 계산 ${kst(valuation.computedAt)}(토스 현재가 사용)` : ''} · TTM은
        최근 4개 분기 합(또는 최근 연간)이며 EPS는 발행주식수 기준입니다. 공시가 없거나 적자이면 값
        대신 사유를 표시합니다.
      </p>

      <h3>재무제표</h3>
      <div className="segmented" role="group" aria-label="재무제표 기간">
        <button type="button" aria-pressed={kind === 'annual'} onClick={() => setKind('annual')}>
          연간
        </button>
        <button type="button" aria-pressed={kind === 'quarter'} onClick={() => setKind('quarter')}>
          분기
        </button>
      </div>
      {statements.length === 0 ? (
        <DataState
          issue={{
            kind: 'no-data',
            message: '이 기간 구분의 공시된 재무제표가 없습니다.',
            retryable: false,
          }}
          compact
        />
      ) : (
        <div className="table-scroll">
          <table data-testid="statements">
            <caption>
              단위: {statementUnit(currency)} · {data.source} · 분기 손익은 3개월 금액 ·
              순이익·자본은 지배기업 소유주 귀속
            </caption>
            <thead>
              <tr>
                <th scope="col">기간</th>
                <th scope="col">매출</th>
                <th scope="col">영업이익</th>
                <th scope="col">순이익</th>
                <th scope="col">자산</th>
                <th scope="col">부채</th>
                <th scope="col">자본</th>
                <th scope="col">공시일</th>
                <th scope="col">출처</th>
              </tr>
            </thead>
            <tbody>
              {statements.map((s) => (
                <tr key={`${s.fiscalYear}-${s.fiscalPeriod}-${s.scope}`}>
                  <th scope="row">
                    {periodName(s)}
                    {s.derived ? ' *' : ''}
                    {s.scope === 'separate' ? ' (별도)' : ''}
                  </th>
                  <td>{formatStatementAmount(s.revenue, s.currency)}</td>
                  <td>{formatStatementAmount(s.operatingIncome, s.currency)}</td>
                  <td>{formatStatementAmount(s.netIncome, s.currency)}</td>
                  <td>{formatStatementAmount(s.totalAssets, s.currency)}</td>
                  <td>{formatStatementAmount(s.totalLiabilities, s.currency)}</td>
                  <td>{formatStatementAmount(s.totalEquity, s.currency)}</td>
                  <td>{s.filedAt}</td>
                  <td>
                    <SourceLink url={s.sourceUrl} title={`${s.source} 공시 근거`}>
                      {s.source}
                    </SourceLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">
        * 4분기 등 직접 보고되지 않아 연간 − 누적으로 도출한 값. — 은 공시에 없는 항목입니다. 기간
        종료일은
        {statements.some((s) => s.periodEndAssumed)
          ? ' 일부 달력 기준으로 가정했습니다.'
          : ' 공시 기준입니다.'}
        {data.warnings.length > 0 && ` 어댑터 경고: ${data.warnings.slice(0, 3).join(' / ')}`}
      </p>

      <SectorComparison
        key={symbol}
        symbol={symbol}
        market={market}
        subject={{
          per: valuation?.ratios.per.value ?? null,
          pbr: valuation?.ratios.pbr.value ?? null,
        }}
      />
    </div>
  );
}

type PeerState =
  | { status: 'idle' }
  | { status: 'running'; done: number; total: number; phase: string }
  | { status: 'issue'; message: string }
  | { status: 'done'; peers: SectorPeers; rows: PeerRatios[]; asOf: string; computedAt: string };

const CONCURRENCY = 2;

function SectorComparison({
  symbol,
  market,
  subject,
}: {
  symbol: string;
  market: Market | null;
  subject: { per: number | null; pbr: number | null };
}) {
  const [state, setState] = useState<PeerState>({ status: 'idle' });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const start = async () => {
    if (!market) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const { signal } = controller;
    try {
      setState({ status: 'running', done: 0, total: 0, phase: '업종 찾는 중' });
      const peers = parseSectorPeers(
        await apiGet(
          `/api/analysis/sector-peers?symbol=${encodeURIComponent(symbol)}&market=${market}`,
          signal,
        ),
      );
      if (!peers.sector || peers.peers.length === 0) {
        setState({
          status: 'done',
          peers,
          rows: [],
          asOf: peers.asOf,
          computedAt: new Date().toISOString(),
        });
        return;
      }
      const symbols = peers.peers.map((p) => p.symbol);
      setState({ status: 'running', done: 0, total: symbols.length, phase: '비교군 현재가 조회' });
      const quotes = new Map<string, PriceQuote>();
      try {
        const body = await apiGet(
          `/api/market/prices?symbols=${encodeURIComponent(symbols.join(','))}`,
          signal,
        );
        for (const peer of symbols) {
          try {
            quotes.set(peer.toUpperCase(), parsePriceQuote(peer)(body));
          } catch {
            // A peer without a price is excluded with a reason below.
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      const rows: PeerRatios[] = new Array(peers.peers.length);
      let next = 0;
      let done = 0;
      let rateLimited = false;
      const worker = async () => {
        while (next < peers.peers.length && !signal.aborted) {
          const index = next++;
          const peer = peers.peers[index];
          const quote = quotes.get(peer.symbol.toUpperCase());
          const failed = (reason: string): PeerRatios => ({
            symbol: peer.symbol,
            name: peer.name,
            per: null,
            pbr: null,
            perReason: reason,
            pbrReason: reason,
          });
          let row = failed('FETCH_FAILED');
          if (rateLimited) row = failed('RATE_LIMITED');
          else if (!quote) row = failed('NO_PRICE');
          else {
            try {
              const f = parseFundamentals(
                await apiGet(
                  `/api/fundamentals?market=${market}&symbol=${encodeURIComponent(peer.symbol)}`,
                  signal,
                ),
              );
              const ratios = priceRatios(f.perShare, quote.lastPrice, quote.currency);
              row = {
                symbol: peer.symbol,
                name: peer.name,
                per: ratios.per.value,
                pbr: ratios.pbr.value,
                perReason: ratios.per.reason,
                pbrReason: ratios.pbr.reason,
              };
            } catch (error) {
              if (signal.aborted) return;
              if (error instanceof ApiError && error.status === 429) rateLimited = true;
              row = failed(rateLimited ? 'RATE_LIMITED' : 'FETCH_FAILED');
            }
          }
          rows[index] = row;
          done += 1;
          setState({ status: 'running', done, total: symbols.length, phase: '비교군 재무 계산' });
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (signal.aborted) return;
      setState({
        status: 'done',
        peers,
        rows,
        asOf: peers.asOf,
        computedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (signal.aborted) return;
      setState({ status: 'issue', message: issueOf(error).message });
    }
  };
  const comparison = useMemo(
    () => (state.status === 'done' ? compareSector(state.rows) : null),
    [state],
  );
  return (
    <section aria-label="업종 비교">
      <h3>같은 업종 비교</h3>
      <p className="muted">
        토스 섹터 분류(<code>/sectors</code>)에서 이 종목이 속한 가장 구체적인 업종을 찾고, 그
        업종의 시가총액 상위 종목(대상 종목 제외)의 PER·PBR 평균·중앙값을 같은 방식으로 계산합니다.
        종목마다 재무 공시를 조회하므로 버튼을 눌러 직접 실행합니다.
      </p>
      <div className="panel-actions">
        <button
          className="button"
          type="button"
          onClick={start}
          disabled={!market || state.status === 'running'}
        >
          {state.status === 'done' ? '업종 비교 다시 계산' : '업종 비교 계산'}
        </button>
        {state.status === 'running' && (
          <span className="muted" role="status" aria-live="polite">
            {state.phase}
            {state.total ? ` ${state.done}/${state.total}` : ''}…
          </span>
        )}
      </div>
      {state.status === 'running' && state.total > 0 && (
        <div className="progress" aria-hidden="true">
          <span style={{ width: `${Math.round((state.done / state.total) * 100)}%` }} />
        </div>
      )}
      {state.status === 'issue' && (
        <DataState
          issue={{ kind: 'error', message: state.message, retryable: false }}
          compact
          scope="업종 비교"
        />
      )}
      {state.status === 'done' && !state.peers.sector && (
        <DataState
          issue={{
            kind: 'no-data',
            message: `토스 섹터 분류에서 이 종목을 찾지 못했습니다(섹터 조회 ${state.peers.lookups}/${state.peers.lookupLimit}회${state.peers.lookupLimitReached ? ', 조회 상한 도달' : ''}).`,
            retryable: false,
          }}
          compact
          scope="업종 비교"
        />
      )}
      {state.status === 'done' && state.peers.sector && comparison && (
        <SectorResult state={state} comparison={comparison} subject={subject} />
      )}
    </section>
  );
}

function SectorResult({
  state,
  comparison,
  subject,
}: {
  state: Extract<PeerState, { status: 'done' }>;
  comparison: ReturnType<typeof compareSector>;
  subject: { per: number | null; pbr: number | null };
}) {
  const { peers, rows } = state;
  const sector = peers.sector!;
  const exclusion = (counts: Record<string, number>) =>
    Object.entries(counts)
      .map(([reason, count]) => `${reasonText(reason)} ${count}`)
      .join(', ') || '없음';
  const stat = (value: number | null) => (value === null ? '—' : formatRatioTimes(value));
  return (
    <div data-testid="sector-result">
      <p className="muted">
        업종: <strong>{sector.path.join(' › ')}</strong> · 토스 분류 구성 종목 {peers.memberCount}개
        중 시가총액 상위 {peers.peers.length}개를 비교군으로 사용
        {peers.peersTruncated ? `(조회 상한 ${peers.peerCap}개라 나머지는 제외)` : ''}. 조회{' '}
        {kst(state.asOf)} · 계산 {kst(state.computedAt)}.
        {peers.alsoIn.length > 0 &&
          ` 같은 깊이의 다른 업종: ${peers.alsoIn.map((a) => a.name).join(', ')}.`}
        {peers.lookupLimitReached && ' 섹터 조회 상한에 도달해 더 깊은 분류는 보지 못했습니다.'}
      </p>
      <div className="table-scroll">
        <table data-testid="sector-table">
          <caption>업종 평균은 값이 있는 비교군만의 단순 평균·중앙값입니다.</caption>
          <thead>
            <tr>
              <th scope="col">지표</th>
              <th scope="col">이 종목</th>
              <th scope="col">업종 평균</th>
              <th scope="col">업종 중앙값</th>
              <th scope="col">표본 수</th>
              <th scope="col">제외</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ['PER', subject.per, comparison.per, comparison.perExclusions],
                ['PBR', subject.pbr, comparison.pbr, comparison.pbrExclusions],
              ] as const
            ).map(([name, own, summary, reasons]) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td>{stat(own)}</td>
                <td>{stat(summary.mean)}</td>
                <td>{stat(summary.median)}</td>
                <td>
                  {summary.count} / {comparison.peers}
                </td>
                <td style={{ whiteSpace: 'normal', textAlign: 'left' }}>{exclusion(reasons)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details>
        <summary>비교군 {rows.length}개 종목별 값 보기</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">종목</th>
                <th scope="col">PER</th>
                <th scope="col">PBR</th>
                <th scope="col">사유</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.symbol}>
                  <th scope="row">
                    {row.name} {row.symbol}
                  </th>
                  <td>{row.per === null ? '—' : formatRatioTimes(row.per)}</td>
                  <td>{row.pbr === null ? '—' : formatRatioTimes(row.pbr)}</td>
                  <td style={{ whiteSpace: 'normal', textAlign: 'left' }}>
                    {[
                      row.per === null ? `PER: ${reasonText(row.perReason)}` : '',
                      row.pbr === null ? `PBR: ${reasonText(row.pbrReason)}` : '',
                    ]
                      .filter(Boolean)
                      .join(' / ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** Fundamentals for the page: loaded once per symbol (the header and this tab share it). */
export function useFundamentals(market: Market | null, symbol: string) {
  return useApiResource(
    market ? `/api/fundamentals?market=${market}&symbol=${encodeURIComponent(symbol)}` : null,
    parseFundamentals,
  );
}
