'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTmpDir, rmrf } = require('./helpers');
const { createWindowsInstallerConfig, findInstallerExe } = require('../../scripts/package-windows');

test('Windows packaging uses an assisted NSIS installer', (t) => {
  const config = createWindowsInstallerConfig('/tmp/stepforge-output');

  assert.deepEqual(config.win.target, ['nsis']);
  assert.equal(config.nsis.oneClick, false);
  assert.equal(config.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(config.nsis.createDesktopShortcut, true);
  assert.equal(config.nsis.createStartMenuShortcut, true);
  assert.equal(config.nsis.shortcutName, 'StepForge');
  assert.equal(config.asar, true);
  assert.ok(config.files.includes('app/**/*'));
  assert.ok(config.files.includes('core/**/*'));
  assert.ok(config.files.includes('exporters/**/*'));
  assert.ok(!config.files.includes('assets/**/*'));

  const tmp = makeTmpDir('windows-installer');
  t.after(() => rmrf(tmp));
  fs.mkdirSync(path.join(tmp, 'nested', 'deeper'), { recursive: true });
  const installer = path.join(tmp, 'nested', 'deeper', 'StepForge Setup 0.2.0.exe');
  fs.writeFileSync(installer, Buffer.from('fake installer'));
  assert.equal(findInstallerExe(tmp), installer);
});
