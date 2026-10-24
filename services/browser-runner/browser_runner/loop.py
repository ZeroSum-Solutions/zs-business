"""One pass of the runner: claim a job, hand it to the executor, report the result.

The executor is the part that wraps Browser Use (`BrowserExecutor`). It is NOT part of this first
slice: the skeleton below only wires the job interface, so it can be tested with a fake executor
and no browser. The executor receives the claim, a profile directory and a `Hooks` object; it must
call `hooks.before_step()` before each step and stop when that says so, send each step through
`hooks.record_step()`, and save each PDF through `hooks.save_artifact()`.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol

from .client import ApiFailure, JobClient
from .config import RunnerConfig, profile_dir
from .redact import Redactor


class Hooks(Protocol):
    def before_step(self) -> str | None: ...
    def record_step(self, event: dict[str, Any]) -> dict[str, Any]: ...
    def save_artifact(self, kind: str, name: str, data: bytes) -> dict[str, Any]: ...


@dataclass
class Outcome:
    """`read_done`, or `stopped` with one of the contract's stop reasons."""
    outcome: str
    reason: str | None = None

    def as_body(self) -> dict[str, Any]:
        return {"outcome": "read_done"} if self.outcome == "read_done" else {"outcome": "stopped", "reason": self.reason}


class BrowserExecutor(Protocol):
    def run(self, claim: dict[str, Any], profile: Path, hooks: Hooks) -> Outcome: ...


class _ClientHooks:
    def __init__(self, client: JobClient, run_id: str, lease: str, redactor: Redactor):
        self._client, self._run_id, self._lease = client, run_id, lease
        # BT-8: the last line before the API, which never sees the values to check them.
        self._redact = redactor

    def before_step(self) -> str | None:
        return self._client.control(self._run_id, self._lease).get("stop")

    def record_step(self, event: dict[str, Any]) -> dict[str, Any]:
        return self._client.event(self._run_id, self._lease, self._redact.event(event))

    def save_artifact(self, kind: str, name: str, data: bytes) -> dict[str, Any]:
        return self._client.artifact(self._run_id, self._lease, kind, self._redact.text(name), data)


def run_once(config: RunnerConfig, client: JobClient, executor: BrowserExecutor) -> bool:
    """Returns True when a job was claimed (so the caller polls again at once), False when idle."""
    claim = client.claim()
    if claim is None:
        return False
    run_id, lease = claim["runId"], claim["leaseToken"]
    profile = profile_dir(config, claim["tenantId"], claim["targetId"])
    profile.mkdir(parents=True, exist_ok=True)
    try:
        outcome = executor.run(claim, profile, _ClientHooks(client, run_id, lease, Redactor(claim.get("credentials"))))
    except ApiFailure:
        # The lease is gone or the API refused a call: leave the job to the lease expiry.
        return True
    except Exception:  # noqa: BLE001 - any executor failure is reported as one reason, with no detail
        outcome = Outcome("stopped", "runner_error")
    try:
        client.finish(run_id, lease, outcome.as_body())
    except ApiFailure:
        pass
    return True


def serve(config: RunnerConfig, client: JobClient, executor: BrowserExecutor, sleep: Callable[[float], None], keep_going: Callable[[], bool]) -> None:
    while keep_going():
        if not run_once(config, client, executor):
            sleep(config.poll_seconds)
