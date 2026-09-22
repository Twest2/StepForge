# Install StepForge on Fedora

StepForge provides an RPM package for **Fedora 44 Workstation (GNOME 50) on
x86_64**.

The recommended way to install is the StepForge DNF repository, so StepForge
updates with the rest of your system. On Ubuntu, see the [Ubuntu guide](apt.md).

## Install from the StepForge repository

Open a terminal and run these commands. They add the StepForge repository and
install the app.

```bash
sudo tee /etc/yum.repos.d/stepforge-rpm.repo > /dev/null <<'EOF'
[stepforge-rpm]
name=StepForge RPM Repository
baseurl=https://packages.twestbrook.com/rpm/stepforge-rpm/
enabled=1
gpgcheck=0
EOF

sudo dnf makecache --refresh
sudo dnf install stepforge
```

> [!IMPORTANT]
> **Log out and back in** before your first recording so GNOME loads the
> StepForge extension. See [Recording on GNOME Wayland](linux_install.md#recording-on-gnome-wayland).

Launch **StepForge** from Activities, then follow
[Getting Started](../GETTING_STARTED.md) to record your first guide.

To check the installed version:

```bash
rpm -q stepforge
```

## Update

StepForge updates with your normal system updates:

```bash
sudo dnf upgrade --refresh
```

To update only StepForge:

```bash
sudo dnf upgrade stepforge
```

## Alternative: install a downloaded RPM

If you'd rather not add a repository, download
`stepforge-<version>-1.fc44.x86_64.rpm` and its `.sha256` file from the
[latest release](https://github.com/Twest2/StepForge/releases/latest). From the
folder you saved them to, verify the download and install it:

```bash
sha256sum --check stepforge-<version>-1.fc44.x86_64.rpm.sha256
sudo dnf install ./stepforge-<version>-1.fc44.x86_64.rpm
```

Use `dnf install` rather than `rpm -i` so DNF installs the dependencies too.

> [!NOTE]
> A downloaded RPM won't update automatically. To upgrade, download the newer
> RPM and run the same command, or add the repository above.

## Uninstall

```bash
sudo dnf remove stepforge
```

To also remove the StepForge repository:

```bash
sudo rm /etc/yum.repos.d/stepforge-rpm.repo
sudo dnf clean metadata
```

Your guides and settings in `~/.local/share/stepforge` are kept.

## Troubleshooting

**Clicks don't create steps.** Log out and back in, confirm you're on a
Wayland session (`echo $XDG_SESSION_TYPE`), and accept the extension prompt
when recording starts. More in [Recording on GNOME Wayland](linux_install.md#recording-on-gnome-wayland).

**`dnf` can't find `stepforge`.** Check that the repository file exists at
`/etc/yum.repos.d/stepforge-rpm.repo`, then run `sudo dnf makecache --refresh`
and try again.
