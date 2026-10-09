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
if [ ! -d "$ROOT_DIR/node_modules/electron/dist" ]; then
  echo "package-deb SKIPPED: node_modules/electron missing (run npm ci first)"
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

# Here-strings avoid SIGPIPE from echo | grep -q under pipefail on large payload listings.
# Required install items.
for needle in \
  './usr/bin/stepforge' \
  './usr/share/applications/stepforge.desktop' \
  './usr/share/mime/packages/stepforge.xml' \
  './usr/share/icons/hicolor/256x256/apps/stepforge.png' \
  './opt/stepforge/node_modules/electron/dist/electron' \
  './opt/stepforge/app/main.js' \
  './opt/stepforge/app/boot.js' \
  './opt/stepforge/app/assets/stepforge.png' \
  './usr/share/keyrings/stepforge-archive-keyring.gpg' \
  './usr/share/doc/stepforge/copyright'; do
  grep -qF "$needle" <<< "$listing" || fail "missing packaged file: $needle"
done

# The development node_modules / build tooling must NOT be present.
for banned in \
  'node_modules/electron-builder' \
  'node_modules/app-builder-lib' \
  'node_modules/dmg-builder'; do
  grep -qF "$banned" <<< "$listing" && fail "build-only dependency leaked: $banned" || true
done

# The app's own docs/prompts/examples must not be shipped.
for banned in \
  './opt/stepforge/docs/' \
  './opt/stepforge/ai_prompts/' \
  './opt/stepforge/examples/'; do
  grep -qF "$banned" <<< "$listing" && fail "app extra shipped: $banned" || true
done

# Control metadata sanity.
grep -q '^Package: stepforge' <<< "$control" || fail "control missing Package"
grep -q '^Depends:.*libnss3' <<< "$control" || fail "control missing runtime Depends"
grep -Eq '^Architecture: (amd64|arm64)' <<< "$control" || fail "control has no concrete Architecture"

# Sandbox is set up, not disabled: postinst makes chrome-sandbox setuid.
dpkg-deb --info "$DEB" | grep -q 'postinst' || fail "no postinst maintainer script"

# A downloaded .deb adds the StepForge APT repository so it updates with
# apt upgrade. Run the packaged maintainer scripts against throwaway roots
# (DPKG_ROOT, as dpkg --root sets it).
if [ "$(dpkg --print-architecture)" = "amd64" ]; then
  SCRIPTS="$OUT_DIR/control"
  dpkg-deb -e "$DEB" "$SCRIPTS"
  LIST=etc/apt/sources.list.d/stepforge.list

  # Fresh system: the source is added, signed by the packaged keyring, and an
  # upgrade leaves it as it is. Removing the package removes it.
  root="$OUT_DIR/root-fresh"; mkdir -p "$root/etc/apt"
  DPKG_ROOT="$root" sh "$SCRIPTS/postinst" configure >/dev/null 2>&1
  [ -f "$root/$LIST" ] || fail "postinst did not add the APT repository"
  grep -qF 'deb [arch=amd64 signed-by=/usr/share/keyrings/stepforge-archive-keyring.gpg] https://packages.twestbrook.com/debian/stepforge/ resolute main' \
    "$root/$LIST" || fail "postinst wrote an unexpected APT source: $(cat "$root/$LIST")"
  first="$(cat "$root/$LIST")"
  DPKG_ROOT="$root" sh "$SCRIPTS/postinst" configure 0.0.0 >/dev/null 2>&1
  [ "$(cat "$root/$LIST")" = "$first" ] || fail "upgrade rewrote the APT source"
  DPKG_ROOT="$root" sh "$SCRIPTS/postrm" remove >/dev/null 2>&1
  [ ! -e "$root/$LIST" ] || fail "postrm left the APT source the package added"

  # Repository already set up by hand (README instructions): untouched by
  # install and by removal.
  root="$OUT_DIR/root-manual"; mkdir -p "$root/etc/apt/sources.list.d"
  manual='deb [arch=amd64 signed-by=/etc/apt/keyrings/stepforge.gpg] https://packages.twestbrook.com/debian/stepforge/ resolute main'
  printf '%s\n' "$manual" > "$root/$LIST"
  DPKG_ROOT="$root" sh "$SCRIPTS/postinst" configure >/dev/null 2>&1
  DPKG_ROOT="$root" sh "$SCRIPTS/postrm" remove >/dev/null 2>&1
  [ "$(cat "$root/$LIST")" = "$manual" ] || fail "a hand-written APT source was changed"

  # Launchpad PPA already configured: no second StepForge source.
  root="$OUT_DIR/root-ppa"; mkdir -p "$root/etc/apt/sources.list.d"
  printf 'Types: deb\nURIs: https://ppa.launchpadcontent.net/twest39/stepforge/ubuntu/\nSuites: resolute\nComponents: main\n' \
    > "$root/etc/apt/sources.list.d/twest39-ubuntu-stepforge-resolute.sources"
  DPKG_ROOT="$root" sh "$SCRIPTS/postinst" configure >/dev/null 2>&1
  [ ! -e "$root/$LIST" ] || fail "postinst added the APT repository alongside the PPA"

  # The packaged key is a usable OpenPGP keyring.
  if command -v gpg >/dev/null 2>&1; then
    dpkg-deb --fsys-tarfile "$DEB" | tar -xO ./usr/share/keyrings/stepforge-archive-keyring.gpg > "$OUT_DIR/keyring.gpg"
    gpg --show-keys "$OUT_DIR/keyring.gpg" >/dev/null 2>&1 || fail "packaged APT keyring is not an OpenPGP key"
  fi
fi

# The launcher must refuse an unsandboxed launch by default.
grep -q 'STEPFORGE_ALLOW_NO_SANDBOX' packaging/linux/common/launcher.sh \
  || fail "launcher does not gate --no-sandbox behind an explicit opt-in"

echo "package-deb OK ($(basename "$DEB"), $(du -h "$DEB" | cut -f1))"
