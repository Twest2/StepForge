#!/usr/bin/env bash
# Shared staging for the Linux packages. Populates $STAGE_ROOT with the FHS
# layout common to the .deb and .rpm: a pruned runtime-only /opt/stepforge, the
# launcher, desktop entry, icons, MIME registration, and the license.
#
# Distro-specific metadata (Depends vs Requires) and the packaging step
# (dpkg-deb vs rpmbuild) stay in the per-distro builders. This file only
# assembles the payload so the two never drift.
#
# Usage:  ROOT_DIR=<repo> STAGE_ROOT=<dir> bash stage-runtime.sh
set -euo pipefail

: "${ROOT_DIR:?ROOT_DIR must be set}"
: "${STAGE_ROOT:?STAGE_ROOT must be set}"

# A packaged app must contain a fixed runtime; never install at build time and
# never ship without node_modules.
ELECTRON_BIN="$ROOT_DIR/node_modules/electron/dist/electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "error: Linux Electron runtime is missing at $ELECTRON_BIN." >&2
  echo "Run 'npm ci' on Linux before packaging; do not package a Windows or macOS node_modules tree." >&2
  exit 1
fi

APP_DIR="$STAGE_ROOT/opt/stepforge"
mkdir -p "$APP_DIR/node_modules" \
  "$STAGE_ROOT/usr/bin" \
  "$STAGE_ROOT/usr/share/applications" \
  "$STAGE_ROOT/usr/share/mime/packages"

# --- application code (runtime only) ----------------------------------------
for item in app core exporters package.json package-lock.json; do
  cp -a "$ROOT_DIR/$item" "$APP_DIR/$item"
done

# --- runtime node_modules ----------------------------------------------------
# The fixed Electron runtime (needed at runtime even though it is a dev dep):
cp -a "$ROOT_DIR/node_modules/electron" "$APP_DIR/node_modules/electron"
# Production npm dependencies (tesseract.js + language data + transitive):
while IFS= read -r dep; do
  [ -n "$dep" ] || continue
  rel="${dep#"$ROOT_DIR"/}"
  [ "$rel" != "$dep" ] || continue
  [ -d "$dep" ] || continue
  mkdir -p "$APP_DIR/$(dirname "$rel")"
  cp -a "$dep" "$APP_DIR/$rel"
done < <(cd "$ROOT_DIR" && npm ls --omit=dev --all --parseable 2>/dev/null | tail -n +2)

# Guard: the development-only packaging toolchain must not have leaked in.
if [ -d "$APP_DIR/node_modules/electron-builder" ] || [ -d "$APP_DIR/node_modules/app-builder-lib" ]; then
  echo "error: build-only dependency leaked into the package payload." >&2
  exit 1
fi

# --- launcher ----------------------------------------------------------------
install -m 0755 "$ROOT_DIR/packaging/linux/common/launcher.sh" "$STAGE_ROOT/usr/bin/stepforge"

# --- desktop entry, icons, MIME ---------------------------------------------
install -m 0644 "$ROOT_DIR/packaging/linux/common/stepforge.desktop" "$STAGE_ROOT/usr/share/applications/stepforge.desktop"
install -m 0644 "$ROOT_DIR/packaging/linux/common/stepforge-mime.xml" "$STAGE_ROOT/usr/share/mime/packages/stepforge.xml"
for size in 16 32 48 64 128 256 512; do
  icon="$ROOT_DIR/packaging/assets/icons/stepforge-${size}.png"
  [ -f "$icon" ] || continue
  dest="$STAGE_ROOT/usr/share/icons/hicolor/${size}x${size}/apps"
  mkdir -p "$dest"
  install -m 0644 "$icon" "$dest/stepforge.png"
done
