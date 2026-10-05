#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Callers can delegate named checks to another job. Validate every name before
# running anything so a renamed check cannot silently restore duplicate work.
skip_checks=()
while [[ $# -gt 0 ]]; do
  if [[ "$1" != --skip || $# -lt 2 ]]; then
    echo 'Usage: tests/run_test.sh [--skip test_name.sh ...]' >&2
    exit 1
  fi
  name="$2"
  if [[ ! "$name" =~ ^test_[A-Za-z0-9_]+[.]sh$ || ! -f "tests/checks/$name" ]]; then
    echo "Unknown check: $name" >&2
    exit 1
  fi
  skip_checks+=("tests/checks/$name")
  shift 2
done

mapfile -t test_scripts < <(find tests/checks -maxdepth 1 -type f -name 'test_*.sh' | sort)

if [[ "${#test_scripts[@]}" -eq 0 ]]; then
  echo "No test scripts found under tests/checks/." >&2
  exit 1
fi

for test_script in "${test_scripts[@]}"; do
  skip=false
  for skipped in "${skip_checks[@]}"; do
    if [[ "$test_script" == "$skipped" ]]; then skip=true; break; fi
  done
  if [[ "$skip" == true ]]; then
    echo "Skipping ${test_script} (explicit --skip)"
    continue
  fi
  echo "Running ${test_script}"
  bash "$test_script"
done

echo "All tests passed."
