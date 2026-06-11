#!/usr/bin/env bash
# Runs the node:test workflow suites. These create real guides, archives,
# and exports in temp directories and assert on the actual output produced.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -d "tests/unit" ]]; then
  echo "No tests/unit directory found, skipping unit tests."
  exit 0
fi

mapfile -t unit_tests < <(find tests/unit -type f \( \
  -name "*.test.js" -o \
  -name "*.spec.js" -o \
  -name "*.test.mjs" -o \
  -name "*.spec.mjs" -o \
  -name "*.test.cjs" -o \
  -name "*.spec.cjs" \
\) | sort)

if [[ "${#unit_tests[@]}" -eq 0 ]]; then
  echo "No unit test files found under tests/unit, skipping unit tests."
  exit 0
fi

node --test "${unit_tests[@]}"