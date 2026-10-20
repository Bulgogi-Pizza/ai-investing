# 실전 주문 기반 — TRADING

SOT: [next-phase-design.md](../planning/next-phase-design.md) 4절(주문·주문 권한 확인·비용 반영·안전장치 1–10), 계획: [next-phase-plan.md](../planning/next-phase-plan.md) 7d–7f. 구현: `src/server/trading/`, `src/jobs/algo-live*.ts`, `src/jobs/order-access-check.ts`, `src/server/live.ts`, 테스트: `tests/trading-*.test.ts`, `tests/algo-live-*.test.ts`, `tests/order-access-check.test.ts`, `tests/live-api.test.ts`.

**연결 상태(7e/7f, 2026-10-21)**: 이 모듈은 세 곳에만 연결되어 있다. (1) 실전 작업 `src/jobs/algo-live.ts`(주문 실행기), (2) 읽기 전용 확인 작업 `src/jobs/order-access-check.ts`(`checkOrderAccess`), (3) 소유자 전용 화면 API `src/server/live.ts`와 앱 조립(`app.ts`·`index.ts`)이 저장소를 **읽기만** 한다. 주문 실행기(`placeOrder`를 부르는 곳)는 `executor.ts` 한 곳이고, 화면 서버는 주문 클라이언트·실행기·전송 계층을 import하지 않는다(정적 테스트 `tests/trading-static.test.ts`가 이 목록과 "주문 POST 경로 한 곳"을 검사한다). 테스트는 가짜 토스 서버(`tests/support/fake-toss.ts`)만 쓰고 이 저장소의 어떤 테스트도 실제 주문을 내지 않는다. **실제 주문이 한 번이라도 나간 적은 없고, 아래 연결 코드는 실호출로 검증하지 않았다.**

## 공식 계약

확인일: 2026-10-21 KST. 토스증권 Open API 명세 v1.2.24(`https://openapi.tossinvest.com/openapi-docs/latest/openapi.json`)를 데이터로 읽었다. 아래에 없는 필드는 만들지 않았다.

### 주문 생성 `POST /api/v1/orders` (호출 한도 그룹 `ORDER`)

- 요청 본문은 `OrderCreateRequest`이고 두 가지 형태 중 하나다. **수량 기반**(`quantity`)만 쓴다. 금액 기반(`orderAmount`, 미국 시장가 전용)과 소수점 수량(미국 시장가 매도 전용)은 쓰지 않는다.
- 우리가 보내는 필드는 정확히 `clientOrderId`, `symbol`, `side`(`BUY`/`SELL`), `orderType`(`LIMIT`만), `timeInForce`(`DAY`만), `quantity`(정수 문자열), `price`(문자열)다. 1억 원 이상 주문의 확인 플래그는 필드 이름 자체를 코드에 두지 않는다. 보내지 않으면 기본값은 `false`이고, 1억 원 이상이면 서버가 `400 confirm-high-value-required`로 막는다.
- `clientOrderId`: 최대 36자, `[a-zA-Z0-9\-_]`. 멱등 키이며 **10분간 유효**하다. 같은 값으로 다시 요청하면 이전 결과를 그대로 돌려준다. 10분이 지나면 새 주문으로 처리한다. 서버가 자동 생성하지 않는다. 같은 키에 다른 본문을 보내면 `422 idempotency-key-conflict`, 같은 키의 요청이 처리 중이면 `409 request-in-progress`다.
- `timeInForce`: `DAY`(기본), `CLS`(미국 지정가 전용), `OPG`(국내 시가단일가 전용). `DAY`는 정규장 종료까지 미체결분이 자동 취소된다. 이 모듈은 `DAY`만 보낸다.
- `price`: `LIMIT`일 때 필수. 국내는 정수(원)이고 호가 단위에 맞아야 한다. 맞지 않으면 `400 invalid-request`와 함께 `error.data = {field: "price", tickSize, nearestPrices: [하나 아래, 하나 위]}`가 온다. 미국은 1달러 미만 소수 넷째 자리, 1달러 이상 둘째 자리까지이며 그 아래는 서버가 **절삭**한다.
- 200 응답: `{result: {orderId, clientOrderId}}`. `orderId`는 서버가 만든 불투명 문자열이고 `clientOrderId`는 요청값을 그대로 돌려준다(없으면 `null`).
- 오류 응답: `{error: {requestId, code, message, data?}}`. 명세에 정의된 코드는 다음과 같다.

| HTTP | 코드                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `invalid-request`(`data`: 필드, 허용값, 호가 단위), `confirm-high-value-required`, `account-header-required`                                                                                                                                                                                                                                                                                                              |
| 401  | `invalid-token`, `expired-token`, `token-revoked`, `login-user-not-found`                                                                                                                                                                                                                                                                                                                                                 |
| 409  | `request-in-progress`, `opposite-pending-order-exists`                                                                                                                                                                                                                                                                                                                                                                    |
| 422  | `insufficient-buying-power`, `order-hours-closed`(`data.retryAfterAt`), `stock-restricted`, `price-out-of-range`, `order-type-not-allowed`, `prerequisite-required`, `market-not-supported-for-stock`, `investor-exchange-not-integrated`, `account-restricted`, `max-order-amount-exceeded`(30억 원 초과), `idempotency-key-conflict`, `amount-order-outside-regular-hours`, `fractional-quantity-outside-regular-hours` |
| 429  | `rate-limit-exceeded`(`Retry-After` 헤더)                                                                                                                                                                                                                                                                                                                                                                                 |
| 500  | `internal-error`, `maintenance`(`data.retryAfterSeconds`)                                                                                                                                                                                                                                                                                                                                                                 |

- **`POST /orders`에는 403이 정의되어 있지 않다.** 그래도 코드는 401과 403을 모두 권한 문제로 다룬다(아래 실행기).

### 조회·취소

