"""Runs the script embedded in .github/workflows/plane-link.yml against a fake Plane.

Standard library only: python3 -I -B scripts/plane_link_test.py
Nothing leaves the process: urllib's opener is replaced by an in-memory Plane.
"""
import io
import json
import os
import pathlib
import re
import textwrap
import unittest
import urllib.request
from contextlib import redirect_stdout
from unittest import mock

WORKFLOW = pathlib.Path(__file__).resolve().parent.parent / ".github" / "workflows" / "plane-link.yml"
BASE = "https://plane.invalid"
PREFIX = BASE + "/api/v1/workspaces/zerosum/"
PR_URL = "https://github.com/example/repo/pull/7"


def embedded_script():
    text = WORKFLOW.read_text()
    # The terminator must sit at the same indent as the line that opens the heredoc: YAML strips
    # that indent from the run block, so only then does bash see it at column 0.
    match = re.search(r"^( *)python3 - <<'PLANE_LINK_PY'\n(.*?)\n\1PLANE_LINK_PY\n", text, re.S | re.M)
    if not match:
        raise AssertionError("no PLANE_LINK_PY block in %s" % WORKFLOW)
    return textwrap.dedent(match.group(2))


class Reply:
    def __init__(self, body):
        self.body = json.dumps(body).encode()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self.body


class FakePlane:
    """Work items ZSB-n, all in project p1, with one state per group."""

    STATES = [{"id": "s-" + g, "name": g.title(), "group": g, "sequence": i}
              for i, g in enumerate(["backlog", "unstarted", "started", "completed", "cancelled"])]

    def __init__(self, items):
        self.items = {n: {"id": "i%d" % n, "state": "s-" + group, "links": [], "comments": []}
                      for n, group in items.items()}
        self.calls = []
        self.errors = []  # the script catches KeyError and ValueError, so a fake's own fault is kept here

    def group(self, n):
        return self.items[n]["state"][2:]

    def open(self, request, timeout=None):
        try:
            return self.answer(request)
        except Exception as error:
            self.errors.append(repr(error))
            raise

    def answer(self, request):
        url, method = request.full_url, request.get_method()
        assert url.startswith(PREFIX), url
        path = url[len(PREFIX):].split("?")[0]
        body = json.loads(request.data) if request.data else None
        self.calls.append((method, path))
        m = re.fullmatch(r"issues/ZSB-(\d+)/", path)
        if m and method == "GET":
            return Reply({"project": "p1", "id": self.items[int(m.group(1))]["id"]})
        if path == "projects/p1/states/":
            return Reply({"results": self.STATES, "next_page_results": False})
        m = re.fullmatch(r"projects/p1/issues/i(\d+)/(links/|comments/)?", path)
        assert m, path
        item = self.items[int(m.group(1))]
        if m.group(2) == "links/":
            if method == "POST":
                item["links"].append(body)
            return Reply({"results": item["links"], "next_page_results": False})
        if m.group(2) == "comments/":
            if method == "POST":
                item["comments"].append(body)
            return Reply({"results": item["comments"], "next_page_results": False})
        if method == "PATCH":
            item["state"] = body["state"]
        return Reply({"state": item["state"]})


def run(plane, action, merged=False, branch="", title="", body=""):
    env = {
        "PLANE_URL": BASE, "PLANE_API_KEY": "test-key", "PR_ACTION": action,
        "PR_MERGED": "true" if merged else "false", "PR_STATE": "closed" if action == "closed" else "open",
        "PR_BASE": "main", "DEFAULT_BRANCH": "main", "PR_URL": PR_URL, "PR_NUMBER": "7",
        "PR_TITLE": title, "PR_BRANCH": branch, "PR_BODY": body,
    }
    out = io.StringIO()
    with mock.patch.dict(os.environ, env, clear=True), \
            mock.patch.object(urllib.request, "build_opener", return_value=plane), \
            redirect_stdout(out):
        try:
            exec(compile(embedded_script(), str(WORKFLOW), "exec"), {"__name__": "__main__"})
        except SystemExit as exit_:
            if exit_.code not in (None, 0):  # the workflow step would fail
                raise AssertionError("script exited with %r:\n%s" % (exit_.code, out.getvalue()))
    if plane.errors:  # a request the fake did not expect, swallowed by the script's handler
        raise AssertionError("unexpected Plane requests: %s\n%s" % (plane.errors, out.getvalue()))
    return out.getvalue()


class PlaneLinkTest(unittest.TestCase):
    def test_merge_finishes_branch_and_title_keys_but_not_a_body_mention(self):
        plane = FakePlane({21: "started", 24: "started", 13: "started"})
        log = run(plane, "closed", merged=True, branch="ci/ZSB-24-plane-link-body",
                  title="fix: flaky deadline tests (ZSB-21)", body="Follow-up of ZSB-13; tracked as ZSB-13.")
        self.assertEqual(plane.group(24), "completed")
        self.assertEqual(plane.group(21), "completed")
        self.assertEqual(plane.group(13), "started", log)
        self.assertNotIn(("PATCH", "projects/p1/issues/i13/"), plane.calls)
        # The mention still links the PR and leaves its comment.
        self.assertEqual([link["url"] for link in plane.items[13]["links"]], [PR_URL])
        self.assertEqual(len(plane.items[13]["comments"]), 1)
        self.assertIn("ZSB-13: named only in the body", log)

    def test_open_starts_only_branch_and_title_keys(self):
        plane = FakePlane({30: "backlog", 31: "unstarted"})
        run(plane, "opened", branch="feat/ZSB-30-thing", body="Needs ZSB-31 first.")
        self.assertEqual(plane.group(30), "started")
        self.assertEqual(plane.group(31), "unstarted")
        self.assertEqual(len(plane.items[31]["links"]), 1)

    def test_a_key_in_the_body_and_the_title_still_moves(self):
        plane = FakePlane({40: "started"})
        run(plane, "closed", merged=True, title="fix: thing (zsb-040)", body="Closes ZSB-40.")
        self.assertEqual(plane.group(40), "completed")

    def test_body_only_merge_moves_nothing(self):
        plane = FakePlane({50: "started", 51: "backlog"})
        run(plane, "closed", merged=True, branch="chore/tidy", title="chore: tidy", body="See ZSB-50 and ZSB-51.")
        self.assertEqual((plane.group(50), plane.group(51)), ("started", "backlog"))
        self.assertFalse([c for c in plane.calls if c[0] == "PATCH"])
        for n in (50, 51):  # still linked and commented
            self.assertEqual([link["url"] for link in plane.items[n]["links"]], [PR_URL])
            self.assertEqual(len(plane.items[n]["comments"]), 1)

    def test_edit_does_not_repeat_the_comment(self):
        plane = FakePlane({60: "started"})
        for _ in range(2):
            run(plane, "edited", body="tracked as ZSB-60")
        self.assertEqual(len(plane.items[60]["comments"]), 1)
        self.assertEqual(len(plane.items[60]["links"]), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
