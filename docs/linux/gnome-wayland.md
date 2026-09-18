# StepForge on Linux

StepForge supports Linux through native packages for **Ubuntu 26.04** and **Fedora 44 Workstation**, with GNOME 50 and Wayland as the primary supported desktop environment.

There are several ways to install StepForge:

* **Ubuntu / Debian package repository** — recommended for Ubuntu
* **Fedora / DNF repository** — recommended for Fedora
* **GitHub Releases** — manually install a `.deb` or `.rpm`
* **Portable Linux archive** — extract and run without installing a package
* **Source installation** — clone the repository and run StepForge with Node.js/npm

Using the package repositories is recommended because StepForge will receive updates through your normal system update commands.

---

## Ubuntu 26.04

For installation instructions, please see [apt.md](apt.md)

## Fedora 44 Workstation

For installation instructions, please see [dnf.md](dnf.md)


## Portable Linux archive

StepForge Linux releases may also include a portable archive:

```text
stepforge_<version>_linux-x64.tar.gz
```

Download it from
[GitHub Releases](https://github.com/Twest2/StepForge/releases), then extract
it:

```bash
tar -xzf stepforge_<version>_linux-x64.tar.gz
```

Run StepForge with:

```bash
./usr/bin/stepforge
```

The portable archive contains StepForge and its bundled Electron runtime, but
required Linux system libraries must already be installed.

For most users, the `.deb` or `.rpm` package is preferable because the system
package manager handles dependencies and upgrades.

---

## Run StepForge from source

Developers can also clone and run StepForge directly from the source
repository.

### 1. Clone the repository

```bash
git clone https://github.com/Twest2/StepForge.git
cd StepForge
```

### 2. Install Node.js

StepForge uses the Node.js version specified in `.nvmrc`.

If you use NVM:

```bash
nvm install
nvm use
```

### 3. Install Linux dependencies

On Ubuntu / Debian:

```bash
bash scripts/linux/apt/install-runtime-deps.sh
```

On Fedora:

```bash
bash scripts/linux/dnf/install-runtime-deps.sh
```

### 4. Install StepForge's Node dependencies

Use the repository's locked dependency versions:

```bash
npm ci
```

`npm ci` is recommended instead of `npm install` because it installs exactly
the dependency versions recorded in `package-lock.json`.

### 5. Install the GNOME integration

On supported GNOME Wayland systems:

```bash
bash scripts/linux/install-gnome-extension.sh
```

You may need to log out and back in after installing or updating the GNOME
extension.

### 6. Start StepForge

```bash
npm start
```

This runs StepForge directly from the source checkout instead of installing a
system package.

---

## Build packages from source

### Ubuntu / Debian

Install the build dependencies:

```bash
bash scripts/linux/apt/install-build-deps.sh
nvm install
nvm use
npm ci
```

Build the Debian package and Linux archive:

```bash
npm run package:linux:deb
```

Generated files are placed under:

```text
build/artifacts/
```

### Fedora

Install the Fedora build dependencies:

```bash
bash scripts/linux/dnf/install-build-deps.sh
nvm install
nvm use
npm ci
```

Build the RPM:

```bash
npm run package:linux:rpm
```

Generated RPM files are placed under:

```text
build/artifacts/x86_64/
```

---

## GNOME Wayland support

The Ubuntu and Fedora packages include StepForge's GNOME recording integration.

On GNOME Wayland, StepForge uses:

* XDG Desktop Portal for screen-sharing permission
* PipeWire for screen capture
* the StepForge GNOME extension for mouse-click detection and marker placement

After the first package installation or after an extension update, log out and
back in so GNOME can load the installed extension.

When starting a recording:

1. Open or create a guide.
2. Press **Start recording**.
3. Enable the StepForge extension if prompted.
4. Select the monitors you want to share.
5. StepForge minimizes and **StepForge REC** appears in the GNOME panel.
6. Click normally to create recorded steps.
7. Stop recording from the GNOME panel or from StepForge.

For detailed Linux capture behavior and limitations, see
[GNOME Wayland recording](gnome-wayland.md).

---

## Uninstall

### Ubuntu

```bash
sudo apt remove stepforge
```

To also remove the StepForge repository:

```bash
sudo rm /etc/apt/sources.list.d/stepforge.list
sudo rm /etc/apt/keyrings/stepforge.gpg
sudo apt update
```

### Fedora

```bash
sudo dnf remove stepforge
```

To also remove the StepForge repository:

```bash
sudo rm /etc/yum.repos.d/stepforge-rpm.repo
sudo dnf clean metadata
```

Removing the application does not automatically remove guides and settings
stored in your home directory.