- `GET /api/v1/orders?status=OPEN|CLOSED[&symbol][&from][&to][&limit][&cursor]`(`ORDER_HISTORY`): `OPEN`은 진행 중 주문(`PENDING`, `PARTIAL_FILLED`, `PENDING_CANCEL`, `PENDING_REPLACE`)을 **전량** 돌려주고 `limit`·`cursor`는 무시하며 `hasNext`는 항상 `false`다. `CLOSED`는 `limit`(기본 20, 최대 100)와 `cursor`로 페이지를 넘긴다. 응답 `{orders[], nextCursor, hasNext}`의 주문 필드는 `orderId`, `symbol`, `side`, `orderType`, `timeInForce`, `status`, `price`(시장가면 `null`), `quantity`, `orderAmount`, `currency`, `orderedAt`, `canceledAt`, `execution{filledQuantity, averageFilledPrice, filledAmount, commission, tax, filledAt, settlementDate}`다. **주문 목록·상세 응답에는 `clientOrderId`가 없다.** 상태 값은 `PENDING`, `PENDING_CANCEL`, `PENDING_REPLACE`, `PARTIAL_FILLED`, `FILLED`, `CANCELED`, `REJECTED`, `CANCEL_REJECTED`, `REPLACE_REJECTED`, `REPLACED`이고 명세가 "알 수 없는 코드를 허용하라"고 한다.
- `GET /api/v1/orders/{orderId}`(`ORDER_HISTORY`): 같은 주문 객체. 404 `order-not-found`.
- `POST /api/v1/orders/{orderId}/cancel`(`ORDER`): 200 `{orderId}`(취소로 새로 발급된 식별자), 409 `already-filled`·`already-canceled`·`already-modified`·`already-rejected`·`already-processing`, 422 `cancel-restricted`·`order-hours-closed`.
- `GET /api/v1/buying-power?currency=KRW|USD`(`ORDER_INFO`): `{currency, cashBuyingPower}`. 현금 기준(미수 제외). 401, 404 `account-not-found`.
- `GET /api/v1/sellable-quantity?symbol=`(`ORDER_INFO`): `{sellableQuantity}`. 국내는 정수, 미국은 소수점 가능. 404 `stock-not-found`.
- `GET /api/v1/commissions`(`ORDER_INFO`): `[{marketCountry, commissionRate, startDate, endDate}]`. 해외는 `startDate`가 `null`.
- `GET /api/v1/stocks/{symbol}/warnings`(`STOCK`): `[{warningType, exchange, startDate, endDate}]`. `warningType`은 `LIQUIDATION_TRADING`, `OVERHEATED`, `INVESTMENT_WARNING`, `INVESTMENT_RISK`, `VI_STATIC_AND_DYNAMIC`, `VI_STATIC`, `VI_DYNAMIC`, `STOCK_WARRANTS`. 응답 시점 기준 활성 항목(`startDate <= 오늘 <= endDate` 또는 `endDate`가 `null`)만 온다. 활성 항목이 없으면 `200 []`. 403 `forbidden`(권한 부족)과 404가 정의되어 있다. 명세의 열거형에 "거래정지"는 없다. 거래정지·주문 제한은 주문 시점의 `422 stock-restricted`로만 드러난다.
- `GET /api/v1/price-limits?symbol=`(`MARKET_DATA`): `{timestamp, upperLimitPrice, lowerLimitPrice, currency}`. 미국처럼 가격제한이 없는 시장은 두 값이 `null`이다. 계좌 헤더가 필요 없다.
- 금액·수량은 모두 문자열 소수다. 계좌 지정은 `X-Tossinvest-Account` 헤더이며 전송 계층(transport)이 붙인다. 이 모듈은 계좌 식별값을 다루지 않는다.

## 구성

| 파일                 | 내용                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `toss-orders.ts`     | 주문 클라이언트, 전송 계층 인터페이스, `clientOrderId` 생성, 가격 정규화, 호가 보정, 응답 검증, 정리된 오류 |
| `pre-trade.ts`       | `preTradeCheck`(주문 전 단 하나의 검사), `planSellTranches`, `isAcceptableCorrection`                       |
| `executor.ts`        | `LiveOrderExecutor`: 검사 → 슬롯 예약 → 주문 → 기록 → 알림, 미체결·체결 동기화(`reconcile`)                 |
| `access-check.ts`    | `checkOrderAccess`: 읽기 전용 주문 권한 확인                                                                |
| `stores.ts`          | 저장소 인터페이스, 상태 전이, 장부 계산, 메모리 구현                                                        |
| `firestore-store.ts` | Firestore 구현(트랜잭션)                                                                                    |
| `reasons.ts`         | 거부 사유 코드와 한국어 문구                                                                                |
| `alerts.ts`          | 알림 매핑 단 한 곳(`liveAlertEvent`)                                                                        |
| `toss-transport.ts`  | `OrderTransport` 구현(7e): `TossClient.authorizedRequest` 위의 허용 목록 전송 계층                          |
| `ledger-pnl.ts`      | 알고리즘 자신의 주문에서 누적 손익(실현 + 평가) 계산                                                        |

가짜 토스 서버(`FakeToss`), 가짜 Firestore, 고정 입력은 `tests/support/`에 있다. `src/`의 어떤 파일도 이를 import하지 않는다(정적 테스트가 검사한다).

### 전송 계층 인터페이스

`toss.ts`는 바꾸지 않았다. 감독자가 나중에 `TossClient`의 토큰·계좌 헤더 처리로 아래 인터페이스를 구현한다.

```ts
interface OrderTransport {
  send(request: {
    method: 'GET' | 'POST';
    path: string;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
  }): Promise<{ status: number; body: unknown; retryAfterSeconds?: number | null }>;
}
```

구현이 지켜야 할 것: 베어러 토큰과 `X-Tossinvest-Account` 부착, 시간 제한, `redirect: 'error'`, 응답 크기 상한, HTTP 오류 상태도 **응답으로 돌려줄 것**(던지지 않는다), 응답을 받지 못했을 때만 `TransportNetworkError`를 던질 것, **재시도하지 않을 것**(재시도와 멱등성은 클라이언트의 몫이다), 본문·헤더를 로그에 남기지 않을 것. 현재 `TossClient.request`는 오류를 `ProviderError`로 뭉개고 429 때 전역 대기를 걸기 때문에 그대로 쓸 수 없다. 오류 본문(특히 호가 보정용 `data`)을 보존하는 별도 메서드가 필요하다.

## 주문 클라이언트 (`toss-orders.ts`)

- **본문은 한 곳에서 고정 필드로만 만든다.** 시장가, 금액 기반, `CLS`/`OPG`, 소수점 수량을 만들 수 없다. 정수 수량, 문서의 가격 단위, 시장별 종목 형식(국내 6자리 영숫자 대문자, 미국 대문자 티커)이 맞지 않으면 아무것도 보내지 않고 `OrderInputError`를 던진다.
- **결과는 세 가지다.** `accepted`(주문 번호를 받음), `rejected`(확정 거부: 해당 키로 주문이 없다), `unknown`(주문이 있을 수도 없을 수도 있다). 제공자 결과로는 던지지 않는다.
- **정리된 오류**: `{kind, status, code, requestId?}`만 남는다. `code`는 `[a-z0-9-]`로 검증한 제공자 코드이거나 `network-error`, `response-invalid`, `http-<상태>` 같은 로컬 코드다. 제공자 `message`, `data`, 응답 본문, 계좌 식별값, 토큰은 어디에도 저장하지 않는다. 한국어 문구는 코드에서 만든다(`describeOrderError`).
- **엄격한 응답 검증**: 200 응답에서 `result.orderId`(`[A-Za-z0-9_\-=.~]`, 256자 이하)와 `result.clientOrderId`(보낸 값과 같아야 함)를 확인한다. 아니면 `unknown`이다(주문이 접수되었을 수 있다). 목록·잔고·수수료·경고·가격제한도 필드마다 형식을 검사하고, 틀리면 `response-invalid`다. `OPEN` 목록의 `hasNext`가 `true`이면 믿지 않는다.

### 가격

