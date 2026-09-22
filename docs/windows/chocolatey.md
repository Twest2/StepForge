# Install StepForge on Windows with Chocolatey

[Chocolatey](https://chocolatey.org) is the recommended way to install
StepForge on **Windows 10 and Windows 11 (64-bit)**. After a one-time setup,
one command keeps StepForge up to date, with no installers to download and no
SmartScreen prompts.

Prefer a regular installer? See the [Windows installation guide](../windows_installation.md).

## Before you start

- **Chocolatey must be installed.** If `choco --version` doesn't work in
  PowerShell, follow the [Chocolatey install instructions](https://chocolatey.org/install)
  first.
- **Use an Administrator PowerShell** for every command on this page: right-click
  **Terminal** or **Windows PowerShell** and choose **Run as administrator**.

## Install

**1. Add the StepForge package feed.** You only need to do this once.

```powershell
choco source add --name=stepforge --source=https://packages.twestbrook.com/nuget/stepforge-choco/
```

**2. Install StepForge.**

```powershell
choco install stepforge --source=stepforge -y
```

StepForge is installed for all users and appears in the Start menu. Head to
[Getting Started](../GETTING_STARTED.md) to record your first guide.

## Update

Close StepForge, then run:

```powershell
choco upgrade stepforge -y
```

Or update everything installed through Chocolatey at once:

```powershell
choco upgrade all -y
```

Updates keep your guides, settings, and Google Drive sign-in.

## Switching from the regular installer

You don't need to uninstall first. Just follow the install steps above:

- A copy installed **only for you** is removed and replaced by the
  Chocolatey-managed copy.
- A copy installed **for all users** is upgraded in place.

Your guides, settings, and Google Drive sign-in carry over either way.

## Uninstall

```powershell
choco uninstall stepforge -y
```

This removes the application only. Your guides and settings stay in
`%APPDATA%\stepforge`. To also remove the StepForge feed:

```powershell
choco source remove --name=stepforge
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `choco` is not recognized | Chocolatey isn't installed, or the terminal was opened before it was. Install Chocolatey, then open a new Administrator PowerShell. |
| Access denied, or a request for elevation | Reopen PowerShell with **Run as administrator** and try again. |
| `The package was not found with the source(s) listed` | The StepForge feed hasn't been added. Run the `choco source add` command above and confirm it appears in `choco source list`. |

To check which version you have installed:

```powershell
choco list stepforge
```
