'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildMissingElectronError,
  resolveElectronBinary,
} = require('../../scripts/electron-launcher');
const { makeTmpDir, rmrf } = require('./helpers');

test('resolves the Electron binary from path.txt when present', (t) => {
  const root = makeTmpDir('electron-path-hint');
  t.after(() => rmrf(root));

  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'path.txt'), 'electron.exe\n');
  fs.writeFileSync(path.join(root, 'dist', 'electron.exe'), 'binary');

  assert.equal(
    resolveElectronBinary({ packageRoot: root, platform: 'win32' }),
    path.join(root, 'dist', 'electron.exe')
  );
});

test('falls back to the platform binary when path.txt is absent', (t) => {
  const root = makeTmpDir('electron-platform-fallback');
  t.after(() => rmrf(root));

  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'electron.exe'), 'binary');

  assert.equal(
    resolveElectronBinary({ packageRoot: root, platform: 'win32' }),
    path.join(root, 'dist', 'electron.exe')
  );
});

test('reports a helpful error when the runtime is missing', (t) => {
  const root = makeTmpDir('electron-missing');
  t.after(() => rmrf(root));

  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });

  assert.throws(
    () => resolveElectronBinary({ packageRoot: root, platform: 'win32' }),
    /npm install/
  );

  const message = buildMissingElectronError({
    packageRoot: root,
    distDir: path.join(root, 'dist'),
    candidatePaths: [path.join(root, 'dist', 'electron.exe')],
  });
  assert.match(message, /Electron could not be started/);
  assert.match(message, /Expected the binary in:/);
});
