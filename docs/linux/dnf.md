# StepForge on Fedora 44 Workstation / GNOME 50

The Fedora x86_64 RPM uses the same application, GNOME Capture extension,
Python helper, and consented Portal/PipeWire capture path as Ubuntu. Fedora 44
ships GNOME 50; the RPM requires GNOME 50 and rejects incompatible Shell
versions. KDE, RHEL, and older Fedora releases are not supported by this RPM.
See [Fedora's GNOME 50 target](https://fedoraproject.org/wiki/Test_Day:2026-02-11_GNOME_50_Desktop).

## Install an RPM

Download the `.fc44.x86_64.rpm` and its `.sha256` from a GitHub Release, or
from the PR's `fedora-44-gnome-test-package` artifact. In their directory:

```bash
sha256sum --check stepforge-<version>-1.fc44.x86_64.rpm.sha256
sudo dnf install ./stepforge-<version>-1.fc44.x86_64.rpm
rpm -q stepforge
```

DNF installs the required GNOME, Python/GObject, GStreamer, PipeWire and portal
libraries. The package includes Electron, production npm dependencies, desktop
and MIME integration, and the extension in
`/usr/share/gnome-shell/extensions/stepforge@twestbrook.com`.

Log out and back in after the first install or extension update. Launch
StepForge, open a guide, start recording, accept the extension-enable prompt,
and share every monitor you intend to record. Normal clicks create steps with
markers. Stop from **StepForge REC** in the GNOME panel or the restored app.
See the [shared GNOME recording behavior and limitations](gnome-wayland.md#what-is-and-is-not-windows-parity).

The launcher retains sandboxing; the RPM installs the Chromium sandbox helper
with root ownership and mode 4755. Do not disable SELinux or the sandbox to
work around a desktop failure. Report the failure with Fedora/GNOME versions.

To remove the package (guides and settings in your home directory remain):

```bash
gnome-extensions disable stepforge@twestbrook.com
sudo dnf remove stepforge
```

A source-installed per-user extension may override the packaged copy. Remove
that old copy before testing package updates, as described in the GNOME guide.

## ProGet repository setup

ProGet's Debian and RPM feeds are different feed types. The existing Debian
feed `stepforge` remains unchanged. Create a separate **RPM feed**, for example
`stepforge-fedora`, on your existing ProGet server. Configure package signing
in that feed and use its **Connect to Feed** instructions to install the DNF
repository and its signing key on Fedora. Keep package signature verification
enabled. Once configured:

```bash
sudo dnf install stepforge
sudo dnf upgrade stepforge
```

In GitHub repository **Settings → Secrets and variables → Actions**, configure:

| Setting | Type | Value |
| --- | --- | --- |
| `PROGET_RPM_FEED` | Variable | Your separate RPM feed name, e.g. `stepforge-fedora` |
| `PROGET_API_KEY` | Secret | Existing key, with upload permission on the RPM feed |
| `PROGET_UPLOAD_URL` | Optional variable | Upload server origin; defaults to the same host as the existing Debian workflow |

The Fedora workflow uses ProGet's [Upload Package API](https://docs.inedo.com/docs/proget/api/packages/upload),
including the RPM filename in the URL. It does not send Debian distribution or
component parameters. No credentials are required for PR builds.

## CI and releases

**Fedora CI** is a separate workflow. It builds inside `fedora:44` on an x86_64
runner, executes repository tests and RPM metadata/payload/checksum checks,
installs the built RPM with DNF, imports the installed capture helper, checks
GStreamer elements, and renders a packaged app window under Xvfb.

The existing **Release** workflow finishes Windows/Ubuntu publishing first,
then calls **Release Fedora**. Fedora checks out that exact release tag,
stamps the version, tests/builds/installs the RPM, and attaches only RPM and RPM
checksum files to the existing GitHub Release. Stable releases also upload to
the RPM feed; prereleases do not. Missing ProGet configuration fails the Fedora
publish step with setup guidance, leaving the existing release assets intact.

Retry **Release Fedora** manually with the same tag after fixing configuration.
This can also add Fedora artifacts to a release whose tag contains the Fedora
support files. Tags from before this change cannot use the new build/test
scripts. Retries replace only the matching Fedora assets; they do not modify
tags, Windows installers, Ubuntu packages, or the Debian feed.

## Build from source

On Fedora 44 Workstation:

```bash
bash scripts/linux/dnf/install-build-deps.sh
bash scripts/linux/dnf/install-runtime-deps.sh
nvm install && nvm use
npm ci
bash tests/run_test.sh
npm run package:linux:rpm
# Output: build/artifacts/x86_64/*.rpm and *.rpm.sha256
```

The Fedora builder shares `packaging/linux/common/stage-runtime.sh` with Debian
and keeps its RPM metadata separate. It packages only runtime dependencies;
it never installs dependencies when the application starts.

## Desktop verification

Container CI verifies packaging, dependency resolution and UI startup. It
cannot certify a real Fedora Wayland desktop or SELinux sandbox operation.
Before a production release, install the RPM on Fedora 44 Workstation with
SELinux enforcing and verify regular mouse/touchpad clicks, native Wayland and
XWayland applications, multi-monitor scaling, pause/resume, cancellation,
screen lock, extension disablement, save/reopen, and export. Check that a click
on an unshared monitor reports an error without capturing the wrong monitor.
The [GNOME integration test](../../tests/integration/linux/gnome-shell.test.sh)
can additionally exercise a private GNOME compositor with the requisite test
libraries installed; it does not interact with your real desktop.
