#!/usr/bin/env bash
# Workflow check: run the offline build with temp output roots and verify the
# report, manifest, and sample assets are produced.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

BUILD_ROOT="$TMP_ROOT/build"
EXAMPLES_ROOT="$TMP_ROOT/examples"

STEPFORGE_BUILD_DIR="$BUILD_ROOT" \
STEPFORGE_EXAMPLES_DIR="$EXAMPLES_ROOT" \
bash scripts/build-release.sh >/dev/null

for f in build_report.md artifacts_manifest.json; do
  if [[ ! -s "$BUILD_ROOT/$f" ]]; then
    echo "Missing build output: $f" >&2
    exit 1
  fi
done

if ! find "$BUILD_ROOT/artifacts" -maxdepth 1 -type f -name '*.tar.gz' -print -quit | grep -q .; then
  echo "Missing portable tarball" >&2
  exit 1
fi

if [[ ! -s "$EXAMPLES_ROOT/sample-manifest.json" ]]; then
  echo "Missing sample manifest from build" >&2
  exit 1
fi

if [[ ! -s "$EXAMPLES_ROOT/sample-guide.sfgz" ]]; then
  echo "Missing sample archive from build" >&2
  exit 1
fi

MANIFEST_FILE="$BUILD_ROOT/artifacts_manifest.json" node - <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.env.MANIFEST_FILE, 'utf8'));
if (manifest.format !== 'stepforge-artifacts-manifest') throw new Error('unexpected build manifest format');
if (!Array.isArray(manifest.files) || manifest.files.length < 3) throw new Error('missing build files');
if (!manifest.files.some((file) => file.path.endsWith('.tar.gz'))) throw new Error('missing tarball entry');
if (!manifest.files.some((file) => file.path.endsWith('sample-guide.sfgz'))) throw new Error('missing sample archive entry');
NODE

echo "build release OK"