- `normalizeLimitPrice(market, side, price)`: 국내는 정수 원, 미국은 1달러 미만 4자리·1달러 이상 2자리로 맞추되 **항상 덜 공격적인 쪽**(매수는 내림, 매도는 올림)으로 한다. 10진 문자열을 BigInt로 계산해 부동소수 오차가 없다.
- 국내 호가 단위 표(KRX 규정)는 토스 명세에 없다. **추측한 표를 코드에 넣지 않았다.** 호가에 맞지 않으면 토스가 400과 함께 `nearestPrices`를 돌려주므로, 그 값으로 **한 번만** 보정한다. 매수는 아래 값, 매도는 위 값(덜 공격적인 쪽)이다. 보정은 다음 조건을 모두 만족할 때만 한다: 국내 종목, 응답이 `invalid-request`이고 `field=price`, `tickSize`와 `nearestPrices`가 정수 문자열, 보낸 가격이 두 값 사이, 두 값의 차이가 `tickSize` 이하. 하나라도 어긋나면 보정하지 않고 거부한다(`tick-correction-unavailable`).
- 보정 가격으로 다시 보내기 전에 호출자가 준 `onPriceCorrection` 검문을 통과해야 한다. 없으면 거부한다(`tick-correction-declined`). 실행기의 검문(`verifyCorrectedPrice`)은 1억 원 상한, 가격 단위, 덜 공격적인 방향, 환율을 다시 확인하고, **상·하한가를 다시 조회해 보정 가격이 완충 구간(3%)에 들어가면 거부**하며, 긴급 정지와 알고리즘 정지를 다시 읽는다(읽기 실패는 거부). 보정 후 두 번째 가격 거부는 최종이다(반복 없음). 이전 시도가 모호했다면(아래) 호가 보정은 하지 않는다.
- 보정 재시도에는 **새 키**(`<원래 키>-t1`)를 쓴다. 첫 요청이 400으로 확정 거부되어 그 키로 만들어진 주문은 없다. 거부된 본문에 키가 묶이는지는 명세에 없으므로, 같은 키에 다른 본문을 보내는 방식은 피한다.

### `clientOrderId`와 재시도

- `deriveClientOrderId({algorithmId, runId, symbol, side, tranche})`: 입력의 JSON을 SHA-256으로 해시해 `ai-` + 16진 28자(31자)를 만든다. 같은 입력이면 항상 같고(프로세스 재시작 포함), 구성 요소 중 하나만 달라도 달라진다. 구분자 충돌이 없다.
- 재시도는 **네트워크 오류, 5xx, 429에서만** 한다. 같은 키·같은 본문으로 **최대 2번**(총 3회). 4xx는 재시도하지 않는다. 대기는 500ms, 1000ms이고, 429의 `Retry-After`가 있으면 그 값(최대 30초)을 쓴다. 첫 시도에서 9분이 지났거나 대기 시간을 더하면 9분을 넘으면 더 시도하지 않는다(키 유효 10분을 넘기면 새 주문이 되기 때문이다).
- **재시도 직전 점검(`beforeRetry`)**: 대기 뒤, 모든 재시도 직전에 호출자의 훅을 부른다. 훅이 `false`를 돌려주거나 던지면 재전송하지 않고 `unknown`(`retry-aborted`)으로 끝낸다. 실행기는 이 훅에서 긴급 정지와 알고리즘 정지 상태를 다시 읽고, 읽기에 실패해도 재전송하지 않는다.
- 재시도 소진 후의 결과: 응답이 한 번이라도 모호했으면(네트워크 오류, 5xx, 이상한 200) `unknown`. 모든 시도가 429였다면 `rejected`(주문이 만들어졌을 수 없다).
- **모호한 시도 뒤의 4xx**: 네트워크 오류나 5xx 같은 모호한 시도가 한 번이라도 있었다면, 그 뒤에 오는 **모든 비 200 응답**(401, 403, 422, 409, 400 등)은 `rejected`가 아니라 `unknown`이다. 이전 요청으로 주문이 이미 만들어졌는지 이 응답으로는 알 수 없다. 이 판정에서 "주문이 없음을 증명하는 코드" 집합(`PROVES_NO_ORDER`)은 의도적으로 비어 있다. 그래서 이 경우에는 호가 보정도, 권한 문제로 인한 알고리즘 정지도 일어나지 않는다. 429는 처리 전에 거부하므로 앞선 시도가 모호하지 않았다면 `rejected` 판정을 해치지 않는다.
- 4xx 중에도 **모호한 코드**가 있다. `409 request-in-progress`(같은 키 요청이 처리 중)와 `422 idempotency-key-conflict`(같은 키가 이미 다른 본문으로 쓰였다)는 이전 주문이 있을 수 있으므로 `unknown`이다. 재시도하지 않는다.
- `GET /orders`가 `clientOrderId`를 돌려주지 않으므로, `unknown` 주문의 확인은 `clientOrderId`로 할 수 없다. 실행기의 `reconcile`은 종목·방향·수량·가격·`LIMIT`·`DAY`가 모두 같고 `orderedAt`이 기록의 `createdAt` 이후인 **유일한** 미체결 주문만 이어받는다. 이어받기에는 두 방향의 유일성이 필요하다: 기록 하나에 맞는 미체결 주문이 정확히 하나이고, 그 주문에 맞는 `orderId` 없는 기록(모든 알고리즘 포함)도 정확히 하나여야 한다. 이미 다른 기록(어느 알고리즘이든)이 가진 `orderId`는 이어받지 않는다. 그 밖에는 `unknown`으로 남아 새 주문을 막는다(사람의 확인이 필요하다). 10분 안이면 같은 키·같은 본문 재전송이 이전 결과를 돌려주므로 확인 수단이 된다(구현하지 않았다. 7e/7f 과제).

## 주문 전 검사 (`pre-trade.ts`)

`preTradeCheck(context, deps) → {allowed: true, order} | {allowed: false, reasons[], autoStop?}`. 실전 주문은 모두 이 함수를 통과해야 한다. 규칙은 다음과 같다.

- **닫힌 방향(fail closed)**: 빠진 사실, 읽지 못한 저장소·제공자 응답, 예상 밖 예외는 모두 거부다. 던지지 않는다.
- **주문을 바꾸지 않는다.** 통과한 주문은 입력과 같다(`Object.freeze`). 매도 수량을 소유 수량으로 깎지 않고 거부한다(`checkOrder`는 깎지만 여기서는 `clamped`이면 거부한다).
- **검사 순서가 고정되어 있다.** 앞 단계에 사유가 있으면 거기서 끝나고 뒤 단계는 실행하지 않는다. 그래서 막힌 주문에 원격 조회를 쓰지 않는다.
  1. 모양: LIMIT·DAY, 정수 수량, 가격 단위, 종목 형식
  2. 제어 상태(저장소): 긴급 정지, 알고리즘 정지, 예산 설정, 누적 손익과 -20% 한도, 하루 주문 횟수(알고리즘·전체)
  3. 로컬 자료와 보유 규칙: 현재가 신선도, 직전 거래일 일봉, 재무, 환율, 미체결·미확인 주문(저장소), 예산, 그리고 재사용한 `checkOrder`(수량, 매도 보유·최소 보유 기간, 매수 유동성, 알고리즘당 횟수, 주문 금액 상한)
  4. 원격 조회(차례대로, 첫 거부에서 중단): 미체결 주문 → 매수 유의사항 → 상·하한가 → (매도) 판매 가능 수량 / (매수) 수수료 → 예상 이익 규칙(`checkOrder` 두 번째 호출) → 매수 가능 금액
  5. 마지막: **긴급 정지를 저장소에서 다시 읽는다.** 느린 원격 조회 뒤의 변경을 잡는다. 1단계 읽기와 별개이며 캐시하지 않는다.
