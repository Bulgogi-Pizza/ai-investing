# 월 예산 자동 중지

SOT: 이 문서. 결정(2026-10-21): 월 클라우드 예산 30,000원, 20,000원에 경고. 30,000원에 도달하면 앱이 비용을 만드는 기능을 스스로 멈춘다. **결제를 끄지 않는다.** 사이트와 데이터는 그대로 있다. 코드: `src/server/budget-guard.ts`, `src/jobs/budget-gate.ts`. Terraform: `infra/gcp/budget.tf`와 `main.tf`의 `google_billing_budget.app`. 테스트: `tests/budget-guard.test.ts`, `tests/budget.spec.ts`.

## 한계: 최선 노력이다

- **예산 알림은 몇 시간 늦는다.** 알림이 오는 사이에 비용이 더 쓰일 수 있다. 이 장치는 지출 상한이 아니다. 콘솔의 비용 화면을 함께 본다.
- **고정 비용은 멈추지 않는다.** 고정 IP, Cloud NAT, Firestore 저장·PITR, Artifact Registry, Secret Manager, Cloud Scheduler 작업 수는 중지 중에도 계속 청구된다. 이 항목은 앱이 끌 수 없다. 길게 쓰지 않으려면 사용자가 직접 정리한다.
- 요청으로 움직이는 화면(시세·자산 조회, 관리자의 일정 등록 등)은 중지 중에도 동작한다. 이 비용은 작다.
- 중지는 앱 안의 규칙이다. 앱 밖에서 만든 리소스(수동 실행한 gcloud 작업, 다른 프로젝트 서비스)는 막지 못한다.
- **Anthropic API 지출은 이 GCP 예산에 들어오지 않는다**(아래 [Anthropic 지출은 GCP 예산 밖이다](#anthropic-지출은-gcp-예산-밖이다)).

## 동작

```
Cloud Billing 예산 ─(모든 업데이트, schema 1.0)→ Pub/Sub 주제 investing-budget-alerts
   → push 구독(OIDC 토큰, 서비스 계정 investing-budget-push) → POST /api/internal/budget-alert
```

예산의 기본 이메일 수신자는 그대로 둔다(`disable_default_iam_recipients`를 쓰지 않는다). Pub/Sub 규칙은 추가 수신자다.

앱은 알림마다 `opsControl/budget` 한 문서를 거래(transaction)로 갱신한다.

| 상황 (같은 청구 기간 안)                                                                   | 결과                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 비용 < 경고 비율(`BUDGET_WARNING_RATIO`, 0.6667)                                           | 상태만 저장                                                                                                                                        |
| 경고 비율 이상, 한도 미만                                                                  | 텔레그램 `budget-warning` **기간당 한 번**                                                                                                         |
| 비용 ≥ 예산, 또는 `alertThresholdExceeded` ≥ 1.0                                           | `stopped = true`, **긴급 정지 켬**(이력 `budget-stop`), 텔레그램 `budget-stop` 한 번. 이후 알림은 아무것도 바꾸지 않음                             |
| 이전 기간의 늦은 알림, 아직 시작하지 않은 청구 기간(최대 하루 앞까지만 형식상 허용)의 알림 | 상태를 바꾸지 않는다(마지막 수신 시각만 갱신). 가짜·조작된 "가까운 미래" 메시지가 자동 재개를 일으키거나 진짜 알림을 "이전 기간"으로 만들지 못한다 |
| 새 청구 기간 알림이고 비용 < 예산                                                          | `stopped`를 자동으로 풀고 텔레그램 `budget-resumed`. **긴급 정지는 풀지 않는다**(소유자가 화면에서 해제)                                           |

- 긴급 정지를 켜는 데 실패하면 응답이 500이라 Pub/Sub이 다시 보낸다. 상태에 "긴급 정지 적용됨/알림 보냄" 표시가 있어 재시도가 중복 이력·중복 메시지를 만들지 않는다.
- 소유자가 긴급 정지를 먼저 풀고 `stopped`는 그대로 두면, 앱은 긴급 정지를 다시 켜지 않는다. 대신 아래 `stopped` 검사가 작업·AI·실전을 계속 막는다.
- 텔레그램 문구에는 금액을 넣지 않는다("월 예산 경고/한도 도달"). 화면 API는 소유자에게만 금액을 보여 준다.

## `stopped`가 막는 것

| 대상                                                                    | 동작                                                                                                                                                                                                                | 플래그를 읽지 못할 때                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 작업 시작: 스냅샷, 아침 캘린더, 모의 운용, 권한 확인, 캘린더 보강(수동) | 로그 `job-skipped`(`code: BUDGET_STOPPED`) 후 종료 코드 0. 실행 기록은 남기지 않아 다음 실행이 다시 일한다                                                                                                          | **실행한다**(fail open)                                                                     |
| 실전 작업 `investing-algo-live`                                         | **먼저 미체결 주문을 정리한다**(체결 기록, 오래된 잠금 해제, 체결 알림). 그 뒤 새 판단·주문 없이 끝낸다(`job-skipped`/`BUDGET_STOPPED`, 종료 코드 0, 실행 기록 없음). 긴급 정지도 켜져 있어 주문 직전 검사도 막는다 | **주문은 막고 정리는 한다**(fail closed). 종료 코드 1, `BUDGET_UNKNOWN`, `job-failure` 알림 |
| AI 호출: 추천 해설, 아침 AI, 캘린더 보강 AI, 알고리즘 AI                | 쿼터를 쓰기 전에 `unavailable`, 코드 `BUDGET_STOPPED`. 해설은 캐시도 쓰지 않는다. **제공자도 호출 직전에 한 번 더 확인한다**(`AI_BUDGET_STOPPED`)                                                                   | **막는다**(fail closed). 운영에서 가드를 설치하지 않은 프로세스도 막는다                    |

fail open/closed 이유: 스냅샷·아침·모의 작업은 싸고, 못 받은 날의 데이터는 나중에 되돌릴 수 없다. AI는 비용이 크고 실전 주문은 돈이 걸리므로 모르면 멈춘다.

플래그는 인스턴스마다 최대 60초 캐시한다(`BudgetGuard`). 같은 인스턴스에서 웹훅·해제가 일어나면 캐시를 바로 버린다. 다른 인스턴스·작업은 최대 1분 늦게 반영한다.

## Anthropic 지출은 GCP 예산 밖이다

AI 기본 경로는 Anthropic API 직접 호출이다(2026-10-21, [ai-provider.md](../implementation/ai-provider.md#제공자-계약-claude-sonnet-55-기본은-anthropic-api)). Anthropic 요금은 GCP 청구에 포함되지 않으므로 **Cloud Billing 예산(3만 원)과 그 알림은 이 지출을 보지 못한다.** 그래서 브레이크가 둘로 나뉜다.

| 장치                               | 무엇을 막나                                                                                                                                                                       | 한계                                                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Anthropic Console 월 지출 한도** | Anthropic이 한도에 닿으면 호출을 거절한다. **Anthropic 지출의 유일한 하드 상한**이다. 사용자가 Console에서 직접 설정한다([provider-setup.md](provider-setup.md#anthropic-api-키)) | 앱이 아니라 Anthropic 쪽 설정이라 코드가 확인하지 못한다. 설정을 잊으면 상한이 없다. 한도에 닿으면 앱에는 `AI_UNAVAILABLE`로 보일 수 있다 |
| **앱의 월 예산 중지(`stopped`)**   | GCP 예산이 3만 원에 닿아 `stopped`가 되면 이 문서의 표대로 AI 호출(Anthropic 포함)이 호출 앞에서 막힌다. 플래그를 읽지 못해도 막는다(fail closed)                                 | 기준은 **GCP 비용**이다. Anthropic 지출이 많아도 GCP 비용이 3만 원 아래이면 발동하지 않는다. GCP 알림 지연(몇 시간)도 그대로다            |
| 기능별 일일 호출 한도(Firestore)   | 해설 25, 아침 4, 캘린더 20, 알고리즘 12회/일. 호출 수의 상한이라 Anthropic 지출의 상한을 간접적으로 둔다                                                                          | 토큰·금액의 하드캡이 아니다                                                                                                               |

앱의 중지가 Anthropic 호출을 막는지는 `tests/anthropic-provider.test.ts`가 확인한다(중지·읽지 못함·가드 미설치 운영 상태에서 SDK도 네트워크도 부르지 않는다). 거절 폴백이 켜져 있으면(기본) 폴백 모델이 답한 호출은 그 모델의 요금으로 청구된다. 켜고 끄는 방법과 영향은 [ai-provider.md](../implementation/ai-provider.md#anthropic-api-경로-ai_provideranthropic)에 있다.

## 소유자 화면과 수동 해제

- 소유자가 로그인하면 상단에 배너가 나온다: "월 예산 한도(3만 원)에 도달해 예약 작업·AI·실전 주문을 멈췄습니다". 경고 상태에서는 노란 안내만 나온다. 다른 계정에는 아무것도 나오지 않는다.
- **월 예산 정지 해제** 버튼 → 확인 창 → `POST /api/ops/budget/release`. 이번 기간 안에는 다시 자동으로 멈추지 않는다(다음 기간에는 다시 감시한다). 긴급 정지는 그대로이며 알고리즘 화면에서 따로 해제한다. 해제하면 텔레그램 `setting-risk-increase`/`budget-stop-released` 알림과 변경 이력(`budget-stop-released`)이 남는다.
- `GET /api/ops/budget`는 소유자 전용이다(상태, 금액, 긴급 정지 여부, 웹훅 설정 여부, `lastMessageAt`). 배너 아래 한 줄이 항상 "마지막 예산 알림 수신" 시각을 보여 준다. 이 시각이 하루 넘게 오래되었거나 "아직 없음"이면 푸시 파이프라인(구독, 토큰, 환경변수)이 죽은 것이다. 예산 알림은 보통 하루에도 여러 번 온다고 알려져 있으나 실제 빈도는 확인하지 못했다.
- 해제는 감사 기록을 먼저 남긴다: 변경 이력(`budget-stop-released`)을 쓰지 못하면 해제하지 않고 503이다. 같은 쓰기에서 `releasedBy`(소유자 id)가 `opsControl/budget`에 저장된다.
- 화면을 쓸 수 없으면 Firestore 문서 `opsControl/budget`의 `stopped`를 `false`로 바꾼다(소유자 개인 계정, 서버 전용 컬렉션).

## 웹훅 보안

`POST /api/internal/budget-alert`는 세션이 없는 경로라 `app.ts`에서 동일 출처 검사와 세션 검사 **앞**에 설치한다. 이 경로만 그렇다. 다른 `/api` 경로는 그대로 세션과 `Origin`이 필요하다(`tests/budget-guard.test.ts`).

1. 환경변수 `BUDGET_PUSH_AUDIENCE`와 `BUDGET_PUSH_SERVICE_ACCOUNT` 중 하나라도 없거나 형식이 틀리면 404(기능 꺼짐).
2. 엄격한 속도 제한(분당 20회, **거부된 요청만 센다**). 정상 푸시는 세지 않는다.
3. `Authorization: Bearer <JWT>` 검사: `google-auth-library`의 `OAuth2Client.verifyIdToken({ idToken, audience })`로 서명·만료·audience를 확인한 뒤, 발급자가 `accounts.google.com` 또는 `https://accounts.google.com`, `aud`가 설정값, `email`이 `BUDGET_PUSH_SERVICE_ACCOUNT`와 정확히 같고 `email_verified`가 true인지 확인한다. 하나라도 틀리면 이유를 알리지 않는 같은 401.
4. 인증 뒤에야 본문(16KB 제한)을 읽는다. Pub/Sub 봉투(`message.data` base64 JSON)와 예산 알림 필드(`budgetDisplayName`, `costAmount`, `budgetAmount`, `costIntervalStart`, `currencyCode`, 선택 `alertThresholdExceeded`)를 엄격히 검사한다. `budgetDisplayName`은 `BUDGET_DISPLAY_NAME`(기본 `ai-investing-monthly`, Terraform 예산 이름)과 같아야 한다. 다른 예산의 메시지가 이 주제로 와도 멈추거나 재개하지 못한다. 청구 기간 시작이 하루보다 먼 미래이면 형식 오류다. 형식 오류 400. 올바르지만 할 일이 없는 메시지는 204(Pub/Sub이 무한 재시도하지 않게).

`BUDGET_PUSH_AUDIENCE`는 배포 워크플로가 `APP_ORIGIN`으로, `BUDGET_PUSH_SERVICE_ACCOUNT`는 `investing-budget-push@<프로젝트>.iam.gserviceaccount.com`으로 서비스에만 설정한다(작업에는 없다). 둘 중 하나만 있거나 형식이 틀리면 웹훅은 꺼진 채(404)지만, 서버가 시작할 때 값 없이 `budget-push-config-invalid` 경고를 한 줄 남긴다.

## 적용 순서

1. 코드를 main에 병합해 배포한다(서비스가 두 환경변수를 받는다. 구독이 없으니 아직 아무 푸시도 오지 않는다).
2. 개인 `terraform.tfvars`에 `service_url = "<APP_ORIGIN과 같은 값>"`을 넣는다(저장소에는 값이 없다). `billing_account`, `monthly_budget_amount = 30000`, `budget_warning_amount = 20000`, `budget_currency = "KRW"`도 있어야 한다.
3. `node scripts/gcp.mjs plan`. 예상 변경: `google_project_service.api["pubsub.googleapis.com"]`, `google_pubsub_topic.budget_alerts`, `google_service_account.budget_push`, `google_project_service_identity.pubsub`(Pub/Sub 서비스 에이전트를 먼저 만든다), `google_service_account_iam_member.pubsub_token_creator`, `google_pubsub_subscription.budget_push[0]`, `google_billing_budget.app[0]`을 **제자리 수정**(`all_updates_rule` 추가). 다른 리소스가 바뀌면 멈추고 원인을 본다. `google_project_service_identity`는 provider 문서상 베타라서 `google-beta` provider(`~> 6.0`, 잠금 파일에 추가됨)가 새로 필요하다. `node scripts/gcp.mjs init`이 받아 온다.
4. 검토 후 apply.

`push_endpoint`는 `service_url` 뒤에 `/api/internal/budget-alert`를 붙인 주소다. `APP_ORIGIN`이 사용자 도메인이면 그 도메인으로 Cloud Run이 응답해야 한다.

## 합성 메시지로 시험하기

실제 비용을 올리지 않고 푸시 경로(OIDC 검증 포함)를 확인한다. **현재 청구 기간보다 미래인 `costIntervalStart`를 쓰지 않는다.** 미래 값이 상태에 저장되면 이후 진짜 알림이 "이전 기간"으로 무시된다. 아래처럼 이번 달 1일 00:00Z(항상 실제 기간 시작 이전)를 쓴다.

1. 인증 없는 호출은 401이어야 한다(꺼져 있으면 404): `curl -i -X POST "$APP_ORIGIN/api/internal/budget-alert"`.
2. 경고 아래의 합성 메시지(상태만 저장):

```
gcloud pubsub topics publish investing-budget-alerts --account=<지정 계정> --project=<프로젝트> \
  --message='{"budgetDisplayName":"ai-investing-monthly","costAmount":1000,"costIntervalStart":"2026-10-01T00:00:00Z","budgetAmount":30000,"budgetAmountType":"SPECIFIED_AMOUNT","currencyCode":"KRW"}'
```

3. Cloud Run 요청 로그에서 `POST /api/internal/budget-alert`가 204인지, Firestore `opsControl/budget`에 `costAmount: 1000`이 생겼는지 본다.
4. 경고 경로까지 보려면 `costAmount`를 21000으로 보낸다(텔레그램 경고 한 통, 같은 기간에 한 번뿐). **`costAmount`를 30000 이상으로 보내면 실제로 중지한다.** 긴급 정지가 켜지고 `stopped`가 true가 되므로, 시험이면 화면에서 두 가지를 모두 해제한다.
5. 시험이 끝나면 합성 상태가 다음 진짜 기간 알림으로 덮이므로 따로 지울 필요는 없다. 지우려면 `opsControl/budget` 문서를 삭제한다.

## 확인하지 못한 것 (2026-10-21)

- 실제 Pub/Sub 푸시 전달과 실제 예산 알림은 받아 보지 않았다. 아래는 문서로 확인했을 뿐이다. 테스트는 검증기를 주입한 합성 메시지만 쓴다.
- 예산 알림의 `costIntervalStart` 시각 기준(태평양 시간 월 경계로 알려져 있다)과 알림 빈도는 실제 메시지로 확인하지 못했다. 앱은 값을 불투명한 시각으로만 비교한다.
- `google_project_service_identity`(베타 provider)가 이 프로젝트에서 실제로 적용되는지는 확인하지 못했다. 실패하면 `gcloud beta services identity create --service=pubsub.googleapis.com`로 만든 뒤 다시 apply한다.
- 예산이 주제에 게시하는 데 별도 IAM이 필요 없다고 알고 있으나 실제로 확인하지 못했다. 메시지가 오지 않으면 주제의 게시 권한을 먼저 본다.
- 서비스 인스턴스는 `--vpc-egress=all-traffic`이라 Google 인증서 조회가 NAT를 지난다. 첫 푸시에서 401이 계속되면 인증서 조회 실패(로그에는 이유를 남기지 않는다)를 의심한다.
