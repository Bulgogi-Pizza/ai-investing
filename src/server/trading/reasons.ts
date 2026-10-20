/**
 * Stable reason codes for every way the pre-trade check can refuse an order. The code is the
 * contract (stored, tested, shown); the Korean message is display text. Numbers in the comments
 * refer to the "안전장치" list in docs/planning/next-phase-design.md section 4.
 */
export const REASONS = {
  // Order shape (LIMIT + DAY, integer quantity, valid price) — 8 (LIMIT only), 10.
  ORDER_NOT_LIMIT_DAY: '지정가(LIMIT)·당일(DAY) 주문만 낼 수 있습니다.',
  ORDER_INVALID: '주문 종목·방향·수량·가격 형식이 올바르지 않습니다.',
  QUANTITY_NOT_INTEGER: '주문 수량은 1 이상의 정수여야 합니다.',
  PRICE_INVALID: '주문 가격이 올바르지 않습니다.',
  CURRENCY_MISMATCH: '주문 통화가 알고리즘 시장의 통화와 다릅니다.',
  // Control state — 4, 5, 2.
  EMERGENCY_STOP: '긴급 정지가 켜져 있습니다.',
  EMERGENCY_STOP_UNREADABLE: '긴급 정지 상태를 읽지 못해 주문하지 않습니다.',
  ALGORITHM_STOPPED: '알고리즘이 정지 상태입니다.',
  LOSS_LIMIT_REACHED: '누적 손실이 한도에 닿아 알고리즘을 자동 정지합니다.',
  LOSS_UNKNOWN: '누적 손익을 확인하지 못해 주문하지 않습니다.',
  DAILY_LIMIT_ALGORITHM: '알고리즘의 하루 최대 주문 횟수에 닿았습니다.',
  DAILY_LIMIT_GLOBAL: '전체 하루 최대 주문 횟수에 닿았습니다.',
  STORE_UNAVAILABLE: '저장소 상태를 읽지 못해 주문하지 않습니다.',
  // Data freshness — 6.
  DAILY_BAR_MISSING: '직전 거래일 일봉이 없어 주문하지 않습니다.',
  QUOTE_MISSING: '현재가를 받지 못해 주문하지 않습니다.',
  QUOTE_STALE: '현재가가 1분보다 오래되어 주문하지 않습니다.',
  FINANCIALS_MISSING: '재무 데이터가 비어 있어 가치 신호를 쓰는 알고리즘은 주문하지 않습니다.',
  FX_RATE_MISSING: '환율을 확인하지 못해 미국 주문 금액을 원화로 환산할 수 없습니다.',
  FX_RATE_INVALID: '환율이 상식적인 범위를 벗어나 미국 주문 금액을 환산하지 않습니다.',
  FX_RATE_STALE: '환율이 오래되었거나 시각을 알 수 없어 미국 주문 금액을 환산하지 않습니다.',
  PRICE_FAR_FROM_QUOTE: '주문 가격이 현재가와 너무 떨어져 있습니다.',
  // Position rules — 7, 2, 1.
  SELL_NOT_OWNED: '알고리즘이 보유한 수량이 없어 매도하지 않습니다.',
  SELL_EXCEEDS_OWNED: '알고리즘이 산 수량보다 많이 매도할 수 없습니다.',
  SELL_EXCEEDS_SELLABLE: '증권사 판매 가능 수량보다 많이 매도할 수 없습니다.',
  MIN_HOLDING_PERIOD: '최소 보유 기간(거래일) 안에는 매도하지 않습니다.',
  BUDGET_NOT_SET: '운용 금액 한도가 없어 매수하지 않습니다.',
  BUDGET_EXCEEDED: '운용 금액 한도를 넘어 매수하지 않습니다.',
  BUYING_POWER_INSUFFICIENT: '계좌의 현금 매수 가능 금액이 부족합니다.',
  // Universe and market rules — 8, 9, 10.
  LIQUIDITY_BELOW_MINIMUM: '최근 20거래일 평균 거래대금이 기준보다 적습니다.',
  STOCK_WARNING: '매수 유의사항(투자경고·거래정지 등)이 있는 종목입니다.',
  NEAR_PRICE_LIMIT: '주문 가격이 상·하한가에 가깝거나 범위를 벗어났습니다.',
  ORDER_TOO_LARGE: '주문 금액이 1억 원 이상이어서 주문하지 않습니다.',
  // Duplicate orders — 3.
  OPEN_ORDER_EXISTS: '같은 종목에 미체결 주문이 있어 새 주문을 내지 않습니다.',
  UNRECONCILED_ORDER: '결과를 확인하지 못한 이전 주문이 있어 새 주문을 내지 않습니다.',
  // Costs — "비용 반영".
  COST_SETTINGS_MISSING: '수수료율 또는 거래세율이 없어 비용을 계산할 수 없습니다.',
  HISTORY_INSUFFICIENT: '기록 부족으로 주문 보류',
  EXPECTED_PROFIT_BELOW_COST: '예상 이익이 왕복 비용보다 크지 않아 주문하지 않습니다.',
  // Remote reads that failed closed.
  OPEN_ORDERS_UNAVAILABLE: '미체결 주문 목록을 확인하지 못해 주문하지 않습니다.',
  WARNINGS_UNAVAILABLE: '종목 유의사항을 확인하지 못해 주문하지 않습니다.',
  PRICE_LIMITS_UNAVAILABLE: '상·하한가를 확인하지 못해 주문하지 않습니다.',
  BUYING_POWER_UNAVAILABLE: '매수 가능 금액을 확인하지 못해 주문하지 않습니다.',
  SELLABLE_UNAVAILABLE: '판매 가능 수량을 확인하지 못해 주문하지 않습니다.',
  COMMISSIONS_UNAVAILABLE: '매매 수수료율을 확인하지 못해 주문하지 않습니다.',
  RUN_IN_PROGRESS: '같은 알고리즘의 다른 실행이 진행 중이어서 주문하지 않습니다.',
  ALGORITHM_NOT_LIVE: '알고리즘이 더 이상 실전 모드가 아니어서 주문하지 않습니다.',
  RUN_WINDOW_CLOSED: '개장 직후 주문 시간대가 끝나 주문하지 않습니다.',
  // Fail-closed fallbacks.
  SETTINGS_INVALID: '안전장치 설정값이 올바르지 않아 주문하지 않습니다.',
  INTERNAL_ERROR: '예상하지 못한 오류가 있어 주문하지 않습니다.',
} as const;

export type ReasonCode = keyof typeof REASONS;
export type Reason = { code: ReasonCode; message: string };

export function reason(code: ReasonCode): Reason {
  return { code, message: REASONS[code] };
}

/**
 * Reasons that are routine "no trade today" holds rather than safety events. The executor records
 * them but does not send a notification for them.
 */
export const ROUTINE_HOLD_CODES: readonly ReasonCode[] = [
  'HISTORY_INSUFFICIENT',
  'EXPECTED_PROFIT_BELOW_COST',
  'MIN_HOLDING_PERIOD',
];
