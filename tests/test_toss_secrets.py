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


class GcloudResolutionTests(unittest.TestCase):
    ROOT = "C:\\SDK\\google-cloud-sdk"
    GCLOUD_PY = ROOT + "\\lib\\gcloud.py"
    BUNDLED = ROOT + "\\platform\\bundledpython\\python.exe"
    SDK_FILES = {ROOT + "\\bin\\gcloud.cmd", GCLOUD_PY, BUNDLED}
    WIN_ENV = {"PATH": 'C:\\Windows;"' + ROOT + '\\bin"'}

    def resolve(self, environ, files, platform="win32"):
        return module.resolve_gcloud(platform=platform, environ=environ, is_file=lambda path: path in files)

    def test_non_windows_runs_plain_gcloud_without_touching_the_filesystem(self):
        def probe(path):
            raise AssertionError("Must not probe the filesystem")
        for platform in ("linux", "darwin"):
            self.assertEqual(module.resolve_gcloud(platform=platform, environ={}, is_file=probe), (["gcloud"], None))

    def test_windows_uses_bundled_python_and_gcloud_py_without_a_shell(self):
        prefix, env = self.resolve({**self.WIN_ENV, "PYTHONHOME": "C:\\other", "KEEP": "1"}, self.SDK_FILES)
        self.assertEqual(prefix, [self.BUNDLED, "-S", self.GCLOUD_PY])
        self.assertEqual(env["CLOUDSDK_PYTHON"], self.BUNDLED)
        self.assertNotIn("PYTHONHOME", env)
        self.assertEqual(env["KEEP"], "1")

    def test_windows_honors_cloudsdk_python_in_any_case_and_site_packages(self):
        python = "D:\\Python312\\python.exe"
        prefix, env = self.resolve(
            {"Path": self.WIN_ENV["PATH"], "CloudSdk_Python": python, "VIRTUAL_ENV": "D:\\venv"},
            {self.ROOT + "\\bin\\gcloud.cmd", self.GCLOUD_PY, python},
        )
        self.assertEqual(prefix, [python, self.GCLOUD_PY])
        self.assertEqual(env["CLOUDSDK_PYTHON"], python)
        self.assertNotIn("CloudSdk_Python", env)

    def test_windows_resolution_failures_are_static_messages(self):
        secret = "sentinel-secret-value"
        cases = [
            ({"PATH": "C:\\Windows", "SENTINEL": secret}, set()),
            (self.WIN_ENV, {self.ROOT + "\\bin\\gcloud.cmd"}),
            (self.WIN_ENV, {self.ROOT + "\\bin\\gcloud.cmd", self.GCLOUD_PY}),
            ({**self.WIN_ENV, "CLOUDSDK_PYTHON": "D:\\missing\\python.exe"}, self.SDK_FILES),
            ({**self.WIN_ENV, "CLOUDSDK_PYTHON": "D:\\tools\\python.cmd"}, self.SDK_FILES | {"D:\\tools\\python.cmd"}),
        ]
        for environ, files in cases:
            with self.assertRaises(module.SetupError) as caught:
                self.resolve(environ, files)
            message = str(caught.exception)
            self.assertIn("WSL", message)
            for value in environ.values():
                self.assertNotIn(value, message)

    def test_relative_path_entries_cannot_plant_gcloud_cmd(self):
        files = {".\\gcloud.cmd", "bin\\gcloud.cmd", "lib\\gcloud.py", "python.exe"}
        with self.assertRaises(module.SetupError):
            self.resolve({"PATH": ".;bin;C:\\Windows"}, files)

    def test_default_runner_prepends_the_resolved_command_and_env(self):
        seen = {}
        def fake_run(argv, **kwargs):
            seen["argv"], seen["kwargs"] = argv, kwargs
            return subprocess.CompletedProcess(argv, 0, b"", b"")
        env = {"CLOUDSDK_PYTHON": "python.exe"}
        resolved = ([self.BUNDLED, "-S", self.GCLOUD_PY], env)
        with patch.object(module, "resolve_gcloud", return_value=resolved), patch.object(module.subprocess, "run", fake_run):
            module.run_gcloud_process(["gcloud", "secrets", "list", "--quiet"], input=b"stdin-only", timeout=60)
        self.assertEqual(seen["argv"], [self.BUNDLED, "-S", self.GCLOUD_PY, "secrets", "list", "--quiet"])
        self.assertIs(seen["kwargs"]["env"], env)
        self.assertEqual(seen["kwargs"]["input"], b"stdin-only")
        self.assertNotIn("shell", seen["kwargs"])
        with patch.object(module, "resolve_gcloud", return_value=(["gcloud"], None)), patch.object(module.subprocess, "run", fake_run):
            module.run_gcloud_process(["gcloud", "secrets", "list"])
        self.assertEqual(seen["argv"], ["gcloud", "secrets", "list"])
        self.assertNotIn("env", seen["kwargs"])


if __name__ == "__main__":
    unittest.main()
