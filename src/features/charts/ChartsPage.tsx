import { useMemo, useState } from 'react';
import { Bell, Check, CircleHelp, Sparkles, Star } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { DataState, LoadingState } from '../../components/DataState';
import { ApiError, NoDataError, useApiResource } from '../../lib/api';
import { formatKst } from '../../lib/kst';
import {
  bollinger,
  chartWindowLength,
  formatChartPrice,
  ema,
  macd,
  rsi,
  sma,
} from '../../lib/market';

const symbols = [
  { label: '삼성전자', code: '005930', venue: '005930 · KOSPI' },
  { label: 'SK하이닉스', code: '000660', venue: '000660 · KOSPI' },
  { label: 'Apple', code: 'AAPL', venue: 'AAPL · NASDAQ' },
] as const;
type Candles = {
  source: string;
  asOf: string;
  currency: 'KRW' | 'USD';
  rows: { date: string; close: number }[];
};
export function parseCandles(body: unknown): Candles {
  const d = body as {
    source?: unknown;
    asOf?: unknown;
    candles?: { timestamp: string; close: string; currency?: string }[];
  };
  if (!d || typeof d.source !== 'string' || !Number.isFinite(Date.parse(String(d.asOf))))
    throw new ApiError(502, 'INVALID_RESPONSE', '시세 응답 형식을 확인하지 못했습니다.');
  if (!Array.isArray(d.candles))
    throw new ApiError(502, 'INVALID_RESPONSE', '시세 응답 형식을 확인하지 못했습니다.');
  if (!d.candles.length) throw new NoDataError('이 종목에 대해 제공자가 돌려준 일봉이 없습니다.');
  const rows = d.candles.map((c) => {
    const close = Number(c.close);
    if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(Date.parse(c.timestamp)))
      throw new ApiError(502, 'INVALID_RESPONSE', '시세 데이터 형식이 올바르지 않습니다.');
    return {
      date: new Date(c.timestamp).toLocaleDateString('ko-KR', {
        timeZone: 'Asia/Seoul',
        month: '2-digit',
        day: '2-digit',
      }),
      close,
    };
  });
  const currency = d.candles.at(-1)?.currency === 'USD' ? 'USD' : 'KRW';
  return { source: d.source, asOf: String(d.asOf), currency, rows };
}
export default function ChartsPage({ initialSymbol }: { initialSymbol: string }) {
  const [symbol, setSymbol] = useState(
    symbols.some((s) => s.label === initialSymbol) ? initialSymbol : symbols[0].label,
  );
  const [indicators, setIndicators] = useState(['SMA']);
  const [buy, setBuy] = useState('');
  const [sell, setSell] = useState('');
  const [watch, setWatch] = useState(['삼성전자', 'Apple']);
  const [period, setPeriod] = useState('3개월');
  const [oscillator, setOscillator] = useState('RSI');
  const [priceAlert, setPriceAlert] = useState(false);
  const current = symbols.find((s) => s.label === symbol) ?? symbols[0];
  const { state, retry } = useApiResource(
    `/api/market/candles?symbol=${encodeURIComponent(current.code)}&interval=1d&count=100`,
    parseCandles,
  );
  const data = useMemo(() => {
    if (state.status !== 'ready') return [];
    const prices = state.data.rows.map((p) => p.close);
    const s = sma(prices, 20),
      e = ema(prices, 20),
      b = bollinger(prices),
      r = rsi(prices),
      m = macd(prices);
    return state.data.rows
      .map((p, i) => ({
        ...p,
        sma: s[i],
        ema: e[i],
        upper: b[i].upper,
        lower: b[i].lower,
        rsi: r[i],
        macd: m[i].macd,
      }))
      .slice(-chartWindowLength(period));
  }, [state, period]);
  const buyLine = Number(buy) > 0 ? Number(buy) : null;
  const sellLine = Number(sell) > 0 ? Number(sell) : null;
  const ready = state.status === 'ready' ? state.data : null;
  return (
    <>
      <div className="page-heading">
        <div className="eyebrow">TECHNICAL ANALYSIS</div>
        <div className="title-row">
          <div>
            <h1>
              차트 분석
              <span className="title-dot" />
            </h1>
            <p>가격의 흐름과 지표를 함께 읽고, 나만의 기준을 세워보세요.</p>
          </div>
        </div>
      </div>
      <section className="chart-panel">
        <div className="chart-header">
          <div className="chart-symbol">
            <span className="stock-icon samsung">{symbol[0]}</span>
            <div>
              <select
                aria-label="종목 선택"
                value={symbol}
                onChange={(e) => {
                  setSymbol(e.target.value);
                  setBuy('');
                  setSell('');
                }}
              >
                {symbols.map((s) => (
                  <option key={s.code}>{s.label}</option>
                ))}
              </select>
              <small>{current.venue} · 토스 API 조회</small>
            </div>
          </div>
          <button
            className="button"
            onClick={() =>
              setWatch((v) => (v.includes(symbol) ? v.filter((s) => s !== symbol) : [...v, symbol]))
            }
          >
            <Star size={15} fill={watch.includes(symbol) ? 'currentColor' : 'none'} />
            {watch.includes(symbol) ? '관심종목 해제' : '관심종목 추가'}
          </button>
        </div>
        {state.status === 'loading' && <LoadingState label="시세를 불러오는 중…" />}
        {state.status === 'issue' && <DataState issue={state.issue} onRetry={retry} />}
        {ready && (
          <>
            <div className="chart-price">
              {data.length ? formatChartPrice(data[data.length - 1].close, ready.currency) : '—'}
              <span>{ready.currency === 'USD' ? 'USD' : '원'}</span>
              <small>일봉 종가 · 조회 시점 기준</small>
            </div>
            <p className="subtle">
              기간은 약 5/21/63거래일 기준입니다. 휴장일과 수신 데이터 수에 따라 실제 날짜 범위가
              달라질 수 있습니다.
            </p>
            <div className="chart-controls">
              <div className="view-toggle">
                {['1주', '1개월', '3개월'].map((p) => (
                  <button
                    key={p}
                    className={period === p ? 'selected' : ''}
                    onClick={() => setPeriod(p)}
                  >
                    {p}
                  </button>
                ))}
              </div>
              {['SMA', 'EMA', 'Bollinger'].map((i) => (
                <button
                  key={i}
                  className={`indicator-button ${indicators.includes(i) ? 'enabled' : ''}`}
                  onClick={() =>
                    setIndicators((v) => (v.includes(i) ? v.filter((s) => s !== i) : [...v, i]))
                  }
                >
                  {i === 'Bollinger' ? '볼린저 밴드' : i + ' 20'}
                </button>
              ))}
            </div>
            <div className="chart-canvas">
              <ResponsiveContainer width="100%" height={330}>
                <LineChart data={data} margin={{ top: 20, right: 20, left: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 5" vertical={false} stroke="#eef0f4" />
                  <XAxis
                    dataKey="date"
                    minTickGap={45}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11, fill: '#9299a6' }}
                  />
                  <YAxis
                    domain={['auto', 'auto']}
                    orientation="right"
                    width={70}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11, fill: '#9299a6' }}
                  />
                  <Tooltip
                    contentStyle={{ borderRadius: 10, border: '1px solid #e9eaf0', fontSize: 12 }}
                  />
                  <Line
                    dataKey="close"
                    name={symbol}
                    stroke="#7460df"
                    strokeWidth={2.5}
                    dot={false}
                  />
                  {indicators.includes('SMA') && (
                    <Line
                      dataKey="sma"
                      name="SMA 20"
                      stroke="#e3a64d"
                      dot={false}
                      strokeWidth={1.4}
                    />
                  )}
                  {indicators.includes('EMA') && (
                    <Line dataKey="ema" name="EMA 20" stroke="#68a8d4" dot={false} />
                  )}
                  {indicators.includes('Bollinger') && (
                    <>
                      <Line
                        dataKey="upper"
                        name="상단 밴드"
                        stroke="#a7b7ca"
                        dot={false}
                        strokeDasharray="4 4"
                      />
                      <Line
                        dataKey="lower"
                        name="하단 밴드"
                        stroke="#a7b7ca"
                        dot={false}
                        strokeDasharray="4 4"
                      />
                    </>
                  )}
                  {buyLine !== null && (
                    <ReferenceLine
                      y={buyLine}
                      label="매수 검토선"
                      stroke="#26a18b"
                      strokeDasharray="5 5"
                    />
                  )}
                  {sellLine !== null && (
                    <ReferenceLine
                      y={sellLine}
                      label="매도 검토선"
                      stroke="#ef7b7e"
                      strokeDasharray="5 5"
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="oscillator-heading">
              <div className="view-toggle">
                {['RSI', 'MACD'].map((i) => (
                  <button
                    key={i}
                    className={oscillator === i ? 'selected' : ''}
                    onClick={() => setOscillator(i)}
                  >
                    {i}
                  </button>
                ))}
              </div>
              <span>
                {oscillator === 'RSI' ? '14기간 · 단순 평균 방식' : '12 / 26기간 EMA 차이'}
              </span>
            </div>
            <ResponsiveContainer width="100%" height={110}>
              <LineChart data={data}>
                <YAxis
                  width={45}
                  domain={oscillator === 'RSI' ? [0, 100] : ['auto', 'auto']}
                  tick={{ fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip />
                <Line
                  dataKey={oscillator === 'RSI' ? 'rsi' : 'macd'}
                  dot={false}
                  stroke="#a08be2"
                  strokeWidth={1.5}
                />
                {oscillator === 'RSI' && (
                  <>
                    <ReferenceLine y={70} stroke="#f2d8dd" strokeDasharray="3 3" />
                    <ReferenceLine y={30} stroke="#d4e9e4" strokeDasharray="3 3" />
                  </>
                )}
              </LineChart>
            </ResponsiveContainer>
            <div className="chart-footnote">
              출처: {ready.source} · 조회 {formatKst(ready.asOf)} KST · 자동 갱신 아님 · 조정주가
              일봉
            </div>
          </>
        )}
      </section>
      <div className="bottom-grid">
        <section className="detail-card">
          <div className="card-heading">
            <h3>내 매매 기준선</h3>
            <span className="subtle">선택한 종목 차트에만 표시 · 종목을 바꾸면 초기화</span>
          </div>
          <div className="line-inputs">
            <label>
              <span className="positive">매수 검토선</span>
              <input
                aria-label="매수 검토선"
                type="number"
                min="0"
                value={buy}
                onChange={(e) => setBuy(e.target.value)}
              />
            </label>
            <label>
              <span className="text-red">매도 검토선</span>
              <input
                aria-label="매도 검토선"
                type="number"
                min="0"
                value={sell}
                onChange={(e) => setSell(e.target.value)}
              />
            </label>
          </div>
          {buyLine !== null && sellLine !== null && buyLine >= sellLine && (
            <p className="form-error">매수 검토선은 매도 검토선보다 낮게 설정하세요.</p>
          )}
          <p className="subtle">사용자가 직접 설정한 참고선입니다. 투자 권유나 주문이 아닙니다.</p>
          <button className="button small" onClick={() => setPriceAlert(!priceAlert)}>
            <Bell size={14} />
            {priceAlert ? '알림 메모 해제' : '이 가격 기준 메모'}
            {priceAlert && <Check size={13} />}
          </button>
          {priceAlert && (
            <p className="subtle">
              현재 세션에 기준 메모를 추가했습니다. 외부 가격 알림은 연결 전입니다.
            </p>
          )}
        </section>
        <section className="impact-card">
          <div className="card-heading">
            <h3>분석 노트</h3>
            <Sparkles size={18} />
          </div>
          <p>
            SMA는 평균적인 추세, RSI는 가격 변화의 강도를 보여줍니다. 지표는 과거 가격을 바탕으로
            계산되며 미래 수익을 보장하지 않습니다.
          </p>
          <div className="impact-disclaimer">
            <CircleHelp size={13} />
            <span>
              관심종목 {watch.length}개 · 기준선은 선택한 종목의 통화 단위로 직접 입력하세요.
            </span>
          </div>
        </section>
      </div>
    </>
  );
}
