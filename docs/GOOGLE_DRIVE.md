# Optional Google Drive sharing

Google Drive sharing is off until you choose **Sign in with Google**. Signing
in and allowing access enables automatic sharing of your local guides,
including screenshots, annotations, descriptions, and capture metadata.
Local guides remain usable offline.

## Connect your Google account

1. Open **Settings → Google Drive sharing** and choose **Sign in with Google**.
2. Choose your Google account in the browser and allow StepForge to store its
   app data in Drive. StepForge does not request access to your other Drive files.
3. Return to StepForge. Settings shows **Connected as** your email address,
   and guides begin synchronizing automatically.
4. Sign in to the same Google account in StepForge on your other computer.

You do not need an API key, client ID, client secret, or Google Cloud project.
You can cancel sign-in at any time. Turn off **Automatically sync guides** to
pause sharing, or choose **Disconnect** to remove this device's connection.

## Test your connection

After connecting, choose **Test Google Drive connection**. It checks sign-in,
refreshes authorization, checks private storage access, uploads and downloads
a small temporary file, verifies its bytes, and deletes it. Each result is
shown separately. The test itself does not upload a guide; existing automatic
synchronization resumes afterwards if enabled.

These cloud controls apply immediately, independently of the Settings Save or
Cancel buttons. **Sync now** requests a pass; the top-bar Drive indicator opens
Settings and shows pending, syncing, synced, conflict, or error states.

## Sync behavior

- Local saves trigger an upload after approximately three seconds without new
  saves. StepForge checks Drive approximately every 30 seconds while running.
  Keep StepForge running until its status says synced before changing devices.
- Updates are complete `.sfgz` archive snapshots stored in Google Drive's private
  `appDataFolder`. They do not appear in the ordinary My Drive file list and
  cannot be shared with other Google accounts through this feature.
- Each upload creates an immutable version linked to its previous version.
  Concurrent devices cannot overwrite each other's uploads. If edits diverge,
  StepForge preserves conflict copies in the library. This is not live
  collaboration or automatic merging of individual steps.
- Incoming replacements wait until the editor is closed, pending edits are
  saved, and recording is paused/stopped. Downloads are validated before
  installation, and a change during download prevents replacement.
- Replaced local guides are retained under `cloud/backups` in the app data
  directory. A journal recovers an interrupted directory replacement.
- Disconnecting disables sync and removes credentials on this device. It does
  not delete local guides, cloud versions, or copies on another computer.
  Revoke the app in your Google account to remove its authorization remotely.
- Deleting a guide is local-only. A guide already synchronized and deleted
  locally is not automatically restored by subsequent polls. Another device
  still has its copy, and a fresh installation can download the cloud copy.
- This initial implementation retains cloud versions and local replacement
  backups; it does not automatically prune them. They consume storage. Guides
  use complete snapshots rather than incremental image transfers. Transfers
  are limited to 256 MB per archive and have a 60-second request deadline;
  unusually large guides or slow connections may need a later retry.
- Network failures leave local edits intact. Background polling retries while
  sharing is enabled; Settings reports authentication, permission, quota, and
  connection errors.

## Credentials and scope

The main process opens the Google OAuth browser flow using PKCE, a random
state value, and a short-lived loopback callback listener. It requests only
`https://www.googleapis.com/auth/drive.appdata`, not access to all Drive files.
Your access and refresh tokens are encrypted using Electron's
OS-backed `safeStorage` and are never returned to the renderer or written to
ordinary settings. Linux's insecure `basic_text` fallback is refused; unlock
or configure an OS keyring if sign-in reports a credential-store error.

Guides are transferred over HTTPS. The archive itself is not end-to-end
encrypted by StepForge; the Google account's storage protections apply.
No telemetry or StepForge-hosted account/server is involved.

## Verification

Automated tests use real local guide/archive files and mocked Google responses.
They cover PKCE/state validation, cancellation, secure credential persistence,
refresh and revoked tokens, paginated listing, the connection probe, clean
cross-device updates, concurrent/offline edits, conflict copies, active-editor
protection, integrity failure, retry, disabled mode, and interrupted installs.

Before release, use a build configured with StepForge's registration and two isolated devices:

1. Confirm sharing starts off and ordinary capture/edit/export works offline.
2. Sign in and run the connection test; check that every stage passes.
3. Confirm signing in enables sharing on both devices. Edit a guide on A; wait for synced; close
   the editor on B and verify its title, steps, images, and annotations update.
4. Edit both copies offline, reconnect, and confirm both edits remain available
   as separate guides after synchronization. Repeat with simultaneous uploads.
5. Open a guide on B while A uploads; verify B shows pending and preserves its
   unsaved input until leaving the editor.
6. Revoke access in Google, then run the connection test. Check the actionable
   sign-in error. Disconnect/reconnect and verify recovery.
7. Disable sharing during a transfer; confirm further background work stops
   and local guides remain. Restart to verify the setting persists.

Maintainers: see [Google sign-in release configuration](GOOGLE_DRIVE_RELEASE.md)
for the one-time application registration and packaging requirements.

Google references: [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[app storage](https://developers.google.com/workspace/drive/api/guides/appdata),
[uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads).
