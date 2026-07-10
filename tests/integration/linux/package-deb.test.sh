#!/usr/bin/env bash
# Integration test: build the production .deb and assert it is a real,
# runtime-only package — the right files present, and the dev tree / build
# tooling / app docs absent. A package is NOT accepted merely because
# dpkg-deb produced a file.
#
# Honest skip policy: skip ONLY when the prerequisites are genuinely absent
# (not apt-based, dpkg-deb missing, or node_modules not installed). Once we
# build, any structural failure fails the test.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

if ! command -v dpkg-deb >/dev/null 2>&1; then
  echo "package-deb SKIPPED: dpkg-deb not installed (not an apt-based build host)"
  exit 0
fi
if [ ! -x "$ROOT_DIR/node_modules/electron/dist/electron" ]; then
  echo "package-deb SKIPPED: Linux Electron runtime missing (run npm ci on Linux first)"
  exit 0
fi

OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

DEB="$(STEPFORGE_PACKAGE_DIR="$OUT_DIR" bash packaging/linux/debian/package.sh | head -1)"
if [ ! -f "$DEB" ]; then
  echo "package-deb FAILED: builder did not produce a .deb" >&2
  exit 1
fi

fail() { echo "package-deb FAILED: $1" >&2; exit 1; }

listing="$(dpkg-deb -c "$DEB")"
control="$(dpkg-deb -f "$DEB")"

# Required install items.
for needle in \
  './usr/bin/stepforge' \
  './usr/share/applications/stepforge.desktop' \
  './usr/share/mime/packages/stepforge.xml' \
  './usr/share/icons/hicolor/256x256/apps/stepforge.png' \
  './opt/stepforge/node_modules/electron/dist/electron' \
  './opt/stepforge/app/main.js' \
  './usr/share/doc/stepforge/copyright'; do
  echo "$listing" | grep -qF "$needle" || fail "missing packaged file: $needle"
done

# The development node_modules / build tooling must NOT be present.
for banned in \
  'node_modules/electron-builder' \
  'node_modules/app-builder-lib' \
  'node_modules/dmg-builder'; do
  echo "$listing" | grep -qF "$banned" && fail "build-only dependency leaked: $banned" || true
done

# The app's own docs/prompts/examples must not be shipped.
for banned in \
  './opt/stepforge/docs/' \
  './opt/stepforge/ai_prompts/' \
  './opt/stepforge/examples/'; do
  echo "$listing" | grep -qF "$banned" && fail "app extra shipped: $banned" || true
done

# Control metadata sanity.
echo "$control" | grep -q '^Package: stepforge' || fail "control missing Package"
echo "$control" | grep -q '^Depends:.*libnss3' || fail "control missing runtime Depends"
echo "$control" | grep -Eq '^Architecture: (amd64|arm64)' || fail "control has no concrete Architecture"

# Sandbox is set up, not disabled: postinst makes chrome-sandbox setuid.
dpkg-deb --info "$DEB" | grep -q 'postinst' || fail "no postinst maintainer script"

# The launcher must refuse an unsandboxed launch by default.
grep -q 'STEPFORGE_ALLOW_NO_SANDBOX' packaging/linux/common/launcher.sh \
  || fail "launcher does not gate --no-sandbox behind an explicit opt-in"

# The portable archive must be self-contained enough to launch from its
# extraction directory: it has the same usr/ + opt/ layout as the package,
# includes the license, and its launcher remains valid POSIX shell.
TAR="$(find "$OUT_DIR" -maxdepth 1 -type f -name '*.tar.gz' -print -quit)"
[ -n "$TAR" ] && [ -f "$TAR" ] || fail "builder did not produce a portable tarball"
TAR_LIST="$OUT_DIR/portable-files.txt"
tar -tzf "$TAR" > "$TAR_LIST"
grep -qx 'opt/stepforge/app/main.js' "$TAR_LIST" || fail "portable app payload missing"
grep -qx 'usr/bin/stepforge' "$TAR_LIST" || fail "portable launcher missing"
grep -qx 'usr/share/doc/stepforge/copyright' "$TAR_LIST" || fail "portable license missing"
PORTABLE_ROOT="$OUT_DIR/portable"
mkdir -p "$PORTABLE_ROOT"
tar -C "$PORTABLE_ROOT" -xzf "$TAR"
dash -n "$PORTABLE_ROOT/usr/bin/stepforge" || fail "portable launcher is not POSIX shell"

echo "package-deb OK ($(basename "$DEB"), $(du -h "$DEB" | cut -f1))"
