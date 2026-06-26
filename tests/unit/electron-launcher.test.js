'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildMissingElectronError,
  linuxSandboxLaunchArgs,
  repairElectronInstall,
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

test('repairs a broken Electron install before resolving the binary', (t) => {
  const root = makeTmpDir('electron-repair');
  t.after(() => rmrf(root));

  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'install.js'),
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) process.exit(2);",
      "fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });",
      "fs.writeFileSync(path.join(__dirname, 'dist', 'electron.exe'), 'binary');",
      "fs.writeFileSync(path.join(__dirname, 'path.txt'), 'electron.exe');",
    ].join('\n')
  );

  const originalSkip = process.env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  process.env.ELECTRON_SKIP_BINARY_DOWNLOAD = '1';
  t.after(() => {
    if (originalSkip === undefined) delete process.env.ELECTRON_SKIP_BINARY_DOWNLOAD;
    else process.env.ELECTRON_SKIP_BINARY_DOWNLOAD = originalSkip;
  });

  assert.equal(
    repairElectronInstall({ packageRoot: root }),
    true
  );
  assert.equal(
    resolveElectronBinary({ packageRoot: root, platform: 'win32' }),
    path.join(root, 'dist', 'electron.exe')
  );
});

test('rebuilds Electron through npm when the binary is missing', (t) => {
  const root = makeTmpDir('electron-rebuild');
  t.after(() => rmrf(root));

  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const fakeNpmCli = path.join(root, 'fake-npm-cli.js');
  fs.writeFileSync(
    fakeNpmCli,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) process.exit(2);",
      "fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });",
      "fs.writeFileSync(path.join(__dirname, 'dist', 'electron.exe'), 'binary');",
      "fs.writeFileSync(path.join(__dirname, 'path.txt'), 'electron.exe');",
    ].join('\n')
  );

  const originalNpmExecPath = process.env.npm_execpath;
  const originalNpmNodeExecPath = process.env.npm_node_execpath;
  const originalSkip = process.env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  process.env.npm_execpath = fakeNpmCli;
  process.env.npm_node_execpath = process.execPath;
  process.env.ELECTRON_SKIP_BINARY_DOWNLOAD = '1';
  t.after(() => {
    if (originalNpmExecPath === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = originalNpmExecPath;
    if (originalNpmNodeExecPath === undefined) delete process.env.npm_node_execpath;
    else process.env.npm_node_execpath = originalNpmNodeExecPath;
    if (originalSkip === undefined) delete process.env.ELECTRON_SKIP_BINARY_DOWNLOAD;
    else process.env.ELECTRON_SKIP_BINARY_DOWNLOAD = originalSkip;
  });

  assert.equal(
    resolveElectronBinary({ packageRoot: root, platform: 'win32' }),
    path.join(root, 'dist', 'electron.exe')
  );
});

test('falls back to npm install when rebuild does not repair the runtime', (t) => {
  const root = makeTmpDir('electron-install-fallback');
  t.after(() => rmrf(root));

  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const fakeNpmCli = path.join(root, 'fake-npm-cli.js');
  fs.writeFileSync(
    fakeNpmCli,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const command = process.argv[2];",
      "if (command === 'rebuild') process.exit(1);",
      "if (command === 'install') {",
      "  fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });",
      "  fs.writeFileSync(path.join(__dirname, 'dist', 'electron.exe'), 'binary');",
      "  fs.writeFileSync(path.join(__dirname, 'path.txt'), 'electron.exe');",
      "  process.exit(0);",
      "}",
      "process.exit(1);",
    ].join('\n')
  );

  const originalNpmExecPath = process.env.npm_execpath;
  const originalNpmNodeExecPath = process.env.npm_node_execpath;
  process.env.npm_execpath = fakeNpmCli;
  process.env.npm_node_execpath = process.execPath;
  t.after(() => {
    if (originalNpmExecPath === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = originalNpmExecPath;
    if (originalNpmNodeExecPath === undefined) delete process.env.npm_node_execpath;
    else process.env.npm_node_execpath = originalNpmNodeExecPath;
  });

  assert.equal(
    resolveElectronBinary({ packageRoot: root, projectRoot: root, platform: 'win32' }),
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

test('uses --no-sandbox when the Linux sandbox helper is not root-owned and setuid', () => {
  const args = linuxSandboxLaunchArgs({
    electronPath: '/tmp/stepforge/node_modules/electron/dist/electron',
    platform: 'linux',
    statSync: () => ({ uid: 1000, mode: 0o100755 }),
  });
  assert.deepEqual(args, ['--no-sandbox']);
});

test('keeps the sandbox enabled when the Linux helper is root-owned and setuid', () => {
  const args = linuxSandboxLaunchArgs({
    electronPath: '/tmp/stepforge/node_modules/electron/dist/electron',
    platform: 'linux',
    statSync: () => ({ uid: 0, mode: 0o104755 }),
  });
  assert.deepEqual(args, []);
});
