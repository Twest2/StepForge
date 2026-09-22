#!/usr/bin/env bash
# Explicit artifact requests must fail closed, even on hosts without RPM tools.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

expect_failure() {
  local expected="$1"
  shift
  if "$@" >"$TMP_ROOT/output" 2>&1; then
    echo 'RPM reuse check unexpectedly succeeded' >&2
    exit 1
  fi
  grep -qF "$expected" "$TMP_ROOT/output" || {
    cat "$TMP_ROOT/output" >&2
    exit 1
  }
}

expect_failure 'RPM not found:' env STEPFORGE_TEST_RPM="$TMP_ROOT/missing.rpm" \
  bash tests/checks/test_fedora_package.sh
expect_failure 'RPM not found:' env STEPFORGE_TEST_RPM='' \
  bash tests/checks/test_fedora_package.sh
expect_failure 'Usage:' bash tests/integration/linux/package-rpm.test.sh one.rpm two.rpm

echo 'RPM reuse argument checks OK'
