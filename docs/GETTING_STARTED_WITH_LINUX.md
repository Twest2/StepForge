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
| Screenshot per click | ✅ Yes | ⚙️ Optional (least-privilege mouse rule) |
| Red circle on the click | ✅ Yes | ❌ No (Wayland hides the cursor position) |
| "Share your screen" prompt | Never | Once per recording session |
| Default trigger | Per click | Global hotkey or timed interval |
| Setup needed | None | None (per-click is opt-in, mice only) |

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

### Per-click capture (optional, least-privilege)

By default on Wayland, StepForge cannot see your clicks, so it uses a **global
hotkey or a timed interval** to capture (see below). This is the recommended,
no-extra-permissions path.

If you want a screenshot **on every click**, you can grant StepForge read
access to your **mouse** devices. Do **not** use `sudo usermod -aG input`:
joining the `input` group grants your user access to *all* input devices —
**including keyboards** — permanently, on every session. That is a keylogging
surface StepForge does not need.

Instead, install the least-privilege udev rule, which grants your active
session read access to **mouse devices only** (never keyboards), scoped to
whoever is physically logged in:

```bash
bash scripts/linux/enable-click-capture.sh
```

It shows you the exact rule and asks for confirmation before installing. Under
the hood it uses a systemd `uaccess` ACL restricted to `ID_INPUT_MOUSE`
devices — see [packaging/linux/common/60-stepforge-input.rules](../packaging/linux/common/60-stepforge-input.rules).
Re-log in (or replug a USB mouse) for it to apply.

> **No red marker on Wayland.** Even with per-click capture working, Wayland
> does not tell apps *where* the pointer is, so StepForge cannot draw the circle
> at the click. The screenshot is still captured per click — just without the
> marker. If you need the marker, use [Option A (Xorg)](#option-a-best-experience--use-xorg).

### Adjusting the timed-capture interval

If you don't enable the `input` group, StepForge captures on a timer. Change the
fallback in **Settings → Capture**:

- `When clicks are unavailable` -> `Hotkey only` to use the Capture hotkey
  instead of a timer.
- `When clicks are unavailable` -> `Timed interval`, then set
  `Timer interval (seconds)` (`capture.autoIntervalSec`, default 5 seconds)
  if you want timed captures.

---

## How StepForge picks a capture method (for reference)

On launch StepForge chooses the best available click source:

1. **Windows** — low-level mouse hook (position + timing).
2. **X11** — `xinput` (position + timing → full red marker).
3. **Linux evdev** (`/dev/input`) — button presses on X11 *and* Wayland, no
   position on Wayland. Used when `xinput` can't see clicks (i.e. Wayland) and
   only if you opted into the least-privilege mouse rule
   (`scripts/linux/enable-click-capture.sh`).
4. **Hotkey / timed capture** — the always-works fallback (the Capture hotkey,
   or a screenshot every N seconds) when no click source is available. On
   Wayland this is the default, and StepForge reports it honestly instead of
   pretending clicks are captured.

Open **Settings → Diagnostics** to see the detected session type, portal/
PipeWire status, and the active capture trigger for your machine.

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
- `[stepforge] no readable mouse input devices …` — per-click capture is not
  enabled; run `scripts/linux/enable-click-capture.sh` for the least-privilege
  mouse rule, or just use the hotkey/interval trigger.

**Harmless console noise.** Lines like `vaInitialize failed`, `Frame latency is
negative`, and `StatusNotifierItem … already exported` come from Chromium/GNOME,
not StepForge, and don't affect recording.
