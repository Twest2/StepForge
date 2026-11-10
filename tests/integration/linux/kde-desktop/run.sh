#!/usr/bin/env bash
# Only inside a disposable, privileged test container with a virtual DRM node.
set -euo pipefail
[[ -f /.dockerenv && -d /artifacts ]] || { echo 'Run in the documented disposable container.' >&2; exit 1; }
[[ ! -e /artifacts/data ]] || { echo 'Use a fresh artifact directory for each run.' >&2; exit 1; }
cp /fixture/{cdp.cjs,input.py,target.py,scenario.cjs,start-virtual-desktop.sh,run-in-session.sh} /artifacts/
mkdir -p /dev/input /artifacts/generated
# Keep both discovery and input FDs private; never read host input devices.
mount -t tmpfs tmpfs /dev/input
mkfifo /dev/input/event990
cat > /artifacts/input-devices <<'EOF'
I: Bus=0003 Vendor=0001 Product=0001 Version=0001
N: Name="StepForge isolated test mouse"
H: Handlers=mouse0 event990

EOF
mount --bind /artifacts/input-devices /proc/bus/input/devices
python3 -m pywayland.scanner -i /usr/share/plasma-wayland-protocols/fake-input.xml -o /artifacts/generated
bash /artifacts/start-virtual-desktop.sh > /artifacts/desktop.log 2>&1 &
desktop_pid=$!
trap 'kill "$desktop_pid" 2>/dev/null || true' EXIT
for _ in {1..200}; do
  [[ -f /tmp/kde-desktop/ready ]] && break
  kill -0 "$desktop_pid" || { cat /artifacts/desktop.log; exit 1; }
  sleep 0.1
done
[[ -f /tmp/kde-desktop/ready ]] || { echo 'Plasma did not start.' >&2; exit 1; }
bash /artifacts/run-in-session.sh python3 /artifacts/target.py > /artifacts/target.log 2>&1 &
export STEPFORGE_DATA_DIR=/artifacts/data
# Not a first start: a new library also gets the "Welcome to StepForge" guide
# (core/welcome-guide.js), and scenario.cjs reads the one guide it records.
mkdir -p "$STEPFORGE_DATA_DIR/settings"
echo '{"welcomeGuideAdded": true}' > "$STEPFORGE_DATA_DIR/settings/app-settings.json"
bash /artifacts/run-in-session.sh env -u ELECTRON_RUN_AS_NODE \
  /opt/stepforge/node_modules/electron/dist/electron --no-sandbox --disable-dev-shm-usage \
  --ozone-platform=wayland --remote-debugging-port=9365 /opt/stepforge > /artifacts/app.log 2>&1 &
bash /artifacts/run-in-session.sh node /artifacts/scenario.cjs
cp /tmp/kde-desktop/{kwin-info.txt,kwin.log,pipewire.log,wireplumber.log} /artifacts/
