# Getting Started

StepForge is a fully offline desktop app. Nothing is uploaded or synced, and
all guides stay on your machine.

# Installation

For Windows, see [windows_installation](windows_installation.md). For the
release-tested Linux target — Ubuntu 26.04/Fedora 44 with GNOME 50 on Wayland —
see [Linux Installation](linux/linux_install.md). Other Linux desktop
paths are documented as developer/legacy paths, not release-tested targets.

# Developer install

## 1. Install

Install the pinned Node toolchain first — Node 22.12 or newer (see
`.nvmrc`; with nvm: `nvm install && nvm use`). Installs are refused on
older Nodes.

From the repository root:

```bash
npm ci
```

That installs the locked dependency tree — Electron and the local packaging
tools used by the scripts. `npm ci` is the only supported installation path;
the app never installs or repairs dependencies at runtime.

## 2. Launch the app

```bash
npm start
```

In the guide editor, click **Select**, click a step, then **Shift-click** another
step or checkbox to select the inclusive range, including substeps. Existing
selections outside the range remain selected. An ordinary click toggles one step
and sets the starting point for the next range. Clear or leave Select mode to
reset the selection.
