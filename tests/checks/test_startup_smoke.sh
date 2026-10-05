#!/usr/bin/env bash
# Workflow check: ensure the Electron launcher boots without the
# ELECTRON_RUN_AS_NODE shim leaking into the app process.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=../lib/headless.sh
source tests/lib/headless.sh

# The only allowed skip is missing headless tooling, detected before launch.
# Any failure after launch (missing shared library, crash) must fail the check.
if ! headless_ready; then
  echo "startup smoke SKIPPED: $HEADLESS_MISSING"
  exit 0
fi

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

LOG_FILE="$TMP_ROOT/start.log"
set +e
run_headless env STEPFORGE_DATA_DIR="$TMP_ROOT/data" timeout 8s npm start >"$LOG_FILE" 2>&1
status=$?
set -e

if [[ $status -ne 124 ]]; then
  cat "$LOG_FILE" >&2
  echo "electron launcher did not stay alive under timeout (status $status)" >&2
  exit 1
fi

if grep -Eq 'TypeError: Cannot read properties of undefined \(reading '\''requestSingleInstanceLock'\''\)|bad option: --ozone-platform=headless' "$LOG_FILE"; then
  cat "$LOG_FILE" >&2
  echo "launcher still exposed a Node-mode startup failure" >&2
  exit 1
fi

echo "startup smoke OK"
