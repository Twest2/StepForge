#!/usr/bin/env bash
# Exercise the real Electron UI with mouse and keyboard input, in isolation.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
source tests/lib/headless.sh
if ! headless_ready; then
  echo "UI tests SKIPPED: $HEADLESS_MISSING"
  exit 0
fi
run_headless node --test --test-concurrency=1 --test-timeout=180000 tests/e2e/*.test.js
