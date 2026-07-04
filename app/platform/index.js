'use strict';

/**
 * The single factory that selects a platform implementation. The rest of the
 * app depends on the interfaces in ./interfaces.js and asks this module for a
 * concrete adapter — it never branches on `process.platform` itself.
 *
 * As Linux runtime capture is implemented, its ClickSource / ScreenFrameSource
 * adapters are added here; today this provides the WindowContextProvider for
 * every platform and the Linux capability diagnostics.
 */

const { assertWindowContextProvider } = require('./interfaces');

function detectPlatform(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  return 'unsupported';
}

/**
 * Build the WindowContextProvider for the current OS. `platform` is injectable
 * so the selection logic is unit-testable off the target OS.
 */
function createWindowContextProvider({ platform = process.platform } = {}) {
  const os = detectPlatform(platform);
  let provider;
  switch (os) {
    case 'windows':
      provider = require('./windows/window-context').createWindowsWindowContextProvider();
      break;
    case 'darwin':
      provider = require('./darwin/window-context').createDarwinWindowContextProvider();
      break;
    case 'linux':
      provider = require('./linux/window-context').createLinuxWindowContextProvider();
      break;
    default:
      // Unsupported OS: a null-object provider so callers still work.
      provider = { async collect() { return { appName: '', windowTitle: '' }; } };
  }
  return assertWindowContextProvider(provider);
}

/**
 * Capability profile for the current OS (used by diagnostics UI). Only Linux
 * has a rich profile today; other platforms report their OS and a capable
 * baseline.
 */
function detectCapabilities({ platform = process.platform, env = process.env } = {}) {
  const os = detectPlatform(platform);
  if (os === 'linux') {
    return require('./linux/diagnostics').detectLinuxCapabilities({ env });
  }
  return {
    os,
    sessionType: os,
    isWayland: false,
    clickCapture: os === 'windows' ? 'windows-hook' : os,
    screenCapture: os,
    messages: [],
  };
}

module.exports = { detectPlatform, createWindowContextProvider, detectCapabilities };
