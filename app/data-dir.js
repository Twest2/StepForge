'use strict';

const os = require('node:os');
const path = require('node:path');
const { LibraryLocation } = require('../core/library-location');

/**
 * The default library folder: STEPFORGE_DATA_DIR, else StepForge in the home
 * folder on Windows (%USERPROFILE%\StepForge), else the per-user data folder.
 *
 * Windows used to keep it in %APPDATA%\stepforge. That folder doesn't survive
 * uninstalling the Microsoft Store app (Windows deletes what a Store app
 * writes under %APPDATA%), it is also Electron's profile, and every install
 * type now shares one location. Not Documents: OneDrive, Dropbox and Google
 * Drive often back it up, which would upload every guide and fight StepForge's
 * own sync. A library in the old folder moves automatically (LibraryLocation).
 */
function resolveDataDir({ homeDir = os.homedir() } = {}) {
  if (process.env.STEPFORGE_DATA_DIR) return process.env.STEPFORGE_DATA_DIR;
  if (process.platform === 'win32') return path.join(homeDir, 'StepForge');
  const xdg = process.env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share');
  return path.join(xdg, 'stepforge');
}

/** The old Windows default, which LibraryLocation moves libraries out of. */
function legacyWindowsDataDir(env = process.env, homeDir = os.homedir()) {
  return path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'stepforge');
}

/** The library-location bookkeeping the app keeps in Electron's userData folder. */
function libraryLocationFor(userDataDir, { homeDir } = {}) {
  return new LibraryLocation({
    // Keep this bootstrap setting outside the movable library so a selected
    // destination can be resolved before the store is opened.
    file: path.join(userDataDir, 'library-location.json'),
    defaultPath: resolveDataDir({ homeDir }),
    legacyPath: process.platform === 'win32' ? legacyWindowsDataDir(process.env, homeDir) : null,
    override: process.env.STEPFORGE_DATA_DIR || null,
  });
}

module.exports = { resolveDataDir, legacyWindowsDataDir, libraryLocationFor };
