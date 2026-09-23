# Sync guides with Google Drive

Google Drive sync keeps your StepForge library the same on every computer you
use. Sign in once on each machine and your guides, including screenshots,
annotations, and descriptions, follow you.

Sync is **optional and off by default**. StepForge works fully offline without it.

## Connect your Google account

1. Open **Settings → Google Drive** and choose **Sign in with Google**.
2. Your browser opens. Pick your Google account and allow StepForge to store
   its data in your Drive.
3. Return to StepForge. You'll see **Connected as** with your email address,
   and your guides start syncing.
4. On your other computer, install StepForge and sign in with the **same**
   Google account.

Changes in the Google Drive settings take effect immediately. You don't need
to press **Save**.

> [!NOTE]
> **StepForge can only see its own files.** It uses a private, hidden area of
> your Drive reserved for the app, and has no access to your documents,
> photos, or anything else. For the same reason, StepForge's files don't appear
> in the normal Drive file list.

## Everyday use

There's nothing to do. StepForge uploads a guide a few seconds after you save
it and checks for changes from your other computers about every 30 seconds.

The **Drive indicator** in the top bar shows what's happening (waiting,
syncing, up to date, or needs attention) and opens the Drive settings when
clicked.

> [!TIP]
> Before switching computers, wait until the indicator shows the guide is up
> to date.

- **Sync now** starts a sync immediately.
- **Automatically sync guides** pauses and resumes syncing on this computer.
- **Test connection** (under **Advanced**) checks sign-in and Drive access by
  uploading, downloading, and deleting a small temporary file. It never
  uploads a guide.

## How changes are handled

- **Nothing is overwritten silently.** If you edit the same guide on two
  computers before they sync, StepForge keeps both: your version stays, and
  the other appears in your library as a *conflict copy*. StepForge doesn't
  merge individual steps; this isn't live co-editing.
- **Your work isn't interrupted.** Updates from another computer wait until
  you close the guide and stop recording.
- **Downloads are checked** before they replace anything, and the replaced
  local copy is kept as a backup in your data folder.
- **Deleting a guide only deletes it on this computer.** The Drive copy
  remains until you remove it from Drive (see below).
- **Going offline is fine.** Local edits are kept and sync resumes when you're
  back online.

## Manage what's in Drive

**Settings → Google Drive** also lets you see and tidy up your Drive storage.

**Storage.** StepForge's Drive folder is hidden, so this is the only place to
see how much space it uses. The bar splits usage into latest versions,
previous versions, and recovery copies of deleted guides.

**Free up space** deletes all previous versions after you confirm. The latest
version of every guide is always kept. Deleted versions can't be recovered.

**Guides in Drive** lists every guide stored in Drive, including ones that
aren't on this computer.

- **Versions** shows a guide's latest version and up to two previous ones.
  **Restore** puts an earlier version back. Close the guide and stop any
  recording first. Your current local copy is backed up before it's replaced.
- **Download** installs a guide that's only in Drive onto this computer.
- **Delete from Drive** permanently removes all of a guide's Drive versions
  after confirmation. Your local copy is kept and stops syncing. Other computers
  that still sync the guide may upload it again.

**Recently deleted** holds recovery copies of deleted guides, which you can
restore or delete permanently.

### Make this computer the source of truth

If your computers have drifted apart and you want one of them to win, use
**Advanced → Replace Drive with this computer**. After confirmation, StepForge:

1. Deletes everything StepForge has stored in Drive, including all versions
   and recovery copies.
2. Uploads the guides on this computer.
3. Tells your other computers to move any guide that isn't on this computer
   to their trash, and to update the rest to this computer's version.
   Unsynced edits on those computers are kept as conflict copies.

**Automatically sync guides** must be on to use this.

> [!WARNING]
> Replacing Drive can't be undone. Make sure this computer has everything you
> want to keep.

## Disconnect

Choose **Disconnect** to sign this computer out. Syncing stops and the saved
sign-in is removed. Your guides stay on this computer and in Drive.

To revoke StepForge's access completely, remove it from
[your Google account's third-party connections](https://myaccount.google.com/connections).

## Limits

- Each guide keeps its **latest version plus up to two previous versions** in
  Drive. Older versions are removed automatically after a successful sync.
- A single guide can be up to **256 MB**. Very large guides on slow
  connections may take more than one attempt.
- Sync sends complete guides, not just the changed images, so large guides
  use more bandwidth.

## Privacy and security

- Sign-in happens in your own browser on Google's website. StepForge never sees
  your Google password.
- The access token is stored encrypted using your operating system's
  credential storage.
- Guides are sent over HTTPS and stored in your Google account. They aren't
  additionally encrypted by StepForge, so treat them like any other file in
  your Drive.

See the [privacy policy](PRIVACY.md#optional-google-drive-sync) and
[security overview](SECURITY.md) for details.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Sign-in finishes but StepForge says Drive access wasn't granted | Choose **Sign in with Google** again and leave the Google Drive permission ticked on Google's consent page. |
| "Google sign-in is unavailable in this build" | You're running a development build. Install an official release. |
| The indicator shows *needs attention* | Open **Settings → Google Drive** to see the error. For sign-in problems, choose **Sign in again**. |
| A guide from another computer hasn't arrived | Make sure that computer finished syncing, then choose **Sync now**. Close the guide if it's open here. |
| Drive is full | Choose **Free up space**, or free up space elsewhere in your Google account. |

---

*Maintainers: see [Google sign-in release configuration](GOOGLE_DRIVE_RELEASE.md).*
