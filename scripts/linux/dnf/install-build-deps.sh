#!/usr/bin/env bash
# Install the BUILD toolchain for producing StepForge packages on dnf-based
# systems (Fedora/RHEL). For DEVELOPERS/packagers only; never shipped inside
# the end-user package.
set -euo pipefail

if ! command -v dnf >/dev/null 2>&1; then
  echo "This script is for dnf-based systems (Fedora/RHEL)." >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

PACKAGES=(
  rpm-build rpmdevtools   # build the .rpm
  desktop-file-utils      # validate the .desktop entry
  ca-certificates         # npm ci over https
  xorg-x11-server-Xvfb    # headless smoke test under Xvfb
)

echo "Installing StepForge build dependencies via dnf..."
$SUDO dnf install -y "${PACKAGES[@]}"

cat <<'MSG'
Done. Also install the pinned Node toolchain (see .nvmrc — Node 22.12+):
  nvm install && nvm use     # or another Node 22 LTS install method
Then, from the repo root:
  npm ci
  npm run package:linux:rpm
MSG
