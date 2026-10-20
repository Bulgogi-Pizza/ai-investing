# 재현 가능한 배포

## 선행 조건

관리자 권한의 GitHub 로그인, 결제 연결된 GCP 프로젝트와 API/IAM 생성 권한, 상세 토스 API 계약. 자격증명을 저장소에 넣지 않는다. 신규 프로젝트라면 조직·결제 계정·프로젝트 ID를 정한 뒤 구성한다. 기존 Firestore 기본 DB가 있다면 Terraform import와 지역 확인을 먼저 수행한다. 이 구성은 기존 DB를 교체하지 않는다.

## GitHub

```sh
gh auth login -h github.com
git init -b main
npm run check
git add .
git diff --cached --stat
git commit -m 'Build private investing workspace foundation'
gh repo create ai-investing --public --source=. --remote=origin --push
```

공개되는 것은 소스뿐이다. `.env*` 실파일, terraform state, 계정정보는 커밋하지 않는다. public repo의 Secret scanning과 Push protection을 활성화한다. main 규칙에 Verify 필수 통과를 설정한다. production environment 접근을 제한한다.

## 인프라

```sh
cd infra/gcp
cp terraform.tfvars.example terraform.tfvars
# 프로젝트/owner/repo/숫자 repository ID를 입력한다. 비밀은 넣지 않는다.
terraform init
terraform plan -out=/private/tmp/investing-plan
terraform apply /private/tmp/investing-plan
```

Terraform은 API·Artifact Registry·Firestore·세션 TTL·서비스 계정·GitHub WIF·선택 예산 알림을 만든다. Cloud Run은 검증된 이미지로 배포 워크플로가 생성한다. state는 민감 정보이므로 개인 프로젝트의 비공개 GCS 버킷 `<project>-tfstate`(prefix `infra/gcp`, 버전 관리, 공개 접근 차단)에 둔다. 버킷 이름은 공개 저장소에 쓰지 않고 gitignore된 `.local/gcs-backend.hcl`에 `bucket`·`prefix` 두 줄로 둔다. 버킷은 state 밖에서 gcloud로 만든다. 서비스 계정에는 Storage 권한을 주지 않는다. Firestore PITR은 유료 추가 비용일 수 있다. Firestore Security Rules는 `firestore.rules`로 모든 클라이언트 접근을 차단해야 한다. 이 서버는 IAM/Admin SDK만 사용한다. Firebase 클라이언트 SDK는 포함하지 않는다.

GitHub 저장소의 Actions Variables에 다음 비밀이 아닌 값을 설정한다. 배포 job의 if 조건에서도 읽으므로 환경 전용 변수가 아닌 저장소 변수로 등록한다:

- GCP_PROJECT_ID
- GCP_WORKLOAD_IDENTITY_PROVIDER (`terraform output -raw workload_identity_provider`)
- GCP_DEPLOY_SERVICE_ACCOUNT (`terraform output -raw deploy_service_account`)
- APP_ORIGIN (`https://` 서비스 최종 URL, 뒤 슬래시 없이)

장기 JSON 서비스 계정 키는 만들지 않는다. WIF는 repo 이름/불변 숫자 ID/main 브랜치/배포 workflow_ref/production 환경/workflow_run 이벤트를 함께 제한한다. 일반 workflow에서는 reusable workflow 전용 job_workflow_ref를 쓰지 않는다. 근거: https://docs.github.com/en/actions/reference/security/oidc . 레지스트리 writer는 해당 Artifact Registry 저장소에만 부여한다. 배포 계정 run.admin 권한은 서비스 IAM 초기 설정 때문에 필요하며 전용 프로젝트에 한정한다. 런타임은 datastore.user만 가진다.

## 예약 작업

Terraform `jobs.tf`가 작업용 서비스 계정과 Cloud Scheduler 트리거를 만들고, `Deploy GCP`가 서비스 배포 뒤에 Cloud Run Job을 같은 이미지 digest로 배포한다. 적용 순서, 수동 실행, IAM은 [예약 작업](jobs.md)을 따른다.

## 최초 서비스 URL 확정

Cloud Run URL이 아직 없으면 로컬에서 첫 검증 이미지를 Artifact Registry로 push하고 배포한다. APP_ORIGIN은 최초에 `https://bootstrap.invalid`로 두면 로그인/변경 요청이 차단된 안전한 상태로 서버가 시작된다. `gcloud run services describe ... --format='value(status.url)'`로 URL을 얻고 APP_ORIGIN을 해당 URL로 수정한 뒤 GitHub 환경 변수에도 저장한다. 실제 계정은 이 작업 이후 생성한다. 도메인 사용 시 APP_ORIGIN도 함께 갱신한다.

