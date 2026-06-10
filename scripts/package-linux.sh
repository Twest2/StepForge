#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('${ROOT_DIR}/package.json').version" 2>/dev/null || echo 0.0.0)"
OUT_DIR="${STEPFORGE_PACKAGE_DIR:-$ROOT_DIR/build/artifacts}"
mkdir -p "$OUT_DIR"
WORK_DIR="$(mktemp -d "${OUT_DIR%/}/.pkg.XXXXXX")"
APP_DIR="$WORK_DIR/opt/stepforge"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$APP_DIR" "$WORK_DIR/usr/bin" "$WORK_DIR/DEBIAN"

copy_item() {
  local src="$1"
  local dest="$2"
  if [[ -e "$ROOT_DIR/$src" ]]; then
    mkdir -p "$(dirname "$dest")"
    cp -a "$ROOT_DIR/$src" "$dest"
  fi
}

# Application payload: only the files needed to run the app.
copy_item app "$APP_DIR/app"
copy_item core "$APP_DIR/core"
copy_item exporters "$APP_DIR/exporters"
copy_item scripts "$APP_DIR/scripts"
copy_item README.md "$APP_DIR/README.md"
copy_item ARCHITECTURE.md "$APP_DIR/ARCHITECTURE.md"
copy_item CHANGELOG.md "$APP_DIR/CHANGELOG.md"
copy_item CODE_OF_CONDUCT.md "$APP_DIR/CODE_OF_CONDUCT.md"
copy_item CONTRIBUTING.md "$APP_DIR/CONTRIBUTING.md"
copy_item LICENSE "$APP_DIR/LICENSE"
copy_item SECURITY.md "$APP_DIR/SECURITY.md"
copy_item package.json "$APP_DIR/package.json"
copy_item package-lock.json "$APP_DIR/package-lock.json"
copy_item prompt.md "$APP_DIR/prompt.md"
copy_item examples "$APP_DIR/examples"
copy_item build/agent_audit.md "$APP_DIR/build/agent_audit.md"

if [[ -d "$ROOT_DIR/node_modules" ]]; then
  cp -a "$ROOT_DIR/node_modules" "$APP_DIR/node_modules"
fi

cat > "$WORK_DIR/usr/bin/stepforge" <<'EOF'
#!/usr/bin/env sh
APP_DIR=/opt/stepforge
cd "$APP_DIR" || exit 1
exec "$APP_DIR/node_modules/.bin/electron" "$APP_DIR" "$@"
EOF
chmod 0755 "$WORK_DIR/usr/bin/stepforge"

cat > "$WORK_DIR/DEBIAN/control" <<EOF
Package: stepforge
Version: $VERSION
Section: utils
Priority: optional
Architecture: amd64
Maintainer: StepForge <noreply@example.com>
Description: Offline desktop guide capture and export tool
 A fully offline desktop app for step-by-step documentation, built for local
 capture, annotation, and export workflows.
EOF

DEB_FILE="$OUT_DIR/stepforge_${VERSION}_amd64.deb"
TAR_FILE="$OUT_DIR/stepforge_${VERSION}_linux-x64.tar.gz"

if command -v dpkg-deb >/dev/null 2>&1; then
  dpkg-deb --build "$WORK_DIR" "$DEB_FILE" >/dev/null
else
  echo "dpkg-deb is not installed; skipping .deb build" >&2
fi

tar -C "$WORK_DIR/opt" -czf "$TAR_FILE" stepforge

printf '%s\n' "$DEB_FILE"
printf '%s\n' "$TAR_FILE"
