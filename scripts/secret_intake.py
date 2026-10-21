"""Shared intake helpers for operator scripts. Plaintext stays in memory and gcloud stdin only."""
import getpass
import json
import ntpath
import os
import re
import subprocess
import sys
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FAILURE = "Secret Manager 작업에 실패했습니다. 개인 계정 권한/API 설정을 확인하세요."


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


def run_gcloud_process(argv, *, resolve=None, **kwargs):
    """Default runner: argv[0] is the logical name "gcloud"; resolve how to start it on this OS."""
    prefix, env = (resolve or resolve_gcloud)()
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


def gcloud(config, args, *, value=None, runner=run_gcloud_process, failure=DEFAULT_FAILURE, timeout=60, on_timeout=None):
    """Run gcloud with fixed identity flags. `on_timeout` is an exception to raise instead of the
    generic failure when the call exceeds `timeout` (the operation may still have succeeded)."""
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
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        if on_timeout is not None:
            raise on_timeout from None
        raise SetupError("gcloud 실행에 실패했습니다. 개인 계정 로그인과 네트워크를 확인하세요.") from None
    except (OSError, subprocess.SubprocessError):
        raise SetupError("gcloud 실행에 실패했습니다. 개인 계정 로그인과 네트워크를 확인하세요.") from None
    if result.returncode != 0:
        # Provider errors may echo request data. Never forward stderr or exception details.
        raise SetupError(failure)
    return result.stdout


def require_interactive():
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        raise SetupError("본인 터미널에서 직접 실행하세요. 리다이렉션·파이프 입력은 허용하지 않습니다.")


def prompt_hidden(prompt):
    """Hidden terminal input; refuses to fall back to echoed input."""
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        return getpass.getpass(prompt)
