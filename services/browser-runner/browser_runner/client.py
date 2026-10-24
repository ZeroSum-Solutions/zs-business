"""The job interface over HTTPS (browser-tasks.md BT-7): claim, control, events, artifacts, finish.

Standard library only. The runner token goes in `Authorization`, the run's lease token in
`Lease-Token`. Nothing here logs a header, a body or a credential.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .config import RunnerConfig

BASE = "/browser-runner/v1"


class ApiFailure(Exception):
    def __init__(self, status: int):
        super().__init__(f"the API answered {status}")
        self.status = status


class JobClient:
    def __init__(self, config: RunnerConfig, timeout: float = 30.0):
        self._config = config
        self._timeout = timeout

    def _call(self, method: str, path: str, *, lease: str | None = None, body: Any = None, raw: bytes | None = None) -> Any:
        headers = {"Authorization": f"Bearer {self._config.runner_token}"}
        data: bytes | None = None
        if lease:
            headers["Lease-Token"] = lease
        if raw is not None:
            data = raw
            headers["Content-Type"] = "application/octet-stream"
        elif body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(f"{self._config.api_url}{BASE}{path}", data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:  # noqa: S310 - https or loopback, checked in config
                text = response.read().decode()
        except urllib.error.HTTPError as error:
            raise ApiFailure(error.code) from None
        return json.loads(text) if text else None

    def claim(self) -> dict[str, Any] | None:
        return self._call("POST", "/claim")["claim"]

    def control(self, run_id: str, lease: str) -> dict[str, Any]:
        return self._call("POST", f"/runs/{run_id}/control", lease=lease)

    def event(self, run_id: str, lease: str, event: dict[str, Any]) -> dict[str, Any]:
        return self._call("POST", f"/runs/{run_id}/events", lease=lease, body=event)

    def artifact(self, run_id: str, lease: str, kind: str, name: str, data: bytes) -> dict[str, Any]:
        query = urllib.parse.urlencode({"kind": kind, "name": name})
        return self._call("POST", f"/runs/{run_id}/artifacts?{query}", lease=lease, raw=data)

    def finish(self, run_id: str, lease: str, outcome: dict[str, Any]) -> dict[str, Any]:
        return self._call("POST", f"/runs/{run_id}/finish", lease=lease, body=outcome)
