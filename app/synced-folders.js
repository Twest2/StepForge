'use strict';

/**
 * Folders that a file-sync app uploads: OneDrive, Dropbox, Google Drive and
 * Nextcloud. Settings → General → Guide storage warns when the library is in
 * one, because the app then uploads every guide and screenshot whether or not
 * StepForge's own sync is on, and the library's per-computer sync state
 * (<library>/cloud) gets copied between computers.
 *
 * Everything here is local: environment variables and the sync apps' own
 * settings files. Nothing is sent anywhere. Loadable under plain Node so the
 * detection is unit-testable on any platform.
 */

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function readText(fs, file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Dropbox's info.json: { personal: { path }, business: { path } }. */
function dropboxFolders(text) {
  try {
    const info = JSON.parse(text);
    return Object.values(info && typeof info === 'object' ? info : {})
      .map((account) => account && account.path)
      .filter((folder) => typeof folder === 'string' && folder);
  } catch {
    return [];
  }
}

/** Nextcloud's nextcloud.cfg lists each synced folder as "0\Folders\1\localPath=C:/Users/x/Nextcloud/". */
function nextcloudFolders(text) {
  return [...String(text).matchAll(/^\d+\\(?:Folders|FoldersWithPlaceholders|Multifolders)\\\d+\\localPath=(.+)$/gm)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

/** The Linux OneDrive client's config: sync_dir = "~/OneDrive". */
function onedriveLinuxFolder(text, homeDir) {
  const match = /^\s*sync_dir\s*=\s*"([^"]+)"/m.exec(String(text));
  const folder = match ? match[1] : '~/OneDrive';
  return folder.startsWith('~') ? path.posix.join(homeDir, folder.slice(1)) : folder;
}

/** Every folder a sync app on this computer uploads, as [{ service, folder }]. */
function syncedFolders({ platform = process.platform, env = process.env, fs = nodeFs, homeDir = os.homedir() } = {}) {
  const found = [];
  const add = (service, folders) => {
    for (const folder of folders) if (typeof folder === 'string' && folder.trim()) found.push({ service, folder: folder.trim() });
  };
  if (platform === 'win32') {
    const p = path.win32;
    // OneDrive sets these for each signed-in account. Documents, Desktop and
    // Pictures are inside them when OneDrive backs those folders up.
    add('OneDrive', ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'].map((name) => env[name]));
    const appData = env.APPDATA || p.join(homeDir, 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA || p.join(homeDir, 'AppData', 'Local');
    for (const file of [p.join(appData, 'Dropbox', 'info.json'), p.join(localAppData, 'Dropbox', 'info.json')]) {
      const text = readText(fs, file);
      if (text) add('Dropbox', dropboxFolders(text));
    }
    const nextcloud = readText(fs, p.join(appData, 'Nextcloud', 'nextcloud.cfg'));
    if (nextcloud) add('Nextcloud', nextcloudFolders(nextcloud));
  } else {
    const p = path.posix;
    const configHome = env.XDG_CONFIG_HOME || p.join(homeDir, '.config');
    const dropbox = readText(fs, p.join(homeDir, '.dropbox', 'info.json'));
    if (dropbox) add('Dropbox', dropboxFolders(dropbox));
    const nextcloud = readText(fs, p.join(configHome, 'Nextcloud', 'nextcloud.cfg'));
    if (nextcloud) add('Nextcloud', nextcloudFolders(nextcloud));
    const onedrive = readText(fs, p.join(configHome, 'onedrive', 'config'));
    if (onedrive !== null) add('OneDrive', [onedriveLinuxFolder(onedrive, homeDir)]);
  }
  return found;
}

/** Whether `folder` is `root` or inside it. Windows paths compare without case and with either slash. */
function isInside(folder, root, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (value) => {
    const resolved = p.resolve(platform === 'win32' ? String(value).replace(/\//g, '\\') : String(value));
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const relative = p.relative(norm(root), norm(folder));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative));
}

/**
 * The sync app that uploads `folder`, or null. Google Drive for desktop has no
 * settings file to read, so a "My Drive" folder, which every Google Drive
 * folder sits under, stands for it.
 */
function syncServiceFor(folder, { platform = process.platform, folders = null, ...options } = {}) {
  if (typeof folder !== 'string' || !folder) return null;
  const known = folders || syncedFolders({ platform, ...options });
  const match = known.find((entry) => isInside(folder, entry.folder, platform));
  if (match) return match.service;
  const parts = folder.split(/[\\/]+/);
  return parts.some((part) => /^my drive$/i.test(part)) ? 'Google Drive' : null;
}

module.exports = {
  dropboxFolders,
  nextcloudFolders,
  onedriveLinuxFolder,
  syncedFolders,
  isInside,
  syncServiceFor,
};
