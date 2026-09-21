# Optional Google Drive sharing

Google Drive sharing is off by default. Sign-in and connection testing do not
turn it on. Enabling **Automatically share guides with Google Drive** uploads
all guides in the local library, including screenshot files, annotations,
descriptions, and capture metadata, to the selected Google account. It also
downloads guides from your other devices. Local guides remain usable offline.

## Set up and test authentication

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select
   a project and enable **Google Drive API**.
2. Configure the OAuth consent screen. If the project is in Testing, add your
   Google account as a test user. Google may expire test-mode refresh tokens;
   if StepForge reports revoked/expired authorization, disconnect and sign in
   again. Public distribution requires appropriate Google OAuth configuration.
3. Create an OAuth client of type **Desktop app**, not Web application.
4. In StepForge, open **Settings → Google Drive sharing → Google OAuth setup**.
   Enter the client ID and client secret from that Desktop app client.
5. Choose **Sign in with Google**, complete consent in your system browser,
   and return to StepForge. You can cancel sign-in in Settings.
6. Choose **Test Google Drive connection**. The results separately report:
   - authentication and refresh-token validity;
   - access to StepForge's Drive app storage;
   - uploading a small random test file;
   - downloading it and checking that its bytes match;
   - deleting the temporary test file.
   No guide is uploaded by the connection test. A failed cleanup is reported.
7. Enable automatic sharing when ready. Repeat on the other computer using
   the **same Google account and OAuth project**, preferably the same client.

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
Tokens and the configured client credentials are encrypted using Electron's
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

Before release, use a real OAuth Desktop app client and two isolated devices:

1. Confirm sharing starts off and ordinary capture/edit/export works offline.
2. Sign in and run the connection test; check that every stage passes.
3. Enable sharing on both devices. Edit a guide on A; wait for synced; close
   the editor on B and verify its title, steps, images, and annotations update.
4. Edit both copies offline, reconnect, and confirm both edits remain available
   as separate guides after synchronization. Repeat with simultaneous uploads.
5. Open a guide on B while A uploads; verify B shows pending and preserves its
   unsaved input until leaving the editor.
6. Revoke access in Google, then run the connection test. Check the actionable
   sign-in error. Disconnect/reconnect and verify recovery.
7. Disable sharing during a transfer; confirm further background work stops
   and local guides remain. Restart to verify the setting persists.

Google references: [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[app storage](https://developers.google.com/workspace/drive/api/guides/appdata),
[uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads).
