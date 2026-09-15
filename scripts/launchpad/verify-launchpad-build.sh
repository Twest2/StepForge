#!/usr/bin/env bash
# Build an already-created PPA source package in the target Ubuntu release.
# This catches Debian helper/toolchain failures before the release is published
# and sent to Launchpad's slower shared builder queue.
set -euo pipefail

SOURCE_DIR="${1:?usage: verify-launchpad-build.sh SOURCE_DIR}"
IMAGE="${STEPFORGE_LAUNCHPAD_IMAGE:-ubuntu:26.04}"

if ! command -v docker >/dev/null; then
  echo 'error: docker is required for the Launchpad build preflight' >&2
  exit 1
fi

SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
changes=("$SOURCE_DIR"/*_source.changes)
if [ ! -f "${changes[0]}" ]; then
  echo "error: no source changes file found in $SOURCE_DIR" >&2
  exit 1
fi

docker run --rm \
  --volume "$SOURCE_DIR:/source:ro" \
  "$IMAGE" \
  bash -euc '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install --yes build-essential debhelper dpkg-dev fakeroot
    mkdir /build
    cp /source/stepforge_* /build/
    cd /build
    dpkg-source -x stepforge_*.dsc
    cd stepforge-*
    dpkg-buildpackage --sanitize-env -us -uc -b -rfakeroot
  '
