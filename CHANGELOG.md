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

### Fixed

- Renderer scripts no longer collide in the shared global scope (the app
  previously failed to boot with a blank window).
- Focused-view toggle persists correctly (`step.focusedView.enabled`).
- Annotation style edits no longer steal input focus on each keystroke.
- Step list stays in sync after saves and undo/redo.
- Escape deselects the active annotation instead of deleting it.

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
