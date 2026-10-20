# 예약 작업 (Cloud Scheduler → Cloud Run Job)

4단계에서 만든 예약 작업 기반이다. 6b(아침 캘린더 갱신)와 7c(시장별 알고리즘 판단)가 같은 틀을 다시 쓴다. 첫 작업은 일일 스냅샷(`investing-daily-snapshot`)이며 데이터 구조와 동작은 [일일 스냅샷](../implementation/snapshots.md)에 있다. 상태: **구현·검증 완료(합성 테스트와 `terraform validate`), 운영 적용 전**. 실제 클라우드 적용과 실호출 확인은 아래 순서로 감독이 한다.

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

| 주체                     | 권한                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `investing-jobs` SA      | `datastore.user`(Firestore 읽기·쓰기), 토스 비밀 4개(`client-id`, `client-secret`, `account-seq`, `owner-user-id`)에 대해 **비밀 단위** `secretAccessor` |
| `investing-scheduler` SA | 프로젝트 권한 없음. 배포 워크플로가 `investing-daily-snapshot` **job 하나**에만 `roles/run.invoker`를 부여한다                                           |
| `investing-deploy` SA    | 기존 `run.admin`으로 job 생성·갱신, 새로 `investing-jobs`에 대한 `iam.serviceAccountUser`(job이 그 계정으로 돌게 함)                                     |

- 프로젝트 단위 `secretAccessor`는 주지 않는다. DART·FRED·ECOS·텔레그램 비밀은 이 작업에 필요 없어서 접근 권한이 없다(6b 이후에 필요한 비밀만 추가).
- Firestore는 컬렉션 단위 IAM이 없어 `datastore.user`가 모든 컬렉션(계정·세션 포함)을 읽고 쓸 수 있다. 서비스(`investing-runtime`)와 같은 수준이며, 작업 코드는 `marketSnapshots`·`snapshotRuns`·`snapshotTargets`·`economicEvents`·`providerTokens`만 건드린다. 이 잔여 위험은 인지하고 있다.
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

## 확인과 문제 해결

- 상태 API(소유자 전용): `GET /api/snapshots/status`. 시장별 최근 5회의 상태, 시도 횟수, 대상·기록 건수, 단계별 상태 코드.
- 로그: `gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="investing-daily-snapshot"'`. 정제된 필드만 있다. 오류 코드의 뜻은 [스냅샷 문서](../implementation/snapshots.md#상태-코드)를 본다.
- `PROVIDER_ACCESS_DENIED`가 나오면 먼저 토스 허용 IP, 그다음 비밀 버전을 확인한다. `PROVIDER_FORBIDDEN`은 키에 해당 수급 API 권한이 없다는 뜻이며 실패가 아니다.

## 비용 메모 (2026-10-21 추정, 공식 가격표 재확인 필요)

- Cloud Scheduler: 작업 2개. 결제 계정당 3개까지 무료라서 현재는 0원이다. 6b·7c가 작업을 더하면 3개를 넘을 수 있고 초과분은 작업당 월 약 $0.10이다(가격표로 다시 확인).
- Cloud Run Job: 1 vCPU·512MiB, 실행 1분 안팎(보유·목록 20종목 기준 호출 약 120회 × 0.25초 간격), 하루 3~4회. 무료 구간 안이다.
- Firestore: 문서 쓰기 하루 수백 건, 저장은 연 150MB 안팎([스냅샷 문서](../implementation/snapshots.md#저장-용량-추정)). 무료 구간 안이다.
- 네트워크: 기존 고정 IP·Cloud NAT를 공유한다. 추가 고정비는 없다.

## 아직 확인하지 못한 것

- Cloud Scheduler(서울)가 OAuth 토큰으로 `run.googleapis.com/v2/…/jobs/<이름>:run`을 호출하는 것과 `roles/run.invoker`만으로 충분한지(첫 자동 실행에서 확인).
- `gcloud run jobs deploy --set-secrets`가 배포 계정에 비밀 접근 권한 없이 되는지(서비스 계정의 접근만 검사한다고 알려져 있으나 실제 배포에서 확인).
- 배포 워크플로의 `jq` 식(서비스 JSON에서 비밀 버전 추출)은 로컬에서 실행하지 못했다. 첫 실행 로그의 경고 여부로 확인한다.
- 토스 호출 한도의 실제 값과 `PROVIDER_FORBIDDEN`의 실제 응답은 실호출로 확인한다.
