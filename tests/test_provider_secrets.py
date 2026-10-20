"""Credential-free tests: python3 -m unittest discover -s tests -p 'test_provider_secrets.py'."""
import importlib.util
import io
import json
import subprocess
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("provider_secrets", Path(__file__).resolve().parents[1] / "scripts/provider-secrets.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
CONFIG = {"personalOnly": True, "account": "operator@example.test", "project": "personal-test-123"}
ALL_NAMES = tuple(module.SECRETS)
SAMPLES = {
    "investing-dart-api-key": "0123456789abcdef0123456789abcdef01234567",
    "investing-fred-api-key": "fred0123456789abcdef0123456789ab",
    "investing-ecos-api-key": "ECOS0123456789ABCDEF",
    "investing-telegram-bot-token": "123456789:EXAMPLE-token_0123456789abcdefghij",
    "investing-telegram-chat-id": "-1001234567890",
    "investing-sec-user-agent": "Example Research owner@example.test",
}


class FakeCloud:
    """Records every gcloud call and simulates the Secret Manager/Cloud Run state."""

    def __init__(self, secrets=None, enabled=None, fail=None):
        self.secrets = set(ALL_NAMES if secrets is None else secrets)
        self.enabled = dict(enabled or {})  # name -> newest ENABLED numeric version
        self.fail = fail  # substring of a command that should fail
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        text = " ".join(argv)
        if self.fail and self.fail in text:
            return subprocess.CompletedProcess(argv, 1, b"", b"provider echoed " + b"example-secret-value")
        if argv[1:3] == ["secrets", "list"]:
            out = json.dumps([{"name": f"projects/123/secrets/{n}"} for n in sorted(self.secrets)]).encode()
        elif argv[1:4] == ["secrets", "versions", "list"]:
            version = self.enabled.get(argv[4])
            out = f"projects/123/secrets/{argv[4]}/versions/{version}\n".encode() if version else b""
        elif argv[1:4] == ["secrets", "versions", "add"]:
            self.enabled[argv[4]] = self.enabled.get(argv[4], 0) + 1
            out = b""
        else:
            out = b""
        return subprocess.CompletedProcess(argv, 0, out, b"")

    def writes(self):
        return [argv for argv, _ in self.calls if argv[1:4] == ["secrets", "versions", "add"]]


class ValidationTests(unittest.TestCase):
    def test_valid_samples_pass_and_are_returned_trimmed(self):
        for name, value in SAMPLES.items():
            self.assertEqual(module.validate(name, f"  {value}\t"), value)

    def test_each_secret_rejects_malformed_values_without_echoing(self):
        bad = {
            "investing-dart-api-key": ["", "short", "has space in key 0123456789", "a" * 39, "a" * 41, "a" * 39 + "-", "key\nwith-newline0123456789", "키" * 20],
            "investing-fred-api-key": ["", "x" * 15, "semi;colon0123456789abcd"],
            "investing-ecos-api-key": ["", "y" * 15, "slash/0123456789abcdef"],
            "investing-telegram-bot-token": ["", "no-colon-token", "12:" + "a" * 20, "123456789:" + "a" * 19, "123456789:" + "a" * 129,
                                              "١٢٣٤٥٦٧٨٩:" + "a" * 20, "123456789:abc def0123456789abcdefg", "123456789:" + "a" * 10 + chr(10) + "a" * 10],
            "investing-telegram-chat-id": ["", "abc", "--5", "1" * 20, "12.5", "٣٣٣", "+123"],
            "investing-sec-user-agent": ["", "no contact info", "x@y", "bot@example", "a" * 190 + " me@example.test", "Mozilla\nme@example.test",
                                         "Agent me@example.test\x00", "Agent 한글 me@example.test"],
        }
        for name, values in bad.items():
            for value in values:
                with self.assertRaises(module.SetupError, msg=f"{name}: {value!r}") as caught:
                    module.validate(name, value)
                self.assertNotIn(value.strip() or "\0", str(caught.exception))

    def test_telegram_formats_match_the_documented_patterns(self):
        self.assertIsNotNone(module.TELEGRAM_TOKEN.fullmatch("123456789:" + "A" * 35))
        self.assertIsNotNone(module.TELEGRAM_CHAT.fullmatch("-1" + "0" * 18))
        self.assertIsNone(module.TELEGRAM_CHAT.fullmatch("-"))

    def test_sec_user_agent_boundaries(self):
        name = "investing-sec-user-agent"
        value = "x" * (200 - len(" me@example.test")) + " me@example.test"
        self.assertEqual(len(value), 200)
        self.assertEqual(module.validate(name, value), value)
        with self.assertRaises(module.SetupError):
            module.validate(name, "x" + value)

    def test_unknown_secret_names_are_refused(self):
        with self.assertRaises(module.SetupError):
            module.validate("investing-other-key", "anything-valid-0123456789")


class AliasTests(unittest.TestCase):
    def test_aliases_map_to_fixed_names_in_canonical_order_without_duplicates(self):
        self.assertEqual(module.resolve_aliases(["telegram", "dart"]),
                         ("investing-dart-api-key", "investing-telegram-bot-token", "investing-telegram-chat-id"))
        self.assertEqual(module.resolve_aliases(["dart", "dart", "telegram-token", "telegram"]),
                         ("investing-dart-api-key", "investing-telegram-bot-token", "investing-telegram-chat-id"))
        self.assertEqual(set(module.resolve_aliases(list(module.ALIASES))), set(ALL_NAMES))
        self.assertEqual({name: module.SECRETS[name][0] for name in ALL_NAMES}, {
            "investing-dart-api-key": "DART_API_KEY",
            "investing-fred-api-key": "FRED_API_KEY",
            "investing-ecos-api-key": "ECOS_API_KEY",
            "investing-telegram-bot-token": "TELEGRAM_BOT_TOKEN",
            "investing-telegram-chat-id": "TELEGRAM_CHAT_ID",
            "investing-sec-user-agent": "SEC_USER_AGENT",
        })

    def test_unknown_or_missing_alias_is_rejected_without_echo(self):
        pasted = "pasted-secret-value-0123456789"
        for aliases in (["dart", pasted], ["investing-dart-api-key"], []):
            with self.assertRaises(module.SetupError) as caught:
                module.resolve_aliases(aliases)
            self.assertNotIn(pasted, str(caught.exception))

    def test_unknown_flags_and_stray_values_never_reach_output_or_cloud(self):
        pasted = "pasted-secret-value-0123456789"
        for argv in (["dart", pasted], ["--token=" + pasted, "dart"], ["dart", "--rotate", "--attach-only"], ["dart", "--attach", "--attach-only"]):
            stderr = io.StringIO()
            with redirect_stderr(stderr), patch.object(module.secret_intake, "run_gcloud_process", side_effect=AssertionError("No cloud")):
                self.assertEqual(module.main(argv), 1)
            self.assertNotIn(pasted, stderr.getvalue())


class StoreTests(unittest.TestCase):
    def test_values_travel_only_in_stdin_and_names_are_fixed(self):
        cloud = FakeCloud()
        names = module.resolve_aliases(["dart", "telegram", "sec"])
        values = [SAMPLES[name] for name in names]
        progress = []
        versions = module.store(CONFIG, names, values, runner=cloud, progress=progress.append)
        self.assertEqual(versions, {name: "1" for name in names})
        self.assertEqual([opts["input"] for argv, opts in cloud.calls if argv[1:4] == ["secrets", "versions", "add"]],
                         [value.encode() for value in values])
        for argv, options in cloud.calls:
            self.assertEqual(argv[0], "gcloud")
            self.assertIn("--account=operator@example.test", argv)
            self.assertIn("--project=personal-test-123", argv)
            self.assertIn("--billing-project=personal-test-123", argv)
            self.assertIn("--quiet", argv)
            self.assertIs(options["stderr"], subprocess.PIPE)
            for value in values:
                self.assertNotIn(value, " ".join(argv))
            if argv[1:4] == ["secrets", "versions", "add"]:
                self.assertIn("--data-file=-", argv)
                self.assertIn(argv[4], ALL_NAMES)
            else:
                self.assertIsNone(options["input"])
        self.assertTrue(all(argv[4] in names for argv in cloud.writes()))
        for value in values:
            self.assertNotIn(value, str(progress))
        # Secrets are never created here: Terraform owns them (and their IAM).
        self.assertFalse(any(argv[1:3] == ["secrets", "create"] for argv, _ in cloud.calls))

    def test_missing_terraform_secret_stops_before_any_write(self):
        cloud = FakeCloud(secrets=set(ALL_NAMES) - {"investing-fred-api-key"})
        names = module.resolve_aliases(["dart", "fred"])
        with self.assertRaises(module.SetupError) as caught:
            module.store(CONFIG, names, [SAMPLES[n] for n in names], runner=cloud)
        self.assertIn("Terraform", str(caught.exception))
        self.assertEqual(cloud.writes(), [])

    def test_existing_enabled_version_blocks_every_write_without_rotate(self):
        cloud = FakeCloud(enabled={"investing-fred-api-key": 2})
        names = module.resolve_aliases(["dart", "fred"])
        with self.assertRaises(module.SetupError) as caught:
            module.store(CONFIG, names, [SAMPLES[n] for n in names], runner=cloud)
        self.assertIn("--rotate", str(caught.exception))
        self.assertIn("investing-fred-api-key", str(caught.exception))
        self.assertEqual(cloud.writes(), [])

    def test_rotate_adds_a_new_version_and_reports_it(self):
        cloud = FakeCloud(enabled={"investing-fred-api-key": 2})
        names = module.resolve_aliases(["fred"])
        versions = module.store(CONFIG, names, [SAMPLES[names[0]]], rotate=True, runner=cloud, progress=lambda message: None)
        self.assertEqual(versions, {"investing-fred-api-key": "3"})
        self.assertEqual(len(cloud.writes()), 1)

    def test_one_invalid_value_prevents_any_cloud_call(self):
        names = module.resolve_aliases(["dart", "telegram"])
        values = [SAMPLES[names[0]], "not-a-token", SAMPLES[names[2]]]
        with self.assertRaises(module.SetupError):
            module.store(CONFIG, names, values, runner=lambda *a, **k: self.fail("No cloud calls expected"))

    def test_provider_errors_do_not_echo_plaintext_and_stop(self):
        cloud = FakeCloud(fail="versions add")
        names = module.resolve_aliases(["dart", "fred"])
        with self.assertRaises(module.SetupError) as caught:
            module.store(CONFIG, names, [SAMPLES[n] for n in names], runner=cloud)
        self.assertNotIn("example-secret-value", str(caught.exception))
        self.assertEqual(len(cloud.writes()), 1)

    def test_non_numeric_version_response_is_rejected(self):
        def runner(argv, **kwargs):
            out = b"projects/1/secrets/x/versions/latest\n" if argv[1:4] == ["secrets", "versions", "list"] and "--sort-by=~createTime" in argv else b"[]"
            if argv[1:3] == ["secrets", "list"]:
                out = json.dumps([{"name": "projects/1/secrets/investing-dart-api-key"}]).encode()
            elif argv[1:4] == ["secrets", "versions", "list"] and "--sort-by=~createTime" not in argv:
                out = b""
            return subprocess.CompletedProcess(argv, 0, out, b"")
        with self.assertRaises(module.SetupError):
            module.store(CONFIG, ("investing-dart-api-key",), [SAMPLES["investing-dart-api-key"]], runner=runner)


class AttachTests(unittest.TestCase):
    def test_attach_builds_exact_update_secrets_with_numeric_versions(self):
        cloud = FakeCloud()
        versions = {"investing-telegram-chat-id": "4", "investing-dart-api-key": "1", "investing-telegram-bot-token": "12"}
        progress = []
        module.attach(CONFIG, versions, runner=cloud, progress=progress.append)
        self.assertEqual(len(cloud.calls), 1)
        argv, options = cloud.calls[0]
        self.assertEqual(argv, [
            "gcloud", "run", "services", "update", "ai-investing", "--region=asia-northeast3",
            "--update-secrets=DART_API_KEY=investing-dart-api-key:1,"
            "TELEGRAM_BOT_TOKEN=investing-telegram-bot-token:12,TELEGRAM_CHAT_ID=investing-telegram-chat-id:4",
            "--account=operator@example.test", "--project=personal-test-123", "--billing-project=personal-test-123", "--quiet",
        ])
        self.assertIsNone(options["input"])
        # Only --update-secrets: no flag that would replace or clear other settings.
        self.assertFalse(any(flag in " ".join(argv) for flag in ("--set-secrets", "--clear-secrets", "--remove-secrets", "--set-env-vars", ":latest")))

    def test_attach_refuses_latest_and_non_numeric_versions(self):
        for version in ("latest", "1; rm", "", "-1"):
            with self.assertRaises(module.SetupError):
                module.attach(CONFIG, {"investing-dart-api-key": version}, runner=lambda *a, **k: self.fail("No cloud"))
        with self.assertRaises(module.SetupError):
            module.attach(CONFIG, {}, runner=lambda *a, **k: self.fail("No cloud"))

    def test_attach_failure_uses_a_static_message(self):
        cloud = FakeCloud(fail="run services update")
        with self.assertRaises(module.SetupError) as caught:
            module.attach(CONFIG, {"investing-dart-api-key": "1"}, runner=cloud)
        self.assertIn("Cloud Run", str(caught.exception))
        self.assertNotIn("example-secret-value", str(caught.exception))

    def test_latest_version_picks_the_numeric_newest_enabled_version(self):
        cloud = FakeCloud(enabled={"investing-dart-api-key": 7})
        self.assertEqual(module.latest_version(CONFIG, "investing-dart-api-key", runner=cloud), "7")
        self.assertIn("--sort-by=~createTime", cloud.calls[0][0])
        self.assertIn("--filter=state=ENABLED", cloud.calls[0][0])
        with self.assertRaises(module.SetupError):
            module.latest_version(CONFIG, "investing-dart-api-key", runner=FakeCloud())


class MainTests(unittest.TestCase):
    def test_noninteractive_input_fails_before_prompting_or_cloud(self):
        stderr = io.StringIO()
        with patch.object(module.sys, "stdin", io.StringIO()), redirect_stderr(stderr), \
                patch("getpass.getpass", side_effect=AssertionError("Must not prompt")), \
                patch.object(module, "read_identity", side_effect=AssertionError("No identity read")):
            self.assertEqual(module.main(["dart"]), 1)
        self.assertIn("터미널", stderr.getvalue())

    def test_identity_is_required_and_personal(self):
        stderr = io.StringIO()
        with patch.object(module, "require_interactive"), patch.object(module, "read_identity", side_effect=module.SetupError("no identity")), \
                redirect_stderr(stderr), patch("getpass.getpass", side_effect=AssertionError("Must not prompt")):
            self.assertEqual(module.main(["dart"]), 1)
        self.assertIn("no identity", stderr.getvalue())

    def test_full_run_prompts_hidden_validates_stores_and_attaches(self):
        cloud = FakeCloud()
        answers = iter([SAMPLES["investing-dart-api-key"], SAMPLES["investing-telegram-bot-token"], SAMPLES["investing-telegram-chat-id"]])
        prompts = []
        def fake_prompt(prompt):
            prompts.append(prompt)
            return next(answers)
        out, err = io.StringIO(), io.StringIO()
        with patch.object(module, "require_interactive"), patch.object(module, "read_identity", return_value=CONFIG),                 patch.object(module, "prompt_hidden", fake_prompt), redirect_stdout(out), redirect_stderr(err):
            code = module.main(["telegram", "dart", "--attach"], runner=cloud)
        self.assertEqual(code, 0)
        self.assertEqual(prompts, ["DART_API_KEY (숨김 입력): ", "TELEGRAM_BOT_TOKEN (숨김 입력): ", "TELEGRAM_CHAT_ID (숨김 입력): "])
        self.assertEqual(len(cloud.writes()), 3)
        update = [argv for argv, _ in cloud.calls if argv[1:4] == ["run", "services", "update"]]
        self.assertEqual(len(update), 1)
        self.assertIn("--update-secrets=DART_API_KEY=investing-dart-api-key:1,"
                      "TELEGRAM_BOT_TOKEN=investing-telegram-bot-token:1,TELEGRAM_CHAT_ID=investing-telegram-chat-id:1", update[0])
        for value in SAMPLES.values():
            self.assertNotIn(value, out.getvalue() + err.getvalue())

    def test_invalid_last_input_means_no_cloud_write(self):
        cloud = FakeCloud()
        answers = iter([SAMPLES["investing-dart-api-key"], "bad key"])
        err = io.StringIO()
        with patch.object(module, "require_interactive"), patch.object(module, "read_identity", return_value=CONFIG), \
                patch.object(module, "prompt_hidden", lambda prompt: next(answers)), \
                redirect_stdout(io.StringIO()), redirect_stderr(err):
            self.assertEqual(module.main(["dart", "fred"], runner=cloud), 1)
        self.assertEqual(cloud.writes(), [])
        self.assertNotIn("bad key", err.getvalue())
        self.assertIn("FRED_API_KEY", err.getvalue())

    def test_attach_only_needs_no_prompt_and_uses_numeric_versions(self):
        cloud = FakeCloud(enabled={"investing-dart-api-key": 3, "investing-sec-user-agent": 1})
        out = io.StringIO()
        with patch.object(module, "read_identity", return_value=CONFIG), patch("getpass.getpass", side_effect=AssertionError("Must not prompt")),                 redirect_stdout(out):
            self.assertEqual(module.main(["sec", "dart", "--attach-only"], runner=cloud), 0)
        self.assertEqual(cloud.writes(), [])
        update = [argv for argv, _ in cloud.calls if argv[1:4] == ["run", "services", "update"]]
        self.assertIn("--update-secrets=DART_API_KEY=investing-dart-api-key:3,SEC_USER_AGENT=investing-sec-user-agent:1", update[0])


if __name__ == "__main__":
    unittest.main()
