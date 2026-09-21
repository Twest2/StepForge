# Getting Started

StepForge is a fully offline desktop app. Nothing is uploaded or synced, and
all guides stay on your machine.

# Installation

For Windows, see [windows_installation](windows_installation.md). For the
release-tested Linux target — Ubuntu 26.04/Fedora 44 with GNOME 50 on Wayland —
see [GNOME Wayland installation](linux/gnome-wayland.md). Other Linux desktop
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

## Empty capture drafts

Starting New Capture, or accepting the default blank New Guide title, creates
a draft. Until you save a step or edit the guide, it stays out of the library
and search, including after restarting the app. Draft data remains on disk.
Saving a title, description, metadata, or other guide change makes it a normal
library entry; it stays there even if you later remove its last step.
Existing, imported, and explicitly named guides are unaffected.
