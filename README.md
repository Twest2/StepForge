# StepForge

StepForge is a **local-first**, open-source desktop app for Windows,
Ubuntu 26.04, and Fedora 44 Workstation with GNOME 50 on Wayland. It captures step-by-step workflows as screenshots, lets
you annotate and describe each step in a focused three-pane editor, and
exports the result to Markdown, DOCX, PPTX, PDF, HTML (WIP), GIF (WIP),
confluence (WIP), Wiki.js (WIP), and image bundles (WIP). The current
reconmendations for exporting is Markdown and PDF.

It is an independent desktop guide-capture tool inspired by publicly
documented workflow patterns of commercial documentation tools like Folge. It
contains no third-party branding, assets, or code from those tools.

**Network and privacy contract.** StepForge has no telemetry, no update
checks, and no license checks. Optional Google Drive sharing is **off by
default**; choosing Sign in with Google and granting access synchronizes your guides
between computers. See [Google Drive setup and testing](docs/GOOGLE_DRIVE.md).
The **optional** AI integration is also off by default: when *you* enable it and configure an [Ollama](https://ollama.com)
endpoint, StepForge sends step screenshots and text to that endpoint to
generate titles and descriptions. By default that endpoint must be **local
(loopback)**; sending data to a remote host requires the explicit "Allow
remote AI host" opt-in. See [docs/PRIVACY.md](docs/PRIVACY.md) for exactly
what is collected and sent. Note that OCR (Tesseract) and its English language
data are bundled production dependencies — Electron is not the only one.

## Installation

For Windows, install and update StepForge with Chocolatey:

```powershell
choco source add --name=stepforge --source=https://packages.twestbrook.com/nuget/stepforge-choco/
choco install stepforge --source=stepforge -y
```

See [StepForge on Windows with Chocolatey](docs/windows/chocolatey.md) for updating and uninstalling, or the [Windows installation guide](docs/windows_installation.md) to install manually from GitHub Releases. For a more detailed developer setup and source walkthrough, see [Getting Started](docs/GETTING_STARTED.md).

For Linux, StepForge currently provides native packages for **Ubuntu 26.04** and **Fedora 44 Workstation**, with GNOME 50 Wayland as the primary supported desktop environment.

See the [Linux installation guide](docs/linux/linux_install.md) for:

* Ubuntu installation through APT or a downloaded `.deb`
* Fedora installation through DNF or a downloaded `.rpm`
* Portable Linux builds
* Running StepForge directly from source
* Linux capture setup and GNOME Wayland notes

The Ubuntu and Fedora packages include the required StepForge GNOME integration for click-based recording and marker placement.


**Manual**

Requirements: Node.js 22.12+ and npm (pinned in `.nvmrc`; installs are
refused on older Nodes because the packaging toolchain needs 22.12+).

```bash
npm ci             # one-time, installs the locked dependency tree
npm install
npm start          # launch StepForge
```

## Overview

StepForge is a free and open-source alternative to documentation tools like Folge. It automatically creates step-by-step documentation as you work, reducing the need to manually write instructions and capture screenshots.

Whether you're documenting a workflow, setting up a development environment, creating a tutorial, or recording a process, StepForge captures screenshots and generates organized steps as you go. This makes creating clear, visual documentation significantly faster and easier.

## What problem does this app solve?

Creating good documentation is often slow, tedious, and easy to neglect. People have to stop what they're doing to take screenshots, write instructions, organize steps, and format everything afterward.

Because of that extra effort, documentation often contains too few screenshots or relies heavily on instructions like “click here” or “select this option.” Without a visual showing exactly where to click, those instructions can be confusing—especially for someone unfamiliar with the software or workflow.

StepForge solves this by capturing screenshots and recording each step as the process happens. This makes it easier to create detailed, visual documentation where users can see exactly what to do, rather than having to interpret written instructions alone.

By combining screenshots and written instructions in a single editor, StepForge helps you create polished, visual documentation that is easy to understand, easy to follow, and easy to work with.

## Testing

Please create your tests so that when the following is ran it automatically
tests your test.

```bash
bash tests/run_test.sh
```

The runner executes every `tests/checks/test_*.sh` script; those scripts run
the workflow test suites under `tests/unit/` with `node --test`. The tests
exercise real workflows like creating guides, round-tripping archives, exporting
documents, and validating the bytes of the output, not string matching.

## Building & Packaging

```bash
bash scripts/bootstrap-offline.sh   # verify toolchain availability
bash scripts/verify.sh              # full test suite + smoke checks
bash scripts/build-release.sh       # assemble runnable app directory
npm run package:linux:deb           # Ubuntu 26.04 / GNOME 50 package
npm run package:linux:rpm           # Fedora 44 / GNOME 50 RPM (separate workflow)
npm run package:windows             # Windows installer .exe in releases/
pwsh scripts/package-windows.ps1    # same Windows installer build via PowerShell
```

See [build/build_report.md](build/build_report.md) for what was produced on
this machine and which packaging tools were unavailable.

## Offline Guarantee

Capture, editing, and export work offline. AI and Google Drive sharing make
network requests only when explicitly used or enabled. There is no telemetry,
update check, or license validation. Exports embed no remote fonts or CDN references. See
[docs/SECURITY.md](docs/SECURITY.md) for the threat model. 

> **Note:** Google Drive sharing is currently in testing and requires your
> Google account to be added as an approved StepForge test user. Please contact git@twestbrook.com to be added.

## Contributing

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for the full contribution flow,
including the issue-number requirement for every pull request and the
clean-room rules.

## Repository Layout

Project docs live in `docs/` and prompt handoffs live in `ai_prompts/`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the repo layout.

## License

StepForge is licensed under the **Creative Commons Attribution-NonCommercial
4.0 International License (CC BY-NC 4.0)**. See the root [LICENSE](LICENSE) for
the full terms.

In plain terms: you're free to use, modify, and share it for **non-commercial**
purposes, with attribution — but you may not sell it or use it commercially
without written permission from the copyright holder.
