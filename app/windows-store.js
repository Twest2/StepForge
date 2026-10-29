'use strict';

/**
 * StepForge installed from the Microsoft Store (an MSIX package built by
 * scripts/package-windows-store.js).
 *
 * A Store install differs from the .exe installer in three ways:
 * - Windows redirects new files under %APPDATA% into a private folder that it
 *   deletes with the app, so the guide library defaults to %USERPROFILE%\StepForge
 *   instead (app/data-dir.js). Not Documents: OneDrive, Dropbox and Google
 *   Drive often back that up, which would upload every guide and fight
 *   StepForge's own sync.
 * - The Store installs updates. Chocolatey's Update now is never offered;
 *   Settings → About opens StepForge in the Store instead.
 * - The exe sits in a WindowsApps folder named after its version, so AI agents
 *   start StepForge through the stepforge.exe execution alias, which stays the
 *   same across updates (packaging/windows/store/extensions.xml).
 *
 * Loadable under plain Node: the MCP server runs there (app/boot.js), and
 * process.windowsStore is only set in Electron's main process.
 */

const { win32 } = require('node:path');

const EXECUTION_ALIAS = 'stepforge.exe';
const LIBRARY_FOLDER = 'StepForge';
const UPDATES_PAGE = 'ms-windows-store://downloadsandupdates';

/** Running from a Store package: Electron says so, or the exe is under WindowsApps, as Electron itself decides. */
function isStoreInstall({ platform = process.platform, windowsStore = process.windowsStore, execPath = process.execPath } = {}) {
  if (platform !== 'win32') return false;
  return windowsStore === true || /\\WindowsApps\\/i.test(String(execPath || ''));
}

/**
 * The default library of a Store install: StepForge in the user's home folder.
 * Windows keeps it when the app is uninstalled, and OneDrive's folder backup
 * (Desktop, Documents, Pictures) doesn't include it.
 */
function storeLibraryDir(homeDir) {
  return win32.join(homeDir, LIBRARY_FOLDER);
}

/** The execution alias agents run: %LOCALAPPDATA%\Microsoft\WindowsApps\stepforge.exe, which Windows keeps on PATH. */
function executionAliasPath(env = process.env) {
  const local = typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA.trim() : '';
  return /^[A-Za-z]:\\/.test(local) ? win32.join(local, 'Microsoft', 'WindowsApps', EXECUTION_ALIAS) : EXECUTION_ALIAS;
}

/**
 * Where Settings → About sends a Store user for an update: StepForge's Store
 * page when the build knows its Store ID, else the Store's updates page.
 */
function storeUpdateUrl(productId) {
  return typeof productId === 'string' && /^[0-9A-Z]{12}$/.test(productId)
    ? `ms-windows-store://pdp/?ProductId=${productId}`
    : UPDATES_PAGE;
}

module.exports = {
  EXECUTION_ALIAS,
  LIBRARY_FOLDER,
  UPDATES_PAGE,
  isStoreInstall,
  storeLibraryDir,
  executionAliasPath,
  storeUpdateUrl,
};
