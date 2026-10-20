# 금융 서비스 연결

SOT: 요구사항 PORT/STRAT/REC. 서버 구현 `src/server/toss.ts`, `src/server/app.ts`. 공식 계약: [Toss Securities OpenAPI v1.2.24](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json), 확인2026-10-20 KST. fixtures는 공식 withHoldings 예시의 합성 수치이며 고객 데이터가 아니다. Toss Payments API를 사용하지 않는다.

## 연결 상태와 환경변수

읽기 전용 어댑터와 계약 fixture 테스트를 구현했다. 실제 계좌 연결은 아직 검증하지 않았다. 서버 환경변수 TOSS_CLIENT_ID, TOSS_CLIENT_SECRET, TOSS_ACCOUNT_SEQ, TOSS_OWNER_USER_ID 네 가지가 모두 있어야 켜진다. 네 값의 저장과 서비스 연결 절차는 [토스 키 입력 및 계좌 연결](../operations/toss-setup.md)을 따른다. 이 변수들을 브라우저 빌드 변수(VITE_*)에 넣지 않는다. 누락 시 API503, 소유자와 다른 로그인 계정의 자산 요청은403이며 제공자를 호출하지 않는다. 동일 자격증명을 여러 웹 계정에 공유하지 않는다.

공식 토큰 API는 등록된 IP에서만 허용된다. Cloud Run 동적 외부IP로는 운영할 수 없다. 고정 공인IP + Cloud NAT + VPC egress 경로를 구성하고 토스 WTS 설정 > Open API > 허용 IP 관리에 해당IP를 등록해야 한다. 고정 egress 비용은 Cloud Run 비용과 별도다. 네트워크 경로/허용IP 설정 전 실제 연결 완료로 표시하지 않는다.

## 공식 요청

POST `/oauth2/token`은 application/x-www-form-urlencoded의 grant_type=client_credentials, client_id, client_secret를 보낸다. refresh token이 없고 재발급하면 기존 access token이 즉시 무효화된다. 운영에서는 Firestore providerTokens/{client-id-sha256} 문서에 토큰/만료/갱신lease를 보관하고 트랜잭션으로 여러 인스턴스와 배포revision의 발급을 조율한다. 해당 컬렉션은 bearer 비밀을 포함하므로 브라우저 SDK 접근을 금지하고 서버 IAM만 허용한다. Firestore의 저장암호화가 적용된다. 갱신 임계는 만료60초 전이며 발급 lease는60초다. 발급 실패/불확실 응답은 즉시 반복하지 않으며 lease가 끝날 때까지 기다린다. 개발과 테스트는 메모리 singleflight를 사용한다. 공급자401/403에도 자동 재발급을 반복하지 않는다. 외부에서 같은 client 토큰을 별도로 발급하면 캐시가 무효화될 수 있으므로 그 작업을 중단하고 운영자가 토큰 캐시를 조정해야 한다.

GET `/api/v1/accounts`에서 설정된 accountSeq의 BROKERAGE 계좌가 존재하는지 확인한 뒤 GET `/api/v1/holdings`에 Bearer와 X-Tossinvest-Account를 보낸다. 계좌번호/계좌식별자는 HTTP 응답에 포함하지 않는다. 요청 제한시간8초, 응답최대4MiB, redirect 금지, 오류본문 숨김,429 Retry-After 최대3600초와 인스턴스 cooldown을 적용한다. 계좌와 조회결과는30초 메모리 캐시, 동일조회 singleflight, 최대100 캐시항목/32 진행조회로 제한한다. 운영 scale-out 시 각 인스턴스의 조회 캐시는 별개다.

## 웹 API 계약

