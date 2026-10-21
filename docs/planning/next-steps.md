# 다음 할 일과 인수인계

기준: 2026-10-21 KST. 이 문서는 "지금 어디까지 왔고, 다음에 무엇을 하며, 이어받는 사람이 먼저 무엇을 확인해야 하는지"의 SOT다. [AGENTS.md](../../AGENTS.md) 규칙에 따라 작업을 마칠 때마다 같은 변경 안에서 갱신한다. 기능별 세부 상태는 [상태 SOT](../implementation/status.md), 단계별 계획은 [구현 계획](next-phase-plan.md)을 본다.

## 현재 상태

- 다음 단계(실데이터 전환·종목 분석·알고리즘 자동 매매)의 코드는 모두 main에 병합·배포됐다(#17–#33).
- 운영 작업:

| 작업                           | 스케줄                                 | 마지막 확인                                                                           |
| ------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------- |
| `investing-daily-snapshot`     | 켜짐(KR 16:30·18:30, US 06:30·07:30)   | 2026-10-21 수동 실행: KR 지수·국채·뉴스 40건 저장                                     |
| `investing-morning-calendar`   | 켜짐(07:00)                            | 2026-10-21 수동 실행: 뉴스 120건, 브리핑 저장. FRED 키 없음, AI 꺼짐, 텔레그램 미설정 |
| `investing-algo-paper`         | 켜짐(KR 09:05, US 22:35·23:35)         | 2026-10-21 시작 확인(장 시간 밖이라 건너뜀). 모의 알고리즘은 아직 없음                |
| `investing-algo-live`          | **꺼짐**, `LIVE_TRADING_ENABLED=false` | 배포만 됨. **실제 주문은 한 번도 내지 않았다**                                        |
| `investing-order-access-check` | 없음(수동)                             | 2026-10-21 all-ok(매수 가능 금액 KRW·USD, 수수료, 미체결 목록 조회)                   |

## 다음 할 일

### 사용자 (먼저 필요)

1. 소유자 계정으로 로그인해 실제 지수·보유·종목 분석 탭이 보이는지 확인한다. 이상하면 화면을 알려 준다.
2. 키 입력: 아래 명령에 값이 생긴 항목만 넣는다(숨김 입력, 채팅에 붙이지 않는다). 발급 방법은 [provider-setup.md](../operations/provider-setup.md).
   - `python scripts/provider-secrets.py dart fred ecos telegram sec --attach`
3. (2026-10-21 결정) AI 기본 모델은 Claude Sonnet 5.5(월 약 1만 8천 원 예상). 프로젝트의 Vertex `anthropic-claude-sonnet` global 할당량이 0이라 **할당량 증가 요청·승인이 필요하다.** 예산은 월 3만 원으로 하고, 2만 원에 경고, 3만 원에 앱 기능 자동 중지(예약 작업·AI·실전 주문 중지, 사이트·데이터 유지)를 둔다.
4. 실전을 원할 때: 토스 WTS 설정 > Open API에서 주문 관련 설정 확인 → 알고리즘 하나를 소액으로 실전 켜기 → 에이전트에게 실전 일정 켜기를 요청한다.

### 에이전트 (사용자 입력이 있으면 바로 할 수 있는 순서)

| 우선 | 할 일                                                                                                                                                                                | 막힌 점          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 1    | 스냅샷 이틀 연속 자동 실행 확인: `snapshotRuns/KR_2026-10-21`(16:30), `US_2026-10-21`(10-22 06:30) 상태와 작업 로그                                                                  | 없음             |
| 2    | 아침 작업 07:00 자동 실행 확인(`morningRuns/{날짜}`)                                                                                                                                 | 없음             |
| 3    | 키 입력 후 실호출 확인: DART·SEC(종목 분석 재무 탭), FRED `verifyCatalog()`·ECOS(차트 비교, 아침 작업), SEC companyfacts 응답 모양, 텔레그램 실발송(`MORNING_FORCE=1` 수동 실행)     | 키 입력          |
| 4    | 모의 알고리즘이 생기면 개장 직후 실행 기록(`algorithmRuns`, `paperTrades`) 확인                                                                                                      | 모의 알고리즘    |
| 5    | AI 승인 시: `morning_ai_enabled = true`(tfvars, plan·apply), deploy.yml의 `MORNING_AI_ENABLED`·`ALGO_AI_ENABLED`를 바꾸는 PR, 저장소 변수 `AI_MODEL=gemini-3.8-flash` 확인, 수동 1회 | AI 비용 승인     |
| 6    | 실전 요청 시: [jobs.md 실전 순서](../operations/jobs.md)대로 저장소 변수 `LIVE_TRADING_ENABLED=true`, `live_schedules_enabled = true`, 첫 주문을 로그·화면·텔레그램·토스 앱으로 관찰 | 사용자 실전 켜기 |
| 7    | 단계 8 도메인: 연결 방식·비용 비교 후 사용자와 결정                                                                                                                                  | 사용자 결정      |

남은 개선(급하지 않음): 종목 이름 검색(`/stocks/all`), 캔들 차트 보기, 업종 비교의 서버 일괄 계산, 지표 매개변수 편집, `toss.ts`와 `toss-analysis.ts`의 수급 정규화 중복 통합, `liveOrders`·`blockedOrders` 보존 기간, 뉴스 점수 규칙(현재 신호에서 제외), KRX 호가 단위표(현재는 400 응답의 안내로 한 번 보정).

## 이어서 작업하기 전에 확인할 것

1. 환경: [다른 컴퓨터에서 이어서 작업하기](next-phase-design.md#다른-컴퓨터에서-이어서-작업하기)대로 `.local/deployment.json`, `.local/deployment-account.md`, `.local/owner-access.json`, `.local/gcs-backend.hcl`, `infra/gcp/terraform.tfvars`를 안전한 경로로 옮긴다. Terraform state는 GCS에 있으므로 옮기지 않는다.
2. **`terraform.tfvars`의 스케줄 변수**는 gitignore 대상이라 저장소에 없다. 지금 운영 값은 `snapshot_schedules_enabled = true`, `morning_schedule_enabled = true`, `algo_schedules_enabled = true`, `live_schedules_enabled = false`(기본값), `morning_ai_enabled = false`(기본값), `monthly_budget_amount = 30000`, `budget_warning_amount = 20000`, `budget_currency = "KRW"`다. 이 값이 빠진 컴퓨터에서 `apply`하면 켜 둔 스케줄이 다시 멈춘다. `node scripts/gcp.mjs plan` 결과가 "No changes"인지 먼저 본다.
3. 검사: `git pull`, `npm ci`, `npm run check`, `E2E_PORT=<빈 포트> npm run test:e2e`가 통과하는지 확인한다. 여러 worktree를 동시에 돌릴 때는 포트를 나눈다.
4. 클라우드: `gcloud auth login <지정 개인 계정>` 후 `node scripts/gcp.mjs doctor`·`init`·`plan`. 토큰이 만료되면 `invalid_grant`가 난다.
5. 운영 확인 명령: 작업 실행은 `gcloud run jobs execute <작업> --region=asia-northeast3 --wait`(계정·프로젝트 명시), 로그는 `gcloud logging read`로 실행 이름별로 읽는다. 로그에는 허용한 키만 있고 토큰·계좌 값은 없다.
6. 함정:
   - Windows Git Bash의 `date`는 `Asia/Seoul`을 모르고 UTC를 KST처럼 보여 준다. KST는 `node -e` + `Intl.DateTimeFormat`으로 확인한다.
   - 에이전트 worktree는 `main`에서 시작한다. 시작할 브랜치를 지시하고, 공유 git 설정을 바꾸지 않게 한다.
   - main 보호 규칙상 PR은 최신 main 위에 있어야 병합된다. squash 병합 뒤 남은 브랜치는 `git rebase --onto origin/main <이전 기준>`으로 옮긴다.
   - 운영 이미지는 `src/server`·`src/jobs`·`src/lib`만 담는다. 서버가 다른 폴더를 import하면 Dockerfile을 함께 고친다.
7. 사용자만 열 수 있는 관문(키, AI 비용, 실전 주문)은 사용자 지시 없이 열지 않는다.
