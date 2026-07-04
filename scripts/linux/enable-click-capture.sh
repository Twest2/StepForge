#!/usr/bin/env bash
# OPTIONAL: enable per-click capture on Wayland (or X11 without xinput) using a
# LEAST-PRIVILEGE udev rule instead of the broad `input` group.
#
# Security tradeoff (read before running):
#   * This grants your ACTIVE local session read access to MOUSE devices only.
#   * It deliberately EXCLUDES keyboards — StepForge never needs keystrokes.
#   * Access is session-scoped (systemd `uaccess` ACL), not a permanent group.
#   * It is NOT required: the safe default is a global hotkey or interval
#     capture. Only enable this if you want a screenshot on every click.
#
# Compare to `sudo usermod -aG input "$USER"`, which grants access to ALL input
# devices (including keyboards) for your user on every session — a much larger
# surface. This script does not do that.
set -euo pipefail

RULE_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/packaging/linux/common/60-stepforge-input.rules"
RULE_DEST="/etc/udev/rules.d/60-stepforge-input.rules"

if [ ! -f "$RULE_SRC" ]; then
  echo "error: rule file not found at $RULE_SRC" >&2
  exit 1
fi

echo "This installs a least-privilege udev rule granting your session read"
echo "access to MOUSE devices only (never keyboards):"
echo
sed 's/^/    /' "$RULE_SRC"
echo
printf 'Install it to %s? [y/N] ' "$RULE_DEST"
read -r reply
case "$reply" in
  y|Y|yes|YES) ;;
  *) echo "Aborted. No changes made."; exit 0 ;;
esac

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

$SUDO install -m 0644 "$RULE_SRC" "$RULE_DEST"
$SUDO udevadm control --reload-rules
$SUDO udevadm trigger --subsystem-match=input --action=change || true

cat <<'MSG'

Installed. You may need to unplug/replug a USB mouse or re-log in for the ACL
to apply to already-connected devices.

To remove it later:
  sudo rm /etc/udev/rules.d/60-stepforge-input.rules
  sudo udevadm control --reload-rules
MSG
