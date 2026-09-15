# StepForge on apt-based Linux (Debian / Ubuntu)

The current `.deb` targets **Ubuntu 26.04 with GNOME 50**. See the
[GNOME Wayland recording and testing guide](gnome-wayland.md). Fedora
and other dnf-based systems have a separate guide: [dnf.md](dnf.md).

## Recommended: install from the official APT repository

For supported Ubuntu releases, install the stable `stepforge` package from the
official StepForge APT repository. Add the repository once, then use normal
apt upgrades:

```bash
sudo mkdir -p /etc/apt/keyrings

sudo curl -fsSL \
  -o /etc/apt/keyrings/stepforge.gpg \
  https://packages.twestbrook.com/debian/stepforge/keys/stepforge.gpg

echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/stepforge.gpg] https://packages.twestbrook.com/debian/stepforge/ resolute main" \
  | sudo tee /etc/apt/sources.list.d/stepforge.list

sudo apt update
sudo apt install stepforge
```

Once configured, `apt update` downloads the updated StepForge package list; it
does **not** install upgrades by itself. To install all available upgrades:

```bash
sudo apt update
sudo apt upgrade
```

To have Ubuntu install upgrades automatically, enable its standard unattended
upgrades service:

```bash
sudo apt install unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

The repository currently publishes an `amd64` package because its bundled
Electron runtime is architecture-specific. It targets Ubuntu `resolute`.

## Alternative: install a downloaded `.deb`

Download `stepforge_<version>_amd64.deb` from the GitHub Release, then run:

```bash
sudo apt install ./stepforge_<version>_amd64.deb
```

This is useful for installing a specific release or testing a release asset.
Unlike the APT repository method, it will not receive new StepForge versions through
normal apt upgrades; download and install each newer `.deb` yourself.

apt pulls the required runtime libraries automatically (they are declared as
`Depends`). Either installation method installs:

- the app and a fixed Electron runtime under `/opt/stepforge`,
- the `stepforge` launcher at `/usr/bin/stepforge`,
- a desktop entry, icons, and `.sfgz`/`.sfglt` file associations,
- the required StepForge Capture GNOME Shell extension.

Launch it from your application menu or run `stepforge`.

## Uninstall

Remove StepForge while keeping the repository configured for a later
reinstallation:

```bash
sudo apt remove stepforge
```

To also remove the StepForge APT repository and its signing key:

```bash
sudo rm /etc/apt/sources.list.d/stepforge.list
sudo rm /etc/apt/keyrings/stepforge.gpg
sudo apt update
```

### Sandbox

The launcher runs **sandboxed**. On most modern kernels the Chromium
user-namespace sandbox works out of the box; the package's `postinst` also
makes the setuid `chrome-sandbox` helper usable as a fallback. StepForge will
**not** silently launch unsandboxed — see the launcher's message if the
sandbox is unavailable.

## Install from the portable tarball

```bash
tar -xzf stepforge_<version>_linux-x64.tar.gz
# Install the runtime libraries first (see below), then run:
./usr/bin/stepforge         # or move opt/stepforge to /opt and use the launcher
```

The tarball includes the `/usr/bin/stepforge` launcher (unlike older builds).
Install the runtime libraries with:

```bash
bash scripts/linux/apt/install-runtime-deps.sh
```

## Capture capabilities on apt systems

- **X11**: full per-click capture with an accurate marker (needs `xinput`).
- **GNOME 50 Wayland**: screen capture via the XDG Desktop Portal + PipeWire;
  the bundled extension samples mouse clicks and coordinates for red markers.
  Enable the extension on first recording and select the monitors to share.
  See the GNOME guide for sampling limitations and supported capture modes.

Run StepForge and open Settings → Diagnostics to see the detected session
type, portal/PipeWire status, and the active capture profile.

## Build the .deb yourself

```bash
bash scripts/linux/apt/install-build-deps.sh   # dpkg-dev, fakeroot, xvfb, …
nvm install && nvm use                          # pinned Node 22 (see .nvmrc)
npm ci
npm run package:linux:deb                        # -> build/artifacts/*.deb + tarball + sha256
```

The builder stages **only** runtime files: the app code, a fixed Electron
runtime, and production npm dependencies. It never copies the development
`node_modules`, docs, prompts, or examples, and it fails if `node_modules` is
missing rather than producing an unusable artifact.
