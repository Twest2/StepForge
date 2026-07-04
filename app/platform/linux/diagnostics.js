'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

/**
 * Linux capture-capability diagnostics. Detects the session type, portal /
 * PipeWire availability, xinput, readable input devices, and the sandbox
 * situation, and turns them into an actionable capability profile the UI can
 * show instead of console-only failures.
 *
 * Pure detection with injectable probes so it is unit-testable without a real
 * desktop session.
 */

function defaultHasBinary(name) {
  try {
    execFileSync('which', [name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function detectSessionType(env = process.env) {
  const t = String(env.XDG_SESSION_TYPE || '').toLowerCase();
  if (t === 'wayland' || t === 'x11') return t;
  if (env.WAYLAND_DISPLAY) return 'wayland';
  if (env.DISPLAY) return 'x11';
  return 'unknown';
}

function detectLinuxCapabilities({
  env = process.env,
  hasBinary = defaultHasBinary,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
} = {}) {
  const sessionType = detectSessionType(env);
  const isWayland = sessionType === 'wayland';

  // XDG Desktop Portal + PipeWire are how Wayland screen capture works.
  const hasPortalBus = Boolean(env.DBUS_SESSION_BUS_ADDRESS);
  let hasPipeWire = false;
  try {
    hasPipeWire = hasBinary('pipewire') || existsSync(`/run/user/${process.getuid ? process.getuid() : ''}/pipewire-0`);
  } catch {
    hasPipeWire = hasBinary('pipewire');
  }

  const hasXinput = hasBinary('xinput');
  const hasXprop = hasBinary('xprop');

  // Readable /dev/input event nodes gate the evdev click fallback.
  let readableInputDevices = 0;
  try {
    for (const name of readdirSync('/dev/input')) {
      if (!/^event\d+$/.test(name)) continue;
      try { fs.accessSync(`/dev/input/${name}`, fs.constants.R_OK); readableInputDevices += 1; } catch { /* not readable */ }
    }
  } catch { /* /dev/input not present */ }

  // Determine the click-capture profile for this session.
  let clickCapture;
  if (!isWayland && hasXinput) clickCapture = 'x11-xinput';
  else if (readableInputDevices > 0) clickCapture = isWayland ? 'evdev-wayland' : 'evdev-x11';
  else clickCapture = 'hotkey-or-interval-only';

  const messages = [];
  if (isWayland && !hasPipeWire) {
    messages.push('Wayland screen capture needs PipeWire and the XDG Desktop Portal. Install pipewire and xdg-desktop-portal.');
  }
  if (isWayland && !hasPortalBus) {
    messages.push('No D-Bus session bus detected; the screen-share portal cannot be reached.');
  }
  if (!isWayland && !hasXinput) {
    messages.push('xinput not found: per-click capture with a marker is unavailable on X11 without it.');
  }
  if (clickCapture === 'hotkey-or-interval-only') {
    messages.push('No global click source available. Recording falls back to a hotkey or interval trigger.');
  }

  return {
    os: 'linux',
    sessionType,
    isWayland,
    hasPortalBus,
    hasPipeWire,
    hasXinput,
    hasXprop,
    readableInputDevices,
    clickCapture,
    // Portal capture is the safe Wayland baseline; X11 can grab directly.
    screenCapture: isWayland ? 'wayland-portal' : 'x11-direct',
    messages,
  };
}

module.exports = { detectLinuxCapabilities, detectSessionType };
