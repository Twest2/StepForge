#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ISSUE_TEMPLATE="$ROOT_DIR/.github/ISSUE_TEMPLATE.md"
PR_TEMPLATE="$ROOT_DIR/.github/PULL_REQUEST_TEMPLATE.md"

assert_contains() {
  local file="$1"
  local needle="$2"

  if ! grep -Fq -- "$needle" "$file"; then
    printf 'Expected %s to contain: %s\n' "$file" "$needle" >&2
    exit 1
  fi
}

assert_contains "$ISSUE_TEMPLATE" "## Improvement Area"
assert_contains "$ISSUE_TEMPLATE" "## Issue Type"
assert_contains "$ISSUE_TEMPLATE" "## Summary"
assert_contains "$ISSUE_TEMPLATE" "## Current Behavior"
assert_contains "$ISSUE_TEMPLATE" "## Expected Behavior"
assert_contains "$ISSUE_TEMPLATE" "## Steps To Reproduce"
assert_contains "$ISSUE_TEMPLATE" "## Testing Notes"
assert_contains "$ISSUE_TEMPLATE" "## Screenshots, Logs, or Extra Context"

assert_contains "$PR_TEMPLATE" "## Improvement Area"
assert_contains "$PR_TEMPLATE" "## Issue"
assert_contains "$PR_TEMPLATE" "Closes #"
assert_contains "$PR_TEMPLATE" "bash tests/run_test.sh"
assert_contains "$PR_TEMPLATE" "## Testing"
assert_contains "$PR_TEMPLATE" "## Deployment / Rollout Notes"
assert_contains "$PR_TEMPLATE" "Any follow-up work is tracked in TODO.md or an issue."
