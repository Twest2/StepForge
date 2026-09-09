# Ubuntu 26.04 / GNOME 50 recording

StepForge's GNOME Wayland build requires the **StepForge Capture** Shell
extension. The Ubuntu `.deb` installs it alongside the application. Recording
uses regular mouse button presses with red click markers; it does not fall
back to timed captures when the extension is missing.

## Install and test

Install the `.deb` from the PR's **Ubuntu test package** artifact, or from a
GitHub Release:

```bash
sudo apt install ./stepforge_<version>_amd64.deb
```

The package targets Ubuntu 26.04 and GNOME Shell 50. It includes Electron,
the application, and the extension; apt installs the system Python/GObject,
GStreamer, PipeWire, and GNOME portal dependencies. It does not change input
device permissions or add the user to the `input` group.

Log out and back in after the first installation so GNOME discovers the new
system extension. On the first recording, StepForge offers to enable it for
your user. Extension updates may also require a new login to load the new
JavaScript. There is no need to download a separate extension from a website.

1. Open StepForge and start or open a guide.
2. Press **Start recording** and enable the extension if prompted.
3. In GNOME's screen-sharing dialog, select **every monitor** you intend to
   record. The application waits for real screen frames before recording.
4. StepForge minimizes. **StepForge REC** appears in the GNOME top panel.
5. Click normally in native Wayland or XWayland applications. Accepted clicks
   become steps with markers in the correct logical monitor coordinates.
6. Stop from **StepForge REC**, or restore StepForge from the dock and stop
   in the recording bar. Accepted captures finish saving after stopping.

Screen sharing is requested once for each recording/resume, never once per
click. Pause/stop, losing the screen share, locking the session, disabling the
extension, or exiting the app stops input observation. A missing/incompatible
extension blocks recording with an explanation. Clicks on monitors you did not
share produce an explicit error instead of a screenshot of another monitor.

## What is and is not Windows parity

The guide editor, storage, annotations, archives, OCR/optional AI, and exports
are shared with Windows. The existing Windows capture service is unchanged.
GNOME uses a separate capture subclass and system helper.

The GNOME extension samples the compositor's mouse-button state every **4 ms**
while recording. This works for normal mouse presses, including native
Wayland applications. It never grabs input, reinjects input, or reads keyboard
events. Ordinary Shell `captured-event` handlers alone are insufficient:
Mutter consumes native-client events before these handlers receive them.

Sampling is **not a hardware mouse hook**. A complete press/release between
samples, or a GNOME Shell stall covering an entire click, can be missed.
Coordinates and timestamps are observations at sample time. Do not claim
lossless hardware-event timing or exact parity for very short synthetic clicks.
The normal 200 ms click debounce matches the existing Windows default; set
`capture.clickDebounceMs` to zero to retain rapid observed presses individually.

The helper pairs clicks to preceding frames in memory and encodes only the
selected frames. Frame timestamps describe when the helper observed a frame,
not the hardware presentation timestamp. The app does not silently substitute
a post-click screenshot when strict timing cannot find a preceding frame.

Active-window captures crop the shared monitor to GNOME's focused-window
geometry. An occluded area cannot be reconstructed from a monitor stream;
windows spanning monitors are clipped to the captured monitor. Region capture
uses GNOME's native area selector and supports a region within one shared
monitor. Browser/UI-element labels and raw typed-text collection are not
implemented by this companion. The extension transports focused-app name and
window title, not Windows UI Automation data.

Global shortcut availability depends on the Electron/GNOME combination. The
panel and dock controls remain available to stop recording regardless of
shortcut registration. The experimental Electron GlobalShortcutsPortal flag is
not enabled: it crashed this Electron 41/GNOME 50 session while exporting a
Wayland surface. Capture itself uses the independent GNOME companion/helper.

## Source checkout

```bash
bash scripts/linux/apt/install-runtime-deps.sh
npm ci
bash scripts/linux/install-gnome-extension.sh
# Log out and back in if GNOME has not discovered the extension yet.
npm start
```

Only the source-install script writes to the current user's extension
directory. The packaged extension lives in
`/usr/share/gnome-shell/extensions/stepforge@twestbrook.com`. Avoid keeping an
old per-user copy when testing package updates: GNOME can prefer that copy
over the system installation.

## Implementation map

- `app/platform/capture-service.js` selects the GNOME subclass only for Linux
  Wayland GNOME/Ubuntu sessions. Windows still selects `app/capture.js`.
- `app/platform/linux/gnome-capture.js` handles lifecycle, first-run enablement,
  logical-coordinate marker placement, cropped captures, and storing steps.
- `app/platform/linux/portal-backend.js` manages the helper process, bounded
  requests, cancellation, and draining selected images on stop.
- `app/platform/linux/portal_capture.py` owns the consented XDG ScreenCast
  session, restricted PipeWire file descriptors, RGB rings, and PNG encoding.
  It uses distribution-provided libraries; there are no new npm dependencies.
- `gnome-extension/stepforge@twestbrook.com/` exports protocol version 1 on
  `/org/stepforge/Capture`, interface `org.stepforge.Capture1`, through
  `org.gnome.Shell`. Click signals are unicast to the connection that started
  the session. Other connections cannot stop that session. Losing the owner
  connection removes the sampler and recording indicator.

The local session bus is the trust boundary. This interface is not intended
to protect against a malicious process already running as the same user. It
does not expose a network endpoint, event log, arbitrary filesystem operation,
keyboard feed, or bypass for screen-sharing consent.

## Verification

```bash
bash tests/run_test.sh
bash tests/integration/linux/gnome-shell.test.sh
npm run package:linux:deb
```

The GNOME integration test uses a private headless compositor, D-Bus session,
temporary configuration, and a test-only virtual pointer. It does not inject
input into or enable extensions in the real desktop. It requires the GNOME 50
runtime, GTK 4/AT-SPI introspection, PipeWire, and WirePlumber.

Manual testing should cover physical mouse and touchpad presses, rapid clicks,
125%/150% scaling, secondary monitors, screen-share cancellation, pause/resume,
screen lock, extension disablement, and a GNOME update followed by re-login.

The manual **Release** GitHub workflow builds the Windows installer and the
Ubuntu package independently, then attaches both plus Linux checksums and a
Linux archive to the same release. Linux artifacts use `buildVersion`, matching
the requested four-component release version. The Linux package can be built
on an older Ubuntu runner because the bundled Electron binary and Python
source are not compiled against that runner's GNOME; installation is gated
to GNOME 50 by Debian dependencies.
