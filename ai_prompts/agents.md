# StepForge: detailed project guide for contributors and agents

## Purpose and product promise

StepForge is a local-first desktop application for turning a real on-screen
workflow into a clear, shareable, step-by-step guide. A person performs a task
in another application, StepForge captures the relevant screen states, and the
person refines those captures into instructions with annotations and rich text.
The completed guide can then be exported as documents, web pages, image sets,
or structured data.

The core user experience is deliberately focused:

1. Start a guide and record a workflow.
2. Each capture becomes a step in a visual guide.
3. Add or revise titles, descriptions, callouts, arrows, blur, crops, and
   other annotations.
4. Reorder, group, skip, hide, or supplement steps with text/code/table
   content.
5. Export the same guide in the format appropriate for the recipient.

The project is privacy-oriented and local-first. It has no telemetry, update
checks, licence checks, account system, cloud sync, or automatic network
traffic. Guides, screenshots, search indexes, backups, and exports remain on
the user’s computer. The one deliberate outbound feature is an optional,
user-configured Ollama integration for titles/descriptions; it defaults to a
loopback endpoint and requires an explicit opt-in for a remote AI host.

StepForge is an independent implementation inspired by public workflow
documentation patterns. Do not add third-party branding, proprietary assets,
or copied code to this project.

## What it looks like

The visual design is an efficient desktop workbench rather than a marketing
dashboard. The app uses system/light/dark themes and a restrained panel-based
layout.

- A thin top bar contains the **StepForge** library/home control, contextual
  guide information, a red pill-shaped recording indicator when a session is
  active, and a global guide search field. The search hint advertises
  `Ctrl+/` for Quick Actions.
- The library/welcome view introduces the app as a private tool to “Capture,
  annotate, and export step-by-step guides.” It presents clear entry points
  such as **New Capture** and **Settings**.
- The editor is a three-pane workspace: a step tree on the left, the large
  image/annotation canvas in the middle, and a properties/details panel on
  the right. This is the primary product surface.
- The left step tree represents image, empty, and content steps, including
  substeps and their status. It supports a guide-library workflow with
  folders, favorites, search, duplicate/move/delete, and Quick Actions.
- The centre canvas is WYSIWYG: screenshots are the visual substrate and
  annotations are drawn directly over them. A canvas toolbar exposes the
  editing tools.
- The right pane edits the selected step’s title, rich description, status,
  visibility, focused view, annotation properties, and supporting blocks.
- While recording, the red REC control plainly states the active trigger
  (for example “on click”, “hotkey”, or an interval), shows the captured-step
  count, and provides Start/Pause/Stop controls. On Linux, the application
  uses slightly tighter top-bar spacing to fit desktop conventions.

The UI is intentionally practical and compact: it should make creating an
SOP, support article, onboarding guide, or bug-reproduction guide feel like
editing a visual document, not configuring a complicated recorder.

## User-facing capabilities

### Capture

StepForge can create steps from:

- Full-screen, active-window, and region screenshots.
- Continuous recording sessions.
- Clipboard paste and imported PNG/JPEG/GIF images.
- Configurable capture delays and global shortcuts.
- A click trigger where the operating system safely exposes it.
- A capture hotkey or timed interval when global clicks cannot be observed.

During a continuous session, a dedicated hidden capture-worker renderer keeps
a timestamped ring buffer of screen frames. A captured click is paired with
the newest frame from at or before the click, preventing a guide from showing
the post-click result as though it were the state at the moment of interaction.
The capture path serializes saving but not click/frame pairing, so slow PNG
encoding does not shift later clicks. It also drains accepted clicks when a
session finishes so fast final interactions are not silently lost.

### Editing and annotations

Screenshots are never destructively painted with editor state. Each step keeps
an immutable `original.png`, a crop target (`working.png`), and a normalized
JSON annotation scene graph. Coordinates are fractions of the image rather
than fixed pixels, so an annotation remains aligned when the guide is shown
or exported at a different resolution.

Supported annotation types are rectangles, ovals, lines, arrows, text,
tooltips, numbered markers, blur, highlight, magnify, and cursor markers.
The editor supports undo/redo, zoom/pan, and focused view. Focused view is a
non-destructive crop/zoom presentation setting; it does not change the
original screenshot.

Steps can include rich descriptions plus informational text blocks, code
blocks, tables, links to other steps, and placeholders. Step state includes
todo/in-progress/done status, hidden/skipped state, and parent/substep
relationships.

### Guide management and resilience

The guide library supports folders, favorites, title and full-text search,
duplicate/move/delete, and a command palette at `Ctrl+/`. Local edits
autosave. The working store uses atomic writes (`.tmp`, fsync, rename), and a
deleted guide first moves to a trash location.