## 런타임 비밀

토스 환경변수 네 개(`TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET`, `TOSS_ACCOUNT_SEQ`, `TOSS_OWNER_USER_ID`)는 모두 Secret Manager에만 두고 서비스에는 비밀 참조로 연결한다. 키 발급, 허용 IP 등록, 키 저장, 계좌 연결, 실조회 검증 절차는 [토스 키 입력 및 계좌 연결](toss-setup.md)을 따른다. 실제 주문은 소유자 전용 알고리즘 실전 운용에서만, [설계](../planning/next-phase-design.md) 4절의 안전장치를 모두 통과할 때 허용한다. 아직 구현되지 않았다.

DART·FRED·ECOS 키, 텔레그램 봇 토큰·chat ID, SEC User-Agent는 같은 방식으로 저장하며 절차는 [외부 키·텔레그램 봇 준비](provider-setup.md)를 따른다.

`TOSS_OWNER_USER_ID` 계정은 관리자(admin) 계정이어야 한다. 캘린더 JSON 등록과 공식 뉴스 수집은 관리자이면서 소유자인 계정만 할 수 있고, 소유자가 관리자가 아니면 이 쓰기 작업을 할 계정이 없다. `scripts/provision-owner.ts`가 만드는 최초 소유자는 관리자다.

## 운영

`Verify`가 성공한 main push SHA만 `Deploy GCP`에서 Docker 이미지 digest로 배포한다. PR/fork는 배포되지 않는다. 이미지 보존은 최신5개/30일로 관리한다. `/api/health` 검증 후 Cloud Run revision/트래픽을 확인한다. 실패 시 이전 revision으로 트래픽 복구하고 원인 수정 후 다시 main 검증한다. 동시 배포는 직렬화된다. 런타임 로그에 요청 body/계좌/토큰을 기록하지 않는다.

Firestore TTL 삭제는 즉시가 아니므로 만료는 항상 앱에서 검사한다. PITR 복구와 데이터 삭제를 별도 운영 절차로 검증한다. 예산 경고는 지출 제한이 아니므로 콘솔 비용을 함께 확인한다.

## 고정 출구 IP

network.tf가 VPC/subnet/Cloud Router/NAT/정적IP를 생성한다. CI의 Cloud Run 설정은 모든 외부 요청을 Direct VPC egress로 보낸다. 기본 Cloud Run 직접 출구를 사용하면 토스 IP 허용 목록을 만족하지 못한다. 정적IP/NAT는 scale-to-zero 상태에도 비용이 발생할 수 있다. 월비용은 cloud-comparison.md 참조.

정적IP `investing-egress`는 토스 허용 목록에 등록되는 주소이므로 `prevent_destroy`로 보호한다. 이 리소스를 삭제하거나 다시 만드는 plan은 Terraform이 오류로 막는다. 주소를 바꿔야 한다면 보호 설정을 의도적으로 해제하고, 새 주소를 토스 허용 목록에 다시 등록한다.

## 최초 관리자 생성

권한 있는 운영자 환경에서 ADC와 대상 GOOGLE_CLOUD_PROJECT를 설정한 뒤 실행한다. 비밀번호를 명령행/히스토리/커밋에 남기지 않는다. zsh의 보안 입력 예시:

```sh
read 'PROVISION_ADMIN_EMAIL?관리자 이메일: '
read -rs 'PROVISION_ADMIN_PASSWORD?관리자 비밀번호(12자 이상): '
export PROVISION_ADMIN_EMAIL PROVISION_ADMIN_PASSWORD
node --import tsx scripts/admin-user.ts
unset PROVISION_ADMIN_EMAIL PROVISION_ADMIN_PASSWORD
```

생성 스크립트는 실제 계정을 출력하지 않는다. 개발 서버 ADMIN_*와 운영 프로비저닝 PROVISION_ADMIN_*를 혼용하지 않는다.

## 개인 계정 강제 운영 도구

회사 계정 기본 설정을 실수로 쓰지 않도록 `scripts/gcp.mjs`를 제공한다. 사용자가 지정한 개인 계정/프로젝트를 gitignore된 `.local/deployment.json`에 `{ "personalOnly": true, "account": "YOUR_PERSONAL_ACCOUNT", "project": "YOUR_PERSONAL_PROJECT" }` 형태로 넣는다. 공개 소스에는 실제 이메일/결제 ID를 넣지 않는다.

