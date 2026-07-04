#!/usr/bin/env bash
# Build a production StepForge .rpm from a pruned, runtime-only tree, mirroring
# the .deb builder. Stages the shared payload via common/stage-runtime.sh, then
# packages it with rpmbuild against a prebuilt BuildRoot (no compilation).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./package.json').version")"
MAINTAINER="${STEPFORGE_MAINTAINER:-StepForge <tyler@twestbrook.com>}"
OUT_DIR="${STEPFORGE_PACKAGE_DIR:-$ROOT_DIR/build/artifacts}"
mkdir -p "$OUT_DIR"

if ! command -v rpmbuild >/dev/null 2>&1; then
  echo "error: rpmbuild is not installed. Run scripts/linux/dnf/install-build-deps.sh" >&2
  exit 1
fi

# RPM arch label from the host.
RPM_ARCH="$(rpm --eval '%{_arch}' 2>/dev/null || uname -m)"

BUILD_ROOT="$(mktemp -d "${OUT_DIR%/}/.rpm.XXXXXX")"
trap 'rm -rf "$BUILD_ROOT"' EXIT
STAGE="$BUILD_ROOT/buildroot"
mkdir -p "$STAGE"

# Shared runtime-only payload (fails if node_modules is missing).
ROOT_DIR="$ROOT_DIR" STAGE_ROOT="$STAGE" bash "$ROOT_DIR/packaging/linux/common/stage-runtime.sh"

# License into the RPM's conventional location.
mkdir -p "$STAGE/usr/share/licenses/stepforge"
if [ -f "$ROOT_DIR/LICENSE" ]; then
  install -m 0644 "$ROOT_DIR/LICENSE" "$STAGE/usr/share/licenses/stepforge/LICENSE"
elif [ -f "$ROOT_DIR/docs/LICENSE" ]; then
  install -m 0644 "$ROOT_DIR/docs/LICENSE" "$STAGE/usr/share/licenses/stepforge/LICENSE"
else
  # rpmbuild %license requires the file to exist; write a pointer if absent.
  echo "See project LICENSE." > "$STAGE/usr/share/licenses/stepforge/LICENSE"
fi

# Materialize the spec with version/maintainer substituted.
SPEC="$BUILD_ROOT/stepforge.spec"
sed -e "s/@VERSION@/$VERSION/" -e "s#@MAINTAINER@#$MAINTAINER#" \
  "$ROOT_DIR/packaging/linux/fedora/stepforge.spec" > "$SPEC"

rpmbuild -bb \
  --define "_topdir $BUILD_ROOT/rpmbuild" \
  --define "_rpmdir $OUT_DIR" \
  --define "_build_id_links none" \
  --buildroot "$STAGE" \
  --target "$RPM_ARCH" \
  "$SPEC" >/dev/null

# rpmbuild writes to $OUT_DIR/<arch>/<name>.rpm — surface the final path.
RPM_FILE="$(find "$OUT_DIR" -name "stepforge-${VERSION}-1*.${RPM_ARCH}.rpm" -newer "$SPEC" | head -1)"
if [ -z "$RPM_FILE" ]; then
  RPM_FILE="$(find "$OUT_DIR" -name "stepforge-${VERSION}-1*.rpm" | head -1)"
fi
[ -n "$RPM_FILE" ] || { echo "error: rpmbuild did not produce an .rpm" >&2; exit 1; }

# Checksum.
( cd "$(dirname "$RPM_FILE")" && sha256sum "$(basename "$RPM_FILE")" > "$(basename "$RPM_FILE").sha256" )

echo "$RPM_FILE"
