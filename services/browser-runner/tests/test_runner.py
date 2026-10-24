"""Standard-library tests for the runner skeleton. No browser, no real site, no network beyond loopback."""
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from browser_runner.client import ApiFailure, JobClient
from browser_runner.config import ConfigError, RunnerConfig, load_config, profile_dir
from browser_runner.loop import Outcome, run_once

TENANT = "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a70"
TARGET = "5b7d9f1a-2c4e-4a6b-8d0f-1a2b3c4d5e6f"
RUN = "11111111-1111-4111-8111-111111111111"
TOKEN = "t" * 32
LEASE = "l" * 32
GOOD_ENV = {
    "ANONYMIZED_TELEMETRY": "false",
    "BROWSER_USE_CLOUD_SYNC": "false",
    "ZS_API_URL": "https://api.example.test",
    "BROWSER_RUNNER_TOKEN": TOKEN,
    "BROWSER_ROOT": "/var/zs-browser",
}


class FakeApi(BaseHTTPRequestHandler):
    log: list = []
    claims: list = []

    def log_message(self, *args):  # silence
        pass

    def _reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        FakeApi.log.append((self.path, self.headers.get("Authorization"), self.headers.get("Lease-Token"), body))
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            return self._reply(401, {"error": {"code": "Unauthorized"}})
        if self.path.endswith("/claim"):
            return self._reply(200, {"claim": FakeApi.claims.pop(0) if FakeApi.claims else None})
        if self.headers.get("Lease-Token") != LEASE:
            return self._reply(403, {"error": {"code": "Forbidden"}})
        if self.path.endswith("/control"):
            return self._reply(200, {"stop": None})
        if self.path.endswith("/finish"):
            return self._reply(200, {"status": "completed"})
        return self._reply(201, {"ok": True})


def claim():
    return {"runId": RUN, "tenantId": TENANT, "targetId": TARGET, "leaseToken": LEASE, "month": "2026-09"}


class ConfigTests(unittest.TestCase):
    def test_refuses_to_start_without_telemetry_off(self):
        for name in ("ANONYMIZED_TELEMETRY", "BROWSER_USE_CLOUD_SYNC"):
            for value in (None, "true", "False", ""):
                env = dict(GOOD_ENV)
                if value is None:
                    del env[name]
                else:
                    env[name] = value
                with self.assertRaises(ConfigError) as caught:
                    load_config(env)
                self.assertIn(name, str(caught.exception))

    def test_message_never_holds_the_token(self):
        env = dict(GOOD_ENV, BROWSER_RUNNER_TOKEN="zq9-planted")
        with self.assertRaises(ConfigError) as caught:
            load_config(env)
        self.assertNotIn("zq9-planted", str(caught.exception))

    def test_refuses_plain_http_and_relative_roots(self):
        with self.assertRaises(ConfigError):
            load_config(dict(GOOD_ENV, ZS_API_URL="http://api.example.test"))
        with self.assertRaises(ConfigError):
            load_config(dict(GOOD_ENV, BROWSER_ROOT="relative/path"))
        load_config(dict(GOOD_ENV, ZS_API_URL="http://127.0.0.1:8787"))

    def test_plain_http_only_on_an_exact_loopback_host(self):
        for bad in (
            "http://127.0.0.1.attacker.example",
            "http://127.0.0.1.attacker.example:8787",
            "http://127.0.0.1@evil.example",
            "http://user:pw@127.0.0.1:8787",
            "https://user@api.example.test",
            "http://127.0.0.1:8787?x=1",
            "http://127.0.0.1:8787#frag",
            "https://api.example.test?x=1",
            "http://localhost.evil.example",
            "http://[::1].evil.example",
            "https://",
            "ftp://127.0.0.1",
            "http://127.0.0.1:notaport",
        ):
            with self.assertRaises(ConfigError, msg=bad):
                load_config(dict(GOOD_ENV, ZS_API_URL=bad))
        for good in ("http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787", "http://127.0.0.1", "https://api.example.test/base"):
            self.assertEqual(load_config(dict(GOOD_ENV, ZS_API_URL=good)).api_url, good)

    def test_profile_path_comes_only_from_uuids(self):
        config = load_config(GOOD_ENV)
        self.assertEqual(profile_dir(config, TENANT, TARGET), Path("/var/zs-browser") / TENANT / TARGET / "profile")
        for bad in ("../x", "a/b", ""):
            with self.assertRaises(ConfigError):
                profile_dir(config, bad, TARGET)


class LoopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeApi)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.root = tempfile.TemporaryDirectory()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.root.cleanup()

    def setUp(self):
        FakeApi.log, FakeApi.claims = [], []
        self.config = RunnerConfig(
            api_url=f"http://127.0.0.1:{self.server.server_port}", runner_token=TOKEN,
            browser_root=Path(self.root.name), poll_seconds=1,
        )
        self.client = JobClient(self.config)

    def test_idle_when_nothing_is_queued(self):
        class Never:
            def run(self, *args):
                raise AssertionError("no job, no executor")
        self.assertFalse(run_once(self.config, self.client, Never()))

    def test_runs_a_job_through_the_hooks_and_reports_it(self):
        FakeApi.claims.append(claim())
        seen = {}

        class Fake:
            def run(self, got, profile, hooks):
                seen["profile"] = profile
                self_stop = hooks.before_step()
                hooks.record_step({"action": "open", "url": "https://portal.example.test/invoices"})
                hooks.save_artifact("invoice_pdf", "2026-09-001.pdf", b"%PDF-1.4 fake")
                seen["stop"] = self_stop
                return Outcome("read_done")

        self.assertTrue(run_once(self.config, self.client, Fake()))
        self.assertEqual(seen["profile"], Path(self.root.name) / TENANT / TARGET / "profile")
        self.assertTrue(seen["profile"].is_dir())
        self.assertIsNone(seen["stop"])
        paths = [entry[0] for entry in FakeApi.log]
        self.assertEqual(paths, [
            "/browser-runner/v1/claim", f"/browser-runner/v1/runs/{RUN}/control", f"/browser-runner/v1/runs/{RUN}/events",
            f"/browser-runner/v1/runs/{RUN}/artifacts?kind=invoice_pdf&name=2026-09-001.pdf", f"/browser-runner/v1/runs/{RUN}/finish",
        ])
        self.assertEqual(json.loads(FakeApi.log[-1][3]), {"outcome": "read_done"})
        # Only the claim goes without a lease.
        self.assertTrue(all(entry[2] == LEASE for entry in FakeApi.log[1:]))

    def test_an_executor_crash_is_reported_as_one_reason_without_detail(self):
        FakeApi.claims.append(claim())

        class Boom:
            def run(self, *args):
                raise RuntimeError("password=hunter2 in a stack trace")

        self.assertTrue(run_once(self.config, self.client, Boom()))
        finish = json.loads(FakeApi.log[-1][3])
        self.assertEqual(finish, {"outcome": "stopped", "reason": "runner_error"})
        self.assertNotIn(b"hunter2", b"".join(entry[3] for entry in FakeApi.log))

    def test_a_wrong_token_is_an_api_failure(self):
        bad = JobClient(RunnerConfig(self.config.api_url, "x" * 32, self.config.browser_root, 1))
        with self.assertRaises(ApiFailure) as caught:
            bad.claim()
        self.assertEqual(caught.exception.status, 401)


class RedirectTests(unittest.TestCase):
    """A 3xx from the API is a failure; the runner token and lease never follow it anywhere."""

    def test_a_redirect_is_an_api_failure_and_carries_no_credentials(self):
        second_hits = []

        class Second(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _any(self):
                second_hits.append((self.command, self.path, self.headers.get("Authorization"), self.headers.get("Lease-Token")))
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            do_GET = do_POST = _any

        second = HTTPServer(("127.0.0.1", 0), Second)
        threading.Thread(target=second.serve_forever, daemon=True).start()
        self.addCleanup(second.server_close)
        self.addCleanup(second.shutdown)
        status_box = {}

        class First(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                self.send_response(status_box["status"])
                self.send_header("Location", f"http://127.0.0.1:{second.server_port}/stolen")
                self.send_header("Content-Length", "0")
                self.end_headers()

        first = HTTPServer(("127.0.0.1", 0), First)
        threading.Thread(target=first.serve_forever, daemon=True).start()
        self.addCleanup(first.server_close)
        self.addCleanup(first.shutdown)
        client = JobClient(RunnerConfig(f"http://127.0.0.1:{first.server_port}", TOKEN, Path("/var/zs-browser"), 1))
        for status in (301, 302, 303, 307, 308):
            status_box["status"] = status
            with self.assertRaises(ApiFailure, msg=status) as caught:
                client.claim()
            self.assertEqual(caught.exception.status, status)
            with self.assertRaises(ApiFailure, msg=status):
                client.event(RUN, LEASE, {"type": "step"})
        self.assertEqual(second_hits, [])


if __name__ == "__main__":
    unittest.main()
