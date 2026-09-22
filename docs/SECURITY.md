# Security

## Security issues in the app

Please report all security issues via email directly to `git@twestbrook.com`. Please do NOT create a public issue or PR supporting this.


## Network boundary

Core capture, editing, and exports work offline. There is no telemetry,
analytics, update checking, or license validation. Optional AI and Google Drive
sharing are explicitly configured and off by default; see [PRIVACY.md](PRIVACY.md).
The sandboxed renderer has no direct network or token access.

Google Drive uses browser-based OAuth with PKCE and state validation, a
short-lived listener bound to 127.0.0.1, and the limited `drive.appdata` scope.
Tokens are stored through OS-backed Electron safeStorage; plaintext Linux
fallback is refused. Google requests use fixed HTTPS endpoints, reject
redirects, and have time and transfer-size limits. Turning sync off cancels
in-flight requests; it cannot undo a request already accepted by Google.

## Threat Model

The app accepts user-imported files and, when sharing is enabled, archives from
Google Drive app storage. Downloaded archives are untrusted and must pass the
same archive validation before installation. Immutable cloud versions preserve
concurrent writes. Incoming replacements are deferred while editing or recording,
and staged installation retains local backups. See [GOOGLE_DRIVE.md](GOOGLE_DRIVE.md).

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

Report vulnerabilities by sending an email to `git@twestbrook.com`