```sh
node scripts/gcp.mjs doctor
node scripts/gcp.mjs init
node scripts/gcp.mjs plan
node scripts/gcp.mjs apply
```

이 도구는 gcloud의 기본 계정을 사용하지 않고 모든 호출에 지정 계정을 전달한다. OAuth 토큰은 메모리의 자식 프로세스 환경변수로만 전달한다. plan은 개인 프로젝트를 CLI 변수로 고정한다. apply는 실제 활성 결제 상태와 저장된 plan의 프로젝트 일치 여부를 검사한다. `.local/gcp.plan`을 검토한 뒤 apply하며 이 명령은 실제 리소스를 만든다. 먼저 비밀 없는 `terraform.tfvars`를 두고 `node scripts/gcp.mjs init`으로 원격 state에 연결한다. init은 `.local/gcs-backend.hcl`의 버킷이 지정 프로젝트의 `<project>-tfstate`가 아니면 중단한다. Windows에서도 같은 명령을 쓴다. 기본 ADC에 의존한 수동 apply는 피한다.

개인 계정 ADC 혼용을 피하는 최초 소유자 생성 도구도 제공한다: `node --import tsx scripts/provision-owner.ts`. 비공개 deployment.json의 지정 계정으로만 gcloud 임시 토큰을 메모리에서 얻고, 공식 Firestore REST commit으로 이메일 예약·관리자 문서를 원자적으로 생성한다. 기존 계정은 덮어쓰지 않는다. 무작위 초기 비밀번호는 해시로 서버에 저장하고 원문은 gitignore된 `.local/owner-access.json`(0600)에만 기록한다. 채팅·로그·공개 저장소에 출력하지 않는다. 최초 소유자 이메일은 지정한 개인 배포 계정과 같다. 이 파일을 안전한 비밀번호 관리자로 옮긴 뒤 로컬 원문을 정리한다. 출처: https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/commit .

계정 지정만으로 gcloud의 기본 quota project가 바뀌지는 않는다. 운영 도구는 account와 함께 project/billing-project를 모두 개인 프로젝트로 고정한다. Terraform provider도 billing_project와 user_project_override를 명시한다. 회사 기본 프로젝트의 권한을 추가하거나 설정을 바꾸어 우회하지 않는다. Docker push의 인증 도우미에도 CLOUDSDK_CORE_ACCOUNT/CLOUDSDK_CORE_PROJECT/CLOUDSDK_BILLING_QUOTA_PROJECT를 개인 범위로 지정한다.

`budget_currency`는 실제 청구통화와 일치해야 한다. 이 배포는 KRW/월15,000원을 사용하고50/90/100% 알림을 설정한다. 다른 계정에서는 통화·금액을 다시 지정한다. 개인 프로젝트를 quota project로 처음 사용할 때 Cloud Billing/Cloud Resource Manager API를 명시적으로 활성화한 후 plan을 수행한다.

## 실제 배포와 제공자 확인

서비스는 https://ai-investing-688204744640.asia-northeast3.run.app 에 배포되어 있다. GitHub main의 Verify 성공 후 Deploy GCP가 검증 SHA를 이미지 digest로 배포하고 health를 확인한다. main4b1033e의 실제 OIDC 배포 성공을 확인했다. 오래된 SHA는 배포 직전 현재 main과 비교해 건너뛴다.

`AI_PROVIDER=vertex`, `AI_MODEL=gemini-3.1-flash-lite`, `AI_LOCATION=global`은 비밀이 아닌 GitHub 저장소 변수다. 런타임 SA의 개인 프로젝트 Vertex IAM으로 호출하며 개인키/API키를 보관하지 않는다. 공유 Firestore aiUsage TTL과 하루25회 제한을 적용한다. 자세한 계약과 데이터 최소화는 implementation/ai-provider.md를 따른다.

실제 인증 스모크는 `node scripts/smoke-deployed.mjs`로 수행한다. 개인 접속 파일을 내부에서 읽고 세션을 폐기하며 비밀번호·세션을 출력하지 않는다. `--sync-news`를 추가하면 공식 공개 보도자료를 실제 저장하며 출처별 건수/상태만 출력한다. 로그인 시도 제한에 포함되므로 짧은 시간에 반복하지 않는다. 토스 미설정503은 정상적인 미연결 상태로 확인한다.
