# 텔레그램 알림 — NOTIFICATIONS

SOT: [next-phase-design.md](../planning/next-phase-design.md)의 "알림" 절과 [next-phase-plan.md](../planning/next-phase-plan.md) 6a. 서버 구현: `src/server/notify.ts`. 기능 테스트: `tests/notify.test.ts`.

## 공식 계약

확인일: 2026-10-21 KST. [Telegram Bot API](https://core.telegram.org/bots/api)의 [Making requests](https://core.telegram.org/bots/api#making-requests)와 [sendMessage](https://core.telegram.org/bots/api#sendmessage) 문서를 직접 읽고 아래만 사용한다. 이 문서에 쓰인 Bot API 버전 번호는 확인하지 못했다. 최신 페이지 기준이다.

- 요청 형식: `https://api.telegram.org/bot<token>/METHOD_NAME`, HTTPS 전용. GET과 POST를 지원하고 `application/json` 본문을 쓸 수 있다. 우리는 POST + JSON만 쓴다.
- 응답: 항상 Boolean `ok`가 있다. 성공이면 `result`, 실패면 `ok:false`와 `description`, 정수 `error_code`(문서가 "내용은 바뀔 수 있다"고 명시)가 온다. 일부 오류에는 `parameters`(ResponseParameters)가 붙고, flood control이면 `retry_after`(초)가 있다.
- `sendMessage` 파라미터 중 사용하는 것: `chat_id`(Integer 또는 String, 필수), `text`(String, 필수, 엔티티 파싱 후 1–4096자), `link_preview_options`(LinkPreviewOptions) 안의 `is_disabled`(Boolean). 그 외 파라미터는 보내지 않는다. `parse_mode`와 `entities`를 쓰지 않으므로 텍스트는 서식 없이 그대로 표시된다. 마크업 주입 경로가 없다.
- 이 문서에서 하지 않은 것: 텔레그램으로 명령을 받는 기능(webhook, getUpdates)은 구현하지 않는다. 설계가 이번 단계는 보내기만 하도록 정했다.

## 경계

- 호스트는 `https://api.telegram.org`로 고정한다. 받는 쪽(`chat_id`)과 봇 토큰은 생성자 설정으로만 받는다. 환경변수 `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`를 `notifierFromEnvironment()`가 읽는다(`tossFromEnvironment`와 같은 방식). 요청 입력에서 받는 경로가 없다.
- 토큰은 API 규격상 URL 경로에 들어간다. 그래서 URL, 요청 본문, 응답 본문, 제공자 `description`, 원본 오류 메시지를 로그·응답·저장소 어디에도 내보내지 않는다. 전송 실패는 `NotificationDeliveryError`의 고정 코드 하나로만 표현한다. 토큰과 chat ID는 `#private` 필드에 두어 JSON·검사 출력에 나오지 않는다.
- 토큰 형식(`숫자:영숫자_-` 20자 이상)과 chat ID(정수 문자열)를 생성 시 검사한다. 형식이 틀리면 생성하지 않아 경로 주입이 불가능하다. `notifierFromEnvironment()`는 값이 없거나 형식이 틀리면 `undefined`를 돌려주고, 그 경우 알림은 `disabled`로 기록된다. 부팅을 실패시키지 않는 이유는 알림 설정 오류가 매매 작업을 막으면 안 되기 때문이다.
- 전송: POST JSON, 8초 제한(`AbortSignal.timeout`), `redirect:'error'`, 리다이렉트된 응답 거부, 응답 64KiB 상한(Content-Length와 실제 스트림 각각). `{ok}`만 최소로 해석한다. 성공은 `ok:true`이고 HTTP 성공일 때다. HTTP 429는 `TELEGRAM_RATE_LIMITED`, 그 밖의 거부는 `TELEGRAM_REJECTED`, 시간 초과는 `TELEGRAM_TIMEOUT`, 연결 실패는 `TELEGRAM_UNREACHABLE`, JSON이 아니거나 `ok`가 없거나 너무 큰 응답은 `TELEGRAM_RESPONSE_INVALID`다. 자동 재시도는 하지 않는다. 같은 알림이 중복 전송될 수 있어서다.

## 이벤트와 메시지

`NotificationEvent`는 설계의 알림 목록을 그대로 타입으로 만든다.

| kind                                            | 내용                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fill`                                          | 체결. `mode`(`paper`/`live`), 종목, 방향, 체결·일부 체결, 알고리즘                                                                                                                                                                               |
| `algorithm-auto-stop`                           | 알고리즘 자동 정지. 선택 사유(`loss-limit`, `data-error`, `order-permission`, `first-order-rejected`)                                                                                                                                            |
| `order-rejected`                                | 주문 거부. 고정 사유 문구(`broker-rejected`, `safety-guard`)만 허용                                                                                                                                                                              |
| `data-error`                                    | 데이터 오류. 대상(시세·캔들·재무·뉴스·캘린더·기타)과 선택 종목                                                                                                                                                                                   |
| `live-order-unconfirmed`                        | 실전 주문을 보냈지만 응답을 못 받음(접수 여부 미확인). 선택 종목·방향·알고리즘 이름. "토스증권 앱에서 주문 내역을 확인" 안내                                                                                                                     |
| `job-failure`                                   | 작업 실패. 작업 이름                                                                                                                                                                                                                             |
| `morning-brief`                                 | 아침 브리핑. 선택 요약 문장(정리 후 600자 이하)                                                                                                                                                                                                  |
| `budget-warning`·`budget-stop`·`budget-resumed` | 월 예산 경고·한도 도달·새 기간 자동 재개([월 예산 자동 중지](../operations/budget.md)). 금액 없이 상태만 알린다. 화면 경로는 `/`                                                                                                                 |
| `setting-risk-increase`                         | 위험을 늘리는 설정 변경: `live-enabled`, `budget-raised`, `emergency-stop-released`, `algorithm-stop-released`, `max-orders-raised`, `min-holding-lowered`, `loss-stop-loosened`, `liquidity-lowered`, `budget-stop-released`(월 예산 정지 해제) |

타입에 금액·수량·계좌 식별값·제공자 오류 필드가 없다. 모의는 `[모의 운용·가상 체결]`과 "가상 기록이며 실제 주문이 아닙니다", 실전은 `[실전 주문·실제 체결]`과 "실제 주문입니다."로 구분한다. 위험 증가 설정 변경에는 "본인이 한 변경이 아니면 화면에서 바로 긴급 정지를 누르세요."를 붙인다. 마지막 줄은 `화면: APP_ORIGIN + 고정 경로`다. 경로는 알림 종류에서 고르며(알고리즘 관련 `/algorithms`, 아침 브리핑 `/calendar`) 입력으로 받지 않는다. 앱이 아직 URL 경로를 쓰지 않으므로 서버의 SPA 대체 응답이 첫 화면을 열고, 화면별 경로 처리는 알고리즘 화면 단계에서 맞춘다.

### 정리 규칙 (`sanitizeNotificationText`)

모든 자유 문자열(알고리즘 이름, 작업 이름, 요약)과 본문 줄에 적용한다. 종목은 `[A-Za-z0-9][A-Za-z0-9.-]{0,11}` 허용 목록에 맞을 때만 쓰고 아니면 `(종목 확인 필요)`로 대체한다. 열거형 값은 허용 표에 없으면 중립 문구로 대체한다.

- NFKC 정규화(전각 숫자 등을 일반 문자로), 제어·방향·보이지 않는 문자를 공백으로 바꾸고 한 줄로 합친다.
- `scheme://...`, `mailto:`·`tg:`·`javascript:`·`data:`·`file:`·`ftp:`, `www.`, 도메인 형태(`name.tld/path`)를 제거한다. 화면 링크는 정리 대상이 아니라 정리 뒤에 붙인다.
- 이메일 형태와 모든 `@`를 제거한다.
- 24자 이상의 영숫자·`_`·`-` 연속(키·토큰 형태)을 제거한다.
- 숫자가 8자리 이상 이어지면 제거한다. 공백·쉼표·하이픈 하나로 끊긴 경우(`123-456-789012`, `1234 5678`)와 날짜(`2026-10-21`)도 포함한다.
- 결과가 더 줄지 않을 때까지(최대 4회) 반복하고, 필드 길이(기본 60자, 요약 600자)와 본문 전체 1,000자로 자른다.

## 저장

컬렉션 `notifications`(서버 전용, 문서 ID는 난수 UUID). 필드: `id`, `kind`, `mode?`, `createdAt`(ISO), `status`, `failureCode?`, `message`(정리된 본문과 화면 링크), `ttlAt`(Firestore Timestamp, 보존 90일 제안). 토큰·chat ID·제공자 응답은 저장하지 않는다. 읽을 때는 명시적으로 위 필드만 투영한다. `status`는 `pending`(기록 후 전송 전), `sent`, `failed`, `disabled`다. 설계의 세 값 외에 `pending`을 둔 것은 기록을 먼저 남기기 위해서다. 프로세스가 전송 도중 끝나면 `pending`으로 남는다. 개발·테스트용 `MemoryNotificationRepository`는 최근 500건만 유지한다. 목록은 `createdAt` 내림차순이며 단일 필드 정렬이라 별도 복합 색인이 필요 없다.

## 실패 처리

`NotificationService.notify(event)`는 어떤 경우에도 던지지 않는다.

1. 이벤트를 메시지로 만든다. 만들 수 없으면(앱 origin이 잘못됨 등) `failed/MESSAGE_INVALID`를 돌려준다. 알 수 없는 `kind`는 던지지 않고 중립 문구로 처리한다.
2. 먼저 기록한다. 설정이 없으면 `disabled`(`NOT_CONFIGURED`)로 기록하고 끝낸다.
3. 설정이 있으면 `pending`으로 기록한 뒤 전송하고 결과(`sent`/`failed`+고정 코드)로 갱신한다.
4. 저장소 쓰기가 실패해도 전송은 시도한다(반환값 `recorded:false`). 전송이 실패해도, 갱신이 실패해도 호출자에게 예외를 올리지 않는다. 호출한 매매 작업은 텔레그램 실패에 영향받지 않는다.

반환값은 `{status, failureCode?, recorded}`이며 로그에는 이것만 남기면 된다.

## 화면 API

`createNotificationsRouter({repository, ownerUserId})`의 `GET /api/notifications?limit=`. 기본 20, 1~50의 정수만 허용한다. 다른 쿼리 키·중복·비정수는 400 `INVALID_NOTIFICATION_QUERY`. 응답 `{notifications:[{id,kind,mode?,createdAt,status,failureCode?,message}], limit}`, 최근 순, `Cache-Control: no-store`. 라우터도 `res.locals.user`를 다시 검사한다. 로그인 정보가 없거나 비활성이면 401 `AUTH_REQUIRED`, 소유자 ID와 다르면(관리자 포함) 403 `OWNER_REQUIRED`다. `ownerUserId`가 비어 있으면 모두 거부한다. 저장소 오류는 상세 없이 503 `NOTIFICATIONS_UNAVAILABLE`이다.

## 검증

`tests/notify.test.ts` 26개. 외부 통신 없이 주입 transport만 쓴다. 정리 규칙(이메일·외부 URL·긴 숫자·토큰·제어문자·전각 숫자), 모의·실전 문구 구분, 모든 알림 종류, 고정 URL·POST·JSON 본문(문서화된 파라미터만)·`redirect:'error'`, 설정 형식 검증, 오류에 토큰·URL·응답 본문이 없음, 429·형식 오류·과대 응답·리다이렉트·연결 실패·시간 초과 분류, 먼저 기록 순서, 실패·미설정·저장소 장애 시 던지지 않음, 라우터 401·403·limit 검증·503을 검사한다. 실제 텔레그램 호출과 실제 Firestore 저장은 검증하지 않았다.

## 연결 상태 (7a, 2026-10-21)

- 연결됨: `createApp`이 `createNotificationsRouter`를 인증·동일 출처 확인과 `ownerGate` 뒤에 설치한다(`GET /api/notifications`). `index.ts`가 운영에서는 `FirestoreNotificationRepository`, 그 밖에는 메모리 저장소와 `notifierFromEnvironment()`, `APP_ORIGIN`으로 `NotificationService`를 만들어 주입한다. 앱 origin이 https(또는 127.0.0.1)가 아니면 서비스를 만들지 않고 알림은 전송되지 않는다(운영은 `createApp`이 먼저 거부).
- 호출처: 알고리즘 API가 긴급 정지 해제(`emergency-stop-released`)와 운용 금액 상향(`budget-raised`)에서 `setting-risk-increase`를 보낸다. 응답에 `notification` 결과(`sent`·`failed`·`disabled`)를 실어 화면이 정확히 안내한다. 실전 켜기(`live-enabled`)는 7f에서 연결한다.
- 화면: 내 자산 > 알고리즘 탭의 "최근 알림"(상태 배지, 모의·가상/실전·실제 라벨, 실패 이유, 화면 링크 줄은 숨김). 텔레그램 링크의 `/algorithms` 경로는 앱이 그 탭을 바로 연다.
- 테스트: `tests/algorithms-api.test.ts`(해제 시 알림 기록과 텔레그램 호출, 실패·미설정이 변경을 막지 않음, 금액이 메시지에 없음, 목록 소유자 전용), `tests/algorithms.spec.ts`(알림 목록 상태 배지·라벨).

## 아직 연결하지 않은 것

- `src/server/app.ts`·`index.ts`에서 라우터 설치(인증·동일 출처 이후)와 `FirestoreNotificationRepository` 주입, `notifierFromEnvironment()`로 서비스 생성. 아침 작업(`src/jobs/morning-calendar.ts`)은 `morning-brief`(하루 한 번)와 실행 실패 시 `job-failure`를 이 서비스로 보낸다. 알고리즘 API는 긴급 정지 해제·운용 금액 한도 상향 때 `setting-risk-increase`를 보낸다(7a).
- Secret Manager 비밀(`investing-telegram-bot-token`, `investing-telegram-chat-id`)과 서비스·작업의 비밀 참조, 환경변수 `TELEGRAM_BOT_TOKEN`·`TELEGRAM_CHAT_ID` 연결, Firestore `notifications.ttlAt` TTL 정책 — 계획 2단계(Terraform).
- 체결·자동 정지·주문 거부·데이터 오류·작업 실패·아침 브리핑을 호출하는 쪽(7c~7f, 6b).
- `.env.example`에 `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` 빈 항목 추가.
- 실제 봇으로 한 번 보내 보는 운영 확인과 그 기록.

## 7e/7f 연결 (2026-10-21)

- **실전 주문 알림**: `src/server/trading/alerts.ts`의 `liveAlertEvent`가 유일한 매핑이다. 접수 여부 미확인은 전용 종류 `live-order-unconfirmed`(이전에는 `job-failure`로 보냈다), 권한 문제 정지와 첫 주문 거부 정지는 `algorithm-auto-stop`의 `order-permission`·`first-order-rejected` 사유로 보낸다. 주문 거부(`order-rejected`)와 체결(`fill`)은 이전과 같다. 알림 실패는 주문을 막지 않는다.
- **위험 증가 설정 변경 알림(추가 인증 없음의 대가)**: 실전 켜기(`live-enabled`), 운용 금액 상향(`budget-raised`), 긴급 정지 해제(`emergency-stop-released`), 알고리즘 자동 정지 해제(`algorithm-stop-released`), 실전 알고리즘 전략 변경(`live-strategy-changed`), 안전장치 완화 네 가지(`max-orders-raised`, `min-holding-lowered`, `loss-stop-loosened`, `liquidity-lowered`)가 **변경이 저장된 직후 변경 종류마다 한 번** 나간다. 줄이는 변경(긴급 정지 켜기, 실전 끄기, 한도 낮추기, 안전장치 강화)은 알리지 않는다. 문구에는 금액·수량·설정 값이 없다. 응답의 `notification(s)`가 `sent|failed|disabled`를 그대로 화면에 알린다.
- 새 종류 `live-order-resolved`(소유자가 미확인 주문을 직접 정리함, 결과만 담음)와 자동 정지 사유 `unconfirmed-order`. 실전 자동 정지 알림에는 "보유 종목은 자동으로 팔지 않습니다" 안내가 붙는다.
- 텔레그램이 설정되어 있지 않으면 웹 서비스는 실전 켜기·운용 금액 상향을 409로 거부하고, 실전 작업은 시작하지 않는다(알림이 필수 안전장치). 실행 중 전송 실패는 주문을 막지 않고 기록된다.
- 테스트: `tests/notify.test.ts`(새 종류와 모든 변경 문구, 위험 값 정리), `tests/algorithms-api.test.ts`(변경마다 알림), `tests/algo-live-job.test.ts`(주문 거부·권한 정지·미확인), `tests/live-api.test.ts`(정지 해제 알림).
