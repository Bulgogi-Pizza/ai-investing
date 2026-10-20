# 재무·가치 지표 — FUNDAMENTALS (5b)

상태: 서버 어댑터, 순수 계산 라이브러리, 라우터 팩토리, 합성 fixture 테스트까지 구현했고 **5단계(종목 분석)에서 앱에 연결했다**: `createApp`이 라우터를 소유자 검사 뒤에 마운트하고, `src/server/index.ts`가 환경 변수로 DART·SEC 어댑터를 만들어 넘긴다. 화면은 [종목 분석](charts.md)의 가치·재무 탭과 요약이 쓴다. DART·SEC 실제 호출은 하지 않았다(키가 아직 없다). 설계 근거는 [next-phase-design.md](../planning/next-phase-design.md) 2절 "분석 탭"과 4절 "검증 흐름"이며, 계산 함수는 7b 시점 기준 백테스트가 그대로 재사용한다.

## 공식 근거와 확인일

확인일: 2026-10-21 KST. 아래 페이지의 내용만 근거로 구현했다. 페이지에 없는 항목은 "문서에 없음"으로 따로 적었고, 첫 실호출 때 확인해야 한다.

| 출처                        | 주소                                                                                                                                                   | 확인한 내용                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DART 고유번호               | [guide DS001/2019018](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019018)                                                         | `GET https://opendart.fss.or.kr/api/corpCode.xml`, 파라미터 `crtfc_key`(40자), 응답은 ZIP 안의 XML. 필드 `corp_code`(8자리)·`corp_name`·`corp_eng_name`·`stock_code`(상장사만 6자리)·`modify_date` |
| DART 단일회사 전체 재무제표 | [guide DS003/2019020](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2019020)                                                         | `fnlttSinglAcntAll.json`, 파라미터 `crtfc_key`·`corp_code`·`bsns_year`(2015년부터)·`reprt_code`·`fs_div`(`CFS` 연결/`OFS` 별도), 응답 필드, 분기 손익의 3개월 금액 설명                            |
| DART 공시검색               | [guide DS001/2019001](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019001)                                                         | `list.json`, 파라미터 `corp_code`·`bgn_de`·`end_de`·`pblntf_ty`(A 정기공시)·`last_reprt_at`·`sort`·`sort_mth`·`page_no`·`page_count`(최대 100), 응답 `rcept_no`·`rcept_dt`(접수일자 YYYYMMDD)      |
| DART 주식의 총수 현황       | [guide DS002/2020002](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS002&apiId=2020002)                                                         | `stockTotqySttus.json`, 파라미터 `crtfc_key`·`corp_code`·`bsns_year`·`reprt_code`, 응답 `se`·`istc_totqy`(발행주식총수)·`tesstk_co`(자기주식수)·`distb_stock_co`(유통주식수)·`stlm_dt`(결산기준일) |
| SEC 접근 규칙               | [Accessing EDGAR Data](https://www.sec.gov/os/accessing-edgar-data), [개발자 FAQ](https://www.sec.gov/os/webmaster-faq#developers)                     | 요청 헤더에 User-Agent(회사명과 연락 이메일 형태)를 선언한다. 최대 요청 속도는 초당 10건. 자동 도구의 사이트 크롤링은 허용하지 않는다. RESTful API는 `data.sec.gov`                                |
| SEC API                     | [EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces), [API 문서](https://www.sec.gov/edgar/sec-api-documentation) | `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json`(CIK 10자리, 0 채움), `submissions/CIK##########.json`. 인증키 없음, CORS 미지원. XBRL API는 보통 1분 안에 갱신된다                 |
| SEC 티커 매핑               | [개발자 FAQ](https://www.sec.gov/os/webmaster-faq#developers)                                                                                          | `https://www.sec.gov/files/company_tickers.json`이 티커·CIK·회사명 대응 파일이다. 정기 갱신이며 정확성·범위는 보장하지 않는다                                                                      |

DART 상태 코드(세 API 공통): `000` 정상, `010` 등록되지 않은 키, `011` 사용 중지된 키, `012` 허용되지 않은 IP, `013` 조회된 데이터 없음, `014` 파일 없음, `020` 요청 제한 초과, `021` 조회 회사 수 초과(최대 100), `100` 필드 값 부적절, `101` 부적절한 접근, `800` 시스템 점검, `900` 정의되지 않은 오류, `901` 개인정보 보유기간 만료로 키 사용 불가. **일일 한도**: 문서는 "일반적으로 20,000건 이상 요청에서 020이 발생하나 키마다 다르게 설정될 수 있다"고 적고 기간 단위는 밝히지 않는다.

**공식 문서에 없어서 첫 실호출 때 확인해야 하는 것**

- SEC `companyfacts` JSON의 필드 배치(`facts` → 분류 → 태그 → `units` → `{start,end,val,accn,fy,fp,form,filed,frame}`). 위 페이지들은 이 구조를 설명하지 않는다. 널리 알려진 구조로 구현했고, 모양이 다르면 `PROVIDER_SCHEMA_INVALID`로 실패한다. `fy`·`fp`·`frame`의 의미도 문서에 없어서 **쓰지 않는다**(기간은 `start`/`end`로 정한다).
- `company_tickers.json`의 필드(`cik_str`, `ticker`, `title`). 위 FAQ는 파일 위치와 용도만 설명한다.
- DART `corpCode.xml` ZIP 안의 항목 이름(`CORPCODE.xml`)과 XML 구조(`<result><list>…`), 오류 시 ZIP 대신 상태 문서를 주는지. 문서에 예시 응답이 없다. 어댑터는 이름을 대소문자 무시로 비교하고, ZIP이 아니면 `<result><status>`를 읽는다.
- DART `fnlttSinglAcntAll`의 `thstrm_add_amount`가 어떤 보고서에서 채워지는지. 문서는 필드가 있다는 것과 "분기·반기 손익계산서의 `thstrm_amount`는 3개월 금액"이라는 것만 밝힌다.
- DART `stockTotqySttus`의 `se` 값. 문서는 "증권의 종류, 합계, 비고"라고만 적는다. `합계` 행을 쓰고, 없으면 `비고`를 뺀 행이 하나일 때만 그 행을 쓴다.
- DART 응답의 상태 키 위치. 문서 표는 `result` 아래 `status`·`message`로 적지만 `stockTotqySttus`와 `list`의 응답 필드 표는 최상위 `status`·`message`로 적는다. 최상위 `status`로 구현했다.
- DART 보고서의 결산일 필드가 없다(아래 "결산일").

## 연결 방법(연결 완료)

```ts
import {
  dartFromEnvironment,
  secFromEnvironment,
  createFundamentalsRouter,
} from './fundamentals/index.js';
app.use(
  createFundamentalsRouter({
    dart: dartFromEnvironment(), // DART_API_KEY 없음/형식 오류 → undefined
    sec: secFromEnvironment(), // SEC_USER_AGENT 없음/연락처 없음 → undefined
    ownerUserId: process.env.TOSS_OWNER_USER_ID ?? '',
  }),
);
```

- 환경 변수: `DART_API_KEY`(비밀, Secret Manager의 `investing-dart-api-key`), `SEC_USER_AGENT`(비밀 아님, 연락처 포함 예 `프로젝트명 연락이메일`; 공개 저장소에 쓰지 않는다). 키는 코드·로그·응답에 나오지 않는다.
- 라우터는 세션·동일 출처·본문 한도 미들웨어 뒤에 설치한다. 라우터도 `res.locals.user`와 소유자를 다시 검사한다.

## API

`GET /api/fundamentals?market=KR|US&symbol=`

| 조건                                                         | 응답                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 비로그인·비활성                                              | 401 `AUTH_REQUIRED`                                                                        |
| 소유자 아님(또는 소유자 ID 미설정)                           | 403 `OWNER_REQUIRED`                                                                       |
| `market`·`symbol` 외 파라미터, 반복·객체 파라미터, 형식 오류 | 400 `INVALID_FUNDAMENTALS_QUERY`. KR은 영숫자 6자리, US는 `A-Z` 1~6자(+`.`/`-` 접미 1~2자) |
| KR인데 `dart` 없음 / US인데 `sec` 없음                       | 503 `DART_UNAVAILABLE` / 503 `SEC_UNAVAILABLE`(서로 다른 코드)                             |
| 종목·재무 데이터 없음                                        | 404 `FUNDAMENTALS_NOT_FOUND`                                                               |
| 제공자 오류                                                  | 아래 "실패 처리"                                                                           |
| 성공                                                         | 200 `{market,symbol,name,source,asOf,statements,warnings,perShare,notice}`                 |

- `asOf`는 서버가 제공자에서 받은 시각(ISO)이다. 각 재무제표의 `filedAt`은 공시 접수일이다. 둘을 섞지 않는다.
- `perShare`는 `computePerShareMetrics`의 결과(TTM 순이익, EPS, BPS, ROE와 각 `asOf`·이유 코드)다. **PER·PBR은 서버가 계산하지 않는다.** 화면이 토스 현재가를 받아 `priceRatios(perShare, price, currency)`를 호출한다(`src/lib/valuation.ts`는 브라우저에서 그대로 쓸 수 있는 순수 함수다). 업종 평균은 토스 `/sectors` 구성 종목의 값으로 `sectorSummary`를 호출한다.
- 사용자당 분당 30회 제한(인스턴스별). 제공자 호출은 캐시(아래)가 먼저 막는다.

## 정규화 재무제표 모델

`src/lib/valuation.ts`의 `FinancialStatement`. DART와 SEC가 같은 모양을 돌려준다. 금액·주식 수는 [toss.ts](../../src/server/toss.ts)와 같은 **십진 문자열**(`^-?\d+(\.\d+)?$`, 지수 표기 없음)이다. 부동소수점 변환 오차 없이 그대로 전달하고, 화면·계산 함수가 필요할 때만 `Number`로 바꾼다. 가장 큰 값(수백조 원)도 `Number`의 안전 정수 범위(약 9.0×10¹⁵) 안이다. 값이 없으면 `null`이고 추정하지 않는다.

| 필드                                             | 뜻                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `market`, `symbol`                               | `KR`/`US`, 종목 코드(KR 6자리, US 대문자 티커)                                         |
| `periodType`, `fiscalYear`, `fiscalPeriod`       | `annual`/`quarter`, 회계연도, `FY`·`Q1`~`Q4`                                           |
| `periodEnd`, `periodEndAssumed`                  | 기간 종료일 YYYY-MM-DD. 공시 정보로 확인하지 못해 달력으로 가정했으면 `true`           |
| `filedAt`                                        | 공시 접수일 YYYY-MM-DD. 시점 기준 필터의 기준. 값마다 다르면 사용한 값 중 가장 늦은 날 |
| `currency`, `scope`                              | 통화 코드. `consolidated`/`separate`(DART 연결/별도, SEC는 `consolidated`)             |
| `derived`                                        | 분기 흐름 값을 빼서 만들었으면 `true`(4분기 등)                                        |
| `revenue`, `operatingIncome`, `netIncome`        | 매출, 영업이익, **지배기업 소유주 귀속** 당기순이익. 분기는 3개월 금액                 |
| `totalAssets`, `totalLiabilities`, `totalEquity` | 기말 잔액. 자본은 **지배기업 소유주 귀속**                                             |
| `sharesOutstanding`                              | 발행주식수(아래 매핑). 없으면 `null`                                                   |
| `source`, `sourceUrl`                            | `DART`/`SEC EDGAR`, 근거 주소(DART 공시뷰어 `rcpNo`, SEC `companyfacts` 주소)          |

순이익·자본을 지배주주 기준으로 통일한 이유: PER·PBR의 주당 값은 보통주 주주 몫으로 나눠야 하고, SEC `NetIncomeLoss`·`StockholdersEquity`가 이미 지배주주 기준이다.

## 필드 매핑 — DART

기본은 연결(`CFS`)이다. 모든 기간(연도 × 보고서)에서 연결 재무제표가 하나도 없을 때만 별도(`OFS`)로 다시 받고 `scope: separate`로 표시한다(한 종목 안에서 연결과 별도를 섞지 않는다). `account_id`가 표준 ID(`ifrs-full_`·`dart_` 접두)인 행은 ID로, 표준 ID가 아닌 행("표준계정코드 미사용" 자리표시)은 아래 계정명 정확 일치로만 찾는다. 같은 구분(`sj_div`)에서는 `IS`를 먼저, 없으면 `CIS`를 본다.

| 필드                | 우선 `account_id` (구분)                                                                    | 대체                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `revenue`           | `ifrs-full_Revenue` (IS/CIS)                                                                | 계정명 `매출액`, `수익(매출액)`, `영업수익`, `매출`                                                                                                                                |
| `operatingIncome`   | `dart_OperatingIncomeLoss` (IS/CIS)                                                         | 계정명 `영업이익`, `영업이익(손실)`, `영업손익`                                                                                                                                    |
| `netIncome`         | `ifrs-full_ProfitLossAttributableToOwnersOfParent`                                          | `ifrs-full_ProfitLoss`(또는 `당기순이익`·`분기순이익`·`반기순이익` 계열 계정명) — **비지배지분 순이익 행 `ifrs-full_ProfitLossAttributableToNoncontrollingInterests`가 없을 때만** |
| `totalAssets`       | `ifrs-full_Assets` (BS)                                                                     | `자산총계`                                                                                                                                                                         |
| `totalLiabilities`  | `ifrs-full_Liabilities` (BS)                                                                | `부채총계`                                                                                                                                                                         |
| `totalEquity`       | `ifrs-full_EquityAttributableToOwnersOfParent`                                              | `ifrs-full_Equity`(또는 `자본총계`) — **`ifrs-full_NoncontrollingInterests` 행이 없을 때만**                                                                                       |
| `sharesOutstanding` | `stockTotqySttus`의 `se=합계` 행의 `distb_stock_co`(유통주식수 = 발행주식총수 − 자기주식수) | `합계`가 없고 `비고`를 뺀 행이 하나면 그 행. 0 이하·파싱 불가는 `null`                                                                                                             |

- 금액 문자열에서 천 단위 쉼표를 제거한 정수만 받는다. 비어 있거나 `-`는 `null`, 그 밖의 형식은 `null`로 두고 경고에 계정명을 남긴다. 응답의 형식 자체가 다르면(`list`가 배열이 아님 등) `PROVIDER_SCHEMA_INVALID`다.
- 통화는 행의 `currency`(3자 대문자)다. 없으면 그 기간을 쓰지 않는다.
- 발행주식수에 우선주가 포함된다(`합계`). 우선주 비중이 큰 종목은 EPS가 달라질 수 있다.
- **결산일**: 재무제표 응답에 기간 종료일 필드가 없다. 기본값은 12월 결산 달력(1분기 3/31, 반기 6/30, 3분기 9/30, 연간 12/31)이다. `stockTotqySttus`의 `stlm_dt`(결산기준일)가 이 날짜의 ±45일 안이면 그 값을 쓰고 `periodEndAssumed: false`로 둔다. 아니면 달력 값을 쓰고 `periodEndAssumed: true`와 경고를 남긴다. 결산월이 12월이 아닌 회사는 `periodEnd`가 틀릴 수 있다(회계연도·분기 번호는 `bsns_year`·`reprt_code`로 정해지므로 TTM 계산에는 영향이 없다).
- **공시 접수일**: `fnlttSinglAcntAll` 행의 `rcept_no`를 `list.json`(`pblntf_ty=A`, `last_reprt_at=N`, 해당 기간)의 `rcept_dt`와 맞춰 `filedAt`을 정한다. 응답 행의 `rcept_no`가 가리키는 보고서의 접수일이므로, 정정 보고서가 응답되면 정정 보고서의 접수일이다(원본보다 늦으므로 미래 참조가 생기지 않는다). 목록에 없는 `rcept_no`는 접수일을 알 수 없으므로 그 기간을 제외하고 경고한다. `rcept_no` 앞 8자리를 날짜로 해석하지 않는다(문서에 없음).
- 조회 연도: 현재(KST) 연도와 그 앞 2년(기본). 분기·반기·3분기·사업보고서 4종 × 3년 × (재무제표 + 주식 수) = 24건에 공시 목록 1건, 고유번호 갱신 때 1건이 든다. 연결이 전혀 없는 종목은 24건이 더 든다. `013`(데이터 없음)은 오류가 아니라 "아직 공시되지 않음"이다. 모든 기간이 `013`이면 404다.

## 필드 매핑 — SEC EDGAR

`facts.us-gaap.<태그>.units.USD`(주식 수는 `facts.dei.EntityCommonStockSharesOutstanding.units.shares`)만 쓴다. USD가 아닌 단위, 10-K·10-Q 이외 양식(`10-K/A`, `8-K`, 20-F 등)의 사실은 쓰지 않는다. `us-gaap` 분류가 없는 회사(외국 발행사)는 오류가 아니라 빈 재무제표와 경고를 돌려준다.

| 필드                | 태그(우선순위, **기간마다** 첫 번째로 값이 있는 태그)                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `revenue`           | `Revenues` → `RevenueFromContractWithCustomerExcludingAssessedTax` → `SalesRevenueNet` → `RevenueFromContractWithCustomerIncludingAssessedTax`    |
| `operatingIncome`   | `OperatingIncomeLoss`                                                                                                                             |
| `netIncome`         | `NetIncomeLoss`(지배기업 귀속). `ProfitLoss`로 대체하지 않는다                                                                                    |
| `totalAssets`       | `Assets`                                                                                                                                          |
| `totalLiabilities`  | `Liabilities`. 이 태그를 쓰지 않는 회사는 `null`이다(자산−자본으로 만들지 않는다)                                                                 |
| `totalEquity`       | `StockholdersEquity`(지배기업 귀속). 비지배지분 포함 자본 태그로 대체하지 않는다                                                                  |
| `sharesOutstanding` | dei `EntityCommonStockSharesOutstanding`: 그 재무제표의 대표 공시(`accn`)에 같은 값만 있으면 그 값. 주식 종류별로 값이 여럿이면 모호하므로 `null` |

- **같은 기간의 여러 값**: 한 기간(`start`+`end`)은 이후 공시의 비교 열로도 나온다(재작성될 수 있다). **가장 먼저 공시된 값**을 쓴다("최초 보고 기준"). 그래서 재작성·정정은 반영하지 않으며, 대신 시점 기준 백테스트에 미래 값이 섞이지 않는다.
- **기간 분류**: `start`와 `end`의 일수로 정한다. 연간 350~380일, 3개월 80~100일, 9개월 누적 260~290일. 회계연도는 연간 기간의 `end`에서 15일을 뺀 날의 연도다(52/53주 회계연도와 1월 결산 회사 보정). 분기 번호는 해당 회계연도 시작일에서 분기 시작일까지의 일수를 91.3으로 나눈 값으로 정하고 ±12일 안이 아니면 그 분기를 쓰지 않는다. 연간 보고서가 아직 없는 진행 중 회계연도는 직전 연간 기간의 다음 날을 시작일로 본다(직전 연간 기간이 없으면 쓰지 않는다). **`fy`·`fp`·`frame` 필드는 읽지 않는다.**
- **잔액**: `start`가 없는 사실을 기간 종료일(`end`)로 맞춘다.
- **대표 공시와 접수일**: 재무제표 하나에 쓴 모든 사실의 `filed` 중 가장 늦은 날이 `filedAt`이다.
- `sourceUrl`은 `companyfacts` 주소다. 공시 문서별 주소는 문서에 정의되지 않아 만들지 않았다.

## 분기 흐름 규칙 (3개월 금액 통일)

화면과 계산은 분기 `revenue`·`operatingIncome`·`netIncome`을 **3개월 금액**으로 본다. 잔액(자산·부채·자본)은 기말 값이다.

**DART**

- `1분기`(11013)·`반기`(11012)·`3분기`(11014) 보고서의 손익 `thstrm_amount`는 공식 문서대로 3개월 금액이다. `thstrm_add_amount`는 누적 금액이다.
- 4분기 = 사업보고서(11011) `thstrm_amount`(연간) − 3분기 보고서 `thstrm_add_amount`(9개월 누적). 둘 중 하나라도 없으면 4분기 흐름은 `null`이다(4분기의 잔액은 사업보고서 값). `derived: true`.
- `thstrm_amount`가 비어 있고 누적만 있으면 2분기 = 반기 누적 − 1분기, 3분기 = 3분기 누적 − 반기 누적으로 만든다(`derived: true`).
- 검증: 반기 누적 ≠ 1분기 + 2분기, 3분기 누적 ≠ 반기 누적 + 3분기이면 그 분기 값을 제외하고 경고한다.

**SEC**

- 10-Q의 3개월 기간(80~100일)을 분기 값으로 쓴다. 6개월 누적은 쓰지 않는다.
- 4분기 = 10-K 연간 값 − 같은 회계연도 시작일에서 시작하는 9개월 누적 값(10-Q, ±3일). 9개월 값이 없으면 4분기 흐름은 `null`이고, 잔액은 10-K 값이다. `derived: true`. 10-K에 4분기 3개월 기간이 직접 있어도(드묾) 도출한 값을 쓴다.
- 정수가 아닌 값의 뺄셈은 소수 6자리로 반올림한다.

## 시점 기준(point-in-time) 규칙

- 모든 재무제표는 `filedAt`을 가진다. `statementsKnownAt(statements, date, {inclusive?})`는 `filedAt <= date`(기본, `inclusive: false`면 `<`)인 것만 돌려준다. `date`는 `YYYY-MM-DD` 또는 `Date`이며 형식이 틀리면 `RangeError`다. 접수일 형식이 올바르지 않은 재무제표는 항상 제외한다.
- 7b 시뮬레이션은 시장 개장 전에 판단하므로, 그날 접수된 공시를 쓰지 않으려면 `inclusive: false`를 쓴다.
- `valuationAt(statements, date, price?)`가 필터와 계산을 한 번에 한다. 계산 함수는 시계를 읽지 않는다.
- 값은 "최초 보고 기준"이다(SEC). DART는 `fnlttSinglAcntAll`이 돌려주는 보고서의 값이며 그 `rcept_no`의 접수일을 `filedAt`으로 쓴다. 정정본이 응답되면 정정본 접수일부터만 알려진 값으로 취급한다. 정정 이전에 알려졌던 원본 값은 복원하지 못한다.
- 회계 기간(`periodEnd`)이 아니라 공시일 기준이므로 분기 종료 직후에는 이전 공시의 TTM이 쓰인다.

## 계산(`src/lib/valuation.ts`, 순수 함수)

| 항목       | 정의                                                                                                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TTM 순이익 | 알려진 재무제표 중 가장 최근 기간부터 거꾸로 보며 처음 계산되는 값. 그 기간이 연간(`FY`)이고 순이익이 있으면 연간 값, 아니면 그 분기 포함 연속 4개 분기의 합. 하나라도 없으면 한 분기 앞으로 물러난다. 통화가 섞이면 쓰지 않는다 |
| 주식 수    | 기간 종료일이 가장 늦은 재무제표 중 값이 있는 것. TTM 종료일보다 400일 넘게 오래됐으면 쓰지 않는다                                                                                                                               |
| EPS        | TTM 순이익 ÷ 주식 수. 음수도 부호 있는 값으로 돌려준다                                                                                                                                                                           |
| BPS        | 가장 최근 자본 ÷ 주식 수                                                                                                                                                                                                         |
| ROE        | TTM 순이익 ÷ 평균 자본(TTM 종료 시점 자본과 4분기 전 자본의 평균). 비율(0.12 = 12%)                                                                                                                                              |
| PER        | 가격 ÷ EPS(TTM) (`priceRatios`)                                                                                                                                                                                                  |
| PBR        | 가격 ÷ BPS (`priceRatios`)                                                                                                                                                                                                       |

각 지표는 `{value, reason, asOf}`다. `asOf`는 그 값에 쓴 재무제표들의 `filedAt` 중 가장 늦은 날이고, 최상위 `asOf`는 모든 사용분 중 가장 늦은 날이다. `value`가 `null`이면 `reason`이 아래 중 하나다.

| 이유 코드                     | 뜻                                                            |
| ----------------------------- | ------------------------------------------------------------- |
| `NO_STATEMENTS`               | 알려진 재무제표 없음                                          |
| `INSUFFICIENT_QUARTERS`       | 연속 4개 분기(또는 연간) 순이익이 없음                        |
| `MISSING_SHARES`              | 쓸 수 있는 주식 수 없음                                       |
| `MISSING_EQUITY`              | 자본 없음                                                     |
| `INSUFFICIENT_EQUITY_HISTORY` | ROE의 평균에 필요한 4분기 전 자본 없음                        |
| `NON_POSITIVE_EPS`            | EPS ≤ 0이라 PER을 만들지 않음                                 |
| `NON_POSITIVE_EQUITY`         | BPS ≤ 0(PBR) 또는 평균 자본 ≤ 0(ROE)                          |
| `INVALID_PRICE`               | 가격이 유한한 양수가 아님                                     |
| `CURRENCY_MISMATCH`           | 가격 통화와 재무제표 통화가 다름, 또는 TTM 분기의 통화가 섞임 |

EPS·BPS는 부호 있는 값으로 노출하고, 비율(PER·PBR·ROE)만 0 이하일 때 `null`로 만든다. 음수 EPS를 숨기지 않기 위해서다.

`sectorSummary(values)`는 `null`·`undefined`·비유한 값을 빼고 `{count, excluded, mean, median}`을 돌려준다. 하나도 없으면 평균·중앙값이 `null`이다. 같은 업종 구성 종목의 PER·PBR을 모아 호출하는 것은 화면 단계 작업이다(아직 연결하지 않음).

## 전송·한도·캐시

| 항목             | DART                                                                               | SEC EDGAR                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 호스트           | `https://opendart.fss.or.kr/api/` 고정                                             | `https://www.sec.gov/files/company_tickers.json`, `https://data.sec.gov/api/xbrl/companyfacts/` 고정     |
| 인증             | 쿼리 `crtfc_key`(환경 `DART_API_KEY`, 40자 영숫자)                                 | 헤더 `User-Agent`(환경 `SEC_USER_AGENT`, 연락처 필수). 없으면 어댑터를 만들지 않아 503 `SEC_UNAVAILABLE` |
| 시간 제한        | 요청당 15초, `redirect: 'error'`                                                   | 요청당 15초, `redirect: 'error'`                                                                         |
| 응답 크기 상한   | ZIP 10 MiB, JSON 4 MiB, 오류 문서 64 KiB. `Content-Length`와 실제 스트림 모두 검사 | 티커 파일 3 MiB, companyfacts 40 MiB. 같은 방식                                                          |
| 요청 간격        | 150 ms(최대 초당 약 6건). 일일 한도는 문서 기준 약 20,000건                        | 250 ms(**초당 4건**, SEC 상한 10건의 절반 미만)                                                          |
| 식별자 지도 캐시 | 고유번호 지도 24시간, 프로세스 메모리, 동시 요청 합치기(singleflight)              | 티커→CIK 지도 24시간, 같은 방식                                                                          |
| 재무제표 캐시    | 종목별 6시간, 최대 100종목, singleflight                                           | 같은 방식                                                                                                |
| 한도 도달        | `020`이면 1시간 동안 제공자 호출 없이 503 `PROVIDER_RATE_LIMITED`                  | HTTP 429면 `Retry-After`(없으면 60초, 최대 1시간)를 `retryAfter`로 전달                                  |

- 캐시는 Cloud Run 인스턴스마다 따로다(최대 2인스턴스). 한도·간격 제한도 인스턴스별이다.
- 요청 간격 제한기는 대기열이 60초를 넘으면 503 `PROVIDER_BUSY`로 거절한다.

### 고유번호 ZIP 처리

새 의존성 없이 `node:zlib`의 `inflateRaw`로 푼다(`src/server/fundamentals/zip.ts`). 디스크에 쓰지 않는다.

1. ZIP 끝의 중앙 디렉터리 끝 레코드(EOCD)를 뒤에서부터 찾는다. 여러 디스크, ZIP64, 항목 수 0 또는 8개 초과, 중앙 디렉터리 범위 이상은 거부한다.
2. 중앙 디렉터리에서 `CORPCODE.xml`(대소문자 무시) 항목 **하나**를 찾는다. 없거나 두 개 이상이면 거부한다. 암호화 플래그, 저장(0)·deflate(8) 이외 방식은 거부한다.
3. 선언된 압축 크기 ≤ 10 MiB, 선언된 해제 크기 ≤ 80 MiB를 풀기 전에 확인한다. 지역 헤더 서명과 데이터 범위를 검사한다.
4. `inflateRaw`에 `maxOutputLength`를 선언 크기로 준다. 선언을 속인 압축 폭탄은 실제 해제 중에 멈춘다. 해제 결과의 길이와 CRC-32가 선언과 다르면 거부한다.
5. XML은 `DOCTYPE`/`ENTITY` 선언이 있으면 거부한다. `<list>` 블록을 문자열로 나눠 `stock_code`가 6자리인 상장사 블록만 모아 `fast-xml-parser`로 해석한다(비상장 약 95%는 해석하지 않아 메모리를 아낀다). 같은 `stock_code`가 여럿이면 `modify_date`가 가장 늦은 것을 쓴다.

## 실패 처리

제공자 원문 오류, 요청 URL(키 포함), User-Agent는 응답·로그에 내보내지 않는다. 통신 예외는 잡아서 코드만 남긴다. 어댑터는 로그를 남기지 않는다.

| 상황                                                 | 앱 응답                                     |
| ---------------------------------------------------- | ------------------------------------------- |
| 통신 실패·시간 초과·스트림 오류                      | 503 `PROVIDER_UNREACHABLE`                  |
| DART `010`·`011`·`012`·`901`, HTTP 401/403           | 503 `PROVIDER_ACCESS_DENIED`                |
| DART `020`, HTTP 429                                 | 503 `PROVIDER_RATE_LIMITED`(+`Retry-After`) |
| DART `800`·`900`, 그 밖의 HTTP 오류                  | 503 `PROVIDER_UNAVAILABLE`                  |
| DART `100`·`101`·`021`(요청이 잘못됨)                | 502 `PROVIDER_REQUEST_REJECTED`             |
| 응답 형식 불일치, 알 수 없는 상태 코드, 손상된 ZIP   | 502 `PROVIDER_SCHEMA_INVALID`               |
| 응답 크기 초과                                       | 502 `PROVIDER_RESPONSE_TOO_LARGE`           |
| 종목 코드를 못 찾음, SEC 404, 모든 DART 기간이 `013` | 404 `FUNDAMENTALS_NOT_FOUND`                |
| 처리 중 알 수 없는 예외                              | 500 `FUNDAMENTALS_FAILED`(내용 없음)        |

부분 실패는 허용하지 않는다: 한 호출이 실패하면 그 종목 조회 전체가 실패하고 실패 결과는 캐시하지 않는다(DART `013`은 실패가 아니다). 캐시된 이전 값을 만료 후 오류 대신 쓰지 않는다.

## 테스트

외부 통신 없이 주입한 transport와 합성 fixture(`tests/fixtures/fundamentals/`)로 돌린다. 합성 fixture는 실데이터 검증이 아니다. fixture의 회사·금액·접수번호는 모두 만든 값이고, SEC fixture는 일부러 `fy`·`fp`를 틀리게 넣어 어댑터가 이 필드에 의존하지 않음을 검증한다.

- `tests/fundamentals-dart.test.ts`: ZIP 추출(저장·deflate, 크기 한도, 선언을 속인 압축 폭탄, 암호화·CRC·중복·항목 수·손상), 고유번호 XML(상장사만, 중복 코드, DOCTYPE), 고정 호스트·redirect 금지·캐시·동시 요청 합치기, 분기 3개월 값과 4분기 도출, 누적만 있는 분기, 누적 불일치 제외, 접수일 없는 보고서 제외, 연결→별도 전환, 상태 코드 표, `020` 대기, 키·URL 비노출, 시점 필터(접수일 하루 전과 당일).
- `tests/fundamentals-sec.test.ts`: 기간 길이 분류, 최초 공시 우선(정정·재작성 비교 열 무시), 태그 우선순위와 태그 변경, 4분기 도출, 없는 항목 `null`, 진행 중 회계연도, 접수일, 모호한 주식 수, 시점 필터와 TTM, USD 이외·us-gaap 없음·형식 오류, 고정 URL·User-Agent·캐시, 티커 정규화, 404/403/429/500, 요청 간격 제한기, User-Agent 검증.
- `tests/valuation.test.ts`: 시점 필터(경계·`inclusive`·잘못된 날짜·미래 값을 바꿔도 결과 동일), TTM·EPS·BPS·ROE 수식, 연간 우선, 분기 누락 시 물러남, 이유 코드 전부, 업종 요약.
- `tests/fundamentals-router.test.ts`: 401/403/400/503/404/오류 매핑, KR·US 라우팅, 키 비노출, 분당 제한.

## 연결 현황과 남은 것

- (완료) `app.ts`·`index.ts` 마운트와 환경 변수 연결. 어댑터가 없으면 해당 시장은 503 `DART_UNAVAILABLE`/`SEC_UNAVAILABLE`이고 화면은 "데이터 제공자가 연결되지 않았습니다"와 서버 문구를 보인다. 토스 연결과 별개의 원인으로 구분한다.
- (완료) 화면: 요약의 PER·PBR(토스 현재가와 `priceRatios`, "재무 공시일·계산 시각" 표시), 가치·재무 탭의 연간·분기 표와 EPS·BPS·ROE, 같은 업종 비교. 업종 비교는 토스 `/sectors` 구성 종목 상위 20개(대상 종목 제외)를 **종목마다 `/api/fundamentals`로 조회**해 `sectorSummary`로 요약한다. 이 API가 사용자당 분당 30회라 20개로 제한했고 버튼을 눌러 실행한다. 한도(429)에 걸리면 나머지는 "요청 한도로 조회하지 못함"으로 제외하고 부분 결과를 그대로 보여 준다. 국내 첫 조회는 종목당 DART 약 25회라 오래 걸릴 수 있어 진행률을 표시한다(캐시 6시간).
- 여전히 남은 것: Terraform의 `investing-dart-api-key` 비밀과 `SEC_USER_AGENT` 배포 변수([계획 2단계](../planning/next-phase-plan.md), 이 단계는 infra를 건드리지 않음), 실제 DART·SEC 호출 검증(첫 호출 전까지 위 "문서에 없어서 확인해야 하는 것"은 가정), 일일 한도를 고려한 업종 일괄 계산(서버 쪽 사전 계산·저장은 4단계 이후).
- 7b 백테스트의 과거 연도 확장: DART는 기본 3년(현재 연도와 앞 2년)만 받는다(`yearsBack` 옵션). 더 긴 과거가 필요하면 호출 수(연도당 8건)와 일일 한도를 계산한 뒤 늘린다. 일일 데이터 적재(4단계)가 재무제표를 저장하는 방식은 정해지지 않았다.
- 결산월이 12월이 아닌 한국 회사의 정확한 `periodEnd`, 우선주를 제외한 보통주 EPS, SEC 정정 공시(`10-K/A`) 반영, 외국 발행사(20-F/40-F, IFRS)는 지원하지 않는다.
