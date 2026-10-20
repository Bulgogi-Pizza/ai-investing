# 일일 데이터 적재 (스냅샷)

SOT: 다음 단계 계획 4단계. 과거 시뮬레이션(7b)에 쓸 시점 기준 데이터를 지금부터 쌓는다. 수급·뉴스·시장 지표는 토스가 최근 기간만 주거나 수집 시작 이후만 있어서, 쌓은 기간만큼만 전체 신호 시뮬레이션이 가능하다. 서버 코드는 `src/server/snapshots.ts`(저장소·API), 작업은 `src/jobs/`다. 실행·일정·IAM·배포는 [예약 작업](../operations/jobs.md)이다. 상태: 구현과 합성 테스트 완료, **운영 적용과 실호출 확인 전**.

## 토스 어댑터 (명세 확인)

확인: [Toss Securities OpenAPI v1.2.24](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json) `info.version` 1.2.24, **2026-10-21 KST**에 아래 엔드포인트를 읽고 구현했다. 명세에 있는 필드만 읽고, 형식이 다르면 `PROVIDER_SCHEMA_INVALID`로 실패한다(`src/server/toss.ts`, 기존 `decimal`/`record`/`text` 검사 방식). 테스트 fixture(`tests/fixtures/toss-snapshot.ts`)는 명세 모양의 합성 값이며 실데이터 검증이 아니다.

| 메서드                                                      | 엔드포인트(한도 그룹)                                               | 명세에서 근거로 삼은 사실                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `marketCalendar(market, date)`                              | `GET /market-calendar/{KR\|US}?date=`(`MARKET_INFO`)                | 응답 `today`·`previousBusinessDay`·`nextBusinessDay`(영업일 3개). 모든 시간은 KST. KR은 `integrated`(KRX+NXT 통합)의 `regularMarket`(KRX·NXT 합집합, 둘 다 휴장이면 null). US는 `regularMarket`, 휴장이면 네 세션 모두 null. US `date`는 미국 현지 날짜                                        |
| `dailyCandlePage` / `dailyCandles`                          | `GET /candles`(`MARKET_DATA_CHART`), `interval=1d`, `adjusted=true` | 최대 200봉, 최신순. `1d` `timestamp`는 해당 거래일의 현지 자정. `before`는 포함(inclusive) 상한, `nextBefore`를 그대로 다음 `before`로, 마지막이면 null. `+`는 `%2B`(URLSearchParams가 처리)                                                                                                   |
| `marketIndicatorCandlePage` / `marketIndicatorDailyCandles` | `GET /market-indicators/{symbol}/candles`(`MARKET_INDICATOR_CHART`) | 카탈로그 8종만, 국채는 일봉만. 응답 필드는 `timestamp`(봉 시작 시각)와 OHLCV뿐이고 통화 필드가 없다                                                                                                                                                                                            |
| `investorTrading`                                           | `GET /stocks/{symbol}/investor-trading`(`STOCK_TRADING_TREND`)      | KR 전용, `count` 최대 100, `until` 포함 기준일, `nextUntil`. 최신순. **당일 기록은 장중 잠정치**: `individual`·`institution.breakdown`·`otherCorporation`·`foreignerHolding`·`cfd`가 null일 수 있다. 확정치는 당일 저녁, `cfd`는 T+1, 외국인 보유는 다음 영업일 오전에 한 번 더 갱신될 수 있다 |
| `programTrades`                                             | `GET /stocks/{symbol}/program-trades`                               | KR 전용, KRX만 집계(NXT 제외). 당일 기록은 장 종료 전까지 갱신                                                                                                                                                                                                                                 |
| `shortSelling`                                              | `GET /stocks/{symbol}/short-selling`                                | KR 전용. 일별 확정치는 당일 저녁 반영. 비중은 분모가 없으면 null                                                                                                                                                                                                                               |
| `creditTrades`                                              | `GET /stocks/{symbol}/credit-trades`                                | KR 전용. T+1(최신 기록은 전 영업일). 융자·대주 한쪽만 있으면 다른 쪽이 null                                                                                                                                                                                                                    |

