# Changelog

All notable user-visible changes are recorded here. The format follows
Keep-a-Changelog conventions; versions follow semver.

## [Unreleased]

### Changed

- **Click-capture pipeline rearchitected for Folge-like recording.** This is
  the milestone where fast, real-world recording works end to end: every
  mouse click during a session becomes exactly one saved step, the red
  marker lands on the exact click position (verified at 0.00% offset across
  scaled and multi-monitor displays), and the screenshot shows the screen at
  the click rather than after it.
  - Continuous capture now runs in a hidden worker process that samples a
    desktop media stream per display into a timestamped ring buffer, so the
    main process stays responsive and OS click events are never delayed by
    capture work. Falls back to the legacy in-process loop where streams
    cannot start (portal-less Wayland/WSLg).
  - Each click is paired with the newest frame captured at or before its
    hook timestamp (strict timing, `capture.strictClickFrames`, default on):
    a frame whose grab started after the click is never used.
  - Physical→DIP coordinate conversion is multi-monitor and scale-factor
    aware (`screen.screenToDipPoint` on Windows, display-geometry math
    elsewhere), fixing marker drift on displays scaled away from 100%.
  - A configurable click-lead (`capture.clickLeadMs`, default 120ms) targets
    the screen just before each click so the saved step shows what the user
    was about to act on, not the click's onset; the stream sampling cadence
    was tightened to 50ms so a frame near that target always exists.

### Fixed

- **Fast click bursts no longer lose screenshots.** Finishing or pausing a
  recording used to cancel every screenshot still being encoded, so a quick
  series of clicks saved only the first two or three. The capture worker now
  drains on stop — frames already captured for queued clicks finish encoding
  and are saved — so all clicks are recorded even on machines where PNG
  encoding takes seconds. Verified end to end: an 8-click burst followed by
  an immediate finish saves all 8.
- **Screenshots taken after the click instead of at it.** A slow PNG encode
  was being mistaken for a dead capture worker, which kicked the click over
  to a fallback that shot the screen after the click. The worker now
  acknowledges frame selection immediately and ships the encoded image
  separately, so a slow encode no longer triggers the post-click fallback.
- Windows continuous click capture now uses a low-level mouse hook instead
  of timer polling, so normal left-clicks are not missed when the app or
  target system is under load. Click captures also preserve the original
  click timestamp through the queue and choose a buffered frame from before
  the click when one is available, keeping the marker aligned with the
  click-time cursor position.

## [0.1.0] - 2026-06-10

Initial release.

### Added

- Welcome screen on launch: app title with three actions — New Capture
  (creates a guide, opens the editor, and starts a capture session),
  Existing Workspace (guide library), and Settings. The brand button
  returns to the welcome screen from any view.
- Capture menu in the editor topbar: full screen / window / region /
  3-second delay, paste image as step, import images, and capture
  session start/finish — capture no longer requires the global hotkey.
- Continuous capture sessions: steps are grabbed on every OS click where
  the platform supports it (xinput on X11, PowerShell on Windows), with
  interval auto-capture (3/5/10 s) as the always-works fallback when
  click detection or global hotkeys are unavailable (e.g. WSLg/Wayland).
  The REC bar shows the live count and trigger, with Shoot / Auto /
  Pause / Finish controls.
- Recording sessions tuck the window away once and control everything
  from a red tray icon (capture now / pause / open / finish) instead of
  hiding the window for every shot — the app stays reachable
  mid-session, opening it auto-pauses capture, and per-shot latency
  drops because the hide-repaint wait is gone. Automatic captures also
  stand down whenever the cursor is over a visible StepForge window.
- New captures and newly added steps are now selected in the editor.
- The app hides its own window during capture so screenshots show your
  work, not StepForge; hotkey captures restore the window without
  stealing focus.
- Blocks panel: add and edit informational text blocks, code blocks,
  and tables directly on a step.
- Focused-view zoom and pan sliders.
- Guide-level placeholders editor (More ▾ → Guide placeholders).
- Backups & snapshots dialog with one-click undoable restore.
- Export dialog: editable per-format options, save-as-template, and a
  template manager (rename / duplicate / delete / share as .sfglt);
  Preview now opens the generated file in the default viewer.
- Apply an annotation's style to all annotations of the same type in
  the step or the whole guide.
