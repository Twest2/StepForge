# StepForge on dnf-based Linux (Fedora / RHEL)

This is the setup and packaging guide for **dnf-based** distributions. Debian,
Ubuntu, and other apt-based systems have a separate guide:
[apt.md](apt.md).

## Install from the .rpm

```bash
sudo dnf install ./stepforge-<version>-1.<arch>.rpm
```

dnf pulls the required runtime libraries automatically (they are declared as
`Requires`). The package installs:

- the app and a fixed Electron runtime under `/opt/stepforge`,
- the `stepforge` launcher at `/usr/bin/stepforge`,
- a desktop entry, icons, and `.sfgz`/`.sfglt` file associations.

Launch it from your application menu or run `stepforge`.

### Sandbox

The launcher runs **sandboxed**. On most modern kernels the Chromium
user-namespace sandbox works out of the box; the package's `%post` also makes
the setuid `chrome-sandbox` helper usable as a fallback. StepForge will **not**
silently launch unsandboxed.

## Install from the portable tarball

The portable tarball (same one shipped for apt systems) includes the
`/usr/bin/stepforge` launcher. Install the runtime libraries first:

```bash
bash scripts/linux/dnf/install-runtime-deps.sh
tar -xzf stepforge_<version>_linux-x64.tar.gz
./usr/bin/stepforge
```

## Capture capabilities on dnf systems

- **X11**: full per-click capture with an accurate marker (needs `xinput`).
- **Wayland** (Fedora's default): screen capture via the XDG Desktop Portal +
  PipeWire; the portal asks permission once per recording. Per-click capture
  with coordinates is not exposed by Wayland, so recording uses a global
  hotkey or interval trigger. StepForge reports the active trigger honestly.

Open Settings → Diagnostics in the app to see the detected session type,
portal/PipeWire status, and the active capture profile.

## Build the .rpm yourself

```bash
bash scripts/linux/dnf/install-build-deps.sh    # rpm-build, rpmdevtools, Xvfb, …
nvm install && nvm use                           # pinned Node 22 (see .nvmrc)
npm ci
npm run package:linux:rpm                         # -> build/artifacts/*.rpm + sha256
```

The builder stages **only** runtime files (shared with the `.deb` builder via
`packaging/linux/common/stage-runtime.sh`): the app code, a fixed Electron
runtime, and production npm dependencies. It never copies the development
`node_modules` and fails if `node_modules` is missing.
