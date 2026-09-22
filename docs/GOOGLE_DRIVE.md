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

After connecting, open **Advanced** and choose **Test connection**. It checks sign-in,
refreshes authorization, checks private storage access, uploads and downloads
a small temporary file, verifies its bytes, and deletes it. Each result is
shown separately. The test itself does not upload a guide; existing automatic
synchronization resumes afterwards if enabled.

These cloud controls apply immediately, independently of the Settings Save or
Cancel buttons. **Sync now** requests a pass. While you are signed in with
**Auto-sync** on, a Drive indicator in the top bar shows pending, syncing,
synced, conflict, or error states and opens Settings. It is hidden otherwise.

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
- Each guide keeps its latest snapshot and up to two previous snapshots in
  Drive; older ones are pruned automatically after a successful sync. Local
  replacement backups are not pruned. Guides use complete snapshots rather
  than incremental image transfers. Transfers
  are limited to 256 MB per archive and have a 60-second request deadline;
  unusually large guides or slow connections may need a later retry.
- If another computer's pruning removes the version this computer last synced,
  this computer re-evaluates the guide after two minutes, downloads the latest
  version, and keeps any unsynced local edits as a conflict copy.
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

## Browse and manage Drive guides

**Settings → Google Drive sharing** shows the connected account, sync status,
and an **Auto-sync** switch. Below it:

- **Storage** shows how much space StepForge uses in Drive. The app folder is
  hidden, so this is the only place to see it. The bar splits the total into
  latest versions, previous versions, and deleted-guide recovery copies, and
  shows the share of your Google storage quota when Google reports one.
  **Free up space** deletes every previous version after confirmation. The
  latest version of every guide is always kept. Removed versions cannot be
  restored.
- **Guides in Drive** lists every active cloud guide, including ones not in
  this computer's library. Choose **Versions** to see the latest version and
  up to two previous versions, then **Restore** one. Close the guide editor
  and stop capture first. Restoring replaces the local content and preserves
  the previous local copy in the cloud backup directory. With sharing enabled,
  the restored content becomes a new cloud version on the next sync. A guide
  already excluded from sharing stays excluded. Guides only in Drive also offer
  **Download**, which installs the latest version on this computer.
- **Delete from Drive** removes all of that guide's cloud versions after
  confirmation. This cannot be undone. Local copies are kept and this computer
  stops sharing that guide. Other computers still sharing it may upload it again.
- **Recently deleted** lists recovery copies of deleted guides, which can be
  restored or permanently deleted.

### Use this computer as the source of truth

**Advanced → Replace Drive with this computer** makes this computer's library
the only content in Drive. After confirmation it deletes every cloud version,
previous version, and recovery copy, then uploads the guides on this computer.
Guides that were in Drive but are not on this computer are marked deleted, so
your other computers move them to their trash. Guides on other computers that
are still in this library update to this computer's version; unsynced edits on
those computers are kept as conflict copies. Auto-sync must be on. This cannot
be undone.

These actions apply immediately; the Settings Save button is not required.
Confirmations return to the same Settings panel, keeping unsaved fields intact.
