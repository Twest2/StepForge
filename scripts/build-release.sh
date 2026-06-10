#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
BUILD_ROOT="${STEPFORGE_BUILD_DIR:-$ROOT_DIR/build}"
EXAMPLES_ROOT="${STEPFORGE_EXAMPLES_DIR:-$ROOT_DIR/examples}"
ARTIFACT_DIR="$BUILD_ROOT/artifacts"
REPORT_FILE="$BUILD_ROOT/build_report.md"
MANIFEST_FILE="$BUILD_ROOT/artifacts_manifest.json"

mkdir -p "$BUILD_ROOT"

bash "$ROOT_DIR/scripts/bootstrap-offline.sh"
node "$ROOT_DIR/scripts/make-sample-guide.js" --root "$EXAMPLES_ROOT"
STEPFORGE_PACKAGE_DIR="$ARTIFACT_DIR" bash "$ROOT_DIR/scripts/package-linux.sh" >/dev/null

BUILD_ROOT="$BUILD_ROOT" \
ARTIFACT_DIR="$ARTIFACT_DIR" \
EXAMPLES_ROOT="$EXAMPLES_ROOT" \
REPORT_FILE="$REPORT_FILE" \
MANIFEST_FILE="$MANIFEST_FILE" \
ROOT_DIR="$ROOT_DIR" \
node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const buildRoot = process.env.BUILD_ROOT;
const artifactDir = process.env.ARTIFACT_DIR;
const examplesRoot = process.env.EXAMPLES_ROOT;
const reportFile = process.env.REPORT_FILE;
const manifestFile = process.env.MANIFEST_FILE;
const rootDir = process.env.ROOT_DIR;

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, base, out);
    else out.push(path.relative(base, abs));
  }
  return out;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const files = [];
for (const rel of walk(artifactDir, artifactDir)) {
  const abs = path.join(artifactDir, rel);
  files.push({
    kind: 'artifact',
    path: path.relative(buildRoot, abs),
    size: fs.statSync(abs).size,
    sha256: sha256(abs),
  });
}
for (const rel of walk(examplesRoot, examplesRoot)) {
  if (!rel.startsWith('sample-')) continue;
  const abs = path.join(examplesRoot, rel);
  files.push({
    kind: 'sample',
    path: path.relative(buildRoot, abs),
    size: fs.statSync(abs).size,
    sha256: sha256(abs),
  });
}

const pkg = require(path.join(rootDir, 'package.json'));
const report = `# StepForge Build Report

Version: ${pkg.version}
Generated: ${new Date().toISOString()}

## Outputs

- Portable tarball: ${files.find((f) => f.path.endsWith('.tar.gz'))?.path || 'not generated'}
- Debian package: ${files.find((f) => f.path.endsWith('.deb'))?.path || 'not generated'}
- Sample guide archive: ${files.find((f) => f.path.endsWith('sample-guide.sfgz'))?.path || 'not generated'}

## Notes

- The desktop shell is Electron.
- Core storage, exports, and archive handling are local-only.
- Sample exports and package artifacts are written by the offline build scripts.
`;

fs.writeFileSync(reportFile, report);
fs.writeFileSync(manifestFile, JSON.stringify({
  format: 'stepforge-artifacts-manifest',
  version: 1,
  generatedAt: new Date().toISOString(),
  packageVersion: pkg.version,
  files,
}, null, 2) + '\n');
NODE

echo "Build artifacts written to $BUILD_ROOT"
