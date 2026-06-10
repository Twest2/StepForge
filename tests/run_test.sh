#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mapfile -t test_scripts < <(find tests/checks -maxdepth 1 -type f -name 'test_*.sh' | sort)

if [[ "${#test_scripts[@]}" -eq 0 ]]; then
  echo "No test scripts found under tests/checks/." >&2
  exit 1
fi

for test_script in "${test_scripts[@]}"; do
  echo "Running ${test_script}"
  bash "$test_script"
done

echo "All tests passed."
