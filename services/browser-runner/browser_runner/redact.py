"""BT-8: the sign-in values stay inside the sign-in.

A supplier page may echo them back (a greeting, a form value, a link, a redirect to /users/<name>).
Every event URL and file name the runner reports passes through `Redactor` first: each value is
replaced by its placeholder, in any letter case, raw or URL-encoded. Mirrors core's `redact.ts`.
"""
from __future__ import annotations

import re
import urllib.parse
from typing import Any


def _variants(value: str) -> list[str]:
    forms = {value, urllib.parse.quote(value, safe=""), urllib.parse.quote_plus(value), urllib.parse.quote(value, safe="/:@!$&'()*+,;=-._~")}
    return [form for form in forms if form]


class Redactor:
    def __init__(self, credentials: dict[str, Any] | None):
        entries: list[tuple[str, str]] = []
        for key, placeholder in (("password", "{{password}}"), ("username", "{{username}}")):
            value = (credentials or {}).get(key)
            if isinstance(value, str) and value:
                entries.extend((form, placeholder) for form in _variants(value))
        entries.sort(key=lambda entry: len(entry[0]), reverse=True)
        self._placeholder: dict[str, str] = {}
        for form, placeholder in entries:
            self._placeholder.setdefault(form.lower(), placeholder)
        self._pattern = re.compile("|".join(re.escape(form) for form, _ in entries), re.IGNORECASE) if entries else None

    def text(self, value: str) -> str:
        if self._pattern is None:
            return value
        return self._pattern.sub(lambda match: self._placeholder.get(match.group(0).lower(), "{{password}}"), value)

    def event(self, event: dict[str, Any]) -> dict[str, Any]:
        url = event.get("url")
        return {**event, "url": self.text(url)} if isinstance(url, str) else event
