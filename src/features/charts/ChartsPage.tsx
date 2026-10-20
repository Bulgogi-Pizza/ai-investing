import { useEffect, useMemo, useState } from 'react';
import { Bell, Check, CircleHelp, Plus, Sparkles, Star } from 'lucide-react';
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
import {
  bollinger,
  chartWindowLength,
  formatChartPrice,
  normalizeComparison,
  demoPrices,
  ema,
  macd,
  rsi,
  sma,
} from '../../lib/market';
export default function ChartsPage({ initialSymbol }: { initialSymbol: string }) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [compare, setCompare] = useState(false);
  const [indicators, setIndicators] = useState(['SMA']);
  const [buy, setBuy] = useState(76000);
  const [sell, setSell] = useState(88000);
  const [watch, setWatch] = useState(['삼성전자', 'Apple']);
  const [period, setPeriod] = useState('3개월');
  const [oscillator, setOscillator] = useState('RSI');
  const [priceAlert, setPriceAlert] = useState(false);
  const [live, setLive] = useState(false);
  const [liveRows, setLiveRows] = useState<{ date: string; close: number; compare: number }[]>([]);
  const [liveSource, setLiveSource] = useState('');
  const [liveError, setLiveError] = useState('');
  const [liveLoading, setLiveLoading] = useState(false);
  useEffect(() => {
    setLiveRows([]);
    setLiveError('');
    if (!live) return;
    const controller = new AbortController();
    setLiveLoading(true);
    setCompare(false);
    const code = symbol === '삼성전자' ? '005930' : symbol === 'SK하이닉스' ? '000660' : 'AAPL';
    fetch(`/api/market/candles?symbol=${code}&interval=1d&count=100`, { signal: controller.signal })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error?.message ?? '시세를 불러오지 못했습니다.');
        if (
          !Array.isArray(d.candles) ||
          !d.candles.length ||
          !d.source ||
          !Number.isFinite(Date.parse(d.asOf))
        )
          throw new Error('검증 가능한 시세 데이터가 없습니다.');
        const rows = d.candles.map((c: { timestamp: string; close: string }) => {
          const close = Number(c.close);
          if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(Date.parse(c.timestamp)))
            throw new Error('시세 데이터 형식이 올바르지 않습니다.');
          return {
            date: new Date(c.timestamp).toLocaleDateString('ko-KR', {
              timeZone: 'Asia/Seoul',
              month: '2-digit',
              day: '2-digit',
            }),
            close,
            compare: 0,
          };
        });
        if (!controller.signal.aborted) {
          setLiveRows(rows);
          setLiveSource(
            `${d.source} · 조회 ${new Date(d.asOf).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST`,
          );
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setLiveError(e instanceof Error ? e.message : '시세 연결 실패');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLiveLoading(false);
      });
    return () => controller.abort();
  }, [live, symbol]);
  const data = useMemo(() => {
    const factor = symbol === '삼성전자' ? 1 : symbol === 'SK하이닉스' ? 2.4 : 0.003;
    const sourceRows = live ? liveRows : demoPrices;
    const prices = sourceRows.map((p) => p.close * (live ? 1 : factor));
    const s = sma(prices, 20),
      e = ema(prices, 20),
      b = bollinger(prices),
      r = rsi(prices),
      m = macd(prices);
    const visible = sourceRows
      .map((p, i) => ({
        ...p,
        close: prices[i],
        sma: s[i],
        ema: e[i],
        upper: b[i].upper,
        lower: b[i].lower,
        rsi: r[i],
        macd: m[i].macd,
      }))
      .slice(-chartWindowLength(period));
    return compare ? normalizeComparison(visible) : visible;
  }, [symbol, compare, period, live, liveRows]);
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
          <span className="demo-pill">{live ? '토스 API 연결 모드' : '합성 데이터 · 학습용'}</span>
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
                onChange={(e) => setSymbol(e.target.value)}
              >
                {['삼성전자', 'SK하이닉스', 'Apple'].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
              <small>
                {symbol === '삼성전자'
                  ? '005930 · KOSPI'
                  : symbol === 'SK하이닉스'
                    ? '000660 · KOSPI'
                    : 'AAPL · NASDAQ'}{' '}
                · {live ? 'API 조회' : '데모'}
              </small>
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
        <div className="chart-price">
          {data.length
            ? formatChartPrice(
                data[data.length - 1].close,
                compare ? 'INDEX' : symbol === 'Apple' ? 'USD' : 'KRW',
              )
            : '—'}
          <span>{compare ? '기준 100' : symbol === 'Apple' ? 'USD' : '원'}</span>
          <small>{live ? '일봉 종가 · 조회 시점 기준' : '합성 예시 가격'}</small>
        </div>
        <div className="chart-source-switch">
          <button
            className={`button small ${!live ? 'toggled' : ''}`}
            onClick={() => setLive(false)}
          >
            합성 데모
          </button>
          <button className={`button small ${live ? 'toggled' : ''}`} onClick={() => setLive(true)}>
            토스 API 시세 연결
          </button>
          <span>실제 데이터는 로그인과 API 설정이 필요합니다.</span>
        </div>
        {liveLoading && (
          <div className="data-notice" role="status">
            시세를 불러오는 중…
          </div>
        )}
        {liveError && (
          <div className="form-error" role="alert">
            {liveError} 합성 데모 탭에서 기능을 확인할 수 있습니다.
          </div>
        )}
        <p className="subtle">
          기간은 약 5/21/63거래일 기준입니다. 휴장일과 수신 데이터 수에 따라 실제 날짜 범위가 달라질
          수 있습니다.
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
          <button
            className={`button small ${compare ? 'toggled' : ''}`}
            disabled={live}
            onClick={() => setCompare(!compare)}
          >
            <Plus size={14} /> KOSPI 비교 {compare && <Check size={13} />}
          </button>
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
              <Line dataKey="close" name={symbol} stroke="#7460df" strokeWidth={2.5} dot={false} />
              {compare && (
                <Line dataKey="compare" name="KOSPI 합성 비교" stroke="#24a895" dot={false} />
              )}{' '}
              {indicators.includes('SMA') && (
                <Line dataKey="sma" name="SMA 20" stroke="#e3a64d" dot={false} strokeWidth={1.4} />
              )}{' '}
              {indicators.includes('EMA') && (
                <Line dataKey="ema" name="EMA 20" stroke="#68a8d4" dot={false} />
              )}{' '}
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
              {!live && !compare && symbol === '삼성전자' && (
                <>
                  <ReferenceLine
                    y={buy}
                    label="매수 검토선"
                    stroke="#26a18b"
                    strokeDasharray="5 5"
                  />
                  <ReferenceLine
                    y={sell}
                    label="매도 검토선"
                    stroke="#ef7b7e"
                    strokeDasharray="5 5"
                  />
                </>
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
          <span>{oscillator === 'RSI' ? '14기간 · 단순 평균 방식' : '12 / 26기간 EMA 차이'}</span>
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
          {live
            ? liveRows.length
              ? `출처: ${liveSource} · 자동 갱신 아님 · 조정주가 일봉`
              : '실제 시세 미연결 · 가격 표시 없음'
            : '출처: Folio 결정적 합성 시계열 · 실제 종목 가격 아님 · 2026.10.20 기준 화면 예시'}
        </div>
      </section>
      <div className="bottom-grid">
        <section className="detail-card">
          <div className="card-heading">
            <h3>내 매매 기준선</h3>
            <span className="subtle">삼성전자 데모 차트에 표시</span>
          </div>
          <div className="line-inputs">
            <label>
              <span className="positive">매수 검토선</span>
              <input
                aria-label="매수 검토선"
                type="number"
                min="0"
                value={buy}
                onChange={(e) => setBuy(Number(e.target.value))}
              />
            </label>
            <label>
              <span className="text-red">매도 검토선</span>
              <input
                aria-label="매도 검토선"
                type="number"
                min="0"
                value={sell}
                onChange={(e) => setSell(Number(e.target.value))}
              />
            </label>
          </div>
          {buy >= sell && (
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
              관심종목 {watch.length}개 · 비교 차트는 시작점을 100으로 정규화합니다. 가격 기준선은
              원화 모드의 삼성전자에서 확인하세요.
            </span>
          </div>
        </section>
      </div>
    </>
  );
}
