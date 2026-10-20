# 거시 지표 데이터 — FRED·ECOS 어댑터 (5d·5e·6b)

상태: 서버 어댑터, 고정 지표 카탈로그, 라우터 팩토리, 합성 fixture 테스트까지 구현했다. **앱에는 아직 연결하지 않았다**(`src/server/app.ts`·`index.ts`, 화면, 아침 작업은 감독이 연결한다). FRED·ECOS 실제 호출은 하지 않았다(키가 아직 없다). 용도는 세 가지다: 5d 이벤트 수직선(발표일), 5e 원/달러 비교 차트(ECOS 일별 환율), 6b 아침 캘린더 갱신(다가오는 발표와 지난 발표의 실제값·이전값). 설계 근거는 [next-phase-design.md](../planning/next-phase-design.md) 2절(이벤트 수직선, 시장 지표 겹쳐 보기)·3절(아침 캘린더 갱신)이다.

코드는 `src/server/macro/`에 있다: `shared.ts`(오류·소수 문자열 정규화·고정 호스트 GET), `catalog.ts`(지표 카탈로그), `fred.ts`, `ecos.ts`, `router.ts`, `events.ts`(캘린더 연결), `index.ts`.

## 공식 근거와 확인일

확인일: 2026-10-21 KST. 아래 페이지의 내용만 근거로 구현했다. 페이지에 없는 항목은 "문서에 없음"으로 따로 적었고 첫 실호출 때 확인해야 한다.

### FRED API

