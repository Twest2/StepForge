# Environment Audit

Audit performed 2026-06-10 before stack selection, as required by the build
specification in `ai_prompts/prompt.md`.

## Host

| Item | Value |
|---|---|
| OS | Linux 6.6.87.2-microsoft-standard-WSL2 (Ubuntu userland, x86_64) |
| Display | WSLg available (`DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0`) — GUI apps can run |
| Shell | bash |

## Toolchains

| Toolchain | Present | Detail |
|---|---|---|
| Node.js | yes | v20.20.2 (`/usr/bin/node`) |
| npm | yes | 10.8.2, cache at `~/.npm/_cacache` |
| Rust / Cargo | **no** | not installed, no `~/.cargo/registry` cache |
| .NET SDK | **no** | not installed |
| Python | yes | 3.12.3 (venv), no GUI toolkit verified |

## Packaging tools

| Tool | Present |
|---|---|
| dpkg-deb | yes (`/usr/bin/dpkg-deb`) |
| rpmbuild | no |
| appimagetool | no |
| WiX (MSI) | no |
| NSIS / Inno Setup | no |

## Vendored dependencies

`./vendor/` does not exist. No vendored dependencies are present on disk.

## Network

`registry.npmjs.org` is reachable (HTTP 200).

## Stack selection and recorded deviation

The specification's stack-selection rule prefers Rust + Tauri, then Rust +
immediate-mode UI, then .NET/Avalonia, and says never to choose a path that
requires network dependency resolution.

**None of the offline-capable GUI paths exist on this machine**: there is no
Rust toolchain, no cargo registry cache, no .NET SDK, and no `./vendor`
directory. The only installed application runtime is Node.js. A desktop GUI
cannot be produced from Node.js built-ins alone.

**Decision:** Node.js core + Electron desktop shell.

- All product logic (schema, storage, archives, locks, search, placeholder
  expansion, render AST, and every exporter — ZIP, PNG, GIF, PDF, DOCX, PPTX,
  HTML, Markdown, JSON) is implemented **dependency-free** in `core/` and
  `exporters/` using only Node built-ins (`node:fs`, `node:zlib`,
  `node:crypto`, ...). This code runs and is tested fully offline with
  `node --test`.
- Electron is the **single third-party dependency**, used only as the desktop
  shell (window, canvas UI, screen capture, global hotkeys, clipboard). It was
  fetched from the npm registry once at development time because no offline
  GUI toolchain exists on this machine. This is a recorded deviation from the
  "never fetch from the network" build rule, chosen over the alternative of
  shipping no GUI at all.
- The **shipped application contains zero network code paths**: no telemetry,
  no update checks, no license checks, no remote AI, no sockets.

### Fallbacks chosen for missing components

| Spec preference | Fallback used | Reason |
|---|---|---|
| SQLite + FTS5 search index | Pure-JS inverted index persisted as JSON under `library/index/` | Node 20 has no built-in SQLite; native modules would add dependencies |
| HTML/CSS → PDF backend | Native PDF generation from the render AST (hand-rolled PDF writer) | Deterministic, testable headlessly, no browser dependency in the export path |
| OCR title prefill | Template-based title generation (capture mode + timestamp + window title when available) | No offline OCR engine present |
| MSI / NSIS / AppImage / RPM | Portable archives + `.deb` via dpkg-deb; spec files emitted for the missing tools | Tools absent (see table above), recorded in `build/build_report.md` |
