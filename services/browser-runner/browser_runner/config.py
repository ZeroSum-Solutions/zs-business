"""Runner settings (browser-tasks.md BT-2, BT-7). Read once from a mapping, never from ambient state."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


class ConfigError(Exception):
    """The runner refuses to start. The message names the setting, never a value."""


@dataclass(frozen=True)
class RunnerConfig:
    api_url: str
    runner_token: str
    browser_root: Path
    poll_seconds: float


def load_config(env: dict[str, str]) -> RunnerConfig:
    # BT-2: telemetry and the cloud sync of Browser Use stay off, or nothing starts.
    for name in ("ANONYMIZED_TELEMETRY", "BROWSER_USE_CLOUD_SYNC"):
        if env.get(name) != "false":
            raise ConfigError(f"{name} must be set to false")
    api_url = env.get("ZS_API_URL", "").rstrip("/")
    if not api_url.startswith("https://") and not api_url.startswith("http://127.0.0.1"):
        raise ConfigError("ZS_API_URL must be an https URL (http only on 127.0.0.1)")
    token = env.get("BROWSER_RUNNER_TOKEN", "")
    if len(token) < 24:
        raise ConfigError("BROWSER_RUNNER_TOKEN is missing or too short")
    root = env.get("BROWSER_ROOT", "")
    if not root or not Path(root).is_absolute():
        raise ConfigError("BROWSER_ROOT must be an absolute path")
    try:
        poll = float(env.get("BROWSER_POLL_SECONDS", "10"))
    except ValueError as error:
        raise ConfigError("BROWSER_POLL_SECONDS must be a number") from error
    if not 1 <= poll <= 300:
        raise ConfigError("BROWSER_POLL_SECONDS must be between 1 and 300")
    return RunnerConfig(api_url=api_url, runner_token=token, browser_root=Path(root), poll_seconds=poll)


def profile_dir(config: RunnerConfig, tenant_id: str, target_id: str) -> Path:
    """BT-6: one profile per tenant and target, built only from server-derived IDs."""
    for part in (tenant_id, target_id):
        if not part or any(ch not in "0123456789abcdef-" for ch in part):
            raise ConfigError("a tenant or target ID is not a UUID")
    return config.browser_root / tenant_id / target_id / "profile"
