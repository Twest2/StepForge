#!/usr/bin/env bash
# Runs the node:test workflow suites. These create real guides, archives,
# and exports in temp directories and assert on the actual output produced.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

node --test tests/unit/
