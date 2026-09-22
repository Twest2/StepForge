# StepForge on Windows with Chocolatey

StepForge provides a Chocolatey package for **Windows 10 and Windows 11 (64-bit)**.

The recommended installation method is the StepForge Chocolatey feed. After a one-time setup, StepForge updates with a single `choco upgrade` command, with no installer to download and no SmartScreen prompts.

You can also install StepForge manually by downloading the installer from [GitHub Releases](https://github.com/Twest2/StepForge/releases). See the [Windows installation guide](../windows_installation.md).

## Before you start

Chocolatey must be installed. If `choco --version` does not work in PowerShell, follow the [Chocolatey installation instructions](https://chocolatey.org/install) first.

Run every command below in **PowerShell as Administrator** (right-click **Windows PowerShell** or **Terminal** and choose **Run as administrator**).

## Recommended: install from the StepForge Chocolatey feed

Add the StepForge feed to Chocolatey:

```powershell
choco source add --name=stepforge --source=https://packages.twestbrook.com/nuget/stepforge-choco/
```

Install StepForge from that feed:

```powershell
choco install stepforge --source=stepforge -y
```

StepForge is installed for all users and appears in the Start menu.

## Updating StepForge

To update only StepForge:

```powershell
choco upgrade stepforge -y
```

To update everything installed with Chocolatey, StepForge included:

```powershell
choco upgrade all -y
```

Close StepForge before updating.

Updates keep your guides, settings, and Google Drive sign-in.

## Switching from a manual install

If you installed StepForge with the setup wizard, you can switch to Chocolatey at any time by following the install steps above. You do not need to uninstall first:

- A copy installed **only for you** is removed automatically and replaced by the Chocolatey-managed copy.
- A copy installed **for all users** is upgraded in place.

Your guides, settings, and Google Drive sign-in are kept either way.

## Uninstalling StepForge

```powershell
choco uninstall stepforge -y
```

Uninstalling removes the application only. Your guides and settings stay in `%APPDATA%\stepforge`.

To also remove the StepForge feed from Chocolatey:

```powershell
choco source remove --name=stepforge
```

## Troubleshooting

**`choco` is not recognized.** Chocolatey is not installed, or the terminal was opened before installing it. Install Chocolatey, then open a new Administrator PowerShell.

**Access denied, or the install asks for elevation.** Open PowerShell with **Run as administrator** and run the command again.

**`stepforge not installed. The package was not found with the source(s) listed.`** The StepForge feed has not been added. Run the `choco source add` command above, then check it is listed with:

```powershell
choco source list
```

**Checking which version is installed:**

```powershell
choco list stepforge
```
