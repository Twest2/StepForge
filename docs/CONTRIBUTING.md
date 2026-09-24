# Contributing to StepForge

Thanks for helping improve StepForge. Bug reports, documentation fixes, and
code are all welcome.

**Contents:** [Workflow](#workflow) · [Ground rules](#ground-rules) ·
[Run from source](#run-stepforge-from-source) · [Tests](#tests) ·
[Build packages](#build-installable-packages) ·
[Test on Ubuntu / GNOME](#testing-on-ubuntu-and-gnome-wayland) ·
[Review checklist](#review-checklist)

## Workflow

1. **Start with an issue.** Find an existing one or
   [open a new one](https://github.com/Twest2/StepForge/issues/new/choose)
   describing the bug or change. Every pull request must link to an issue.
2. **Create a branch that includes the issue number**, for example
   `feat/123-export-page-numbers` or `fix/123-missing-marker`.
3. **Keep it focused.** One issue per branch. Put unrelated clean-up in its own
   branch.
4. **Open a pull request** using the template. Include `Closes #123` (or
   `Fixes` / `Relates to`), a summary of what changed, and anything a reviewer
   should check by hand.

CI runs the full test suite on every pull request.

## Ground rules

### Offline first

- Core features must work offline. No telemetry, automatic update checks,
  license checks, or remote fonts. The only update check is the one the user
  starts from **Settings → About**.
- Optional integrations (AI and Google Drive) stay **off by default**, require
  explicit opt-in, and follow the [privacy policy](PRIVACY.md). Discuss any new
  network feature with the maintainer before building it.

### No new runtime dependencies

Please don't add runtime dependencies without the maintainer's agreement first.
Prefer small internal implementations built on Node's standard library. Every
dependency is supply-chain risk, and npm has seen too many compromised packages
to add them casually.

### Clean-room rules

StepForge is an independent implementation of publicly described
guide-capture workflows. To keep it that way:

- Don't use the names, logos, icons, screenshots, or UI text of commercial
  documentation products in code, assets, or docs.
- Don't copy wording from other products' documentation.
- Don't decompile or inspect proprietary software to work out its behavior.
- Build from public descriptions and your own design.
- Keep file formats (`.sfgz`, `.sfglt`, guide and step JSON) documented and
  versioned in [ARCHITECTURE.md](ARCHITECTURE.md).

### License

StepForge is licensed under
[CC BY-NC 4.0](../LICENSE). By contributing, you agree your contribution is
released under the same license.

## Run StepForge from source

You'll need **Git** and **Node.js 22.12 or newer** (the exact version is in
`.nvmrc`; older versions are refused).

```bash
git clone https://github.com/Twest2/StepForge.git
cd StepForge
nvm install && nvm use      # or install Node 22.12+ another way
```

**On Linux,** install the system libraries and the GNOME extension:

```bash
bash scripts/linux/apt/install-runtime-deps.sh    # Ubuntu / Debian
bash scripts/linux/dnf/install-runtime-deps.sh    # Fedora
bash scripts/linux/install-gnome-extension.sh     # then log out and back in
```

**Then, on any platform:**

```bash
npm ci        # installs the exact locked dependency versions
npm start     # launches StepForge
```

Use `npm ci` rather than `npm install`: it installs exactly what's in
`package-lock.json`. StepForge never installs or repairs dependencies while it
runs.

> [!TIP]
> Keep your development data separate from your real library:
>
> ```bash
> STEPFORGE_DATA_DIR="$HOME/.local/share/stepforge-dev" npm start
> ```

To try Google Drive features from a source checkout, see
[Signing in from a development checkout](GOOGLE_DRIVE_RELEASE.md#signing-in-from-a-development-checkout).

**Useful scripts**

| Command | What it does |
| --- | --- |
| `npm start` | Run the app |
| `npm test` | Run the unit test suites |
| `npm run sample` | Regenerate the sample guide and exports in `examples/` |
| `npm run icons` | Regenerate app and package icons from `assets/images/` |
| `bash scripts/verify.sh` | Full test suite plus smoke checks |
| `bash scripts/bootstrap-offline.sh` | Check that the build toolchain is available |

## Tests

Run the whole suite before opening or updating a pull request:

```bash
bash tests/run_test.sh
```

The runner executes every `tests/checks/test_*.sh`, which in turn run the
`node --test` suites in `tests/unit/`. To add tests, put workflow suites in
`tests/unit/` and any new shell check in `tests/checks/`; the runner picks
both up automatically.

**What good tests look like here:**

- **Exercise real workflows and check real output.** Create a guide, export
  it, and parse the bytes that come out.
- **Never write a test that just greps the source code.**
- Every exporter or storage change needs tests. Changes to output also need
  updated fixtures in `tests/fixtures/`.
- Name and describe tests clearly so that whoever breaks one later understands
  what it protects.

The same command runs in CI through `.github/workflows/ci.yml`.

## Build installable packages

| Target | Command | Output |
| --- | --- | --- |
| Windows installer | `npm run package:windows` (or `pwsh scripts/package-windows.ps1`) | `releases/` |
| Ubuntu `.deb` + portable `.tar.gz` | `npm run package:linux:deb` | `build/artifacts/` |
| Fedora `.rpm` | `npm run package:linux:rpm` | `build/artifacts/x86_64/` |
| Unpacked app folder | `bash scripts/build-release.sh` | `build/` |

Linux builds need the build tools first:

```bash
bash scripts/linux/apt/install-build-deps.sh    # Ubuntu
bash scripts/linux/dnf/install-build-deps.sh    # Fedora
```

Packages contain only what's needed at runtime: the app, the bundled Electron
runtime, production dependencies, the launcher, and the Linux integration.
Docs, prompts, tests, and dev dependencies are left out.

## Testing on Ubuntu and GNOME Wayland

The main Linux target is **Ubuntu 26.04 with GNOME Shell 50 on Wayland**. Click
recording depends on the StepForge GNOME extension, which the `.deb` bundles.

### Install a test package

Get a `.deb` either by downloading the `ubuntu-26.04-gnome-test-package`
artifact from the pull request's GitHub Actions run, or by building one
yourself:

```bash
bash scripts/linux/apt/install-build-deps.sh
nvm install && nvm use
npm ci
bash tests/run_test.sh
npm run package:linux:deb
```

Close StepForge, then replace any installed copy. Test and production packages
share the name `stepforge`, so remove the old one first to be sure you're
testing the right build:

```bash
if dpkg-query -W -f='Installed: ${Version}\n' stepforge 2>/dev/null; then
  sudo apt remove stepforge
fi
sudo apt install ./stepforge_<version>_amd64.deb     # or ./build/artifacts/stepforge_<version>_amd64.deb
dpkg-query -W -f='Now testing: ${Version}\n' stepforge
```

`apt remove` keeps your guides and settings. Don't use `apt purge` unless you
mean to delete them. Rebuild after changing app, extension, packaging, or icon
files so you never test a stale package.

### What to check

Log out and back in after the first install so GNOME loads the extension. Then
create or open a guide, start recording, accept the extension prompt, and share
every monitor you'll use. Click through native Wayland and XWayland apps and
stop with **StepForge REC** or from the StepForge window.

- [ ] Each normal click creates one step, with the pre-click screenshot and a
      correctly placed marker.
- [ ] Pause and resume work.
- [ ] Guides save, reopen, and export correctly.
- [ ] Cancelling the screen-share prompt is handled cleanly.
- [ ] Clicking on a monitor that wasn't shared shows a clear error and never
      captures the wrong screen.

When reporting a capture problem, include the Ubuntu and GNOME Shell versions,
whether you're on Wayland, your monitor layout and scaling, the app you were
clicking in, and any error shown.

### Automated GNOME tests

```bash
bash tests/integration/linux/gnome-shell.test.sh
```

This runs a private headless GNOME Shell with its own D-Bus session and a
test-only virtual pointer. It never enables extensions or sends input to your
real desktop. It needs the GNOME 50 runtime, GTK 4 / AT-SPI introspection,
PipeWire, and WirePlumber.

> [!NOTE]
> GNOME click capture samples the button state every 4 ms. It isn't a
> hardware-level hook, so an extremely short click or a GNOME Shell stall can
> be missed.

### Clean up afterwards

```bash
gnome-extensions disable stepforge@twestbrook.com 2>/dev/null || true
sudo apt remove stepforge
```

If you installed the extension from a source checkout, remove that copy too:

```bash
rm -rf ~/.local/share/gnome-shell/extensions/stepforge@twestbrook.com
```

Check the list before accepting any `apt autoremove` suggestion. Don't remove
shared GNOME, PipeWire, or portal packages other apps rely on. Log out and back
in if the recording indicator is still visible.

## Review checklist

Before requesting review, make sure:

- [ ] The pull request links the right issue.
- [ ] `bash tests/run_test.sh` passes locally.
- [ ] New behavior has tests that check real output.
- [ ] Docs are updated for anything users will notice.
- [ ] The change stays within the issue's scope.
- [ ] Anything that still needs manual verification is listed in the PR.
- [ ] No new network calls, dependencies, or third-party branding.

Please follow the [code of conduct](CODE_OF_CONDUCT.md) in all project spaces.
