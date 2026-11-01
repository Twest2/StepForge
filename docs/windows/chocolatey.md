# Install StepForge on Windows with Chocolatey

[Chocolatey](https://chocolatey.org) installs StepForge on **Windows 10 and
Windows 11 (64-bit)** from the command line. After a one-time setup, one
command keeps StepForge up to date, with no installers to download and no
SmartScreen prompts. It suits PCs you already manage with Chocolatey.

For most people, the [Microsoft Store](microsoft-store.md) is simpler: no
administrator rights or command line, and updates are automatic. Prefer a
regular installer? See the [Windows installation guide](../windows_installation.md).

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

The easiest way: in StepForge, open **Settings → About**, press **Check for
updates**, then **Update now**. StepForge saves your work and closes, Windows
asks for administrator approval, and Chocolatey updates StepForge (and nothing
else). Then StepForge opens again. If you decline the approval prompt, nothing
changes.

If the update fails, the **Updating StepForge** window says why and stays open
until you press Enter. Chocolatey's log is
`C:\ProgramData\chocolatey\logs\chocolatey.log`.

**Update now** appears only when StepForge is registered with Chocolatey,
which a Chocolatey install, or the .exe installer's **Keep StepForge updated
with Chocolatey** option, does.

To update from PowerShell instead, close StepForge, then run this in an
Administrator PowerShell:

```powershell
choco upgrade stepforge -y
```

Or update everything installed through Chocolatey at once:

```powershell
choco upgrade all -y
```

Updates keep your guides, settings, and Google Drive sign-in.

## Already installed from the .exe?

The setup wizard's **Updates** page has **Keep StepForge updated with
Chocolatey**, checked by default. Leave it checked, and once the files are
copied the installer installs Chocolatey if needed, adds the StepForge feed,
and registers the version you just installed. From then on, **Update now** and
`choco upgrade stepforge -y` both work. If you install only for yourself,
Windows asks for administrator approval once.

Installed with an older installer that has no **Updates** page? Run the latest
installer once. Your guides and settings are kept.

Good to know:

- **It needs internet access**, and downloads the StepForge package (about
  100 MB) from the feed once.
- If you installed **only for you**, the first Chocolatey update turns it into
  an **all-users** install. Your guides, settings, and sign-in are kept.
- **If it doesn't work** (you declined the approval prompt, you're offline, IT
  policy blocks it, or it's a prerelease build that isn't on the feed),
  StepForge is still installed, and the wizard tells you where the log is,
  normally `C:\ProgramData\StepForge\chocolatey-setup.log`. You can set it up
  later with the [install steps](#install) above.
- Uninstalling from **Apps & Features** also removes StepForge from
  Chocolatey, so `choco upgrade` doesn't bring it back.

### For IT admins

- Silent installs (`/S`) skip the Chocolatey setup unless you also pass
  `/chocolatey`, for example
  `"StepForge Setup <version>.exe" /S /allusers /chocolatey`. Run it from an
  administrator prompt, or Windows shows an approval prompt even though the
  install is silent. The installer never does this when Chocolatey itself is
  running it.
- Silent uninstalls (`/S`) leave the Chocolatey registration alone.
- To register an installed version with Chocolatey by hand, run
  `choco install stepforge --version <your version> --source=stepforge -y --skip-automation-scripts`.

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
`%USERPROFILE%\StepForge`. To also remove the StepForge feed:

```powershell
choco source remove --name=stepforge
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `choco` is not recognized | Chocolatey isn't installed, or the terminal was opened before it was. Install Chocolatey, then open a new Administrator PowerShell. |
| Access denied, or a request for elevation | Reopen PowerShell with **Run as administrator** and try again. |
| `The package was not found with the source(s) listed` | The StepForge feed hasn't been added. Run the `choco source add` command above and confirm it appears in `choco source list`. |
| **Update now** is missing from Settings → About | It appears only after **Check for updates** finds a newer version. If it still doesn't, StepForge isn't registered with Chocolatey: run the latest installer and keep **Keep StepForge updated with Chocolatey** checked, or see [Already installed from the .exe?](#already-installed-from-the-exe). |
| The update window says StepForge did not close | StepForge was still running after two minutes, so nothing was installed. Press **Update now** again, or close StepForge and run `choco upgrade stepforge -y` in an Administrator PowerShell. |
| The update window says Chocolatey doesn't have the new version yet | The Chocolatey package is published shortly after the GitHub release. Try again later. |

To check which version you have installed:

```powershell
choco list stepforge
```
