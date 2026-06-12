#!/usr/bin/env bash
# Workflow check: run the full click-capture pipeline end to end in a real
# Electron session (STEPFORGE_CLICK_SELFTEST) and assert every scenario
# passes. This guards the click→screenshot→step behavior — exact markers,
# one step per click, fast bursts not dropped on finish, the first click of a
# session captured (warm-before-arm), and the ~200ms debounce — against
# regressions that unit tests alone can't catch because they don't exercise
# the live capture stream and window timing.
#
# Scenarios and their pass lines (see app/main.js STEPFORGE_CLICK_SELFTEST):
#   steps:    3 of 3, each marker "off by 0.00% of screen"
#   burst:    8 of 8  (fast clicks + immediate finish, none lost)
#   arm:      warmup click ignored, first armed click captured
#   debounce: 4 of 4  (40ms burst collapses to 1, three 300ms clicks kept)
#
# If the environment can't run a desktop capture at all (no display/stream),
# the scenarios never print, so the check skips rather than failing CI.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

LOG_FILE="$TMP_ROOT/selftest.log"
set +e
STEPFORGE_DATA_DIR="$TMP_ROOT/data" STEPFORGE_CLICK_SELFTEST=1 \
  timeout 120s npm start >"$LOG_FILE" 2>&1
set -e

# The self-test always prints this first line once it begins; without it the
# app never reached the scenarios (couldn't launch / no capture environment).
if ! grep -q 'CLICK-SELFTEST source:' "$LOG_FILE"; then
  echo "click capture selftest SKIPPED (no capture environment on this host)"
  exit 0
fi

fail() {
  echo "click capture selftest FAILED: $1" >&2
  echo "----- selftest output -----" >&2
  grep -E 'CLICK-SELFTEST' "$LOG_FILE" >&2 || true
  exit 1
}

# Any scenario that detected a problem prints FAIL or an ERROR line.
if grep -Eq 'CLICK-SELFTEST.*(FAIL|ERROR)' "$LOG_FILE"; then
  fail "a scenario reported FAIL/ERROR"
fi

# Per-scenario positive assertions (deterministic with synthetic clicks).
grep -q 'CLICK-SELFTEST steps: 3 of 3' "$LOG_FILE" \
  || fail "marker scenario did not capture 3 of 3 clicks"

# All three markers must land exactly on the injected click positions.
marker_ok="$(grep -c 'CLICK-SELFTEST marker [0-9]*: off by 0.00% of screen' "$LOG_FILE" || true)"
[[ "$marker_ok" -eq 3 ]] \
  || fail "expected 3 markers at 0.00% offset, found $marker_ok"

grep -q 'CLICK-SELFTEST burst: 8 of 8' "$LOG_FILE" \
  || fail "burst scenario lost clicks on finish"

grep -q 'CLICK-SELFTEST arm:.*OK' "$LOG_FILE" \
  || fail "arm scenario did not capture the first armed click"

grep -q 'CLICK-SELFTEST debounce: 4 of 4 expected OK' "$LOG_FILE" \
  || fail "debounce scenario did not collapse the burst / keep deliberate clicks"

echo "click capture selftest OK (markers, burst, arm, debounce all verified)"
