# prompt2.md — Finish StepForge (handoff checklist)

You are finishing a nearly-complete offline desktop app called **StepForge**
(an Electron + vanilla-JS clone of Folge, see `./prompt.md` for the full spec).
Work through the unchecked boxes below **in order**, committing after each
section. Keep every change consistent with the existing code style.

## Ground rules (do not skip)

- Run `bash tests/run_test.sh` after every section. It must stay green.
- The app must keep working: verify visually with the screenshot hook:
  ```bash
  rm -rf /tmp/sf-x && STEPFORGE_DATA_DIR=/tmp/sf-x \
    STEPFORGE_SCREENSHOT=/tmp/x.png \
    STEPFORGE_SCREENSHOT_JS="<js to run in page>" timeout 30 npm start
  ```
  Then look at /tmp/x.png. Useful JS snippets:
  - welcome: (no JS needed)
  - library: `window.stepforgeApp.openExistingWorkspace()`
  - editor: `window.stepforgeApp.startNewCapture()`
- Renderer files (`app/renderer/*.js`) are plain scripts wrapped in IIFEs.
  NEVER add top-level `const` outside the IIFE — scripts share global scope
  and duplicate consts break the whole app with a SyntaxError.
- `window.stepforge` (from `app/preload.js`) is the ONLY way the renderer
  talks to the system. New IPC = add handler in `app/main.js` `setupIpc()`
  + matching entry in `app/preload.js`.
- Annotations/steps/guides are saved through `this.saveStepDebounced()` /
  `api.step.save` in `app/renderer/editor.js`. Mutate `this.currentStep`,
  set `this.pendingSave = true`, call the debounced save.
- No network code anywhere. No new npm dependencies.
- Commit messages end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## State when this file was written

Done already (do not redo): core library (`core/`, `exporters/`, 57 unit
tests), Electron shell, library UI, three-pane editor with annotation
canvas, welcome screen (New Capture / Existing Workspace / Settings),
sample pipeline, .deb + tarball packaging, build report.

In flight (check `git status` / `git log` first — finish or fix anything
half-done): capture-service fixes and editor additions listed in sections
1–3 below may already be partially applied to `app/capture.js` and
`app/renderer/editor.js`.

## Checklist

### 1. Capture service hardening (app/capture.js) — [x] DONE
- [x] `grab('window')` requests `['window','screen']` and falls back to the
      screen source when the compositor exposes no window sources (WSLg).
- [x] `withWindowHidden(fn, {refocus})` hides the app window during capture
      (350 ms repaint pause), restores with `showInactive()` when
      `refocus:false` (hotkey path must not steal focus).
- [x] `shoot()` accepts `hideWindow`/`refocus`; `regionCapture` hides too.

### 2. Editor: blocks, focused view, shortcuts (app/renderer/editor.js) — [x] DONE
- [x] Props panel "Blocks" section: add/edit/delete text blocks
      (position/level/title/body), code blocks (language/code), table
      blocks (pipe-separated rows). Buttons `+ Text block / + Code / + Table`.
- [x] Focused-view sliders (zoom 1–3, panX/panY 0–1) shown when the
      Focused checkbox is on; write to `step.focusedView.*`.
- [x] `openCaptureMenu(event)` context menu: full screen / window /
      region / 3 s delay / paste image / import images / start-finish session.
- [x] `pasteClipboardStep()`, `shareAsFile()` (.sfgz via `api.archive.export`),
      `openBackupsDialog()`, `openGuidePlaceholders()`, `openShortcutsHelp()`,
      `applyStyleAcross('step'|'guide')` methods.
- [x] "Style → step" / "Style → guide" buttons in the annotation editor.
- [x] Shortcuts in `onDocumentKeyDown` (only when target not editable):
      tool keys s/r/o/l/a/t/g/n/b/h/m/u/c, PageUp/PageDown step nav,
      Ctrl+=/-/0 zoom, Ctrl+C/V annotation copy/paste (V falls back to
      OS-clipboard image -> new step), Ctrl+Delete delete step,
      Shift+arrows = 10px nudge.

