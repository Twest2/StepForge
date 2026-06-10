#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="$ROOT_DIR/.gitea/workflows/tests.yaml"

assert_contains() {
  local file="$1"
  local needle="$2"

  if ! grep -Fq -- "$needle" "$file"; then
    printf 'Expected %s to contain: %s\n' "$file" "$needle" >&2
    exit 1
  fi
}

if [[ ! -f "$WORKFLOW" ]]; then
  printf 'Expected workflow file to exist: %s\n' "$WORKFLOW" >&2
  exit 1
fi

assert_contains "$WORKFLOW" "name: Template tests"
assert_contains "$WORKFLOW" "push"
assert_contains "$WORKFLOW" "pull_request"
assert_contains "$WORKFLOW" "opened"
assert_contains "$WORKFLOW" "synchronize"
assert_contains "$WORKFLOW" "reopened"
assert_contains "$WORKFLOW" "runs-on: ubuntu-latest"
assert_contains "$WORKFLOW" "uses: https://gitea.com/actions/checkout@v4"
assert_contains "$WORKFLOW" "bash tests/run_test.sh"
