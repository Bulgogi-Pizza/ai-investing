# 자산 및 전략 — PORT / STRAT

## 구현

`src/features/portfolio.tsx`: 토스증권에서 조회한 주식 잔고(국내 KRW·해외 USD 평가금액·매입금액·평가손익, 종목별 수량·현재가·평가금액·손익·수익률)와 목표 비중 편집기. 예시 보유 종목, DEMO 표시, 합성 총자산·도넛·스트레스·리밸런싱 금액은 제거했다. 소득·자산 등 개인 정보를 브라우저 저장소에 보관하지 않는다. 평가금액 숨김은 표시 기능이며 서버 접근 통제를 대체하지 않는다.

## API 경계와 상태

- `GET /api/portfolio`: 로그인 + **소유자 검사**(`requireOwner`, 서버). 토스 클라이언트도 소유자를 다시 검사한다. 성공 시 `source`, `asOf`(KST 표시)와 함께 통화별 원래 단위로 표시하며 합산·환산하지 않는다. `scope:'stocks-only'`이므로 현금·채권·금·다른 계좌는 포함하지 않고 전체 자산 비중이나 리밸런싱 금액을 계산하지 않는다. 공식 `profitLoss.rate`는 비율(0.1077)이라 화면은 100을 곱해 10.77%로 표시한다.
- 상태는 공통 컴포넌트가 구분한다: 503 `TOSS_INTEGRATION_UNAVAILABLE` 토스 미연결, 403 `OWNER_REQUIRED` 소유자 전용 안내(다른 등록 계정은 이 안내만 본다), 보유 종목 0개는 "보유 중인 주식이 없습니다", 그 밖의 오류는 경고 + 다시 시도. 어떤 경우에도 예시 자산으로 대체하지 않는다.
- 전략 편집도 소유자 전용이다(`GET/PUT /api/strategy`에 소유자 검사). 소유자가 아니면 403 `OWNER_REQUIRED`이고 화면은 편집기 대신 소유자 전용 안내만 보인다. `GET /api/strategy`로 읽고 `PUT /api/strategy`에 `{strategy:{name,horizon,benchmark,riskTolerance,targetAllocations,notes}}`를 보낸다. 실제 계좌·주문은 변경하지 않는다. 자산 데이터를 받지 못해도(미연결·일시 오류) 소유자는 전략 편집이 가능하다.

## 규칙 및 한계

`src/lib/strategy.ts`에서 목표 비중 각 0~100 및 합100% 검사(새 전략 입력 초기값 유지). 투자성향·기간·벤치마크·선호는 저장 가능하나 수익률 비교 계산이나 자동 주문과 연결되지 않는다. 실계좌 연결 검증 상태의 원본은 [상태 SOT](status.md)다.

## 검증

- `tests/strategy.test.ts`: 비중 유효성, 리밸런싱 총액 보존, 잘못된 입력 거절, 방어 배분 합계 보존.
- `tests/app.spec.ts`(가짜 API): 실잔고 표시·통화 분리·수익률 퍼센트 변환·숨김, 전략 검증과 저장, 소유자 전용·미연결·빈 보유·일시 오류 상태, 예시 문구 부재.
- `tests/market-api.test.ts`/`tests/server.test.ts`/`tests/toss.test.ts`: 소유자 격리, 계약.
- `npm test`, `npm run build`, `npm run test:e2e`. 합성 fixture는 실계좌 검증이 아니다.