- 설정은 느슨하게 만들 수 없는 한도가 있다. 주문 금액 상한은 1억 원 이상으로 올릴 수 없고(낮추는 것만 가능), 현재가 허용 나이는 60초를 넘길 수 없다. 숫자 설정이 `NaN`이거나 범위를 벗어나면 안전장치가 조용히 꺼지는 일이 없도록 `SETTINGS_INVALID`로 거부한다.
- **위험을 늘리는 설정(사용자 선호: 설정 가능, 상한 없음)**: 하루 주문 횟수(알고리즘 3건, 전체 10건), 최소 보유 거래일, 누적 손실 정지 비율, 유동성 기준, 운용 금액 한도는 코드가 올릴 수 있는 한도를 따로 정하지 않는다. 이 값을 **올리거나 느슨하게 하는 것은 위험을 늘리는 설정 변경**이다. 7e는 이 변경을 반드시 설정 변경 알림 경로(`setting-risk-increase`, 설계의 설정 변경 인증 절)로 보내고 변경 이력을 남겨야 한다. 줄이는 변경은 즉시 반영해도 된다. 이 모듈은 하드 한도를 1억 원 주문 상한과 60초 현재가 나이 두 가지만 둔다.

### `checkOrder`(`src/lib/algo`) 재사용과 차이

재사용: 수량 검사, 매도 보유량·최소 보유 기간, 매수 유동성, 예상 이익 규칙(기록 부족 포함), 알고리즘당 하루 횟수, 주문 금액 상한. 다음은 `checkOrder`에 입력이 없어 이 모듈이 직접 하고, `checkOrder`와 다르게 동작하는 점은 아래와 같다.

- 긴급 정지, 알고리즘 정지 상태, 전체 하루 횟수, 예산 누적, 누적 손실의 자동 정지 표시(`autoStop`)는 이 모듈이 한다. `checkOrder`는 단일 알고리즘 하루 횟수만 안다.
- `checkOrder`는 큰 매도를 소유 수량으로 **줄여** 통과시킨다. 여기서는 거부한다.
- 주문 금액은 원화 환산으로 비교한다. 미국 주문은 `midRate × (1 + 여유 2%)`로 환산해 `checkOrder`에 원화 가격으로 넘긴다. 유동성 기준은 시장 통화(국내 원, 미국 달러) 그대로 쓴다.
- 유동성과 예상 이익 규칙은 매수에만 적용한다(`checkOrder`와 같다). 매도(청산)는 막지 않는다.

## 안전장치와 사유 코드

번호는 설계 4절 "안전장치" 순서다. 모든 사유는 안정된 코드와 한국어 문구(`reasons.ts`)를 갖는다.

| 설계 | 규칙                                                          | 사유 코드                                                                                                                                                                                                                  | 단계 | 자료                                             |
| ---- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------ |
| 1    | 알고리즘별·통화별 운용 금액 한도(기본값 없음)                 | `BUDGET_NOT_SET`, `BUDGET_EXCEEDED`                                                                                                                                                                                        | 2, 3 | 알고리즘 설정, 장부(보유 원가 + 진행 중 매수)    |
| 2    | 하루 알고리즘 3건·전체 10건                                   | `DAILY_LIMIT_ALGORITHM`, `DAILY_LIMIT_GLOBAL`                                                                                                                                                                              | 2    | 저장소 카운터(KST 날짜), 예약 때 트랜잭션 재확인 |
| 2    | 최소 보유 5거래일                                             | `MIN_HOLDING_PERIOD`                                                                                                                                                                                                       | 3    | 장부의 마지막 매수일 + 거래일 계산               |
| 3    | 미체결 주문이 있으면 새 주문 금지                             | `OPEN_ORDER_EXISTS`, `UNRECONCILED_ORDER`, `OPEN_ORDERS_UNAVAILABLE`                                                                                                                                                       | 3, 4 | 저장소 + `GET /orders?status=OPEN&symbol`        |
| 3    | 재시도는 같은 `clientOrderId`                                 | (클라이언트 규칙)                                                                                                                                                                                                          | -    | `deriveClientOrderId`                            |
| 4    | 누적 손실 -20% 자동 정지                                      | `LOSS_LIMIT_REACHED`(+ `autoStop`), `LOSS_UNKNOWN`                                                                                                                                                                         | 2    | 호출자가 계산한 실현 + 평가 손익                 |
| 5    | 긴급 정지                                                     | `EMERGENCY_STOP`, `EMERGENCY_STOP_UNREADABLE`, `ALGORITHM_STOPPED`                                                                                                                                                         | 2, 5 | 저장소(매번 새로 읽음)                           |
| 6    | 데이터 신선도                                                 | `DAILY_BAR_MISSING`, `QUOTE_MISSING`, `QUOTE_STALE`, `FINANCIALS_MISSING`, `PRICE_FAR_FROM_QUOTE`(추가 규칙)                                                                                                               | 3    | 호출자가 준 시세·일봉                            |
| 7    | 알고리즘이 산 수량만 매도                                     | `SELL_NOT_OWNED`, `SELL_EXCEEDS_OWNED`, `SELL_EXCEEDS_SELLABLE`, `SELLABLE_UNAVAILABLE`                                                                                                                                    | 3, 4 | 장부 + `GET /sellable-quantity`                  |
| 8    | 지정가만, 유동성 필터(국내 10억 원·미국 500만 달러, 20거래일) | `ORDER_NOT_LIMIT_DAY`, `LIQUIDITY_BELOW_MINIMUM`                                                                                                                                                                           | 1, 3 | 호출자가 준 평균 거래대금                        |
| 9    | 매수 유의사항·상하한가 근접 제외                              | `STOCK_WARNING`, `WARNINGS_UNAVAILABLE`, `NEAR_PRICE_LIMIT`, `PRICE_LIMITS_UNAVAILABLE`                                                                                                                                    | 4    | `GET /stocks/{symbol}/warnings`, `/price-limits` |
| 10   | 1억 원 이상 주문 금지, 매도는 분할                            | `ORDER_TOO_LARGE`(+ `planSellTranches`)                                                                                                                                                                                    | 3    | 원화 환산 가격(미국은 환율 + 여유)               |
| 비용 | 예상 이익 > 왕복 비용, 기록 부족이면 보류                     | `COST_SETTINGS_MISSING`, `COMMISSIONS_UNAVAILABLE`, `HISTORY_INSUFFICIENT`("기록 부족으로 주문 보류"), `EXPECTED_PROFIT_BELOW_COST`                                                                                        | 4    | `/commissions`, 설정의 거래세율, 점수 구간 통계  |
| -    | 매수 가능 금액(국내 원화, 미국은 달러 현금만)                 | `BUYING_POWER_INSUFFICIENT`, `BUYING_POWER_UNAVAILABLE`                                                                                                                                                                    | 4    | `GET /buying-power?currency=`                    |
| -    | 입력·설정 이상, 미국 환율 없음, 예상 밖 오류                  | `ORDER_INVALID`, `QUANTITY_NOT_INTEGER`, `PRICE_INVALID`, `CURRENCY_MISMATCH`, `FX_RATE_MISSING`, `FX_RATE_INVALID`, `FX_RATE_STALE`, `RUN_IN_PROGRESS`(실행기), `SETTINGS_INVALID`, `STORE_UNAVAILABLE`, `INTERNAL_ERROR` | 1-4  | -                                                |

