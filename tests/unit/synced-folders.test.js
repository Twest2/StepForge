'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  dropboxFolders,
  nextcloudFolders,
  onedriveLinuxFolder,
  syncedFolders,
  isInside,
  syncServiceFor,
} = require('../../app/synced-folders');

/**
 * Settings → Guide storage warns when the library is in a folder OneDrive,
 * Dropbox, Google Drive or Nextcloud syncs (app/synced-folders.js and
 * storageWarning in app/renderer/dialogs.js).
 */

/** An fs with just readFileSync, holding the given files. */
function fakeFs(files) {
  return {
    readFileSync(file) {
      if (Object.prototype.hasOwnProperty.call(files, file)) return files[file];
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    },
  };
}

const HOME_WIN = 'C:\\Users\\Casey';
const WIN_ENV = { APPDATA: `${HOME_WIN}\\AppData\\Roaming`, LOCALAPPDATA: `${HOME_WIN}\\AppData\\Local` };
const NEXTCLOUD_CFG = [
  '[Accounts]',
  '0\\Folders\\1\\localPath=C:/Users/Casey/Nextcloud/',
  '0\\FoldersWithPlaceholders\\2\\localPath=D:/Work Cloud/',
  '0\\Folders\\1\\targetPath=/',
].join('\n');

test('each sync app’s own settings name its folders', () => {
  assert.deepEqual(dropboxFolders(JSON.stringify({ personal: { path: 'C:\\Users\\Casey\\Dropbox' }, business: { path: 'C:\\Users\\Casey\\Dropbox (Acme)' } })),
    ['C:\\Users\\Casey\\Dropbox', 'C:\\Users\\Casey\\Dropbox (Acme)']);
  assert.deepEqual(dropboxFolders('not json'), []);
  assert.deepEqual(dropboxFolders('null'), []);
  assert.deepEqual(nextcloudFolders(NEXTCLOUD_CFG), ['C:/Users/Casey/Nextcloud/', 'D:/Work Cloud/']);
  assert.equal(onedriveLinuxFolder('# sync_dir = "~/elsewhere"\nsync_dir = "~/Cloud/OneDrive"\n', '/home/casey'), '/home/casey/Cloud/OneDrive');
  assert.equal(onedriveLinuxFolder('', '/home/casey'), '/home/casey/OneDrive', 'the client’s default');
});

test('Windows: OneDrive from its environment variables, Dropbox and Nextcloud from their settings files', () => {
  const folders = syncedFolders({
    platform: 'win32',
    homeDir: HOME_WIN,
    env: { ...WIN_ENV, OneDrive: `${HOME_WIN}\\OneDrive`, OneDriveCommercial: `${HOME_WIN}\\OneDrive - Acme` },
    fs: fakeFs({
      [`${HOME_WIN}\\AppData\\Local\\Dropbox\\info.json`]: JSON.stringify({ personal: { path: `${HOME_WIN}\\Dropbox` } }),
      [`${HOME_WIN}\\AppData\\Roaming\\Nextcloud\\nextcloud.cfg`]: NEXTCLOUD_CFG,
    }),
  });
  assert.deepEqual(folders, [
    { service: 'OneDrive', folder: `${HOME_WIN}\\OneDrive` },
    { service: 'OneDrive', folder: `${HOME_WIN}\\OneDrive - Acme` },
    { service: 'Dropbox', folder: `${HOME_WIN}\\Dropbox` },
    { service: 'Nextcloud', folder: 'C:/Users/Casey/Nextcloud/' },
    { service: 'Nextcloud', folder: 'D:/Work Cloud/' },
  ]);
  assert.deepEqual(syncedFolders({ platform: 'win32', homeDir: HOME_WIN, env: WIN_ENV, fs: fakeFs({}) }), [], 'no sync apps');
});

test('Linux: Dropbox, Nextcloud and the OneDrive client from their settings files', () => {
  const folders = syncedFolders({
    platform: 'linux',
    homeDir: '/home/casey',
    env: {},
    fs: fakeFs({
      '/home/casey/.dropbox/info.json': JSON.stringify({ personal: { path: '/home/casey/Dropbox' } }),
      '/home/casey/.config/Nextcloud/nextcloud.cfg': '0\\Folders\\1\\localPath=/home/casey/Nextcloud/',
      '/home/casey/.config/onedrive/config': '',
    }),
  });
  assert.deepEqual(folders.map((f) => f.service), ['Dropbox', 'Nextcloud', 'OneDrive']);
  assert.deepEqual(syncedFolders({ platform: 'linux', homeDir: '/home/casey', env: {}, fs: fakeFs({}) }), []);
});

