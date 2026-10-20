export type IndicatorId =
  | 'sma'
  | 'ema'
  | 'bollinger'
  | 'rsi'
  | 'macd'
  | 'ichimoku'
  | 'vwap'
  | 'stochastic'
  | 'atr'
  | 'obv'
  | 'parabolicSar'
  | 'adx'
  | 'cci'
  | 'keltner'
  | 'fibonacci';

export type IndicatorDescription = {
  id: IndicatorId;
  /** Korean display name. */
  name: string;
  /** 'price': drawn over the price pane; 'separate': drawn in its own pane below the price. */
  pane: 'price' | 'separate';
  /** Default parameters as shown next to the name. */
  defaultParams: string;
  /** Text for the ⓘ tooltip: what it computes and how it is commonly read (2-3 sentences). */
  tooltip: string;
};

/** Display order: existing indicators first, then the additional ones. */
export const indicatorDescriptions: Record<IndicatorId, IndicatorDescription> = {
  sma: {
    id: 'sma',
    name: '단순 이동평균(SMA)',
    pane: 'price',
    defaultParams: '기간 20',
    tooltip:
      '최근 일정 기간 종가의 산술 평균을 이어 그린 선입니다. 가격이 평균선 위에 있는지 아래에 있는지로 추세의 방향을 가늠하는 데 쓰이며, 기간이 길수록 선이 완만해지고 반응이 느려집니다.',
  },
  ema: {
    id: 'ema',
    name: '지수 이동평균(EMA)',
    pane: 'price',
    defaultParams: '기간 20',
    tooltip:
      '최근 가격에 더 큰 가중치를 두어 계산한 이동평균입니다. 단순 이동평균보다 최근 가격 변화에 빠르게 반응하므로 추세 전환을 먼저 보여 주는 대신 잦은 흔들림도 함께 반영합니다.',
  },
  bollinger: {
    id: 'bollinger',
    name: '볼린저 밴드',
    pane: 'price',
    defaultParams: '기간 20, 표준편차 2배',
    tooltip:
      '이동평균선 위아래에 표준편차의 2배만큼 떨어진 상단·하단 밴드를 그린 지표입니다. 밴드 폭이 좁아지면 변동성이 낮아진 상태, 넓어지면 변동성이 커진 상태로 읽으며, 가격이 밴드 바깥으로 나가도 추세가 이어질 수 있습니다.',
  },
  rsi: {
    id: 'rsi',
    name: '상대강도지수(RSI)',
    pane: 'separate',
    defaultParams: '기간 14',
    tooltip:
      '일정 기간의 상승폭과 하락폭을 비교해 0에서 100 사이 값으로 나타낸 모멘텀 지표입니다. 흔히 70 이상은 과열 구간, 30 이하는 침체 구간으로 참고하지만 강한 추세에서는 한쪽 구간에 오래 머물 수 있습니다.',
  },
  macd: {
    id: 'macd',
    name: 'MACD',
    pane: 'separate',
    defaultParams: '12, 26, 9',
    tooltip:
      '단기(12)와 장기(26) 지수 이동평균의 차이인 MACD선과 그 9기간 평균인 시그널선, 두 선의 차이를 막대로 보여 줍니다. MACD선이 시그널선을 위에서 아래로 또는 아래에서 위로 교차하는 시점과 0선 위치로 추세의 방향과 힘을 가늠합니다.',
  },
  ichimoku: {
    id: 'ichimoku',
    name: '일목균형표',
    pane: 'price',
    defaultParams: '전환 9, 기준 26, 선행스팬 52, 후행 26',
    tooltip:
      '전환선·기준선(일정 기간 최고가와 최저가의 중간값), 26기간 앞으로 이동해 그린 구름대(선행스팬 1·2), 26기간 뒤로 이동한 후행스팬으로 구성됩니다. 가격이 구름대 위에 있는지 아래에 있는지, 구름대 두께가 얼마나 되는지로 추세와 지지·저항 구간을 가늠합니다.',
  },
  vwap: {
    id: 'vwap',
    name: '거래량 가중 평균가(VWAP)',
    pane: 'price',
    defaultParams: '분봉은 장 시작 기준, 일봉은 누적',
    tooltip:
      '대표가격((고가+저가+종가)/3)을 거래량으로 가중해 누적 평균한 가격입니다. 분봉에서는 하루 거래의 평균 체결 가격 수준을, 일봉에서는 선택한 시작점 이후의 평균 매수 단가 수준을 보여 주며 현재 가격이 그보다 높은지 낮은지를 비교하는 기준으로 쓰입니다.',
  },
  stochastic: {
    id: 'stochastic',
    name: '스토캐스틱(슬로)',
    pane: 'separate',
    defaultParams: '%K 14, 평활 3, %D 3',
    tooltip:
      '일정 기간의 최고가와 최저가 범위 안에서 현재 종가가 어느 위치에 있는지를 0에서 100 사이로 나타냅니다. 흔히 80 이상은 범위 상단, 20 이하는 하단에 가까운 상태로 보며, %K선과 %D선의 교차를 모멘텀 변화의 참고로 삼습니다.',
  },
  atr: {
    id: 'atr',
    name: '평균 진폭(ATR)',
    pane: 'separate',
    defaultParams: '기간 14',
    tooltip:
      '하루 가격 변동 폭에 전일 종가 대비 갭까지 포함한 진폭(True Range)의 평균을 계산합니다. 방향이 아니라 변동성의 크기만 나타내므로 값이 클수록 가격이 크게 움직이는 상태이며, 손절 폭이나 포지션 크기를 정할 때 변동성 참고치로 쓰입니다.',
  },
  obv: {
    id: 'obv',
    name: '누적 거래량(OBV)',
    pane: 'separate',
    defaultParams: '없음',
    tooltip:
      '종가가 전일보다 오르면 그날 거래량을 더하고 내리면 빼서 누적한 값입니다. 가격 흐름과 거래량 흐름이 같은 방향인지 비교하는 데 쓰이며, 절대 수치보다 기울기와 가격과의 방향 일치 여부를 주로 봅니다.',
  },
  parabolicSar: {
    id: 'parabolicSar',
    name: '파라볼릭 SAR',
    pane: 'price',
    defaultParams: '시작 0.02, 증가 0.02, 최대 0.2',
    tooltip:
      '추세를 따라 가격에 점차 가까워지는 점을 가격 위 또는 아래에 찍는 지표입니다. 점이 가격 아래에 있으면 상승 추세, 위에 있으면 하락 추세로 보고, 가격이 점을 넘어서면 추세 전환 신호로 해석합니다. 횡보 구간에서는 전환이 잦아질 수 있습니다.',
  },
  adx: {
    id: 'adx',
    name: '추세 강도(ADX, +DI/−DI)',
    pane: 'separate',
    defaultParams: '기간 14',
    tooltip:
      'ADX는 추세의 방향과 무관하게 추세가 얼마나 강한지를 0에서 100 사이로 나타내며, 흔히 25 안팎을 넘으면 추세가 뚜렷한 것으로 봅니다. +DI와 −DI는 상승과 하락 움직임의 상대적 크기를 보여 주어 어느 쪽 힘이 더 큰지 비교하는 데 쓰입니다.',
  },
  cci: {
    id: 'cci',
    name: '상품채널지수(CCI)',
    pane: 'separate',
    defaultParams: '기간 20',
    tooltip:
      '대표가격이 최근 평균에서 평균 편차의 몇 배만큼 벗어나 있는지를 나타냅니다. 흔히 +100 이상이면 평균보다 크게 높은 상태, −100 이하면 크게 낮은 상태로 보며, 값에 상하한이 없어 강한 움직임에서는 범위를 크게 벗어날 수 있습니다.',
  },
  keltner: {
    id: 'keltner',
    name: '켈트너 채널',
    pane: 'price',
    defaultParams: 'EMA 20, ATR 10의 2배',
    tooltip:
      '지수 이동평균을 중심으로 평균 진폭(ATR)의 2배만큼 위아래에 채널을 그린 지표입니다. 가격이 채널 상단 위나 하단 아래에서 움직이면 평소보다 강한 움직임으로 보고, 볼린저 밴드와 달리 표준편차 대신 ATR을 쓰기 때문에 급격한 폭 변화가 덜합니다.',
  },
  fibonacci: {
    id: 'fibonacci',
    name: '피보나치 되돌림',
    pane: 'price',
    defaultParams: '0, 23.6, 38.2, 50, 61.8, 78.6, 100%',
    tooltip:
      '선택한 구간의 최고가와 최저가 사이를 피보나치 비율로 나눈 가로선입니다. 상승 뒤 조정이나 하락 뒤 반등이 어느 비율 부근에서 멈추는지 가늠하는 참고선으로 쓰이지만, 비율 자체에 통계적 보장이 있는 것은 아니며 구간 선택에 따라 달라집니다.',
  },
};

export const indicatorIds = Object.keys(indicatorDescriptions) as IndicatorId[];
