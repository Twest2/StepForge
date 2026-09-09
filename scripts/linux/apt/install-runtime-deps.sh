#!/usr/bin/env bash
# Install the RUNTIME libraries StepForge needs on apt-based systems
# (Debian/Ubuntu). These are the shared libraries the packaged Electron runtime
# links against, plus the X11/portal integration used for capture. This is for
# END USERS installing from the tarball; the .deb declares the same set as
# Depends so apt pulls them automatically.
set -euo pipefail

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script is for apt-based systems (Debian/Ubuntu). Use the dnf script on Fedora." >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

PACKAGES=(
  # Chromium/Electron shared libraries
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2
  libgtk-3-0t64 libgbm1 libasound2t64 libxkbcommon0 libatspi2.0-0t64
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxshmfence1
  # X11 per-click capture (marker-accurate) — X11 sessions only
  xinput x11-utils
  # Wayland screen-share via the XDG portal + PipeWire
  xdg-desktop-portal xdg-desktop-portal-gnome pipewire gnome-shell
  python3 python3-gi gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0
  gir1.2-gdkpixbuf-2.0 gstreamer1.0-pipewire gstreamer1.0-plugins-base libglib2.0-bin
)

echo "Installing StepForge runtime dependencies via apt..."
$SUDO apt-get update
$SUDO apt-get install -y --no-install-recommends "${PACKAGES[@]}"
echo "Done. StepForge runtime dependencies are installed."
