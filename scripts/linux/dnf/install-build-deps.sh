#!/usr/bin/env bash
# Install the BUILD toolchain for producing StepForge packages on dnf-based
# systems (Fedora 44). For DEVELOPERS/packagers only; never shipped inside
# the end-user package.
set -euo pipefail

# Contributors get the complete suite's Debian tools by default; RPM-only
# CI/release jobs can omit them without changing their system libraries.
rpm_only=false
if [[ $# == 1 && "$1" == --rpm-only ]]; then
  rpm_only=true
elif [[ $# != 0 ]]; then
  echo 'Usage: install-build-deps.sh [--rpm-only]' >&2
  exit 1
fi

if ! command -v dnf >/dev/null 2>&1; then
  echo "This script is for dnf-based systems (Fedora 44)." >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

PACKAGES=(
  rpm-build rpmdevtools findutils tar gzip diffutils file   # build the .rpm
  desktop-file-utils      # validate the .desktop entry
  ca-certificates         # npm ci over https
  xorg-x11-xauth dbus-daemon
  xorg-x11-server-Xvfb    # headless smoke test under Xvfb
  # Electron libraries for repository checks, independent of RPM installation.
  nss nspr atk at-spi2-atk at-spi2-core cups-libs libdrm
  gtk3 mesa-libgbm alsa-lib libxkbcommon
  libXcomposite libXdamage libXfixes libXrandr libxshmfence
)

if [[ "$rpm_only" == false ]]; then
  PACKAGES+=(dpkg) # full contributor suite also builds Debian release artifacts
fi

echo "Installing StepForge build dependencies via dnf..."
$SUDO dnf install -y "${PACKAGES[@]}"

cat <<'MSG'
Done. Also install the pinned Node toolchain (see .nvmrc — Node 22.12+):
  nvm install && nvm use     # or another Node 22 LTS install method
Then, from the repo root:
  npm ci
  npm run package:linux:rpm
MSG
