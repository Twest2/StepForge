# Privacy

**Short version:** StepForge keeps your guides on your computer. It has no
accounts, collects no analytics, and doesn't contact the internet unless you
turn on Google Drive sync or point AI at a remote server.

## What StepForge never does

- No telemetry, analytics, or crash reporting.
- No update checks, license checks, or "phoning home".
- No uploads unless you sign in to Google Drive.
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
- StepForge also reads your Google account's email address, profile photo, and
  Drive storage usage to show which account is connected and how much space
  it's using.
- Data travels over HTTPS. It isn't additionally encrypted by StepForge.
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
