# StepForge on apt-based Linux (Debian / Ubuntu)

This is the setup and packaging guide for **apt-based** distributions. Fedora
and other dnf-based systems have a separate guide: [dnf.md](dnf.md).

## Install from the .deb

```bash
sudo apt install ./stepforge_<version>_amd64.deb
```

apt pulls the required runtime libraries automatically (they are declared as
`Depends`). The package installs:

- the app and a fixed Electron runtime under `/opt/stepforge`,
- the `stepforge` launcher at `/usr/bin/stepforge`,
- a desktop entry, icons, and `.sfgz`/`.sfglt` file associations.

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
- **Wayland**: screen capture via the XDG Desktop Portal + PipeWire; the
  portal asks permission once per recording. Per-click capture with
  coordinates is not exposed by Wayland, so recording uses a global hotkey or
  interval trigger. StepForge reports the active trigger honestly.

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
