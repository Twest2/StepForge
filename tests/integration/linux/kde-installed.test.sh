#!/usr/bin/env bash
# Run only in a disposable CI container (fedora:44 or ubuntu:26.04): installs
# the StepForge package on top of the KDE Plasma pieces it uses, without
# GNOME, and checks what Plasma recording needs from the installed files,
# including against a real headless KWin. Never touches a real desktop.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
[[ $# == 1 && -f "$1" ]] || { echo 'Usage: kde-installed.test.sh package.(deb|rpm)' >&2; exit 1; }
[[ "${GITHUB_ACTIONS:-}" == true && -f /.dockerenv ]] || {
  echo 'This install test requires a disposable GitHub Actions container.' >&2
  exit 1
}
fail() { echo "kde-installed FAILED: $1" >&2; exit 1; }
package="$(realpath "$1")"

# The Plasma side of the desktop, as Kubuntu and Fedora KDE ship it, plus the
# tools this test uses (Xvfb for the smoke test, GTK 4 for a test window).
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends kwin-wayland xdg-desktop-portal-kde udev \
    dbus-daemon gir1.2-gtk-4.0 xvfb xauth
  apt-get install -y "$package"
  installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }
else
  dnf install -y kwin xdg-desktop-portal-kde systemd-udev dbus-daemon gtk4 xorg-x11-server-Xvfb xorg-x11-xauth
  dnf install -y "$package"
  installed() { rpm -q "$1" >/dev/null 2>&1; }
fi

# Plasma users must not get GNOME pulled in.
for name in gnome-shell xdg-desktop-portal-gnome; do
  installed "$name" && fail "installing StepForge pulled in $name"
done
installed xdg-desktop-portal-kde || fail 'the KDE portal is not installed'
command -v spectacle >/dev/null || fail 'the package did not provide Spectacle for region selection'

# Mouse and touchpad access for the active seat, and a valid rule file.
rule=/usr/lib/udev/rules.d/60-stepforge-input.rules
[[ -f "$rule" ]] || fail "missing $rule"
grep -q 'ID_INPUT_KEYBOARD}!="1"' "$rule" || fail 'the input rule does not exclude keyboards'
udevadm verify "$rule" || fail 'udevadm rejects the input rule'

helper=/opt/stepforge/app/platform/linux
for file in portal_capture.py kwin_companion.py kwin/stepforge-capture.js; do
  [[ -f "$helper/$file" ]] || fail "missing $helper/$file"
done
python3 - <<'PY'
import importlib.util
spec = importlib.util.spec_from_file_location('portal_capture', '/opt/stepforge/app/platform/linux/portal_capture.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
helper.Gst.init(None)
for name in ('pipewiresrc', 'videoconvert', 'appsink'):
    assert helper.Gst.ElementFactory.find(name), f'Missing GStreamer element: {name}'
PY

# The installed helper against recorded input events and against real KWin.
STEPFORGE_HELPER_DIR="$helper" python3 -I "$ROOT_DIR/tests/integration/linux/kwin-companion-units.py"
STEPFORGE_HELPER_DIR="$helper" bash "$ROOT_DIR/tests/integration/linux/kwin-headless.test.sh"

# The installed app starts and renders with a Plasma Wayland environment (it
# selects the Plasma capture service and the GlobalShortcuts portal). Xvfb
# stands in for the display; the container's root has no Chromium sandbox.
smoke_dir="$(mktemp -d)"
trap 'rm -rf "$smoke_dir"' EXIT
env -u ELECTRON_RUN_AS_NODE -u WAYLAND_DISPLAY \
  XDG_CURRENT_DESKTOP=KDE KDE_SESSION_VERSION=6 XDG_SESSION_TYPE=wayland \
  STEPFORGE_DATA_DIR="$smoke_dir/data" STEPFORGE_SCREENSHOT="$smoke_dir/window.png" \
  timeout 60s xvfb-run -a stepforge --no-sandbox --disable-gpu --ozone-platform=x11
python3 - "$smoke_dir/window.png" <<'PY'
import struct
import sys
from pathlib import Path
png = Path(sys.argv[1]).read_bytes()
assert png[:8] == b'\x89PNG\r\n\x1a\n', 'App did not render a PNG'
width, height = struct.unpack('>II', png[16:24])
assert width > 100 and height > 100, 'App rendered an empty window'
print(f'Installed app smoke test on a Plasma environment passed ({width}x{height})')
PY
echo 'kde-installed OK'
