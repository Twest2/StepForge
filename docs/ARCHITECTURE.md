# Architecture

StepForge is split into a **dependency-free Node.js core** and a thin
**Electron desktop shell**. All product logic lives in `core/` and
`exporters/` and runs (and is tested) headlessly with plain `node`. The shell
in `app/` only provides the window, the canvas UI, screen capture, hotkeys,
and the clipboard.

## Repository Layout

```text
app/            Electron shell: main process, preload bridge, renderer UI
core/           Dependency-free domain logic (schema, store, archive, search,
                placeholders, render AST, png/gif/pdf/zip primitives, locks,
                snapshots, settings)
exporters/      One module per output format, all consuming the Render AST
scripts/        bootstrap / verify / build / package scripts (sh + ps1)
tests/
  run_test.sh   entrypoint — runs every tests/checks/test_*.sh
  checks/       shell wrappers that invoke the node test suites
  unit/         node:test workflow suites
  fixtures/     test images and guides
examples/       sample guide + sample exports
assets/         app icon and packaged static assets
build/          agent_audit.md, build_report.md, artifacts_manifest.json
docs/           file-format and data-model documentation
vendor/         reserved for vendored deps (reuse only; nothing fetched)
```

## Data Model

Internal working storage is **folder-based**; sharing/backups use a
**single-file zip archive** (`.sfgz`).

```text
<data root>/                      (~/.local/share/stepforge, %APPDATA%/stepforge,
  settings/                        or $STEPFORGE_DATA_DIR)
    app-settings.json
    placeholders.json             global placeholders
    templates/<format>/<name>.template.json
  library/
    folders.json                  folder tree + guide->folder mapping
    guides/<guide-id>/
      guide.json                  guide metadata (schema below)
      steps/<step-id>/
        step.json
        original.png              never mutated after capture
        working.png               crop target; annotations stay vector JSON
      history/snapshots/*.zip     automated + manual backups
    index/search-index.json       inverted full-text index
  temp/                           previews; cleaned on close
  shared-links/                   linked-guide registry
```

- `guide.json` — schemaVersion, guideId, title, descriptionHtml,
  placeholders, flags (focusedViewDefault, ...), stepsOrder, favorite,
  linkedSource, exportProfiles, createdAt/updatedAt.
- `step.json` — stepId, parentStepId, kind (`image | empty | content`),
  status (`todo | in-progress | done`), title, descriptionHtml, hidden,
  skipped, focusedView {enabled, zoom, panX, panY}, image paths + size,
  `annotations[]` (normalized scene graph, coordinates in 0..1 fractions of
  the image), textBlocks[], codeBlocks[], tableBlocks[], links[].

All writes are **atomic** (write to `*.tmp`, fsync, rename). Deleting a guide
moves it to `library/trash/` first.

## Annotation Scene Graph

Annotations are stored as normalized JSON, never as an editor-library blob.
Coordinates are fractions of the image (resolution-independent). Types:
`rect, oval, line, arrow, text, tooltip, number, blur, highlight, magnify,
cursor`. The same geometry is rendered by the editor canvas (HTML5 canvas)
and by the export rasterizer (`core/raster.js`), so what you see is what
exports.

## Render Pipeline

```text
guide.json + step.json + settings
        │ core/renderast.js  (placeholder expansion, numbering, filtering
        ▼                     hidden/skipped, focused-view geometry)
   Render AST  ──► exporters/json.js        .json + steps-<title>/ images
               ──► exporters/markdown.js    .md  + steps-<title>/ images
               ──► exporters/wikijs.js      .md  + steps-<title>/ images
               ──► exporters/html-simple.js single self-contained .html
               ──► exporters/html-rich.js   checkboxes + floating TOC
               ──► exporters/pdf.js         native PDF writer (core/pdf.js)
               ──► exporters/gif.js         GIF89a encoder (core/gif.js)
               ──► exporters/image-bundle.js annotated PNGs + metadata
               ──► exporters/docx.js        zip+XML (core/zip.js)
               ──► exporters/pptx.js        zip+XML (core/zip.js)
```

Image-bearing exporters rasterize annotations with `core/raster.js` on top of
PNG pixels decoded by `core/png.js`. Every exporter accepts a template object
(per-format settings persisted under `settings/templates/`, shareable as
`.sfglt` zip files).

## Shell / Core Boundary

