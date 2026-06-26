# Getting Started with StepForge on Linux

> ⚠️ **Work in progress.** Linux support is still under active development.
> Expect rough edges — especially on Wayland (see the limitations below). X11 /
> Xorg is the most complete path today. Please report issues.

StepForge was built on Windows, where the OS lets an app watch every click and
grab the screen freely. Linux is more restrictive, and **how much works depends
on whether you are running X11 (Xorg) or Wayland.** This guide explains the
difference, how to get the best experience, and how to enable per-click capture.

## TL;DR

| | **X11 / "Ubuntu on Xorg"** | **Wayland (default on Ubuntu)** |
|---|---|---|
| Screenshot per click | ✅ Yes | ✅ Yes (needs `input` group) |
| Red circle on the click | ✅ Yes | ❌ No (Wayland hides the cursor position) |
| "Share your screen" prompt | Never | Once per recording session |
| Setup needed | None | Add yourself to the `input` group |

**If you want the full Windows-like experience (click capture *with* the red
marker), use an Xorg session — see [Option A](#option-a-best-experience--use-xorg).**

---

## 1. Check which session you are running

```bash
echo $XDG_SESSION_TYPE
```

- `x11`  → you're on Xorg. Everything works, including the red click marker. No setup needed.
- `wayland` → you're on Wayland. Read on.

---

## Option A (best experience) — use Xorg

On Xorg, StepForge captures a screenshot **on every click** and draws the **red
marker** at the exact click position, exactly like Windows. No dependencies, no
permissions, no portal dialogs.

To switch:

1. Log out.
2. On the login (password) screen, click the **⚙ gear icon** in the bottom-right corner.
3. Choose **"Ubuntu on Xorg"**.
4. Log back in.

That's it — open StepForge and record. (To go back to Wayland later, pick
"Ubuntu" at the gear menu again.)

---

## Option B — stay on Wayland

Wayland deliberately blocks apps from monitoring global input and from grabbing
the screen silently. StepForge works around this as far as the platform allows:

### Screen capture

The first time you press **Start recording**, the system shows a **"Share your
screen"** dialog (the XDG desktop portal). Pick your screen and click **Share**.
This happens **once per recording session** — not per screenshot. The shared
stream stays open until you stop recording.

> If you never see steps appear, make sure you actually picked a screen and
> clicked **Share** in that dialog.

### Per-click capture (requires the `input` group)

By default on Wayland, StepForge cannot see your clicks, so it falls back to
**capturing a screenshot every few seconds** (timed capture).

To get a screenshot **on every click** instead, give your user read access to
the mouse devices by joining the `input` group:

```bash
sudo usermod -aG input "$USER"
```

Then **log out and log back in** (group membership only applies to new sessions).
Verify it took effect:

```bash
groups | tr ' ' '\n' | grep input    # should print: input
```

Now StepForge reads mouse buttons directly from the kernel (`/dev/input`) and
captures a screenshot on each click.

> **No red marker on Wayland.** Even with per-click capture working, Wayland
> does not tell apps *where* the pointer is, so StepForge cannot draw the circle
> at the click. The screenshot is still captured per click — just without the
> marker. If you need the marker, use [Option A (Xorg)](#option-a-best-experience--use-xorg).

### Adjusting the timed-capture interval

If you don't enable the `input` group, StepForge captures on a timer. Change the
interval in **Settings → Capture** (`capture.autoIntervalSec`, default 5
seconds).

---

## How StepForge picks a capture method (for reference)

On launch StepForge chooses the best available click source:

1. **Windows** — low-level mouse hook (position + timing).
2. **X11** — `xinput` (position + timing → full red marker).
3. **Linux evdev** (`/dev/input`) — button presses on X11 *and* Wayland, no
   position on Wayland. Used when `xinput` can't see clicks (i.e. Wayland), if
   you're in the `input` group.
4. **Timed capture** — the always-works fallback (a screenshot every N seconds)
   when no click source is available.

Screen frames come from a single long-lived capture stream per recording, so
clicks/timer ticks never re-open the screen-share dialog.

---

## Troubleshooting

**"It asks to share my screen every time."**
You're likely on an older build. Update to the current version — the screen
stream is now opened once per recording session. If it persists, confirm
`echo $XDG_SESSION_TYPE` and that you clicked **Share** (not Cancel) in the dialog.

**"Recording captures a couple of steps then stops."**
Fixed in the current version (a slow, GPU-less PNG encode used to trip a
failure guard and tear down the stream). Update and retry.

**"The window disappeared and I can't stop the recording."**
On Linux the window **minimizes** while recording (GNOME's system tray is
unreliable). Bring it back from the **taskbar / dock**, then click **Stop
recording**.

**"No steps at all on Wayland, even after picking a screen."**
Run from a terminal with logging and look for the diagnostic lines:

```bash
STEPFORGE_CAPTURE_LOG=1 npm start
```

- `[stepforge] screen-capture stream active …` — the stream is up.
- `[stepforge] per-click capture via evdev on N device(s) …` — clicks are wired up.
- `[stepforge] no readable mouse input devices …` — you need the `input` group (see above).

**Harmless console noise.** Lines like `vaInitialize failed`, `Frame latency is
negative`, and `StatusNotifierItem … already exported` come from Chromium/GNOME,
not StepForge, and don't affect recording.
