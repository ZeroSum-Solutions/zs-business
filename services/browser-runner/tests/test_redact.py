"""BT-8: sign-in values a page echoes back never reach the API in an event URL or a file name."""
import tempfile
import threading
import unittest
import urllib.parse
from http.server import HTTPServer
from pathlib import Path

from browser_runner.client import JobClient
from browser_runner.config import RunnerConfig
from browser_runner.loop import Outcome, run_once
from browser_runner.redact import Redactor

from tests.test_runner import TOKEN, FakeApi, claim

USERNAME = "alice.planted@clinic.example"
PASSWORD = "Zq-PLANTED-pw-4417"


def leaks(blob: str) -> list[str]:
    forms = [USERNAME, PASSWORD, urllib.parse.quote(USERNAME, safe=""), urllib.parse.quote_plus(USERNAME)]
    return [form for form in forms if form.lower() in blob.lower()]


class RedactorTests(unittest.TestCase):
    def test_replaces_raw_encoded_and_case_variants(self):
        redact = Redactor({"username": USERNAME, "password": PASSWORD})
        text = f"Hi {USERNAME.upper()} {urllib.parse.quote(USERNAME, safe='')} {PASSWORD.lower()} /users/{USERNAME}"
        self.assertEqual(redact.text(text), "Hi {{username}} {{username}} {{password}} /users/{{username}}")

    def test_a_second_pass_changes_nothing(self):
        for credentials in ({"username": "name", "password": "word"}, {"username": "a", "password": "user"}):
            redact = Redactor(credentials)
            once = redact.text(f"x {credentials['username']} {credentials['password']} y")
            self.assertEqual(redact.text(once), once)
            self.assertIn("{{username}}", once)

    def test_a_credential_that_contains_a_placeholder_is_matched_whole(self):
        redact = Redactor({"username": "alice", "password": "{{username}}-Tail9!"})
        self.assertEqual(redact.text("pw={{username}}-Tail9! user=alice"), "pw={{password}} user={{username}}")
        self.assertEqual(redact.text("{{username}} {{password}}"), "{{username}} {{password}}")

    def test_no_credentials_changes_nothing(self):
        self.assertEqual(Redactor(None).text("anything"), "anything")


class LoopRedactionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeApi)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.root = tempfile.TemporaryDirectory()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.root.cleanup()

    def test_hooks_redact_event_urls_and_artifact_names(self):
        FakeApi.log, FakeApi.claims = [], [dict(claim(), credentials={"username": USERNAME, "password": PASSWORD})]
        config = RunnerConfig(api_url=f"http://127.0.0.1:{self.server.server_port}", runner_token=TOKEN, browser_root=Path(self.root.name), poll_seconds=1)

        class Echoing:
            def run(self, got, profile, hooks):
                hooks.record_step({"action": "open", "url": f"https://portal.example.test/users/{urllib.parse.quote(USERNAME, safe='')}/{PASSWORD}"})
                hooks.save_artifact("invoice_pdf", f"{PASSWORD.upper()}-{USERNAME}.pdf", b"%PDF-1.4 fake")
                return Outcome("read_done")

        self.assertTrue(run_once(config, JobClient(config), Echoing()))
        sent = [entry for entry in FakeApi.log if not entry[0].endswith("/claim")]
        blob = "\n".join(urllib.parse.unquote_plus(path) + "\n" + path + "\n" + body.decode() for path, _, _, body in sent)
        self.assertEqual(leaks(blob), [])
        self.assertIn("{{username}}", blob)


if __name__ == "__main__":
    unittest.main()
