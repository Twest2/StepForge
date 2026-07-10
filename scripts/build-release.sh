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
# Production Linux package: a pruned runtime tree with real desktop
# integration. Requires node_modules (fails otherwise); never installs at
# build time. Skipped only when the Electron runtime is genuinely absent.
if [ -x "$ROOT_DIR/node_modules/electron/dist/electron" ]; then
  STEPFORGE_PACKAGE_DIR="$ARTIFACT_DIR" bash "$ROOT_DIR/packaging/linux/debian/package.sh" >/dev/null
else
  echo "[build-release] skipping Linux .deb: Linux Electron runtime missing (run npm ci on Linux)" >&2
fi

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
const buildVersion = pkg.buildVersion || pkg.version;

const { execSync } = require('node:child_process');
function toolAvailable(cmd) {
  try { execSync(`command -v ${cmd}`, { stdio: 'pipe', shell: '/bin/bash' }); return true; } catch { return false; }
}
const tools = {
  'dpkg-deb (Linux .deb)': toolAvailable('dpkg-deb'),
  'rpmbuild (Linux .rpm)': toolAvailable('rpmbuild'),
  'appimagetool (Linux AppImage)': toolAvailable('appimagetool'),
  'makensis (Windows installer .exe)': toolAvailable('makensis'),
  'wixl / WiX (Windows .msi)': toolAvailable('wixl'),
};
const toolRows = Object.entries(tools)
  .map(([name, ok]) => `| ${name} | ${ok ? 'available' : '**missing**'} |`)
  .join('\n');

const report = `# StepForge Build Report

Build version: ${buildVersion}
Package version: ${pkg.version}
Generated: ${new Date().toISOString()}
Host: ${process.platform} ${process.arch} (node ${process.version})

## Outputs

- Portable tarball: ${files.find((f) => f.path.endsWith('.tar.gz'))?.path || 'not generated'}
- Debian package: ${files.find((f) => f.path.endsWith('.deb'))?.path || 'not generated'}
- Sample guide archive: ${files.find((f) => f.path.endsWith('sample-guide.sfgz'))?.path || 'not generated'}
- Sample exports (10 formats): see examples/sample-exports/
- Full artifact list with sha256 checksums: artifacts_manifest.json

## Packaging tool availability

| Tool | Status |
|---|---|
${toolRows}

Fallback policy: when a packaging tool is missing the build still produces
the runnable app (portable tarball with launcher) plus whatever package
formats the available tools allow. Windows artifacts are produced by
\`npm run package:windows\` (electron-builder, installer .exe); .msi/.rpm/
AppImage require the tools listed above and are skipped on this host.

## Offline guarantee

- The shipped app opens no sockets: no telemetry, update checks, license
  checks, cloud sync, or remote AI. See docs/SECURITY.md.
- All exporters (PNG/GIF/PDF/DOCX/PPTX/ZIP) are implemented in-repo with
  Node built-ins; Electron is the only third-party dependency
  (dev-time fetch recorded in build/agent_audit.md).

## Verification

- \`bash tests/run_test.sh\` runs the workflow suites (node --test), a
  startup smoke test of the Electron launcher, the sample-artifact
  pipeline, and this release build.
`;

fs.writeFileSync(reportFile, report);
fs.writeFileSync(manifestFile, JSON.stringify({
  format: 'stepforge-artifacts-manifest',
  version: 1,
  generatedAt: new Date().toISOString(),
  packageVersion: pkg.version,
  buildVersion,
  files,
}, null, 2) + '\n');
NODE

echo "Build artifacts written to $BUILD_ROOT"
