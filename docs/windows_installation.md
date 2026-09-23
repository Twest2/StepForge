# Install StepForge on Windows

StepForge runs on **Windows 10 and Windows 11 (64-bit)**. Installing takes
about two minutes.

> [!TIP]
> **Prefer automatic updates?** Install with [Chocolatey](windows/chocolatey.md)
> instead. After a one-time setup, `choco upgrade stepforge` keeps you on the
> latest version and skips the SmartScreen prompt below.

*These instructions were recorded and exported with StepForge itself. The
red circles mark where to click.*

## 1. Download the installer

**1.1** Open the [StepForge repository on GitHub](https://github.com/Twest2/StepForge).

![The StepForge repository on GitHub](steps-windows_installation/001-navigate-to-the-git-repo..png)

**1.2** In the right-hand sidebar, click **Releases**.

![The Releases link in the repository sidebar](steps-windows_installation/002-click-on-releases.png)

**1.3** Open the release marked **Latest** and, under **Assets**, download
the file named `StepForge.Setup.<version>.exe`.

![The installer in the release's assets list](steps-windows_installation/003-select-the-latest-release-for-stepforge.png)

> [!NOTE]
> Or skip straight to the [latest release](https://github.com/Twest2/StepForge/releases/latest).

## 2. Run the installer

**2.1** Open the file you downloaded.

![Opening the downloaded installer](steps-windows_installation/004-run-the-installer..png)

**2.2** If Windows shows **Windows protected your PC**, click **More info**.

![The SmartScreen warning with More info highlighted](steps-windows_installation/005-click-more-info.png)

> [!IMPORTANT]
> Microsoft Defender SmartScreen shows this warning for new applications that
> haven't yet built up download reputation. It doesn't mean a problem was found
> with StepForge. Only continue if you downloaded the installer from the
> official GitHub Releases page.

**2.3** Click **Run anyway**.

![The Run anyway button](steps-windows_installation/006-select-run-anyway.png)

**2.4** Choose whether to install StepForge **only for you** or **for all
users** of this computer. Installing for all users needs administrator rights.

![Choosing who StepForge is installed for](steps-windows_installation/007-select-install-for-me-or-install-for-all-users.png)

**2.5** Click **Next** to keep the default install location.

![The install location page](steps-windows_installation/008-select-next.png)

**2.6** Click **Install**.

![The Install button](steps-windows_installation/009-select-install.png)

**2.7** Click **Finish**. StepForge opens and is ready to use.

![The final page of the installer](steps-windows_installation/010-select-finish.png)

## Next steps

- Record your first guide with the [Getting Started guide](GETTING_STARTED.md).
- StepForge appears in the Start menu as **StepForge**.

## Updating and uninstalling

**To update,** download the newest installer from
[Releases](https://github.com/Twest2/StepForge/releases/latest) and run it.
Your guides and settings are kept. A manual install does not update itself,
so consider switching to [Chocolatey](windows/chocolatey.md), which you can do
at any time without uninstalling first.

**To uninstall,** open **Settings → Apps → Installed apps**, find
**StepForge**, and choose **Uninstall**. Your guides stay in
`%APPDATA%\stepforge` in case you reinstall. Delete that folder if you want
them gone too.
