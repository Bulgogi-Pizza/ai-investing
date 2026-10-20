#!/usr/bin/env python3
"""Provider key intake (DART, FRED, ECOS, Telegram, SEC contact); plaintext stays in memory and gcloud stdin only.

Usage: python scripts/provider-secrets.py <alias>... [--rotate | --attach | --attach-only]
Secret names, environment names and aliases are fixed below and never come from operator input.
"""
import argparse
import getpass
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import secret_intake  # noqa: E402
from secret_intake import SetupError, gcloud, prompt_hidden, read_identity, require_interactive  # noqa: E402

SERVICE = "ai-investing"
REGION = "asia-northeast3"

API_KEY = re.compile(r"[A-Za-z0-9_-]{16,128}")
TELEGRAM_TOKEN = re.compile(r"[0-9]{3,20}:[A-Za-z0-9_-]{20,128}")
TELEGRAM_CHAT = re.compile(r"-?[0-9]{1,19}")
CONTACT_EMAIL = re.compile(r"[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+")


def _api_key(value):
    return API_KEY.fullmatch(value) is not None


def _telegram_token(value):
    return TELEGRAM_TOKEN.fullmatch(value) is not None


def _telegram_chat(value):
    return TELEGRAM_CHAT.fullmatch(value) is not None


def _sec_user_agent(value):
    return (
        len(value) <= 200
        and all(0x20 <= ord(c) <= 0x7E for c in value)
        and CONTACT_EMAIL.search(value) is not None
    )


# Secret Manager name -> (environment variable, validator, operator hint). Order is the prompt order.
SECRETS = {
    "investing-dart-api-key": ("DART_API_KEY", _api_key, "영문·숫자·-·_ 16~128자"),
    "investing-fred-api-key": ("FRED_API_KEY", _api_key, "영문·숫자·-·_ 16~128자"),
    "investing-ecos-api-key": ("ECOS_API_KEY", _api_key, "영문·숫자·-·_ 16~128자"),
    "investing-telegram-bot-token": ("TELEGRAM_BOT_TOKEN", _telegram_token, "<숫자>:<영문·숫자·-·_ 20~128자>"),
    "investing-telegram-chat-id": ("TELEGRAM_CHAT_ID", _telegram_chat, "정수(그룹은 음수 가능)"),
    "investing-sec-user-agent": ("SEC_USER_AGENT", _sec_user_agent, "연락 이메일을 포함한 한 줄, 200자 이하"),
}
ALIASES = {
    "dart": ("investing-dart-api-key",),
    "fred": ("investing-fred-api-key",),
    "ecos": ("investing-ecos-api-key",),
    "telegram": ("investing-telegram-bot-token", "investing-telegram-chat-id"),
    "telegram-token": ("investing-telegram-bot-token",),
    "telegram-chat": ("investing-telegram-chat-id",),
    "sec": ("investing-sec-user-agent",),
}
ATTACH_FAILURE = "Cloud Run 서비스 비밀 연결에 실패했습니다. 개인 계정 권한과 서비스 상태를 확인하세요."


def resolve_aliases(aliases):
    """Map operator aliases to fixed secret names in canonical order. Never echoes the input."""
    if not aliases:
        raise SetupError(f"입력할 항목을 지정하세요. 사용 가능: {', '.join(ALIASES)}")
    wanted = set()
    for alias in aliases:
        if alias not in ALIASES:
            raise SetupError(f"알 수 없는 항목입니다. 사용 가능: {', '.join(ALIASES)}")
        wanted.update(ALIASES[alias])
    return tuple(name for name in SECRETS if name in wanted)


def validate(name, value):
    if name not in SECRETS:
        raise SetupError("지원하지 않는 비밀 이름입니다.")
    env, check, hint = SECRETS[name]
    value = value.strip()
    if not value or not check(value):
        raise SetupError(f"{env} 형식이 올바르지 않습니다. 기대 형식: {hint}. 값은 출력하지 않습니다.")
    return value


def _names(config, runner):
    raw = gcloud(config, ["secrets", "list", "--format=json(name)"], runner=runner)
    try:
        return {item["name"].rsplit("/", 1)[-1] for item in json.loads(raw)}
    except (ValueError, TypeError, KeyError, AttributeError):
        raise SetupError("Secret Manager 목록 응답을 확인할 수 없습니다.") from None


def _enabled_versions(config, name, runner, *, newest):
    order = ["--sort-by=~createTime"] if newest else []
    args = ["secrets", "versions", "list", name, "--filter=state=ENABLED", *order, "--limit=1", "--format=value(name)"]
    return gcloud(config, args, runner=runner).decode("utf-8", "replace").strip()


