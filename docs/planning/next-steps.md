# 다음 할 일과 인수인계

기준: 2026-10-21 KST. 이 문서는 "지금 어디까지 왔고, 다음에 무엇을 하며, 이어받는 사람이 먼저 무엇을 확인해야 하는지"의 SOT다. [AGENTS.md](../../AGENTS.md) 규칙에 따라 작업을 마칠 때마다 같은 변경 안에서 갱신한다. 기능별 세부 상태는 [상태 SOT](../implementation/status.md), 단계별 계획은 [구현 계획](next-phase-plan.md)을 본다.

## 현재 상태

- 다음 단계(실데이터 전환·종목 분석·알고리즘 자동 매매)의 코드는 모두 main에 병합·배포됐다(#17–#33).
- 월 예산 자동 중지(Pub/Sub 푸시 → `/api/internal/budget-alert`, 예산 100%에 예약 작업·AI·실전 주문 중지와 긴급 정지, 소유자 화면 배너·해제)의 **코드와 Terraform은 완료, 적용 전**이다. 순서와 한계는 [budget.md](../operations/budget.md).
- 운영 작업:

| 작업                           | 스케줄                                 | 마지막 확인                                                                                                                                                                     |
| ------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `investing-daily-snapshot`     | 켜짐(KR 16:30·18:30, US 06:30·07:30)   | 2026-10-21 수동 실행: KR 지수·국채·뉴스 40건 저장                                                                                                                               |
| `investing-morning-calendar`   | 켜짐(07:00)                            | 2026-10-21 수동 실행: 뉴스 120건, 브리핑 저장. FRED 키 없음, 텔레그램 미설정. **코드는 AI 켜짐(Claude Sonnet 5.5)·새 이벤트 보강 단계 추가(미배포, 병합 후 첫 실행 확인 필요)** |
| `investing-calendar-enrich`    | 없음(수동)                             | **미배포(이 변경 병합 후 deploy.yml이 만든다)**. 첫 실행은 백필(우선 4b)                                                                                                        |
| `investing-algo-paper`         | 켜짐(KR 09:05, US 22:35·23:35)         | 2026-10-21 시작 확인(장 시간 밖이라 건너뜀). 모의 알고리즘은 아직 없음                                                                                                          |
| `investing-algo-live`          | **꺼짐**, `LIVE_TRADING_ENABLED=false` | 배포만 됨. **실제 주문은 한 번도 내지 않았다**                                                                                                                                  |
| `investing-order-access-check` | 없음(수동)                             | 2026-10-21 all-ok(매수 가능 금액 KRW·USD, 수수료, 미체결 목록 조회)                                                                                                             |

## 다음 할 일

### 사용자 (먼저 필요)

1. 소유자 계정으로 로그인해 실제 지수·보유·종목 분석 탭이 보이는지 확인한다. 이상하면 화면을 알려 준다.
2. 키 입력: 아래 명령에 값이 생긴 항목만 넣는다(숨김 입력, 채팅에 붙이지 않는다). 발급 방법은 [provider-setup.md](../operations/provider-setup.md).
   - `python scripts/provider-secrets.py dart fred ecos telegram sec --attach`
3. **완료(2026-10-21)**: AI 기본 모델을 Claude Sonnet 5.5(Vertex AI, `global`)로 정하고 월 약 1만 8천 원을 승인했다([설계 5절](next-phase-design.md#5-ai-모델-사용자-결정)). 예산은 월 3만 원으로 하고, 2만 원에 경고, 3만 원에 앱 기능 자동 중지(예약 작업·AI·실전 주문 중지, 사이트·데이터 유지)를 둔다. **Vertex의 `anthropic-claude-sonnet` `global` 할당량이 0이라 2026-10-21 증가를 요청했다**(분당 요청 10, 입력 10만, 출력 2만 토큰; Cloud Quotas `quotaPreferences/claude-sonnet-*`). 승인 전까지 AI 호출은 `AI_QUOTA_PROVIDER`로 기록되고 실행은 깨지지 않는다.
4. 실전을 원할 때: 토스 WTS 설정 > Open API에서 주문 관련 설정 확인 → 알고리즘 하나를 소액으로 실전 켜기 → 에이전트에게 실전 일정 켜기를 요청한다.

### 에이전트 (사용자 입력이 있으면 바로 할 수 있는 순서)

| 우선 | 할 일                                                                                                                                                                                                                                                                                                                                                       | 막힌 점                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 0    | 월 예산 자동 중지 적용: 배포 후 tfvars에 `service_url`(= `APP_ORIGIN`) 추가 → `init`(새 `google-beta` provider)·`plan`(예상: pubsub API, 주제, `investing-budget-push` 계정, Pub/Sub 서비스 에이전트 `google_project_service_identity`, token creator, 구독, 예산 제자리 수정) → apply → [합성 메시지 시험](../operations/budget.md#합성-메시지로-시험하기) | 없음                      |
| 1    | 스냅샷 이틀 연속 자동 실행 확인: `snapshotRuns/KR_2026-10-21`(16:30), `US_2026-10-21`(10-22 06:30) 상태와 작업 로그                                                                                                                                                                                                                                         | 없음                      |
| 2    | 아침 작업 07:00 자동 실행 확인(`morningRuns/{날짜}`)                                                                                                                                                                                                                                                                                                        | 없음                      |
| 3    | 키 입력 후 실호출 확인: DART·SEC(종목 분석 재무 탭), FRED `verifyCatalog()`·ECOS(차트 비교, 아침 작업), SEC companyfacts 응답 모양, 텔레그램 실발송(`MORNING_FORCE=1` 수동 실행)                                                                                                                                                                            | 키 입력                   |
| 4    | 모의 알고리즘이 생기면 개장 직후 실행 기록(`algorithmRuns`, `paperTrades`) 확인                                                                                                                                                                                                                                                                             | 모의 알고리즘             |
| 4a   | **Claude/캘린더 보강 켜기**([jobs.md](../operations/jobs.md#ai-켜기-claude-sonnet-55)): 저장소 변수 `AI_PROVIDER`·`AI_MODEL`(예전 `vertex`·`gemini-3.8-flash`) 삭제·갱신, tfvars `morning_ai_enabled = true`(plan: `jobs_ai` 1개만 추가), Model Garden 사용 설정, 할당량 증가                                                                               | Vertex Claude 할당량 승인 |
| 4b   | **캘린더 백필**: 배포 후 `gcloud run jobs execute investing-calendar-enrich … --wait`(운영 121건, AI 약 13회). 토스 실호출 가정 확인: SPY 심볼·일봉 `date`가 현지 거래일인지, `/exchange-rate?dateTime=`가 과거 시각에 응답하는지, 국채 일봉 `close`가 수익률(%)인지. `calendarEnrichRuns`의 코드 확인                                                      | 4a(AI), 토스 연결(반응)   |
| 5    | AI형 알고리즘은 **사용자가 따로 요청할 때만** 켠다: deploy.yml의 `ALGO_AI_ENABLED`를 `true`로 바꾸는 PR(모델은 `AI_PROVIDER`·`AI_MODEL`, 판단 호출 effort `medium`)과 수동 1회. 아침·해설·캘린더 보강 AI는 4a를 따른다                                                                                                                                      | 사용자 요청               |
| 6    | 실전 요청 시: [jobs.md 실전 순서](../operations/jobs.md)대로 저장소 변수 `LIVE_TRADING_ENABLED=true`, `live_schedules_enabled = true`, 첫 주문을 로그·화면·텔레그램·토스 앱으로 관찰                                                                                                                                                                        | 사용자 실전 켜기          |
| 7    | 단계 8 도메인: 연결 방식·비용 비교 후 사용자와 결정                                                                                                                                                                                                                                                                                                         | 사용자 결정               |

남은 개선(급하지 않음): 종목 이름 검색(`/stocks/all`), 캔들 차트 보기, 업종 비교의 서버 일괄 계산, 지표 매개변수 편집, `toss.ts`와 `toss-analysis.ts`의 수급 정규화 중복 통합, `liveOrders`·`blockedOrders` 보존 기간, 뉴스 점수 규칙(현재 신호에서 제외), KRX 호가 단위표(현재는 400 응답의 안내로 한 번 보정).

## 이어서 작업하기 전에 확인할 것

1. 환경: [다른 컴퓨터에서 이어서 작업하기](next-phase-design.md#다른-컴퓨터에서-이어서-작업하기)대로 `.local/deployment.json`, `.local/deployment-account.md`, `.local/owner-access.json`, `.local/gcs-backend.hcl`, `infra/gcp/terraform.tfvars`를 안전한 경로로 옮긴다. Terraform state는 GCS에 있으므로 옮기지 않는다.
2. **`terraform.tfvars`의 스케줄 변수**는 gitignore 대상이라 저장소에 없다. 지금 운영 값은 `snapshot_schedules_enabled = true`, `morning_schedule_enabled = true`, `algo_schedules_enabled = true`, `live_schedules_enabled = false`(기본값), `morning_ai_enabled = true`(아침 작업이 Sonnet을 쓰려면 필요), `monthly_budget_amount = 30000`, `budget_warning_amount = 20000`, `budget_currency = "KRW"`, `service_url = <APP_ORIGIN과 같은 값>`(예산 자동 중지)다. 이 값이 빠진 컴퓨터에서 `apply`하면 켜 둔 스케줄이 다시 멈춘다. `node scripts/gcp.mjs plan` 결과가 "No changes"인지 먼저 본다.
3. 검사: `git pull`, `npm ci`, `npm run check`, `E2E_PORT=<빈 포트> npm run test:e2e`가 통과하는지 확인한다. 여러 worktree를 동시에 돌릴 때는 포트를 나눈다.
4. 클라우드: `gcloud auth login <지정 개인 계정>` 후 `node scripts/gcp.mjs doctor`·`init`·`plan`. 토큰이 만료되면 `invalid_grant`가 난다.
5. 운영 확인 명령: 작업 실행은 `gcloud run jobs execute <작업> --region=asia-northeast3 --wait`(계정·프로젝트 명시), 로그는 `gcloud logging read`로 실행 이름별로 읽는다. 로그에는 허용한 키만 있고 토큰·계좌 값은 없다.
6. 함정:
   - Windows Git Bash의 `date`는 `Asia/Seoul`을 모르고 UTC를 KST처럼 보여 준다. KST는 `node -e` + `Intl.DateTimeFormat`으로 확인한다.
   - 에이전트 worktree는 `main`에서 시작한다. 시작할 브랜치를 지시하고, 공유 git 설정을 바꾸지 않게 한다.
   - main 보호 규칙상 PR은 최신 main 위에 있어야 병합된다. squash 병합 뒤 남은 브랜치는 `git rebase --onto origin/main <이전 기준>`으로 옮긴다.
   - 운영 이미지는 `src/server`·`src/jobs`·`src/lib`만 담는다. 서버가 다른 폴더를 import하면 Dockerfile을 함께 고친다.
   - AI 제공자는 `AI_PROVIDER`(`vertex-claude` 기본 | `vertex`=Gemini)로 고른다. 저장소 변수에 예전 `vertex`+`gemini-3.8-flash`가 남아 있으면 그 값이 이긴다. Claude 호출이 429(`AI_QUOTA_PROVIDER`)면 코드 문제가 아니라 Vertex 할당량 0이다. 작업은 죽지 않고 해당 AI 단계만 실패 코드를 남긴다. 클라이언트(`@anthropic-ai/vertex-sdk`)는 첫 호출 때 만들어진다(ADC를 찾기 때문). Claude Sonnet 5.5는 `temperature` 등 기본이 아닌 샘플링 값과 `thinking: {type:'disabled'}`를 400으로 거부하니 보내지 않는다.
   - 캘린더 보강은 토스 호출이 필요하다(고정 IP). 로컬에서 실행할 수 없고 Cloud Run Job으로만 돈다(`investing-calendar-enrich`, 수동). 반응이 아직 확정되지 않은 최근 이벤트는 AI를 미루고 다음 아침 작업이 채운다.
7. 사용자만 열 수 있는 관문(키, AI 비용, 실전 주문)은 사용자 지시 없이 열지 않는다.
8. **`service_url`**(tfvars, 저장소에 없음)은 `APP_ORIGIN`과 같은 https 주소다. 빠지면 Pub/Sub 구독과 예산의 Pub/Sub 규칙이 plan에서 사라진다(예산 이메일 알림은 그대로). 월 예산 중지 때문에 작업이 건너뛰어졌다면 로그의 `job-skipped`(`BUDGET_STOPPED`)와 `opsControl/budget`을 본다.
