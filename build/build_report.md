# StepForge Build Report

Version: 0.1.0
Generated: 2026-06-11T02:38:15.730Z
Host: linux x64 (node v20.20.2)

## Outputs

- Portable tarball: artifacts/stepforge_0.1.0_linux-x64.tar.gz
- Debian package: artifacts/stepforge_0.1.0_amd64.deb
- Sample guide archive: ../examples/sample-guide.sfgz
- Sample exports (9 formats): see examples/sample-exports/
- Full artifact list with sha256 checksums: artifacts_manifest.json

## Packaging tool availability

| Tool | Status |
|---|---|
| dpkg-deb (Linux .deb) | available |
| rpmbuild (Linux .rpm) | **missing** |
| appimagetool (Linux AppImage) | **missing** |
| makensis (Windows installer .exe) | **missing** |
| wixl / WiX (Windows .msi) | **missing** |

Fallback policy: when a packaging tool is missing the build still produces
the runnable app (portable tarball with launcher) plus whatever package
formats the available tools allow. Windows artifacts are produced by
`npm run package:windows` (electron-builder, portable .exe); .msi/.rpm/
AppImage require the tools listed above and are skipped on this host.

## Offline guarantee

- The shipped app opens no sockets: no telemetry, update checks, license
  checks, cloud sync, or remote AI. See SECURITY.md.
- All exporters (PNG/GIF/PDF/DOCX/PPTX/ZIP) are implemented in-repo with
  Node built-ins; Electron is the only third-party dependency
  (dev-time fetch recorded in build/agent_audit.md).

## Verification

- `bash tests/run_test.sh` runs the workflow suites (node --test), a
  startup smoke test of the Electron launcher, the sample-artifact
  pipeline, and this release build.
