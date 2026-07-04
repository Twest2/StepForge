#!/usr/bin/env bash
# Install the BUILD toolchain for producing StepForge packages on apt-based
# systems. These are for DEVELOPERS/packagers only and are never shipped inside
# the end-user package.
set -euo pipefail

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script is for apt-based systems (Debian/Ubuntu)." >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

PACKAGES=(
  dpkg-dev fakeroot   # build the .deb
  desktop-file-utils  # validate the .desktop entry
  ca-certificates     # npm ci over https
  xvfb                # headless smoke test under Xvfb
)

echo "Installing StepForge build dependencies via apt..."
$SUDO apt-get update
$SUDO apt-get install -y --no-install-recommends "${PACKAGES[@]}"

cat <<'MSG'
Done. Also install the pinned Node toolchain (see .nvmrc — Node 22.12+):
  nvm install && nvm use     # or another Node 22 LTS install method
Then, from the repo root:
  npm ci
  npm run package:linux:deb
MSG