세부 규칙:

- 신선도: 현재가는 관측 시각이 60초 이내여야 하고(미래 시각 5초 초과도 거부), 직전 거래일 일봉 날짜가 호출자가 준 기대 날짜 이상이어야 한다. 가치 신호를 쓰는 알고리즘만 재무 유무를 본다. 지정가가 현재가보다 3% 넘게 **불리한 쪽**(매수는 높음, 매도는 낮음)이면 거부한다. 체결되지 않을 뿐인 먼 가격은 막지 않는다. 이 3% 검사는 설계에 없는 추가 안전장치다.
- 미체결 판정: 저장소에서 같은 알고리즘·종목의 `accepted`/`partially-filled`는 `OPEN_ORDER_EXISTS`, `reserved`/`unknown`은 `UNRECONCILED_ORDER`다. 제공자 `OPEN` 목록은 이미 `symbol=`로 걸러서 받으므로, **목록에 주문이 하나라도 있으면** 누가 냈든 막는다(종목 문자열 비교를 하지 않아 표기가 다른 심볼도 빠져나가지 못한다. 목록에 `clientOrderId`가 없어 알고리즘을 구분할 수 없고, 소유자가 직접 낸 주문과 겹치지 않게 하는 보수적 선택이다).
- 유의사항: 활성 항목이 하나라도 있으면(알 수 없는 유형 포함) 매수·매도 모두 막는다. 거부는 안전한 쪽이라 보수적으로 했다. 403 등으로 조회가 안 되면 `WARNINGS_UNAVAILABLE`이다.
- 상·하한가: 주문 가격이 상한가의 97% 이상이거나 하한가의 103% 이하이거나 범위 밖이면 `NEAR_PRICE_LIMIT`. 국내 종목에서 두 값이 모두 `null`이면 확인할 수 없으므로 거부한다. 미국은 두 값이 `null`이 정상이다.
- 1억 원: 국내 `수량 × 가격 < 1억`. 미국은 `수량 × 가격 × midRate × 1.02 < 1억`(토스의 실제 환산율이 다를 수 있어 2% 여유). 매수는 거부, 매도는 `planSellTranches`로 `maxQuantityBelowValue`(`src/lib/algo`) 단위로 나눠 각 분할을 따로 검사한다. 분할은 **최대 50개**이고 더 필요하면 `ORDER_TOO_LARGE`로 거부한다. 한 종목에는 한 번에 미체결 주문 하나만 허용하므로 첫 분할만 나가고 나머지는 `OPEN_ORDER_EXISTS`로 보류되어 이후 판단 때 나간다.
- 비용: 수수료율은 `/commissions`에서 시장·날짜에 맞는 항목을 고르고 여러 개면 가장 큰 값을 쓴다. 국내는 거래세율 설정(`sellTaxRate`)이 없으면 0으로 가정하지 않고 거부한다. 왕복 비용은 `roundTripCostRate`(= 2 × 수수료 + 거래세)다. 양도소득세는 비교에 넣지 않는다(7b 시뮬레이션과 같다).
- 미국: 달러 현금만 본다(`GET /buying-power?currency=USD`만 호출한다). 환전 호출은 없다. 달러가 모자라면 거부하고 알린다.
- **환율 점검(미국)**: `midRate`는 상식적인 범위(기본 300~5000 원/달러, `fxBand`)에 있어야 하고(아니면 `FX_RATE_INVALID`), 관측 시각(`fxObservedAt`, `/exchange-rate`의 `validFrom`)이 6시간(`maxFxAgeHours`) 이내여야 한다(없거나 오래되었거나 미래이면 `FX_RATE_STALE`, 값이 없거나 0 이하이면 `FX_RATE_MISSING`). 틀린 자릿수의 환율이 1억 원 상한을 우회하지 못하게 하는 점검이다. 분할 계획과 호가 보정 검문도 같은 범위를 쓴다.

## 실행기 (`executor.ts`)

`LiveOrderExecutor.executeRun({runId, algorithm, decisions, data})`는 결정마다 차례로 처리한다.

0. **실행 임대(lease)**: `executeRun`은 먼저 알고리즘별 임대(`tradingRunLeases/{알고리즘}`, 기본 10분)를 잡는다. 다른 실행이 살아 있는 임대를 쥐고 있으면 아무것도 하지 않고 `leaseHeld`와 결정별 `RUN_IN_PROGRESS`(건너뜀)로 끝난다. 같은 실행 ID는 다시 잡을 수 있고(재시작), 끝나면(예외 포함) 풀며, 죽은 실행의 임대는 만료로 풀린다.
1. 시작 때 `reconcile`을 읽기 전용으로 한 번 돌린다(실패해도 계속하지만, 풀리지 않은 주문은 사전 검사에서 막힌다).
2. 결정을 주문으로 바꾼다. 가격을 덜 공격적으로 정규화하고, 매도가 상한을 넘으면 분할한다.
3. 주문마다 `data.marketFacts`(현재가를 그때 새로 받는다), 누적 손익, 예상 이익 통계를 받아 `preTradeCheck`를 부른다.
4. 거부되면 사유 코드와 함께 `blockedOrders`에 기록하고(카운터는 쓰지 않는다) 알린다. 단 "기록 부족" 같은 일상적 보류, 긴급 정지·알고리즘 정지, 진행 중 주문은 알리지 않는다. `autoStop`이면 알고리즘을 정지하고 `algorithm-auto-stop`(`loss-limit`)을 보낸 뒤 이번 실행의 나머지 주문은 건너뛴다.
5. 통과하면 **슬롯 예약**을 한다. 한 트랜잭션에서 긴급 정지, 알고리즘 상태, 하루 카운터 두 개, 같은 키의 문서, **(알고리즘, 종목) 잠금**과 그 잠금을 쥔 주문, **알고리즘의 모든 주문(장부)**을 읽고 모두 통과해야 카운터를 올리고, 잠금을 잡고, `reserved` 기록을 만든다. 잠금이 살아 있으면 `OPEN_ORDER_EXISTS`/`UNRECONCILED_ORDER`, 장부로 다시 계산한 매수 예산 초과는 `BUDGET_EXCEEDED`, 매도 수량이 소유 수량(작업 중 매도 제외)을 넘으면 `SELL_EXCEEDS_OWNED`로 거부한다. 이 기록은 요청을 보내기 **전에** 남는다(write-ahead). 같은 키의 기록이 있으면 `duplicate`로 건너뛴다. 실행 ID가 다른 겹친 실행, 재시작, 중복 실행이 같은 주문을 다시 내거나 예산·보유 수량을 두 번 쓰지 못한다.
6. 주문을 낸다. 결과에 따라 기록을 갱신한다: `accepted`(+`orderId`, 보정되었다면 보낸 키와 가격), `rejected`(+정리된 오류), `unknown`(+정리된 오류). 기록 갱신이 실패하면 `reserved`로 남고(다음 주문을 막는다) 결과에 `recordError`가 표시된다.
7. 알림은 주입한 `TradingNotifier.notify(event)`로 보내며, 상황을 이벤트로 바꾸는 매핑은 `alerts.ts`의 `liveAlertEvent` 한 곳에만 있다(`src/server/notify.ts`의 `NotificationEvent`는 `import type`으로만 쓴다). 알림 실패는 삼키고 거래 판단을 막지 않는다.

