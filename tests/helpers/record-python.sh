#!/usr/bin/env bash
# Record the Python CLI's (tavily-cli 0.2.1) stdout and exit code for every contract case.
#
# Re-runnable, not part of `npm test`. Needs uv (tested with 0.9.3) and network access the first
# time (uv fetches Python 3.12 and the dependencies; `update --check` always queries PyPI).
# Must run from a checkout that still holds the Python package (pyproject.toml + tavily_cli/).
#
# For each case in tests/fixtures/contract/cases.json it runs, once with --json and once without
# (stdout piped, so plain mode):
#
#   uvx --python 3.12 --from <repo> tvly <args...> [--json]
#
# against tests/helpers/fixture-server.ts serving tests/fixtures/contract/api.json, in a clean
# environment whose HOME is a fresh, short temp dir under /tmp (short so Rich's 80-column wrap never
# splits the config path that `auth` prints) holding ~/.tavily/config.json with the fake key
# tvly-fixture-key, and writes tests/fixtures/contract/<case>-<json|plain>.python.{stdout,exit}.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURES="$ROOT/tests/fixtures/contract"
UV_CACHE="$(uv cache dir)"
UV_PYTHONS="$(uv python dir)"
WORK="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

node --import tsx "$ROOT/tests/helpers/fixture-server.ts" "$FIXTURES/api.json" >"$WORK/server.url" &
SERVER_PID=$!
for _ in $(seq 50); do
  [ -s "$WORK/server.url" ] && break
  sleep 0.1
done
BASE_URL="$(head -n1 "$WORK/server.url")"
[ -n "$BASE_URL" ] || { echo "fixture server did not start" >&2; exit 1; }

# `init` verifies that `tvly` is on PATH; a stub keeps that check independent of the machine.
mkdir -p "$WORK/bin"
printf '#!/bin/sh\nexit 0\n' >"$WORK/bin/tvly"
chmod +x "$WORK/bin/tvly"

# Build the package once up front so per-case output is not mixed with uv's build messages.
uvx --python 3.12 --from "$ROOT" tvly --version >/dev/null

node -e '
  const cases = require(process.argv[1]);
  for (const [name, args] of Object.entries(cases)) console.log([name, ...args].join("\t"));
' "$FIXTURES/cases.json" | while IFS=$'\t' read -r -a fields; do
  name="${fields[0]}"
  args=("${fields[@]:1}")
  for mode in json plain; do
    home="$(mktemp -d /tmp/tvly-XXXXXX)"
    mkdir -p "$home/.tavily"
    printf '{"api_key": "tvly-fixture-key"}\n' >"$home/.tavily/config.json"
    extra=()
    [ "$mode" = json ] && extra=(--json)
    out="$FIXTURES/$name-$mode.python"
    set +e
    env -i \
      HOME="$home" \
      PATH="$WORK/bin:$PATH" \
      LANG=en_US.UTF-8 \
      TAVILY_API_BASE_URL="$BASE_URL" \
      UV_CACHE_DIR="$UV_CACHE" \
      UV_PYTHON_INSTALL_DIR="$UV_PYTHONS" \
      uvx --quiet --python 3.12 --from "$ROOT" tvly "${args[@]}" ${extra[@]+"${extra[@]}"} \
      </dev/null >"$out.stdout" 2>"$WORK/stderr"
    code=$?
    set -e
    rm -rf "$home"
    echo "$code" >"$out.exit"
    echo "$name-$mode: exit $code"
  done
done
