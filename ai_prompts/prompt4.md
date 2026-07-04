# After action report

## Done — 10 PRs implemented, merged, and CI-green on both forges
I worked through ai_prompts/prompt4.md and shipped PRs 1–10 of the plan's recommended sequence. Each was a focused branch, opened on both GitHub (Twest2/StepForge #5–#14) and Gitea (Tyler/autodoc #21–#30), verified green on GitHub CI (Ubuntu + Windows + dependency audit), merged with the same SHA to both forges, and the Gitea mirror closed with a merge note. Final state: main is byte-identical across local, GitHub, and Gitea (cc724f8), main CI is green, no open PRs, 289 unit tests pass (0 fail).

## PR	What it fixed
1	Pinned Node ≥22.12 (.nvmrc/engines); removed all runtime npm self-repair; refuse silent --no-sandbox; CI on pull_request + prod/full audits; made the click E2E stop hiding startup crashes as "SKIPPED"; remediated the form-data/undici advisories
2	Closed the renderer privilege boundary: navigation/popup denial, sandboxed windows, per-channel IPC sender+argument validation, deny-by-default permissions (display capture only for the capture worker), intent-specific shell access replacing arbitrary shell:openPath
3	Truthful local-first AI/privacy contract: raw keystroke capture off by default, AbortController timeouts + cancellation + concurrency + image-size limits, loopback-only Ollama unless explicitly opted in, honest docs + new docs/PRIVACY.md
4	Optimistic revision fields + compare-and-swap (stale AI responses can't clobber edits), autosave keeps dirty state on failed saves, corrupt guides/steps quarantined instead of silently vanishing
5	Region-capture nested-result + listener-leak bugs, single-owner power blocker, explicit click-source reporting (evdev fix), strict-mode skips instead of storing post-click shots, pathToFileURL, shutdown drain
6	ZIP-bomb limits, transactional archive import, atomic snapshot restore, exclusive locks (O_EXCL + token), search index reconcile at startup, implemented the dead automatic-backup settings
7	Platform adapter layer — window-context detection extracted to app/platform/{windows,linux,darwin}/; shared code no longer branches on process.platform; Linux capability diagnostics
8	Production .deb (runtime-only staging, no dev tree, detected arch, desktop/MIME/icons, original generated icon set), apt setup scripts, real launcher; retired the old broken packager
9	Production .rpm + dnf setup, shared stage-runtime.sh so both formats never drift
10	Honest Wayland triggers (never promises per-click coordinates it can't deliver) + a least-privilege mouse-only udev rule replacing the broad input group keylogging surface; .gitattributes so Unix scripts don't break on CRLF
I verified real behavior where possible: built and inspected an actual 107 MB .deb, ran the click self-test (markers 3/3, burst 8/8), and confirmed the sandboxed app boots.

## One blocking item I did not act on — the license (needs your decision)
The plan calls this a legal release blocker that an implementation agent must not guess, and I agree. The repo currently contradicts itself:

package.json → MPL-2.0 and CONTRIBUTING requires MPL-2.0 + DCO sign-off (permits commercial use)
docs/LICENSE + README §License → Creative Commons Attribution-NonCommercial (forbids commercial use; also not a software license)
there is no root LICENSE file
MPL-2.0 and CC-BY-NC are mutually exclusive, and contributors have been signing off under a license the project doesn't actually ship. You need to pick one, then I can reconcile the SPDX field, root LICENSE, README, CONTRIBUTING, package payloads, and the About view in a single follow-up PR.

## What remains (plan PRs 11–14 — larger, several need your input)
Canonical blocks/callout-placement schema-v2 migration; lazy exports + Unicode font vendoring (needs a licensed-font choice); editor modularization + accessibility; and the signed reproducible release pipeline (needs signing keys). Also still open: the click self-test's arm/debounce scenarios fail on Linux — a pre-existing capture defect I surfaced honestly in PR 1 but didn't chase down (it needs on-device Linux capture debugging).

Tell me your license choice and I'll do the reconciliation PR; tell me which of 11–14 to prioritize and I'll take it next.



# StepForge comprehensive improvement plan

This document is an implementation handoff for another coding agent. It is based on a repository-wide audit of commit `534a28e` on 2026-07-03. It is a plan, not authorization to make all changes in one unreviewable patch.

## Objective

Turn StepForge into a reliable, secure, maintainable Windows and Linux desktop application while preserving user data and the core capture/edit/export workflow. Work in small phases, add tests before or with each fix, and keep each pull request focused. Do not claim a capability until its acceptance test passes on the relevant operating system.

Linux is a platform rewrite, not a collection of `process.platform === "linux"` branches in Windows-oriented files. All Linux-only runtime, setup, packaging, and tests must live in separate Linux-specific files. Apt- and dnf-based distributions must also have separate setup/package files.

## Audit baseline

- Repository: Electron app with a dependency-light Node core.
- Approximate size: 10,949 lines in `app/`, 4,134 in `core/`, 2,658 in `exporters/`, 1,119 in `scripts/`, and 5,119 in tests.
- Largest production files are already too broad: `app/renderer/editor.js` (2,336 lines), `app/capture.js` (2,055), `app/renderer/dialogs.js` (1,039), `app/renderer/app.js` (944), and `app/main.js` (905).
- `node --check` succeeds for all checked JavaScript files.
- The full `bash tests/run_test.sh` run fails in `test_startup_smoke.sh`: Electron cannot load `libnspr4.so` on this Linux host. The earlier click self-test reports “SKIPPED,” masking that startup failure as a missing capture environment.
- Direct unit run: 205 tests, 200 passed, 1 failed, 4 skipped. The failure is `tests/unit/package-windows.test.js`, caused by the packaging dependency graph being loaded under Node 18 (`ERR_REQUIRE_ESM`). The four skipped tests are external renderer/codec validations.
- The host has Node 18.19.1. Documentation says Node 20+, but the lockfile contains packages requiring at least Node 20.19 and some packaging packages requiring Node 22.12. There is no `engines` field or hard prerequisite check.
- Sample generation and the current build-release workflow tests pass. They do not prove that the produced Linux package launches or that it has all system libraries.
- `npm audit --package-lock-only` reports two high-severity issues in build/dev dependencies (`form-data` and `undici`). `npm audit --omit=dev --package-lock-only` reports no production issue. This distinction disappears in the current Linux package because it copies all of `node_modules`, including dev/build dependencies.
- The launcher silently ran `npm install --package-lock=false` when dependencies were missing. That changed the ignored `node_modules` tree to versions different from `package-lock.json`. A desktop launcher must not repair itself by accessing npm at runtime.
- The worktree was clean before this plan; diagnostics only created ignored `node_modules` content.

## Confirmed high-priority findings

### Security and privacy

1. **A remote page can inherit the privileged preload API.** The main window has no `will-navigate` guard and no `setWindowOpenHandler`. Stored descriptions allow `https:` links. If a link navigates the main window, the preload still runs and exposes `window.stepforge` to the new page. IPC handlers do not validate sender URL/origin, and `shell:openPath` accepts an arbitrary renderer-provided target. This is a release-blocking privilege-boundary defect.

2. **The default session grants every Electron permission.** `app/main.js` uses permission handlers that return `true` for every permission and every requester. The comment that this is safe because content is local is not a security control. Grant only display capture, only to the dedicated capture worker, and reject everything else.

3. **Windows recording behaves like a keylogger.** The PowerShell/C# hook embedded in `app/capture.js` installs a global keyboard hook, reconstructs printable characters, buffers up to 200 characters, persists them in `captureMetadata`, and can send them with screenshots to an Ollama host. This can capture passwords or other sensitive text. It is not adequately disclosed or consented to. Disable raw character capture by default; ideally remove it. If retained, make it an explicit, separately consented feature with sensitive-field suppression, short in-memory lifetime, redaction, no persistence by default, and tests.

4. **“Fully offline” and “zero HTTP requests” are factually false.** `app/text-intel.js` performs configurable HTTP requests to an Ollama host and accepts a host that can be remote. The launcher can contact npm. The docs also say Electron is the only dependency, while Tesseract and its language data are production dependencies. Choose and document an accurate contract such as “local-first, no telemetry, optional user-configured Ollama,” then enforce it. If remote hosts are prohibited, validate loopback/unix-socket targets instead of accepting arbitrary HTTP endpoints.

5. **AI requests have no timeout, cancellation, size limit, or concurrency policy.** A dead Ollama endpoint can leave UI actions pending indefinitely. Full screenshots are base64-expanded into requests. Add `AbortController` deadlines, cancellation when a guide/step closes, request-size limits, bounded concurrency, and explicit data-disclosure UI.

6. **Archive import lacks resource limits and transactional extraction.** ZIP entry paths and CRCs are checked, but entry count, compressed size, inflated size, compression ratio, manifest size, and total extracted bytes are not bounded. A ZIP bomb can exhaust memory because the archive and inflated entries are handled synchronously in memory. Import writes `guide.json` before all steps validate, leaving partial guides after an error.

7. **Imported export templates can inject active HTML.** `customCss`, accent values, and other template values are interpolated into generated HTML without a typed schema. A malicious `.sfglt` can close the style element and add script. Validate every format’s options, restrict colors/numbers/enums, and either remove arbitrary CSS or safely encode it with a clearly documented trusted-template boundary.

8. **The HTML sanitizer is regex-based and link navigation is not separated from rendering.** Replace ad hoc URL checks with URL parsing and a strict scheme/host policy. Add hostile HTML fixtures and ensure renderer links are intercepted rather than navigating the privileged window.

### Broken or misleading behavior

1. **Region capture returns the wrong shape.** `CaptureService.regionCapture()` stores the result of `storeFrameAsStep()` in `step` and then returns `{ ok: true, step }`. The actual step is therefore at `result.step.step`. Region capture selection and region auto-documentation expect `result.step.stepId`, so they break. Return the `storeFrameAsStep()` result directly and add an IPC-to-renderer workflow test.

2. **Cancelled region capture leaks an IPC listener.** `pickRegion()` removes `region:picked` only when an event arrives. Closing/cancelling the overlay leaves the listener and captured window references behind. Cleanup must be idempotent on pick, close, load failure, and app shutdown. Validate/clamp the received rectangle before cropping.

3. **Autosave can report clean after a failed write.** `flushStep()` and `flushGuide()` clear dirty flags before awaiting IPC. A rejected save can lose the visible dirty state and is often invoked through a debounce that does not handle rejected promises. Use a serialized save queue with states (`dirty`, `saving`, `saved`, `error`), only clear the matching revision after success, retry safely, show persistent failure UI, and flush on navigation/close.

4. **Concurrent whole-object saves can overwrite newer edits.** Editor saves, capture auto-documentation, AI generation, and background step updates all read and write full step objects with no revision check. An AI response based on stale data can overwrite user edits; `step:updated` can reload the editor while local changes are pending. Add per-guide/per-step revision numbers and compare-and-swap saves or field-level patches. Resolve conflicts explicitly.

5. **Configured automatic backups do not exist.** `backups.automatic` and `backups.everyNSaves` are defined but never used. Implement a save-count/time policy with pruning and failure reporting, or remove the settings and the documentation claim. Snapshot restore must extract into a temporary directory, validate fully, and atomically swap; the current restore deletes live content before extraction succeeds.

6. **Strict click timing still falls back to a post-click shot.** The selection logic rejects post-click frames, but `sessionCapture()` then takes a fresh shot after the click and stores it. That contradicts the strict-mode product promise. In strict mode, either keep a sufficiently healthy pre-click buffer or skip the capture with a visible diagnostic; never label a post-click fallback as strict.

7. **Linux evdev state is reported incorrectly.** `startEvdevWatcher()` does not set `clickWatcher`, so `state().clickCapture` is false even when evdev is active. The UI can say “hotkey only” while clicks are being watched. Device stream errors are swallowed and do not trigger fallback. Represent trigger sources as explicit states (`windows-hook`, `x11`, `wayland-helper`, `hotkey`, `interval`, `unavailable`) rather than a boolean.

8. **Power blocker ownership is wrong.** The IPC `start` action starts a power-save blocker even though new sessions begin paused. Tray/second-instance pauses bypass the main-process closure that stops it. Move power management behind capture state transitions so there is exactly one owner and assert that paused/finished sessions release it.

9. **File URLs are assembled by string concatenation.** `file://${p}` breaks on spaces, `#`, `%`, Windows drive letters, and other characters. Use `pathToFileURL()` and remove renderer control of arbitrary filesystem paths.

10. **Search can silently remain empty.** If the index is missing, corrupt, or version-mismatched, the constructor starts empty and does not reconcile all existing guides. Rebuild incrementally at startup, store a source revision/fingerprint, and expose recovery status instead of silently swallowing failures.

11. **Corrupt user data is silently hidden.** `listGuides()` and `listSteps()` skip unreadable entries. Corrupt settings are silently replaced in memory. Quarantine corrupt files, preserve originals, surface a recovery UI/report, and never make a guide disappear without explanation.

12. **Several public settings/schema fields are dead or incomplete.** `language`, `capture.includeCursor`, `editor.autoTitleTemplate`, `library.sortBy`, automatic backup settings, `themeOverride`, `exportProfiles`, `extraImages`, and parts of `links` are unused or only partially used. Implement them end-to-end or remove/migrate them; do not keep misleading UI/data contracts.

13. **Linked-guide locking is racy and barely observable.** Lock acquisition is read-then-write rather than exclusive creation, locks exist only for the short save operation, and two writers can race. Define whether the lock covers the editing session or just a write transaction. Use atomic exclusive creation plus ownership token, heartbeat/stale recovery if session-scoped, and conflict detection based on archive hash/revision before overwrite.

### Export correctness and scalability

1. `renderAllImages()` retains every decoded/rendered RGBA image. A single 4K image is roughly 32 MiB before copies; a large guide can consume gigabytes and terminate the export worker. Render one step at a time, write/consume it, release buffers, and report progress/cancellation.

2. PNG and ZIP decoding are synchronous and memory-heavy. Dimension-only limits still permit enormous allocations (up to 32,768 squared). Set total pixel/byte budgets, validate exact inflated length rather than only “at least,” and move heavy work off the main process.

3. The PDF writer replaces unsupported Unicode with `?`; raster annotation text uses an ASCII 8x8 font; the editor uses system fonts. Therefore the documented WYSIWYG and international-text claims are false. Vendor a properly licensed Unicode font or adopt a vetted renderer, embed/subset fonts, and add multilingual fixtures.

4. Editor and export rendering differ for blur, typography, antialiasing, tooltip layout, and potentially focused-view geometry. Build shared geometry/style calculations and golden-image comparisons with explicit tolerances.

5. Text-block position behavior needs a complete format matrix. Current grouping supports six positions for text blocks, while code/table blocks always fall into `rest`. Existing tests do not prove every position in PDF, DOCX, PPTX, HTML, Markdown, Confluence, and Wiki.js. Fix the reported callout movement issue by defining one canonical ordered content stream and testing every exporter against it.

6. Image sizing is format-specific and inconsistent. Introduce a canonical image layout policy (`natural`, `fit-content-width`, explicit max width/height, preserve aspect ratio, no-upscale) and map physical units correctly for HTML/CSS pixels, PDF points, DOCX twips, and PPTX EMUs. Make it configurable in export profiles and test portrait, landscape, ultrawide, small, and 4K images.

7. Markdown output does not robustly escape table pipes/newlines or choose a safe code-fence length when code contains backticks. Add escaping/conformance tests. Validate Office packages by opening/rendering with LibreOffice in Linux CI, not just by checking ZIP/XML structure. Validate PDF with Ghostscript/Poppler and images/GIF with external tools in a dedicated integration job.

8. Export writes directly into the selected output directory and can leave partial/stale files. Export into a temporary sibling directory, validate, then atomically publish. Define overwrite behavior and clean obsolete sidecar images.

### Build, packaging, and release

1. The current Linux package script is not production packaging. It copies all `node_modules` (including dev tools and vulnerable build dependencies), docs, prompts, examples, and stale audit files; hardcodes `amd64`; declares only `xinput`; lacks desktop entry/icons/MIME integration; and copies a nonexistent root `LICENSE`. The portable tarball excludes the generated `/usr/bin/stepforge` launcher because it archives only `opt/stepforge`.

2. A clean run can build a package without `node_modules`, producing an unusable artifact while tests still pass. Package tests only inspect file existence, not launch/install behavior.

3. Linux startup currently falls back to `--no-sandbox` whenever `chrome-sandbox` is not setuid-root. Do not normalize an unsandboxed production launch. Use a packaging method/configuration that supports Chromium sandboxing (or user namespaces where supported), fail with actionable diagnostics, and reserve `--no-sandbox` for explicitly marked development/CI environments.

4. The launcher auto-repairs/reinstalls Electron with npm and ignores the lockfile. Remove all runtime installation. Development setup uses `npm ci`; packaged applications contain a fixed Electron runtime.

5. The Windows artifact finder returns the first `.exe` encountered and can select the unpacked app executable instead of the NSIS installer. Select the expected artifact by exact pattern/metadata and fail on zero or multiple matches.

6. There is no real app icon/assets directory even though architecture docs claim one, and the Windows test explicitly asserts assets are not packaged. Add licensed original assets and verify Windows/Linux metadata.

7. Versioning is inconsistent: package version, four-part build version, tags, changelog, and committed build reports disagree. Use SemVer for releases, a separate platform file/build version where needed, and generate all metadata from one source. Do not commit stale machine-specific build reports/manifests as if current.

8. The license is contradictory. `package.json` says `MPL-2.0`, contribution docs require MPL-2.0/DCO, while `docs/LICENSE` and README impose a noncommercial license. There is no root `LICENSE`. The owner must choose one license before the next release; then make the SPDX field, root license text, README, contribution policy, package contents, and generated About view agree. This is a legal release blocker and cannot be guessed by an implementation agent.

9. GitHub CI runs only `npm test`, only on pushes to `main`; docs claim full checks on pull requests. Release builds only Windows. Add `pull_request`, run the same authoritative commands everywhere, and add Linux package jobs. Do not allow the click E2E test to convert arbitrary startup failures into skips.

## Target architecture

Refactor incrementally toward these boundaries; do not perform a blind rewrite of the whole app.

```text
app/
  main/                 lifecycle, window policy, IPC composition
  renderer/             views/components with no filesystem privilege
  capture/              platform-neutral session state machine and frame pairing
  platform/
    windows/             Windows hooks, context, power behavior
    linux/               Linux session detection, portal/X11 input, window policy
  services/             export, AI/OCR, search coordination
core/
  domain/               guide/step/block model and migrations
  storage/              transactional repository, recovery, snapshots, locks
  render/               canonical document layout and annotation geometry
exporters/               thin format adapters consuming canonical layout
packaging/
  windows/
  linux/
    debian/
    fedora/
scripts/
  linux/apt/
  linux/dnf/
tests/
  unit/
  integration/
  e2e/
  fixtures/
```

Use dependency injection for OS adapters. The platform-neutral capture coordinator should consume interfaces such as `ClickSource`, `ScreenFrameSource`, `WindowContextProvider`, `WindowVisibilityPolicy`, and `PowerPolicy`. It should never inspect `process.platform` itself. `app/platform/index.js` is the only factory that selects a platform implementation.

Introduce a schema-v2 migration with a single ordered `blocks[]` collection instead of three arrays plus synthesized order. Keep a tested v1 reader/migrator and never rewrite user data without a pre-migration snapshot. Add `revision` fields for optimistic concurrency.

## Phased implementation plan

### Phase 0 — freeze the contract and make the baseline reproducible

- Resolve the license decision and the offline/local-AI product wording with the owner.
- Choose one supported Node LTS that satisfies the entire locked dependency graph (the current graph requires at least Node 22.12 for packaging), add `engines`, `.nvmrc` or `.node-version`, and a hard version check in setup/CI.
- Make `npm ci` the only dependency installation path. Remove auto-install/repair from `scripts/electron-launcher.js` and keep clear diagnostics.
- Refresh and pin the lockfile on the chosen Node/npm version; remediate the two audited build dependency issues. Add production and full dependency audits as separate CI signals with an explicit policy.
- Split tests into deterministic unit, desktop smoke, platform capture E2E, export integration, and package install/launch suites. A missing display may skip only a capture scenario after the app has demonstrably started; a missing shared library or crash must fail.
- Add `pull_request` CI. Run syntax/lint/type checks, unit tests, and artifact checks on Linux and Windows. Keep macOS core tests only if macOS is an intended support target; otherwise stop implying app support.
- Record baseline performance fixtures: 100-step 1080p guide, 25-step 4K guide, large archive, and rapid-click session. Track peak RSS, export time, save latency, and dropped-click count.

### Phase 1 — close privilege boundaries and data-loss paths

- In the main window, reject all navigation away from the exact local app entry URL. Add `setWindowOpenHandler(() => ({ action: "deny" }))`. Route safe external links through a narrow `openExternal` handler after scheme validation and optional confirmation.
- Validate IPC sender/webContents for every handler. Add per-channel input schemas, length/size limits, enum checks, and ownership/path checks. Remove generic `shell:openPath`/`showItemInFolder` from the renderer; replace them with intent-specific commands for known export, preview, data, and linked-archive paths.
- Set `sandbox: true` explicitly for every renderer. Deny all permissions by default and grant display capture only to the capture worker and only for the app’s local URL. Add security regression tests for remote navigation, popup attempts, permission requests, malicious stored HTML, and hostile template archives.
- Remove or default-disable global printable-key capture. Add a privacy disclosure for screenshot/OCR/window-title/AI data. Never persist raw typed text unless the user explicitly opts in.
- Add AI timeouts, cancellation, concurrency limits, loopback policy if required, payload limits, and error states. Ensure stale AI responses cannot overwrite edited revisions.
- Build the serialized revision-aware autosave queue. Keep dirty state on failure, show last successful save time, flush before navigation/quit, and block destructive close only when a flush genuinely fails.
- Make guide/step save operations transactional at the guide level where multiple files must change. Add recovery journals or temp-directory swaps for add/delete/reorder/import/restore. Quarantine and report corrupt data.
- Add archive/template limits and preflight validation. Extract/import into temp storage, validate manifest/schema/all referenced files, then publish atomically.

### Phase 2 — fix known workflows before larger refactors

- Fix region capture’s nested result and listener cleanup. Add tests covering capture service → IPC → renderer selection → optional AI.
- Implement automatic snapshots or remove the dead settings. Make restore atomic and verify rollback after injected failures.
- Rebuild/reconcile the search index at startup and test deletion/corruption/version upgrade.
- Replace file URL concatenation with `pathToFileURL()` and test Windows, spaces, Unicode, `#`, and `%` paths.
- Fix power blocker transitions, evdev trigger reporting, watcher-loss fallback, pending click drain on application shutdown, and strict-mode post-click behavior.
- Validate and clamp all persisted geometry and settings. Reject NaN/infinite/negative image sizes, cyclic parent relationships, invalid block IDs/orders, unsafe image paths, out-of-range focused views, and oversized strings/arrays.
- Inventory every schema/settings field and either implement, migrate, or delete it. Update UI and docs in the same PR.

### Phase 3 — Linux rewrite with separate files (apt and dnf)

This phase must not add more Linux conditionals to `app/capture.js`, `app/text-intel.js`, `app/main.js`, or the Windows hook. First introduce platform interfaces, preserve the tested Windows adapter, and then write Linux implementations in new files.

Create at minimum:

```text
app/platform/index.js
app/platform/windows/capture-adapter.js
app/platform/windows/click-hook.cs
app/platform/windows/window-context.ps1
app/platform/windows/power-policy.js
app/platform/linux/capture-adapter.js
app/platform/linux/session-detection.js
app/platform/linux/portal-frame-source.js
app/platform/linux/x11-click-source.js
app/platform/linux/wayland-click-source.js
app/platform/linux/window-context-x11.js
app/platform/linux/window-policy.js
app/platform/linux/diagnostics.js
scripts/linux/apt/install-build-deps.sh
scripts/linux/apt/install-runtime-deps.sh
scripts/linux/dnf/install-build-deps.sh
scripts/linux/dnf/install-runtime-deps.sh
packaging/linux/debian/package.sh
packaging/linux/debian/control.in
packaging/linux/fedora/package.sh
packaging/linux/fedora/stepforge.spec
packaging/linux/common/stepforge.desktop
packaging/linux/common/stepforge-mime.xml
packaging/linux/common/launcher.sh
docs/linux/apt.md
docs/linux/dnf.md
tests/integration/linux/x11-capture.test.js
tests/integration/linux/wayland-capture.test.js
tests/integration/linux/package-deb.test.sh
tests/integration/linux/package-rpm.test.sh
```

Requirements:

- Support both X11 and Wayland as different capability profiles. X11 may use a separately implemented `xinput` adapter with event-time coordinates. Wayland must use XDG Desktop Portal/PipeWire for screen selection and capture.
- Do not promise global per-click capture with coordinates on Wayland when the platform does not expose it. The safe baseline is portal screen capture plus user-triggered global hotkey or interval capture. Treat direct `/dev/input` access as an optional, explicitly consented privileged mode, not default setup.
- Remove documentation that casually tells every user to join the broad `input` group. If a privileged helper is retained, perform a threat review, use least-privilege device rules, never read keyboard devices, package it separately, and show the security tradeoff before enabling it.
- Detect portal, PipeWire, compositor/session, sandbox, required shared libraries, xinput availability, and permission state in Linux diagnostics. Return actionable UI messages instead of console-only failures.
- On Wayland, map the portal-selected monitor to actual frame metadata. Do not assume `displays[0]` represents the selected screen. Test single/multiple monitors, mixed DPI, negative origins on X11, portal cancellation, stream revocation, suspend/resume, and monitor hotplug.
- Keep Linux minimize/restore/tray behavior in `window-policy.js`; do not branch inside the capture coordinator.
- Apt and dnf runtime dependency lists must be maintained in their separate files and verified in clean Debian/Ubuntu and Fedora containers/VMs. Include Chromium/Electron shared libraries, portal/PipeWire integration, and X11 tools only where needed. Do not install build tools in end-user packages.
- Produce a real `.deb` and `.rpm` from a pruned packaged Electron application. Never copy the development `node_modules` tree. Include architecture mapping (`x64`, `arm64` if supported), icons, desktop entry, categories, MIME registration, license, uninstall behavior, and sandbox-compatible permissions.
- Add Linux artifacts to release CI with checksums/SBOM. Install each artifact in a clean VM/container where possible, launch a smoke screen under Xvfb for X11, and run a real Wayland compositor test job for portal behavior. A package is not accepted merely because `dpkg-deb` or `rpmbuild` produced a file.

Linux acceptance criteria:

- Fresh apt-based and dnf-based systems can follow separate documented setup paths and launch StepForge without `--no-sandbox` or manual npm commands.
- Fullscreen, region, clipboard/import, edit, save, reopen, and export workflows pass on both distro families.
- X11 click capture preserves event time and marker position across DPI/monitors.
- Wayland asks for screen sharing once per recording, handles cancel/revoke, never loops portal prompts, and accurately reports whether the active trigger is hotkey, interval, or an approved click source.
- `.deb` and `.rpm` contain only runtime files and pass install, upgrade, uninstall, dependency, license, desktop-entry, and launch tests.

### Phase 4 — canonical editor/document model

- Migrate to a single ordered block list with text/code/table discriminated types and explicit anchors (`before-title`, `after-title`, `before-description`, `after-description`, `before-image`, `after-image`). Decide whether code/table can use anchors; enforce the decision consistently.
- Refactor the editor into bounded modules: guide state/autosave, step tree, properties form, block editor, annotation controls, capture controls, export dialog, and command history. Avoid framework migration unless it has a measured benefit and an approved dependency cost.
- Replace deprecated `document.execCommand` with an explicit editor model or a small audited implementation. Preserve selection safely, sanitize paste, and implement real link editing instead of inserting `[Text](Link)` placeholders.
- Unify undo/redo around commands and revisions. Include block edits, step metadata, crop/reset, reorder, delete/restore, and AI changes. Do not keep full base64 image copies in renderer history without a bounded disk-backed strategy.
- Make annotation geometry bounded and reusable. Share style/geometry calculations between canvas and raster export. Add rotation/layering only after parity is tested.
- Fix callout placement with exporter matrix fixtures. Add export image sizing controls and saved per-format profiles.
- Add accessibility: semantic buttons, modal roles/names, focus trap and restoration, keyboard traversal, visible focus, screen-reader labels, reduced-motion support, high contrast, and a non-canvas representation of annotations. Run automated accessibility checks plus manual keyboard testing.
- Improve responsive behavior below the current 880px minimum and at 125–200% UI scale. Preserve pane sizes and window bounds per platform.

### Phase 5 — storage, performance, and export hardening

- Add explicit schema migration functions and fixture coverage for every historical schema. Back up before migration and make migrations idempotent.
- Add storage integrity scanning: guide/order references, orphan steps/images, duplicate IDs, missing originals/workings, invalid parents, and recoverable temp files. Provide repair/dry-run output.
- Replace repeated synchronous whole-index writes with an incremental, crash-safe index and background reconciliation. Measure search on large libraries.
- Stream archives and exports where practical. At minimum enforce byte/pixel budgets and render/release one step at a time. Add export progress, cancellation, and worker termination cleanup.
- Introduce a canonical layout layer that computes content order and image constraints once. Keep exporters thin.
- Add Unicode-capable text rendering and licensed embedded fonts. Test CJK, RTL, emoji policy, combining marks, smart punctuation, and long unbroken tokens. If a format cannot support a case, fail or document it rather than substituting silently.
- Add reproducible/golden output tests. Normalize timestamps/IDs where required, render PDF/DOCX/PPTX to images in integration CI, and compare meaningful layout rather than only container structure.
- Add stress/fault tests: disk full, permission denied, interrupted atomic rename, corrupted JSON, ZIP bomb, huge PNG, export worker crash, Ollama timeout, capture worker death, rapid app quit, and concurrent saves.

### Phase 6 — packaging, release, and documentation completion

- Use one packaging system/config source for Windows and Linux where possible, with platform-specific files under `packaging/`. Prune production dependencies and generate an SBOM/license notice.
- Add original icons at required resolutions. Sign Windows artifacts before recommending users bypass SmartScreen; sign/package Linux repositories if repository distribution is introduced.
- Build release artifacts from a clean checkout with `npm ci`, fixed toolchain versions, no dirty files, and no network during the packaging stage. Generate checksums and provenance.
- Test upgrade compatibility using real prior-version user data and installed packages.
- Rewrite README, architecture, security, getting-started, Linux apt/dnf, privacy/AI, file format, and troubleshooting docs to match tested behavior. Remove stale “WIP”/“fixed” claims and stale machine-specific build reports.
- Correct spelling/grammar and links, compress oversized documentation screenshots, and keep generated sample outputs either reproducible and CI-verified or out of version control.

## File-specific work map

- `app/main.js`: split lifecycle/IPC/security policy; navigation guards; permission allowlist; sender/input validation; path intents; capture power ownership.
- `app/capture.js`: reduce to platform-neutral session coordinator, then move every OS branch to adapters; fix region result/listener, strict fallback, shutdown drain, explicit trigger state.
- `app/text-intel.js`: split OCR, platform window context, and Ollama client; remove embedded OS scripts; add privacy controls, timeout/cancel/limits.
- `app/stream-backend.js` and worker: authenticated worker-only IPC, selected-display metadata, cancellation, bounded frames/encodes, lifecycle tests.
- `app/renderer/editor.js`: save state machine, revision conflicts, module split, canonical blocks, reliable undo, modern rich text, accessibility.
- `app/renderer/dialogs.js`: typed settings forms, validation, modal focus/ARIA, safe template options, AI disclosure.
- `core/schema.js`: schema v2, strict validation, bounds, migrations, revisions, unified blocks.
- `core/store.js`: transactions, corruption quarantine, async/heavy-operation strategy, integrity scan, conflict-aware patches.
- `core/archive.js`, `core/zip.js`, `core/snapshots.js`, `core/locks.js`: resource limits, temp validation/atomic swap, exclusive locks/revisions, rollback tests.
- `core/search.js`: startup reconciliation, incremental persistence, visible recovery.
- `core/renderast.js`, `core/raster.js`, `core/pdf.js`: canonical layout, lazy image rendering, WYSIWYG parity, Unicode/font work, resource limits.
- `exporters/*`: typed option schemas, safe escaping, streaming/lazy images, consistent anchors/image sizing, external conformance tests.
- `scripts/electron-launcher.js`: diagnostics only; never install or weaken production sandbox.
- `scripts/package-windows.js`: exact installer selection, assets, signing hooks, clean artifact verification.
- `.github/workflows/*` and `.gitea/workflows/*`: PR triggers, authoritative test commands, Linux distro/package matrix, non-masking E2E behavior, release artifacts/provenance.
- `README.md`, `docs/*`, `package.json`, root `LICENSE`: reconcile support, dependencies, AI/network/privacy, version, license, and build instructions.

## Required test layers

1. **Pure unit tests:** schema/migrations, storage transactions, sanitizer/URLs, archive limits, frame selection, platform parsers, layout calculations, exporter escaping.
2. **IPC contract tests:** instantiate handlers with fake senders and prove invalid origins, paths, sizes, and payloads are rejected. Do not rely on regex extraction alone.
3. **Renderer tests:** save failures/retries, navigation with dirty state, capture-added and AI races, block placement, modals/focus, keyboard and accessibility.
4. **Desktop E2E:** launch packaged/unpackaged app, create/capture/import/edit/save/restart/export. Separate Windows, Linux X11, and Linux Wayland scenarios with explicit capability expectations.
5. **Artifact tests:** install/launch/uninstall `.exe`, `.deb`, and `.rpm`; inspect file lists and dependencies; verify sandbox, icons, desktop integration, version, license, and clean upgrades.
6. **External output tests:** open/render PDF, DOCX, PPTX, HTML, GIF, and images with independent tools; include visual fixtures and multilingual content.
7. **Security/fault tests:** hostile navigation, malicious HTML/template/archive, ZIP bomb budgets, arbitrary IPC paths, permission denial, disk failures, worker crashes, stale AI responses, and captured-secret prevention.

## Definition of done

- No release-blocking security or license contradiction remains.
- No production launch path downloads dependencies or uses `--no-sandbox` by default.
- User edits remain visibly dirty until durably saved; injected failures and concurrent AI/capture updates do not lose data.
- Automatic backups, restore, archive import, and linked saves are transactional and tested.
- Windows, apt-based Linux, and dnf-based Linux use separate platform/setup/package files and pass their documented capability matrices.
- Linux `.deb` and `.rpm` install and launch from clean systems with only runtime dependencies.
- Region capture, callout placement, image sizing, Unicode, large-guide exports, and click-session shutdown have regression tests.
- CI runs on pull requests, cannot hide startup crashes as skips, and tests the same commands documented for contributors.
- README, Security, Architecture, Privacy/AI, support matrix, package metadata, changelog, and license all describe the shipping application accurately.

## Recommended PR sequence

1. Reproducible toolchain/CI and test-runner truthfulness.
2. Navigation/IPC/permission security boundary.
3. Privacy and AI/network contract.
4. Revision-aware autosave and transactional storage.
5. Region capture, power/session state, and shutdown fixes.
6. Archive/snapshot/lock/search recovery hardening.
7. Platform interface extraction with Windows behavior preserved.
8. Linux apt/X11 implementation and `.deb` packaging.
9. Linux dnf/X11 implementation and `.rpm` packaging.
10. Linux Wayland portal implementation and honest fallback behavior.
11. Canonical blocks/callout placement and image sizing.
12. Lazy exports, Unicode rendering, and external conformance tests.
13. Editor modularization/accessibility/UX polish.
14. Signed, reproducible release pipeline and final documentation reconciliation.

Do not combine these into one PR. Each PR must include migration/rollback notes where user data or package layout changes, automated tests proportional to risk, and a short manual verification matrix for the affected operating systems.
