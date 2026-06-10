# Changelog

All notable user-visible changes are recorded here. The format follows
Keep-a-Changelog conventions; versions follow semver.

## [0.1.0] - 2026-06-10

Initial release.

### Added

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
