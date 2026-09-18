# StepForge on apt-based Linux

StepForge provides a `.deb` package for **Ubuntu 26.04 with GNOME 50 on amd64/x86_64**.

The recommended installation method is the official StepForge APT repository. This allows StepForge to receive updates through the same `apt update` and `apt upgrade` commands used for the rest of the system.

You can also download a `.deb` directly from the [StepForge GitHub Releases](https://github.com/Twest2/StepForge/releases) page if you prefer a manual installation.

Fedora and other DNF-based systems have a separate guide: [dnf.md](dnf.md).

For information about recording on GNOME Wayland, see [GNOME Wayland recording and testing](gnome-wayland.md).

## Recommended: install from the StepForge APT repository

Create the APT keyring directory if it does not already exist:

```bash
sudo mkdir -p /etc/apt/keyrings
```

Download the StepForge repository signing key, add the StepForge repository, and refresh apt and install StepForge:

```bash
sudo curl -fsSL \
  -o /etc/apt/keyrings/stepforge.gpg \
  https://packages.twestbrook.com/debian/stepforge/keys/stepforge.gpg

echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/stepforge.gpg] https://packages.twestbrook.com/debian/stepforge/ resolute main" \
  | sudo tee /etc/apt/sources.list.d/stepforge.list

sudo apt update
sudo apt install stepforge
```

The repository currently provides an `amd64` package targeting Ubuntu 26.04 `resolute`.

## Updating StepForge

Once the StepForge repository is configured, StepForge behaves like any other package installed through APT.

To refresh package information and install all available system updates:

```bash
sudo apt update
sudo apt upgrade
```

StepForge will be upgraded automatically whenever a newer version is available.

To update only StepForge:

```bash
sudo apt update
sudo apt install --only-upgrade stepforge
```

You do not need to manually download a new `.deb` when using the APT repository.

## Alternative: install the `.deb` from GitHub Releases

If you do not want to add the StepForge APT repository, download the Ubuntu `.deb` from the [StepForge GitHub Releases](https://github.com/Twest2/StepForge/releases) page.

The filename will look similar to:

```text
stepforge_<version>_amd64.deb
```

Open a terminal in the directory containing the downloaded file and install it with:

```bash
sudo apt install ./stepforge_<version>_amd64.deb
```

For example:

```bash
sudo apt install ./stepforge_0.5.0.0_amd64.deb
```

Using `apt install` instead of `dpkg -i` allows APT to automatically install required dependencies.

This method is useful for installing a specific release or testing a release package.

However, installations made directly from GitHub **will not automatically receive newer StepForge versions** unless the StepForge APT repository is also configured. To update, download the newer `.deb` and install it using the same command.

## Uninstall

To remove StepForge while leaving the APT repository configured:

```bash
sudo apt remove stepforge
```

If you also want to remove the StepForge repository and signing key:

```bash
sudo rm /etc/apt/sources.list.d/stepforge.list
sudo rm /etc/apt/keyrings/stepforge.gpg
sudo apt update
```

Your StepForge guides and settings stored in your home directory are not automatically deleted when the package is removed.

## Sandbox

StepForge launches with Chromium sandboxing enabled.

On modern Linux kernels, the Chromium user-namespace sandbox normally works automatically. The Debian package also configures the bundled `chrome-sandbox` helper as a fallback.

StepForge will not silently disable sandboxing if neither method is available. Instead, the launcher will display an error explaining the problem.

## Portable tarball

A portable Linux tarball is also available from GitHub Releases:

```text
stepforge_<version>_linux-x64.tar.gz
```

Extract it with:

```bash
tar -xzf stepforge_<version>_linux-x64.tar.gz
```

Then run:

```bash
./usr/bin/stepforge
```

The tarball includes the StepForge application and launcher, but system runtime libraries must already be installed.

For a source checkout, those dependencies can be installed with:

```bash
bash scripts/linux/apt/install-runtime-deps.sh
```

The `.deb` package is recommended over the portable tarball for normal Ubuntu installations because APT can manage package dependencies and upgrades.

## Capture capabilities

### X11

StepForge supports per-click capture with an accurate mouse marker.

`xinput` is required for click detection.

### GNOME 50 Wayland

StepForge uses the XDG Desktop Portal and PipeWire for screen capture.

The bundled StepForge GNOME extension detects mouse clicks and provides coordinates used for recording markers.

On the first recording:

1. Start a recording from StepForge.
2. Enable the StepForge extension if prompted.
3. Select the monitors you want to share.
4. Record normally.

See [GNOME Wayland recording and testing](gnome-wayland.md) for detailed capture behavior and limitations.

You can also open **Settings → Diagnostics** inside StepForge to view the detected session type, Portal/PipeWire status, and active capture configuration.

## Build the `.deb` yourself

To build StepForge from source:

```bash
bash scripts/linux/apt/install-build-deps.sh
nvm install && nvm use
npm ci
npm run package:linux:deb
```

The generated Debian package, portable tarball, and checksum files are placed under:

```text
build/artifacts/
```

The package builder includes only files required at runtime: the StepForge application, bundled Electron runtime, production dependencies, launcher, and Linux integration files.

Development dependencies, documentation, prompts, and other source-only files are not included in the installed package.
