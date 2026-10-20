#!/usr/bin/env python3
"""Interactive secret intake; plaintext stays in memory and gcloud stdin only."""
import getpass
import ipaddress
import json
import ntpath
import os
import re
import subprocess
import sys
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SECRET_NAMES = ("investing-toss-client-id", "investing-toss-client-secret")
EGRESS_ADDRESS = "investing-egress"
REGION = "asia-northeast3"
NEXT_STEP = "[3/5] 연결 코드가 main에 배포된 상태에서 사전 확인을 실행하세요: node scripts/connect-toss.mjs"


class SetupError(Exception):
    """A safe, credential-free error for the operator."""


WINDOWS_HINT = "WSL, macOS 또는 Linux에서 실행하거나 Google Cloud SDK 설치를 확인하세요."


def _env_value(environ, name):
    # Windows environment variable names are case-insensitive.
    for key, value in environ.items():
        if key.upper() == name.upper() and isinstance(value, str) and value != "":
            return value
    return None


def resolve_gcloud(platform=sys.platform, environ=os.environ, is_file=os.path.isfile):
    """Return (argv prefix, env or None) that starts gcloud without a shell.

    macOS/Linux run `gcloud` directly. On Windows the entry point is gcloud.cmd, which cannot be
    started without a shell, so run the SDK's Python entry point the way gcloud.cmd does:
    `<python> [-S] <sdk>/lib/gcloud.py`. Error messages never contain paths, env values or args.
    """
    if platform != "win32":
        return ["gcloud"], None
    cmd_path = None
    for raw in (_env_value(environ, "PATH") or "").split(";"):
        directory = raw.strip().strip('"')
        # Relative entries (for example ".") would let a planted gcloud.cmd choose the interpreter.
        if directory and ntpath.isabs(directory) and is_file(ntpath.join(directory, "gcloud.cmd")):
            cmd_path = ntpath.join(directory, "gcloud.cmd")
            break
    if cmd_path is None:
        raise SetupError(f"PATH에서 gcloud.cmd를 찾지 못했습니다. Google Cloud SDK를 설치하고 PATH에 추가하세요. {WINDOWS_HINT}")
    bin_dir = ntpath.dirname(cmd_path)
    root = next((d for d in (ntpath.dirname(bin_dir), bin_dir) if is_file(ntpath.join(d, "lib", "gcloud.py"))), None)
    if root is None:
        raise SetupError(f"Google Cloud SDK의 lib/gcloud.py를 찾지 못했습니다. SDK 설치 상태를 확인하세요. {WINDOWS_HINT}")
    python = _env_value(environ, "CLOUDSDK_PYTHON")
    if python:
        if python.lower().endswith((".cmd", ".bat")):
            raise SetupError(f"CLOUDSDK_PYTHON은 python.exe 같은 실행 파일이어야 합니다(.cmd/.bat 불가). {WINDOWS_HINT}")
        # A bare name such as "python" is resolved through PATH by the OS, like gcloud.cmd does.
        if ntpath.isabs(python) and not is_file(python):
            raise SetupError(f"gcloud용 Python을 찾지 못했습니다. SDK 번들 Python을 복구하거나 CLOUDSDK_PYTHON에 python.exe 경로를 지정하세요. {WINDOWS_HINT}")
    else:
        python = ntpath.join(root, "platform", "bundledpython", "python.exe")
        if not is_file(python):
            raise SetupError(f"gcloud용 Python을 찾지 못했습니다. SDK 번들 Python을 복구하거나 CLOUDSDK_PYTHON에 python.exe 경로를 지정하세요. {WINDOWS_HINT}")
    # gcloud.cmd passes -S (no site-packages) unless site packages were requested or a venv is active.
    site_packages = _env_value(environ, "CLOUDSDK_PYTHON_SITEPACKAGES") is not None or _env_value(environ, "VIRTUAL_ENV") is not None
    encoding = _env_value(environ, "CLOUDSDK_ENCODING")
    replaced = {"CLOUDSDK_PYTHON", "PYTHONHOME"} | ({"PYTHONIOENCODING"} if encoding else set())
    child_env = {k: v for k, v in environ.items() if k.upper() not in replaced}
    child_env["CLOUDSDK_PYTHON"] = python
    if encoding:
        child_env["PYTHONIOENCODING"] = encoding
    return [python, *([] if site_packages else ["-S"]), ntpath.join(root, "lib", "gcloud.py")], child_env


def run_gcloud_process(argv, **kwargs):
    """Default runner: argv[0] is the logical name "gcloud"; resolve how to start it on this OS."""
    prefix, env = resolve_gcloud()
    if env is not None:
        kwargs["env"] = env
    return subprocess.run([*prefix, *argv[1:]], **kwargs)


def read_identity(root=ROOT):
    if not (root / ".local/deployment-account.md").is_file():
        raise SetupError("개인 배포 계정 지침 파일(.local/deployment-account.md)이 없습니다. AGENTS.md의 Deployment identity boundary를 먼저 따르세요.")
    try:
        config = json.loads((root / ".local/deployment.json").read_text())
    except (OSError, ValueError):
        raise SetupError("개인 배포 설정을 읽을 수 없습니다.") from None
    if (
        not isinstance(config, dict)
        or config.get("personalOnly") is not True
        or not isinstance(config.get("account"), str)
        or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", config["account"])
        or not isinstance(config.get("project"), str)
        or not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", config["project"])
    ):
        raise SetupError("개인 배포 계정과 프로젝트 설정을 확인하세요.")
    return config


def validate_value(value):
    if not value.strip() or len(value.encode("utf-8")) > 8192 or any(c in value for c in "\r\n\0"):
        raise SetupError("키는 비어 있지 않은 단일 행 값이어야 하며 8,192바이트 이하여야 합니다.")
    return value


def gcloud(config, args, *, value=None, runner=run_gcloud_process):
    argv = [
        "gcloud", *args,
        f"--account={config['account']}",
        f"--project={config['project']}",
        f"--billing-project={config['project']}",
        "--quiet",
    ]
    try:
        result = runner(
            argv,
            input=None if value is None else value.encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        raise SetupError("gcloud 실행에 실패했습니다. 개인 계정 로그인과 네트워크를 확인하세요.") from None
    if result.returncode != 0:
        # Provider errors may echo request data. Never forward stderr or exception details.
        raise SetupError("Secret Manager 작업에 실패했습니다. 개인 계정 권한/API 설정을 확인하세요.")
    return result.stdout


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
