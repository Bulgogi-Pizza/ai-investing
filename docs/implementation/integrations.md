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
- `GET /api/market/candles?symbol=005930&interval=1d&count=100`: 인증 필수, interval1m/1d, count1–200, 심볼 영숫자/점/하이픈 최대30자. 공식 `/api/v1/candles` 수정주가 기준 조회. `{source,asOf,symbol,interval,adjusted:true,candles:[{timestamp,open,high,low,close,volume,currency}]}`. 수치는 십진문자열이며 과거→최신으로 정렬한다. pagination은 아직 웹API에 노출하지 않는다.
- `GET /api/recommendations`: 인증·소유자·저장 전략 필수. 토스 일봉·주식 잔고·등록 일정 기반 rules-v1 분석을 반환한다. 전략없음409, 제공자미설정503, 소유자외403. 선택적 Vertex 해설과 관리자 실행 공식 RSS 수집을 연결한다. 예약 뉴스 수집은 구성하지 않았다. 상세는 recommendation-engine.md 참조.
- `GET /api/strategy`: `{strategy:null}` 또는 계정별 전략. `PUT /api/strategy`는 `{strategy:{name,horizon,benchmark,riskTolerance,targetAllocations,notes}}`. name/horizon/benchmark/notes는 문자열, riskTolerance는 low/medium/high, targetAllocations는 `{asset:string,percentage:number}[]`. 중복 자산 금지, 합계100%, 각 비중0–100, 최대30개. 서버에서 검사하고 허용 필드만 저장한다.

운영 전략은 Firestore strategies/{userId}에 저장한다. 브라우저 데모 전략은 메모리 전용이며 실제 계정 API에 저장하지 않는다. 주문 엔드포인트는 구현 범위에 없다.

## 최초 계좌 식별값 연결 작업

`src/server/toss-setup.ts`는 웹 엔드포인트가 아닌 일회성 Cloud Run Job 진입점이다. 명령은 `node --import tsx src/server/toss-setup.ts`다. `NODE_ENV=production`, 명시적 `GOOGLE_CLOUD_PROJECT`, Secret Manager에서 주입한 `TOSS_CLIENT_ID`/`TOSS_CLIENT_SECRET`가 필요하며 Cloud Run이 제공하는 `CLOUD_RUN_JOB`도 확인한다. 로컬 실행이나 기본 프로젝트로의 자동 대체는 허용하지 않는다. Job은 서비스와 같은 고정 NAT 경로 및 같은 Firestore `providerTokens` 캐시를 사용하여 토큰 재발급으로 기존 서비스 토큰을 무효화하지 않도록 한다.

공식 `/api/v1/accounts`를 Bearer만으로 조회한다. 공식 정수형 `accountSeq`가 양의 안전 정수이며 최대15자리인 `BROKERAGE` 계좌가 정확히 하나인 경우에만 진행한다. 계좌 없음·다중 거래 계좌·잘못된 응답은 실패 처리한다. 응답 원본, 계좌번호, 식별값을 로그나 웹 응답에 출력하지 않는다. 발견한 식별값은 런타임 서비스 계정의 ADC로 Secret Manager의 고정 이름 `investing-toss-account-seq`에 새 버전으로 저장한다. IAM은 이 단일 비밀에 대한 버전 추가 권한과 공용 토큰 캐시 접근만 부여한다. 다른 비밀 이름/프로젝트는 요청 입력으로 받지 않는다. Secret Manager 요청은8초 제한, redirect 금지이며 응답 본문은 읽지 않는다.

성공 로그는 `{accountDiscovered:true,accountSeqStored:true}`만 남긴다. 실패는 `{code:고정코드}` 한 필드만 출력한다. `PROVIDER_ACCESS_DENIED`(인증/허용IP), `PROVIDER_ACCOUNT_UNAVAILABLE`(거래 계좌 없음), `PROVIDER_ACCOUNT_SELECTION_REQUIRED`(다중 거래 계좌), 제한·통신·응답검증·토큰lease의 명시적 허용목록 코드만 통과시키며, 비밀 저장 실패는 `TOSS_SETUP_SECRET_STORE_FAILED`, 그 외는 `TOSS_SETUP_FAILED`다. 공급자가 보낸 임의 code/message/body와 스택은 기록하지 않는다. 작업 성공 후 서비스에 계좌 비밀과 소유자 사용자ID를 주입하고 인증된 자산 조회를 별도 검증해야 실제 연결이 완료된다. 다중 계좌일 때는 식별값을 로그에 나열하지 않고 운영자의 안전한 선택 절차를 마련해야 한다.

검증: `npx vitest run tests/toss.test.ts tests/toss-setup.test.ts`. 단일 거래 계좌의 식별값 최소화, 계좌 헤더 미전송, 빈/다중/손상 응답 거부, 고정 비밀 경로, 잘못된 프로젝트/실행 환경 거부, 오류 메시지 비밀 제거를 합성 fixture로 검사한다. 이 테스트는 실제 토스/Google API를 호출하지 않는다.

검증: `npx vitest run tests/toss.test.ts tests/server.test.ts tests/auth.test.ts`. 공식 응답fixture, 헤더/인증본문, 통화분리, 소유자격리, 토큰경합/lease, 오류비밀제거, 조회캐시, 쿼리검증을 검사한다. 실키·실계좌·실거래는 테스트에 사용하지 않는다.

## 실제 데이터 기반 추천 갱신

`GET /api/recommendations?period=daily|weekly|monthly&symbol=005930`는 저장된 전략·토스 일봉·주식 잔고·출처 등록 일정으로 rules-v1 분석을 반환한다. 전략없음409, 제공자미설정503, 연결소유자외403. 상세 계약은 recommendation-engine.md 참조. 선택적 Vertex 해설 및 관리자 실행 한국은행·연준 RSS 수집의 계약은 ai-provider.md/news-provider.md를 따른다. 실제 연결 상태는 status.md가 원본이다.
