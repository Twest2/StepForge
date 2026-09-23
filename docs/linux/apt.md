# Install StepForge on Ubuntu

StepForge provides a `.deb` package for **Ubuntu 26.04 (GNOME 50) on amd64**.

The recommended way to install is the StepForge APT repository, so StepForge
updates with the rest of your system. On Fedora, see the [Fedora guide](dnf.md).

## Install from the StepForge repository

Open a terminal and run these commands. They add StepForge's signing key and
repository, then install the app.

```bash
sudo mkdir -p /etc/apt/keyrings

sudo curl -fsSL -o /etc/apt/keyrings/stepforge.gpg \
  https://packages.twestbrook.com/debian/stepforge/keys/stepforge.gpg

echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/stepforge.gpg] https://packages.twestbrook.com/debian/stepforge/ resolute main" \
  | sudo tee /etc/apt/sources.list.d/stepforge.list

sudo apt update
sudo apt install stepforge
```

> [!IMPORTANT]
> **Log out and back in** before your first recording so GNOME loads the
> StepForge extension. See [Recording on GNOME Wayland](linux_install.md#recording-on-gnome-wayland).

Launch **StepForge** from the app grid, then follow
[Getting Started](../GETTING_STARTED.md) to record your first guide.

## Update

StepForge updates with your normal system updates:

```bash
sudo apt update
sudo apt upgrade
```

To update only StepForge:

```bash
sudo apt update
sudo apt install --only-upgrade stepforge
```

## Alternative: install a downloaded `.deb`

If you'd rather not add a repository, for example on a machine without
internet access, download `stepforge_<version>_amd64.deb` from the
[latest release](https://github.com/Twest2/StepForge/releases/latest) and
install it from the folder you saved it to:

```bash
sudo apt install ./stepforge_<version>_amd64.deb
```

Use `apt install` rather than `dpkg -i` so APT installs the dependencies too.

> [!NOTE]
> A downloaded `.deb` won't update automatically. To upgrade, download the
> newer `.deb` and run the same command, or add the repository above.

## Uninstall

```bash
sudo apt remove stepforge
```

To also remove the StepForge repository and its signing key:

```bash
sudo rm /etc/apt/sources.list.d/stepforge.list /etc/apt/keyrings/stepforge.gpg
sudo apt update
```

Your guides and settings in `~/.local/share/stepforge` are kept.

## Troubleshooting

**StepForge reports a sandbox error at launch.** StepForge always runs with
Chromium's security sandbox enabled and refuses to start without it rather
than quietly running unprotected. On a standard Ubuntu install this works
automatically; the package also configures a fallback helper. If you see the
error, make sure the package installed completely (`sudo apt install --reinstall stepforge`)
and [open an issue](https://github.com/Twest2/StepForge/issues/new/choose)
with the message shown.

**Clicks don't create steps.** Log out and back in, confirm you're on a
Wayland session (`echo $XDG_SESSION_TYPE`), and accept the extension prompt
when recording starts. More in [Recording on GNOME Wayland](linux_install.md#recording-on-gnome-wayland).
