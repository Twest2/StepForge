#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

for cmd in node npm tar; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required tool: $cmd" >&2
    exit 1
  fi
done

if command -v dpkg-deb >/dev/null 2>&1; then
  echo "dpkg-deb available"
else
  echo "dpkg-deb not available; Linux .deb packaging will be skipped" >&2
fi

node - <<'NODE'
const pkg = require('./package.json');
console.log(`StepForge ${pkg.buildVersion || pkg.version} bootstrap OK`);
NODE