- **403 매핑**: 위 수급 4개 엔드포인트에서 403 "권한 부족"이 명세에 정의되어 있다. 이 응답은 `PROVIDER_FORBIDDEN`(503)으로 따로 구분한다. 같은 403이라도 다른 엔드포인트는 기존처럼 `PROVIDER_ACCESS_DENIED`(키·허용 IP 문제)다. 401은 어디서나 `PROVIDER_ACCESS_DENIED`다. 작업은 `PROVIDER_FORBIDDEN`을 실패가 아니라 "권한 없음"으로 기록한다.
- **페이지 조회 정지 조건**(`collectCandlePages`): 제공자가 더 없다고 함(`EXHAUSTED`), 요청한 시작 날짜 도달(`REACHED_DATE`), 최대 페이지 수(`MAX_PAGES`, 기본 5, 상한 20), 빈 페이지(`EMPTY_PAGE`), 커서가 진행하지 않음(새 봉이 하나도 없거나 `nextBefore`가 직전 `before`보다 과거가 아님, `CURSOR_STALLED`). 앞의 둘만 `complete: true`이고 나머지는 중간에 멈췄다는 사실을 결과로 돌려준다. 봉은 타임스탬프로 중복을 없앤다.
- 입력 검사: 수급 엔드포인트는 KR 6자리 코드(`^[A-Za-z0-9]{6}$`)만, 지표는 카탈로그 심볼만 허용하고 요청 전에 400 `INVALID_MARKET_QUERY`로 거절한다(경로 주입 방지).
- 한도: 명세는 호출 한도 그룹별 토큰 버킷과 `X-RateLimit-*`·`Retry-After` 헤더를 정의하지만 **한도 값은 명세에 없다**. 작업은 호출 간격 250ms를 두고 `Retry-After` 65초 이하만 두 번까지 기다린다.

## 저장 구조 (Firestore, 서버 전용)

클라이언트 접근은 기존 `firestore.rules`(전부 거부)가 막는다. TTL을 걸지 않는다(이력이 목적이다).

| 컬렉션            | 문서 ID                                  | 내용                                                                                                                          |
| ----------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `marketSnapshots` | `{KR\|US}_{거래일}_{심볼 대문자}` (종목) | 시장·거래일·심볼별 한 문서. 섹션: `candle`, `investorTrading`, `programTrades`, `shortSelling`, `creditTrades`(KR만 수급 4개) |
| `marketSnapshots` | `INDICATOR_{거래일}_{지표}` (시장 지표)  | KOSPI, KOSDAQ, `KR_BOND_*` 일봉. 섹션 `candle`                                                                                |
| `snapshotRuns`    | `{KR\|US}_{세션 날짜}`                   | 실행 기록(아래)                                                                                                               |
| `snapshotTargets` | `{소유자 사용자 ID}`                     | 소유자가 지정한 추가 적재 종목 `{targets:[{market,symbol}], updatedAt}`                                                       |

각 섹션은 `{ baseDate, observedAt, sourceUpdatedAt, value }`다. `baseDate`는 원천 자체의 기준일(거래일), `observedAt`은 작업이 받은 시각(UTC ISO), `sourceUpdatedAt`은 제공자가 알려 준 갱신 시각(없으면 null)이다. 문서 최상위에도 마지막 쓰기 시각 `observedAt`이 있다. 캔들은 `adjusted: true`(수정주가, 이후 분할·배당 조정으로 과거 값이 바뀔 수 있어 "받은 시점의 값"으로 읽는다)와 통화를 함께 저장한다. 수치는 제공자의 십진 문자열 그대로다.