test('a library is in a synced folder when it is that folder or anywhere under it', () => {
  const folders = [
    { service: 'OneDrive', folder: `${HOME_WIN}\\OneDrive` },
    { service: 'Nextcloud', folder: 'C:/Users/Casey/Nextcloud/' },
  ];
  const service = (folder) => syncServiceFor(folder, { platform: 'win32', folders });
  // OneDrive's Documents backup: Documents is inside the OneDrive folder.
  assert.equal(service(`${HOME_WIN}\\OneDrive\\Documents\\StepForge`), 'OneDrive');
  assert.equal(service('c:\\users\\casey\\onedrive\\StepForge'), 'OneDrive', 'Windows paths ignore case');
  assert.equal(service(`${HOME_WIN}\\Nextcloud\\Guides`), 'Nextcloud', 'either slash');
  assert.equal(service(`${HOME_WIN}\\OneDrive`), 'OneDrive');
  // Not inside: a sibling whose name only starts the same, the home folder, AppData.
  assert.equal(service(`${HOME_WIN}\\OneDrive Backup\\StepForge`), null);
  assert.equal(service(`${HOME_WIN}\\StepForge`), null);
  assert.equal(service(`${HOME_WIN}\\AppData\\Roaming\\stepforge`), null);
  assert.equal(service(null), null);
  assert.equal(service(''), null);

  assert.equal(syncServiceFor('G:\\My Drive\\StepForge', { platform: 'win32', folders: [] }), 'Google Drive');
  assert.equal(syncServiceFor('/home/casey/Documents/StepForge', { platform: 'linux', folders: [{ service: 'Dropbox', folder: '/home/casey/Dropbox' }] }), null);
  assert.equal(syncServiceFor('/home/casey/Dropbox/StepForge', { platform: 'linux', folders: [{ service: 'Dropbox', folder: '/home/casey/Dropbox' }] }), 'Dropbox');
  assert.equal(isInside('/home/casey/DropboxOld', '/home/casey/Dropbox', 'linux'), false);
});

function storageWarning(info) {
  const context = { window: {}, setTimeout, el: () => ({}) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/dialogs.js'), 'utf8'), context);
  return context.window.StepForgeDialogs.storageWarning(info);
}

test('Settings → Guide storage warns about the library, or about the folder it is moving to', () => {
  assert.equal(storageWarning({ current: 'C:\\x', syncedBy: { current: null, pending: null } }), null);
  assert.equal(storageWarning({ current: 'C:\\x' }), null, 'an older main process without syncedBy');

  const current = storageWarning({ current: 'C:\\OneDrive\\StepForge', syncedBy: { current: 'OneDrive', pending: null } });
  assert.equal(current.title, 'Your guides are in a folder that OneDrive syncs');
  assert.match(current.text, /^OneDrive uploads every guide and screenshot in it, even with StepForge’s sync turned off/);
  assert.match(current.text, /Choose a folder OneDrive doesn’t sync\. .*Settings → Accounts\.$/);

  const moving = storageWarning({ current: 'C:\\x', pending: 'C:\\Dropbox\\Guides', syncedBy: { current: null, pending: 'Dropbox' } });
  assert.equal(moving.title, 'The folder you chose is in a folder that Dropbox syncs');

  // Moving out of a synced folder: nothing left to warn about.
  assert.equal(storageWarning({ current: 'C:\\OneDrive\\StepForge', pending: 'C:\\Users\\Casey\\StepForge', syncedBy: { current: 'OneDrive', pending: null } }), null);
});

test('the storage handlers report syncedBy, and Guide storage shows the warning', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../app/main.js'), 'utf8');
  for (const channel of ['storage:status', 'storage:reset', 'storage:cancelMove']) {
    assert.match(main, new RegExp(`h\\('${channel}', \\(\\) => storageStatus\\(`), channel);
  }
  assert.match(main, /return storageStatus\(libraryLocation\.schedule\(result\.filePaths\[0\]\)\);/);
  const dialogs = fs.readFileSync(path.join(__dirname, '../../app/renderer/dialogs.js'), 'utf8');
  assert.match(dialogs, /el\('div\.settings-storage', \{\}, storagePath, storageNote\),\n\s+storageWarningNote,/);
});
