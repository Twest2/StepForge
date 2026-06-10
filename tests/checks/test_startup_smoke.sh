#!/usr/bin/env bash
# Workflow check: ensure the Electron launcher boots without the
# ELECTRON_RUN_AS_NODE shim leaking into the app process.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

LOG_FILE="$TMP_ROOT/start.log"
set +e
STEPFORGE_DATA_DIR="$TMP_ROOT/data" timeout 8s npm start >"$LOG_FILE" 2>&1
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