- `GET /api/portfolio`: 인증+소유자 검사. `{source,asOf,scope:'stocks-only',totals:{KRW:{marketValue,purchaseAmount,profitLoss},USD:{동일}},holdings:[{symbol,name,market,currency,quantity,lastPrice,averagePurchasePrice,marketValue,profitLoss,profitLossRate}]}`. 금액/수량/비율은 정밀도 보존용 십진문자열. 통화별 요약은 null이 가능하다. asOf는 서버 조회시각이며 체결시각이 아니다. API는 국내/미국 주식만 포함하므로 현금·채권·해외옵션·전체 순자산으로 표시하지 않는다. KRW와 USD는 환율 없이는 합산하지 않는다. profitLossRate는 비율(0.1=10%)이다.
- `GET /api/market/candles?symbol=005930&interval=1d&count=100`: 인증+소유자 검사(아래 "소유자 전용 API"), interval1m/1d, count1–200, 심볼 영숫자/점/하이픈 최대30자. 공식 `/api/v1/candles` 수정주가 기준 조회. `{source,asOf,symbol,interval,adjusted:true,candles:[{timestamp,open,high,low,close,volume,currency}]}`. 수치는 십진문자열이며 과거→최신으로 정렬한다. pagination은 아직 웹API에 노출하지 않는다.
- `GET /api/recommendations`: 인증·소유자·저장 전략 필수. 토스 일봉·주식 잔고·등록 일정 기반 rules-v1 분석을 반환한다. 전략없음409, 제공자미설정503, 소유자외403. 선택적 Vertex 해설과 관리자 실행 공식 RSS 수집을 연결한다. 예약 뉴스 수집은 구성하지 않았다. 상세는 recommendation-engine.md 참조.
- `GET /api/strategy`: `{strategy:null}` 또는 계정별 전략. `PUT /api/strategy`는 `{strategy:{name,horizon,benchmark,riskTolerance,targetAllocations,notes}}`. name/horizon/benchmark/notes는 문자열, riskTolerance는 low/medium/high, targetAllocations는 `{asset:string,percentage:number}[]`. 중복 자산 금지, 합계100%, 각 비중0–100, 최대30개. 서버에서 검사하고 허용 필드만 저장한다.

운영 전략은 Firestore strategies/{userId}에 저장한다. 브라우저 데모 전략은 메모리 전용이며 실제 계정 API에 저장하지 않는다. 주문은 [next-phase-design.md](../planning/next-phase-design.md) 4절의 조건부 허용 규칙을 따르며 주문 엔드포인트는 아직 구현되지 않았다.

## 최초 계좌 식별값 연결 작업

`src/server/toss-setup.ts`는 웹 엔드포인트가 아닌 일회성 Cloud Run Job 진입점이다. 명령은 `node --import tsx src/server/toss-setup.ts`다. `NODE_ENV=production`, 명시적 `GOOGLE_CLOUD_PROJECT`, Secret Manager에서 주입한 `TOSS_CLIENT_ID`/`TOSS_CLIENT_SECRET`가 필요하며 Cloud Run이 제공하는 `CLOUD_RUN_JOB`도 확인한다. 로컬 실행이나 기본 프로젝트로의 자동 대체는 허용하지 않는다. Job은 서비스와 같은 고정 NAT 경로 및 같은 Firestore `providerTokens` 캐시를 사용하여 토큰 재발급으로 기존 서비스 토큰을 무효화하지 않도록 한다.

공식 `/api/v1/accounts`를 Bearer만으로 조회한다. 공식 정수형 `accountSeq`가 양의 안전 정수이며 최대15자리인 `BROKERAGE` 계좌가 정확히 하나인 경우에만 진행한다. 계좌 없음·다중 거래 계좌·잘못된 응답은 실패 처리한다. 응답 원본, 계좌번호, 식별값을 로그나 웹 응답에 출력하지 않는다. 발견한 식별값은 런타임 서비스 계정의 ADC로 Secret Manager의 고정 이름 `investing-toss-account-seq`에 새 버전으로 저장한다. IAM은 이 단일 비밀에 대한 버전 추가 권한과 공용 토큰 캐시 접근만 부여한다. 다른 비밀 이름/프로젝트는 요청 입력으로 받지 않는다. Secret Manager 요청은8초 제한, redirect 금지이며 응답 본문은 읽지 않는다.