**실행 기록** `snapshotRuns/{market}_{date}`: `status`(`running`/`complete`/`partial`/`failed`/`skipped`), `trigger`(`scheduler`/`manual`), `attempts`, `startedAt`, `finishedAt`, `sessionClose`, `skipCode`, `targets{holdings,list,total}`, `counts{symbols,documentsWritten}`, `steps`(단계별 `status`, `ok`/`failed`/`forbidden`/`stale`/`empty`/`skipped` 개수, `codes`별 횟수). 휴장일 건너뜀은 같은 컬렉션에 `skipped` 기록으로 한 번만 남긴다(생존 확인용, 이미 있는 기록은 덮어쓰지 않는다).

### 상태 코드

| 단계(step)                                                                                  | 상태                                                     | 뜻                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `targets`                                                                                   | `FAILED`, `SKIPPED`                                      | 보유 조회 등 대상 제공자 실패(코드 포함), 잘못된 심볼 또는 100개 초과로 제외(`TARGET_SYMBOL_INVALID`, `TARGETS_TRUNCATED`)                                             |
| `candles`, `investorTrading`, `programTrades`, `shortSelling`, `creditTrades`, `indicators` | `OK`, `EMPTY`, `FORBIDDEN`, `STALE`, `FAILED`, `SKIPPED` | `EMPTY` 제공자가 빈 목록, `FORBIDDEN` 권한 없음(실패 아님), `STALE` 세션 날짜의 봉이 아직 없음(`CANDLE_NOT_YET_PUBLISHED`), `SKIPPED` 앞선 치명적 오류로 호출하지 않음 |
| `store`                                                                                     | `OK`, `FAILED`                                           | Firestore 쓰기(`STORE_FAILED`)                                                                                                                                         |
| `news`                                                                                      | `OK`, `FAILED`                                           | 공식 RSS 수집(`NEWS_SOURCE_FAILED`: 한 출처 이상 실패, `NEWS_SYNC_FAILED`: 예외)                                                                                       |

실행 상태: 실패·`STALE`·`SKIPPED` 단계가 없으면 `complete`(권한 없음과 빈 데이터는 알려진 상태라 완료로 본다), 있으면서 하나라도 저장했으면 `partial`, 하나도 저장하지 못했으면 `failed`.

## 동작

1. 실행마다 두 시장을 모두 보고, **토스 장 운영 캘린더로 직전 세션이 마감 20분 지났는지** 판단한다(`market-session.ts`). 휴장이면 건너뛴다. KR 일정(16:30·18:30 KST)과 US 일정(06:30·07:30 KST)이 같은 코드를 쓴다.
2. 대상 종목 = 보유 종목(소유자 포트폴리오, 토스 `portfolio`) ∪ `snapshotTargets` 목록. 제공자 인터페이스(`SnapshotTargetProvider`)라서 7a 이후 알고리즘 대상 제공자를 더하면 된다. 제공자 하나가 실패해도 나머지를 쓴다. 시장별 최대 100종목, 대소문자 무시 중복 제거.
3. 종목마다 일봉과(KR이면) 수급 4개를 가져와 거래일별 문서로 묶어 **종목 한 번에 한 번 저장**한다. 한 섹션이 실패해도 받은 섹션은 저장한다. KR 실행은 KOSPI·KOSDAQ·국채 6종 일봉도 저장하고, 공식 뉴스 RSS 수집(`syncOfficialNews`)을 실행한다.
4. **최근 5거래일 윈도우**: 시리즈마다 최근 5건을 요청하고 세션 날짜 이하의 모든 행을 저장한다. 하루를 놓쳤거나 당일 잠정치(개인·기관 세부 null)가 다음 날 확정치로 바뀌어도 다음 실행이 같은 문서 ID를 덮어써 메운다. 같은 날 다시 돌려도 문서가 늘지 않는다.
5. **멱등**: 같은 문서 ID에 섹션 단위로 덮어쓴다. `{market}_{date}` 실행 기록이 `complete`이면 다시 돌지 않는다(수동 `SNAPSHOT_FORCE=1`만 예외). 실행 중 기록이 30분 안이면 동시 실행을 막고(`RUN_IN_PROGRESS`), 오래됐으면 중단된 실행으로 보고 이어받는다.
6. 호출은 하나씩 250ms 간격이다. `PROVIDER_ACCESS_DENIED`(키·허용 IP), 긴 요청 한도(65초 초과), 연속 5회 실패는 치명적으로 보고 나머지 호출을 하지 않는다(`SKIPPED`). 수급이 연속 두 번 `PROVIDER_FORBIDDEN`이면 그 섹션은 더 묻지 않고 나머지 종목도 `FORBIDDEN`으로 기록한다.
7. 알려진 한계: 세션 날짜의 일봉이 아직 없으면 `STALE`로 보고 두 번째 슬롯이 다시 시도한다. 한국 국채(`KR_BOND_*`) 일봉은 하루 늦게(다음 영업일) 나온다(2026-10-21 실호출 확인: KOSPI는 10-20 봉이 있었고 국채는 10-19까지였다). 국채는 최신 봉이 세션 날짜보다 4일 이내로 뒤처지면 정상(`OK`)으로 보고, 최근 행을 다시 쓰는 구조라 다음 실행에서 그 봉이 저장된다. 더 오래 뒤처지면 `STALE`이다. US 일봉 타임스탬프의 날짜는 제공자가 준 문자열의 날짜 부분을 거래일로 쓴다(명세: "현지 자정 고정"). 실제 응답에서 날짜가 어긋나는지는 실호출로 확인해야 한다.

