# StepForge on apt-based Linux (Debian / Ubuntu)

The current `.deb` targets **Ubuntu 26.04 with GNOME 50**. See the
[GNOME Wayland recording and testing guide](gnome-wayland.md). Fedora
and other dnf-based systems have a separate guide: [dnf.md](dnf.md).

## Recommended: install from the official Launchpad PPA

For supported Ubuntu releases, the stable PPA publishes StepForge as
`stepforge`. Add it once, then use normal apt upgrades:

```bash
sudo add-apt-repository ppa:twest39/stepforge
sudo apt update
sudo apt install stepforge
```

### If apt reports `NO_PUBKEY` for the PPA

This should not occur on a new installation: `add-apt-repository` normally
imports the PPA's repository key. It can occur if the PPA was added before
Launchpad finished creating its signing key. Import the current public key and
attach it to the existing source entry, then update again:

```bash
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL 'https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x9CA861A99DEE6171' \
  | gpg --dearmor \
  | sudo tee /etc/apt/keyrings/twest39-stepforge.gpg >/dev/null
sudo sed -i '/^Signed-By:/d; $a Signed-By: /etc/apt/keyrings/twest39-stepforge.gpg' \
  /etc/apt/sources.list.d/twest39-ubuntu-stepforge-resolute.sources
sudo apt update
```

When a new StepForge release is published, its package is built by Launchpad
and appears in that PPA. `apt update` downloads the updated package list; it
does **not** install upgrades by itself. To install all available upgrades:

```bash
sudo apt upgrade
```

To have Ubuntu install upgrades automatically, enable its standard unattended
upgrades service:

```bash
sudo apt install unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

The PPA currently publishes an `amd64` package because its bundled Electron
runtime is architecture-specific. It targets the Ubuntu series selected in
the PPA release workflow. Maintainers can find the one-time publishing setup
in [the Launchpad PPA guide](launchpad-ppa.md).

## Alternative: install a downloaded `.deb`

Download `stepforge_<version>_amd64.deb` from the GitHub Release, then run:

```bash
sudo apt install ./stepforge_<version>_amd64.deb
```

This is useful for installing a specific release or testing a release asset.
Unlike the PPA method, it will not receive new StepForge versions through
normal apt upgrades; download and install each newer `.deb` yourself.

apt pulls the required runtime libraries automatically (they are declared as
`Depends`). Either installation method installs:

- the app and a fixed Electron runtime under `/opt/stepforge`,
- the `stepforge` launcher at `/usr/bin/stepforge`,
- a desktop entry, icons, and `.sfgz`/`.sfglt` file associations,
- the required StepForge Capture GNOME Shell extension.

Launch it from your application menu or run `stepforge`.

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
