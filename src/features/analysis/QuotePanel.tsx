import { RefreshCw } from 'lucide-react';
import { DataState, LoadingState } from '../../components/DataState';
import { useApiResource } from '../../lib/api';
import { formatCount, formatPrice } from '../../lib/format';
import { formatKst } from '../../lib/kst';
import { parseOrderbook, parseTrades, type Orderbook } from './parsers';

const kst = (value: string) => `${formatKst(value)} KST`;
const clock = (value: string) =>
  new Date(value).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });

/**
 * 호가·체결 tab: one snapshot when the tab opens and again only when the button is pressed.
 * There is no polling loop; the provider's own streaming API is not used here.
 */
export function QuotePanel({ symbol }: { symbol: string }) {
  const book = useApiResource(
    `/api/analysis/orderbook?symbol=${encodeURIComponent(symbol)}`,
    parseOrderbook,
  );
  const trades = useApiResource(
    `/api/analysis/trades?symbol=${encodeURIComponent(symbol)}&count=20`,
    parseTrades,
  );
  const busy = book.state.status === 'loading' || trades.state.status === 'loading';
  const refresh = () => {
    book.retry();
    trades.retry();
  };
  return (
    <div>
      <div className="panel-actions">
        <button className="button" type="button" onClick={refresh} disabled={busy}>
          <RefreshCw size={14} aria-hidden="true" /> 새로 고침
        </button>
        <span className="muted" aria-live="polite">
          스냅샷입니다. 자동으로 갱신하지 않으며 버튼을 누를 때마다 다시 조회합니다.
        </span>
      </div>
      <div className="two-col">
        <section aria-label="호가">
          <h3>호가</h3>
          {(book.state.status === 'loading' || book.state.status === 'idle') && (
            <LoadingState label="호가를 불러오는 중…" compact />
          )}
          {book.state.status === 'issue' && (
            <DataState issue={book.state.issue} onRetry={book.retry} scope="호가" compact />
          )}
          {book.state.status === 'ready' && <Book data={book.state.data} />}
        </section>
        <section aria-label="최근 체결">
          <h3>최근 체결 (당일)</h3>
          {(trades.state.status === 'loading' || trades.state.status === 'idle') && (
            <LoadingState label="체결 내역을 불러오는 중…" compact />
          )}
          {trades.state.status === 'issue' && (
            <DataState issue={trades.state.issue} onRetry={trades.retry} scope="체결" compact />
          )}
          {trades.state.status === 'ready' && (
            <>
              <div className="table-scroll">
                <table data-testid="trades">
                  <caption>최근 {trades.state.data.trades.length}건, 제공자 순서(최신순)</caption>
                  <thead>
                    <tr>
                      <th scope="col">체결 시각(KST)</th>
                      <th scope="col">체결가</th>
                      <th scope="col">수량(주)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.state.data.trades.map((trade, index) => (
                      <tr key={`${trade.timestamp}-${index}`}>
                        <th scope="row">{clock(trade.timestamp)}</th>
                        <td>{formatPrice(trade.price, trade.currency)}</td>
                        <td>{formatCount(trade.volume)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted">
                출처: 토스증권 Open API <code>/trades</code> · 조회 {kst(trades.state.data.asOf)}.
                체결 방향(매수·매도)은 제공되지 않습니다.
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function Book({ data }: { data: Orderbook }) {
  const asks = [...data.asks].sort((a, b) => Number(b.price) - Number(a.price));
  const bids = [...data.bids].sort((a, b) => Number(b.price) - Number(a.price));
  const maxVolume = Math.max(
    1,
    ...data.asks.map((l) => Number(l.volume)),
    ...data.bids.map((l) => Number(l.volume)),
  );
  const bestAsk = data.asks.length ? Math.min(...data.asks.map((l) => Number(l.price))) : null;
  const bestBid = data.bids.length ? Math.max(...data.bids.map((l) => Number(l.price))) : null;
  const row = (side: 'ask' | 'bid', level: { price: string; volume: string }) => (
    <tr key={`${side}-${level.price}`}>
      <th scope="row">{side === 'ask' ? '매도' : '매수'}</th>
      <td>{formatPrice(level.price, data.currency)}</td>
      <td className={`depth-bar ${side}`}>
        <span
          style={{ width: `${(Number(level.volume) / maxVolume) * 100}%` }}
          aria-hidden="true"
        />
        {formatCount(level.volume)}
      </td>
    </tr>
  );
  return (
    <>
      <div className="table-scroll">
        <table data-testid="orderbook">
          <caption>
            데이터 시각 {data.timestamp ? kst(data.timestamp) : '미제공'} · 위가 높은 가격
          </caption>
          <thead>
            <tr>
              <th scope="col">구분</th>
              <th scope="col">호가</th>
              <th scope="col">잔량(주)</th>
            </tr>
          </thead>
          <tbody>
            {asks.map((level) => row('ask', level))}
            {bids.map((level) => row('bid', level))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        출처: 토스증권 Open API <code>/orderbook</code> · 조회 {kst(data.asOf)}
        {bestAsk !== null && bestBid !== null
          ? ` · 최우선 매도호가 − 최우선 매수호가 = ${formatPrice(bestAsk - bestBid, data.currency)}(계산)`
          : ''}
        .
      </p>
    </>
  );
}
