# Getting started with StepForge

This guide takes you from a fresh install to a finished, exported guide. If
you haven't installed StepForge yet, start with the
[installation options in the README](../README.md#install).

- [1. Record a guide](#1-record-a-guide)
- [2. Edit your steps](#2-edit-your-steps)
- [3. Annotate screenshots](#3-annotate-screenshots)
- [4. Export](#4-export)
- [5. Organize your library](#5-organize-your-library)
- [6. Share guides and keep backups](#6-share-guides-and-keep-backups)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Troubleshooting](#troubleshooting)

## 1. Record a guide

1. Open StepForge and choose **New guide**.
2. Choose **Capture → Start capture session**. StepForge reminds you how to
   stop, then hides itself.
3. Work through the task you want to document. **Each click creates a step**
   with a screenshot taken at the moment of the click and a marker on the
   spot you clicked.
4. When you're finished, stop the session:
   - **Windows:** use the red StepForge icon in the system tray.
   - **Linux (GNOME):** use **StepForge REC** in the top panel, or restore
     StepForge from the dock.

StepForge reads the text around each click (with on-device OCR) and uses it
to title the step, so you'll usually see titles like *Click Releases* or
*Select Run anyway* without typing anything.

**Other ways to add steps**

| To... | Do this |
| --- | --- |
| Take a single screenshot | **Capture → Capture full screen**, **Capture window**, or **Capture region…** |
| Capture with the keyboard | Press **Ctrl+Shift+1** (change it in **Settings → Capture → Hotkeys**) |
| Pause and resume a session | Press **Ctrl+Shift+2** |
| Use an image you already have | Paste it with **Ctrl+V**, or use **Capture → Import images…** |
| Add a text-only step | Choose **Add** in the steps list |

> [!TIP]
> On first recording under GNOME Wayland you'll be asked to enable the
> StepForge extension and pick which monitors to share. Select every monitor
> you plan to click on. See [Linux recording](linux/linux_install.md#recording-on-gnome-wayland)
> for details.

## 2. Edit your steps

The editor has three panes:

- **Steps (left).** Every step in order. Drag or use **Alt+↑ / Alt+↓** to
  reorder. Use **Make substep of…** to nest a step under another one; substeps
  are numbered 1.1, 1.2, and so on.
- **Screenshot (middle).** The captured image with its annotations.
- **Details (right).** The step title, description, status, and extra
  content blocks.

For each step you can:

- **Write a description** with bold, italics, lists, quotes, and links.
- **Set a status** of *Todo*, *In progress*, or *Done* to track your review.
- **Add blocks** for anything that isn't a screenshot:
  - **Text block** as a Note, Tip, Important, or Warning callout
  - **Code** with a language label, for commands and snippets
  - **Table** for settings, values, or comparisons
- **Hide** a step (kept in the editor, left out of exports) or mark it
  **Skipped**.
- Turn on **Focused** view to zoom the exported screenshot toward the click,
  so readers see the relevant part of the screen instead of the whole desktop.
- Start a **New page** at this step in paged formats such as PDF.

**Working with many steps at once:** choose **Select**, click one step, then
**Shift-click** another to select everything in between, including substeps.
A normal click toggles a single step.

## 3. Annotate screenshots

Pick a tool from the toolbar above the screenshot and drag on the image.

| Tool | Key | Good for |
| --- | --- | --- |
| Select | `S` | Moving, resizing, and restyling existing annotations |
| Rectangle / Oval | `R` / `O` | Framing a button or area |
| Line / Arrow | `L` / `A` | Pointing from one thing to another |
| Text / Tooltip | `T` / `G` | Labels and callouts |
| Number | `N` | Numbered badges that count up automatically |
| Blur | `B` | Hiding passwords, email addresses, and other private data |
| Highlight | `H` | Drawing attention without covering anything |
| Magnify | `M` | Enlarging small text or icons |
| Cursor | `U` | Adding a mouse pointer |
| Crop | `C` | Trimming the screenshot |

Annotations stay editable. The original screenshot is never modified, so you
can always change or remove them later.

> [!IMPORTANT]
> Check every screenshot for personal or confidential information before you
> share a guide, and cover it with the **Blur** tool.

## 4. Export

Choose **Export**, pick a format, and choose where to save.

| Format | Best for |
| --- | --- |
| **PDF** | Sending or printing a polished, paged document |
| **DOCX** | Editing further in Microsoft Word or Google Docs |
| **PPTX** | Training sessions and walkthrough slides |
| **Markdown** | Git repositories, READMEs, and docs sites |
| **HTML** (simple or rich) | A single web page; *rich* adds a sidebar and done-checkboxes |
| **Confluence** | Importing into Confluence |
| **Wiki.js** | Publishing to a Wiki.js site |
| **GIF** | A short animated walkthrough |
| **Image bundle** | Numbered, annotated PNGs for use anywhere |
| **JSON** | Feeding guides into your own tools |

Each format has options (page size, table of contents, image width, and so
on). Save your preferred options as a **template** so every guide exports the
same way. Templates can be shared with teammates as `.sfglt` files.

**Placeholders** keep repeated text consistent. Define one in
**Settings → Placeholders** (for example `Product` → `Admin Portal`) and type
`[[Product]]` in any title or description. It's replaced when you export.
Guides can also have their own placeholders under **More → Guide placeholders…**.

## 5. Organize your library

The library is your home screen.

- **Folders** group related guides. Right-click a guide to move it.
- **Favorites** (★) pin the guides you use most.
- **Search** (top bar) looks through the titles and text of every guide and
  step.
- **Trash** keeps deleted guides until you empty it, so a mistake is easy to
  undo.

Guides live in your StepForge data folder. To keep them somewhere else, such
as a larger drive, use **Settings → General → Guide storage**. StepForge copies
and verifies your library before switching to the new location.

## 6. Share guides and keep backups

- **Share → Share this guide as a .sfgz file** packages a guide and all of its
  images into one file. Anyone with StepForge can open it with
  **Import → Import a copy of a guide (.sfgz)…**.
- **Linked guides** let several people work from one `.sfgz` on a shared
  folder. StepForge saves back to the file and warns you if someone else has
  it open.
- **Snapshots** are automatic backups of each guide. Open
  **More → Backups & snapshots…** to create one by hand or roll back.
  **Settings → Editor → Snapshots to keep** controls how many are kept.
- **Google Drive sync** keeps your library the same on all your computers.
  See [Google Drive sync](GOOGLE_DRIVE.md).

## Keyboard shortcuts

Press **Ctrl+/** for the quick-actions palette, or open
**More → Keyboard shortcuts…** for the full list.

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+1` | Capture a step (global) |
| `Ctrl+Shift+2` | Pause / resume capture (global) |
| `Ctrl+S` | Save |
| `Ctrl+/` | Quick actions |
| `PageUp` / `PageDown` | Previous / next step |
| `Alt+↑` / `Alt+↓` | Move step up / down |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+V` | Paste an annotation, or paste an image as a new step |
| `Ctrl+Delete` | Delete the current step |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / fit |

## Troubleshooting

**Clicks aren't creating steps on Linux.** Make sure you're on a GNOME Wayland
session, that you logged out and back in after installing StepForge, and that
you enabled the StepForge extension when prompted. If your desktop can't report
clicks, **Settings → Capture → When clicks can't be detected** lets you capture
with the hotkey or on a timer instead.

**The screenshot shows the wrong moment.** Add a short delay under
**Settings → Capture → Delay** if the app you're documenting animates slowly.

**Where are my files?**

| System | Location |
| --- | --- |
| Windows | `%APPDATA%\stepforge` |
| Linux | `~/.local/share/stepforge` |

The exact folder is shown in **Settings → About**.

Still stuck? [Open an issue](https://github.com/Twest2/StepForge/issues/new/choose)
and include your operating system, StepForge version (from **Settings → About**),
and what you expected to happen.