## 소유자 전용 API

모두 로그인 + 소유자 검사(`ownerGate`)다. 비로그인 401, 소유자 아님 403 `OWNER_REQUIRED`, 소유자 미설정 503. `app.ts`는 인증 뒤에 `createSnapshotRouter`를 설치할 뿐이고 라우터도 로그인과 소유자를 다시 검사한다.

- `GET /api/snapshots/status` → `{asOf, markets:{KR:{lastRun, recentRuns[≤5]}, US:{...}}}`. 실행 기록의 정제된 투영(상태·시각·대상·기록 건수·단계별 상태 코드)만 돌려주며 제공자 데이터는 없다.
- `GET /api/snapshots/targets` → `{targets, updatedAt}`.
- `PUT /api/snapshots/targets` ← `{targets:[{market:'KR'|'US', symbol}]}`. KR은 6자리 영숫자, US는 `[A-Za-z0-9.-]{1,30}`, 최대 100개, 다른 필드 거부, 대소문자 무시 중복 제거. 동일 출처 검사는 앱 공통 CSRF 규칙을 따른다. UI는 이 단계에 없다(필요하면 후속 단계).

## 저장 용량 추정

가정: KR 종목 20개, US 종목 10개, 거래일 연 250일, 문서 추정치는 필드마다 Firestore 자동 색인(오름·내림)이 붙는다고 보고 넉넉히 잡았다.

| 문서                 | 대략 크기(색인 포함) | 연간(250일)     |
| -------------------- | -------------------- | --------------- |
| KR 종목·일(섹션 5개) | 약 26KB              | 종목당 약 6.5MB |
| US 종목·일(섹션 1개) | 약 4KB               | 종목당 약 1MB   |
| 시장 지표 8개·일     | 약 26KB              | 약 6.6MB        |

