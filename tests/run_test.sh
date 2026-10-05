#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Fedora runs all checks except the Debian release build, which CI runs in
# the Ubuntu unit job. The default remains the complete contributor suite.
profile=full
if [[ $# == 1 && "$1" == --fedora ]]; then
  profile=fedora
elif [[ $# != 0 ]]; then
  echo 'Usage: tests/run_test.sh [--fedora]' >&2
  exit 1
fi

mapfile -t test_scripts < <(find tests/checks -maxdepth 1 -type f -name 'test_*.sh' | sort)

if [[ "${#test_scripts[@]}" -eq 0 ]]; then
  echo "No test scripts found under tests/checks/." >&2
  exit 1
fi

for test_script in "${test_scripts[@]}"; do
  if [[ "$profile" == fedora && "$test_script" == tests/checks/test_workflow_build_release.sh ]]; then
    echo "${test_script} delegated to the Ubuntu CI job"
    continue
  fi
  echo "Running ${test_script}"
  bash "$test_script"
done

echo "All tests passed."
