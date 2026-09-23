# StepForge on Linux

StepForge ships native packages for **Ubuntu 26.04** and **Fedora 44
Workstation** on 64-bit Intel/AMD (x86_64). Both are tested on **GNOME 50
with Wayland**, the default desktop on each.

## Choose how to install

| Method | Best for | Updates | Guide |
| --- | --- | --- | --- |
| **APT repository** | Ubuntu | With `apt upgrade` | [Ubuntu](apt.md) |
| **DNF repository** | Fedora | With `dnf upgrade` | [Fedora](dnf.md) |
| `.deb` / `.rpm` from Releases | A specific version, or offline machines | Manual | [Ubuntu](apt.md#alternative-install-a-downloaded-deb) · [Fedora](dnf.md#alternative-install-a-downloaded-rpm) |
| Portable `.tar.gz` | Trying StepForge without installing | Manual | [Below](#portable-archive) |
| From source | Contributors | `git pull` | [Contributing](../CONTRIBUTING.md#run-stepforge-from-source) |

The package repositories are recommended: StepForge then updates alongside
the rest of your system, and the packages install the GNOME integration that
click recording needs.

## Recording on GNOME Wayland

Wayland deliberately stops apps from watching the screen or the mouse without
permission. StepForge works within those rules using three pieces, all
installed by the `.deb` and `.rpm` packages:

- **XDG Desktop Portal** asks you which screens StepForge may capture.
- **PipeWire** delivers the screen images.
- **The StepForge GNOME extension** reports where you clicked so each click
  becomes a step with an accurate marker.

**Before your first recording, log out and back in** so GNOME loads the
extension. This is also needed after an update that changes the extension.

Then, to record:

1. Open or create a guide and start a capture session.
2. If GNOME asks, allow the StepForge extension.
3. Choose the monitors to share. Pick every monitor you'll click on.
4. StepForge minimizes and **StepForge REC** appears in the top panel.
5. Click through your task. Each click becomes a step.
6. Stop from **StepForge REC** or from the StepForge window.

**Good to know**

- Clicks on a monitor you didn't share are reported as an error rather than
  captured from the wrong screen.
- GNOME reports button state every few milliseconds, so an extremely quick tap
  or a moment when GNOME Shell is frozen can occasionally be missed.
- If your desktop can't report clicks at all, open
  **Settings → Capture → When clicks can't be detected** and capture with the
  hotkey (**Ctrl+Shift+1**) or on a timer instead.
- On an **X11** session StepForge detects clicks with `xinput`, which the
  packages install as a recommended dependency.

## Portable archive

Every release includes a portable build for trying StepForge without
installing anything:

```bash
tar -xzf stepforge_<version>_linux-x64.tar.gz
./usr/bin/stepforge
```

Download it from the [latest release](https://github.com/Twest2/StepForge/releases/latest).
The archive bundles StepForge and its runtime, but not the system libraries or
the GNOME extension, so click recording on Wayland needs the full package. On
Ubuntu or Fedora the `.deb` or `.rpm` is the better choice for everyday use.

## Uninstall

| | Remove StepForge | Also remove the repository |
| --- | --- | --- |
| **Ubuntu** | `sudo apt remove stepforge` | [See the Ubuntu guide](apt.md#uninstall) |
| **Fedora** | `sudo dnf remove stepforge` | [See the Fedora guide](dnf.md#uninstall) |

Uninstalling leaves your guides and settings in `~/.local/share/stepforge`,
so reinstalling picks up where you left off. Delete that folder to remove them
too.

## Building packages yourself

Building `.deb` and `.rpm` packages from source is covered in the
[contributing guide](../CONTRIBUTING.md#build-installable-packages).
