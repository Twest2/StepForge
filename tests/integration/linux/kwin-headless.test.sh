#!/usr/bin/env bash
# Starts a private headless KWin (KDE Plasma 6) + D-Bus session and runs the
# Plasma helper against the real KWin scripting API. Never touches the real
# desktop. Without a GPU render node KWin logs that it cannot composite, but
# its window management and scripting, which is all this exercises, keep
# working.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [[ "${STEPFORGE_ISOLATED_KWIN:-}" != 1 ]]; then
  TEST_DIR="$(mktemp -d)"
  trap 'sleep 1; rm -rf "$TEST_DIR" 2>/dev/null || true' EXIT
  mkdir -p "$TEST_DIR/data/applications" "$TEST_DIR/runtime" "$TEST_DIR/config" "$TEST_DIR/cache" "$TEST_DIR/bin"
  chmod 700 "$TEST_DIR/runtime"
  cat > "$TEST_DIR/data/applications/org.stepforge.KWinTest.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=StepForge KWin test
Exec=true
DESKTOP
  # Containers drop CAP_SYS_NICE, so the packaged binary's file capability
  # makes exec fail. A copy without it runs; KWin requires the same file name.
  cp "$(command -v kwin_wayland)" "$TEST_DIR/bin/kwin_wayland"
  env -u DISPLAY -u WAYLAND_DISPLAY \
    PATH="$TEST_DIR/bin:$PATH" LANG=C.UTF-8 QT_FORCE_STDERR_LOGGING=1 \
    XDG_DATA_HOME="$TEST_DIR/data" XDG_DATA_DIRS="$TEST_DIR/data:/usr/local/share:/usr/share" \
    XDG_CONFIG_HOME="$TEST_DIR/config" XDG_CACHE_HOME="$TEST_DIR/cache" XDG_RUNTIME_DIR="$TEST_DIR/runtime" \
    XDG_CURRENT_DESKTOP=KDE KDE_SESSION_VERSION=6 XDG_SESSION_TYPE=wayland \
    LIBGL_ALWAYS_SOFTWARE=1 GSK_RENDERER=cairo STEPFORGE_ISOLATED_KWIN=1 \
    dbus-run-session -- bash "$0"
  exit
fi
kwin_wayland --virtual --no-lockscreen --width 1280 --height 720 > "$XDG_CACHE_HOME/kwin.log" 2>&1 &
KWIN_PID=$!
trap 'kill "$KWIN_PID" 2>/dev/null || true; cat "$XDG_CACHE_HOME/kwin.log"' EXIT
for _ in {1..100}; do
  [[ -S "$XDG_RUNTIME_DIR/wayland-0" ]] && gdbus call --session --dest org.kde.KWin --object-path /Scripting \
    --method org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1 && break
  kill -0 "$KWIN_PID" 2>/dev/null || { echo 'kwin-headless FAILED: kwin_wayland exited' >&2; exit 1; }
  sleep 0.1
done
WAYLAND_DISPLAY=wayland-0 GDK_BACKEND=wayland GDK_DEBUG=no-portals python3 -I "$ROOT_DIR/tests/integration/linux/kwin-companion-client.py"