위 가정에서 연 약 150MB이고, 최근 4일 행의 재기록은 같은 문서를 덮어쓰므로 늘지 않는다. Firestore 무료 구간(저장 1GiB)을 연 단위로 넘지 않는다. 쓰기는 KR 실행당 약 140건(20종목×5일 + 지표 40건), 하루 수백 건이다. 종목이 늘면 KR 종목당 연 6.5MB가 지배적이다. 커지면 `marketSnapshots` 컬렉션에 색인 제외(`google_firestore_field` 와일드카드)를 거는 방법이 있으나, 7b가 심볼·날짜로 질의하려면 필요한 색인을 그때 정한다(날짜 범위는 문서 ID 범위로 읽을 수 있다: `{market}_{date}_…`). 이 숫자는 추정이며 실제 문서 크기는 첫 적재 뒤 Firestore 사용량으로 확인한다.

## 테스트

`npx vitest run tests/toss-snapshot.test.ts tests/market-session.test.ts tests/daily-snapshot.test.ts tests/snapshots-api.test.ts tests/job-runner.test.ts`. 외부 통신 없이 주입한 transport와 메모리 저장소를 쓴다.

- 어댑터: 명세 모양 검사, 잘라 낸 필드, 403 → `PROVIDER_FORBIDDEN`(다른 엔드포인트는 `PROVIDER_ACCESS_DENIED`), 입력 검증, 페이지 정지 조건(소진·최대 페이지·정체·빈 페이지·시작 날짜).
- 장 운영 판단: KST 날짜, 미국 서머타임 전환(2026-03-08, 2026-11-01), 서머/겨울 마감(05:00/06:00 KST), 단축일, 휴장일, 슬롯별 선택.
- 작업: 휴장 건너뜀, 멱등(재실행·강제 재실행), 부분 실패 보존과 재시도로 메우기, 권한 없음, 치명적 오류 중단, 요청 한도 대기, 토큰 대기, 대상 제공자 실패, 뉴스 실패, 중복 실행 방지, 로그에 비밀·종목·계좌가 없는지.
- API: 비로그인 401, 일반 회원 403, 소유자 200, 소유자 미설정 503, 목록 검증.

## 실호출로 확인할 것 (미확인)

- `PROVIDER_FORBIDDEN`: 키에 수급 API 권한이 있는지, 403 응답이 실제로 어떻게 오는지(종목별인지 키 전체인지).
- 호출 한도 그룹별 실제 값, 과거 캔들 제공 범위, 장 운영 캘린더의 휴장·단축일 표현(휴장일 `today`가 해당 날짜를 가리키는지 가장 가까운 영업일을 가리키는지 포함. 작업은 `today.date`가 요청 날짜와 같고 정규장이 있을 때만 거래일로 본다).
- US 일봉 타임스탬프의 시간대(날짜 키가 미국 현지 거래일과 같은지).
- 첫 적재 문서의 실제 크기와 색인 포함 저장량.

## 운영 확인 (2026-10-21 KST)

- 배포로 `investing-daily-snapshot` Cloud Run Job이 만들어졌다: 서비스 계정 `investing-jobs`, VPC 전체 출구(고정 IP), 스케줄러 계정에는 이 작업 하나에만 `run.invoker`.
- 자동 판단: 02:3x KST 수동 실행에서 KR은 `NO_RECENT_SESSION`(마감 후 8시간 초과), US는 `SESSION_NOT_CLOSED_YET`(장중)으로 건너뛰었다. 실제 장 운영 캘린더 응답(KR 정규장 09:00–15:30+09:00, US 22:30–05:00 KST 서머타임)과 일치하는 정상 판단이다.
- 날짜 지정 실행(`SNAPSHOT_MARKETS=KR`, `SNAPSHOT_DATE=2026-10-20`): 지수·국채 8종과 공식 뉴스를 받아 문서 40개를 썼다. 소유자 보유가 미국 1종목뿐이라 KR 종목 대상은 0이었다(정상). 국채 6종은 위의 하루 지연 때문에 당시 `STALE`였고, 이 문제는 이후 판정 규칙을 고쳐 해결했다.
- 스케줄 2개를 켰다(`snapshot_schedules_enabled = true`, plan은 `paused` 2개 변경만). 이틀 연속 자동 실행 확인은 남아 있다.
