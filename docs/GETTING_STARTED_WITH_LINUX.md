# Linux support

## Release-tested target

StepForge supports **Ubuntu 26.04, GNOME Shell 50, and Wayland** for normal
mouse-click workflow recording. The Ubuntu `.deb` bundles the mandatory
**StepForge Capture** GNOME Shell extension. It records regular left, middle,
and right mouse presses with red markers in GNOME logical coordinates and uses
the XDG Desktop Portal plus PipeWire for consented screen capture.

The shared application features — guide editing, annotations, local storage,
archives, imports, OCR/optional local AI, and exports — are available on this
target. Full-screen, active-window, and one-monitor region screenshots are
supported. See [the Ubuntu GNOME guide](linux/gnome-wayland.md) for install,
uninstall, privacy, and detailed recording instructions.

### Install

Download the Ubuntu `.deb` from a GitHub Release, or the
`ubuntu-26.04-gnome-test-package` artifact for a pull request. To avoid
confusing a test build with an existing production install, remove the current
package first, then verify the version after installation:

```bash
dpkg-query -W -f='Installed StepForge version: ${Version}\n' stepforge 2>/dev/null || true
sudo apt remove stepforge
sudo apt install ./stepforge_<version>_amd64.deb
dpkg-query -W -f='Now running StepForge version: ${Version}\n' stepforge
```

Log out and back in after the first installation. Start recording, enable the
extension when prompted, and share every monitor intended for recording. Use
**StepForge REC** in the GNOME top panel or the restored application window to
stop recording. Removing the package preserves guides and settings; see the
[contributor cleanup instructions](CONTRIBUTING.md#linux-testing-ubuntu-2604--gnome-wayland)
after testing a build.

### Known GNOME limitations

The extension samples GNOME's mouse-button state every 4 ms. This works for
ordinary physical mouse and touchpad clicks, but it is not a lossless hardware
event hook: a press/release completed between samples, or during a GNOME Shell
stall, can be missed. Click timestamps and positions are sample observations.

Window screenshots are crops of a shared monitor, so content occluded by
another window cannot be reconstructed and windows spanning monitors are
clipped. Regions must fit within one shared monitor. Raw typed text and
Windows UI Automation element labels are not collected on GNOME. Screen-share
consent is always required; the extension does not bypass it.

## Other Linux environments

The following paths exist but are not the release-tested GNOME Wayland target:

| Environment | Status | Recording behavior |
| --- | --- | --- |
| X11/Xorg | Legacy/developer path | `xinput` can provide click positions and markers. |
| Fedora/RHEL and other dnf systems | Packaging/developer path | See [dnf.md](linux/dnf.md); no GNOME Wayland regular-click support claim. |
| Other Wayland desktops (KDE, wlroots, etc.) | Not supported for regular global-click recording | Portal screenshots may work; use explicit captures rather than assuming click recording. |

Do not add the user to the broad `input` group to work around Wayland input
restrictions. The legacy optional mouse-only udev rule remains documented in
[`scripts/linux/enable-click-capture.sh`](../scripts/linux/enable-click-capture.sh),
but it is not used by the supported Ubuntu GNOME path and does not grant
pointer coordinates on generic Wayland.

## Development and verification

For a source checkout on Ubuntu GNOME:

```bash
bash scripts/linux/apt/install-runtime-deps.sh
npm ci
bash scripts/linux/install-gnome-extension.sh
# Log out and back in if GNOME has not discovered the extension.
npm start
```

Run the normal suite before contributing. The GNOME integration test uses a
private headless desktop and never modifies the real desktop session:

```bash
bash tests/run_test.sh
bash tests/integration/linux/gnome-shell.test.sh
npm run package:linux:deb
```
