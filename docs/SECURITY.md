# Security

## Reporting a vulnerability

Please email **`git@twestbrook.com`** with a description of the issue and
steps to reproduce it. **Don't open a public issue or pull request** for
security problems, so users aren't exposed before a fix is available.

Fixes are released as a new version on every distribution channel (GitHub
Releases, Chocolatey, APT, and DNF), so keeping StepForge updated is the best
way to stay protected.

## Security at a glance

- **Offline by default.** Capture, editing, OCR, and export make no network
  connections. There's no telemetry, license check, or automatic update check.
- **Opt-in networking only.** AI and Google Drive sync are off until you turn
  them on, and **Check for updates** runs only when you press it. All are
  described in the [privacy policy](PRIVACY.md).
- **Sandboxed interface.** The app's window runs in Chromium's sandbox with no
  direct access to your files, the network, or credentials.
- **Untrusted files are validated.** Imported guides, templates, and images are
  checked before anything is written to disk.

The rest of this page describes those protections in more detail.

## Application hardening

The Electron renderer runs with `contextIsolation`, `sandbox`, and
`nodeIntegration: false`. Its only access to the rest of the app is an
explicit, allowlisted IPC API defined in `app/preload.js`. The main window may
only display StepForge's own page; navigation and pop-ups are blocked.

Rich text in guides is sanitized against an allowlist of tags and attributes
(no scripts, event handlers, or external URLs) both when it's saved and again
when it's displayed or exported. Exports contain no remote fonts, scripts, or
CDN references.

On Linux, StepForge refuses to start without the Chromium sandbox rather than
silently running unprotected.

## Imported files

**Guide archives (`.sfgz`) and templates (`.sfglt`)** are zip files. Every entry
is validated before extraction (`core/zip.js`):

- names must be relative, with no `..` segments, drive letters, or absolute paths;
- each resolved path must stay inside the destination folder;
- sizes come from the actual decompressed data, never from trusted headers;
- entries outside the documented layout are ignored.

**Images (PNG, JPEG, GIF)** are decoded by the platform codecs and re-encoded
as PNG before they're stored. StepForge's own PNG decoder (`core/png.js`,
used by exporters) rejects malformed dimensions, oversized allocations, and bad
checksums.

## Google Drive sync

- Sign-in uses the system browser with OAuth PKCE, `state` validation, and a
  short-lived callback listener bound to `127.0.0.1`.
- Only the `drive.appdata` scope is requested, which limits StepForge to its
  own private app folder.
- Tokens are stored with Electron `safeStorage` (the OS credential store). On
  Linux, StepForge refuses to fall back to plaintext storage.
- Requests go only to fixed Google HTTPS endpoints, reject redirects, and have
  time and size limits.
- **Downloaded guides are treated as untrusted** and pass the same archive
  validation as imports. Uploads create immutable versions, so two computers
  can't overwrite each other. Incoming updates wait while you're editing or
  recording, and the replaced local copy is backed up.
- Turning sync off cancels requests in flight, though it can't undo one Google
  has already accepted.

## Known limitations

- **Guides aren't encrypted at rest.** They're protected by your user account's
  file permissions, like any other documents. If you need to send a guide
  securely, encrypt the `.sfgz` with a separate tool.
- **Linked-guide locks are advisory.** When several people open the same
  `.sfgz` on a shared folder, a `<name>.lock-sfgz` file records who has it
  open. It helps people coordinate but isn't a security boundary; a crashed or
  hostile client can remove it. Conflicting saves are shown to the user, and
  the last save wins.
- **Screenshots contain what was on screen.** Review and blur sensitive
  information before sharing.
