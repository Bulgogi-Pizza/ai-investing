# 토스 키 입력 및 계좌 연결

이 절차는 본인 터미널에서 키를 숨김 입력으로 받아 개인 프로젝트 Secret Manager에 저장한다. 채팅, 명령행 인수, 셸 히스토리, `.env`, GitHub에 값을 붙여 넣지 않는다. 키 두 개의 저장만으로 실계좌 연동이 완료되는 것은 아니다.

## 전체 단계

두 운영 스크립트가 실행 중에 현재 단계와 다음 단계를 `[n/5]` 형식으로 출력한다. 각 스크립트는 이 배포의 고정 출구 IP(`investing-egress`)를 개인 계정으로 직접 조회해 보여 준다. 공개 문서에는 실제 주소를 적지 않는다.

1. 토스증권 WTS 설정 > Open API에서 키를 발급하고 허용 IP 관리에 고정 출구 IP를 등록한다. `scripts/toss-secrets.py`가 주소를 보여 주고 등록을 마칠 때까지 기다린다.
2. 같은 스크립트로 키 두 개를 Secret Manager에 저장한다.
3. 연결 코드가 main에 배포된 상태에서 `node scripts/connect-toss.mjs`로 사전 확인한다.
4. `node scripts/connect-toss.mjs --execute`로 계좌 식별값을 확인하고 서비스에 비밀을 연결한다.
5. 서비스에 로그인해 내 자산 페이지에서 실제 보유 내역이 보이는지 확인한다.

고정 출구 IP는 Terraform `prevent_destroy`로 보호한다. 주소가 바뀌면 1단계의 허용 IP 등록을 다시 해야 한다. 근거는 [재현 가능한 배포](deployment.md)의 고정 출구 IP 절이다.

## 운영자 입력

개인 배포 설정 `.local/deployment.json`의 `personalOnly: true`, `account`, `project`와 `.local/deployment-account.md`의 사용자 지정 계정을 먼저 확인한다. 이 파일들은 gitignore 대상이다. gcloud가 해당 개인 계정에 로그인되어 있어야 하며, Secret Manager API 및 비밀 생성/버전 추가 권한은 운영 담당자가 준비한다. 기본 회사 계정이나 프로젝트 설정은 바꾸지 않는다.

저장소 루트에서 다음을 실행한다. Python 표준 라이브러리만 사용한다.

```sh
cd /Users/dean/git/ai-investing
python3 scripts/toss-secrets.py
```

`TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET`을 차례로 입력한다. 입력 내용은 보이지 않는다. 비대화형 입력·파이프·리다이렉션은 거절하며 숨김 입력이 불가능하면 중단한다. 두 값 모두 검증한 후에만 클라우드를 변경한다. 값의 포맷을 추측하지 않고 비어 있거나 8,192바이트 초과, 줄바꿈/NUL이 있는 입력만 거절한다.

이미 ENABLED 상태의 키 버전이 하나라도 있으면 입력 전에 중단한다. 저장 직전에도 다시 검사하므로 실수로 키를 교체하지 않는다. 이 경우 스크립트는 새 키를 받지 않고 3단계 명령을 안내한다.

스크립트는 모든 gcloud 호출에 지정 개인 `--account`, `--project`, `--billing-project`를 전달한다. 아래 두 비밀만 없으면 생성하고, 새 버전을 추가한다. 값은 메모리에서 gcloud 표준입력으로 전달하며 제공자 응답·오류 원문은 출력하지 않는다.

- `investing-toss-client-id`
- `investing-toss-client-secret`

완료 후 스크립트가 3단계 명령을 안내한다. 키 값은 누구에게도 전달하지 않는다. 중간 실패 시 첫 비밀만 저장되었을 수 있다. 이미 저장된 버전이 있으면 재실행도 차단하므로 `gcloud secrets versions list`로 두 비밀의 버전 상태를 확인해야 한다. 이 도구는 IAM 부여나 서버 배포를 수행하지 않는다.

## 이후 운영 작업

운영 담당자가 런타임/일회성 조회 작업의 서비스 계정에 필요한 개별 비밀 접근 권한만 부여하고 Secret Manager 참조를 설정한다. 허용 IP 등록을 확인한 후 공식 토스 읽기 전용 계좌 목록을 조회해 계좌 식별값을 확보하고, 개인 소유 관리자 ID와 연결한다. 계좌 식별값·보유 내역·토큰은 로그나 공개 문서에 기록하지 않는다. 로그인 후 실제 자산 조회와 차트·추천 연결을 검증한 뒤 상태 문서를 갱신한다. 이 절차는 주문 API를 사용하지 않는다. 주문은 [설계](../planning/next-phase-design.md) 4절의 조건부 허용 규칙을 따른다.

## Windows 실행