성공 로그는 `{accountDiscovered:true,accountSeqStored:true}`만 남긴다. 실패는 `{code:고정코드}` 한 필드만 출력한다. `PROVIDER_ACCESS_DENIED`(인증/허용IP), `PROVIDER_ACCOUNT_UNAVAILABLE`(거래 계좌 없음), `PROVIDER_ACCOUNT_SELECTION_REQUIRED`(다중 거래 계좌), 제한·통신·응답검증·토큰lease의 명시적 허용목록 코드만 통과시키며, 비밀 저장 실패는 `TOSS_SETUP_SECRET_STORE_FAILED`, 그 외는 `TOSS_SETUP_FAILED`다. 공급자가 보낸 임의 code/message/body와 스택은 기록하지 않는다. 작업 성공 후 서비스에 계좌 비밀과 소유자 사용자ID를 주입하고 인증된 자산 조회를 별도 검증해야 실제 연결이 완료된다. 다중 계좌일 때는 식별값을 로그에 나열하지 않고 운영자의 안전한 선택 절차를 마련해야 한다.

검증: `npx vitest run tests/toss.test.ts tests/toss-setup.test.ts`. 단일 거래 계좌의 식별값 최소화, 계좌 헤더 미전송, 빈/다중/손상 응답 거부, 고정 비밀 경로, 잘못된 프로젝트/실행 환경 거부, 오류 메시지 비밀 제거를 합성 fixture로 검사한다. 이 테스트는 실제 토스/Google API를 호출하지 않는다.

검증: `npx vitest run tests/toss.test.ts tests/server.test.ts tests/auth.test.ts`. 공식 응답fixture, 헤더/인증본문, 통화분리, 소유자격리, 토큰경합/lease, 오류비밀제거, 조회캐시, 쿼리검증을 검사한다. 실키·실계좌·실거래는 테스트에 사용하지 않는다.

## 실제 데이터 기반 추천 갱신

`GET /api/recommendations?period=daily|weekly|monthly&symbol=005930`는 저장된 전략·토스 일봉·주식 잔고·출처 등록 일정으로 rules-v1 분석을 반환한다. 전략없음409, 제공자미설정503, 연결소유자외403. 상세 계약은 recommendation-engine.md 참조. 선택적 Vertex 해설 및 관리자 실행 한국은행·연준 RSS 수집의 계약은 ai-provider.md/news-provider.md를 따른다. 실제 연결 상태는 status.md가 원본이다.

## 소유자 전용 API와 시장 데이터 어댑터 (3단계)

확인: [Toss Securities OpenAPI v1.2.24](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json) `info.version` 1.2.24, 2026-10-21 KST에 `/api/v1/prices`, `/api/v1/market-indicators/prices`, `/api/v1/exchange-rate`와 Market Indicators 심볼 카탈로그를 다시 읽고 구현했다. 명세에 없는 필드는 만들지 않았다. 테스트 fixture(`tests/fixtures/toss-prices.json`, `toss-market-indicators.json`, `toss-exchange-rate.json`)는 명세 예시 모양의 합성 값이며 실데이터 검증이 아니다. 실제 호출 확인은 별도로 기록한다.

### 소유자 검사

`createApp({ ownerUserId })`의 `requireOwner` 미들웨어가 인증 뒤에 서버 세션의 사용자 ID를 `ownerUserId`와 비교한다. `src/server/index.ts`는 토스 클라이언트와 같은 `TOSS_OWNER_USER_ID`를 넘긴다. 적용 대상: `/api/portfolio`, `/api/market/*`, `/api/recommendations`(토스 클라이언트 필요)와 `GET/PUT /api/strategy`, `GET /api/calendar/events`, `GET /api/news/sources`, `POST /api/admin/calendar/events`, `POST /api/admin/news/sync`(소유자 ID만 필요, `src/server/owner.ts`의 `ownerGate`, 캘린더·뉴스 라우터가 `ownerUserId`를 받아 자체 재검사). 관리자 쓰기 경로는 관리자이면서 소유자여야 한다. 계정 관리(`/api/admin/users*`)와 인증 경로는 기존과 같다. 순서와 응답:

1. 토스 클라이언트나 `ownerUserId`가 없으면(소유자 ID 전용 경로는 `ownerUserId`만 없으면) 503 `TOSS_INTEGRATION_UNAVAILABLE`(소유자를 알 수 없으면 닫는다).
2. 로그인 사용자가 소유자가 아니면 403 `OWNER_REQUIRED`("소유자 계정 전용 기능입니다."). 제공자를 호출하지 않는다.
3. `TossClient.portfolio`의 자체 소유자 검사(`PORTFOLIO_OWNER_REQUIRED`)는 이중 방어로 유지한다.

