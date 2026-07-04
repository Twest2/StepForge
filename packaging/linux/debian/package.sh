#!/usr/bin/env bash
# Build a production StepForge .deb (and a matching portable tarball) from a
# pruned, runtime-only tree.
#
# Unlike the old scripts/package-linux.sh this does NOT copy the development
# node_modules, docs, prompts, examples, or stale audit files; it stages only
# the app code plus a runtime dependency set (the fixed Electron runtime and
# production npm deps), a real desktop entry, icons, MIME registration, and a
# license. Architecture is detected, not hardcoded.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./package.json').version")"
MAINTAINER="${STEPFORGE_MAINTAINER:-StepForge <tyler@twestbrook.com>}"
OUT_DIR="${STEPFORGE_PACKAGE_DIR:-$ROOT_DIR/build/artifacts}"
mkdir -p "$OUT_DIR"

# Map dpkg architecture to a Node-style label for the tarball name.
DEB_ARCH="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
case "$DEB_ARCH" in
  amd64) NODE_ARCH="x64" ;;
  arm64) NODE_ARCH="arm64" ;;
  *) NODE_ARCH="$DEB_ARCH" ;;
esac

# A packaged app must contain a fixed runtime; never install at build time from
# within the package step, and never ship without node_modules.
if [ ! -d "$ROOT_DIR/node_modules/electron/dist" ]; then
  echo "error: node_modules/electron is missing. Run 'npm ci' before packaging." >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${OUT_DIR%/}/.deb.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
APP_DIR="$WORK_DIR/opt/stepforge"
mkdir -p "$APP_DIR" "$WORK_DIR/usr/bin" "$WORK_DIR/DEBIAN"
mkdir -p "$WORK_DIR/usr/share/applications"
mkdir -p "$WORK_DIR/usr/share/mime/packages"
mkdir -p "$WORK_DIR/usr/share/doc/stepforge"

# --- application code (runtime only) ----------------------------------------
for item in app core exporters package.json package-lock.json; do
  cp -a "$ROOT_DIR/$item" "$APP_DIR/$item"
done

# --- runtime node_modules ----------------------------------------------------
# The fixed Electron runtime (needed at runtime even though it is a dev dep):
mkdir -p "$APP_DIR/node_modules"
cp -a "$ROOT_DIR/node_modules/electron" "$APP_DIR/node_modules/electron"
# Production npm dependencies (tesseract.js + language data + transitive):
while IFS= read -r dep; do
  [ -n "$dep" ] || continue
  rel="${dep#"$ROOT_DIR"/}"
  [ "$rel" != "$dep" ] || continue          # only paths under the repo
  [ -d "$dep" ] || continue
  mkdir -p "$APP_DIR/$(dirname "$rel")"
  cp -a "$dep" "$APP_DIR/$rel"
done < <(npm ls --omit=dev --all --parseable 2>/dev/null | tail -n +2)

# Guard: the development-only packaging toolchain must not have leaked in.
if [ -d "$APP_DIR/node_modules/electron-builder" ] || [ -d "$APP_DIR/node_modules/app-builder-lib" ]; then
  echo "error: build-only dependency leaked into the package payload." >&2
  exit 1
fi

# --- launcher ----------------------------------------------------------------
install -m 0755 "$ROOT_DIR/packaging/linux/common/launcher.sh" "$WORK_DIR/usr/bin/stepforge"

# --- desktop entry, icons, MIME ---------------------------------------------
install -m 0644 "$ROOT_DIR/packaging/linux/common/stepforge.desktop" "$WORK_DIR/usr/share/applications/stepforge.desktop"
install -m 0644 "$ROOT_DIR/packaging/linux/common/stepforge-mime.xml" "$WORK_DIR/usr/share/mime/packages/stepforge.xml"
for size in 16 32 48 64 128 256 512; do
  icon="$ROOT_DIR/packaging/assets/icons/stepforge-${size}.png"
  [ -f "$icon" ] || continue
  dest="$WORK_DIR/usr/share/icons/hicolor/${size}x${size}/apps"
  mkdir -p "$dest"
  install -m 0644 "$icon" "$dest/stepforge.png"
done

# --- license + docs pointer --------------------------------------------------
if [ -f "$ROOT_DIR/LICENSE" ]; then
  install -m 0644 "$ROOT_DIR/LICENSE" "$WORK_DIR/usr/share/doc/stepforge/copyright"
elif [ -f "$ROOT_DIR/docs/LICENSE" ]; then
  install -m 0644 "$ROOT_DIR/docs/LICENSE" "$WORK_DIR/usr/share/doc/stepforge/copyright"
fi

# --- DEBIAN control + maintainer scripts ------------------------------------
sed -e "s/@VERSION@/$VERSION/" -e "s/@ARCH@/$DEB_ARCH/" -e "s#@MAINTAINER@#$MAINTAINER#" \
  "$ROOT_DIR/packaging/linux/debian/control.in" > "$WORK_DIR/DEBIAN/control"

cat > "$WORK_DIR/DEBIAN/postinst" <<'POSTINST'
#!/bin/sh
set -e
# Make the Chromium setuid sandbox helper usable so the app launches sandboxed.
HELPER=/opt/stepforge/node_modules/electron/dist/chrome-sandbox
if [ -e "$HELPER" ]; then
  chown root:root "$HELPER" || true
  chmod 4755 "$HELPER" || true
fi
# Refresh desktop/MIME/icon caches (best effort).
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi
if command -v update-mime-database >/dev/null 2>&1; then update-mime-database /usr/share/mime || true; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q /usr/share/icons/hicolor || true; fi
exit 0
POSTINST

cat > "$WORK_DIR/DEBIAN/prerm" <<'PRERM'
#!/bin/sh
set -e
exit 0
PRERM

cat > "$WORK_DIR/DEBIAN/postrm" <<'POSTRM'
#!/bin/sh
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi
  if command -v update-mime-database >/dev/null 2>&1; then update-mime-database /usr/share/mime || true; fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q /usr/share/icons/hicolor || true; fi
fi
exit 0
POSTRM
chmod 0755 "$WORK_DIR/DEBIAN/postinst" "$WORK_DIR/DEBIAN/prerm" "$WORK_DIR/DEBIAN/postrm"

# --- build the .deb ----------------------------------------------------------
DEB_FILE="$OUT_DIR/stepforge_${VERSION}_${DEB_ARCH}.deb"
if command -v fakeroot >/dev/null 2>&1; then
  fakeroot dpkg-deb --build "$WORK_DIR" "$DEB_FILE" >/dev/null
else
  dpkg-deb --build "$WORK_DIR" "$DEB_FILE" >/dev/null
fi

# --- portable tarball (INCLUDES the launcher, unlike the old script) ---------
TAR_FILE="$OUT_DIR/stepforge_${VERSION}_linux-${NODE_ARCH}.tar.gz"
tar -C "$WORK_DIR" -czf "$TAR_FILE" opt usr/bin/stepforge usr/share/applications usr/share/mime usr/share/icons

# --- checksums ---------------------------------------------------------------
( cd "$OUT_DIR" && sha256sum "$(basename "$DEB_FILE")" "$(basename "$TAR_FILE")" > "stepforge_${VERSION}_${DEB_ARCH}.sha256" )

echo "$DEB_FILE"
echo "$TAR_FILE"
