'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeTmpDir, rmrf } = require('./helpers');
const options = { skip: process.platform !== 'linux' };

function fixture(t) {
  const root = makeTmpDir('fedora-deps');
  t.after(() => rmrf(root));
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'dnf-args');
  fs.mkdirSync(bin);
  // Intercept package-manager calls and simulate container uid without changing
  // the host's packages or requiring elevated privileges.
  for (const [name, body] of Object.entries({
    id: 'echo 0',
    dnf: 'printf "%s\\n" "$@" > "$DEPS_TEST_LOG"',
  })) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return {
    run: (...args) => spawnSync('bash', [path.join(__dirname, '../../scripts/linux/dnf/install-build-deps.sh'), ...args], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEPS_TEST_LOG: log }, encoding: 'utf8',
    }),
    packages: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [],
  };
}

test('Fedora contributor setup supplies Debian tools and Electron test libraries', options, (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const args = f.packages();
  assert.deepEqual(args.slice(0, 2), ['install', '-y']);
  for (const dep of ['dpkg', 'rpm-build', 'nss', 'nspr', 'gtk3', 'alsa-lib', 'mesa-libgbm', 'libXrandr']) {
    assert.ok(args.includes(dep), `missing ${dep}`);
  }
});

test('RPM-only dependency setup omits Debian tools and retains Electron libraries', options, (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const full = f.packages();
  const result = f.run('--rpm-only');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.packages(), full.filter((arg) => arg !== 'dpkg'));
});

test('dependency setup rejects unknown arguments before invoking dnf', options, (t) => {
  const f = fixture(t);
  for (const args of [['--rpm'], ['--rpm-only', 'extra']]) {
    const result = f.run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
  assert.deepEqual(f.packages(), []);
});
