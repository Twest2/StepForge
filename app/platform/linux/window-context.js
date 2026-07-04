'use strict';

const { execFileSync } = require('node:child_process');

function hasBinary(name) {
  try {
    execFileSync('which', [name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Linux (X11) WindowContextProvider using xprop on the active window. On
 * Wayland xprop only sees XWayland clients, so context is best-effort; the
 * portal-based capture path does not depend on it. Extracted verbatim from
 * text-intel.js. Never throws.
 */
function createLinuxWindowContextProvider() {
  return {
    async collect() {
      try {
        if (!hasBinary('xprop')) return { appName: '', windowTitle: '' };
        const active = execFileSync('xprop', ['-root', '_NET_ACTIVE_WINDOW'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 1200,
        });
        const activeMatch = active.match(/window id # (0x[0-9a-fA-F]+)/);
        if (!activeMatch) return { appName: '', windowTitle: '' };
        const winId = activeMatch[1];
        const details = execFileSync('xprop', ['-id', winId, '_NET_WM_NAME', 'WM_NAME', 'WM_CLASS'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 1200,
        });
        const titleMatch = details.match(/(?:_NET_WM_NAME\(UTF8_STRING\)|WM_NAME\(STRING\)|WM_NAME\(UTF8_STRING\)) = "([^"]*)"/);
        const classMatch = details.match(/WM_CLASS\(STRING\) = "([^"]*)"(?:, "([^"]*)")?/);
        return {
          appName: classMatch ? (classMatch[2] || classMatch[1] || '') : '',
          windowTitle: titleMatch ? titleMatch[1] : '',
        };
      } catch {
        return { appName: '', windowTitle: '' };
      }
    },
  };
}

module.exports = { createLinuxWindowContextProvider, hasBinary };
