#!/usr/bin/env bash
# Source-checkout setup; the .deb installs these files system-wide itself.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UUID=stepforge@twestbrook.com
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
if ! gnome-shell --version | grep -qE 'GNOME Shell 50([.]|$)'; then
  echo 'StepForge Capture currently supports GNOME Shell 50 (Ubuntu 26.04).' >&2
  exit 1
fi
mkdir -p "$DEST"
for file in metadata.json extension.js buttons.js; do
  install -m 0644 "$ROOT_DIR/gnome-extension/$UUID/$file" "$DEST/$file"
done
if gnome-extensions enable "$UUID"; then
  echo 'StepForge Capture enabled. If updating an already loaded extension, log out and back in.'
else
  echo 'Extension installed. Log out and back in so GNOME discovers it; StepForge will offer to enable it.'
fi
