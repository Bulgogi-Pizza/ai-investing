# 예약 작업 (Cloud Scheduler → Cloud Run Job)

4단계에서 만든 예약 작업 기반이다. 6b(아침 캘린더 갱신, [아래](#아침-캘린더-작업-6b))가 같은 틀을 썼고 7c(시장별 알고리즘 판단)가 다시 쓴다. 첫 작업은 일일 스냅샷(`investing-daily-snapshot`)이며 데이터 구조와 동작은 [일일 스냅샷](../implementation/snapshots.md)에 있다. 상태: **구현·검증 완료(합성 테스트와 `terraform validate`), 운영 적용 전**. 실제 클라우드 적용과 실호출 확인은 아래 순서로 감독이 한다.

월 예산 한도(3만 원)에 닿아 `opsControl/budget`의 `stopped`가 켜지면 작업은 시작 때(`src/jobs/budget-gate.ts`) `job-skipped`(`BUDGET_STOPPED`)를 남기고 종료 코드 0으로 끝난다. 실전 작업은 예외로, 먼저 미체결 주문을 정리(체결 기록·잠금 해제·체결 알림)한 뒤 새 판단·주문 없이 끝낸다. 플래그를 읽지 못하면 실전 작업만 주문 없이 실패(종료 코드 1, `job-failure` 알림)한다. 자세한 동작은 [월 예산 자동 중지](budget.md).

## 구성

```
Cloud Scheduler(시간만 알림) ──POST jobs:run──▶ Cloud Run Job investing-daily-snapshot
   investing-scheduler SA (job 단위 run.invoker)       investing-jobs SA, 같은 이미지 digest
                                                        고정 출구 IP(VPC all-traffic) → 토스 Open API
                                                        Firestore: marketSnapshots, snapshotRuns
```

- 스케줄러는 시각만 알린다. **어느 시장을 돌릴지는 작업이 토스 장 운영 캘린더로 정한다.** 휴장일, 서머타임, 단축 거래일이 모두 캘린더 데이터라서 스케줄러 설정에 시각을 박지 않는다. 같은 시각표가 모든 시장에 쓰이고, 이미 끝난 날은 건너뛴다(같은 문서 ID, 완료 기록).
- Cloud Run Job 정의는 Terraform이 아니라 배포 워크플로(`.github/workflows/deploy.yml`)가 서비스와 **같은 검증된 이미지 digest**로 만들고 갱신한다(서비스처럼 이미지 드리프트를 만들지 않으려는 저장소 관례). Terraform은 서비스 계정, 비밀 접근, Scheduler 트리거를 만든다.
- 이미지는 서비스와 같다. 진입점만 다르다: `node --import tsx src/jobs/daily-snapshot.ts`. `Dockerfile`이 `src/jobs`를 이미지에 넣고, CI `container` 작업이 파일 존재를 검사한다.

## 작업 프레임워크 (`src/jobs/`)

| 파일                  | 역할                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `runner.ts`           | `runJob`: 종료 코드, 정제된 로그(`createJobLogger`), 오류 코드 변환(`safeErrorCode`)                           |
| `market-session.ts`   | 토스 장 운영 캘린더 기반 거래일·정규장 시간·"마감/개장 후 N분 이내" 판단. 6b·7c가 재사용                       |
| `snapshot-targets.ts` | 적재 대상 종목 제공자 인터페이스(`SnapshotTargetProvider`)와 보유·목록 구현. 알고리즘 대상은 7a 이후 추가      |
| `daily-snapshot.ts`   | 일일 스냅샷 본체(`runDailySnapshot`)와 진입점(`main`). 의존성(토스, 저장소, 시계, sleep)을 주입받아 테스트한다 |

**종료 코드**: `0` 정상 종료(오늘 할 일 없음 포함), `1` 예기치 않은 실패 또는 하나도 저장하지 못함, `2` 설정 오류(재시도해도 소용없음), `3` 일부 단계 실패(실행 기록에 단계별 상태가 있음). `--max-retries=0`이라 비정상 종료 때 Cloud Run이 자동 재실행하지 않는다. 같은 날 두 번째 슬롯이 미완료 날을 다시 시도한다. 권한 없음(403)과 데이터 없음은 알려진 상태라 `0`이다.

**로그 규칙**: 한 줄에 JSON 한 개(`severity`, `message`, `job` + 허용 필드). 허용 필드는 `step`, `market`, `date`, `status`, `trigger`, `code`, `codes`와 숫자 개수뿐이고, 값은 토큰 모양(영숫자·`_:.-`, 64자 이하)이나 대문자 코드만 통과한다. 토큰, 계좌 식별값, 종목 코드, 제공자 응답 원문, 예외 메시지·스택은 어떤 경로로도 기록하지 않는다. 오류는 `safeErrorCode`가 코드로만 바꾼다(코드베이스가 직접 붙인 `PROVIDER_*` 코드 외에는 `JOB_FAILED`).

**새 작업 추가 방법**: `src/jobs/<name>.ts`에 본문 함수를 만들고 `main`에서 `runJob('<name>', ...)`을 호출한다. 설정 검사는 `daily-snapshot.ts`의 `jobConfiguration`처럼 production·`CLOUD_RUN_JOB`·명시적 프로젝트를 요구한다. Terraform에 서비스 계정(필요한 비밀만 `secretAccessor`)과 Scheduler 트리거를 추가하고, `deploy.yml`에 job 배포 단계를 추가한다.

## 일정

| Scheduler 작업                | 크론(Asia/Seoul)   | 의도                                                                                          |
| ----------------------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `investing-daily-snapshot-kr` | `30 16,18 * * 1-5` | KRX 15:30 마감 1시간·3시간 뒤. 18:30은 16:30이 불완전했을 때만 의미가 있다                    |
| `investing-daily-snapshot-us` | `30 6,7 * * 2-6`   | 미국 정규장 마감은 서머타임 05:00 KST, 그 외 06:00 KST(단축일은 03:00). 2회 슬롯이 둘 다 덮음 |

작업은 마감 후 20분이 지난 직전 세션만 고른다(KR 8시간, US 6시간 안). 화~토 06:30·07:30(KST)에 미국 직전 거래일이 선택된다. 일·월 새벽은 스케줄에 넣지 않는다(토요일 새벽이 금요일 세션이다). 재시도: Scheduler는 호출 실패(5xx)만 2회 재시도하고 작업 자체는 멱등이다.

기본은 **일시 정지** 상태로 만든다(`snapshot_schedules_enabled = false`). Cloud Run Job이 생기기 전에 트리거가 실패하는 것을 막기 위해서다.

## IAM (최소 권한)

| 주체                     | 권한                                                                                                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `investing-jobs` SA      | `datastore.user`(Firestore 읽기·쓰기), 토스 비밀 4개(`client-id`, `client-secret`, `account-seq`, `owner-user-id`)에 대해 **비밀 단위** `secretAccessor`; 아침 작업: FRED·ECOS·텔레그램 비밀 4개(`jobs-morning.tf`), AI를 켠 뒤에만 `roles/aiplatform.user` |
| `investing-scheduler` SA | 프로젝트 권한 없음. 배포 워크플로가 `investing-daily-snapshot`·`investing-morning-calendar` **job 각각**에만 `roles/run.invoker`를 부여한다                                                                                                                 |
| `investing-deploy` SA    | 기존 `run.admin`으로 job 생성·갱신, 새로 `investing-jobs`에 대한 `iam.serviceAccountUser`(job이 그 계정으로 돌게 함)                                                                                                                                        |

- 프로젝트 단위 `secretAccessor`는 주지 않는다. 스냅샷 작업에는 DART·FRED·ECOS·텔레그램 비밀이 필요 없다. 아침 작업(6b)의 FRED·ECOS·텔레그램 비밀 4개는 `jobs-morning.tf`가 같은 서비스 계정에 비밀 단위로 추가한다(같은 계정이므로 스냅샷 job에도 접근 권한이 생기지만 그 job은 연결하지 않으며, 계정 분리는 필요해지면 한다).
- Firestore는 컬렉션 단위 IAM이 없어 `datastore.user`가 모든 컬렉션(계정·세션 포함)을 읽고 쓸 수 있다. 서비스(`investing-runtime`)와 같은 수준이며, 작업 코드는 `marketSnapshots`·`snapshotRuns`·`snapshotTargets`·`economicEvents`·`providerTokens`(스냅샷)와 `morningRuns`·`economicEvents`·`notifications`·`aiUsage`(아침 작업)만 건드린다. 이 잔여 위험은 인지하고 있다.
- invoker 권한을 Terraform이 아니라 워크플로가 부여하는 이유: job이 Terraform 리소스가 아니라서 job 단위 IAM 바인딩을 Terraform에 쓸 수 없고, 프로젝트 단위 `run.invoker`는 일회성 `investing-toss-setup` 같은 다른 job까지 실행하게 해서 더 넓다.

## 배포

`deploy.yml`의 `Deploy daily snapshot job` 단계는 서비스 배포와 health 확인 뒤에, 서비스를 실제로 배포한 실행에서만 돈다(오래된 SHA 건너뛰기 규칙을 따른다).

- 같은 이미지 digest, `--service-account=investing-jobs@…`, `--command=node --args=--import,tsx,src/jobs/daily-snapshot.ts`, `--network=investing-network --subnet=investing-subnet --vpc-egress=all-traffic`(고정 출구 IP), `--max-retries=0 --tasks=1 --parallelism=1 --task-timeout=900s --cpu=1 --memory=512Mi`.
- 비밀은 **서비스가 지금 연결한 숫자 버전을 그대로** 읽어 `--set-secrets`로 붙인다(`gcloud run services describe … | jq`). Secret Manager를 읽지 않고 값은 워크플로에 오지 않는다. 서비스에 토스 비밀 네 개가 숫자 버전으로 연결되어 있지 않으면 경고만 남기고 job 배포를 건너뛴다(토스 연결 전에도 배포가 깨지지 않는다).
- 이어서 `investing-scheduler`에 job 단위 `run.invoker`를 부여한다(멱등).

## 감독이 적용하는 순서

1. `node scripts/gcp.mjs plan`. 기대 변경은 **추가만**이다: `cloudscheduler.googleapis.com` API, 서비스 계정 2개(`investing-jobs`, `investing-scheduler`), `datastore.user` 바인딩 1개, 토스 비밀 4개의 `secretAccessor`, `investing-deploy`의 `serviceAccountUser`, Scheduler 작업 2개(일시 정지). 기존 리소스 교체·삭제가 있으면 적용하지 않는다.
2. `node scripts/gcp.mjs apply`.
3. 이 PR을 `main`에 병합한다. CI를 통과한 SHA가 배포되며 `Deploy daily snapshot job` 단계가 job을 만든다. 이미 병합된 뒤라면 `Deploy GCP`를 다시 실행한다.
4. job 확인: `gcloud run jobs describe investing-daily-snapshot --region asia-northeast3`(계정·프로젝트 명시). 서비스 계정, VPC 설정, 비밀 버전을 눈으로 확인한다.
5. **수동 실행 한 번**(아래). 장 마감 뒤 거래일에 한다. 결과의 정제된 로그와 `GET /api/snapshots/status`를 확인한다. 토스 허용 IP는 서비스와 같은 고정 IP라 추가 등록이 필요 없다.
6. `terraform.tfvars`(gitignore 대상)에 `snapshot_schedules_enabled = true`를 넣고 `plan`(Scheduler 두 개의 `paused`만 바뀌어야 한다)·`apply`로 트리거를 켠다.
7. 이틀 연속 자동 실행과 데이터 적재를 확인한다(4단계 완료 기준).

## 수동 실행

로컬에서는 돌릴 수 없다(production, `CLOUD_RUN_JOB`, 명시적 프로젝트가 아니면 설정 오류 종료 `2`). Cloud Run Job을 한 번 실행하면서 환경 변수만 덮어쓴다. 모든 호출에 개인 계정·프로젝트를 명시한다([AGENTS.md](../../AGENTS.md)).

```sh
gcloud run jobs execute investing-daily-snapshot --region=asia-northeast3 \
  --account=<개인 계정> --project=<개인 프로젝트> \
  --update-env-vars=SNAPSHOT_MARKETS=KR,SNAPSHOT_FORCE=1 --wait
```

| 변수               | 값             | 효과                                                                        |
| ------------------ | -------------- | --------------------------------------------------------------------------- |
| `SNAPSHOT_MARKETS` | `KR` 또는 `US` | 한 시장만 돌린다(쉼표 구분 목록은 gcloud 구문과 충돌하므로 한 번에 한 시장) |
| `SNAPSHOT_DATE`    | `YYYY-MM-DD`   | 시장 현지 날짜의 세션을 지정(오래된 날짜도 가능, 캘린더에 있는 거래일만)    |
| `SNAPSHOT_FORCE`   | `1`            | 이미 `complete`인 날도 다시 돌린다(같은 문서 ID에 덮어쓰기)                 |

값이 없으면 스케줄러와 같은 자동 판단이다. 수동 실행 기록은 `trigger: manual`이다. 장이 안 닫혔으면 건너뛴다(`SESSION_NOT_CLOSED_YET`).

## 아침 캘린더 작업 (6b)

`investing-morning-calendar`: 매일 07:00 KST. 본문 `src/jobs/morning-calendar.ts`, 동작·데이터·화면은 [경제 캘린더 — 아침 갱신](../implementation/calendar.md#아침-갱신-6b), AI 계약은 [ai-provider.md](../implementation/ai-provider.md#아침-작업-계약-6b)에 있다. 상태: **구현·합성 테스트 완료, 운영 적용 전, AI 단계는 꺼짐**.

| 항목            | 내용                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduler       | `investing-morning-calendar`, 크론 `0 7 * * *`(Asia/Seoul), 호출 실패(5xx)만 2회 재시도. 기본 **일시 정지**(`morning_schedule_enabled = false`, 스냅샷 트리거와 따로 켠다)                        |
| 실행 계정       | 기존 `investing-jobs`(스냅샷과 같은 계정, 같은 이미지 digest, 같은 VPC·고정 출구 IP)                                                                                                              |
| 비밀(비밀 단위) | `investing-fred-api-key`, `investing-ecos-api-key`, `investing-telegram-bot-token`, `investing-telegram-chat-id`의 `secretAccessor`. 토스·DART·SEC 비밀은 이 작업에 없다                          |
| Vertex 권한     | `roles/aiplatform.user`는 Terraform 변수 `morning_ai_enabled = true`일 때만 `investing-jobs`에 부여한다(기본 `false`)                                                                             |
| 환경변수        | `NODE_ENV=production`, `GOOGLE_CLOUD_PROJECT`, `APP_ORIGIN`(알림의 화면 링크), `MORNING_AI_ENABLED=false`, `AI_PROVIDER`·`AI_MODEL`·`AI_LOCATION`(워크플로 변수가 있을 때만)                      |
| 종료 코드       | 스냅샷과 같다(`0` 정상, `1` 실패, `2` 설정 오류, `3` 일부 단계 실패). 키가 없거나 AI가 꺼진 것, AI 한도 소진, 아직 올라오지 않은 값은 실패가 아니라 단계 기록의 코드다                            |
| 실행 기록       | Firestore `morningRuns/{KST 날짜}`. 같은 날 `complete`면 다음 실행은 건너뛴다(`RUN_ALREADY_COMPLETE`). `partial`·`failed`인 날은 다음 실행이 다시 시도하고, 이미 보낸 브리핑은 다시 보내지 않는다 |
| 실패 알림       | 실행이 `failed`로 끝나면 텔레그램 `job-failure` 알림을 남긴다(전송 실패는 화면 알림 목록에 기록)                                                                                                  |

**수동 실행**(로컬에서는 불가, Cloud Run Job 한 번 실행에 환경변수만 덮어쓴다):

```sh
gcloud run jobs execute investing-morning-calendar --region=asia-northeast3 \
  --account=<개인 계정> --project=<개인 프로젝트> \
  --update-env-vars=MORNING_FORCE=1 --wait
```

| 변수            | 값           | 효과                                                       |
| --------------- | ------------ | ---------------------------------------------------------- |
| `MORNING_DATE`  | `YYYY-MM-DD` | 이 KST 날짜를 "오늘"로 보고 실행(과거 날짜 보충)           |
| `MORNING_FORCE` | `1`          | 이미 `complete`인 날도 다시 실행한다. 브리핑도 다시 보낸다 |

### 감독이 적용하는 순서 (6b)

1. 사용자가 FRED·ECOS 키와 텔레그램 봇 토큰·chat ID를 저장하고 서비스에 연결했는지 확인한다([provider-setup.md](provider-setup.md)). 없어도 배포는 깨지지 않으며 해당 단계가 `*_NOT_CONFIGURED`로 건너뛰어진다.
2. `node scripts/gcp.mjs plan`. 기대 변경은 **추가만**이다: `secretAccessor` 바인딩 4개(`jobs_morning`), Scheduler 작업 1개(`investing-morning-calendar`, 일시 정지). `google_project_iam_member.jobs_ai`는 **나오면 안 된다**(변수 기본값 `false`). 기존 리소스의 교체·삭제가 있으면 적용하지 않는다. `apply`.
3. PR을 `main`에 병합하면 `Deploy morning calendar job` 단계가 job을 만든다(`MORNING_AI_ENABLED=false`, 연결된 숫자 버전의 FRED·ECOS·텔레그램 비밀만 붙인다. 연결되지 않은 비밀은 경고만 남긴다). `gcloud run jobs describe investing-morning-calendar …`로 계정·VPC·비밀 버전·환경변수를 눈으로 확인한다.
4. **수동 실행 한 번**(위). 정제된 로그와 `morningRuns/{날짜}` 문서, 캘린더의 새 이벤트·값, 텔레그램 브리핑을 확인한다. 값이 `VALUE_NOT_AVAILABLE_YET`로만 나오면 신선도 임계값과 FRED 응답을 점검한다([캘린더 문서](../implementation/calendar.md#작업-단계-모두-멱등-한-단계의-실패가-다음-단계를-막지-않는다)).
5. `terraform.tfvars`에 `morning_schedule_enabled = true`를 넣고 `plan`(Scheduler `paused`만 바뀌어야 한다)·`apply`.
6. 이틀 연속 자동 실행을 확인한다(6b 완료 기준).

### 아침 작업 AI 켜기

**사용자 승인 전에는 하지 않는다.** 남은 일:

1. 사용자가 월 AI 비용 상한을 승인한다(근거 계산: [ai-provider.md](../implementation/ai-provider.md#비용-상한-계산-근거-가격-미확인)의 호출 수·토큰 상한에 공식 가격표 단가를 곱한 값을 설계 문서 5절에 기록).
2. `terraform.tfvars`에 `morning_ai_enabled = true`, `plan`(추가: `google_project_iam_member.jobs_ai` 1개만)·`apply`.
3. 변경 PR에서 `.github/workflows/deploy.yml`의 morning 단계 `MORNING_AI_ENABLED=false`를 `true`로 바꾸고, 저장소 변수 `AI_PROVIDER=vertex`·`AI_MODEL=gemini-3.8-flash`가 설정되어 있는지 확인한다(없으면 `true`로 설정이 오류가 나 job이 시작하지 않는다). 병합·배포.
4. 수동 실행(`MORNING_FORCE=1`)으로 한 번 확인한다: `morningRuns/{날짜}.ai`의 호출 수·토큰, 이벤트의 `aiSummary`, 번역 제목. Vertex가 `thinkingLevel: LOW`를 거부하면(400) `ai-morning.ts`의 `MORNING_AI_TASKS`만 고친다.
5. 끄려면 3번의 값을 `false`로 되돌려 배포하면 된다(IAM은 남아도 호출이 없다).

## 확인과 문제 해결

- 상태 API(소유자 전용): `GET /api/snapshots/status`. 시장별 최근 5회의 상태, 시도 횟수, 대상·기록 건수, 단계별 상태 코드.
- 로그: `gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="investing-daily-snapshot"'`. 정제된 필드만 있다. 오류 코드의 뜻은 [스냅샷 문서](../implementation/snapshots.md#상태-코드)를 본다.
- `PROVIDER_ACCESS_DENIED`가 나오면 먼저 토스 허용 IP, 그다음 비밀 버전을 확인한다. `PROVIDER_FORBIDDEN`은 키에 해당 수급 API 권한이 없다는 뜻이며 실패가 아니다.

## 비용 메모 (2026-10-21 추정, 공식 가격표 재확인 필요)

- Cloud Scheduler: 작업 3개(스냅샷 2개 + 아침 1개). 결제 계정당 3개까지 무료라서 현재는 0원이고, 7c가 작업을 더하면 3개를 넘고 초과분은 작업당 월 약 $0.10이다(가격표로 다시 확인).
- 아침 작업: Cloud Run Job 하루 1회 1~2분, FRED·ECOS·RSS 호출 수십 회, Firestore 쓰기 하루 수십 건으로 무료 구간 안이다. Vertex는 꺼져 있어 0원이며 켜면 [AI 비용 상한](../implementation/ai-provider.md#비용-상한-계산-근거-가격-미확인)을 따른다.
- Cloud Run Job: 1 vCPU·512MiB, 실행 1분 안팎(보유·목록 20종목 기준 호출 약 120회 × 0.25초 간격), 하루 3~4회. 무료 구간 안이다.
- Firestore: 문서 쓰기 하루 수백 건, 저장은 연 150MB 안팎([스냅샷 문서](../implementation/snapshots.md#저장-용량-추정)). 무료 구간 안이다.
- 네트워크: 기존 고정 IP·Cloud NAT를 공유한다. 추가 고정비는 없다.

## 아직 확인하지 못한 것

- Cloud Scheduler(서울)가 OAuth 토큰으로 `run.googleapis.com/v2/…/jobs/<이름>:run`을 호출하는 것과 `roles/run.invoker`만으로 충분한지(첫 자동 실행에서 확인).
- `gcloud run jobs deploy --set-secrets`가 배포 계정에 비밀 접근 권한 없이 되는지(서비스 계정의 접근만 검사한다고 알려져 있으나 실제 배포에서 확인).
- 배포 워크플로의 `jq` 식(서비스 JSON에서 비밀 버전 추출)은 로컬에서 실행하지 못했다. 첫 실행 로그의 경고 여부로 확인한다.
- 토스 호출 한도의 실제 값과 `PROVIDER_FORBIDDEN`의 실제 응답은 실호출로 확인한다.

## 모의 운용 작업 (algo-paper)

7c에서 같은 틀 위에 추가한 두 번째 작업이다. 판단·저장·안전장치 의미는 [알고리즘 7c](../implementation/algorithm.md#7c-모의-운용-작업-구현-2026-10-21-운영-적용-전)에 있다. 이 작업은 가상 기록만 만들고 **주문을 내지 않는다**. 상태: 합성 테스트와 `terraform validate`까지 완료, 운영 적용 전.

```
Cloud Scheduler 2개 ──POST jobs:run (overrides: ALGO_MARKET=KR|US)──▶ Cloud Run Job investing-algo-paper
  investing-algo-paper-kr  09:05 KST 월~금                              investing-jobs SA(스냅샷 작업과 같은 계정), 같은 이미지 digest
  investing-algo-paper-us  22:35·23:35 KST 월~금                         고정 출구 IP → 토스(캘린더·일봉·현재가)
                                                                         Firestore: algorithmRuns, paperLedgers, paperTrades, notifications
```

- 진입점 `node --import tsx src/jobs/algo-paper.ts`. 시장은 실행마다 `ALGO_MARKET`(Scheduler가 덮어쓴다)으로 받는다. 값이 없으면 설정 오류로 종료 `2`.
- 어느 슬롯이 유효한지는 작업이 장 운영 캘린더로 정한다(개장 후 20분 이내). 미국 서머타임에는 22:35, 아닐 때는 23:35만 실제로 돈다. 휴장일은 하루 한 번 `skipped`로 기록한다. 같은 시장·날짜는 `algorithmRuns/{market}_{date}`로 한 번만 돈다.
- 종료 코드: `0` 정상(할 일 없음·건너뜀 포함), `3` 일부 알고리즘 실패, `1` 전부 실패·캘린더 오류·기록 오류, `2` 설정 오류. `3`·`1`이면 텔레그램 `job-failure`를 보낸다. `--max-retries=0`이고 Scheduler 재시도는 호출 실패만 2회 한다.
- 환경 변수(배포 워크플로가 설정): `NODE_ENV=production`, `GOOGLE_CLOUD_PROJECT`, `APP_ORIGIN`(알림 링크), `ALGO_AI_ENABLED=false`. 수동 실행에서만 쓰는 값: `ALGO_PAPER_SLIPPAGE_BPS`(0~500, 기본 10), `ALGO_OPEN_WINDOW_MINUTES`(1~120, 기본 20; 쓰면 기록의 `trigger`가 `manual`).
- 비밀: 토스 4개(스냅샷 작업과 같은 숫자 버전)와, 서비스에 숫자 버전으로 연결되어 있을 때만 `TELEGRAM_BOT_TOKEN`·`TELEGRAM_CHAT_ID`. 텔레그램이 없으면 알림은 화면 목록에 `disabled`로만 남고 판단은 그대로 돈다. Terraform이 `investing-jobs`에 텔레그램 비밀 두 개의 비밀 단위 `secretAccessor`를 준다(`infra/gcp/jobs-algo.tf`).

### Terraform (`infra/gcp/jobs-algo.tf`, 변수 `algo_schedules_enabled`, 기본 `false` = 일시 정지)

기대하는 `plan`은 **추가만** 2개다: `google_cloud_scheduler_job.algo_paper_kr`, `google_cloud_scheduler_job.algo_paper_us`(둘 다 `paused=true`). 텔레그램 비밀 접근은 같은 `investing-jobs` 계정에 `jobs-morning.tf`가 이미 준다. Cloud Run Job 자체와 `run.invoker` 바인딩은 배포 워크플로가 만든다. 기존 리소스의 교체·삭제가 있으면 적용하지 않는다. 일정: KR `5 9 * * 1-5`, US `35 22,23 * * 1-5`(Asia/Seoul).

### 배포 (`deploy.yml`의 `Deploy paper algorithm job` 단계)

스냅샷 단계 뒤에, 서비스를 실제로 배포한 실행에서만 돈다. 같은 digest·`investing-jobs` 계정·VPC(`vpc-egress=all-traffic`)·토스 비밀의 숫자 버전(`jq`)을 쓰고 `--command=node --args=--import,tsx,src/jobs/algo-paper.ts`, `--max-retries=0 --task-timeout=900s --cpu=1 --memory=512Mi`, 환경 변수에 `ALGO_AI_ENABLED=false`를 명시한다. 토스 비밀 네 개가 숫자 버전으로 없으면 경고만 하고 건너뛴다. 이어서 `investing-scheduler`에 이 job 하나의 `run.invoker`를 부여한다. 런타임 이미지에는 이제 `src/lib`도 들어간다(`Dockerfile`; 알고리즘 엔진을 서버와 이 작업이 공유한다). CI 컨테이너 검사도 `algo-paper.ts`와 `src/lib/algo/paper.ts`의 존재를 확인한다.

### 감독이 적용하는 순서

1. `node scripts/gcp.mjs plan`으로 위의 추가 5개만 있는지 확인하고 `apply`한다.
2. 이 PR을 병합한다. CI를 통과한 SHA가 배포되며 job이 생긴다(이미 병합된 뒤라면 `Deploy GCP`를 다시 실행).
3. `gcloud run jobs describe investing-algo-paper`(개인 계정·프로젝트 명시)로 서비스 계정, VPC, 비밀 버전, `ALGO_AI_ENABLED=false`를 눈으로 확인한다.
4. **수동 실행 한 번**: 모의 알고리즘을 하나 만들어 모드를 "모의"로 저장하고, 개장 직후 거래일에 아래처럼 실행한다. 개장 창 밖이면 `OUTSIDE_OPEN_WINDOW`로 아무것도 하지 않는다(창을 넓히려면 `ALGO_OPEN_WINDOW_MINUTES`).

```sh
gcloud run jobs execute investing-algo-paper --region=asia-northeast3 \
  --account=<개인 계정> --project=<개인 프로젝트> \
  --update-env-vars=ALGO_MARKET=KR,ALGO_OPEN_WINDOW_MINUTES=120 --wait
```

5. 결과 확인: 정제된 로그, 화면의 "모의 운용" 구역, `algorithmRuns/KR_<날짜>` 문서. 실제 `/prices`의 `timestamp`가 신선도(60초) 판정에 맞는지, 일봉이 직전 거래일까지 오는지 먼저 확인한다(알고리즘 문서의 "확인하지 못한 것").
6. `terraform.tfvars`에 `algo_schedules_enabled = true`를 넣고 `plan`(Scheduler 두 개의 `paused`만 바뀌어야 한다)·`apply`로 켠다. 영업일마다 모의 판단이 쌓이는지 이틀 이상 지켜본다.

### AI형 켜기 (비용 승인 뒤에만)

`ALGO_AI_ENABLED`는 정확히 문자열 `true`일 때만 켜진다. 사용자가 월 비용을 승인하면: Vertex 접근 권한(`investing-jobs`에 `aiplatform.user`)과 모델 가격·생각 토큰 설정을 확인하고, 배포 단계의 `ALGO_AI_ENABLED=false`를 `true`로 바꿔 병합한다. 하루 호출은 기능별 12회로 제한된다(`aiUsage/algorithm_{KST날짜}`). 그 전에는 AI형이 "AI 비용 승인 대기"로 건너뛰어진다.

### 비용 메모

Scheduler 작업이 4개가 되어 무료 3개를 넘는다(초과분 작업당 월 약 $0.10, 가격표 재확인 필요). Cloud Run Job은 하루 2회(국내 1, 미국 1) 몇 분, 일봉 500개 조회는 종목당 3쪽이라 알고리즘 수 × 종목 수 × 약 3회 호출을 0.25초 간격으로 보낸다. 토스 호출 한도의 실제 값은 아직 모른다(실호출 확인 대상).

## 실전 작업 (algo-live, 7f)

**실제 주문이 나가는 작업이다. 기본은 꺼져 있고, 켜는 순서를 지킨다.** 설계와 흐름은 [trading.md](../implementation/trading.md#연결-7e7f), 화면은 [algorithm.md](../implementation/algorithm.md#7f-실전-운용-구현-2026-10-21-운영-적용-전-실주문-미검증)에 있다. 이 PR은 합성 테스트와 `terraform validate`만 거쳤고 운영 적용·실주문은 하지 않았다.

### 구성

- Cloud Run Job `investing-algo-live`(배포 워크플로 `Deploy live algorithm job`): 같은 이미지 digest·`investing-jobs` 계정·VPC·토스 비밀 숫자 버전 + 텔레그램 비밀(없으면 경고 후 배포하지만 **작업이 시작을 거부한다**), `--command=node --args=--import,tsx,src/jobs/algo-live.ts`, `--max-retries=0`, 환경 변수 `ALGO_AI_ENABLED=false`, **`LIVE_TRADING_ENABLED`(이 작업에만, 값은 GitHub 저장소 변수 `LIVE_TRADING_ENABLED`에서 온다: 정확히 `true`일 때만 `true`, 변수가 없거나 다른 값이면 `false`로 배포)**. `investing-scheduler`에 이 job의 `run.invoker`를 부여한다.
- **실전은 문이 세 개이고, 거기에 배포 스위치가 하나 더 있다.** (1) 사용자가 알고리즘마다 화면에서 "실전 켜기"를 누른다. (2) 운영자가 `live_schedules_enabled = true`로 Scheduler를 켠다. (3) 작업이 `LIVE_TRADING_ENABLED=true`로 배포되어 있다. 그리고 4번째로, 이 값은 코드나 배포 파일에 박혀 있지 않고 **저장소 변수**(Settings > Secrets and variables > Actions > Variables)다. 변수를 만들지 않으면 첫 배포는 스위치를 꺼 둔다. 켜려면 변수를 `true`로 만들고 `Deploy GCP`를 다시 실행(재배포)한다. 끄려면 변수를 지우거나 `false`로 바꾸고 재배포하거나, 즉시는 아래 `gcloud run jobs update`를 쓴다.
- 킬 스위치: `LIVE_TRADING_ENABLED`가 정확히 `true`가 아니면 작업은 설정 오류(종료 코드 2)로 끝나고 토스·Firestore에 접근하지 않는다. 화면 설정과 무관한 배포 수준 스위치다. 끄려면 `gcloud run jobs update investing-algo-live --update-env-vars=LIVE_TRADING_ENABLED=false`(다음 배포는 저장소 변수 값으로 되돌리므로 영구히 끄려면 변수를 지우거나 `false`로 한다) 또는 Scheduler를 일시 정지한다.
- Terraform `infra/gcp/jobs-live.tf`(변수 `live_schedules_enabled`, 기본 `false` = 일시 정지): `investing-algo-live-kr`(평일 09:05 KST), `investing-algo-live-us`(평일 22:35·23:35 KST, 서머타임은 달력이 정해 한 슬롯만 동작). 비밀 접근을 추가하지 않는다(`investing-jobs`가 이미 토스·텔레그램 접근을 가진다). **예상 `terraform plan`: Scheduler 작업 2개 추가(paused)만.** 변수를 `true`로 바꾸면 그 두 개의 `paused`만 바뀐다.
- Cloud Run Job `investing-order-access-check`(`Deploy order access check job`): 토스 비밀만, `--args=--import,tsx,src/jobs/order-access-check.ts`, 일정·`run.invoker` 없음, `LIVE_TRADING_ENABLED` 없음.
- CI `container` 작업이 새 파일(`algo-live.ts`, `algo-live-data.ts`, `order-access-check.ts`, `toss-transport.ts`, `executor.ts`, `lib/algo/live.ts`) 존재를 검사한다.

### 감독·사용자가 지키는 순서 (하나라도 아니면 다음으로 가지 않는다)

1. `node scripts/gcp.mjs plan`으로 위의 Scheduler 2개(paused)만 추가되는지 확인하고 `apply`. **`live_schedules_enabled`는 아직 `false`.**
2. 이 PR 병합 → 배포. **저장소 변수 `LIVE_TRADING_ENABLED`는 아직 만들지 않는다(그러면 작업이 꺼진 채로 배포된다).** `gcloud run jobs describe investing-algo-live`와 `investing-order-access-check`(개인 계정·프로젝트 명시)로 서비스 계정, VPC, 비밀 버전, `ALGO_AI_ENABLED=false`, `LIVE_TRADING_ENABLED=false`(live 작업에만 있음)를 눈으로 확인한다. 텔레그램 비밀이 연결되어 있는지 확인한다(없으면 작업이 시작하지 않는다).
3. **주문 권한 읽기 확인(주문을 내지 않는다)**: 고정 출구 IP를 쓰는 이 작업을 한 번 실행한다.

```sh
gcloud run jobs execute investing-order-access-check --region=asia-northeast3 \
  --account=<개인 계정> --project=<개인 프로젝트> --wait
# 같은 일을 명령을 명시해서: --args=--import,tsx,src/jobs/order-access-check.ts 를 덧붙여도 된다.
```

종료 코드 0이고 로그가 `status: all-ok`이면 통과다(`denied`는 권한 거부, `failed`는 그 밖의 실패. 로그에는 상태와 코드만 있다). 결과는 화면의 "주문 권한 확인"에도 나타난다. 통과하지 못하면 여기서 멈추고 원인을 확인한다. 4. **사용자가 토스증권 WTS 설정 > Open API 화면에서 주문 관련 설정을 직접 확인한다**(읽기 확인은 주문 권한 자체를 증명하지 않는다). 5. **사용자가 화면에서 알고리즘 하나를 골라 운용 금액을 작게 입력하고 "실전 켜기"를 누른다.** 텔레그램에 `실전 매매 켜기` 알림이 오는지 확인한다. 이때까지는 실전 일정이 꺼져 있어 주문이 나가지 않으며 화면이 그렇게 알린다. 6. **운영자가 먼저 저장소 변수 `LIVE_TRADING_ENABLED`를 `true`로 만들고 재배포해 `gcloud run jobs describe investing-algo-live`에서 `true`를 확인한 뒤, `terraform.tfvars`(gitignore 대상)에 `live_schedules_enabled = true`를 넣고 `plan`(Scheduler 두 개의 `paused`만 바뀌어야 한다)·`apply`.** 7. **첫 주문을 지켜본다**: 다음 개장 직후(한국 09:05 KST) 로그, 화면의 실전 주문·보류·차단 기록, 텔레그램(체결·거부·자동 정지·접수 여부 미확인), 토스증권 앱의 실제 주문을 서로 대조한다. 첫 주문이 거부되면 알고리즘이 자동 정지되고 알림이 온다. 이상하면 **긴급 정지**를 누르거나 `live_schedules_enabled`를 `false`로 되돌린다.

### 문제 해결

| 증상                               | 의미                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 종료 코드 2, `JOB_CONFIG_INVALID`  | `LIVE_TRADING_ENABLED`가 `true`가 아니거나 텔레그램·`APP_ORIGIN`·토스·시장 설정이 없다. 작업은 아무것도 하지 않았다                                                                                                                                                                                                                                            |
| 하트비트 `OUTSIDE_OPEN_WINDOW`     | 개장 직후 20분 창 밖(미국 슬롯 두 개 중 해당 없는 쪽) 또는 이미 끝난 날. 정상                                                                                                                                                                                                                                                                                  |
| 하트비트 `RUN_ALREADY_COMPLETE`    | 같은 시장·날짜는 한 번만 돈다. 정상                                                                                                                                                                                                                                                                                                                            |
| 화면 "실전 일정이 아직 꺼져 있어…" | 4일 넘게(또는 한 번도) 실전 작업이 돌지 않았다(작업은 영업일마다 돌고 휴장일에도 기록을 남긴다). 순서 6을 했는지, Scheduler가 일시 정지가 아닌지 확인                                                                                                                                                                                                          |
| 알고리즘 "정지"                    | 누적 손실 한도, 권한 거부(401/403), 첫 주문 거부 중 하나. 사유를 읽고 원인을 해결한 뒤 화면에서 "정지 해제"                                                                                                                                                                                                                                                    |
| "접수 여부 미확인" 주문            | 응답을 받지 못한 주문. 동기화가 미체결·종결 주문에서 유일한 일치를 찾으면 이어받고, 못 찾으면 토스증권 앱에서 확인한 뒤 화면의 미확인 주문 정리로 결과를 기록한다. 한 세션이 지나도 남으면 알고리즘이 자동 정지된다. 마지막 실행이 실패·일부 실패면 화면이 오류 색으로 보여 주고, 긴급 정지·정지 상태를 읽지 못한 경우도 실패로 보고되어 작업 실패 알림이 간다 |
