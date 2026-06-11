# StepForge

StepForge is a **fully offline**, open-source desktop app for Windows and
Linux that captures step-by-step workflows as screenshots, lets you annotate
and describe each step in a focused three-pane editor, and exports the result
to JSON, Markdown, HTML (simple and rich), PDF, animated GIF, image bundles,
DOCX, and PPTX.

It is an independent offline desktop guide-capture tool inspired by publicly
documented workflow patterns of commercial documentation tools. It contains no
third-party branding, assets, or code from those tools, and it never talks to
the network: no telemetry, no update checks, no license checks, no cloud, no
remote AI.

## Overview

The core workflow:

1. **Capture** — take full-screen, active-window, or region screenshots with
   configurable delay, pause/resume, and global hotkeys; or import images and
   paste from the clipboard.
2. **Annotate** — rectangles, ovals, lines, arrows, text, tooltips, numbered
   markers, blur, highlight, magnify, and crop on a resolution-independent
   annotation scene graph.
3. **Describe** — rich-text titles and descriptions, informational text
   blocks, code blocks, tables, step links, and placeholders.
4. **Export** — every exporter renders from the same normalized Render AST,
   so output is deterministic across formats.

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ StepForge  >  Reset Password SOP            [Capture] [Export] [Save]      │
├──────────────────┬──────────────────────────────────┬──────────────────────┤
│ Steps            │ Canvas                           │ Properties           │
│ 1 Open Users     │  ┌────────────────────────────┐  │ Title                │
│ 2 Search account │  │  [tooltip]                 │  │ [Reset password]     │
│ 3 Click Reset    │  │      ↘  ┌────────────┐     │  │ Description          │
│   3.1 Warning    │  │         │ Reset btn  │     │  │ [rich text editor]   │
│ 4 Done           │  │         └────────────┘     │  │ Text blocks          │
│ [Add Step]       │  └────────────────────────────┘  │ Step settings        │
├──────────────────┴──────────────────────────────────┴──────────────────────┤
│ Tools: [Select][Rect][Oval][Line][Arrow][Text][Tooltip][#][Blur][Hi][Crop] │
└────────────────────────────────────────────────────────────────────────────┘
```

## What's Included

- **Guide library** with folders, favorites, title search, full-text search,
  duplicate/move/delete, and a quick-actions palette (`Ctrl+/`).
- **Capture engine** — the editor's **Capture ▾** button offers full screen,
  active window, and region capture (the app hides itself during the shot)
  plus delay, pause/resume sessions with global hotkeys, click markers,
  clipboard paste, and PNG/JPEG/GIF import. The full keyboard shortcut list
  lives under **More ▾ → Keyboard shortcuts** in the editor.
- **Three-pane editor** — step tree with substeps, statuses
  (todo/in-progress/done), hidden/skipped steps, focused view (zoom/pan that
  never mutates the original image), autosave, and command-stack undo/redo.
- **Annotation canvas** — normalized JSON scene graph with
  resolution-independent coordinates; annotations render identically in the
  editor and in every exporter.
- **Sharing & backups** — single-file `.sfgz` archives (zip-based, path-
  traversal validated), linked guides with `.lock-sfgz` lock files and
  explicit save, plus automated snapshot backups and restore.
- **Exports** — JSON, Markdown, Simple HTML, Rich HTML (checkboxes + floating
  TOC), PDF, animated GIF, image bundle, DOCX, and PPTX, with per-format
  export templates shareable as `.sfglt` files.
- **Settings & theming** — system/light/dark themes, capture options,
  keyboard shortcuts, preview step count.

Everything except the Electron shell is dependency-free Node.js: the ZIP,
PNG, GIF, PDF, DOCX, and PPTX writers are all implemented in this repository
using only Node built-ins.

## Getting Started

For a shorter walkthrough, see [GETTING_STARTED.md](GETTING_STARTED.md).

Requirements: Node.js 20+ and npm (Electron is the only dependency).

```bash
npm install        # one-time, fetches the Electron shell
npm start          # launch StepForge
```

First run creates the local data directory (`~/.local/share/stepforge` on
Linux, `%APPDATA%/stepforge` on Windows; override with `STEPFORGE_DATA_DIR`).

## Testing

Please create your tests so that when the following is ran it automatically
tests your test.

```bash
bash tests/run_test.sh
```

The runner executes every `tests/checks/test_*.sh` script; those scripts run
the workflow test suites under `tests/unit/` with `node --test`. The tests
exercise real workflows — creating guides, round-tripping archives, exporting
documents, and validating the bytes of the output — not string matching.

## Building & Packaging

```bash
bash scripts/bootstrap-offline.sh   # verify toolchain availability
bash scripts/verify.sh              # full test suite + smoke checks
bash scripts/build-release.sh       # assemble runnable app directory
bash scripts/package-linux.sh       # portable tar.gz + .deb (+ AppDir spec)
npm run package:windows             # portable Windows .exe in releases/
pwsh scripts/package-windows.ps1    # same Windows portable build via PowerShell
```

See [build/build_report.md](build/build_report.md) for what was produced on
this machine and which packaging tools were unavailable.

## Offline Guarantee

The shipping app makes **zero network calls**. There is no telemetry, no
update check, no license validation, no cloud sync, no account system, and no
remote AI. Exports embed no remote fonts or CDN references. See
[SECURITY.md](SECURITY.md) for the threat model.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contribution flow,
including the issue-number requirement for every pull request and the
clean-room rules.

## Repository Layout

See [ARCHITECTURE.md](ARCHITECTURE.md) to see the repo layout.

## License

Application code is licensed under [MPL-2.0](LICENSE). Bundled example
guides, templates, and screenshots are CC-BY-4.0 unless noted otherwise.
