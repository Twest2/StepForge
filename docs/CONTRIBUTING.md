# Contributing

Thanks for improving StepForge.

## Before You Start

- Open or link the issue that describes the work.
- Keep the change small and focused.
- If the work does not have an issue yet, create one first so the PR can
  reference it.

## Clean-Room Rules

StepForge is an independent reimplementation of publicly documented
guide-capture workflow patterns. To keep it legally clean:

- Do **not** use the names, logos, icons, screenshots, or UI strings of
  commercial documentation products anywhere in code, assets, or docs.
- Do **not** copy wording from other products' documentation into the UI.
- Do **not** decompile, disassemble, or otherwise inspect proprietary
  binaries to derive behavior.
- Implement behavior from public descriptions and your own design only.
- Keep file formats (`.sfgz`, `.sfglt`, guide/step JSON) documented and
  versioned in `docs/` and `ARCHITECTURE.md`.

StepForge is licensed under **Creative Commons Attribution-NonCommercial 4.0
International (CC BY-NC 4.0)** — see the root [LICENSE](../LICENSE). By
contributing you agree that your contributions are licensed under that same
license, and you add a Developer Certificate of Origin sign-off to each commit
(`git commit -s`) to certify you have the right to submit them.

## Offline Rules

- No network code paths in the application. No telemetry, update checks,
  license checks, remote fonts, or remote APIs — **ever**.
- No new runtime dependencies without prior maintainer agreement; prefer
  internal implementations using Node built-ins. This is due to all the 
  security issues that have arrose lately with NPM dependencies.

## Branching

- Use a branch name that includes the issue number, such as
  `issue-123-update-readme`.
- Keep unrelated cleanup in a separate branch, only have the fix in the
  branch.

## Pull Requests

- Every pull request must reference an issue number in the body with
  `Closes #123`, `Fixes #123`, or `Relates to #123`.
- Summarize the change clearly and call out anything a reviewer should
  verify manually.
- Update docs when behavior changes.
- Every exporter or storage change **requires tests**; output changes
  require updated snapshot fixtures under `tests/fixtures/`.

## Tests

Run the local checks before opening or updating a PR:

```bash
bash tests/run_test.sh
```

Put new shell checks in `tests/checks/` so the shared runner picks them up
automatically. The shell checks invoke the `node --test` workflow suites in
`tests/unit/`.

Write tests that exercise **real workflows and verify actual output** —
create a guide, export it, parse the bytes that came out. DO NOT WRITE A TEST THAT GREPS FOR CODE.

The Gitea workflow in `.gitea/workflows/tests.yaml` and `.github/workflows/ci.yaml` runs the same command
automatically on pushes and pull requests.

Please add lots of tests to each of your PR's and be descriptive with the
tests so that the issue doesn't happen again or the feature doesn't get
overwritten.

## Linux Testing (Ubuntu 26.04 / GNOME Wayland)

The supported Linux capture path targets Ubuntu 26.04 with GNOME Shell 50 on
Wayland. The GNOME Shell extension is mandatory for click recording and is
bundled in the Ubuntu package; it is not downloaded separately.

To test a packaged build, download the `ubuntu-26.04-gnome-test-package`
artifact from the PR's GitHub Actions run, extract it, and install it with:

```bash
sudo apt install ./stepforge_<version>_amd64.deb
```

Log out of Ubuntu and back in after the first installation so GNOME discovers
the bundled extension. Then launch StepForge, create or open a guide, and
start recording. Accept the extension-enable prompt, and select every monitor
you intend to record in GNOME's screen-sharing dialog. Click normally in a
native Wayland or XWayland application, then stop with **StepForge REC** in
the GNOME top panel or from the StepForge window restored from the dock.

Verify that normal clicks create steps with correctly positioned markers and
the intended pre-click screenshot. Also test pause/resume, saving and
reopening a guide, exporting, screen-share cancellation, and clicks on a
monitor that was not shared. The last case should show an actionable error and
must not capture the wrong monitor.

When testing is complete, remove the test package and disable its per-user
extension setting:

```bash
gnome-extensions disable stepforge@twestbrook.com 2>/dev/null || true
sudo apt remove stepforge
```

Review the packages shown before accepting any `autoremove` suggestion; do
not remove shared GNOME, PipeWire, or portal packages that other applications
use. Log out and back in if GNOME still shows the old recording indicator.
Finally, delete the extracted test-artifact directory and its downloaded ZIP.

If you installed the extension from a source checkout using
`scripts/linux/install-gnome-extension.sh`, remove only that user copy after
disabling it:

```bash
rm -rf ~/.local/share/gnome-shell/extensions/stepforge@twestbrook.com
```

For source-level validation, run:

```bash
bash tests/run_test.sh
bash tests/integration/linux/gnome-shell.test.sh
npm run package:linux:deb
```

The GNOME integration test uses a private headless compositor, D-Bus session,
temporary configuration, and test-only virtual pointer. It does not enable an
extension or inject input into the developer's real desktop. It requires the
GNOME 50 runtime, GTK 4/AT-SPI introspection, PipeWire, and WirePlumber.

GNOME click capture samples button state every 4 ms, so it is not a lossless
hardware-event hook: exceptionally short clicks or a GNOME Shell stall can be
missed. Report failures with the Ubuntu version, GNOME Shell version, Wayland
status, monitor scaling/layout, application tested, and any displayed error.

## Review Checklist

- The PR is linked to the correct issue.
- The test suite passes locally.
- Any relevant docs or comments are updated.
- The change stays within the intended scope.
- The PR body explains any manual verification that is still needed.
- No network calls, no new dependencies, no trademarked assets.
