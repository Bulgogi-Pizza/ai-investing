# 실제 금융 일정 데이터 — CAL

## 데이터 공급 경계

`src/server/calendar.ts`는 관리자가 출처를 검토한 금융 일정을 저장하고 인증된 사용자에게 제공한다. 외부 뉴스 공급 계약이나 자동 크롤러는 포함하지 않는다. 출처 URL은 참조용 문자열로 저장하며 서버가 방문하거나 가져오지 않는다. 빈 저장소는 빈 배열을 반환하고 실정보를 가장한 합성 일정을 생성하지 않는다. 예시 캘린더와 실제 등록 일정은 프론트엔드에서 명시적으로 전환한다.

## 계약

- `GET /api/calendar/events?from=2026-10-01&to=2026-10-31`: 로그인된 활성 계정. ISO 실제 날짜, 양끝 포함, 차이 최대366일. 중요도`importance=1|2|3`, 분류`category`, 영향자산`asset`, 시장`market=한국|미국|글로벌` 조건을 AND로 적용한다.
- `POST /api/admin/calendar/events` JSON `{events:[...]}`: 관리자만 등록 가능.1~100건, 요청 내 중복ID 거부. 숫자ID 기준 upsert이며 전체 삭제/교체가 아니다. 응답`{imported:n}`.
- 일정 필드: `id` 양의 safe integer, `date` ISO날짜, `time` KST HH:mm, `title`, `country` 한국/미국/글로벌, `category`, `assets` 중복 없는1~12개 태그, `importance`1~3, `description`, `sourceUrl`, `sourceName`, `impactDirection` mixed/up/down/unknown, `impactHorizon`, `confidence` low/medium/high, `factualObservedAt` 시간대 포함 ISO시각. 선택 필드는 `forecast`, `previous` 문자열.
- 출처URL은 HTTPS만 허용하고 URL 내 인증정보를 거부한다. 필드 길이와 날짜·시각을 검증하며 임의추가 필드는 저장/응답에서 제외한다. 모든 텍스트는 React 텍스트 노드로 렌더링해야 하며 HTML로 삽입하지 않는다.
- 응답은 `{events,source:'admin-curated',truncated,limit:2000}`. 범위 조회2001건으로 초과 여부 판단.2000건 초과 시`truncated:true`; 사용자는 날짜 범위를 좁혀야 한다.

## 저장 및 접근 통제

`MemoryCalendarRepository`는 개발/테스트 전용. `FirestoreCalendarRepository`는`economicEvents`컬렉션에 저장하며 숫자ID를 문서키로 사용한다. 날짜 단일필드 범위 조회/index를 사용한다. 최대100건 upsert는 atomic batch로 처리한다. 등록자ID와 수정시각은 서버 메타데이터로 저장하며 읽기 응답에는 포함하지 않는다. 출처 검증은 실제 사실·라이선스 확인을 대체하지 않는다. 중요도·영향방향·신뢰도는 관리자 입력의 판단이며 확정 예측이 아니다.

상위 Express 앱은 기존 인증·동일출처 검사와 body size/rate limit 뒤에 라우터를 설치한다. 라우터 자체도 로그인/관리자 권한을 재검사한다. 실제 이벤트는 공개 데모에 노출되지 않는다.

## 검증

`tests/calendar-api.test.ts`: 미인증 및 일반회원 쓰기 거부, 빈 저장소, upsert/AND필터, 내부 메타데이터 제외, 날짜범위·배열필터 검증, 위험URL/잘못된필드/중복/대량입력 거부, 마크업 텍스트 보존.

실행`npm test -- tests/calendar-api.test.ts`, 전체`npm run build`. 로컬 HTTP 소켓을 생성하는 supertest는 이 실행환경에서 listen 허용 권한이 필요하다. 2026-10-20 검증: 허용된 로컬 HTTP 테스트 환경에서6개 API 테스트 통과, 전체 프로덕션 빌드 통과. Firestore 실환경 연결 및 실제 원천 데이터의 정확성은 별도 운영 검증 대상이다.