### 첫 실전 주문과 권한

- 첫 주문 판정: 그 알고리즘에 `accepted`, `unknown`, `partially-filled`, `filled` 기록이 하나도 없으면 첫 주문이다.
- `POST /orders`가 **401 또는 403**이면 몇 번째 주문이든 알고리즘을 정지하고(`order-permission`) `order-rejected`(증권사 거부)와 `algorithm-auto-stop`을 보낸다. 이 실행의 나머지 주문은 건너뛴다.
- **첫 주문**이 다른 확정 거부(예: `prerequisite-required`, `insufficient-buying-power`)를 받아도 정지한다(`first-order-rejected`, 7f의 "첫 실전 주문 거부 감시"). 단 `rate-limit-exceeded`는 일시적이라 제외한다. 첫 주문 이후의 일반 거부는 기록과 알림만 한다.
- `unknown` 결과는 거부가 아니다. 이 알림은 지금은 `job-failure`(`live-order-unconfirmed`)로 간다(전용 종류는 7e가 `notify.ts`에 추가하고 `alerts.ts`만 고친다). 같은 종목의 새 주문은 `UNRECONCILED_ORDER`로 막힌다.
- **로컬 입력 오류**(`OrderInputError`: 아무것도 보내지 않았다)는 증권사 거부가 아니다. 기록은 `rejected`/`input-invalid`로 남기지만 첫 주문 거부로 세지 않고, 알고리즘을 정지하지 않으며, `order-rejected` 대신 `job-failure`(`live-order-input-invalid`)로 알린다.

### 미체결·체결 동기화 (`reconcile`)

`GET /orders/{orderId}`로 `accepted`/`partially-filled` 기록을 갱신한다(`FILLED`, `PARTIAL_FILLED`, `CANCELED`·`REPLACED`, `REJECTED`만 상태를 바꾸고 나머지는 유지). 체결 수량과 평균 체결가를 기록하고, `partially-filled`/`filled`로 **처음** 바뀔 때 `fill` 알림을 한 번만 보낸다(`notifiedStatus`로 중복 방지). `orderId`가 없는 `unknown`/`reserved`는 위에서 설명한 유일 일치일 때만 이어받는다. DAY 주문이 장 마감에 자동 취소되면 `canceled`로 닫혀 종목이 풀린다. **실행 전마다 이 동기화가 필요하다**(`executeRun`이 시작할 때 부른다).

## 저장소 (`stores.ts`, `firestore-store.ts`)

- 인터페이스 `TradingStore`: `getEmergencyStop`, `isAlgorithmStopped`, `stopAlgorithm`, `getDailyCounts`, `reserveOrder`(원자적), `updateOrder`(상태 전이 검증), `getOrder`, `listOrders`, `listNonTerminalOrders`, `recordBlocked`. 사전 검사에는 읽기 전용 부분 `PreTradeStore`만 준다.
- 상태: `reserved → accepted | rejected | unknown`, `unknown → accepted | rejected | partially-filled | filled | canceled`, `accepted → partially-filled | filled | canceled | rejected`, `partially-filled → filled | canceled | rejected`. `rejected`, `filled`, `canceled`는 끝 상태이며 나갈 수 없다. 어긋난 전이는 던진다.
- 장부 계산(`summarizeLedger`)은 알고리즘 자신의 주문 기록에서 보유 수량, 평균 원가 기반 보유 원가, 진행 중 매수 금액, 진행 중 매도 수량, 마지막 매수일을 구한다. 사전 검사의 "알고리즘이 산 수량"과 예산 누적이 이것이다.
- 하루 카운터는 **KST 날짜** 기준이다. 예약 때 증가하고 나중에 거부되어도 되돌리지 않는다(연속 실패의 안전망이기도 하다). 미국 장도 KST 22:30 이후 한 번만 판단하므로 같은 날짜에 들어간다.
- Firestore 구현은 서버 전용 컬렉션을 쓴다(클라이언트 접근은 기존 Firestore 규칙이 막는다): `liveOrders/{clientOrderId}`, `algorithmControl/global`(`{emergencyStop, updatedAt}`: **화면의 긴급 정지 버튼이 쓰는 바로 그 문서**, 모의 작업도 이것을 읽는다. 문서가 없으면 정지 아님, `emergencyStop`이 불리언이 아니면 던진다), `tradingAlgorithmState/{algorithmId}`, `tradingCounters/{날짜}_global`·`{날짜}_a_{algorithmId}`, `tradingSymbolLocks/{algorithmId}_{종목}`(주문이 끝날 때까지 잡고 있는 잠금, 종료 상태로 바뀌는 같은 트랜잭션에서 지운다. 주인 주문이 종료 상태이면 낡은 잠금으로 보고 덮어쓰며, 주인 문서가 없으면 미확인으로 막는다), `tradingRunLeases/{algorithmId}`(`{runId, expiresAt}`), `blockedOrders/{id}`. 예약은 한 `runTransaction` 안에서 모든 읽기(알고리즘 주문 질의 포함)를 한 뒤 쓴다. 문서 ID는 정규식으로 검증한다(경로 주입 방지, 종목은 점만으로 된 값도 거부). 저장된 문서가 형식에 맞지 않으면 잘못된 값을 조용히 쓰지 않고 오류로 처리한다. `liveOrders`의 알고리즘별 조회와 `status in` 조회는 단일 필드라 복합 색인이 필요 없다. 테스트는 낙관적 동시성(읽은 문서나 질의한 컬렉션이 바뀌면 재시도)을 흉내 내는 가짜 Firestore로, 실행 ID가 다른 동시 예약이 같은 종목·예산·보유 수량을 두 번 쓰지 못함과 한도를 넘지 못함을 확인한다. 실제 Firestore에는 연결하지 않았다.

## 읽기 전용 권한 확인 (`access-check.ts`)

`checkOrderAccess(api)`는 `GET /buying-power`(KRW, USD), `GET /commissions`, `GET /orders?status=OPEN`만 차례로 부르고 각각 `{ok, code?, status?}`와 `allOk`, `permissionDenied`를 돌려준다(설계 주문 권한 확인 1). 매개변수 타입이 읽기 메서드만 포함하므로 쓰기 메서드를 부를 수 없고, 테스트는 어떤 응답에서도 POST가 전송 계층에 닿지 않음을 확인한다. 금액, 수수료율, 주문 내용, 계좌 식별값, 제공자 문구는 결과에 넣지 않는다. 이 함수를 고정 출구 IP 일회성 작업으로 실행하는 일은 7e/7f 연결 단계에서 한다.

## 연결 (7e/7f)

### 전송 계층 (`toss-transport.ts`, `TossClient.authorizedRequest`)

