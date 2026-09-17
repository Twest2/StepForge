# StepForge on Fedora

StepForge provides an RPM package for **Fedora 44 Workstation with GNOME 50 on x86_64**.

The recommended installation method is the StepForge DNF repository because future StepForge releases can then be installed through normal Fedora updates.

If you prefer not to add the repository, you can also download the RPM directly from the [StepForge GitHub Releases](https://github.com/Twest2/StepForge/releases) page.

## Recommended: install from the StepForge DNF repository

First, make sure Fedora is up to date:

```bash
sudo dnf upgrade --refresh
```

Add the StepForge repository:

```bash
sudo tee /etc/yum.repos.d/stepforge-rpm.repo > /dev/null <<'EOF'
[stepforge-rpm]
name=StepForge RPM Repository
baseurl=https://packages.twestbrook.com/rpm/stepforge-rpm/
enabled=1
gpgcheck=0
EOF
```

Refresh DNF's repository metadata:

```bash
sudo dnf clean metadata
sudo dnf makecache --refresh
```

Install StepForge:

```bash
sudo dnf install stepforge
```

You can verify the installed version with:

```bash
rpm -q stepforge
```

After the first installation or after an update to the bundled GNOME extension, log out and back in before recording.

## Updating StepForge

Because StepForge is installed through DNF, it can be updated alongside the rest of Fedora.

To refresh repository metadata and install all available system updates:

```bash
sudo dnf update
sudo dnf upgrade -y
```

To update only StepForge:

```bash
sudo dnf upgrade stepforge
```

You do not need to manually download a new RPM when using the repository.

## Alternative: install the RPM from GitHub Releases

You can install StepForge without adding the DNF repository.

Download the Fedora RPM from the [StepForge GitHub Releases](https://github.com/Twest2/StepForge/releases) page.

The filename will look similar to:

```text
stepforge-<version>-1.fc44.x86_64.rpm
```

Then open a terminal in the directory containing the downloaded file and install it with:

```bash
sudo dnf install ./stepforge-<version>-1.fc44.x86_64.rpm
```

For example:

```bash
sudo dnf install ./stepforge-0.5.0.0-1.fc44.x86_64.rpm
```

Using `dnf install` instead of `rpm -i` allows DNF to automatically install required dependencies.

If you downloaded the accompanying checksum file, you can verify the package before installing it:

```bash
sha256sum --check stepforge-<version>-1.fc44.x86_64.rpm.sha256
```

The GitHub Release method is useful if you want a specific version or do not want to add the StepForge repository.

However, installations made this way **will not automatically receive new StepForge versions**. You will need to download and install each newer RPM yourself.

## Uninstall

Remove StepForge with:

```bash
sudo dnf remove stepforge
```

If you installed the DNF repository and also want to remove it:

```bash
sudo rm /etc/yum.repos.d/stepforge-rpm.repo
sudo dnf clean metadata
```

Your StepForge guides and settings stored in your home directory are not automatically deleted when the package is removed.

## GNOME Wayland recording

The Fedora package includes the StepForge GNOME Capture extension and required capture helper.

On GNOME Wayland, StepForge uses the XDG Desktop Portal and PipeWire for screen capture while the bundled GNOME extension provides mouse-click information and coordinates.

On the first recording:

1. Start a recording from StepForge.
2. Allow the StepForge GNOME extension if prompted.
3. Select the monitors you want StepForge to capture.
4. Use the **StepForge REC** indicator in the GNOME panel to control the recording.

See [GNOME Wayland recording and testing](gnome-wayland.md) for more information about capture behavior and limitations.

## Build the RPM yourself

To build StepForge from source on Fedora:

```bash
bash scripts/linux/dnf/install-build-deps.sh
bash scripts/linux/dnf/install-runtime-deps.sh
nvm install && nvm use
npm ci
bash tests/run_test.sh
npm run package:linux:rpm
```

The generated RPM and checksum are placed under:

```text
build/artifacts/x86_64/
```
