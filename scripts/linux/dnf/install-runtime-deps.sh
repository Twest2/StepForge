#!/usr/bin/env bash
# Install the RUNTIME libraries StepForge needs on dnf-based systems (Fedora,
# RHEL/derivatives). These are the shared libraries the packaged Electron
# runtime links against, plus the X11/portal integration used for capture.
# For END USERS installing from the tarball; the .rpm declares the same set as
# Requires so dnf pulls them automatically.
set -euo pipefail

if ! command -v dnf >/dev/null 2>&1; then
  echo "This script is for dnf-based systems (Fedora/RHEL). Use the apt script on Debian/Ubuntu." >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

PACKAGES=(
  # Chromium/Electron shared libraries
  nss nspr atk at-spi2-atk at-spi2-core cups-libs libdrm
  gtk3 mesa-libgbm alsa-lib libxkbcommon
  libXcomposite libXdamage libXfixes libXrandr libxshmfence
  # X11 per-click capture (marker-accurate) — X11 sessions only
  xorg-x11-server-utils xinput
  # Wayland screen-share via the XDG portal + PipeWire
  xdg-desktop-portal pipewire
)

echo "Installing StepForge runtime dependencies via dnf..."
# Some package names differ across Fedora releases; install best-effort so one
# missing optional name doesn't abort the whole set.
$SUDO dnf install -y "${PACKAGES[@]}" || {
  echo "Some packages were unavailable; retrying individually..." >&2
  for pkg in "${PACKAGES[@]}"; do $SUDO dnf install -y "$pkg" || echo "  (skipped: $pkg)" >&2; done
}
echo "Done. StepForge runtime dependencies are installed."