`TossClient`에 공개 메서드 `authorizedRequest(요청, {timeoutMs, maxBytes})`를 하나 더했다. 기존 `request`/`get`의 동작은 바꾸지 않았다. 고정 호스트, 베어러 토큰 + `X-Tossinvest-Account`, 시간 제한(기본 8초), `redirect: 'error'`, 응답 크기 상한(기본 1 MiB)을 지키고, **HTTP 오류 상태도 본문과 함께 돌려주며**(호가 단위 `data`를 주문 클라이언트가 읽으려면 필요하다), `Retry-After`를 파싱하고, 전역 쿨다운을 만들지 않고, 재시도하지 않는다. 연결 실패·시간 초과·큰 응답·토큰 발급 실패는 URL·헤더·본문이 없는 고정 문구의 `ProviderError`로 던진다.

`TossOrderTransport`는 이것 위에서 `OrderTransport`를 구현한다. 응답이 없을 때만 `TransportNetworkError`를 던진다. **허용 목록**(`transportAllows`)에 없는 요청은 토큰을 요청하기 전에 거부한다: 읽기는 `/orders`, `/orders/{id}`, `/buying-power`, `/sellable-quantity`, `/commissions`, `/stocks/{symbol}/warnings`, `/price-limits`, `/exchange-rate`, `/prices`이고 쓰기는 `POST /orders`(주문 생성) 하나다. 취소 경로와 토큰 경로는 목록에 없다(실전 흐름 어디도 주문을 취소하지 않는다). 호출 사이 최소 120 ms 간격을 둔다. `readOnly: true` 옵션은 GET 외 모든 요청을 거부한다(읽기 전용 확인 작업이 이것을 쓴다). 주문 ID 경로 조각은 `=`(`%3D`) 외의 퍼센트 인코딩을 허용하지 않는다(인코딩된 `.`·`/`로 경로를 바꾸는 시도 차단). `TossClient.authorizedRequest`도 `%2e`·`%2f`·`%5c`·`%00`을 거부한다. 본문·헤더·토큰·계좌 식별값은 어디에도 기록하지 않는다. 계좌 헤더는 허용된 모든 요청에 붙는다(포트 계약). 가격 제한·종목 유의사항처럼 계좌가 필요 없다고 문서에 적힌 엔드포인트에 붙여도 되는지는 실호출로 확인하지 않았다.

### 실전 작업 (`src/jobs/algo-live.ts`, 운영 절차는 [jobs.md](../operations/jobs.md#실전-작업-algo-live-7f))

1. 설정 검사: `LIVE_TRADING_ENABLED`가 정확히 `true`가 아니면 아무것도 하지 않고 종료 코드 2(**배포 킬 스위치, 화면과 무관**). production·Cloud Run Job·프로젝트·토스·시장·텔레그램 설정과 `APP_ORIGIN`도 필수다. 개장 창이나 안전장치를 환경 변수로 넓히는 길은 없다.
2. 달력으로 오늘이 정규장 개장 직후(20분)인지 판단한다(모의 작업과 같은 `selectSessionToTrade`, 서머타임·휴장·단축일은 달력 데이터). 실행 기록 `algorithmRuns/live_{시장}_{날짜}`로 같은 날 중복 실행을 막는다.
3. **먼저 모든 비종료 주문을 동기화(`reconcile`)**한다. 체결이 알고리즘의 보유 수량을 바꾸기 때문이다. `orderId`가 없는 `unknown`·`reserved` 주문은 `GET /orders?status=OPEN`과 그 종목의 `GET /orders?status=CLOSED&symbol=&limit=100`(문서화된 매개변수만, 최대 3쪽) 후보에서 **종목·방향·수량·가격이 같고 `orderedAt`이 기록 시각 이후인 유일한 주문**일 때만 이어받는다(목록에 `clientOrderId`가 없다). 체결·취소·만료·거부 어느 쪽이든 이어받은 뒤 상태가 따라간다. 후보가 둘 이상이거나 비슷하기만 하면 이어받지 않는다.
4. 실전 모드이고 시장이 맞는 알고리즘마다: 긴급 정지를 **새로 읽고**(읽지 못하면 `failed`로 보고되어 작업 실패 알림이 간다. 알고리즘 정지 상태를 읽지 못해도 같다), 알고리즘 정지 상태·운용 금액·가치 신호(재무 어댑터가 없어 실전 불가)·AI 승인 여부를 본 뒤, **접수 여부 미확인 주문이 한 세션(KST 날짜) 넘게 남았으면 그 알고리즘을 `unconfirmed-order` 사유로 정지하고 알린다**(묶인 운용 금액이 영원히 풀리지 않는 것을 막는다). 이어서 **누적 손실 정지를 매 실행·알고리즘마다 의도를 만들기 전에 평가**한다(보유 종목의 지금 시세로 평가한 실현+평가 손익이 `손실 정지 비율 × 운용 금액`에 닿으면 주문이 하나도 없는 날에도 `loss-limit`으로 정지하고 알린다. **정지는 자동 매도를 하지 않는다**: 알림과 화면이 남은 보유분은 직접 관리하라고 안내한다). 평가가격을 구하지 못한 보유 종목이 있으면 손익이 `null`이라 주문하지 않는다(**오래된 종가로 대신하지 않는다**: 평가가격은 주문 시점 시세, 없으면 이번 판단 시세만 쓴다). 그다음 모의 작업과 같은 입력(`prepareDecisionInputs`: 신호·일봉·수급·현재가)과 같은 판단 함수(`decideSymbols`)로 판단한다.
5. `buildLiveDecisions`가 판단을 주문 의도로 바꾼다. 매도는 알고리즘이 산(그리고 이미 매도 주문에 넣지 않은) 수량 전부, 매수는 점수 순서로 `운용 금액 × 종목 비율`과 남은 한도 안에서 수량을 정한다. 가격은 판단 시점 현재가다(지정가, 더 공격적이지 않음). 이것은 안전장치를 하나도 검사하지 않는다.
6. `LiveOrderExecutor.executeRun`: 주문마다 주문 직전 사실을 **새로** 받는다(`/prices` 현재가와 관측 시각, 직전 거래일 일봉, 최근 20거래일 평균 거래대금, 미국은 `/exchange-rate`의 `midRate`와 시각, 누적 손익, 점수 구간 통계). 그다음 `preTradeCheck` → 원자적 예약 → 주문 → 기록 → 알림. 긴급 정지는 알고리즘마다, 그리고 실행기가 주문 직전·재시도마다 다시 읽는다. 또한 **주문마다 실행 가드**(`LiveRun.guard`)가 알고리즘이 아직 실전 모드인지 다시 읽고(`ALGORITHM_NOT_LIVE`) 개장 후 창(개장 + 20분 + 10분 여유)이나 장 마감이 지났으면 거부한다(`RUN_WINDOW_CLOSED`, 가드 읽기 실패는 `STORE_UNAVAILABLE`). 이 거부는 기록만 하고 알리지 않는다.
7. 결과를 실행 기록에 쓰고 하트비트(`tradingStatus/liveJob_{시장}`)를 남긴다. 화면은 이 하트비트로 "실전 일정이 꺼져 있음"을 알린다.