The renderer never touches the filesystem. `app/preload.js` exposes a typed
IPC API (`stepforge.*`), and `app/main.js` routes calls into `core/`. Screen
capture uses Electron's `desktopCapturer` (full screen, window) and an
overlay window for region selection; hotkeys use `globalShortcut`.

## Click-Capture Pipeline

Workflow recording must behave like one click → one step, with the
screenshot showing the screen *at* the click and the marker on the exact
click position. Three pieces make that hold:

1. **OS click events** (`app/capture.js`): a low-level mouse hook on Windows
   (`CLICK x y button unixMs` lines), an `xinput test-xi2 --root` watcher on
   X11. The Linux parser carries event-time `root:` coordinates and merges
   raw/regular twin blocks structurally — there is no time-based debounce
   that could drop fast clicks, only suppression of identical duplicate
   deliveries. Physical coordinates convert to DIP via
   `screen.screenToDipPoint` on Windows or display-geometry math in
   `app/coords.js` elsewhere (multi-monitor and scale-factor aware).

2. **Frame recorders**: while recording, a hidden worker window
   (`app/stream-backend.js` + `app/renderer/capture-worker.js`) samples a
   desktop media stream per display into a timestamped ring buffer —
   entirely off the main process, so click delivery is never delayed by
   capture work, and PNG encoding happens in the worker. If streams can't
   start (portal-less Wayland), or the worker stops answering, the service
   degrades to the legacy in-process `desktopCapturer` loop.

3. **Click ↔ frame pairing** (`app/click-frames.js`, shared by the main
   process, the worker, and tests): each click is paired *at event time*
   with the newest frame captured at or before its hook timestamp. In strict
   mode (`capture.strictClickFrames`, default on) a frame whose grab started
   after the click is never used — when nothing qualifies, the service takes
   an explicit fresh shot instead of passing a post-click frame off as the
   click-time screen. Storing is serialized per click; pairing is not, so
   slow encodes never skew later clicks.

Reliability rules that keep "one click → one step" true under load:

- **The worker reply is two-stage.** It acknowledges frame *selection*
  within milliseconds (proving liveness and pinning the pairing), then
  ships the PNG whenever the encode finishes — seconds later on
  software-rendered hosts. A slow payload is never mistaken for a dead
  worker; only a missing ack degrades the backend.
- **Stopping drains.** Finishing or pausing a recording keeps the worker
  alive until frames already selected for queued clicks finish encoding.
  Without this, ending a session right after a fast click burst cancelled
  every still-encoding frame and those clicks vanished (the "I clicked ten
  times but only got two screenshots" bug).
- **Queued clicks outlive the session.** A click registered while recording
  carries its guide id and still becomes a step if the session ends while it
  waits in the store queue. The lone exception is the tray gesture that
  stopped the session, discarded by matching its recorded screen position.
- **A click is never served another monitor's frame.** If the clicked
  display has no ready stream the backend returns null and the caller
  fresh-shots the correct screen, rather than circling a point on the wrong
  one.

`STEPFORGE_CLICK_SELFTEST=1 npm start` exercises the whole pipeline in a
real Electron session across four scenarios — marker accuracy (0.00%
offset), a fast-burst-then-finish that must save every click, the
warm-before-arm first click, and the ~200ms debounce. It runs automatically
as `tests/checks/test_click_capture_selftest.sh` (skipped only when the host
has no capture environment), so a regression in click→screenshot→step
behavior fails the suite. `STEPFORGE_CAPTURE_LOG=1` prints one diagnostic
line per click decision.

## Security Rules

- Zero network code paths: no sockets, no telemetry, no update or license
  checks, no remote fonts in exports.
- Archive imports validate every entry name against path traversal and
  absolute paths before extraction (`core/zip.js`).
- Linked guides use sidecar `*.lock-sfgz` lock files; conflicts surface a
  keep-editing / discard dialog and last-write-wins is documented.
- Renderer runs with `contextIsolation: true`, `nodeIntegration: false`,
  and `sandbox` enabled; only the preload API is exposed.

## Workflow

1. Change core/exporter logic together with its workflow tests in
   `tests/unit/`.
2. Put shell checks in `tests/checks/` so the shared runner picks them up.
3. Run `bash tests/run_test.sh` locally.
4. Open a pull request so CI can verify on PR open.
