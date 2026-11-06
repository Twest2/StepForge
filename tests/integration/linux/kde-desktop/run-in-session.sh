#!/usr/bin/env bash
set -euo pipefail
export DBUS_SESSION_BUS_ADDRESS="$(sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p' /tmp/kde-desktop/session.env)"
export XDG_RUNTIME_DIR=/tmp/kde-desktop/runtime
export XDG_CONFIG_HOME=/tmp/kde-desktop/config
export XDG_DATA_HOME=/tmp/kde-desktop/data
export XDG_CACHE_HOME=/tmp/kde-desktop/cache
export XDG_CURRENT_DESKTOP=KDE KDE_SESSION_VERSION=6 XDG_SESSION_TYPE=wayland
export LANG=C.UTF-8 LIBGL_ALWAYS_SOFTWARE=1 GSK_RENDERER=cairo
export XDG_MENU_PREFIX=plasma- KDE_FULL_SESSION=true
export WAYLAND_DISPLAY=wayland-0 QT_QPA_PLATFORM=wayland
unset DISPLAY
exec "$@"
