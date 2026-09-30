# Sync with OneDrive, Dropbox or Nextcloud

StepForge can back up your guides and keep them in sync between your
computers with **Google Drive**, **OneDrive**, **Dropbox**, or your own
**Nextcloud or WebDAV server**. Sync is off until you sign in.

Open **Settings → Accounts** and choose a service.

| Service | How you sign in | Where guides are stored |
| --- | --- | --- |
| Google Drive | Your Google account, in the browser | A hidden app folder only StepForge can see ([details](GOOGLE_DRIVE.md)) |
| OneDrive | Your Microsoft account (personal, work or school), in the browser | `Apps/StepForge` in your OneDrive |
| Dropbox | Your Dropbox account, in the browser | `Apps/StepForge` in your Dropbox |
| Nextcloud or WebDAV | Nextcloud: your server's own login page. Other servers: a user name and password | A `StepForge` folder in your account |

StepForge only gets access to its own folder. It can't see or change anything
else in your OneDrive, Dropbox, or Nextcloud.

Sync works the same way on every service: versions, restoring, conflict
copies, recently deleted guides, and **Free up space** are all described in
[Google Drive sync](GOOGLE_DRIVE.md). Every service stores only what changed
between versions, so a screenshot that appears in many versions is stored once.

## One account at a time

StepForge syncs with one account at a time. Signing in to a different service
switches this computer to it:

- Your guides stay on this computer and are uploaded to the new service.
- Everything already stored with the previous service stays there. Nothing is
  deleted.
- Your other computers keep syncing with the previous service until you
  switch them too. Switch every computer so they all see the same guides.

## Nextcloud and other WebDAV servers

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
files with coded names. Leave them as they are; StepForge manages them.

## Disconnecting

**Disconnect** stops syncing on this computer and removes the saved sign-in.
Your guides stay on this computer and with the service. To remove StepForge's
access completely:

- **OneDrive:** in your Microsoft account, open **Privacy → Apps and
  services** and remove StepForge. Delete `Apps/StepForge` from OneDrive to
  remove its files.
- **Dropbox:** open **Settings → Connected apps** and remove StepForge. Delete
  `Apps/StepForge` to remove its files.
- **Nextcloud:** revoke the StepForge app password under **Settings →
  Security**, and delete the `StepForge` folder.