관리자라도 소유자가 아니면 403이다.

### `GET /api/market/prices?symbols=005930,AAPL`

토스 `GET /api/v1/prices?symbols=`(Market Data, `MARKET_DATA` 한도 그룹)를 호출한다. 입력: `symbols`는 단일 문자열, 쉼표 구분, 항목은 `^[A-Za-z0-9.\-]{1,30}$`, 최대 50개(명세 상한 200보다 작게 제한), 중복은 제거하고 빈 항목·반복 파라미터·객체형은 400 `INVALID_MARKET_QUERY`. 응답: `{source:'Toss Securities OpenAPI', asOf, prices:[{symbol, lastPrice, currency:'KRW'|'USD', timestamp:string|null}]}`. 명세 필수 필드 `symbol`, `lastPrice`(십진 문자열), `currency`, 선택 `timestamp`(date-time 또는 null)만 사용한다. 응답이 배열이 아니거나, 요청하지 않은·중복 심볼, 십진수가 아닌 값, 알 수 없는 통화, 잘못된 시각, 요청 수보다 많은 행이면 502 `PROVIDER_SCHEMA_INVALID`. 제공자 404(`stock-not-found`)는 404 `PROVIDER_NOT_FOUND`(화면의 "해당 종목 데이터 없음")이며 제공자 오류 본문은 전달하지 않는다. 기존 30초 캐시·동시 요청 합치기(키는 검증된 심볼 목록)를 쓴다.

### `GET /api/market/indicators`

토스 `GET /api/v1/market-indicators/prices?symbols=`(`MARKET_INDICATOR` 그룹)에 카탈로그 8종 `KOSPI, KOSDAQ, KR_BOND_2Y/3Y/5Y/10Y/20Y/30Y`를 요청하고, `GET /api/v1/exchange-rate?baseCurrency=USD&quoteCurrency=KRW`(`MARKET_INFO` 그룹)를 함께 조회한다. 입력 파라미터는 없다. 응답: `{source, asOf, indicators:[{symbol, name, kind:'INDEX'|'BOND', unit:'point'|'percent', lastPrice, timestamp:string|null}], exchangeRate:{baseCurrency:'USD', quoteCurrency:'KRW', midRate, rate, rateChangeType:'UP'|'EQUAL'|'DOWN'|null, validFrom, validUntil}}`. `name`, `kind`, `unit`은 카탈로그 상수이고 값은 제공자가 준 `lastPrice`뿐이다(국채는 수익률 %). 명세의 `midRate`는 매매기준율, `rate`는 매수 환율이며 참고용 표시 환율로 실제 주문 환율과 다를 수 있다. 상단 띠는 `midRate`를 보여 준다. 이 API는 등락률을 주지 않으므로 화면도 등락률을 표시하지 않는다. 카탈로그에 없는 심볼, 십진수가 아닌 값, 환율 통화쌍 불일치, `midRate`/`rate`/`validFrom`/`validUntil` 누락·형식 오류는 502 `PROVIDER_SCHEMA_INVALID`이고 두 호출 중 하나라도 실패하면 전체가 실패한다. 알 수 없는 `rateChangeType`은 null로 둔다. 캐시 키는 `market-indicators`(30초). S&P 500과 원/달러 일별 이력은 이 API로 받을 수 없다([계획 설계 정정](../planning/next-phase-plan.md)).

### 공통 오류 매핑

제공자 404는 404 `PROVIDER_NOT_FOUND`로, 401/403은 503 `PROVIDER_ACCESS_DENIED`, 429·5xx·통신 실패는 기존 코드(`PROVIDER_RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_UNREACHABLE`)로 정제한다. 화면 상태 구분은 [차트](charts.md)의 표를 따른다.

검증: `npx vitest run tests/market-api.test.ts tests/server.test.ts tests/recommendations.test.ts`. 비로그인 401, 일반 회원 403, 소유자 200, 토스 미설정·소유자 미설정 503, 입력 검증 400, 스키마 위반 502, 404 매핑, 캐시를 합성 transport로 검사한다. 실제 토스 호출은 하지 않는다.
