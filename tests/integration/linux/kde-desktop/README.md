# Full Plasma desktop integration

This opt-in test installs the built Debian package in Ubuntu 26.04 with a full
Plasma desktop. KWin uses a virtual 1280×900 output and Mesa llvmpipe. The test
uses the real KDE sharing dialog, PipeWire stream, KWin companion, shortcut
portal, tray and Spectacle selector. CDP supplies trusted mouse input to the app;
KDE's test input protocol supplies desktop clicks, shortcuts and region drags.
The only capture input fixture is a private mouse FIFO and discovery table.
No capture APIs or stored guide contents are mocked.

Run on a disposable Linux Docker host with a DRM render node. A machine without
a GPU can use the kernel's `vgem` module (`modprobe vgem`). The test container is
privileged to mount its private input table and access the DRM node. It must
never share a real desktop's Wayland socket, D-Bus bus or input directory.

From the repository root, after `npm run package:linux:deb`:

```bash
context=$(mktemp -d)
cp -r tests/integration/linux/kde-desktop "$context/fixture"
cp "$context/fixture/Dockerfile" "$context/Dockerfile"
# Substitute the package's output path if using STEPFORGE_PACKAGE_DIR.
cp build/artifacts/stepforge_0.3.2.1_amd64.deb "$context/stepforge.deb"
docker build -t stepforge-kde-desktop-test "$context"
artifacts=$(mktemp -d)
docker run --rm --privileged --shm-size=1g \
  -v "$artifacts:/artifacts" stepforge-kde-desktop-test
```

An exit status of zero requires fullscreen/window captures, pre-click pixel and
marker checks, both shortcuts, pause/resume, right-click capture, tray filtering,
region selection and cancellation. `desktop-test-results.json`, screenshots,
the saved guide and compositor logs remain in the artifact directory. The test
uses a fixed desktop layout; changing its resolution or panel needs fixture
coordinate updates. It does not exercise physical touchpad hardware, seat ACLs
or mixed-scale physical monitors; separate package/helper tests cover their
rules and event/geometry handling.
