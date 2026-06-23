# Getting Started

StepForge is a fully offline desktop app. Nothing is uploaded or synced, and
all guides stay on your machine.

# Windows installation

For the windows installation, please see [windows_installation](windows_installation.md)

# Developer install

## 1. Install

From the repository root:

```bash
npm install
```

That installs Electron and the local packaging tools used by the scripts.

## 2. Launch the app

```bash
npm start
```

The first launch creates the local StepForge data directory. On Linux it is
usually under `~/.local/share/stepforge`. On Windows it is usually under
`%APPDATA%/stepforge`.

## 3. Create your first guide

In the library view:

1. Click `New guide`.
2. Give the guide a clear title (more -> rename guide).
3. Open the guide to enter the editor.

You can also import a guide archive with `Import archive` if you already have
one.

## 4. Add content

There are three simple ways to start:

1. Record your workflow by clicking on the record button (reconmmended).
2. Import screenshots with the `Import` button in the editor.
3. Paste an image from the clipboard if you already copied one.

If you want to capture new screenshots, open `Quick` actions and start a
capture session. Use `Settings` to set the capture hotkey and other capture
options.

## 5. Edit the guide

The editor is split into three panes:

1. Steps on the left
2. Editing canvas in the center
3. Properties on the right

Use the canvas tools to add shapes, arrows, text, blur, highlight, numbers,
and crops. Use the right pane to edit the step title, description, and
annotation details.

## 6. Save and export

Use these actions from the top bar:

1. `Save` writes the guide to disk.
2. `Export` opens format choices such as JSON, Markdown, HTML, PDF, GIF,
   image bundle, DOCX, and PPTX.
3. `Linked` shows archive details when a guide is linked to a shared `.sfgz`
   file.

If you want to find commands quickly, press `Ctrl+/` for Quick Actions.

## Useful shortcuts

1. `Ctrl+/` opens Quick Actions
2. `Ctrl+S` saves the current guide
3. `Ctrl+Z` undoes the last edit
4. `Ctrl+Shift+Z` redoes the last edit
5. `Alt+Up` and `Alt+Down` move the selected step

## If something is missing

1. Open `Settings` to review capture, export, and editor options.
2. Run `npm run sample` to generate a sample guide and exported examples.
3. Run `bash scripts/verify.sh` to check the full offline workflow.

## Optional builds

1. `bash scripts/build-release.sh` assembles the offline release layout.
2. `npm run package:windows` creates the Windows installer `.exe` in
   `releases/`.
3. `bash scripts/package-linux.sh` creates Linux release artifacts.
