#!/usr/bin/env bash
# Starts a private headless GNOME + D-Bus session. Never enables extensions in
# the real desktop or injects input into the user's session.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [[ "${STEPFORGE_ISOLATED_GNOME:-}" != 1 ]]; then
  TEST_DIR="$(mktemp -d)"
  trap 'sleep 1; rm -rf "$TEST_DIR"' EXIT
  mkdir -p "$TEST_DIR/data/gnome-shell/extensions" "$TEST_DIR/runtime" "$TEST_DIR/config" "$TEST_DIR/cache"
  chmod 700 "$TEST_DIR/runtime"
  cp -a "$ROOT_DIR/gnome-extension/stepforge@twestbrook.com" "$TEST_DIR/data/gnome-shell/extensions/"
  cp -a "$ROOT_DIR/tests/integration/linux/gnome-driver" "$TEST_DIR/data/gnome-shell/extensions/stepforge-test@example.invalid"
  env -u DISPLAY -u WAYLAND_DISPLAY \
    XDG_DATA_HOME="$TEST_DIR/data" XDG_CONFIG_HOME="$TEST_DIR/config" \
    XDG_CACHE_HOME="$TEST_DIR/cache" XDG_RUNTIME_DIR="$TEST_DIR/runtime" \
    XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_TYPE=wayland GNOME_SHELL_SESSION_MODE=user \
    LIBGL_ALWAYS_SOFTWARE=1 GDK_BACKEND=wayland WAYLAND_DISPLAY=wayland-0 STEPFORGE_ISOLATED_GNOME=1 \
    dbus-run-session -- bash "$0"
  exit
fi
gsettings set org.gnome.shell enabled-extensions "['stepforge@twestbrook.com', 'stepforge-test@example.invalid']"
pipewire > "$XDG_CACHE_HOME/pipewire.log" 2>&1 &
PIPEWIRE_PID=$!
wireplumber > "$XDG_CACHE_HOME/wireplumber.log" 2>&1 &
WIREPLUMBER_PID=$!
gnome-shell --headless --no-x11 --virtual-monitor=1280x720 > "$XDG_CACHE_HOME/shell.log" 2>&1 &
SHELL_PID=$!
trap 'kill "$SHELL_PID" "$PIPEWIRE_PID" "$WIREPLUMBER_PID" 2>/dev/null || true; cat "$XDG_CACHE_HOME/shell.log"' EXIT
for attempt in {1..100}; do
  if gdbus call --session --dest org.gnome.Shell --object-path /org/stepforge/Capture \
      --method org.stepforge.Capture1.GetInfo >/dev/null 2>&1; then break; fi
  sleep 0.1
done
export WAYLAND_DISPLAY=wayland-0
export GDK_BACKEND=wayland
dbus-update-activation-environment WAYLAND_DISPLAY GDK_BACKEND XDG_CURRENT_DESKTOP XDG_SESSION_TYPE
WAYLAND_DISPLAY=wayland-0 GDK_BACKEND=wayland python3 "$ROOT_DIR/tests/integration/linux/gnome-click-client.py"
python3 "$ROOT_DIR/tests/integration/linux/gnome-portal-client.py"
