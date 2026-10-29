'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const {
  isStoreInstall,
  executionAliasPath,
  storeUpdateUrl,
  UPDATES_PAGE,
} = require('../../app/windows-store');
const { resolveDataDir, legacyWindowsDataDir, libraryLocationFor } = require('../../app/data-dir');
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

test('every Windows install keeps its library in the home folder, outside AppData and Documents', (t) => {
  // Not under AppData, which Windows deletes with a Store app, and not under
  // Documents, which OneDrive, Dropbox and Google Drive often back up.
  assert.equal(legacyWindowsDataDir({ APPDATA: 'C:\\Users\\Casey\\AppData\\Roaming' }), path.join('C:\\Users\\Casey\\AppData\\Roaming', 'stepforge'));
  if (process.platform !== 'win32') return; // resolveDataDir follows the real platform
  const saved = process.env.STEPFORGE_DATA_DIR;
  delete process.env.STEPFORGE_DATA_DIR;
  t.after(() => { if (saved !== undefined) process.env.STEPFORGE_DATA_DIR = saved; });
  assert.equal(resolveDataDir({ homeDir: 'C:\\Users\\Casey' }), 'C:\\Users\\Casey\\StepForge');
});

test('the default library outside Windows is unchanged', (t) => {
  if (process.platform === 'win32') return;
  const userData = makeTmpDir('store-default-library');
  t.after(() => rmrf(userData));
  const saved = process.env.STEPFORGE_DATA_DIR;
  delete process.env.STEPFORGE_DATA_DIR;
  t.after(() => { if (saved !== undefined) process.env.STEPFORGE_DATA_DIR = saved; });
  assert.equal(resolveDataDir({ homeDir: '/home/casey' }), path.join(process.env.XDG_DATA_HOME || '/home/casey/.local/share', 'stepforge'));
  assert.equal(libraryLocationFor(userData, { homeDir: '/home/casey' }).legacyPath, null, 'nothing to move on Linux');
});

test('STEPFORGE_DATA_DIR still wins, and a chosen library stays where it was chosen', (t) => {
  const tmp = makeTmpDir('store-library');
  t.after(() => rmrf(tmp));
  const saved = process.env.STEPFORGE_DATA_DIR;
  t.after(() => { if (saved === undefined) delete process.env.STEPFORGE_DATA_DIR; else process.env.STEPFORGE_DATA_DIR = saved; });

  process.env.STEPFORGE_DATA_DIR = tmp;
  assert.equal(resolveDataDir({ homeDir: 'C:\\Users\\Casey' }), tmp);

  delete process.env.STEPFORGE_DATA_DIR;
  const location = libraryLocationFor(tmp, { homeDir: tmp });
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

test('the Store IPC reports success only after Windows opens the Store and propagates launch failures', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../../app/main.js'), 'utf8');
  const start = main.indexOf("  h('app:openStore',");
  const end = main.indexOf('\n  // Settings → About "Update now"', start);
  assert.ok(start >= 0 && end > start);
  let handler, finish;
  let launch = () => new Promise((resolve) => { finish = resolve; });
  vm.runInNewContext(main.slice(start, end), {
    h: (_name, fn) => { handler = fn; },
    windowsStore: { isStoreInstall: () => true, storeUpdateUrl },
    shell: { openExternal: (url) => { assert.equal(url, storeUpdateUrl('9NBLGGH4R32N')); return launch(); } },
    PACKAGE_JSON: { microsoftStore: { productId: '9NBLGGH4R32N' } },
  });
  let settled = false;
  const pending = handler().then((result) => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(settled, false, 'the renderer must not see success before openExternal settles');
  finish();
  assert.equal((await pending).ok, true);
  launch = async () => { throw new Error('Store protocol is unavailable'); };
  await assert.rejects(handler(), /Store protocol is unavailable/);
});
