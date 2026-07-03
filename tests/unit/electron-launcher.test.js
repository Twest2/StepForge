'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildMissingElectronError,
  linuxSandboxLaunchArgs,
  noSandboxExplicitlyAllowed,
  resolveElectronBinary,
} = require('../../scripts/electron-launcher');
const { checkNodeVersion, assertSupportedNode } = require('../../scripts/check-node-version');
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

test('never runs npm when the runtime is missing: fails with npm ci diagnostics', (t) => {
  const root = makeTmpDir('electron-missing');
  t.after(() => rmrf(root));

  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });

  // Point npm_execpath at a script that would create the binary if executed.
  // The launcher must NOT execute it: runtime self-repair is forbidden.
  const trapNpmCli = path.join(root, 'trap-npm-cli.js');
  fs.writeFileSync(
    trapNpmCli,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(__dirname, 'npm-was-invoked'), '1');",
    ].join('\n')
  );

  const originalNpmExecPath = process.env.npm_execpath;
  process.env.npm_execpath = trapNpmCli;
  t.after(() => {
    if (originalNpmExecPath === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = originalNpmExecPath;
  });

  assert.throws(
    () => resolveElectronBinary({ packageRoot: root, projectRoot: root, platform: 'win32' }),
    /npm ci/
  );
  assert.equal(fs.existsSync(path.join(root, 'npm-was-invoked')), false);
});

test('missing electron package fails with npm ci diagnostics, not an install', (t) => {
  const root = makeTmpDir('electron-no-package');
  t.after(() => rmrf(root));

  assert.throws(
    () => resolveElectronBinary({ packageRoot: null, projectRoot: root, platform: 'win32' }),
    /never installs dependencies at runtime[\s\S]*npm ci/
  );
});

test('missing runtime error message explains recovery without runtime installs', (t) => {
  const root = makeTmpDir('electron-missing-msg');
  t.after(() => rmrf(root));

  const message = buildMissingElectronError({
    packageRoot: root,
    distDir: path.join(root, 'dist'),
    candidatePaths: [path.join(root, 'dist', 'electron.exe')],
  });
  assert.match(message, /Electron could not be started/);
  assert.match(message, /npm ci/);
  assert.doesNotMatch(message, /npm install/);
});

test('refuses an unsandboxed Linux launch unless explicitly allowed', () => {
  assert.throws(
    () =>
      linuxSandboxLaunchArgs({
        electronPath: '/tmp/stepforge/node_modules/electron/dist/electron',
        platform: 'linux',
        statSync: () => ({ uid: 1000, mode: 0o100755 }),
        env: {},
        userNamespaces: () => false,
      }),
    /refuses to silently launch unsandboxed[\s\S]*STEPFORGE_ALLOW_NO_SANDBOX/
  );
});

test('allows --no-sandbox only with an explicit dev/CI opt-in', () => {
  for (const env of [
    { STEPFORGE_ALLOW_NO_SANDBOX: '1' },
    { ELECTRON_DISABLE_SANDBOX: '1' },
  ]) {
    const args = linuxSandboxLaunchArgs({
      electronPath: '/tmp/stepforge/node_modules/electron/dist/electron',
      platform: 'linux',
      statSync: () => ({ uid: 1000, mode: 0o100755 }),
      env,
      userNamespaces: () => false,
    });
    assert.deepEqual(args, ['--no-sandbox']);
  }
  assert.equal(noSandboxExplicitlyAllowed({ STEPFORGE_ALLOW_NO_SANDBOX: '1' }), true);
  assert.equal(noSandboxExplicitlyAllowed({}), false);
});

test('keeps the sandbox enabled when the Linux helper is root-owned and setuid', () => {
  const args = linuxSandboxLaunchArgs({
    electronPath: '/tmp/stepforge/node_modules/electron/dist/electron',
    platform: 'linux',
    statSync: () => ({ uid: 0, mode: 0o104755 }),
    env: {},
  });
  assert.deepEqual(args, []);
});

test('non-Linux platforms never receive sandbox launch flags', () => {
  assert.deepEqual(linuxSandboxLaunchArgs({ platform: 'win32', env: {} }), []);
  assert.deepEqual(linuxSandboxLaunchArgs({ platform: 'darwin', env: {} }), []);
});

test('node toolchain check compares against package.json engines', () => {
  const ok = checkNodeVersion({ currentVersion: '99.0.0' });
  assert.equal(ok.ok, true);

  const tooOld = checkNodeVersion({ currentVersion: '18.19.1' });
  assert.equal(tooOld.ok, false);
  assert.match(tooOld.required, /^\d+\.\d+\.\d+$/);

  assert.throws(
    () => assertSupportedNode({ currentVersion: '18.19.1' }),
    /requires Node .* or newer/
  );
});
