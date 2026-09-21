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

## Generated step titles

New captures receive local, automatic titles based on the recorded action.
On Windows, StepForge prefers accessible control names, such as `Click Profile`,
`Enter Username`, or `Close "Documentation" tab in Chrome`, when available.
Password fields use a generic instruction, and existing field values are not
copied into titles. Each capture describes one action; you can edit its title
or combine instructions yourself in the editor.

Applications expose different amounts of accessibility information. If a
control cannot be identified, StepForge falls back to nearby text, the window
name, or the capture type. No AI setup is required, and existing guides and
manually edited titles are unchanged.

### Default capture focus

In Settings → Editor, use Default focus amount to choose from 1× (full context)
to 1.5× (closer focus), in 0.05 increments. Reset restores 1.5×. The setting
applies only to new automatically focused captures; existing steps and original
screenshots are preserved. Small displays retain the minimum context area.
