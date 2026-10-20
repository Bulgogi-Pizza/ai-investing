"""Credential-free tests: python3 -m unittest discover -s tests -p 'test_toss_secrets.py'."""
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("toss_secrets", Path(__file__).resolve().parents[1] / "scripts/toss-secrets.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
CONFIG = {"personalOnly": True, "account": "operator@example.test", "project": "personal-test-123"}


class IntakeTests(unittest.TestCase):
    def test_values_only_travel_in_stdin_and_personal_identity_is_explicit(self):
        calls = []
        progress = []
        def runner(argv, **kwargs):
            calls.append((argv, kwargs))
            output = b'[{"name":"projects/123/secrets/investing-toss-client-id"}]' if argv[1:3] == ["secrets", "list"] else b""
            return subprocess.CompletedProcess(argv, 0, output, b"")
        module.upload(CONFIG, ["example-id-value", "example-secret-value"], runner=runner, progress=progress.append)
        self.assertEqual(len(calls), 5)  # list, enabled check, first version, second create + version
        for argv, options in calls:
            self.assertIn("--account=operator@example.test", argv)
            self.assertIn("--project=personal-test-123", argv)
            self.assertIn("--billing-project=personal-test-123", argv)
            self.assertNotIn("example-id-value", " ".join(argv))
            self.assertNotIn("example-secret-value", " ".join(argv))
            self.assertIs(options["stderr"], subprocess.PIPE)
        self.assertEqual([opts["input"] for _, opts in calls if opts["input"] is not None], [b"example-id-value", b"example-secret-value"])
        self.assertNotIn("example-secret-value", str(progress))

    def test_existing_enabled_version_prevents_every_write(self):
        calls = []
        def runner(argv, **kwargs):
            calls.append(argv)
            output = b'[{"name":"projects/123/secrets/investing-toss-client-id"}]' if argv[1:3] == ["secrets", "list"] else b"1\n"
            return subprocess.CompletedProcess(argv, 0, output, b"")
        with self.assertRaises(module.SetupError):
            module.upload(CONFIG, ["example-id-value", "example-secret-value"], runner=runner)
        self.assertFalse(any("add" in argv or "create" in argv for argv in calls))

    def test_provider_error_does_not_echo_plaintext_and_stops(self):
        def runner(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 1, b"", b"provider echoed example-secret-value")
        with self.assertRaises(module.SetupError) as caught:
            module.upload(CONFIG, ["example-id-value", "example-secret-value"], runner=runner)
        self.assertNotIn("example-secret-value", str(caught.exception))

    def test_invalid_second_input_prevents_any_cloud_calls(self):
        with self.assertRaises(module.SetupError):
            module.upload(CONFIG, ["valid", ""], runner=lambda *a, **k: self.fail("No cloud calls expected"))
        for value in ["\n", "bad\x00value", "x" * 8193]:
            with self.assertRaises(module.SetupError):
                module.validate_value(value)

    def test_identity_requires_private_instructions_and_personal_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".local").mkdir()
            (root / ".local/deployment.json").write_text(json.dumps(CONFIG))
            with self.assertRaises(module.SetupError):
                module.read_identity(root)
            (root / ".local/deployment-account.md").write_text("Authorized personal identity")
            self.assertEqual(module.read_identity(root), CONFIG)
            (root / ".local/deployment.json").write_text(json.dumps({**CONFIG, "personalOnly": False}))
            with self.assertRaises(module.SetupError):
                module.read_identity(root)

    def test_allowlist_ip_uses_personal_identity_and_rejects_non_ipv4(self):
        calls = []
        def runner(argv, **kwargs):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, b"203.0.113.10\n", b"")
        self.assertEqual(module.allowlist_ip(CONFIG, runner=runner), "203.0.113.10")
        self.assertEqual(calls[0][1:5], ["compute", "addresses", "describe", "investing-egress"])
        self.assertIn("--account=operator@example.test", calls[0])
        for output in [b"", b"not-an-ip", b"2001:db8::1"]:
            with self.assertRaises(module.SetupError):
                module.allowlist_ip(CONFIG, runner=lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0, output, b""))

    def test_existing_keys_point_to_the_next_step(self):
        def runner(argv, **kwargs):
            output = b'[{"name":"projects/123/secrets/investing-toss-client-id"}]' if argv[1:3] == ["secrets", "list"] else b"1\n"
            return subprocess.CompletedProcess(argv, 0, output, b"")
        with self.assertRaises(module.SetupError) as caught:
            module.check_targets(CONFIG, runner=runner)
        self.assertIn("[3/5]", str(caught.exception))
        self.assertIn("node scripts/connect-toss.mjs", str(caught.exception))

    def test_noninteractive_input_fails_before_prompting_or_cloud(self):
        stderr = io.StringIO()
        with patch.object(module.sys, "stdin", io.StringIO()), redirect_stderr(stderr), patch.object(module.getpass, "getpass", side_effect=AssertionError("Must not prompt")):
            self.assertEqual(module.main(), 1)
        self.assertIn("터미널", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
