# Sync your guides between computers

Sync keeps your StepForge library the same on every computer you use. Your
guides, with their screenshots, annotations, and text, follow you, along with
the [settings guides depend on](#settings-that-sync).

Sync is **optional and off by default**. StepForge works fully offline without
it.

## Choose a service

| Service | How you sign in | Where guides are stored |
| --- | --- | --- |
| [Google Drive](#google-drive) | Your Google account, in the browser | A hidden app folder only StepForge can see |
| [OneDrive](#onedrive-and-dropbox) | Your Microsoft account (personal, work or school), in the browser | `Apps/StepForge` in your OneDrive |
| [Dropbox](#onedrive-and-dropbox) | Your Dropbox account, in the browser | `Apps/StepForge` in your Dropbox |
| [Nextcloud or WebDAV](#nextcloud-and-other-webdav-servers) | Nextcloud: your server's own login page. Other servers: a user name and password | A `StepForge` folder in your account |

Every service works the same way. StepForge only gets access to its own
folder, and can't see or change anything else in your account.

## Connect

1. Open **Settings → Accounts** and choose your service.
2. Sign in. For Nextcloud or WebDAV, type your server's address first (see
   [below](#nextcloud-and-other-webdav-servers)).
3. Allow StepForge access in the browser. StepForge comes back to the front,
   shows which account is connected, and starts syncing. You can close the
   browser tab.
4. On your other computers, install StepForge and sign in to the **same**
   account.

If the browser doesn't open, or opens the wrong one, choose **Open it again**
or **copy the sign-in link** under the sign-in button and paste the link into
any browser on this computer.

Changes in these settings take effect immediately. You don't need to press
**Save**.

On Linux, StepForge keeps sign-ins in your desktop's keyring (GNOME Keyring,
KWallet, or another Secret Service such as KeePassXC). If sign-in says it needs
an operating-system credential store, make sure a keyring is installed and
unlocked, then restart StepForge.

### One account at a time

StepForge syncs with one account at a time. Signing in to a different service
switches this computer to it:

- Your guides stay on this computer and are uploaded to the new service.
- Everything already stored with the previous service stays there. Nothing is
  deleted.
- Your other computers keep syncing with the previous service until you
  switch them too. Switch every computer so they all see the same guides.

## Everyday use

There's nothing to do. StepForge uploads a guide a few seconds after you save
it and checks for changes from your other computers about every 30 seconds.

The **sync indicator** in the top bar shows your service's name and what's
happening (waiting, syncing, up to date, or needs attention). While a guide is
uploading (↑) or downloading (↓), it shows a live counter such as
**Drive: ↓ 3.2 MB / 12.0 MB**. Click it to open the sync settings.

> [!TIP]
> Before switching computers, wait until the indicator shows the guide is up
> to date.

- **Sync now** starts a sync immediately.
- **Auto-sync** pauses and resumes syncing on this computer.
- **Test connection** (under **Advanced**) checks sign-in and storage access
  by uploading, downloading, and deleting a small temporary file. It never
  uploads a guide.

To keep one guide on this computer only, open it, choose
**More → Guide information…**, and turn off **Include this guide in cloud
sync**.

## How changes are handled

- **Edits from different computers are combined.** If you edit the same
  guide on two computers before they sync, StepForge puts both sets of changes
  into the one guide. Changes to different steps, to different parts of a step,
  or to different annotations all survive. Steps added on either computer are
  kept, and a step deleted on one computer is removed unless it was edited on
  the other. This isn't live co-editing.
- **When both computers changed the same thing**, such as the same step
  title, the most recent change is kept. If this computer had edits that
  hadn't synced yet, its earlier version is saved as a *before-sync-merge*
  snapshot under **More → Backups & snapshots…**, so nothing is lost.
- **Your work isn't interrupted.** Updates from another computer wait until
  you close the guide and stop recording.
- **Downloads are checked** before they replace anything, and the replaced
  local copy is kept as a backup in your data folder.
- **Deleting a guide deletes it on your other computers too.** They move it
  to their Trash, and one recovery copy stays in the cloud under
  [Recently deleted](#manage-whats-stored). Restore it from the Trash on any
  computer and it comes back everywhere.
- **Going offline is fine.** Local edits are kept and sync resumes when you're
  back online.
- **Folders combine like guides.** Creating, renaming, moving and deleting
  folders on different computers all survive. When two computers changed the
  same folder or guide, the most recent change is kept. Deleting a folder
  moves its guides and sub-folders to the top of the library, as it does on
  the computer where you deleted it; no guide is deleted. The first time a
  computer syncs its folders, a folder with the same name (matched exactly)
  and in the same place as one already in the cloud is treated as that folder,
  so the two aren't listed twice. Matching new folders also converge when
  computers upload at the same time. Intentionally creating two sibling
  folders with the same name keeps two folders.

### Settings that sync

These settings follow your guides across computers:

- **Global placeholders** (**Settings → Placeholders**)
- **Brand profiles**, with their logos, banners and fonts, and which profile
  is active (**Settings → Branding**)
- **Interface language** (**Settings → General → Language**)
- **Recording shortcuts** for Capture and Pause/resume
  (**Settings → Capture → Hotkeys**)

Other capture options, AI and guide storage stay on each computer.

They're combined the same way as guides: changes made on different computers
all survive, and when two computers changed the same value, the most recent
edit wins. Deleting a placeholder or profile deletes it everywhere, unless
another computer edited it. A computer syncing for the first time adds its
placeholders and profiles to the ones already there, and its untouched
defaults never replace a choice you made on another computer.

Changes from another computer wait while **Settings** is open and arrive when
you close it. If settings sync shows an error, usually because another
computer saved them with a newer StepForge, update StepForge on this computer.
Until then your settings are left as they are, and guides keep syncing.

## Manage what's stored

Your service's page in **Settings → Accounts** also lets you see and tidy up
what StepForge has stored there. Buttons use your service's name, such as
**Delete from OneDrive**.

**Storage** shows how much space StepForge uses, split into latest versions,
previous versions, and recovery copies of deleted guides.

**Free up space** deletes all previous versions after you confirm. The latest
version of every guide is always kept. Deleted versions can't be recovered.

**Guides in …** (for example **Guides in Drive**) lists every guide StepForge
has stored, including ones that aren't on this computer.

- **Versions** shows a guide's latest version and up to two previous ones.
  **Restore** puts an earlier version back. Close the guide and stop any
  recording first. Your current local copy is backed up before it's replaced.
- **Download** installs a guide that's only in the cloud onto this computer.
- **Delete from** your service permanently removes all of a guide's cloud
  versions after confirmation. Your local copy is kept and stops syncing.
  Other computers that still sync the guide may upload it again.

**Recently deleted** holds one recovery copy of each deleted guide, which you
can restore or delete permanently.

### How versions are stored

Each version stores **only what changed**. A screenshot is uploaded once and
shared by every version (and every guide) that contains it, so fixing a typo
uploads a few kilobytes instead of the whole guide. Downloads work the same
way: a computer only fetches the screenshots it doesn't already have.

Versions saved as full copies by an older StepForge keep working. **Free up
space** switches them to space-saving versions.

> [!IMPORTANT]
> Update StepForge on **every** computer that syncs with the same account.
> Older releases can't read space-saving versions: they show a sync error for
> those guides instead of changing them. They also don't combine edits, and
> may still save separate *conflict copy* guides.

### Make this computer the source of truth

If your computers have drifted apart and you want one of them to win, open
**Advanced** and choose **Replace … with this computer** (for example
**Replace Drive with this computer**). After you confirm, StepForge:

1. Deletes everything StepForge has stored with your service, including all
   versions and recovery copies.
2. Uploads the guides and [settings](#settings-that-sync) on this computer.
3. Tells your other computers to move any guide that isn't on this computer
   to their Trash, and to update the rest to this computer's version.
   Unsynced edits on those computers are combined with this computer's version.

**Auto-sync** must be on to use this.

> [!WARNING]
> This can't be undone. Make sure this computer has everything you want to
> keep.

## Limits

- Each guide keeps its **latest version plus up to two previous versions**.
  Older versions are removed automatically after a successful sync.
- A guide can be up to **1 GB**, and each file in it, such as a screenshot,
  up to **256 MB**. Very large guides on slow connections may take more than
  one attempt.
- The first sync of a guide sends all of it. After that, only new or changed
  files are sent.
- Folders are stored as one list per account: about 2 KB for 10 folders with
  50 guides in them, and about 16 KB for 50 folders with 500 guides. A library
  without folders stores no folder list at all.
  Computers on older versions of StepForge ignore it and keep syncing guides
  as before.

## Service details

### Google Drive

StepForge stores its files in a private, hidden area of your Drive reserved
for the app. It has no access to your documents, photos, or anything else, and
for the same reason its files don't appear in your Drive file list. The
**Storage** card in StepForge is the only place to see how much space they use.

To remove everything StepForge stored, revoke its access under
[your Google account's third-party connections](https://myaccount.google.com/connections),
then in Google Drive open **Settings → Manage apps**, find StepForge, and
choose **Delete hidden app data**.

### OneDrive and Dropbox

StepForge only gets its own folder, `Apps/StepForge`. With OneDrive, personal,
work and school accounts all work. Leave the files in `Apps/StepForge` as they
are; StepForge manages them.

To remove StepForge's access:

- **OneDrive:** in your Microsoft account, open **Privacy → Apps and
  services** and remove StepForge. Delete `Apps/StepForge` from OneDrive to
  remove its files.
- **Dropbox:** open **Settings → Connected apps** and remove StepForge. Delete
  `Apps/StepForge` to remove its files.

### Nextcloud and other WebDAV servers

Type your server's address, such as `cloud.example.com`, and choose
**Sign in**.

- **Nextcloud** opens its login page in your browser. Log in and grant access;
  Nextcloud gives StepForge its own app password, which you can revoke at any
  time under **Settings → Security** in Nextcloud. Two-factor sign-in works.
- **Other WebDAV servers** (ownCloud, NAS devices, hosted WebDAV) ask for a
  user name and password. Enter the address of the WebDAV folder, for example
  `https://nas.example.com/webdav/`. If the server offers app passwords, create
  one for StepForge instead of using your main password.

StepForge only sends a password over `https://`, except to servers on your own
network (such as `192.168.1.20` or `nas.local`), where plain `http://` is
allowed.

The `StepForge` folder holds a `parts` folder and an `objects` folder of
files with coded names. Leave them as they are; StepForge manages them. To
remove StepForge's access, revoke its app password under **Settings →
Security** in Nextcloud, and delete the `StepForge` folder.

## Disconnect

**Disconnect** stops syncing on this computer and removes the saved sign-in.
Your guides stay on this computer and with the service. To remove StepForge's
access completely, see your service under [Service details](#service-details).

## Privacy and security

- With Google, Microsoft, Dropbox and Nextcloud, you sign in on their own
  website in your browser, so StepForge never sees your password.
- Sign-ins are stored encrypted with your operating system's credential
  storage.
- Guides are sent over HTTPS and stored in your own account. They aren't
  additionally encrypted by StepForge, so treat them like any other file in
  that account.

The [privacy policy](PRIVACY.md#optional-google-drive-sync) lists exactly what
is sent, and the [security overview](SECURITY.md) explains how it's protected.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Google sign-in finishes but StepForge says Drive access wasn't granted | Choose **Sign in with Google** again and leave the Google Drive permission ticked on Google's consent page. |
| "sign-in is unavailable in this build" | You're running a development build. Install an official release. |
| Sign-in says it needs an operating-system credential store (Linux) | Install and unlock a keyring, such as GNOME Keyring or KWallet, then restart StepForge. |
| The indicator shows *needs attention* | Open your service in **Settings → Accounts** to see the error. For sign-in problems, choose **Sign in again**. |
| A guide from another computer hasn't arrived | Make sure that computer finished syncing, then choose **Sync now**. Close the guide if it's open here. |
| Your storage is full | Choose **Free up space**, or free up space elsewhere in your account. |

---

*Maintainers: see [Google sign-in](cloud_accounts_init_setup/GOOGLE_DRIVE_RELEASE.md)
and [OneDrive and Dropbox sign-in](cloud_accounts_init_setup/CLOUD_ACCOUNTS_RELEASE.md)
release configuration.*
