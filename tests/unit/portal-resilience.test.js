'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { PortalBackend } = require('../../app/platform/linux/portal-backend');
const { logFailure } = require('../../app/platform/linux/portal-errors');
const { makeTmpDir, rmrf } = require('./helpers');

test('Python portal requests distinguish responses and clean up failed requests', t => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, [path.join(__dirname, '../fixtures/portal_request_test.py')], { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') { t.skip('Python 3 is not installed'); return; }
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

function fixture(t, options = {}) {
  const root = makeTmpDir('portal'); t.after(() => rmrf(root));
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  const sent = [];
  child.stdin.write = line => sent.push(JSON.parse(line));
  child.stdin.end = line => { sent.push(JSON.parse(line)); child.emit('exit', 0); };
  child.kill = () => {};
  const backend = new PortalBackend({ spawnProcess: () => child, diagnosticDir: root, ...options });
  t.after(() => backend.stop({ immediate: true }));
  return { backend, child, sent, root };
}

for (const [code, text] of [['cancelled', /cancelled.*select the monitors/], ['timeout', /hidden sharing dialog/],
  ['unavailable', /xdg-desktop-portal.*GNOME/], ['stream-failed', /PipeWire.*WirePlumber/],
  ['session-closed', /sharing ended/]]) {
  test(`portal ${code} rejects startup, stops the helper and records only diagnostic metadata`, async t => {
    const { backend, child, sent, root } = fixture(t);
    const started = backend.start();
    const rejected = assert.rejects(started, text);
    child.stdout.emit('data', JSON.stringify({ type: 'error', code, stage: 'Start', reason: 'private title /home/user/secret.png' }) + '\n');
    await rejected;
    assert.equal(backend.isActive(), false);
    assert.equal(backend.child, null);
    assert.equal(sent.at(-1).type, 'stop');
    const rows = fs.readFileSync(path.join(root, 'linux-capture.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['code', 'desktop', 'stage', 'time']);
    assert.equal(rows[0].code, code);
    assert.equal(rows[0].stage, 'Start');
  });
}

test('portal loss rejects pending frames and arm immediately, ignores late readiness and allows a retry', async t => {
  const { backend } = fixture(t);
  const start = backend.start(); backend.receive({ type: 'ready', displays: [], epochOffset: 0 }); await start;
  const frame = backend.request('frame'), armed = backend.arm();
  const frameRejected = assert.rejects(frame, /screen stream stopped/i);
  const armRejected = assert.rejects(armed, /screen stream stopped/i);
  backend.receive({ type: 'error', code: 'stream-failed', reason: 'PipeWire disconnected' });
  await Promise.all([frameRejected, armRejected]);
  assert.equal(backend.pending.size, 0);
  backend.receive({ type: 'ready', displays: [], epochOffset: 0 });
  assert.equal(backend.isActive(), false);
  const retry = backend.start(); backend.receive({ type: 'ready', displays: [], epochOffset: 0 });
  await retry; assert.equal(backend.isActive(), true);
});

test('startup timeout and spawn failures settle with actionable messages', async t => {
  const { backend } = fixture(t, { startTimeoutMs: 5 });
  await assert.rejects(backend.start(), /hidden sharing dialog/);
  assert.equal(backend.child, null);
  const missing = new PortalBackend({ spawnProcess: () => { throw new Error('ENOENT'); } });
  await assert.rejects(missing.start(), /Python 3.*GStreamer/);
  assert.equal(missing.stopping, true);
});

test('helper exit classifies bounded stderr without writing stderr to disk', async t => {
  const { backend, child, root } = fixture(t, { desktop: 'plasma' });
  const rejected = assert.rejects(backend.start(), /Plasma portal backend/);
  child.stderr.emit('data', 'private window name org.freedesktop.DBus.Error.ServiceUnknown');
  child.emit('exit', 1); await rejected;
  assert.ok(!fs.readFileSync(path.join(root, 'linux-capture.jsonl'), 'utf8').includes('private'));
});

test('diagnostic logs rotate within a fixed bound and logging failure never masks capture failure', async t => {
  const { root } = fixture(t);
  const file = path.join(root, 'linux-capture.jsonl');
  fs.writeFileSync(file, 'x'.repeat(256 * 1024));
  assert.equal(logFailure(root, { desktop: 'plasma', code: 'timeout', stage: 'untrusted-path' }), file);
  assert.equal(fs.statSync(file + '.1').size, 256 * 1024);
  assert.ok(fs.statSync(file).size < 1024);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('untrusted-path'));
  const { backend } = fixture(t, { diagnosticDir: file }); // file cannot be a directory
  const rejected = assert.rejects(backend.start(), /cancelled/);
  backend.receive({ type: 'error', code: 'cancelled' }); await rejected;
});
