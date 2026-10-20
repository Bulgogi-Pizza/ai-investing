import { useState, type ReactNode } from 'react';
import { DataState, LoadingState } from '../../components/DataState';
import { useApiResource, type Resource } from '../../lib/api';
import { formatCount, formatPercent, formatSignedCount } from '../../lib/format';
import { formatKst } from '../../lib/kst';
import type { Market } from '../../lib/analysis';
import {
  parseCreditTrades,
  parseInvestorTrading,
  parseProgramTrades,
  parseShortSelling,
} from './parsers';

const kst = (value: string) => `${formatKst(value)} KST`;
const sign = (value: string | null | undefined) =>
  value === null || value === undefined
    ? ''
    : Number(value) > 0
      ? 'num-up'
      : Number(value) < 0
        ? 'num-down'
        : '';
const rate = (value: string | null) => (value === null ? '–' : formatPercent(Number(value)));

const views = [
  { id: 'investor-trading', label: '투자자 동향' },
  { id: 'short-selling', label: '공매도' },
  { id: 'credit-trades', label: '신용거래' },
  { id: 'program-trades', label: '프로그램매매' },
] as const;
type View = (typeof views)[number]['id'];

/** 수급 tab. Toss provides these for Korean stocks only. */
export function FlowPanel({ symbol, market }: { symbol: string; market: Market | null }) {
  const [view, setView] = useState<View>('investor-trading');
  if (market === 'US')
    return (
      <DataState
        issue={{
          kind: 'no-data',
          message:
            '미국 종목은 토스가 제공하지 않습니다. 투자자 동향·공매도·신용·프로그램매매는 국내 종목만 조회할 수 있습니다.',
          retryable: false,
        }}
        title="수급 정보 없음"
      />
    );
  if (market === null) return <LoadingState label="종목 시장을 확인하는 중…" />;
  return (
    <div>
      <div className="segmented" role="group" aria-label="수급 데이터 종류">
        {views.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={view === item.id}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {view === 'investor-trading' && <Investor symbol={symbol} />}
      {view === 'short-selling' && <Short symbol={symbol} />}
      {view === 'credit-trades' && <Credit symbol={symbol} />}
      {view === 'program-trades' && <Program symbol={symbol} />}
    </div>
  );
}

const url = (kind: View, symbol: string) =>
  `/api/analysis/${kind}?symbol=${encodeURIComponent(symbol)}&count=10`;

function Block<T extends { asOf: string }>({
  resource,
  retry,
  title,
  note,
  children,
}: {
  resource: Resource<T>;
  retry: () => void;
  title: string;
  note: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === 'loading' || resource.status === 'idle')
    return <LoadingState label={`${title}을(를) 불러오는 중…`} />;
  if (resource.status === 'issue')
    return <DataState issue={resource.issue} onRetry={retry} scope={title} />;
  return (
    <>
      <div className="table-scroll">{children(resource.data)}</div>
      <p className="muted">
        출처: 토스증권 Open API · 조회 {kst(resource.data.asOf)} · {note}
      </p>
    </>
  );
}

function Investor({ symbol }: { symbol: string }) {
  const { state, retry } = useApiResource(url('investor-trading', symbol), parseInvestorTrading);
  return (
    <Block
      resource={state}
      retry={retry}
      title="투자자별 매매동향"
      note="순매수 거래량(주) = 매수 − 매도, 음수는 순매도. KRX·NXT 통합, 외국인은 등록외국인 기준. 당일은 장중 잠정치이며 개인·기타법인·외국인 보유율은 잠정치가 없으면 –로 표시합니다. 거래대금(금액)은 제공되지 않습니다."
    >
      {(data) => (
        <table data-testid="flow-investor">
          <caption>투자자별 순매수 거래량(주), 최근 {data.rows.length}거래일</caption>
          <thead>
            <tr>
              <th scope="col">날짜</th>
              <th scope="col">외국인</th>
              <th scope="col">기관</th>
              <th scope="col">개인</th>
              <th scope="col">기타법인</th>
              <th scope="col">외국인 보유율</th>
              <th scope="col">갱신</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.date}>
                <th scope="row">{row.date}</th>
                <td className={sign(row.foreigner.netBuyVolume)}>
                  {formatSignedCount(row.foreigner.netBuyVolume)}
                </td>
                <td className={sign(row.institution.netBuyVolume)}>
                  {formatSignedCount(row.institution.netBuyVolume)}
                </td>
                <td className={sign(row.individual?.netBuyVolume)}>
                  {formatSignedCount(row.individual?.netBuyVolume)}
                </td>
                <td className={sign(row.otherCorporation?.netBuyVolume)}>
                  {formatSignedCount(row.otherCorporation?.netBuyVolume)}
                </td>
                <td>{rate(row.foreignerHoldingRate)}</td>
                <td>{kst(row.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Block>
  );
}

function Short({ symbol }: { symbol: string }) {
  const { state, retry } = useApiResource(url('short-selling', symbol), parseShortSelling);
  return (
    <Block
      resource={state}
      retry={retry}
      title="공매도 동향"
      note="일별 확정치는 해당 일자 저녁에 반영됩니다. 비중의 분모는 시간외·애프터마켓을 포함한 당일 누적 거래량·거래대금이며, 분모 데이터가 없는 날은 –입니다. 금액은 원화입니다."
    >
      {(data) => (
        <table data-testid="flow-short">
          <caption>공매도 거래 (최근 {data.rows.length}거래일)</caption>
          <thead>
            <tr>
              <th scope="col">날짜</th>
              <th scope="col">공매도 거래량(주)</th>
              <th scope="col">공매도 거래대금(원)</th>
              <th scope="col">거래량 비중</th>
              <th scope="col">거래대금 비중</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.date}>
                <th scope="row">{row.date}</th>
                <td>{formatCount(row.shortSellingVolume)}</td>
                <td>{formatCount(row.shortSellingAmount)}</td>
                <td>{rate(row.shortSellingVolumeRate)}</td>
                <td>{rate(row.shortSellingAmountRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Block>
  );
}

function Credit({ symbol }: { symbol: string }) {
  const { state, retry } = useApiResource(url('credit-trades', symbol), parseCreditTrades);
  return (
    <Block
      resource={state}
      retry={retry}
      title="신용거래 동향"
      note="다음 영업일 새벽에 반영되므로 최신 기록은 전 영업일입니다. 자기신용과 유통금융 합산, 수량은 주 단위입니다. 융자·대주 중 한쪽만 있는 날은 없는 쪽을 –로 표시합니다. 대주는 개인 신용대주이며 기관 대차거래와 다른 데이터입니다."
    >
      {(data) => (
        <table data-testid="flow-credit">
          <caption>신용융자·신용대주 (최근 {data.rows.length}거래일)</caption>
          <thead>
            <tr>
              <th scope="col">날짜</th>
              <th scope="col">융자 신규</th>
              <th scope="col">융자 상환</th>
              <th scope="col">융자 잔고</th>
              <th scope="col">융자 잔고율</th>
              <th scope="col">융자 공여율</th>
              <th scope="col">대주 잔고</th>
              <th scope="col">대주 잔고율</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.date}>
                <th scope="row">{row.date}</th>
                <td>{formatCount(row.marginLoan?.newQuantity)}</td>
                <td>{formatCount(row.marginLoan?.returnQuantity)}</td>
                <td>{formatCount(row.marginLoan?.balanceQuantity)}</td>
                <td>{row.marginLoan ? rate(row.marginLoan.balanceRate) : '–'}</td>
                <td>{row.marginLoan ? rate(row.marginLoan.tradingRate) : '–'}</td>
                <td>{formatCount(row.stockLoan?.balanceQuantity)}</td>
                <td>{row.stockLoan ? rate(row.stockLoan.balanceRate) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Block>
  );
}

function Program({ symbol }: { symbol: string }) {
  const { state, retry } = useApiResource(url('program-trades', symbol), parseProgramTrades);
  return (
    <Block
      resource={state}
      retry={retry}
      title="프로그램매매 동향"
      note="KRX 시장 거래만 집계하며 NXT는 포함하지 않습니다. 당일 기록은 장 종료 전까지 갱신될 수 있고, 순매수(주) = 매수 − 매도입니다."
    >
      {(data) => (
        <table data-testid="flow-program">
          <caption>프로그램매매 (최근 {data.rows.length}거래일)</caption>
          <thead>
            <tr>
              <th scope="col">날짜</th>
              <th scope="col">차익 매수</th>
              <th scope="col">차익 매도</th>
              <th scope="col">차익 순매수</th>
              <th scope="col">비차익 매수</th>
              <th scope="col">비차익 매도</th>
              <th scope="col">비차익 순매수</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.date}>
                <th scope="row">{row.date}</th>
                <td>{formatCount(row.arbitrage.buyVolume)}</td>
                <td>{formatCount(row.arbitrage.sellVolume)}</td>
                <td className={sign(row.arbitrage.netBuyVolume)}>
                  {formatSignedCount(row.arbitrage.netBuyVolume)}
                </td>
                <td>{formatCount(row.nonArbitrage.buyVolume)}</td>
                <td>{formatCount(row.nonArbitrage.sellVolume)}</td>
                <td className={sign(row.nonArbitrage.netBuyVolume)}>
                  {formatSignedCount(row.nonArbitrage.netBuyVolume)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Block>
  );
}
