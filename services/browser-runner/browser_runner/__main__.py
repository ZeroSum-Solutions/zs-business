"""`python3 -m browser_runner`: validates the settings, then stops.

The Browser Use executor is not part of this slice, so there is nothing to serve yet. Starting the
module checks the environment the pilot Mac must have (BT-2) and prints one line.
"""
import os
import sys

from .config import ConfigError, load_config


def main() -> int:
    try:
        config = load_config(dict(os.environ))
    except ConfigError as error:
        print(f"browser-runner will not start: {error}", file=sys.stderr)
        return 2
    print(f"browser-runner settings are valid for {config.api_url}; no executor is installed yet")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
