# Optional Google Drive sharing

> **Google Drive is currently in testing.**
> Google Drive sharing is currently available only to Google accounts that
> have been added as approved test users for StepForge's Google OAuth app.
> If your account is not an approved test user, Google will block sign-in.
> This restriction is temporary while the Google integration is being tested.
> To be added to the test list, please contact git@twestbrook.com. You will 
> be added just Google requires a list of accounts.

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







Maintainers/contributers: see [Google sign-in release configuration](GOOGLE_DRIVE_RELEASE.md)
for the one-time application registration and packaging requirements.

Google references: [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[app storage](https://developers.google.com/workspace/drive/api/guides/appdata),
[uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads).

Archive compression for normal uploads runs in a background worker shared with
linked archive writes and automatic backups. Jobs run one at a time to limit CPU
and disk contention. Uploads recheck cancellation and sharing permissions after
compression, and edits made during compression remain pending for the next sync.
File discovery and content hashing still run on the main process. Backup history
is excluded from cloud change detection because it is not part of uploaded guides.
