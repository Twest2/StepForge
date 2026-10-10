'use strict';

const os = require('node:os');
const path = require('node:path');
const { LibraryLocation } = require('../core/library-location');

/** The default library folder: STEPFORGE_DATA_DIR, else the per-user data folder. */
function resolveDataDir() {
  if (process.env.STEPFORGE_DATA_DIR) return process.env.STEPFORGE_DATA_DIR;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'stepforge');
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'stepforge');
}

/** The library-location bookkeeping the app keeps in Electron's userData folder. */
function libraryLocationFor(userDataDir) {
  return new LibraryLocation({
    // Keep this bootstrap setting outside the movable library so a selected
    // destination can be resolved before the store is opened.
    file: path.join(userDataDir, 'library-location.json'),
    defaultPath: resolveDataDir(),
    override: process.env.STEPFORGE_DATA_DIR || null,
  });
}

module.exports = { resolveDataDir, libraryLocationFor };
