# Linux screen-sharing troubleshooting

On GNOME Wayland and KDE Plasma 6 Wayland, StepForge uses
`xdg-desktop-portal` to request screen-sharing consent, then reads the granted
PipeWire stream. It never bypasses that consent or substitutes another screen
when capture fails.

## Match the message to the next step

| Message | What to try |
| --- | --- |
| Sharing was cancelled | Start recording again and select the monitors you want to share. Cancelling is different from a portal failure. |
| Sharing timed out | Look for a sharing dialog behind other windows. Retry; if the dialog never appears, check the services below. |
| Portal is unavailable | Check `xdg-desktop-portal` and the backend for your current desktop: `xdg-desktop-portal-gnome` or `xdg-desktop-portal-kde`. After installing missing packages, log out and back in. |
| Screen stream stopped | Check PipeWire, WirePlumber and the portal backend. Reconnect any disconnected monitor, then start a new recording. |
| Sharing ended | Start a new recording and share every monitor you want to record. Existing guide steps remain saved. |
| Capture helper could not run | Check Python 3, PyGObject, GStreamer and its PipeWire plugin. For a source or portable install, use the runtime-dependency script below. |
| Monitor was not shared | Restart recording and select that monitor too. StepForge will not capture a different monitor instead. |

Run these commands in a terminal in your logged-in graphical session:

```bash
echo "$XDG_SESSION_TYPE / $XDG_CURRENT_DESKTOP"
systemctl --user status xdg-desktop-portal.service pipewire.service wireplumber.service
systemctl --user list-units --all '*portal*'
journalctl --user -b -u xdg-desktop-portal.service --no-pager -n 80
```

Check the listed GNOME or KDE backend service too. Unit names vary between
distributions; a missing unit is a diagnostic clue, not a reason to install
every desktop's backend. If packages are installed but services keep failing,
save your work and log out and back in before retrying. StepForge does not
restart desktop services automatically.

For a source checkout or portable installation, the maintained dependency
scripts select the current desktop's packages:

```bash
bash scripts/linux/apt/install-runtime-deps.sh   # Ubuntu / Debian
bash scripts/linux/dnf/install-runtime-deps.sh   # Fedora
```

GNOME click recording also needs the StepForge Capture extension. Follow
[the GNOME setup instructions](CONTRIBUTING.md#testing-on-ubuntu-and-gnome-wayland)
if the error names the extension rather than screen sharing.

## Local diagnostic log

Capture failures write `logs/linux-capture.jsonl` inside StepForge's data
directory. The error includes the absolute log path when logging succeeds.
`STEPFORGE_DATA_DIR` changes the data directory for development sessions.

Each line contains a UTC timestamp, desktop (`gnome` or `plasma`), failure
category, and, when known, the portal operation (`CreateSession`,
`SelectSources`, `Start` or `OpenPipeWireRemote`). It contains no screenshots,
window titles, guide content, raw stderr, D-Bus payloads or account details.
There are no telemetry requests or automatic uploads.

The active file rotates at 256 KiB, retaining one previous file with a `.1`
suffix (about 512 KiB total). New log files use owner-only permissions on
Linux. Logs are best effort; an unwritable directory does not hide the
original capture failure. You can remove these files while StepForge is
closed. They are recreated only when another capture failure occurs.

When reporting a problem, include the displayed message, your desktop and
session type, and relevant diagnostic lines. Review system journal output
before sharing it: system logs can include more information than StepForge's
own diagnostic log.

The request handling follows the upstream
[Request response and Close semantics](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Request.html)
and [ScreenCast session lifecycle](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html).
