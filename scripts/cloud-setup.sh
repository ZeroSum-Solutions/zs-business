#!/usr/bin/env bash
# Prepares a Claude Code cloud session: Node 24, pnpm 10.33.2, a local Postgres on
# 127.0.0.1:55432 with trust auth (same as CI), and installed dependencies.
# Runs from the SessionStart hook in .claude/settings.json. Does nothing on a laptop.
set -euo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

log() { echo "[cloud-setup] $*" >&2; }
is_root() { [ "$(id -u)" -eq 0 ]; }
as_root() { if is_root; then "$@"; else sudo "$@"; fi; }
as_postgres() { if is_root; then runuser -u postgres -- "$@"; else sudo -u postgres "$@"; fi; }
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

# Node 24
if ! node -v 2>/dev/null | grep -q '^v24\.'; then
  log "installing Node 24 (found $(node -v 2>/dev/null || echo none))"
  npm install -g n >/dev/null 2>&1 && as_root n 24 >/dev/null
  # Cloud images put /opt/node22/bin first on PATH; point it at Node 24.
  if [ -d /opt/node22/bin ]; then
    for b in node npm npx corepack; do
      [ -e "/usr/local/bin/$b" ] && as_root ln -sf "/usr/local/bin/$b" "/opt/node22/bin/$b"
    done
  fi
  hash -r
fi

# pnpm pinned by package.json
want_pnpm=$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' package.json)
if [ "$(pnpm -v 2>/dev/null || true)" != "$want_pnpm" ]; then
  log "installing pnpm $want_pnpm"
  npm install -g "pnpm@$want_pnpm" >/dev/null 2>&1
fi

# Postgres on 55432, trust auth, matches .github/workflows/ci.yml
if ! pg_isready -h 127.0.0.1 -p 55432 >/dev/null 2>&1; then
  if ! ls /usr/lib/postgresql/*/bin/initdb >/dev/null 2>&1; then
    log "installing PostgreSQL"
    as_root apt-get update -qq >/dev/null
    DEBIAN_FRONTEND=noninteractive as_root apt-get install -y -qq postgresql >/dev/null
  fi
  bin=$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)
  data=/tmp/zs-pg
  if [ ! -f "$data/PG_VERSION" ]; then
    as_root mkdir -p "$data" && as_root chown postgres:postgres "$data"
    as_postgres "$bin/initdb" -D "$data" -U postgres --auth=trust >/dev/null
  fi
  as_postgres "$bin/pg_ctl" -D "$data" -o "-p 55432 -k /tmp" -l /tmp/zs-pg.log -w start >/dev/null
  log "postgres $("$bin/postgres" --version | awk '{print $3}') up on 55432"
fi

pnpm install --frozen-lockfile >/dev/null
log "ready: node $(node -v), pnpm $(pnpm -v)"

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export ZS_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres" >> "$CLAUDE_ENV_FILE"
fi
