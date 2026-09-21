# StepForge privacy and network contract

StepForge is **local-first**. Guides, screenshots, and settings live on your
machine. Network integrations are off by default. This document describes
what StepForge collects locally and the optional features that send data.

## What never happens

- No telemetry or analytics.
- No update checks, license checks, or "phone home".
- No cloud storage or sync unless you explicitly enable Google Drive sharing.
- No dependency downloads at runtime (dependencies are installed only by you,
  via `npm ci`).

## Data StepForge collects locally

When you capture a step, StepForge may record, **stored locally in your data directory**, capture context to help title and describe the step:

- The screenshot image.
- OCR text read from the region around your click (via the bundled Tesseract
  engine — this runs locally, it is not a network call).
- The foreground window title and application name.
- The accessibility label/role/value of the clicked UI element (Windows).
- Keyboard shortcuts you pressed (for example `Ctrl+T`).

### Raw typed text is OFF by default

StepForge can additionally record the **raw printable characters** you type
between captures. Because this can capture passwords or other secrets, it is
**disabled by default**. It is only recorded when you explicitly enable
`capture.captureTypedText`, and even then the characters are used only to
title the current step and are not retained beyond it. With the setting off,
raw characters are never read or stored (on Windows they never even leave the
keyboard-hook process).

## Optional AI

StepForge has an **optional** AI integration that generates step titles and
descriptions with a local large-language-model runtime
([Ollama](https://ollama.com)). It is **off by default**. When you turn it on
and configure an endpoint:

- StepForge sends the step **screenshot** (only to vision-capable models, only
  when "Attach screenshots" is on, and only if within the size limit) and the
  step **text/capture context** to the configured Ollama endpoint.
- By default the endpoint must be a **local (loopback) address** — for example
  `http://127.0.0.1:11434`. StepForge refuses to send data to a non-loopback
  host unless you explicitly enable **"Allow remote AI host"**. Enabling that
  option means your screenshots and text are sent to the remote host you
  configured; StepForge cannot control what that host does with them.
- Every AI request has a timeout, can be cancelled (closing the guide cancels
  in-flight requests), and runs under a bounded concurrency limit.

## Optional Google Drive sharing

Google Drive sharing is off by default. Signing in uses Google's OAuth endpoints
and a local loopback callback. Connection testing refreshes authentication,
checks app storage, and uploads/downloads/deletes a small random test file;
it does not upload guides.

Once you explicitly enable sharing, all local guides (including screenshots,
text, annotations, placeholders, and stored capture context) are uploaded as
archives to that Google account's private app storage. Updates from your other
devices are downloaded automatically. This access is limited to app storage,
not your other Drive files. It uses HTTPS, not StepForge end-to-end encryption.

Credentials are OS-encrypted locally and are never sent to the renderer.
Turning sharing off stops background transfers. Disconnecting also removes
local credentials, but preserves cloud and local guides. Cloud archive versions
and local replacement backups are retained; local deletion does not delete
cloud copies. See [Google Drive setup, testing, and limitations](GOOGLE_DRIVE.md).

## Bundled dependencies

Beyond the Electron desktop shell, StepForge bundles the Tesseract OCR engine
and its English language data as production dependencies. All OCR runs locally.

## Where your data lives

- Windows: `%APPDATA%\stepforge`
- Linux: `~/.local/share/stepforge` (or `$XDG_DATA_HOME/stepforge`)
- Override with the `STEPFORGE_DATA_DIR` environment variable.