- Keyboard shortcuts: tool keys (S R O L A T G N B H M U C), PageUp/
  PageDown step navigation, Ctrl+= / Ctrl+- / Ctrl+0 zoom, annotation
  copy/paste (Ctrl+C/V), Ctrl+Delete deletes the step, Shift+arrows
  fast-nudge — plus a shortcuts reference dialog.
- Library guide cards now show a description preview and are larger; a
  "Select" toggle enables multi-select with a bulk action bar (select
  all, favorite/unfavorite, move to folder, delete).
- Right-click "Move to folder" on a guide no longer lists its current
  folder, and "Move to no folder" only appears when the guide is
  currently in a folder.
- Opening a guide from the library (card click, search result, or
  "Open guide" from the right-click menu) now arms a paused capture
  session for it, so the red REC bar appears immediately with a "Start
  recording" option to resume capturing more steps.
- Editor step list: a "Select" toggle enables multi-select (checkboxes)
  with a "Select all" / "Delete" bar for removing several steps at once.
- The library's "Select" toggle and bulk action bar now also work in the
  Trash, with "Restore" and "Delete forever" actions for the selected
  items.

### Fixed

- Renderer scripts no longer collide in the shared global scope (the app
  previously failed to boot with a blank window).
- Focused-view toggle persists correctly (`step.focusedView.enabled`).
- Annotation style edits no longer steal input focus on each keystroke.
- Step list stays in sync after saves and undo/redo.
- Escape deselects the active annotation instead of deleting it.
- Modal dialogs (confirm/prompt/etc.) no longer resolve as cancelled when
  an action button is clicked — `openModal`'s teardown was firing the
  dialog's default-cancel callback before the button's own resolution
  could win. This was most visible as the step "Delete" button silently
  doing nothing.
- New Capture no longer hides the app window ~1.2s after starting; a
  session now starts paused and the window only tucks away once the user
  presses "Start recording" in the capture bar, so the app doesn't vanish
  out from under you.
- The capture status bar (REC count / Shoot / Auto / Pause / Finish) is
  now shown only in the editor view; it no longer appears over the
  library when a session is still running in the background.
- Click-triggered captures now grab the cursor position at the instant of
  the click (instead of from the cache's last refresh, up to ~75ms
  earlier) and use it for the click-marker placement, and the
  click-capture cache is armed as soon as recording starts so the very
  first click is captured instantly.
- Settings no longer fails to open if `app-settings.json` or
  `placeholders.json` was previously corrupted (e.g. left containing the
  literal text "undefined" by an old bug); a corrupted file is now
  treated as empty instead of crashing the dialog, and is overwritten
  with valid JSON the next time settings are saved.
- Click captures now line up with the click. While recording, a
  continuous screen-grab loop keeps the latest frame buffered, and each
  click becomes a step from a frame grabbed at (or moments before) the
  click instant, with the marker at the click-time cursor position — a
  frame older than 600ms is never used. Fast clicks are no longer
  dropped: a click that lands while a grab is in flight waits for that
  frame instead of being discarded, and the click debounce was lowered
  from 700ms to 150ms. Pausing stops the loop and discards the buffered
  frame, so resuming can never reuse a stale pre-pause screenshot.

### Added (initial feature set)

- Guide library with folders, favorites, title + full-text search, and a
  quick-actions palette.
- Capture engine: full-screen / active-window / region capture, delay,
  pause/resume, global hotkeys, click markers, clipboard paste, image import.
- Three-pane editor: step tree with substeps, statuses, hidden/skipped steps,
  focused view, autosave, undo/redo.
- Annotation canvas: rect, oval, line, arrow, text, tooltip, numbered marker,
  blur, highlight, magnify, crop; normalized JSON scene graph.
- Rich text descriptions, informational text blocks, code blocks, tables,
  step links, and placeholders (global / guide / system scope).
- Single-file `.sfgz` share archives, linked guides with lock files,
  snapshot backups and restore.
- Exporters: JSON, Markdown, Simple HTML, Rich HTML, PDF, animated GIF,
  image bundle, DOCX, PPTX; per-format templates shareable as `.sfglt`.
- System/light/dark theming, keyboard shortcuts, settings dialog.
- Offline guarantee: zero network code paths.
