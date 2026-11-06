#!/usr/bin/env bash
set -euo pipefail
if [[ "${KDE_TEST_BUS:-}" != 1 ]]; then
  rm -rf /tmp/kde-desktop
fi
mkdir -p /tmp/kde-desktop/{runtime,config,data,cache,bin}
chmod 700 /tmp/kde-desktop/runtime
export XDG_RUNTIME_DIR=/tmp/kde-desktop/runtime
export XDG_CONFIG_HOME=/tmp/kde-desktop/config
export XDG_DATA_HOME=/tmp/kde-desktop/data
export XDG_CACHE_HOME=/tmp/kde-desktop/cache
export XDG_CURRENT_DESKTOP=KDE KDE_SESSION_VERSION=6 XDG_SESSION_TYPE=wayland
export XDG_MENU_PREFIX=plasma- KDE_FULL_SESSION=true
export LANG=C.UTF-8 LIBGL_ALWAYS_SOFTWARE=1 GSK_RENDERER=cairo
export KWIN_COMPOSE=O2 KWIN_WAYLAND_NO_PERMISSION_CHECKS=1
export WAYLAND_DISPLAY=wayland-0 QT_QPA_PLATFORM=wayland
export QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 QT_ACCESSIBILITY=1
unset DISPLAY
if [[ "${KDE_TEST_BUS:-}" != 1 ]]; then
  exec env KDE_TEST_BUS=1 dbus-run-session -- bash "$0"
fi
env > /tmp/kde-desktop/session.env
kbuildsycoca6 --noincremental > /tmp/kde-desktop/sycoca.log 2>&1
pipewire > /tmp/kde-desktop/pipewire.log 2>&1 &
wireplumber > /tmp/kde-desktop/wireplumber.log 2>&1 &
cp /usr/bin/kwin_wayland /tmp/kde-desktop/bin/kwin_wayland
/tmp/kde-desktop/bin/kwin_wayland --virtual --width 1280 --height 900 --no-lockscreen --xwayland > /tmp/kde-desktop/kwin.log 2>&1 &
for _ in {1..100}; do
  [[ -S "$XDG_RUNTIME_DIR/wayland-0" ]] && gdbus call --session --dest org.kde.KWin --object-path /KWin --method org.kde.KWin.supportInformation > /tmp/kde-desktop/kwin-info.txt 2>&1 && break
  sleep 0.1
done
plasmashell > /tmp/kde-desktop/plasmashell.log 2>&1 &
gdbus call --session --dest org.kde.kded6 --object-path /kded --method org.kde.kded6.loadModule statusnotifierwatcher > /tmp/kde-desktop/tray-watcher.log 2>&1
echo ready > /tmp/kde-desktop/ready
wait
