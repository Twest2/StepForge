#!/usr/bin/env sh
# StepForge launcher installed at /usr/bin/stepforge.
#
# Runs the packaged Electron runtime against the installed app at
# /opt/stepforge. It NEVER installs or repairs anything at runtime and it does
# NOT silently disable the Chromium sandbox: an unsandboxed launch requires the
# explicit STEPFORGE_ALLOW_NO_SANDBOX=1 opt-in (development/CI only).

set -eu

APP_DIR=/opt/stepforge
ELECTRON="$APP_DIR/node_modules/electron/dist/electron"
SANDBOX_HELPER="$APP_DIR/node_modules/electron/dist/chrome-sandbox"

if [ ! -x "$ELECTRON" ]; then
  echo "stepforge: Electron runtime missing at $ELECTRON (reinstall the package)." >&2
  exit 1
fi

cd "$APP_DIR" || exit 1

# Linux screen capture: enable the PipeWire path for Wayland portals; harmless
# on X11 where Ozone auto-selects.
COMMON_ARGS="--enable-features=WebRTCPipeWireCapturer --ozone-platform-hint=auto"

sandbox_ok() {
  [ -e "$SANDBOX_HELPER" ] || return 1
  helper_uid="$(stat -c '%u' "$SANDBOX_HELPER" 2>/dev/null || echo '')"
  helper_mode="$(stat -c '%a' "$SANDBOX_HELPER" 2>/dev/null || echo '')"
  [ "$helper_uid" = "0" ] || return 1
  [ -n "$helper_mode" ] || return 1
  # setuid bit set?
  [ $(( $((8#$helper_mode)) & 04000 )) -ne 0 ] || return 1
  return 0
}

userns_ok() {
  # Namespaced sandbox works without the setuid helper on kernels that allow
  # unprivileged user namespaces.
  if [ -r /proc/sys/kernel/unprivileged_userns_clone ]; then
    [ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" = "1" ] && return 0 || return 1
  fi
  if [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
    [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = "0" ] && return 0 || return 1
  fi
  [ -e /proc/self/ns/user ] && return 0 || return 1
}

if sandbox_ok || userns_ok; then
  exec "$ELECTRON" $COMMON_ARGS "$APP_DIR" "$@"
fi

if [ "${STEPFORGE_ALLOW_NO_SANDBOX:-}" = "1" ] || [ "${ELECTRON_DISABLE_SANDBOX:-}" = "1" ]; then
  echo "stepforge: launching WITHOUT the Chromium sandbox (explicit opt-in)." >&2
  exec "$ELECTRON" --no-sandbox $COMMON_ARGS "$APP_DIR" "$@"
fi

cat >&2 <<'MSG'
stepforge: the Chromium sandbox is not available and StepForge will not launch
unsandboxed by default.

Fix one of the following:
  * Make the setuid sandbox helper usable:
      sudo chown root:root /opt/stepforge/node_modules/electron/dist/chrome-sandbox
      sudo chmod 4755 /opt/stepforge/node_modules/electron/dist/chrome-sandbox
  * Enable unprivileged user namespaces (kernel/sysctl dependent):
      sudo sysctl -w kernel.unprivileged_userns_clone=1

For development/CI only you may set STEPFORGE_ALLOW_NO_SANDBOX=1 to override.
MSG
exit 1
