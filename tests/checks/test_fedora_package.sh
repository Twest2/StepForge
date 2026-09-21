#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
if [[ -n "${STEPFORGE_TEST_RPM+x}" ]]; then
  bash tests/integration/linux/package-rpm.test.sh "$STEPFORGE_TEST_RPM"
else
  bash tests/integration/linux/package-rpm.test.sh
fi
