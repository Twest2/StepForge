# Privacy

**Short version:** StepForge keeps your guides on your computer. It has no
accounts, collects no analytics, and doesn't contact the internet unless you
turn on Google Drive sync, connect GitHub to share guides, point AI at a remote
server, or press **Check for updates**.

## What StepForge never does

- No telemetry, analytics, or crash reporting.
- No automatic update checks, license checks, or "phoning home".
- No uploads unless you sign in to Google Drive or publish a guide to GitHub.
- No downloading code or components while it runs.

## What StepForge stores on your computer

When you capture a step, StepForge saves the following in your
[data folder](#where-your-data-lives) to build the step and suggest its title:

| Item | Why |
| --- | --- |
| The screenshot | It's the step. |
| Text near your click, read with on-device OCR | To title the step, e.g. *Click Save*. OCR runs locally with the bundled Tesseract engine. |
| The active window's title and application name | Context for the title. |
| The clicked element's accessibility label and role (Windows) | A more precise title. |
| Keyboard shortcuts you pressed, such as `Ctrl+T` | So steps like *Press Ctrl+T* are recorded. |

### Typed text is not recorded by default

StepForge can optionally record the characters you type between clicks to
title steps like *Type the server name*. Because that could capture a password,
it's **off by default**. It only turns on if you set `capture.captureTypedText`
in the settings file, and even then characters are used only to title the
current step and aren't kept afterwards. With the setting off, typed
characters are never read (on Windows they don't leave the keyboard hook).

> [!TIP]
> Screenshots show whatever was on screen. Use the **Blur** tool to hide
> anything sensitive before you share a guide.

## Finding private details

**Find private details** and the check before publishing read your
screenshots with the same built-in text recognition StepForge uses for step
titles. It runs entirely on your computer and sends nothing anywhere. It
doesn't keep the text it reads. For a blur you mark "not private", it keeps
only a one-way fingerprint (a SHA-256 hash), so it won't be suggested again.
The words you list under **Settings → Privacy** are stored in StepForge's
settings on this computer.

## Checking for updates

**Settings → About → Check for updates** asks GitHub whether a newer version
of StepForge has been released. It only happens when you press the button,
never automatically. StepForge sends a single request to GitHub containing
only its version number (as the browser-style "User-Agent"); GitHub sees your
IP address as with any website visit. See the
[GitHub Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).

The Ubuntu `.deb` and Fedora `.rpm` add the StepForge APT or DNF repository
(`packages.twestbrook.com`) to your system's software sources, as installing
from the repository does. That traffic comes from your package manager, not
StepForge: your system downloads the repository's package list whenever it
refreshes software sources (`apt update` / `dnf upgrade`, or the desktop's
software updater on its usual schedule), and the server sees your IP address
and the package manager's version. Uninstalling StepForge removes the
repository again; see the [Ubuntu](linux/apt.md#uninstall) or
[Fedora](linux/dnf.md#uninstall) guide.

## Optional AI

AI descriptions are **off by default**. When you enable them
([setup guide](getting_started_with_ai.md)):

- StepForge sends the step's text and capture details, and for image-capable
  models the screenshot, to the [Ollama](https://ollama.com) server you
  configure.
- **By default that server must be on your own computer** (a loopback address
  such as `127.0.0.1`). StepForge refuses other addresses unless you
  explicitly set `ai.allowRemoteHost`. If you do, your screenshots and text go
  to that server, and StepForge can't control what it does with them.
- Screenshots can be left out entirely by setting `ai.attachScreenshots` to
  `false`.
- Every request has a timeout and is cancelled when you close the guide.

## Optional Google Drive sync

Drive sync is **off by default**. When you sign in
([how it works](GOOGLE_DRIVE.md)):

- Sign-in happens in your browser on Google's site. StepForge never sees your
  password.
- StepForge requests one permission, `drive.appdata`, which only covers the
  files it creates in its own hidden folder in your Drive. It can't see your
  other Drive files.
- **Your whole library is uploaded**: screenshots, text, annotations,
  placeholders, and the capture details listed above. It goes to that private
  folder in *your* Google Drive, not to StepForge or anyone else.
  Screenshots are stored once and shared between versions, labelled with a
  fingerprint (SHA-256 hash) of their contents so each is only uploaded once.
- StepForge also reads your Google account's email address, profile photo, and
  Drive storage usage to show which account is connected and how much space
  it's using.
- Data travels over HTTPS. It isn't additionally encrypted by StepForge.
- To combine edits made on different computers, StepForge keeps the text of
  each synced guide as it was last synced, with screenshot fingerprints but no
  screenshots, in the `cloud` folder of your [data folder](#where-your-data-lives).
  Before it combines unsynced edits, it saves your version as one of the
  guide's local backups.
- Your Google token is stored encrypted with your operating system's
  credential storage.
- **Test connection** uploads, downloads, and deletes a small random file; it
  never uploads a guide.
- Turning sync off stops transfers. **Disconnect** also removes the saved
  sign-in. Neither deletes guides from your computer or from Drive. Deleting a
  guide locally doesn't delete it from Drive.
- To remove everything StepForge stored in Drive, revoke its access in your
  [Google Account](https://myaccount.google.com/connections), then in Google
  Drive open **Settings → Manage apps**, find StepForge, and choose
  **Delete hidden app data**.
- StepForge's use of information received from Google APIs adheres to the
  [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
  including the Limited Use requirements.

## Optional OneDrive, Dropbox and Nextcloud sync

These work like Google Drive sync above: off by default, your whole library
is uploaded to *your* account and nowhere else, screenshots are stored once
by SHA-256 fingerprint, and sign-in details are stored encrypted with your
operating system's credential storage. StepForge syncs with one service at a
time. [How it works](CLOUD_ACCOUNTS.md).

- **OneDrive:** you sign in on Microsoft's site. StepForge asks for
  `Files.ReadWrite.AppFolder`, which only covers its own `Apps/StepForge`
  folder, plus your name and email address (`User.Read`) to show which account
  is connected, and storage usage.
- **Dropbox:** you sign in on Dropbox's site. StepForge is an "App folder" app,
  so it can only use `Apps/StepForge`. It reads your name, email address and
  storage usage.
- **Nextcloud:** you log in on your own server's page and it gives StepForge an
  app password. **Other WebDAV servers:** you enter a user name and password,
  which StepForge only sends over HTTPS unless the server is on your own
  network. Everything goes to the server you entered and nowhere else.

## Optional GitHub Pages sharing

Sharing is **off by default**. When you connect GitHub
([how it works](GITHUB_PAGES.md)):

- Sign-in happens on GitHub's website with a short code. StepForge never sees
  your GitHub password. To save typing, StepForge copies that one-time code
  to your clipboard when you choose **Sign in with GitHub**.
- StepForge acts through its GitHub App, which can only reach the
  repositories **you install it on**, with access to their contents, Pages
  settings, and workflows. It can't see or change your other repositories.
- StepForge reads your GitHub username and the list of repositories the App is
  installed on.
- **Only guides you publish are uploaded**, one at a time, when you choose
  **Publish**. A published guide contains its visible steps, screenshots with
  annotations, and text, the same as an Interactive HTML export. It's stored
  in *your* repository, not with StepForge.
- **A published guide is public.** Anyone with its link can open it, and
  anyone who browses a public repository can find it. Published pages ask
  search engines not to index them, but that isn't access control.
- The repository also holds a list of shared guides (titles, StepForge guide
  IDs, and publish and expiry times), a placeholder page, a clean-up
  workflow, and, in a new empty repository, a README. If you use an existing
  repository, nothing else in it is changed.
- Guides are removed when they expire by that workflow, which runs on GitHub,
  or by StepForge. Removing a guide rewrites the site branch so the guide
  doesn't stay in its history, but copies may remain in caches, archives, or
  with anyone who saved the page.
- While connected, StepForge contacts GitHub shortly after it starts to remove
  expired guides.
- After you publish, StepForge checks the new link on your GitHub Pages site
  (a request for the page's headers, not its content) every few seconds for up
  to a few minutes, so it can tell you when the link works.
- Data travels over HTTPS. Your GitHub token is stored encrypted with your
  operating system's credential storage.
- **Disconnect** removes the saved sign-in but leaves shared guides online
  until they expire. To revoke access fully, revoke StepForge under
  [GitHub → Settings → Applications](https://github.com/settings/apps/authorizations),
  and uninstall it from your repository. See the
  [GitHub Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).

## Optional Confluence publishing

Confluence publishing is **off until you connect a site** ([how it works](CONFLUENCE.md)).

- StepForge only talks to the Confluence site you enter. Requests never follow
  redirects, so a token can't be sent anywhere else.
- Your API token or personal access token is stored encrypted with your
  operating system's credential storage. With **Sign in with your browser**,
  the site's cookies are kept in a StepForge browser session used only for
  Confluence.
- When you publish, the guide's text and its screenshots (with private details
  blurred, see above) are sent to the space you choose. Nothing is sent until
  you choose **Publish**.
- A smart card is used through your operating system; StepForge never sees
  your PIN or private key. It remembers which certificate you chose for each
  site.
- **Disconnect** removes the saved sign-in and the Confluence cookies. Pages
  you published stay in Confluence.

## Bundled components

Besides the Electron desktop runtime, StepForge includes the Tesseract OCR
engine and its English language data. All text recognition happens on your
computer.

## Where your data lives

| System | Location |
| --- | --- |
| Windows | `%APPDATA%\stepforge` |
| Linux | `~/.local/share/stepforge` (or `$XDG_DATA_HOME/stepforge`) |

You can move your library under **Settings → General → Guide storage**, or
override the location with the `STEPFORGE_DATA_DIR` environment variable.
Uninstalling StepForge leaves this folder in place. Delete it to remove all of
your guides and settings.

## Questions

Email `git@twestbrook.com` with any privacy question.
