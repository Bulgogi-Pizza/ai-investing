# 경제 캘린더

SOT: docs/planning/requirements.md. 구현: src/features/calendar/CalendarPage.tsx, 필터·날짜 계산: src/lib/market.ts, KST 기준일: src/lib/kst.ts.

## 등록 일정 전용

예시(합성) 일정과 데모 모드는 없다. 화면은 열릴 때 인증된 `/api/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD`에서 월 전후 경계 날짜를 포함해 읽는다. 관리자가 출처와 함께 등록한 일정과 공식 RSS 보도자료만 표시하며, 전체 경제 일정의 실시간 공급은 미연결이다(아침 작업이 FRED 카탈로그 발표를 채운다: [아침 갱신](#아침-갱신-6b)). 처음 열 때의 월·일은 **오늘(KST)** 이고 "오늘로 이동"으로 돌아온다. 월/주/일/시간 순 타임라인, 이전/다음 기간, 중요도/카테고리/자산/시장 AND 필터, 제목 검색, 이벤트 상세 및 세션 내 관심 저장을 제공한다. 영향 해석에는 출처, 가정, 불확실성, 시계를 표시한다. 모든 시간은 KST다.

상태: 로딩, 조회 실패(경고 + 다시 시도), 등록 일정 없음("등록된 일정이 없습니다", 예시로 대체하지 않음), 조회 한도 초과(`truncated`)를 각각 명시한다.

범위(소유자 전용): 확정 설계 결정 9에 따라 `GET /api/calendar/events`, `GET /api/news/sources`, 관리자 쓰기 경로(`POST /api/admin/calendar/events`, `POST /api/admin/news/sync`)는 로그인에 더해 **소유자 검사**(`TOSS_OWNER_USER_ID`)를 서버에서 한다. 쓰기 경로는 관리자이면서 소유자여야 한다. 라우터(`calendar.ts`, `news.ts`)도 `ownerUserId`를 받아 장착 순서에 의존하지 않고 다시 검사하며, 소유자 ID가 없으면 503으로 닫는다. 소유자가 아닌 계정은 403 `OWNER_REQUIRED`이며 화면은 일정·관리 도구 없이 "소유자 계정 전용 기능입니다" 안내만 보여 준다(관리자 계정 관리 대화상자는 관리자 전용 경로라 유지).

## 기간 이동

실제 달력 날짜 산술을 사용한다. 주 시작은 일요일이며 월·연도 경계에서 주/일 이동이 가능하다. 월간 달력의 인접 월 숫자는 비활성화된다. 기간·검색·필터 변경 시 선택 이벤트를 초기화한다. 주간 일정은 일(day) 숫자가 아닌 전체 ISO 날짜와 시각으로 정렬한다(`compareEventTime`).

## 관리자 등록 일정

관리자는 JSON 입력 대화상자로 `POST /api/admin/calendar/events`에 1–100개 이벤트를 등록한다. 서버가 날짜·출처 HTTPS URL·확인시각·영향방향·시계·확신·중복 ID를 검증한 후 ID별 upsert한다. 비관리자는 입력 버튼이 없고 서버가 권한을 검사한다. 상세에는 원문 링크 및 KST 확인시각과 영향 해석의 확신·기간·조건을 표시한다. 여러 영향자산의 어느 태그로든 필터링되며 사용자 정의 카테고리·자산도 필터 옵션에 추가된다. 낮음·보통·높음은 라벨·점 개수·색상으로 구별한다.

## 공식 보도자료 수집

관리자는 공식 출처 목록과 수집 범위 경고를 확인한 후 RSS 가져오기 버튼으로 연준/한국은행의 최근 공개 보도자료를 수집한다. UI는 출처별 synced/cached/failed와 upsert건수·경고를 표시하며 전부 실패하면 실제 오류를 표시한다. 성공 시 일정을 재조회한다. 예약 수집은 아침 작업(6b)이 같은 `syncOfficialNews`를 매일 부른다. API/출처/검증 계약은 [공식 뉴스 공급](news-provider.md)을 따른다. 선택 필드 `eventKind`는 scheduled 또는 news-release이며 news-release의 날짜·시각은 KST 게시시각이지 미래 경제지표 발표가 아니다.

## 아침 갱신 (6b)

작업 `investing-morning-calendar`(매일 07:00 KST, [jobs.md](../operations/jobs.md))가 캘린더를 채운다. 코드: `src/jobs/morning-calendar.ts`(본체), `src/server/ai-morning.ts`(AI 계약), `src/server/morning.ts`(실행 기록·브리핑 API). 상태: **구현·합성 테스트 완료, 운영 적용 전, AI 단계는 꺼짐**(사용자가 월 AI 비용을 승인하기 전까지).

### 이벤트 모델 확장

`EconomicEvent`에 모두 선택 필드로 추가했고 `cleanEvent`가 형식을 검사한다(없는 필드는 그대로 두고, 형식이 틀리면 이벤트를 거부한다).

| 필드                          | 뜻                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `time: ''`                    | 제공자가 발표 시각을 주지 않음. 화면은 "발표 시각 미확인"으로 표시한다(`HH:mm` 형식 검사는 그대로, 빈 문자열만 추가로 허용)                         |
| `indicatorIds`                | 이 이벤트의 발표값이 속한 카탈로그 지표 ID. 아침 작업이 FRED·ECOS 값을 붙일 대상을 정한다(ECOS는 발표 일정이 없어 관리자 등록 이벤트에 직접 넣는다) |
| `values[]`                    | 발표값. 지표별 `actual`·`previous`·`unit`·`period`·`previousPeriod`·`source`·`observedAt`(작업이 받은 UTC 시각). 소수 문자열 그대로                 |
| `aiSummary`                   | `{text, model, generatedAt}`. `null`이면 "AI 단계가 꺼졌거나 만들지 못함", 없으면 아직 처리 안 함                                                   |
| `titleOriginal`·`translation` | 제목이 한국어 번역일 때 제공자 원문 제목과 `{model, translatedAt}`. 원문 링크는 기존 `sourceUrl`                                                    |

`time: ''`인 이벤트는 추천 근거(`recommendations.ts`)에서 그 날짜의 끝(23:59 KST)까지 "다가오는 일정"으로 본다.

### 작업 단계 (모두 멱등, 한 단계의 실패가 다음 단계를 막지 않는다)

1. **다가오는 일정**: FRED `upcomingReleases(오늘-7일, 오늘+45일)`로 카탈로그 발표를 `macroEventId`(같은 발표·날짜는 같은 ID)로 upsert한다. FRED는 발표 시각을 문서에서 밝히지 않으므로 `time: ''`. 오늘-7일부터 받는 이유는 첫 실행에도 값을 붙일 이벤트가 있게 하려는 것이다.
2. **공식 보도자료**: 기존 `syncOfficialNews`(연준·한국은행 RSS)를 호출한다.
3. **지난 일정의 값**: 최근 7일(어제까지) 중 `indicatorIds`가 있는 이벤트에 FRED `latestObservations(…, 오늘)`·ECOS `latestObservations`의 최신·직전 관측을 붙인다. 규칙: ① 값이 `null`이면 덮지 않는다 ② 더 오래된 기간으로 되돌리지 않는다 ③ 같은 값이면 쓰지 않는다(`observedAt` 유지) ④ **신선도 검사**: 직전 기간 값을 새 결과로 오인하지 않도록 관측 기간이 이벤트 날짜보다 월간 60일·분기 180일 안에 있어야 하고, 일간 지표(정책금리)는 결정일 이후 관측이어야 한다(FRED는 결정일 다음 날 이후, ECOS는 결정일 이후). 통과하지 못하면 `VALUE_NOT_AVAILABLE_YET`로 기록하고 다음 날 다시 시도한다. 이 임계값은 일반적인 발표 지연에서 정한 **경험적 값**이며 실제 FRED 호출로 확인하지 못했다.
4. **AI 단계**(`MORNING_AI_ENABLED=true`일 때만, [ai-provider.md](ai-provider.md#아침-작업-계약-6b)): 최근 3일 중 값이 있고 요약이 없는 이벤트(최대 8개)를 한 번의 호출로 요약하고, 한글이 없는 미국 이벤트 제목(최대 20개)을 한 번의 호출로 번역한다. 꺼져 있으면 값이 붙은 이벤트에 `aiSummary: null`만 남기고 번역은 하지 않는다. 값이 없는 이벤트는 요약하지 않는다(모델이 사실을 지어내지 못하게).
5. **브리핑**: 최근 발표 결과 최대 3건, 7일 안의 중요도 보통 이상 일정 최대 3건, AI 요약 한 문장(있을 때)을 한국어 짧은 글로 만들어 `morningRuns/{KST 날짜}.brief`에 저장하고 텔레그램 `morning-brief`로 하루 한 번 보낸다. 날짜는 "10월 21일"처럼 쓰고 숫자는 짧게 유지해 알림 정제(8자리 이상 숫자·URL 제거)에 지워지지 않는다. 같은 날 다시 실행해도 이미 보낸 브리핑은 다시 보내지 않는다(강제 재실행은 다시 보낸다).

재수집이 덮어쓰지 않도록 이벤트 쓰기는 `PreservingCalendarRepository`를 거친다: 저장된 값·AI 요약·`indicatorIds`는 유지하고, 번역은 제공자 제목이 그대로일 때만 유지하며(RSS가 매일 영어 제목을 다시 준다), 알려진 시각을 "미확인"으로 덮지 않는다.

실행 기록 `morningRuns/{날짜}`: 상태(`complete`·`partial`·`failed`), 시도 횟수, 단계별 상태·건수·정제된 코드, AI 호출 수와 토큰 합계(공급자가 준 숫자만), 브리핑, 알림 결과. 키·응답 원문·오류 메시지는 담지 않는다. `GET /api/calendar/brief`(소유자 전용)가 브리핑이 있는 가장 최근 기록의 글만 돌려준다.

### 화면 (`src/features/calendar/`)

- 페이지 위 "아침 브리핑" 카드: 로딩·비어 있음("아직 저장된 브리핑이 없습니다")·조회 실패를 각각 말한다. 브리핑 실패는 캘린더를 막지 않는다.
- 상세: "발표 결과" 목록(지표명, 발표·이전 값과 단위, 기준 월, 출처, 받은 시각), 값이 있을 때만 보이는 "AI 요약" 블록(모델명·생성 시각·"틀릴 수 있다" 안내), 번역 제목의 "원문 제목 보기/숨기기"와 "AI 번역" 표시.
- 시각이 없는 이벤트: 칩에 "시각 미확인", 상세에 "발표 시각 미확인", 시간별 보기에는 별도 행.
- 스타일은 `calendar-morning.css`에 있다(전역 `styles.css`는 건드리지 않았다).

### 검증과 한계

- `tests/morning-calendar.test.ts`(작업 단계·멱등·부분 실패·AI 꺼짐/켜짐·값 규칙·브리핑 정제 왕복·설정), `tests/ai-morning.test.ts`(요청 형태·응답 검증·기능별 한도), `tests/morning-api.test.ts`(모델 검증·브리핑 API·Terraform·배포 정적 검사), `tests/morning-calendar.spec.ts`(E2E: 값·AI 블록·원문 토글·시각 미확인·브리핑 상태).
- 실제 FRED·ECOS·Vertex·텔레그램 호출은 하지 않았다. 신선도 임계값, FRED `release/dates`가 과거 날짜에도 동작하는지, 결정일 이후 관측이 언제 올라오는지는 첫 실호출에서 확인한다.
- 값은 현재 빈티지 기준 최신 관측이다. 이후 수정(revision)이 있으면 더 새 기간이 아닌 한 갱신하지 않는다.
- 예상치(`forecast`)는 공식 API로 얻을 수 없어 채우지 않는다.

## 검증

- `tests/market.test.ts`: AND 필터(합성 이벤트 fixture), 날짜 산술, 연도 경계 정렬, 중요도 표시, `tests/ui-state.test.ts`: KST 날짜 경계.
- `tests/calendar-api.test.ts`: 등록 일정 권한·검증.
- E2E(가짜 API, 시계 고정 2026-10-20 KST): `tests/app.spec.ts`(필터·뷰·월 이동·출처 링크), `tests/ui-regressions.spec.ts`(낮은 중요도·잘림 안내·연도 경계·빈 상태·조회 실패 재시도), `tests/providers.spec.ts`(공식 출처 조회·수집 성공/실패). fixture는 합성이며 실제 보도자료 본문을 저장소에 넣지 않는다.

## 링크와 세션

출처 링크(상세의 `sourceUrl`, 공식 출처 `feedUrl`)는 `https://`로 시작하는 URL일 때만 링크로 그리고 아니면 글자로만 표시한다(`src/components/SourceLink.tsx`). 일정 조회가 401(`AUTH_REQUIRED`)이면 앱이 로그인 화면으로 돌아간다.
