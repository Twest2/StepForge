#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTRIBUTING="$ROOT_DIR/CONTRIBUTING.md"

assert_contains() {
  local file="$1"
  local needle="$2"

  if ! grep -Fq -- "$needle" "$file"; then
    printf 'Expected %s to contain: %s\n' "$file" "$needle" >&2
    exit 1
  fi
}

assert_contains "$CONTRIBUTING" "# Contributing"
assert_contains "$CONTRIBUTING" "## Before You Start"
assert_contains "$CONTRIBUTING" "issue number"
assert_contains "$CONTRIBUTING" "issue-123-update-readme"
assert_contains "$CONTRIBUTING" "Closes #123"
assert_contains "$CONTRIBUTING" "bash tests/run_test.sh"
assert_contains "$CONTRIBUTING" "tests/checks/"
assert_contains "$CONTRIBUTING" ".gitea/workflows/tests.yaml"
assert_contains "$CONTRIBUTING" "## Review Checklist"
