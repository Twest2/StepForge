# KDE Plasma 6 on Wayland

StepForge supports Fedora 44 KDE Plasma Desktop and Kubuntu 26.04. Install
the same RPM or Debian package used for GNOME. The KDE portal satisfies the
package's desktop dependency, so installing StepForge on Plasma does not
install GNOME. Plasma 5 is outside this capture path.

On first recording, Plasma asks which monitors to share and which global
shortcuts StepForge may use. Share monitors rather than individual windows.
StepForge uses KWin's window geometry and titles to crop Window captures and
place click markers. Recording controls are in StepForge's tray menu; Pause
and Finish there are excluded from the recording. Panel clicks may take up
to five seconds to become steps while StepForge distinguishes tray actions.

Capture region opens Spectacle's area selector. Both target KDE desktops
normally include Spectacle; install it with `sudo apt install kde-spectacle` or
`sudo dnf install spectacle` if you removed it.

The package installs a udev rule granting the active local seat access to
mice and touchpads, excluding keyboard devices. No membership in the broad
`input` group is needed. If mouse buttons are unreadable after installation,
reconnect the mouse or log out and back in. To disable this access, mask
`/usr/lib/udev/rules.d/60-stepforge-input.rules` with a `/dev/null` symlink
at `/etc/udev/rules.d/60-stepforge-input.rules` and reload udev rules.

For a source checkout or tarball, install the runtime dependencies using
`scripts/linux/apt/install-runtime-deps.sh` or
`scripts/linux/dnf/install-runtime-deps.sh`, then run
`bash scripts/linux/enable-click-capture.sh` to install the mouse access rule.
Run the dependency installer inside the Plasma session so it selects KDE's
portal.

While recording, a temporary KWin script supplies window and pointer context;
the helper reads button presses and touchpad taps, respecting Plasma's tap,
clickfinger and left-handed settings. It unloads the script and closes input
devices on stop. A screen-layout change or session lock stops recording;
restart and share the updated monitors. If KWin does not answer, recording
reports the error rather than silently changing to timed capture.

CI builds and installs both packages in clean containers, checks that GNOME
was not installed, runs a real headless KWin with a Wayland test window and
synthetic mouse-device events, and renders the installed Electron app. It
does not automate the human portal consent dialogs or physical input hardware.
