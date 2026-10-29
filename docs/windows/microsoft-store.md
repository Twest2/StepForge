# Install StepForge from the Microsoft Store

The Microsoft Store is the recommended way to install StepForge on
**Windows 10 (version 1809 or later) and Windows 11, 64-bit**. Microsoft
checks and signs the package, so Windows shows no **Windows protected your
PC** warning, and the Store keeps StepForge up to date for you. You don't need
administrator rights.

Prefer a package manager or a regular installer? See
[Chocolatey](chocolatey.md) or the [Windows installer guide](../windows_installation.md).

## Install

1. Open [StepForge in the Microsoft Store](https://apps.microsoft.com/search?query=StepForge),
   or open the **Microsoft Store** app from the Start menu and search for
   **StepForge**.
2. Click **Get** (or **Install**).
3. Click **Open** when it's done. StepForge also appears in the Start menu.

Head to [Getting Started](../GETTING_STARTED.md) to record your first guide.

## Updates

The Store installs new versions of StepForge automatically, usually within a
day or two of a release, once Microsoft has checked it. An update is installed
while StepForge is closed, or the next time you start it.

To update straight away, open **Settings → About** in StepForge and press
**Check for updates**. If a newer version is out, press **Open Microsoft
Store**, then **Update**. You can also open the Store app and choose
**Library → Get updates**.

Automatic updates can be turned off in the Store app under your profile picture
→ **Settings → App updates**. StepForge is then only updated when you do it
yourself.

## Where your guides are kept

A Store install keeps your guides in a **StepForge** folder in your user
folder: **`C:\Users\<your name>\StepForge`** (`%USERPROFILE%\StepForge`). The
`.exe` installer uses `%APPDATA%\stepforge` instead, but Windows deletes
everything a Store app saves under `%APPDATA%` when the app is uninstalled, and
your guides should survive that. The exact folder is shown in **Settings →
About**, and you can move it under **Settings → General → Guide storage**.

The folder isn't in **Documents** on purpose. OneDrive, and the Dropbox and
Google Drive apps, often back up Documents, which would upload every guide and
screenshot to that service whether or not you turned on sync. To keep guides in
step across computers, use StepForge's own sync under **Settings → Accounts**.

Settings that belong to this computer, such as cloud sign-ins, are kept in the
app's own data, and Windows removes them when you uninstall.

## Switching from the .exe installer or Chocolatey

Your guides from the `.exe` installer are in `%APPDATA%\stepforge`, which the
Store version doesn't use. Move them first, and the Store version opens with
all of them:

1. In the StepForge you have now, open **Settings → General → Guide storage**,
   click **Choose folder…**, and create and choose an empty folder named
   **StepForge** in your user folder (`C:\Users\<your name>`). Close StepForge
   and open it again: it copies your library there, checks the copy, and
   switches to it.
2. Uninstall that StepForge: **Settings → Apps → Installed apps → StepForge →
   Uninstall** in Windows, or `choco uninstall stepforge -y` if you installed it
   with Chocolatey.
3. Install StepForge from the Store, as above.

Keep only one of the two installed. Having both gives you two StepForge entries
in the Start menu, and each updates separately.

## AI agents

The Store version adds a `stepforge.exe` command to your PATH, and the setup in
**Settings → AI → AI agents** uses it, so agents stay connected after each
update. See [Let Claude or Codex write your guides](../AI_AGENTS.md).

## Uninstall

Open **Settings → Apps → Installed apps** in Windows, find **StepForge**, and
choose **Uninstall** (or right-click StepForge in the Start menu and choose
**Uninstall**). Your guides stay in `%USERPROFILE%\StepForge`. Delete that
folder if you want them gone too.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| StepForge isn't found in the Store | Check that you're on Windows 10 version 1809 or later, 64-bit. On a work or school PC, the Store may be turned off by your organization; use the [Windows installer](../windows_installation.md) instead. |
| **Check for updates** shows a newer version, but the Store has no update yet | Microsoft checks each release before the Store offers it, which can take a day or two. Try again later. |
| My guides are missing after switching from the `.exe` installer | They're still in `%APPDATA%\stepforge`. Reinstall the `.exe` version, move the library to `%USERPROFILE%\StepForge` as described in [Switching](#switching-from-the-exe-installer-or-chocolatey), then uninstall it again. |
