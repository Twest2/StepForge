'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isStoreInstall,
  storeLibraryDir,
  executionAliasPath,
  storeUpdateUrl,
  UPDATES_PAGE,
} = require('../../app/windows-store');
const { resolveDataDir, libraryLocationFor } = require('../../app/data-dir');
const { makeTmpDir, rmrf } = require('./helpers');

/**
 * StepForge installed from the Microsoft Store (app/windows-store.js): how it
 * is recognized, where its library goes by default, the command agents run,
 * and where Settings → About sends the user for an update.
 */

const STORE_EXE = 'C:\\Program Files\\WindowsApps\\12345Casey.StepForge_1.5.300.0_x64__abcdefghjkmnp\\app\\StepForge.exe';
const INSTALLER_EXE = 'C:\\Users\\Casey\\AppData\\Local\\Programs\\StepForge\\StepForge.exe';

test('a Store install is recognized from Electron, or from the WindowsApps path under plain Node', () => {
  assert.equal(isStoreInstall({ platform: 'win32', windowsStore: true, execPath: INSTALLER_EXE }), true);
  // The MCP server runs under plain Node, where process.windowsStore is unset.
  assert.equal(isStoreInstall({ platform: 'win32', windowsStore: undefined, execPath: STORE_EXE }), true);
  assert.equal(isStoreInstall({ platform: 'win32', windowsStore: undefined, execPath: INSTALLER_EXE }), false);
  assert.equal(isStoreInstall({ platform: 'linux', windowsStore: true, execPath: STORE_EXE }), false);
});

test('a Store install keeps its library in Documents, which Windows keeps on uninstall', (t) => {
  if (process.platform !== 'win32') {
    // resolveDataDir follows the real platform; check the folder it would use.
    assert.equal(storeLibraryDir('D:\\OneDrive\\Documents'), 'D:\\OneDrive\\Documents\\StepForge');
    return;
  }
  const saved = process.env.STEPFORGE_DATA_DIR;
  delete process.env.STEPFORGE_DATA_DIR;
  t.after(() => { if (saved !== undefined) process.env.STEPFORGE_DATA_DIR = saved; });
  assert.equal(resolveDataDir({ store: true, documentsDir: 'D:\\OneDrive\\Documents' }), 'D:\\OneDrive\\Documents\\StepForge');
  assert.match(resolveDataDir({ store: false, documentsDir: 'D:\\OneDrive\\Documents' }), /\\stepforge$/);
  assert.doesNotMatch(resolveDataDir({ store: false, documentsDir: 'D:\\OneDrive\\Documents' }), /Documents/);
});

test('the default library outside Windows is unchanged by the Store setting', (t) => {
  if (process.platform === 'win32') return;
  const saved = process.env.STEPFORGE_DATA_DIR;
  delete process.env.STEPFORGE_DATA_DIR;
  t.after(() => { if (saved !== undefined) process.env.STEPFORGE_DATA_DIR = saved; });
  assert.equal(resolveDataDir({ store: true, documentsDir: '/home/casey/Documents' }), resolveDataDir({ store: false }));
});

test('STEPFORGE_DATA_DIR still wins over the Store default, and a moved library stays where it was moved', (t) => {
  const tmp = makeTmpDir('store-library');
  t.after(() => rmrf(tmp));
  const saved = process.env.STEPFORGE_DATA_DIR;
  t.after(() => { if (saved === undefined) delete process.env.STEPFORGE_DATA_DIR; else process.env.STEPFORGE_DATA_DIR = saved; });

  process.env.STEPFORGE_DATA_DIR = tmp;
  assert.equal(resolveDataDir({ store: true, documentsDir: 'D:\\Docs' }), tmp);

  delete process.env.STEPFORGE_DATA_DIR;
  const location = libraryLocationFor(tmp, { store: true, documentsDir: 'D:\\Docs' });
  location.state = { current: '/somewhere/chosen' };
  assert.equal(location.status().current, '/somewhere/chosen');
});

test('agents start a Store install through its execution alias, which survives updates', () => {
  assert.equal(executionAliasPath({ LOCALAPPDATA: 'C:\\Users\\Casey\\AppData\\Local' }),
    'C:\\Users\\Casey\\AppData\\Local\\Microsoft\\WindowsApps\\stepforge.exe');
  // Without a usable LOCALAPPDATA, the alias is still on PATH.
  assert.equal(executionAliasPath({}), 'stepforge.exe');
  assert.equal(executionAliasPath({ LOCALAPPDATA: '\\\\server\\share' }), 'stepforge.exe');
});

test('Settings → About opens StepForge in the Store, or the Store updates page without a Store ID', () => {
  assert.equal(storeUpdateUrl('9NBLGGH4R32N'), 'ms-windows-store://pdp/?ProductId=9NBLGGH4R32N');
  assert.equal(storeUpdateUrl(''), UPDATES_PAGE);
  assert.equal(storeUpdateUrl(undefined), UPDATES_PAGE);
  assert.equal(storeUpdateUrl('9NBLGGH4R32N&x=1'), UPDATES_PAGE, 'nothing else is ever put in the URL');
  assert.equal(UPDATES_PAGE, 'ms-windows-store://downloadsandupdates');
});