### 3. Dialogs (app/renderer/dialogs.js) — [x] DONE — add and export via
`window.StepForgeDialogs`:
- [x] `showBackupsDialog({snapshots, onCreate, onRestore})` — list of
      snapshot names with a Restore button each, "Create snapshot" button
      on top (onCreate returns the refreshed list; re-render it).
- [x] `showPlaceholdersDialog({title, hint, values, onSave})` — key/value
      rows with add/remove, same pattern as the placeholder rows already
      inside `showSettingsDialog` (copy that code).
- [x] `showShortcutsDialog()` — static table of the shortcuts from
      section 2 plus Ctrl+S save, Ctrl+/ quick actions, Alt+arrows move step.
- [x] Extend `showExportDialog`: a "Save as template…" button
      (prompts a name, calls new `onSaveTemplate({format, name})`), and a
      "Manage…" button listing templates with rename/duplicate/delete/
      import (.sfglt)/export (use `api.templates.*`, all already exist in
      preload).

### 4. Topbar rework — [x] DONE — (app/renderer/app.js, editor branch of `renderTopbar`)
- [x] Buttons: Back | **Capture** (primary; onClick
      `this.editor.openCaptureMenu(e)`) | Save | Export | Share
      (`this.editor.shareAsFile()`) | More ▾ | guide title text.
- [x] "More ▾" opens `contextMenu` with: Rename guide / Guide
      placeholders… / Backups & snapshots… / Linked guide… / Keyboard
      shortcuts… / Settings.
- [x] Remove the old Rename/Local/Quick/Settings buttons from the topbar
      (they move into More; Quick actions stays reachable via Ctrl+/).

### 5. Main process additions — [x] DONE — (app/main.js + app/preload.js)
- [x] `export:preview` flow: after writing the preview, the renderer
      should call a new `shell.openPath` on the produced file so PDF/GIF
      previews actually open (change `onPreview` in
      `editor.openExportDialog` to call `api.shell.openPath({target: preview.file})`).
- [x] New IPC `export:defaults {format}` returning the exporter's
      DEFAULT_TEMPLATE (require the exporter module, read its export) so
      the export dialog can show editable options. Wire into preload as
      `api.export.defaults`.
- [x] Optional (only if simple): render checkboxes/number/text inputs in
      the export dialog from the defaults object (booleans -> checkbox,
      numbers -> number input, strings -> text input), pass the edited
      object as `options` to export/preview/save-as-template.

### 6. CSS (app/renderer/style.css) — [x] DONE
- [x] Ensure `.spacer { flex: 1; }` exists (block cards use it).
- [x] Style `.focused-controls`, `.blocks-list .block-card textarea`
      (full width), keep visual language consistent (existing vars:
      `--panel`, `--panel-2`, `--border`, `--accent`, `--radius`).

### 7. Verification tour + tests
- [x] Screenshot tour: welcome, library, editor (with blocks panel
      visible), capture menu open, export dialog, backups dialog. Check
      each PNG looks right; fix what doesn't.
- [x] Add a unit test `tests/unit/ipc-surface.test.js` that requires
      `app/preload.js` is impossible (electron); instead statically check:
      every `ipcRenderer.invoke('X')` channel string in preload.js has a
      matching `h('X'` handler string in main.js (read both files with fs,
      regex out the channel names, assert set equality or subset).
- [x] `bash tests/run_test.sh` green; `bash scripts/verify.sh` green.
- [x] Regenerate samples if exporter behavior changed (not needed — exporter behavior unchanged)
      (`node scripts/make-sample-guide.js`), commit changes.

### 8. Docs + final commit
- [x] Update `../docs/CHANGELOG.md` (### Added: capture menu, block editors,
      focused-view controls, shortcuts, backups dialog, template
      management, apply-style-across; ### Fixed: window-capture fallback,
      app hides itself during capture).
- [x] README: mention the capture button and shortcut list location.
- [x] Update THIS file: tick every box you completed.
- [x] Final commit.

## Testing philosophy (from ./prompt.md — do not violate)

Tests must exercise real workflows and assert on actual output (parse the
file that was produced, check the pixels/bytes/structure), NOT grep for
magic strings in source code. The IPC-surface test above is the one
allowed exception since it guards wiring, and even it should compare
extracted channel sets, not match arbitrary words.