macOS/Linux는 `gcloud`를 그대로 실행한다. Windows의 SDK 진입점 `gcloud.cmd`는 셸 없이 실행할 수 없으므로, 세 스크립트(`gcp.mjs`, `connect-toss.mjs`, `toss-secrets.py`)는 PATH의 `gcloud.cmd`로 SDK 루트를 찾아 `gcloud.cmd`와 같은 방식으로 `<python> -S <SDK>/lib/gcloud.py`를 셸 없이 실행한다. Python은 `CLOUDSDK_PYTHON`이 있으면 그 값, 없으면 SDK 번들 `platform/bundledpython/python.exe`다. 셸 문자열 실행(`shell: true`, `cmd /c`)은 쓰지 않으므로 인자 주입 위험이 없고, 키 값은 계속 gcloud 표준입력으로만 전달한다. PATH의 상대 경로 항목은 무시한다. 해석에 실패하면 경로나 환경값 없이 원인과 WSL 사용 안내만 출력하고 중단한다.

## 회귀 검증

```sh
python3 -m unittest discover -s tests -p 'test_toss_secrets.py'
```

(Windows에서 `python3`이 없으면 `python`을 쓴다.) gcloud 실행 경로 해석(플랫폼·PATH·환경 주입)과 가짜 runner로 키가 인수에 포함되지 않고 표준입력에만 전달되는지, 개인 프로젝트 명시, 제공자 오류 비노출, 입력 전체 검증 후 변경, 기존 ENABLED 키 교체 차단, 개인 설정 검사, 비대화형 입력 차단을 확인한다. 테스트는 실제 키·클라우드를 사용하지 않는다. Python 메모리의 즉시 삭제/제로화까지 보장하지는 않으므로 신뢰할 수 있는 본인 터미널에서 실행한다.

## 연결 운영 도구

토스 키 저장과 새 `toss-setup.ts` 엔트리포인트를 포함한 CI/CD 배포가 끝난 뒤 운영 담당자가 아래 순서로 실행한다. `--execute`가 없으면 읽기 전용 사전 확인만 한다.

```sh
node scripts/connect-toss.mjs
node scripts/connect-toss.mjs --execute
```

도구는 개인 배포 설정과 동일 프로젝트의 `.local/owner-access.json`에서 소유자 ID만 사용하며 비밀번호나 ID를 출력하지 않는다. 토스 키 값은 읽지 않고 활성 버전 메타데이터만 확인한다. 소유자 비밀이 없으면 ID를 표준입력으로 저장하고, 기존 값이 다른 소유자를 가리키면 중단한다. 소유자 기존 값 확인도 메모리에서만 처리한다. 실행 시점의 최신 서비스 revision이 준비 상태이며 이미지가 개인 프로젝트 Artifact Registry의 SHA256 digest로 고정되었는지 확인한다.

별도 최소 권한 서비스 계정 `investing-setup`으로 일회성 Cloud Run Job을 실행한다. 작업에는 키 두 개의 고정 버전만 주입하며 기존 VPC/NAT의 고정 IP로 계좌 목록을 조회한다. 작업의 재시도는 0회이고 태스크는 1개, 제한 시간은 60초다. 결과 계좌 식별값은 작업 내부에서 Secret Manager로 저장하며 로컬로 가져오지 않는다. 작업이 실패하면 서비스의 비밀 연결을 변경하지 않고, 허용 IP 등록 여부를 먼저 확인하라는 안내를 출력한다. 출력 원문에는 민감한 정보가 있을 수 있으므로 제공자 오류나 Cloud Run 전체 로그를 채팅에 붙이지 않는다. 정제된 작업 오류 코드로 원인을 확인한다.

작업 성공 후에만 토스 키·계좌 식별값·소유자 ID 네 비밀의 활성 숫자 버전을 서비스에 연결한다. `--update-secrets`를 사용해 기존 다른 환경 설정을 유지한다. gcloud 표준출력/오류는 내부 캡처하며 출력하지 않는다. 모든 호출은 개인 계정·프로젝트·결제 프로젝트를 명시한다. 연결 성공 메시지는 실제 자산 검증 완료를 뜻하지 않으므로 로그인 후 실제 조회와 소유권 차단 검증을 별도로 수행한다.

### 이미지에 `toss-setup.ts`가 있는지는 사전 확인하지 않는다

사전 확인은 서비스 revision과 이미지 digest 형식만 확인한다. 이미지 안의 파일을 읽기 전용으로 확인하는 gcloud 명령은 없다. 확인하려면 이미지를 내려받아 실행하거나 Cloud Run Job을 실행해야 하는데, 사전 확인에서 작업을 실행하면 "읽기 전용" 약속이 깨진다. 대신 CI `container` 작업(`.github/workflows/ci.yml`)이 빌드한 모든 이미지에서 `/app/src/server/toss-setup.ts`가 들어 있는지 검사하고, 배포 워크플로는 CI가 성공한 main의 커밋만 배포한다. 따라서 digest로 고정된 이미지는 이 파일을 포함한다. 파일이 빠진 경우에도 4단계의 일회성 작업이 실패하고 서비스의 비밀 연결은 바뀌지 않는다.