Guides can be shared or backed up as `.sfgz` files, which are validated
zip-based archives. Linked guides use a sidecar `.lock-sfgz` lock file and an
explicit save flow. Snapshot backups and restore are built in.

### Export model

Exporters do not independently interpret raw editor state. `core/renderast.js`
normalizes a guide into a Render AST after placeholder expansion, numbering,
hidden/skipped filtering, and focused-view geometry. Every exporter consumes
that AST. This is why the visible guide and the output formats remain
consistent.

Available formats are JSON, Markdown, Simple HTML, Rich HTML, PDF, animated
GIF, image bundles, DOCX, and PPTX. Export templates are per format and may
be shared as `.sfglt` archive files. The recommended mature export paths are
Markdown and PDF; several other formats remain marked WIP in product docs.

## Architecture and repository map

The application is an Electron shell around a dependency-free Node.js core.
Ubuntu GNOME capture additionally uses a distribution-provided Python/GObject
helper with GStreamer and PipeWire; these are Linux package dependencies, not
new npm dependencies. The mandatory GNOME 50 extension is bundled in the `.deb`.
The renderer never receives direct filesystem access. `app/preload.js` exposes
a narrow IPC surface, and `app/main.js` performs privileged work.

```text
app/                         Electron main process, preload bridge, renderer,
                             capture service, platform adapters
  renderer/                  HTML/CSS/JavaScript three-pane UI and canvas
  platform/                  platform facade and OS-specific adapters
  capture.js                 session lifecycle, input triggers, frame pairing
  stream-backend.js          worker-backed screen-frame capture
core/                        domain model, storage, archives, render AST,
                             rasterization, search, settings, image/document
                             primitives
exporters/                   one AST consumer for each export format
packaging/linux/             Debian/Fedora package assets and scripts
scripts/linux/               runtime/build dependency helpers and opt-in input
                             access setup
docs/                        product, architecture, privacy, security, Linux
                             installation, and contributor documentation
tests/unit/                  node:test behavior and workflow tests
tests/checks/                shared shell test entry points
examples/                    a sample guide and representative exports
ai_prompts/                  durable agent/contributor handoffs, including
                             this document
```

The on-disk data root is normally `~/.local/share/stepforge` on Linux and
`%APPDATA%/stepforge` on Windows, or it can be set with `STEPFORGE_DATA_DIR`.
Within it, settings, templates, library folders, guide folders, guide steps,
snapshot history, a search index, temporary preview data, and shared-guide
metadata are kept separately.

## Linux and Ubuntu GNOME Wayland status

### Current implementation

**Updated for the GNOME 50 implementation:** Ubuntu 26.04 uses the mandatory
StepForge Capture extension, a separate `GnomeCaptureService` subclass, and a
Python/GStreamer portal helper. See [the GNOME guide](../docs/linux/gnome-wayland.md)
for installation, protocol, verification, and exact limitations. The earlier
generic Wayland fallback described below is retained for other desktop paths;
GNOME recording does not silently fall back to evdev, hotkeys, or a timer.

`app/platform/capture-service.js` selects the subclass only on Linux Wayland
GNOME/Ubuntu. Windows continues to instantiate the original `app/capture.js`.
The new helper obtains monitor origins/sizes from the portal, buffers bounded
RGB frames, and performs PNG encoding on worker threads. Clicks are paired
before storing and remain assigned to their original guide across stop/restart.
Screen-share cancellation and companion failures are surfaced in the UI.

Linux support is already present but intentionally labelled WIP. Debian/Ubuntu
and Fedora packaging paths exist. The Linux launcher enables Electron’s
PipeWire capture feature and uses the automatic Ozone platform selection.
At startup, StepForge detects the session type, portal/D-Bus/PipeWire signals,
X11 utilities, readable input devices, and the available capture profile.
The user can inspect this in **Settings → Diagnostics**.

On Ubuntu GNOME Wayland, screen sharing is based on the XDG Desktop Portal and
PipeWire. A recording session opens a portal picker where the user chooses the
screen to share; the chosen stream remains open for the session. This is the
correct, user-consented Wayland model. It is not necessary, safe, or desirable
to bypass the portal for routine screen capture.

The current Linux input behavior is deliberately honest:

| Session and input source | Per-click step | Click coordinate / red marker |
| --- | --- | --- |
| Windows low-level hook | Yes | Yes |
| X11 with `xinput` | Yes | Yes |
| Ubuntu 26.04 / GNOME 50 with the required extension | Yes, sampled button transitions | Yes, sampled logical coordinates |
| Wayland baseline | No; hotkey or timer is used | No |
| Wayland with the optional mouse-only evdev rule | Yes | No |

