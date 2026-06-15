#!/usr/bin/env bash
# Workflow check: generate the offline sample guide and verify the expected
# outputs exist. This exercises the sample pipeline end to end in a temp root.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

SAMPLE_ROOT="$TMP_ROOT/sample"
node scripts/make-sample-guide.js --root "$SAMPLE_ROOT" >/dev/null

for f in sample-manifest.json sample-guide.sfgz; do
  if [[ ! -s "$SAMPLE_ROOT/$f" ]]; then
    echo "Missing sample output: $f" >&2
    exit 1
  fi
done

for dir in sample-data sample-exports/json sample-exports/markdown sample-exports/html-simple \
           sample-exports/wikijs sample-exports/html-rich sample-exports/pdf sample-exports/gif \
           sample-exports/image-bundle sample-exports/docx sample-exports/pptx; do
  if ! find "$SAMPLE_ROOT/$dir" -type f -print -quit | grep -q .; then
    echo "Sample export directory is empty: $dir" >&2
    exit 1
  fi
done

MANIFEST_FILE="$SAMPLE_ROOT/sample-manifest.json" node - <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.env.MANIFEST_FILE, 'utf8'));
if (manifest.format !== 'stepforge-sample-manifest') throw new Error('unexpected sample manifest format');
if (!manifest.guideId) throw new Error('missing guideId');
if (!manifest.exports || Object.keys(manifest.exports).length < 10) throw new Error('missing sample exports');
NODE

echo "sample artifacts OK"