| 용도           | 주소                                                                                      | 확인한 내용                                                                                                                                                                                                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 관측값         | [series/observations](https://fred.stlouisfed.org/docs/api/fred/series_observations.html) | `GET https://api.stlouisfed.org/fred/series/observations`. 파라미터 `api_key`(소문자 영숫자 32자)·`file_type`(기본 xml, json 선택)·`series_id`·`realtime_start`/`realtime_end`(기본 오늘)·`limit`(1~100000, 기본 100000)·`offset`·`sort_order`·`observation_start`/`observation_end`·`units`(기본 `lin`)·`output_type`·`vintage_dates` 등 |
| 응답 필드      | 같은 페이지                                                                               | 최상위 `realtime_start`·`realtime_end`·`observation_start`·`observation_end`·`units`·`output_type`·`file_type`·`order_by`·`sort_order`·`count`·`offset`·`limit`·`observations[]`. 각 항목은 `realtime_start`·`realtime_end`·`date`·`value`(문자열)                                                                                        |
| 발표 일정      | [release/dates](https://fred.stlouisfed.org/docs/api/fred/release_dates.html)             | `GET https://api.stlouisfed.org/fred/release/dates`. `release_id`(필수)·`realtime_start`/`realtime_end`(기본 1776-07-04~9999-12-31)·`limit`(1~10000)·`include_release_dates_with_no_data`(기본 false)·`sort_order`. 응답 `release_dates[]`의 `release_id`·`date`                                                                          |
| 발표 일정 주의 | 같은 페이지                                                                               | 발표일은 데이터 출처가 정하며 "FRED·ALFRED에 데이터가 올라오는 시점"과 같다고 보장하지 않는다. 기본값(false)이면 데이터가 아직 없는 발표일(미래 일정 포함)을 뺀다                                                                                                                                                                         |
| 시리즈의 발표  | [series/release](https://fred.stlouisfed.org/docs/api/fred/series_release.html)           | `GET https://api.stlouisfed.org/fred/series/release`. `series_id` → `releases[]`의 `id`·`name`·`press_release`·`link`. 예: 시리즈 `IRA` → 발표 21                                                                                                                                                                                         |
| 발표 목록      | [releases](https://fred.stlouisfed.org/docs/api/fred/releases.html)                       | `GET https://api.stlouisfed.org/fred/releases`(`limit` 1~1000). 이 구현은 쓰지 않는다                                                                                                                                                                                                                                                     |
| 실시간 기간    | [realtime_period](https://fred.stlouisfed.org/docs/api/fred/realtime_period.html)         | 실시간 기간은 "사실이 참이던 때 또는 정보가 알려져 있던 때"를 뜻하며 양끝을 포함한다. 과거 시점에 알려진 값을 보려면 `realtime_start`/`realtime_end`를 그 시점으로 둔다. 1776-07-04가 가장 이른 값이다                                                                                                                                    |
| 오류·한도      | [errors](https://fred.stlouisfed.org/docs/api/fred/errors.html)                           | HTTP 400·404·423·429·500. 본문은 JSON이면 `error_code`·`error_message`(예: 키 미등록은 400과 api_key 문구). **분당 120건**, 넘으면 429이고 무시하면 일시 차단될 수 있다                                                                                                                                                                   |
| 시리즈·발표 ID | FRED 시리즈 페이지(`https://fred.stlouisfed.org/series/<ID>`)                             | 아래 카탈로그 표의 시리즈 ID, 제목, 단위, 발표 이름과 `rid`                                                                                                                                                                                                                                                                               |

### 한국은행 ECOS Open API

경로: <https://ecos.bok.or.kr/api/> → 개발가이드 → 개발 명세서([`#/DevGuide/DevSpeciflcation`](https://ecos.bok.or.kr/api/#/DevGuide/DevSpeciflcation)) 및 통계코드검색([`#/DevGuide/StatisticalCodeSearch`](https://ecos.bok.or.kr/api/#/DevGuide/StatisticalCodeSearch)). 두 화면은 스크립트로 그려져서 브라우저에서 읽었다.

- 상세주소 `https://ecos.bok.or.kr/api/`(https·http 모두 가능).
- **StatisticSearch(통계 조회 조건 설정)** 요청인자는 순서대로 서비스명, 인증키, 요청유형(`xml`·`json`), 언어구분(`kr`·`en`), 요청시작건수, 요청종료건수, 통계표코드, 주기(`A` 년·`S` 반년·`Q` 분기·`M` 월·`SM` 반월·`D` 일), 검색시작일자, 검색종료일자(주기에 맞는 형식: `2020`·`2020Q1`·`202001`·`20200101`), 통계항목코드 1~4(선택)다. 샘플 URL은 `https://ecos.bok.or.kr/api/StatisticSearch/sample/xml/kr/1/10/200Y101/A/2020/2023/10101/?/?/?`처럼 **경로 인자 방식이며 인증키가 경로에 들어간다**. 샘플의 `?/?/?`는 실제로는 쿼리 문자열이라 구현은 항목코드 1개까지만 경로에 넣고 끝에 `/`를 둔다.
- 응답 필드: `STAT_CODE`·`STAT_NAME`·`ITEM_CODE1~4`·`ITEM_NAME1~4`·`UNIT_NAME`·`WGT`·`TIME`·`DATA_VALUE`. 샘플은 `<StatisticSearch><list_total_count/><row>…`(XML)다.
- **StatisticItemList**: `…/StatisticItemList/<키>/xml/kr/1/10/601Y002`. 응답 필드 `STAT_CODE`·`STAT_NAME`·`GRP_CODE`·`GRP_NAME`·`ITEM_CODE`·`ITEM_NAME`·`P_ITEM_CODE`·`P_ITEM_NAME`·`CYCLE`·`START_TIME`·`END_TIME`·`DATA_CNT`·`UNIT_NAME`·`WEIGHT`. 이 구현은 호출하지 않는다(코드는 아래 표처럼 통계코드검색에서 확인했다).
- **KeyStatisticList(100대 통계지표)**: `…/KeyStatisticList/<키>/xml/kr/1/10`. 응답 필드 `CLASS_NAME`·`KEYSTAT_NAME`·`DATA_VALUE`·`CYCLE`·`UNIT_NAME`. 이 구현은 호출하지 않는다.
- 결과 코드("에러 및 정보배치"): 정보-100 인증키가 유효하지 않음, 정보-200 해당 데이터 없음, 에러-100 필수 값 누락, 에러-101 주기와 다른 형식의 날짜, 에러-200 파일타입 값 오류, 에러-300 조회건수 누락, 에러-301 조회건수 타입 오류, 에러-400 검색범위 초과로 60초 타임아웃, 에러-500 서버 오류, 에러-600 DB 접속 오류, 에러-601 SQL 오류, 에러-602 과도한 호출로 이용 제한. 이 구현은 코드 번호로만 분기하고 제공자 문구는 응답·로그에 내지 않는다.

## 카탈로그

`catalog.ts`가 코드에 고정한다. 요청 입력은 카탈로그 `id`만 고를 수 있고 제공자 시리즈 ID·통계코드는 입력으로 받지 않는다. 중요도(3 최상·2 높음·1 보통)와 근거는 이 프로젝트의 판단이며 제공자 필드가 아니다. 분류는 캘린더 필터 종류인 "경제 지표"·"금리 결정"을 따른다.

### 미국(FRED, 2026-10-21 시리즈 페이지로 확인)

| id                    | 시리즈     | 제목(공식)                                             | 단위·주기                   | FRED 발표(rid)                   | 중요도 | 영향 자산           |
| --------------------- | ---------- | ------------------------------------------------------ | --------------------------- | -------------------------------- | ------ | ------------------- |
| `us-cpi`              | `CPIAUCSL` | CPI for All Urban Consumers: All Items, 계절조정       | 지수 1982-1984=100, 월      | Consumer Price Index (10)        | 3      | 금리·채권·달러·주식 |
| `us-core-cpi`         | `CPILFESL` | CPI: All Items Less Food and Energy, 계절조정          | 지수 1982-1984=100, 월      | Consumer Price Index (10)        | 3      | 금리·채권·달러·주식 |
| `us-unemployment`     | `UNRATE`   | Unemployment Rate, 계절조정                            | %, 월                       | Employment Situation (50)        | 3      | 금리·달러·주식      |
| `us-nonfarm-payrolls` | `PAYEMS`   | All Employees, Total Nonfarm, 계절조정                 | 천 명, 월                   | Employment Situation (50)        | 3      | 금리·달러·주식      |
| `us-gdp`              | `GDPC1`    | Real Gross Domestic Product, 계절조정 연율             | 십억 2017년 연쇄 달러, 분기 | Gross Domestic Product (53)      | 2      | 주식·달러           |
| `us-pce`              | `PCEPI`    | PCE: Chain-type Price Index, 계절조정                  | 지수 2017=100, 월           | Personal Income and Outlays (54) | 2      | 금리·채권·달러      |
| `us-core-pce`         | `PCEPILFE` | PCE Excluding Food and Energy (Chain-Type Price Index) | 지수 2017=100, 월           | Personal Income and Outlays (54) | 3      | 금리·채권·달러·주식 |
| `us-fed-funds-upper`  | `DFEDTARU` | Federal Funds Target Range - Upper Limit               | %, 일(7일)                  | FOMC Press Release (101)         | 3      | 금리·채권·달러·주식 |
| `us-fed-funds-lower`  | `DFEDTARL` | Federal Funds Target Range - Lower Limit               | %, 일(7일)                  | FOMC Press Release (101)         | 3      | 금리·채권·달러·주식 |

- 요청한 목록 가운데 **버린 항목은 없다**. 다만 "GDP"는 실질(`GDPC1`)로 골랐고 명목 GDP 시리즈는 넣지 않았다. "PCE"는 헤드라인(`PCEPI`)과 근원(`PCEPILFE`)을 모두 넣었다. `PCEPILFE` 페이지는 발표 링크를 BEA 주소로 보여 주었지만 같은 페이지의 발표 이름·`rid`는 Personal Income and Outlays(54)였다. 첫 실호출 때 `FredAdapter.verifyCatalog()`로 모든 발표 ID를 다시 확인한다.
- 같은 발표를 공유하는 지표는 발표일 한 번으로 묶인다(`releaseCatalog()`가 발표 ID별 한 건을 만들고 중요도는 가장 높은 값을 쓴다).

### 한국(ECOS, 2026-10-21 통계코드검색 화면으로 확인)

| id             | 통계표                                 | 통계표 코드·주기    | 항목 코드                         | 단위     | 중요도 | 영향 자산           |
| -------------- | -------------------------------------- | ------------------- | --------------------------------- | -------- | ------ | ------------------- |
| `kr-base-rate` | 1.3.1. 한국은행 기준금리 및 여수신금리 | `722Y001` [A,D,M,Q] | `0101000` 한국은행 기준금리       | 연 %     | 3      | 금리·채권·원화·주식 |
| `kr-cpi`       | 4.2.1. 소비자물가지수(2020=100)        | `901Y009` [A,M,Q]   | `0` 총지수                        | 2020=100 | 2      | 금리·채권·원화      |
| `kr-usdkrw`    | 3.1.1.1. 주요국 통화의 대원화환율      | `731Y001` [D]       | `0000001` 원/미국달러(매매기준율) | 원       | 2      | 원화·달러           |

- 위 코드는 코드 검색 화면의 표 이름·주기·항목 이름·단위 표시에서 그대로 옮겼다. 추측한 코드는 없다. `kr-base-rate`와 `kr-usdkrw`는 일(D), `kr-cpi`는 월(M)로 조회한다.
- ECOS에는 발표 일정 API가 없어서 이 세 항목은 "다가오는 발표일"을 만들지 못한다. 한국은행 금리 결정일과 한국 CPI 발표일은 기존 공식 보도자료 수집(news-provider.md)과 관리자 등록 일정이 맡는다.

## 사용법

```ts
import { fredFromEnvironment, ecosFromEnvironment, createMacroRouter } from './macro/index.js';
const fred = fredFromEnvironment(); // FRED_API_KEY 없음/형식 오류 → undefined
const ecos = ecosFromEnvironment(); // ECOS_API_KEY 없음/형식 오류 → undefined
app.use(createMacroRouter({ fred, ecos, ownerUserId: process.env.TOSS_OWNER_USER_ID ?? '' }));
```

- 환경 변수: `FRED_API_KEY`(Secret Manager `investing-fred-api-key`), `ECOS_API_KEY`(`investing-ecos-api-key`). 둘 다 비밀이며 코드·로그·응답에 나오지 않는다. FRED 키 형식은 문서의 "소문자 영숫자 32자"로 검사한다. ECOS 키 형식은 가이드에 없고 URL 경로에 들어가므로 경로에 안전한 영숫자(10~64자)만 받는다.
- 라우터는 세션·동일 출처·본문 한도 미들웨어 뒤에 설치한다. 라우터도 `res.locals.user`와 소유자를 다시 검사한다(분당 30회 제한).

### 어댑터 함수

| 함수                                                                               | 설명                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fred.upcomingReleases(from, to)`                                                  | 카탈로그 발표(10·50·53·54·101)의 발표일. 최대 120일. `include_release_dates_with_no_data=true`로 미래 일정을 받는다. 반환 `{ releaseId, date, indicatorIds }[]` |
| `fred.latestObservations(ids, asOf)`                                               | 지표별 최신·이전 관측값. 그 시점에 알려진 값만 쓰고 결측(".")은 건너뛴다                                                                                        |
| `fred.observationsKnownAt(id, date, { from? })`                                    | `date`에 알려져 있던 시리즈(vintage). 아래 "미래 정보 금지 규칙" 참고                                                                                           |
| `fred.observations(id, { from?, to? })`                                            | 오늘 기준 값(수정 반영). 차트 표시용이며 과거 판단에는 쓰지 않는다                                                                                              |
| `fred.verifyCatalog()`                                                             | 첫 실호출 확인용: 카탈로그의 발표 ID를 `series/release`로 다시 대조해 불일치를 돌려준다(요청 경로에서 쓰지 않는다)                                              |
| `ecos.dailySeries('kr-usdkrw', from, to)`                                          | 5e 차트 비교용 일별 환율. 일별이 아닌 지표는 거부한다                                                                                                           |
| `ecos.observations(id, { from, to })`                                              | 카탈로그 ECOS 지표의 구간 값. 1000건씩 쪽으로 받고 최대 10쪽                                                                                                    |
| `ecos.latestObservations(ids, asOf?)`                                              | 지표별 최신·이전 값(기본 오늘 KST)                                                                                                                              |
| `releaseEventDraft(release, observedAt)`, `toEconomicEvent(draft, { date, time })` | 발표일을 `EconomicEvent` 모델로 잇는 초안과 변환(아래)                                                                                                          |

모든 값은 소수 문자열(`-?\d+(\.\d+)?`, 지수 표기 없음)이고 결측은 `null`이다. FRED 결측 표시 `.`와 ECOS 빈 값·`null`을 `null`로 바꾼다. 숫자가 아닌 다른 값은 조용히 0으로 바꾸지 않고 `PROVIDER_SCHEMA_INVALID`로 실패한다.

### API

| 경로                                                    | 설명                                                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/macro/series?source=fred\|ecos&id=&from=&to=` | 카탈로그 `id`와 같은 `source`만 허용한다. 기간 최대 3660일. 응답 `{ id, source, titleKo, country, unit, sourceName, sourceUrl, asOf, observations: [{ date, value }], notice }` |
| `GET /api/macro/releases?from=&to=`                     | FRED 발표일(최대 120일). 응답 `releases[]`에 `releaseId`·`date`·`timeKnown: false`·`titleKo`·`importance`·`category`·`assets`·`indicatorIds`·`sourceUrl`                        |

| 조건                                                                          | 응답                                                                                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 비로그인·비활성                                                               | 401 `AUTH_REQUIRED`                                                                              |
| 소유자 아님(또는 소유자 ID 미설정)                                            | 403 `OWNER_REQUIRED`                                                                             |
| 추가·반복·객체 파라미터, 형식 오류, 카탈로그에 없는 id·출처 불일치, 기간 초과 | 400 `INVALID_MACRO_QUERY`                                                                        |
| FRED/ECOS 미설정                                                              | 503 `FRED_UNAVAILABLE` / 503 `ECOS_UNAVAILABLE`(releases는 FRED만 필요하다)                      |
| 제공자 오류                                                                   | `PROVIDER_*` 코드(503/502), 한도는 `Retry-After`. 알 수 없는 오류는 500 `MACRO_FAILED` 일반 문구 |

검증 순서는 인증 → 소유자 → 입력 → 설정 상태 → 제공자 호출이다.

### 캘린더 연결

FRED는 발표일(날짜)만 주고 **시각과 시간대를 문서에서 밝히지 않는다**. 그래서 `EconomicEvent`의 필수 필드 `time`을 만들 수 없다. `releaseEventDraft`는 `time`·`date` 없이 `releaseDate`(제공자 날짜)와 안정적인 `idKey`를 가진 초안을 만들고, 6b 작업이 KST 날짜·시각을 정해 `toEconomicEvent(draft, { date, time })`로 완성한다(`cleanEvent`로 검증하므로 모델에 맞지 않으면 `null`). 이벤트 ID는 `macroEventId(idKey)`로 같은 발표·날짜에 같은 정수가 나와 upsert가 중복을 만들지 않는다(1e15 이상 48비트 해시, 손으로 넣은 작은 ID와 겹치지 않는다). 초안의 영향 방향은 `unknown`, 확신은 `low`로 둔다. 발표 후 실제값·이전값은 `latestObservations`로 붙이고 문자열로 `previous`/설명에 넣는 일은 6b가 한다.

## 미래 정보 금지 규칙

과거 시점의 판단(7b 시뮬레이션, 이벤트 수직선의 "그때 알려진 값")에 거시 값을 쓸 때는 **그 시점에 알려져 있던 값만** 쓴다.

- FRED는 `observationsKnownAt(id, date)`로만 쓴다. `realtime_start = realtime_end = date`로 조회하고, 응답 행이 `realtime_start ≤ date ≤ realtime_end`이고 관측 날짜가 `date` 이하인지 한 번 더 걸러 서버가 범위를 어겨도 새어 나오지 않게 했다. 그 뒤에 수정된 값은 보이지 않는다.
- `latestObservations(ids, asOf)`도 같은 방식으로 `asOf` 시점의 값만 쓴다. `observations()`(오늘 기준 값)은 표시 전용이다.
- **ECOS는 vintage가 없다.** 값의 수정 이력도 발표 시점도 알 수 없으므로 `latestObservations`·`observations`는 표시용이다. 과거 시점 판단에 쓰려면 발표 지연을 보수적으로 가정한 별도 규칙을 먼저 정해야 한다(기준금리·환율 일별 값은 수정이 거의 없지만 이 문서는 그렇다고 단정하지 않는다).
- 한계: vintage 날짜는 FRED가 그 값을 저장한 날이라서 원 발표보다 하루 이상 늦을 수 있다(보수적인 방향). FRED가 vintage로 저장하지 않은 수정은 보이지 않고, 실시간 기간이 문서에 없는 날짜(미래 날짜, 첫 vintage 이전)에서의 동작은 문서에 적혀 있지 않다. 첫 실호출에서 확인한다.
- 발표 일정(`upcomingReleases`)은 일정 정보이며 값이 아니다. 발표일에 값이 알려졌다고 가정하려면 발표 시각(문서에 없음)을 따로 정해야 한다.

## 한도와 안전장치

- 호스트 고정(`api.stlouisfed.org`, `ecos.bok.or.kr`), `redirect: 'error'`, 요청 시간 제한(FRED 15초, ECOS 20초), 응답 크기 상한(8MB, 6MB). 같은 조회는 캐시(관측값 5분·ECOS 10분·발표 일정 1시간)하고 동시 요청은 한 번만 보낸다.
- 호출 간격: FRED 600ms(문서 한도 분당 120건보다 낮게), ECOS 300ms(문서에 수치 한도 없음, 에러-602만 명시). 한도 응답(FRED 429, ECOS 에러-602) 뒤에는 대기 시간 동안 제공자를 다시 부르지 않는다.
- **키 보호**: FRED 키는 쿼리, ECOS 키는 **URL 경로**에 들어간다. 어떤 오류에도 URL·전송 오류 원문·제공자 메시지를 담지 않으며, 테스트가 오류 객체·메시지·스택에 키가 없음을 확인한다.
- ECOS는 요청 건수를 1000건 단위로 나눠 받고 최대 10쪽을 넘으면 실패한다(문서에 최대 건수 설명이 없어서 보수적으로 정했다).

## 검증

`tests/macro-fred.test.ts`, `tests/macro-ecos.test.ts`, `tests/macro-router.test.ts`, `tests/macro-catalog.test.ts`가 외부 통신 없이 주입한 transport와 `tests/fixtures/macro/`의 **합성** 응답으로 확인한다(실데이터 검증이 아니다). 형식 검사, 결측, vintage 걸러내기, 키 비노출, ECOS 결과 코드, 라우터 인증·검증·503, 카탈로그 id 전용 입력, 캘린더 변환을 다룬다.

## 아직 연결하지 않은 것

- `app.ts`·`index.ts`에서 라우터 마운트, Cloud Run 서비스·작업의 `FRED_API_KEY`/`ECOS_API_KEY` 비밀 참조(Terraform), 화면(5d 수직선·5e 환율 비교), 6b 아침 작업의 발표 시각·KST 변환·실제값 붙이기·AI 요약.
- 5e의 코스피·코스닥·S&P 500(ETF)은 토스 캔들이 맡는다. 이 어댑터는 원/달러만 제공한다.

## 확인하지 못한 항목(첫 실호출 때 확인)

1. FRED 결측 표시: 공식 API 문서 페이지는 결측값 표현을 설명하지 않는다. 널리 알려진 `"."`를 `null`로 바꾸고 다른 비숫자는 거부한다. 실제 응답에 다른 표기가 있으면 `PROVIDER_SCHEMA_INVALID`로 드러난다.
2. FRED `release/dates`에서 `include_release_dates_with_no_data=true`가 FOMC 성명(rid 101)의 **미래 회의일**까지 돌려주는지, 각 발표(10·50·53·54)의 미래 일정이 실제로 오는지.
3. FRED 발표일의 시간대와 발표 시각: 문서에 없다. 날짜만 쓰고 시각은 6b가 정한다.
4. FRED vintage 동작: 첫 vintage 이전·미래 날짜의 `realtime_*` 처리, ALFRED가 보관하지 않은 시리즈에서 반환되는 `realtime_start`.
5. FRED 오류 본문: 400 키 미등록 시 `error_message`에 `api_key`가 들어가는 것(문서 예시 기준)에 의존해 접근 거부로 구분한다. 다른 문구면 `PROVIDER_REQUEST_REJECTED`로 보인다.
6. ECOS JSON 응답 모양: 가이드에는 XML 샘플만 있다. JSON은 `StatisticSearch.list_total_count`/`row[]`, 오류는 `RESULT.CODE`라고 가정했다(XML 샘플과 같은 이름). 코드 철자도 가이드는 `정보-100`/`에러-100`로 적고 있어 `INFO-100`/`ERROR-100`과 한글 표기를 모두 받는다.
7. ECOS 항목코드를 하나만 보내고 `?/?/?`를 쓰지 않아도 되는지, 최대 요청 건수와 일일 호출 한도(문서에 수치 없음).
8. ECOS 시간대와 `DATA_VALUE` 결측 표현(빈 문자열·`null`을 결측으로 처리), 일별 기준금리 `722Y001`/`D`가 매일 값을 주는지 변경일만 주는지, `901Y009`의 항목코드 `0` 표기.
9. ECOS 인증키 형식(가이드에 없음).
10. FRED 시리즈 페이지의 발표 연결(특히 `PCEPILFE`)과 카탈로그의 발표 ID가 API(`series/release`)와 같은지: `verifyCatalog()`로 확인.
