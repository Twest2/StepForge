# Sourced by checks that launch the Electron app. On Linux the app runs on a
# private Xvfb display inside its own D-Bus session, so a test run never opens
# windows, notifications, or tray icons on the developer's desktop, and gives
# the same result with or without a logged-in session.
#
#   headless_ready || { echo "check SKIPPED: $HEADLESS_MISSING"; exit 0; }
#   run_headless env FOO=1 timeout 8s npm start

headless_ready() {
  [[ "$(uname -s)" == Linux ]] || return 0
  local tool
  for tool in xvfb-run xauth dbus-run-session; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      HEADLESS_MISSING="$tool not installed (run scripts/linux/apt/install-build-deps.sh or scripts/linux/dnf/install-build-deps.sh)"
      return 1
    fi
  done
}

# The user's display, bus, and desktop identity are removed so the app picks
# the X11 capture path against the private display and cannot reach the real
# session. Other platforms have no separate display server and run directly.
run_headless() {
  if [[ "$(uname -s)" != Linux ]]; then
    "$@"
    return
  fi
  env -u DISPLAY -u WAYLAND_DISPLAY -u WAYLAND_SOCKET -u DBUS_SESSION_BUS_ADDRESS \
    -u XDG_CURRENT_DESKTOP -u DESKTOP_SESSION -u GNOME_SHELL_SESSION_MODE \
    XDG_SESSION_TYPE=x11 \
    dbus-run-session -- xvfb-run -a -s '-screen 0 1920x1080x24 -nolisten tcp' "$@"
}