def latest_version(config, name, runner=secret_intake.run_gcloud_process):
    """Newest ENABLED version as a numeric string; never `latest`."""
    response = _enabled_versions(config, name, runner, newest=True)
    version = response.rsplit("/", 1)[-1]
    if not re.fullmatch(r"[0-9]+", version):
        raise SetupError(f"{name}의 활성 비밀 버전을 찾지 못했습니다. 저장 상태를 확인하세요.")
    return version


def check_targets(config, names, *, rotate=False, runner=secret_intake.run_gcloud_process):
    existing = _names(config, runner)
    missing = [name for name in names if name not in existing]
    if missing:
        raise SetupError(
            "Terraform으로 아직 만들지 않은 비밀이 있습니다: " + ", ".join(missing)
            + "\ninfra/gcp/providers.tf 적용을 먼저 요청하세요."
        )
    if not rotate:
        stored = [name for name in names if _enabled_versions(config, name, runner, newest=False)]
        if stored:
            raise SetupError(
                "이미 사용 가능한 버전이 있어 교체하지 않습니다: " + ", ".join(stored)
                + "\n키를 바꾸려면 --rotate를 지정하세요. 서비스에 연결만 하려면 --attach-only를 쓰세요."
            )
    return existing


def store(config, names, values, *, rotate=False, runner=secret_intake.run_gcloud_process, progress=print):
    """Validate everything, re-check targets, then add one new version per name. Returns {name: version}."""
    if len(values) != len(names):
        raise SetupError("입력 값 개수가 항목 수와 다릅니다.")
    values = [validate(name, value) for name, value in zip(names, values)]
    check_targets(config, names, rotate=rotate, runner=runner)
    versions = {}
    for name, value in zip(names, values):
        gcloud(config, ["secrets", "versions", "add", name, "--data-file=-"], value=value, runner=runner)
        versions[name] = latest_version(config, name, runner)
        progress(f"저장 완료: {name} (버전 {versions[name]})")
    return versions


def attach(config, versions, *, runner=secret_intake.run_gcloud_process, progress=print):
    """Attach exact numeric versions to the Cloud Run service, keeping every other setting."""
    if not versions:
        raise SetupError("연결할 비밀이 없습니다.")
    pairs = []
    for name in SECRETS:
        if name in versions:
            if not re.fullmatch(r"[0-9]+", versions[name]):
                raise SetupError("비밀 버전은 숫자여야 합니다. latest는 연결하지 않습니다.")
            pairs.append(f"{SECRETS[name][0]}={name}:{versions[name]}")
    gcloud(
        config,
        ["run", "services", "update", SERVICE, f"--region={REGION}", "--update-secrets=" + ",".join(pairs)],
        runner=runner,
        failure=ATTACH_FAILURE,
    )
    progress(f"서비스 {SERVICE}에 연결 완료: " + ", ".join(pairs))


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse echoes offending arguments, which could be a pasted key. Keep the message static.
        raise SetupError("사용법: python scripts/provider-secrets.py <항목>... [--rotate | --attach | --attach-only]\n"
                         f"항목: {', '.join(ALIASES)}")


def parse_args(argv):
    parser = _Parser(add_help=False, allow_abbrev=False)
    parser.add_argument("aliases", nargs="*")
    parser.add_argument("--rotate", action="store_true")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--attach", action="store_true")
    group.add_argument("--attach-only", action="store_true")
    args = parser.parse_args(argv)
    if args.rotate and args.attach_only:
        parser.error("")
    return args


def main(argv=None, *, runner=secret_intake.run_gcloud_process):
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
        names = resolve_aliases(args.aliases)
        if args.attach_only:
            config = read_identity()
            versions = {name: latest_version(config, name, runner) for name in names}
            attach(config, versions, runner=runner)
            return 0
        require_interactive()
        config = read_identity()
        check_targets(config, names, rotate=args.rotate, runner=runner)
        print("외부 연동 키 저장: 입력한 값은 화면·명령행·로컬 파일에 기록하지 않습니다.")
        values = [prompt_hidden(f"{SECRETS[name][0]} (숨김 입력): ") for name in names]
        # Validate everything before any change so a typo in the last prompt cannot leave a partial write.
        values = [validate(name, value) for name, value in zip(names, values)]
        versions = store(config, names, values, rotate=args.rotate, runner=runner)
        if args.attach:
            attach(config, versions, runner=runner)
        else:
            print("서비스에 연결하려면 같은 항목으로 --attach-only를 실행하세요.")
        return 0
    except (KeyboardInterrupt, EOFError, getpass.GetPassWarning):
        print("\n안전한 입력이 중단되었습니다. 값은 출력하지 않습니다.", file=sys.stderr)
        return 1
    except SetupError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
