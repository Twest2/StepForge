#!/usr/bin/env bash
# Exercise the real RPM builder's default and fast paths with a tiny runtime,
# rather than compressing the full Electron distribution twice on every PR.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
for tool in rpmbuild rpm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "RPM compression check SKIPPED: $tool not installed"
    exit 0
  fi
done
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
FIXTURE="$TMP_ROOT/repo"
mkdir -p "$FIXTURE/packaging/linux" "$FIXTURE/packaging/assets/icons" \
  "$FIXTURE/node_modules/electron/dist" "$FIXTURE/app" "$FIXTURE/core" "$FIXTURE/exporters"
cp -a "$ROOT_DIR/packaging/linux/common" "$ROOT_DIR/packaging/linux/fedora" "$FIXTURE/packaging/linux/"
cp -a "$ROOT_DIR/gnome-extension" "$FIXTURE/"
cp "$ROOT_DIR/LICENSE" "$FIXTURE/LICENSE"
cp "$ROOT_DIR/packaging/assets/icons/stepforge-16.png" "$FIXTURE/packaging/assets/icons/"
cat > "$FIXTURE/package.json" <<'JSON'
{"name":"stepforge-compression-fixture","version":"0.0.1","private":true,"devDependencies":{"electron":"0.0.1"}}
JSON
printf '{}\n' > "$FIXTURE/package-lock.json"
printf '{"name":"electron","version":"0.0.1"}\n' > "$FIXTURE/node_modules/electron/package.json"
for file in electron chrome-sandbox; do
  printf '#!/bin/sh\nexit 0\n' > "$FIXTURE/node_modules/electron/dist/$file"
  chmod 755 "$FIXTURE/node_modules/electron/dist/$file"
done
# Enough repetitive data to exercise payload compression, while remaining tiny.
node -e 'require("fs").writeFileSync(process.argv[1], "fixture runtime data\n".repeat(4096))' "$FIXTURE/app/fixture.txt"

env -u STEPFORGE_RPM_FAST STEPFORGE_PACKAGE_DIR="$TMP_ROOT/default" \
  bash "$FIXTURE/packaging/linux/fedora/package.sh" > "$TMP_ROOT/default-path"
STEPFORGE_RPM_FAST=1 STEPFORGE_PACKAGE_DIR="$TMP_ROOT/fast" \
  bash "$FIXTURE/packaging/linux/fedora/package.sh" > "$TMP_ROOT/fast-path"
DEFAULT_RPM="$(cat "$TMP_ROOT/default-path")"
FAST_RPM="$(cat "$TMP_ROOT/fast-path")"
# The default path must use the host's configured payload flags, not the CI opt-in.
default_mode="$(rpm --eval '%{_binary_payload}')"
default_flags="${default_mode#w}"
default_flags="${default_flags%%.*}"
[[ "$(rpm -qp --qf '%{PAYLOADFLAGS}' "$DEFAULT_RPM")" == "$default_flags" ]] || {
  echo 'Default RPM did not use distro compression flags' >&2; exit 1;
}
[[ "$(rpm -qp --qf '%{PAYLOADCOMPRESSOR} %{PAYLOADFLAGS}' "$FAST_RPM")" == 'zstd 3T2' ]] || {
  echo 'Fast RPM did not use zstd 3T2' >&2; exit 1;
}
# Verify file contents match, independently of compressed payload bytes.
rpm -qp --qf '[%{FILENAMES} %{FILEDIGESTS}\n]' "$DEFAULT_RPM" > "$TMP_ROOT/default-files"
rpm -qp --qf '[%{FILENAMES} %{FILEDIGESTS}\n]' "$FAST_RPM" > "$TMP_ROOT/fast-files"
cmp "$TMP_ROOT/default-files" "$TMP_ROOT/fast-files"
echo 'RPM default/fast compression paths OK; packaged file digests match'
