#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
README="$ROOT_DIR/README.md"

assert_contains() {
  local file="$1"
  local needle="$2"

  if ! grep -Fq -- "$needle" "$file"; then
    printf 'Expected %s to contain: %s\n' "$file" "$needle" >&2
    exit 1
  fi
}

assert_contains "$README" "# "
assert_contains "$README" "## Overview"
assert_contains "$README" "## What's Included"
assert_contains "$README" "## Testing"
assert_contains "$README" "bash tests/run_test.sh"
assert_contains "$README" "## Contributing"
assert_contains "$README" "## Repository Layout"
assert_contains "$README" "See [ARCHITECTURE.md](ARCHITECTURE.md) to see the repo layout."
