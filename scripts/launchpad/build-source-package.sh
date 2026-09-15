#!/usr/bin/env bash
# Build a signed Debian source upload for the StepForge Launchpad PPA.
#
# Launchpad accepts source packages only.  Its builders have no need to fetch
# npm packages: this script stages the same runtime-only payload used by the
# checked .deb builder, then includes that payload in the source upload.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION=""
SERIES=""
OUT_DIR="$ROOT_DIR/build/launchpad"
KEY_ID=""

usage() {
  cat <<'EOF'
Usage: build-source-package.sh --version VERSION --series UBUNTU_SERIES [--out DIR] [--key KEY_ID]

VERSION is the numeric StepForge version without a leading v (for example
0.3.2.1).  The generated PPA version is VERSION-0ubuntu1~ppa1.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?missing version}"; shift 2 ;;
    --series) SERIES="${2:?missing Ubuntu series}"; shift 2 ;;
    --out) OUT_DIR="${2:?missing output directory}"; shift 2 ;;
    --key) KEY_ID="${2:?missing signing key}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! "$VERSION" =~ ^[0-9]+(\.[0-9]+){2,3}$ ]]; then
  echo "error: --version must be a numeric x.y.z or x.y.z.n version" >&2
  exit 2
fi
if [[ ! "$SERIES" =~ ^[a-z]+$ ]]; then
  echo "error: --series must be an Ubuntu series name (for example resolute)" >&2
  exit 2
fi
if [ ! -d "$ROOT_DIR/node_modules/electron/dist" ]; then
  echo "error: node_modules/electron is missing; run npm ci before building a PPA upload" >&2
  exit 1
fi
for tool in debuild dpkg-source; do
  command -v "$tool" >/dev/null || { echo "error: $tool is required" >&2; exit 1; }
done

PPA_VERSION="${VERSION}-0ubuntu1~ppa1"
mkdir -p "$OUT_DIR"
WORK_DIR="$(mktemp -d "$OUT_DIR/.source.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
SOURCE_DIR="$WORK_DIR/stepforge-$VERSION"

# Keep the uploaded source focused: the generated payload contains exactly the
# runtime assets.  Development dependencies, local builds, Git state, docs,
# and examples are not copied into the upload.
mkdir -p "$SOURCE_DIR"
for item in app core exporters gnome-extension packaging package.json package-lock.json LICENSE; do
  cp -a "$ROOT_DIR/$item" "$SOURCE_DIR/$item"
done
mkdir -p "$SOURCE_DIR/payload/usr/share/doc/stepforge"
ROOT_DIR="$ROOT_DIR" STAGE_ROOT="$SOURCE_DIR/payload" \
  bash "$ROOT_DIR/packaging/linux/common/stage-runtime.sh"
install -m 0644 "$ROOT_DIR/LICENSE" "$SOURCE_DIR/payload/usr/share/doc/stepforge/copyright"

mkdir -p "$SOURCE_DIR/debian"
cp -a "$ROOT_DIR/packaging/linux/launchpad/debian/." "$SOURCE_DIR/debian/"
chmod 0755 "$SOURCE_DIR/debian/rules" "$SOURCE_DIR/debian/stepforge.postinst" \
  "$SOURCE_DIR/debian/stepforge.prerm" "$SOURCE_DIR/debian/stepforge.postrm"
cat > "$SOURCE_DIR/debian/changelog" <<EOF
stepforge ($PPA_VERSION) $SERIES; urgency=medium

  * Release StepForge $VERSION.

 -- StepForge <tyler@twestbrook.com>  $(LC_ALL=C date -R)
EOF

# A fresh, reproducible orig tarball is required for each release. Debian
# packaging is carried separately as the Debian diff for format 3.0 (quilt).
ORIG_TAR="$WORK_DIR/stepforge_${VERSION}.orig.tar.gz"
tar --sort=name --mtime='UTC 2026-01-01' --owner=0 --group=0 --numeric-owner \
  --exclude="$(basename "$SOURCE_DIR")/debian" \
  -C "$WORK_DIR" -czf "$ORIG_TAR" "$(basename "$SOURCE_DIR")"

pushd "$SOURCE_DIR" >/dev/null
if [ -n "$KEY_ID" ]; then
  debuild -S -sa -k"$KEY_ID"
else
  debuild -S -sa
fi
popd >/dev/null

CHANGES="$WORK_DIR/stepforge_${PPA_VERSION}_source.changes"
[ -f "$CHANGES" ] || { echo "error: expected source changes file was not created" >&2; exit 1; }
cp "$WORK_DIR"/stepforge_"$PPA_VERSION"_* "$OUT_DIR/"
cp "$ORIG_TAR" "$OUT_DIR/"
echo "$OUT_DIR/$(basename "$CHANGES")"
