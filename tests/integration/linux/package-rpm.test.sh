#!/usr/bin/env bash
# Integration test: build or reuse a production .rpm and assert it is a real,
# runtime-only package. Honest skip policy: skip ONLY when the prerequisites
# are genuinely absent (rpmbuild missing or node_modules not installed). Once
# we build, any structural failure fails the test.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

fail() { echo "package-rpm FAILED: $1" >&2; exit 1; }

[[ $# -le 1 ]] || fail 'Usage: package-rpm.test.sh [existing.rpm]'
if [[ $# == 1 ]]; then
  # CI supplies the exact artifact it will install and upload. Never skip or
  # rebuild an explicitly requested artifact, even on a host without RPM tools.
  RPM="$1"
  [[ -f "$RPM" ]] || fail "RPM not found: $RPM"
  command -v rpm >/dev/null 2>&1 || fail 'rpm is required to validate an existing package'
else
  if ! command -v rpmbuild >/dev/null 2>&1; then
    echo "package-rpm SKIPPED: rpmbuild not installed (not a dnf-based build host)"
    exit 0
  fi
  if [ ! -d "$ROOT_DIR/node_modules/electron/dist" ]; then
    echo "package-rpm SKIPPED: node_modules/electron missing (run npm ci first)"
    exit 0
  fi
  OUT_DIR="$(mktemp -d)"
  trap 'rm -rf "$OUT_DIR"' EXIT
  RPM="$(STEPFORGE_PACKAGE_DIR="$OUT_DIR" bash packaging/linux/fedora/package.sh | tail -1)"
  [[ -f "$RPM" ]] || fail 'builder produced no .rpm'
fi

listing="$(rpm -qlp "$RPM" 2>/dev/null)"

for needle in \
  '/usr/bin/stepforge' \
  '/usr/share/applications/stepforge.desktop' \
  '/usr/share/mime/packages/stepforge.xml' \
  '/opt/stepforge/node_modules/electron/dist/electron' \
  '/opt/stepforge/app/main.js' \
  '/opt/stepforge/app/assets/stepforge.png' \
  '/opt/stepforge/app/platform/linux/portal_capture.py' \
  '/usr/share/gnome-shell/extensions/stepforge@twestbrook.com/metadata.json' \
  '/usr/share/gnome-shell/extensions/stepforge@twestbrook.com/extension.js' \
  '/usr/share/gnome-shell/extensions/stepforge@twestbrook.com/buttons.js'; do
  grep -qFx "$needle" <<< "$listing" || fail "missing packaged file: $needle"
done
grep -q '/usr/share/icons/hicolor/256x256/apps/stepforge.png' <<< "$listing" || fail "missing 256px icon"

# No dev tree / build tooling / app docs.
for banned in 'electron-builder' '/opt/stepforge/docs/' '/opt/stepforge/ai_prompts/' '/opt/stepforge/examples/'; do
  grep -qF "$banned" <<< "$listing" && fail "unexpected payload: $banned" || true
done

# Validate actual RPM metadata, including four-component stamped versions.
[[ "$(rpm -qp --qf '%{NAME}' "$RPM")" == stepforge ]] || fail 'wrong package name'
expected_version="$(node -p "require('./package.json').buildVersion || require('./package.json').version")"
[[ "$(rpm -qp --qf '%{VERSION}' "$RPM")" == "$expected_version" ]] || fail 'release version was truncated'
requires="$(rpm -qp --requires "$RPM")"
for requirement in 'nss' 'gnome-shell >= 50' 'gnome-shell < 51' 'python3-gobject' \
  'gstreamer1-plugins-base' 'pipewire-gstreamer' 'gdk-pixbuf2' \
  'xdg-desktop-portal-gnome' 'pipewire' 'wireplumber'; do
  grep -qFx "$requirement" <<< "$requires" || fail "missing dependency: $requirement"
done
if grep -q '^libffmpeg[.]so' <<< "$requires"; then
  fail 'private bundled FFmpeg incorrectly required from system repositories'
fi
provides="$(rpm -qp --provides "$RPM")"
if grep -qE 'lib(EGL|GLESv2|ffmpeg|vulkan)' <<< "$provides"; then
  fail 'private Electron libraries exposed as system capabilities'
fi
( cd "$(dirname "$RPM")" && sha256sum --check "$(basename "$RPM").sha256" )
# Check installed helper permissions from RPM metadata, without installing it.
dump="$(rpm -qp --dump "$RPM")"
helper="$(awk '$1 ~ /\/electron\/dist\/chrome-sandbox$/ {print $5, $6, $7}' <<< "$dump")"
[[ "$helper" == '0104755 root root' ]] || fail "wrong sandbox helper attributes: $helper"

echo "package-rpm OK ($(basename "$RPM"))"
