# Security

## Offline Guarantee

StepForge ships with **zero network code paths**. The application:

- opens no sockets and performs no HTTP requests,
- has no telemetry, crash reporting, or analytics,
- performs no update checks and no license validation,
- has no account system, cloud sync, or remote AI integration,
- embeds no remote fonts, CDNs, or external references in exports.

The only network activity in the project's lifetime is the one-time
development fetch of the Electron shell via npm (see
`build/agent_audit.md`). The packaged app never goes online.

## Threat Model

Because the app is local-only, the realistic attack surface is **malicious
files opened by the user**:

### Archive imports (`.sfgz`, `.sfglt`)

Both formats are zip files. The reader in `core/zip.js` validates every entry
before extraction:

- entry names must be relative, must not contain `..` segments, drive
  letters, or absolute paths;
- entries are extracted only beneath the destination directory (resolved
  path is verified to stay inside it);
- file sizes are taken from actual inflated data, not trusted headers;
- unknown entries outside the documented layout are ignored.

### Image imports (PNG/JPEG/GIF)

Imported images are decoded by the platform image codecs in the Electron
shell and re-encoded to PNG before storage. The pure-JS PNG decoder in
`core/png.js` (used by exporters) rejects malformed dimensions, oversized
allocations, and bad CRCs.

### Linked guides and lock files

Shared `.sfgz` files opened in *linked mode* use a sidecar lock file
(`<name>.lock-sfgz`) containing the holder's machine name and timestamp.
This is an advisory lock for coordination on shared folders, **not** a
security boundary: a hostile or crashed peer can delete it. Conflicts are
surfaced to the user with keep-editing / discard options; the format is
last-write-wins and that risk is documented in the UI.

### Local data at rest

The guide store is **not encrypted at rest** — it inherits the user account's
filesystem protections, like any document folder. If you need encrypted
sharing, encrypt the `.sfgz` with external tooling; native encrypted archives
are a tracked enhancement, not a current feature.

## Renderer Hardening

The Electron renderer runs with `contextIsolation: true` and
`nodeIntegration: false`; the only privileged surface is the explicit
allowlisted IPC API in `app/preload.js`. Guide description HTML is sanitized
(allowlisted tags/attributes, no scripts, no event handlers, no external
URLs) before storage and again before rendering or export.

## Reporting

Report vulnerabilities by opening an issue marked `security` (this is a
local-only tool, so coordinated disclosure pressure is low; do not include
exploit archives directly — describe the structure instead).
