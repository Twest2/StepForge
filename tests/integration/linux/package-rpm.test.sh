#!/usr/bin/env bash
# Integration test: build the production .rpm and assert it is a real,
# runtime-only package. Honest skip policy: skip ONLY when the prerequisites
# are genuinely absent (rpmbuild missing or node_modules not installed). Once
# we build, any structural failure fails the test.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

if ! command -v rpmbuild >/dev/null 2>&1; then
  echo "package-rpm SKIPPED: rpmbuild not installed (not a dnf-based build host)"
  exit 0
fi
if [ ! -x "$ROOT_DIR/node_modules/electron/dist/electron" ]; then
  echo "package-rpm SKIPPED: Linux Electron runtime missing (run npm ci on Linux first)"
  exit 0
fi

OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

RPM="$(STEPFORGE_PACKAGE_DIR="$OUT_DIR" bash packaging/linux/fedora/package.sh | tail -1)"
[ -f "$RPM" ] || { echo "package-rpm FAILED: builder produced no .rpm" >&2; exit 1; }

fail() { echo "package-rpm FAILED: $1" >&2; exit 1; }

listing="$(rpm -qlp "$RPM" 2>/dev/null)"

for needle in \
  '/usr/bin/stepforge' \
  '/usr/share/applications/stepforge.desktop' \
  '/usr/share/mime/packages/stepforge.xml' \
  '/opt/stepforge/node_modules/electron/dist/electron' \
  '/opt/stepforge/app/main.js'; do
  echo "$listing" | grep -qF "$needle" || fail "missing packaged file: $needle"
done
echo "$listing" | grep -q '/usr/share/icons/hicolor/256x256/apps/stepforge.png' || fail "missing 256px icon"

# No dev tree / build tooling / app docs.
for banned in 'electron-builder' '/opt/stepforge/docs/' '/opt/stepforge/ai_prompts/' '/opt/stepforge/examples/'; do
  echo "$listing" | grep -qF "$banned" && fail "unexpected payload: $banned" || true
done

# Metadata sanity.
rpm -qip "$RPM" 2>/dev/null | grep -q '^Name *: stepforge' || fail "rpm Name is not stepforge"
rpm -qp --requires "$RPM" 2>/dev/null | grep -q '^nss' || fail "rpm does not Require nss"

echo "package-rpm OK ($(basename "$RPM"))"
