#!/usr/bin/env bash
# Install the RUNTIME libraries StepForge needs on Fedora 44 (GNOME 50 or KDE
# Plasma 6). These are the shared libraries the packaged Electron runtime
# links against, plus the X11/portal integration used for capture.
# For END USERS installing from the tarball; the .rpm declares the same set as
# Requires so dnf pulls them automatically.
set -euo pipefail

if ! command -v dnf >/dev/null 2>&1; then
  echo "This script is for dnf-based systems (Fedora/RHEL). Use the apt script on Debian/Ubuntu." >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

# The desktop's own portal: KDE Plasma or GNOME 50/51.
case "${XDG_CURRENT_DESKTOP:-}" in
  *KDE*) DESKTOP_PACKAGES=(xdg-desktop-portal-kde spectacle) ;;
  *) DESKTOP_PACKAGES=('gnome-shell >= 50' 'gnome-shell < 52' xdg-desktop-portal-gnome) ;;
esac

PACKAGES=(
  nss nspr atk at-spi2-atk at-spi2-core cups-libs libdrm
  gtk3 mesa-libgbm alsa-lib libxkbcommon
  libXcomposite libXdamage libXfixes libXrandr libxshmfence
  python3 python3-gobject gdk-pixbuf2 glib2
  gstreamer1 gstreamer1-plugins-base pipewire-gstreamer
  xdg-desktop-portal "${DESKTOP_PACKAGES[@]}" pipewire wireplumber
)

echo "Installing StepForge Fedora runtime dependencies via dnf..."
# Required capture components must all resolve; never report success after a
# partial installation. RHEL and older GNOME releases are not this target.
$SUDO dnf install -y "${PACKAGES[@]}"
echo "Done. StepForge runtime dependencies are installed."
