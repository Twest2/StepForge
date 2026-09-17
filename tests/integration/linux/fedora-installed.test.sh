#!/usr/bin/env bash
# Run only in a disposable Fedora CI container: installs the RPM and tests its
# actual system dependencies and rendered UI. Does not touch a real desktop.
set -euo pipefail
[[ $# == 1 && -f "$1" ]] || { echo 'Usage: fedora-installed.test.sh package.rpm' >&2; exit 1; }
[[ "${GITHUB_ACTIONS:-}" == true && -f /.dockerenv ]] || {
  echo 'This install test requires a disposable GitHub Actions container.' >&2
  exit 1
}
dnf install -y "$1"
rpm -V stepforge
python3 - <<'PY'
import importlib.util
spec = importlib.util.spec_from_file_location('portal_capture', '/opt/stepforge/app/platform/linux/portal_capture.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
helper.Gst.init(None)
for name in ('pipewiresrc', 'videoconvert', 'appsink'):
    assert helper.Gst.ElementFactory.find(name), f'Missing GStreamer element: {name}'
PY
# Container root has no Chromium sandbox. The override applies to this test
# process only; the installed launcher and RPM retain sandboxing defaults.
smoke_dir="$(mktemp -d)"
trap 'rm -rf "$smoke_dir"' EXIT
env -u ELECTRON_RUN_AS_NODE \
  STEPFORGE_DATA_DIR="$smoke_dir/data" STEPFORGE_SCREENSHOT="$smoke_dir/window.png" \
  timeout 60s xvfb-run -a stepforge --no-sandbox --disable-gpu
python3 - "$smoke_dir/window.png" <<'PY'
import struct
import sys
from pathlib import Path
png = Path(sys.argv[1]).read_bytes()
assert png[:8] == b'\x89PNG\r\n\x1a\n', 'App did not render a PNG'
width, height = struct.unpack('>II', png[16:24])
assert width > 100 and height > 100, 'App rendered an empty window'
print(f'Installed Fedora RPM smoke test passed ({width}x{height})')
PY
