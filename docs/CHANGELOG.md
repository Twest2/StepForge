# Changelog

All notable user-visible changes are recorded here. The format follows
Keep-a-Changelog conventions; versions follow semver.

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
  Trash, with a "Delete forever" action that permanently removes the
  selected items.

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
