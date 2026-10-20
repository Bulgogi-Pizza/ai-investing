#!/usr/bin/env python3
"""Interactive secret intake; plaintext stays in memory and gcloud stdin only."""
import getpass
import ipaddress
import json
import subprocess  # noqa: F401  (tests patch subprocess.run through this module)
import sys
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import secret_intake  # noqa: E402
from secret_intake import SetupError, gcloud, read_identity, resolve_gcloud  # noqa: E402,F401

ROOT = Path(__file__).resolve().parent.parent
SECRET_NAMES = ("investing-toss-client-id", "investing-toss-client-secret")
EGRESS_ADDRESS = "investing-egress"
REGION = "asia-northeast3"
NEXT_STEP = "[3/5] 연결 코드가 main에 배포된 상태에서 사전 확인을 실행하세요: node scripts/connect-toss.mjs"


def run_gcloud_process(argv, **kwargs):
    # Resolve through this module so the shared runner starts gcloud the same way for every script.
    return secret_intake.run_gcloud_process(argv, resolve=resolve_gcloud, **kwargs)


def validate_value(value):
    if not value.strip() or len(value.encode("utf-8")) > 8192 or any(c in value for c in "\r\n\0"):
        raise SetupError("키는 비어 있지 않은 단일 행 값이어야 하며 8,192바이트 이하여야 합니다.")
    return value


def check_targets(config, *, runner=run_gcloud_process):
    raw = gcloud(config, ["secrets", "list", "--format=json(name)"], runner=runner)
    try:
        existing = {item["name"].rsplit("/", 1)[-1] for item in json.loads(raw)}
    except (ValueError, TypeError, KeyError, AttributeError):
        raise SetupError("Secret Manager 목록 응답을 확인할 수 없습니다.") from None
    for name in SECRET_NAMES:
        if name in existing:
            enabled = gcloud(config, ["secrets", "versions", "list", name,
                                      "--filter=state=ENABLED", "--limit=1",
                                      "--format=value(name)"], runner=runner)
            if enabled.strip():
                raise SetupError(f"이미 사용 가능한 토스 키가 저장되어 있습니다. 키를 다시 입력하지 마세요.\n{NEXT_STEP}")
    return existing


def allowlist_ip(config, *, runner=run_gcloud_process):
    raw = gcloud(config, ["compute", "addresses", "describe", EGRESS_ADDRESS,
                          f"--region={REGION}", "--format=value(address)"], runner=runner)
    try:
        return str(ipaddress.IPv4Address(raw.decode("utf-8").strip()))
    except (UnicodeDecodeError, ValueError):
        raise SetupError("고정 출구 IP를 확인할 수 없습니다. Terraform 인프라 적용 상태를 확인하세요.") from None


def upload(config, values, *, runner=run_gcloud_process, progress=print):
    if len(values) != len(SECRET_NAMES):
        raise SetupError("키 두 개가 모두 필요합니다.")
    values = tuple(validate_value(value) for value in values)
    existing = check_targets(config, runner=runner)
    for name, value in zip(SECRET_NAMES, values):
        if name not in existing:
            gcloud(config, ["secrets", "create", name, "--replication-policy=automatic"], runner=runner)
        gcloud(config, ["secrets", "versions", "add", name, "--data-file=-"], value=value, runner=runner)
        progress(f"저장 완료: {name}")


def main():
    try:
        if not sys.stdin.isatty() or not sys.stderr.isatty():
            raise SetupError("본인 터미널에서 직접 실행하세요. 리다이렉션·파이프 입력은 허용하지 않습니다.")
        config = read_identity()
        check_targets(config)
        ip = allowlist_ip(config)
        print("토스 Open API 연결 안내 (1~2단계: 이 스크립트, 3~5단계: connect-toss.mjs)")
        print("\n[1/5] 토스 Open API 키 발급과 허용 IP 등록")
        print("  토스증권 WTS 설정 > Open API에서 키를 발급하고, 허용 IP 관리에 아래 주소를 등록하세요.")
        print(f"  허용 IP: {ip}")
        input("  등록을 마쳤으면 Enter를 누르세요. 중단하려면 Ctrl+C를 누르세요.")
        print("\n[2/5] 키 저장")
        print("  발급한 키 두 개를 숨김 입력으로 받아 개인 프로젝트 Secret Manager에 저장합니다.")
        print("  입력한 값은 화면·명령행·로컬 파일에 기록하지 않습니다.")
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            values = tuple(validate_value(getpass.getpass(prompt)) for prompt in (
                "TOSS_CLIENT_ID (숨김 입력): ", "TOSS_CLIENT_SECRET (숨김 입력): ",
            ))
        upload(config, values)
        print(f"\n키 저장을 마쳤습니다. 다음 단계:\n{NEXT_STEP}")
        return 0
    except (KeyboardInterrupt, EOFError, getpass.GetPassWarning):
        print("\n안전한 입력이 중단되었습니다. 값은 출력하지 않습니다.", file=sys.stderr)
        return 1
    except SetupError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