The optional `scripts/linux/enable-click-capture.sh` path installs a
least-privilege udev rule using session-scoped `uaccess` ACLs for mouse devices
only. It explicitly excludes keyboards. Never replace this with membership in
the broad `input` group: that would expose all input devices, including the
keyboard, and creates an unnecessary permanent keylogging surface.

### Can GNOME Wayland reach Windows-equivalent behavior?

**The full product can work on GNOME Wayland, but exact Windows-equivalent
global click capture with an accurate red marker is not available to a normal
unprivileged Wayland application.** This is a Wayland security boundary, not
a missing Electron switch. A normal app can obtain a consented screen stream
through the portal. It cannot generally observe every other application’s
clicks and pointer coordinates.

The current Wayland baseline is therefore viable for real documentation work:

- Screen capture through the portal.
- Manual/hotkey capture.
- Timed recording fallback.
- Per-click capture without a location marker for users who explicitly grant
  mouse-device access through the narrow udev rule.
- All editor, storage, annotation, search, archive, and export behavior.

### Mandatory GNOME extension: current product decision

The user has chosen a mandatory extension for GNOME Wayland recording. It is
installed with the Ubuntu package and enabled per user. The application waits
for the extension and portal streams before recording; absence or failure
blocks recording. Editing and exporting remain available.

The GNOME 50 companion samples compositor mouse state every 4 ms. Mutter
consumes native-client events before ordinary Clutter event handlers see them,
so do not replace this with a `captured-event`-only implementation. This is
sampling, not a Windows-equivalent hardware hook: complete clicks between
samples or during Shell stalls may be missed, and position/time are measured
at observation. Never advertise lossless or hardware-exact parity.

The extension sends coordinates, button number, sample time, and focused-window
context as unicast D-Bus signals to the connection that owns the recording.
It collects no keyboard events, grants no input-device permissions, and retains
no input log. A top-panel REC control is visible while sampling. Stop, owner
disconnect, extension disablement, and session locking end observation.

That route has meaningful costs and must not be treated as a universal Linux
solution:

- It is GNOME-specific; it does not solve KDE, wlroots compositors, or other
  Wayland desktops.
- Shell extension APIs and internals can change with GNOME releases, creating
  a compatibility and maintenance matrix.
- It is privileged by design. The extension must request only the minimum
  shell access, be transparent about what it observes, send no keyboard data,
  retain no event history, and operate only while the user explicitly records.
- It needs its own install/update/review/support story and an actionable
  blocking error when absent or incompatible (not a recording fallback).
- A GNOME extension should never be used to silently bypass portal consent for
  screen capture; screen frames should continue to come from the XDG portal.

Do not make this companion optional for GNOME recording without a new user
decision. Maintain the GNOME 50 compatibility boundary and ship the application
and extension together. The manual Release workflow must produce both Windows
and Ubuntu artifacts, and PR CI should provide an Ubuntu package for testing.

## Engineering constraints

1. Do not alter Windows code while investigating or implementing Linux/GNOME
   work unless the user explicitly requests a cross-platform change and the
   change is demonstrably required.
2. Keep platform-specific behavior behind `app/platform/` or Linux-specific
   capture/packaging modules. Do not weaken the core/export pipeline for an
   OS-specific feature.
3. Preserve the renderer/main-process security boundary: context isolation,
   renderer sandboxing, and narrow preload IPC are intentional.
4. Preserve the no-network default. Any optional AI behavior must remain
   explicit, documented, and local-by-default.
5. Do not claim Wayland supports coordinate-aware global clicks unless the
   active source truly provides them. The capture UI and diagnostics must
   accurately state the trigger and whether a marker can be produced.
6. Treat `/dev/input` access as sensitive. Never add a solution that grants
   keyboard access merely to support mouse click capture.
7. Keep `original.png` immutable and annotations normalized. Avoid baking
   editor-only image modifications into the original capture.
8. Add behavioral workflow tests for any feature. Tests should exercise real
   outcomes, not merely assert the presence of a phrase or implementation
   detail.
9. Run `bash tests/run_test.sh` for changes. `bash scripts/verify.sh` is the
   broader verification path when packaging/smoke checks are relevant.

## Useful commands

```bash
npm ci                         # install the locked Node/Electron toolchain
npm start                      # launch the application
bash tests/run_test.sh         # run all shared test checks
bash scripts/verify.sh         # broader test and smoke verification
npm run package:linux:deb      # build the Debian/Ubuntu package
npm run package:linux:rpm      # build the Fedora package
```

Node.js 22.12 or newer is required. Package/runtime Linux dependencies are
documented in `docs/linux/apt.md` and `docs/linux/dnf.md`; GNOME/Wayland
behavior and limitations are documented in
`docs/GETTING_STARTED_WITH_LINUX.md`.
