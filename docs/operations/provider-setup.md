# 외부 키·텔레그램 봇 준비

DART·FRED·ECOS 키, 텔레그램 봇 토큰·chat ID, SEC 연락처를 개인 프로젝트 Secret Manager에 저장하는 절차다. 값은 채팅, 명령행 인수, 셸 히스토리, `.env`, GitHub에 붙여 넣지 않는다. 토스 키는 [토스 키 입력 및 계좌 연결](toss-setup.md)을 따른다.

| Secret Manager 이름            | 환경변수             | 용도                                  |
| ------------------------------ | -------------------- | ------------------------------------- |
| `investing-dart-api-key`       | `DART_API_KEY`       | 국내 재무제표·공시                    |
| `investing-fred-api-key`       | `FRED_API_KEY`       | 미국 경제지표                         |
| `investing-ecos-api-key`       | `ECOS_API_KEY`       | 한국은행 경제지표                     |
| `investing-telegram-bot-token` | `TELEGRAM_BOT_TOKEN` | 텔레그램 알림 발송                    |
| `investing-telegram-chat-id`   | `TELEGRAM_CHAT_ID`   | 알림을 받을 본인 chat                 |
| `investing-sec-user-agent`     | `SEC_USER_AGENT`     | SEC EDGAR 요청 식별(연락 이메일 포함) |

`SEC_USER_AGENT`는 키는 아니지만 사용자 이메일이 들어가므로 공개 저장소와 CI 로그에 남지 않도록 비밀로 둔다. 예: `이름 contact@example.com`. SEC EDGAR는 키 없이 User-Agent에 연락처를 요구한다.

## 키 발급

각 공식 포털에서 사용자가 직접 발급한다. 화면 구성은 바뀔 수 있으므로 포털의 안내를 따른다.

- DART: 금융감독원 전자공시 DART의 OpenDART 개발자센터(`opendart.fss.or.kr`)에서 회원가입 후 인증키를 신청한다.
- FRED: 세인트루이스 연준 FRED(`fred.stlouisfed.org`)에서 계정을 만들고 API 키를 요청한다.
- ECOS: 한국은행 경제통계시스템(`ecos.bok.or.kr`)의 Open API 서비스에서 인증키를 신청한다.
- 텔레그램: 텔레그램에서 공식 `@BotFather`와 대화해 `/newbot`으로 개인 봇을 만들고 봇 토큰을 받는다. 토큰은 봇을 제어하는 비밀번호와 같다.

### 텔레그램 chat ID 확인

1. 만든 봇을 검색해 대화를 열고 아무 메시지(예: `/start`)를 한 번 보낸다.
2. 본인 터미널에서 `getUpdates`를 한 번 호출해 응답의 `message.chat.id`를 확인한다. 토큰은 숨김 입력으로 변수에 받고, 채팅에는 붙여 넣지 않는다.

```sh
# bash (macOS/Linux/WSL)
read -rs BOT_TOKEN; curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates"; unset BOT_TOKEN
```

```powershell
# Windows PowerShell
$s = Read-Host -AsSecureString "token"; $t = [Net.NetworkCredential]::new('', $s).Password
(Invoke-RestMethod "https://api.telegram.org/bot$t/getUpdates").result | ForEach-Object { $_.message.chat.id }; Remove-Variable t, s
```

개인 대화의 chat ID는 양의 정수다. 응답이 비어 있으면 봇에 메시지를 다시 보낸 뒤 호출한다. chat ID도 계정 식별값이므로 채팅·로그·문서에 적지 않는다.

## 저장 순서

1. 운영 담당자가 `infra/gcp/providers.tf`를 개인 계정·프로젝트를 명시해 `plan`으로 확인한 뒤 적용한다. 비밀 6개(값 없음)와 비밀별 런타임 `secretAccessor` 6개가 추가되어야 하고 기존 리소스의 교체·삭제가 없어야 한다. 스크립트는 비밀을 직접 만들지 않으므로 적용 전에는 저장이 거절된다.
2. 발급된 키부터 본인 터미널에서 실행한다. 항목은 나눠서 여러 번 실행해도 된다.

```sh
python scripts/provider-secrets.py dart fred ecos
python scripts/provider-secrets.py telegram sec
```

항목 별칭은 `dart`, `fred`, `ecos`, `telegram`(봇 토큰+chat ID), `telegram-token`, `telegram-chat`, `sec`다. 값은 `DART_API_KEY (숨김 입력)`처럼 환경변수 이름으로 물어 숨김 입력으로 받는다. 비밀 이름은 코드에 고정되어 있고 입력으로 받지 않는다. 비대화형 입력·파이프는 거절한다.

3. 서비스에 연결한다. 저장과 함께 하려면 `--attach`를 붙이고, 나중에 하려면 같은 항목으로 `--attach-only`를 쓴다. 두 경우 모두 가장 최근 활성 버전의 숫자 번호를 `ai-investing` 서비스(asia-northeast3)에 `--update-secrets`로 연결하고 다른 설정은 바꾸지 않는다. `latest`는 연결하지 않는다.

```sh
python scripts/provider-secrets.py dart fred ecos --attach
python scripts/provider-secrets.py telegram sec --attach-only
```

이 값을 읽는 코드는 이후 단계(4 일일 데이터 적재, 6 알림)에서 들어온다. 그전에 연결해도 서비스 동작은 바뀌지 않는다. 작업(Cloud Run Job)용 서비스 계정의 권한은 4단계에서 비밀 단위로 추가한다.

## 안전 동작

- 모든 입력을 형식 검사한 뒤에만 클라우드를 변경한다. 오류 메시지에 입력값을 싣지 않는다.
  - DART: 영문·숫자 40자(OpenDART 개발 가이드의 `crtfc_key` 설명). 서버 어댑터도 같은 형식이 아니면 DART 연결을 끈다.
  - FRED·ECOS: 영문·숫자·`-`·`_` 16~128자(공급자의 정확한 형식은 추측하지 않고 느슨하게만 검사한다).
  - 텔레그램 봇 토큰: `^\d{3,20}:[A-Za-z0-9_-]{20,128}$`. chat ID: `^-?\d{1,19}$`.
  - SEC User-Agent: 출력 가능한 ASCII 한 줄, 200자 이하, 이메일 형태의 연락처 포함.
- 이미 ENABLED 버전이 있으면 `--rotate` 없이는 저장하지 않는다. `--rotate`는 새 버전을 추가할 뿐 이전 버전을 끄지 않는다. 서비스에 새 버전을 연결한 뒤 이전 버전은 운영 담당자가 `gcloud secrets versions disable`로 끈다.
- 모든 gcloud 호출에 개인 `--account`, `--project`, `--billing-project`를 전달하고 `.local/deployment.json`, `.local/deployment-account.md`를 검사한다. 값은 gcloud 표준입력으로만 전달한다.
- Windows에서는 [토스 문서](toss-setup.md)의 Windows 실행과 같은 방식으로 gcloud를 셸 없이 실행한다.

## 회귀 검증

```sh
python3 -m unittest discover -s tests -p 'test_provider_secrets.py'
```

가짜 runner로 값이 인수에 들어가지 않고 표준입력에만 전달되는지, 고정 이름만 쓰는지, 알 수 없는 별칭 거절, 항목별 형식 검사, `--rotate` 없는 교체 거절, `--attach`의 숫자 버전 인수, 개인 설정 검사, 비대화형 거절을 확인한다. 실제 키와 클라우드는 쓰지 않는다.