입력 출처 정리: 수수료율은 토스 `/commissions`의 활성 항목 중 가장 높은 값(읽지 못하면 매수 보류), 국내 거래세율은 수수료·세금 설정의 `sellTaxRate`(없으면 국내 매수 보류 `COST_SETTINGS_MISSING`), 점수 구간 통계는 모의 장부 시작일 이전 시뮬레이션 + 모의 왕복 기록(없으면 "기록 부족으로 주문 보류"), 누적 손익은 라이브 주문 기록에서 계산(`ledger-pnl.ts`: 체결 평균가 기준 현금 흐름 + 보유분 평가, 수수료·세금은 추정, 평가가격이 없으면 `null`이라 주문하지 않음), `tradingDaysSince`는 이 알고리즘 일봉의 날짜 합집합으로 센다(모의·시뮬레이션과 같은 "완료된 봉 + 오늘" 규칙). AI형은 `ALGO_AI_ENABLED=true`이고 판단기가 있을 때만 돈다(배포는 `false`). AI의 예상 수익률 범위 중간값을 점수 구간 통계 대신 쓰는 합성 통계로 주문 직전 검사에 넘긴다.

### 읽기 전용 확인 작업 (`src/jobs/order-access-check.ts`)

`checkOrderAccess`만 실행한다(`GET /buying-power` KRW·USD, `/commissions`, `/orders?status=OPEN`). 로그에는 상태 단어(`all-ok`/`denied`/`failed`), 성공·실패 개수, 대문자 코드만 남기고, 같은 내용(불리언·정리된 코드·시각)을 `tradingStatus/accessCheck`에 저장해 화면이 보여 준다. 응답 본문·금액·계좌 식별값은 저장도 출력도 하지 않는다. 이 파일에는 쓰기 경로가 없다(정적 테스트).

### 화면 API (`src/server/live.ts`)

`GET /api/algorithms/:id/live`(소유자 전용): 실전 켜기 조건(`enable.blockers`), 모의 요약, 긴급 정지·알고리즘 정지, 주문 권한 확인 결과, 실전 작업 하트비트, 보유(라이브 장부), 주문 40건, 보류·차단 기록 25건. 주문은 고정 필드로만 투영하고 오류는 정리된 코드와 한국어 문장으로만 낸다. `POST /api/algorithms/:id/live/release-stop`: 자동 정지 해제(위험을 늘리는 변경이라 텔레그램 알림 + 변경 이력). `unknown` 주문은 화면이 "접수 여부 미확인"으로 알리고 앱에서 확인하라고 안내한다.

### 남은 한계

- `unknown` 주문(응답 유실): 동기화가 미체결·종결 주문에서 유일한 일치를 찾아 이어받고, 못 찾으면 같은 알고리즘·종목의 새 주문이 막힌다. 소유자는 토스증권 앱에서 확인한 뒤 화면의 **"미확인 주문 정리"**(`POST /api/algorithms/:id/live/orders/:orderId/resolve`)로 결과(체결+수량·평균가 / 취소 / 접수되지 않음)를 기록한다. 증권사에는 아무것도 보내지 않고, 장부가 갱신되고 종목 잠금이 풀리며 변경 이력과 텔레그램 알림(`live-order-resolved`)이 남는다. 수량이 주문보다 적은 체결은 체결 부분을 남기고 나머지를 취소로 기록한다. 한 세션이 지나도 정리되지 않으면 알고리즘이 자동 정지된다(위 4단계).
- 체결 마커(`liveOrders` → 차트)는 다음 실행의 동기화가 체결을 기록한 뒤에야 보인다(실행 사이의 체결은 반영이 늦다). 알려진 한계.
- AI형의 "켜짐" 여부는 작업 자신의 `ALGO_AI_ENABLED`(배포는 `false`)만 확인한다. 화면 쪽 `aiEnabled`는 환경 설정을 그대로 비추는 값이라 두 곳이 어긋날 수 있다. 알려진 한계(AI는 꺼진 채로 배포한다).
- 토큰을 주문 직전에 받지 못하면 전송 계층은 "응답 없음"으로 처리해 주문이 `unknown`이 될 수 있다(실제로는 아무것도 보내지 않았다). 같은 작업에서 직전 읽기가 같은 토큰을 이미 쓰므로 드물다.
- `blockedOrders`·`liveOrders` 보존 기간은 정하지 않았다(TTL 없음).
- 호가 단위는 여전히 400으로 배운다(국내 첫 시도가 한 번 더 걸릴 수 있다).

## 실제 주문 전 확인

감독자와 사용자가 실전을 켜기 전에 직접 확인한다. 하나라도 아니면 켜지 않는다.

1. `npm run check`와 `tests/trading-*.test.ts`가 통과한다. 정적 테스트가 `confirmHighValueOrder` 문자열 부재, LIMIT·DAY 고정, POST 두 곳(생성·취소), 미연결 상태를 확인한다.
2. 연결 PR에서 `OrderTransport` 구현이 재시도하지 않고 오류 본문을 보존하며 토큰·계좌 식별값을 로그에 남기지 않는지 검토한다.
3. 고정 출구 IP 일회성 작업에서 `checkOrderAccess`가 `allOk`이고 `permissionDenied`가 `false`다(응답 원문 출력 없음). 사용자가 WTS 설정 > Open API 화면에서 주문 관련 설정을 확인했다.
4. 명세가 바뀌지 않았다: `openapi.json` 버전이 v1.2.24이거나, 바뀐 부분(주문 요청, 오류 코드, 호가 단위 `data`)을 다시 읽고 이 문서를 고쳤다.
5. 긴급 정지: 화면 버튼(`AlgorithmRepository.setControl`)과 주문 경로(`FirestoreTradingStore`)가 같은 문서 `algorithmControl/global`을 쓰고 읽는다(테스트가 두 구현을 같은 가짜 Firestore에 물려 확인하고, 두 모듈이 같은 컬렉션·문서 이름을 쓰는지 정적으로 검사한다). 정지를 켠 뒤 다음 주문이 나가지 않는 것은 단위 수준(가짜 서버)으로 확인했다. **운영 문서로는 확인하지 않았다.**
6. 세금 설정(`sellTaxRate`)과 수수료율이 현재 값이다. 운용 금액 한도(알고리즘별, 통화별)를 작게 입력했다. 첫 실전은 작은 금액으로 사용자가 직접 켠다.
7. 텔레그램 알림이 도착한다(주문 거부, 알고리즘 자동 정지, 체결). 알림 실패가 주문을 막지 않는 것은 테스트로 확인했다.
8. Firestore 규칙이 새 컬렉션(`liveOrders`, `algorithmControl`, `tradingAlgorithmState`, `tradingCounters`, `tradingSymbolLocks`, `tradingRunLeases`, `blockedOrders`, `tradingStatus`)의 클라이언트 접근을 막는다.
9. 시장 캘린더 기반 `tradingDaysSince`, 직전 거래일 일봉 날짜, 환율(`midRate`)이 실제 값으로 들어온다. 평균 거래대금(20거래일), 현재가 관측 시각, 누적 손익이 사실과 맞는지 샘플로 대조했다.
10. 첫 실전 주문 뒤 `liveOrders` 기록, `reconcile` 결과, 텔레그램 알림이 서로 맞는지 사용자가 확인한다. 거부되면 알고리즘이 정지되었는지 확인한다.
