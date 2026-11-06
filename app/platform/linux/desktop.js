'use strict';

/**
 * Which Linux desktop StepForge is running on, from the session environment.
 * Only Wayland sessions of GNOME and KDE Plasma 6 have their own capture
 * services; everything else (X11, other compositors) uses the shared one.
 */

function isWaylandSession(env = process.env) {
  return env.XDG_SESSION_TYPE
    ? env.XDG_SESSION_TYPE.toLowerCase() === 'wayland' : Boolean(env.WAYLAND_DISPLAY);
}

/** 'gnome' | 'plasma' | 'other'. GNOME keeps its original test, checked first. */
function detectLinuxDesktop(env = process.env) {
  const current = env.XDG_CURRENT_DESKTOP || '';
  if (/gnome|ubuntu/i.test(current)) return 'gnome';
  // Plasma sets XDG_CURRENT_DESKTOP=KDE and KDE_SESSION_VERSION=6. Plasma 5
  // has a different KWin scripting API, so it stays on the shared service.
  if (/(^|:)kde($|:)/i.test(current)) {
    const version = Number(env.KDE_SESSION_VERSION);
    return !env.KDE_SESSION_VERSION || version >= 6 ? 'plasma' : 'other';
  }
  return 'other';
}

/** The desktop whose own capture service applies here, or null. */
function waylandCaptureDesktop(platform = process.platform, env = process.env) {
  if (platform !== 'linux' || !isWaylandSession(env)) return null;
  const desktop = detectLinuxDesktop(env);
  return desktop === 'other' ? null : desktop;
}

// Shifted digits become punctuation in KDE's shortcut portal (e.g. Shift+2
// is @ on a US keyboard), so those default triggers do not match key events.
// Letter keys also keep distinct IDs in Electron's portal backend (function
// keys generate the same empty ID there). Saved choices win.
const PLASMA_HOTKEYS = {
  hotkeyCapture: 'CommandOrControl+Alt+C',
  hotkeyPauseResume: 'CommandOrControl+Alt+P',
};

module.exports = { isWaylandSession, detectLinuxDesktop, waylandCaptureDesktop, PLASMA_HOTKEYS };
