'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const security = require('../../app/security');

const MAIN_URL = security.APP_PAGES.main;
const WORKER_URL = security.APP_PAGES.captureWorker;
const REGION_URL = security.APP_PAGES.region;

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---- navigation policy -----------------------------------------------------

test('navigation: a window may only stay on its own app page', () => {
  assert.equal(security.navigationAllowed(MAIN_URL, 'main'), true);
  assert.equal(security.navigationAllowed(`${MAIN_URL}?q=1#frag`, 'main'), true);
  assert.equal(security.navigationAllowed(REGION_URL, 'region'), true);

  // Hostile / cross-page navigations are all denied.
  for (const target of [
    'https://evil.example/phish.html',
    'http://127.0.0.1:8080/',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'about:blank',
    REGION_URL, // a *different* app page is still a denial for 'main'
    'file:///etc/passwd',
    'not a url',
    '',
  ]) {
    assert.equal(security.navigationAllowed(target, 'main'), false, `should deny ${target}`);
  }
  assert.equal(security.navigationAllowed(MAIN_URL, 'nonexistent-page'), false);
});

// ---- permission policy -----------------------------------------------------

test('permissions: display capture only for the capture worker, nothing else for anyone', () => {
  assert.equal(security.permissionAllowed('display-capture', WORKER_URL), true);
  assert.equal(security.permissionAllowed('media', WORKER_URL), true);

  // The main window gets nothing, including display capture.
  assert.equal(security.permissionAllowed('display-capture', MAIN_URL), false);
  assert.equal(security.permissionAllowed('media', MAIN_URL), false);

  // Everything else is denied even for the worker.
  for (const permission of ['geolocation', 'notifications', 'clipboard-read', 'openExternal', 'fullscreen', 'pointerLock', 'hid', 'usb', 'serial']) {
    assert.equal(security.permissionAllowed(permission, WORKER_URL), false, permission);
  }

  // Remote origins never get anything.
  assert.equal(security.permissionAllowed('display-capture', 'https://evil.example/'), false);
  assert.equal(security.permissionAllowed('media', undefined), false);
});

// ---- external URL policy ---------------------------------------------------

test('external links: only well-formed http(s)/mailto pass', () => {
  assert.equal(security.validateExternalUrl('https://example.com/docs'), 'https://example.com/docs');
  assert.equal(security.validateExternalUrl('http://example.com'), 'http://example.com/');
  assert.match(security.validateExternalUrl('mailto:hi@example.com'), /^mailto:/);

  for (const url of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,x',
    'ftp://example.com/x',
    'smb://server/share',
    'chrome://settings',
    'vbscript:x',
    'https://',
    'not a url',
    123,
    null,
    `https://example.com/${'a'.repeat(3000)}`,
  ]) {
    assert.equal(security.validateExternalUrl(url), null, `should reject ${String(url).slice(0, 60)}`);
  }
});

// ---- IPC sender guard --------------------------------------------------------

function makeGuard(mainWc) {
  return security.makeIpcSenderGuard({ getMainWebContents: () => mainWc });
}

test('ipc guard: accepts only the main window top frame on index.html', () => {
  const wc = { id: 1 };
  const guard = makeGuard(wc);

  assert.equal(guard({ sender: wc, senderFrame: { parent: null, url: MAIN_URL } }), true);
});

test('ipc guard: rejects other windows, subframes, navigated and disposed frames', () => {
  const wc = { id: 1 };
  const otherWc = { id: 2 };
  const guard = makeGuard(wc);

  // Different webContents (popup, worker, region overlay).
  assert.equal(guard({ sender: otherWc, senderFrame: { parent: null, url: MAIN_URL } }), false);
  // Subframe of our own window.
  assert.equal(guard({ sender: wc, senderFrame: { parent: {}, url: MAIN_URL } }), false);
  // Frame that navigated somewhere else but kept the preload bridge.
  assert.equal(guard({ sender: wc, senderFrame: { parent: null, url: 'https://evil.example/' } }), false);
  assert.equal(guard({ sender: wc, senderFrame: { parent: null, url: WORKER_URL } }), false);
  // Disposed frame accessor throws.
  const disposed = {};
  Object.defineProperty(disposed, 'parent', { get() { throw new Error('disposed'); } });
  assert.equal(guard({ sender: wc, senderFrame: disposed }), false);
  // Missing frame or window entirely.
  assert.equal(guard({ sender: wc, senderFrame: null }), false);
  assert.equal(makeGuard(null)({ sender: wc, senderFrame: { parent: null, url: MAIN_URL } }), false);
  assert.equal(guard(null), false);
});

// ---- argument hygiene --------------------------------------------------------

test('args must be plain object bags', () => {
  assert.equal(security.isPlainArgs({ a: 1 }), true);
  assert.equal(security.isPlainArgs(Object.create(null)), true);
  assert.equal(security.isPlainArgs(undefined), true);
  assert.equal(security.isPlainArgs(null), true);
  assert.equal(security.isPlainArgs([1, 2]), false);
  assert.equal(security.isPlainArgs('x'), false);
  class Weird {}
  assert.equal(security.isPlainArgs(new Weird()), false);
});

test('payload budget rejects oversized and non-data values', () => {
  assert.equal(security.payloadWithinBudget({ a: 'small' }, 1000), true);
  assert.equal(security.payloadWithinBudget({ a: 'x'.repeat(2000) }, 1000), false);
  assert.equal(security.payloadWithinBudget({ fn: () => 1 }, 1000), false);
  // Deep nesting is cut off.
  let deep = 'leaf';
  for (let i = 0; i < 40; i += 1) deep = { deep };
  assert.equal(security.payloadWithinBudget(deep, 100000), false);
  // Numbers/booleans/null are fine.
  assert.equal(security.payloadWithinBudget({ n: 5, b: true, z: null }, 1000), true);
});

test('field validators refuse traversal, separators, and pollution', () => {
  const c = security.check;
  assert.equal(c.id('guide-123_A.b'), true);
  assert.equal(c.id('../../etc/passwd'), false);
  assert.equal(c.id('a/b'), false);
  assert.equal(c.id('a\\b'), false);
  assert.equal(c.id(''), false);
  assert.equal(c.id(42), false);

  assert.equal(c.fileName('My snapshot 2026-07-03'), true);
  assert.equal(c.fileName('..'), false);
  assert.equal(c.fileName('a/../b'), false);
  assert.equal(c.fileName('a/b'), false);
  assert.equal(c.fileName('a\\b'), false);
  assert.equal(c.fileName('a\0b'), false);
  assert.equal(c.fileName('   '), false);

  assert.equal(c.settingsKeyPath('capture.hotkeyCapture'), true);
  assert.equal(c.settingsKeyPath('__proto__.polluted'), false);
  assert.equal(c.settingsKeyPath('a.constructor.b'), false);
  assert.equal(c.settingsKeyPath('a..b'), false);
  assert.equal(c.settingsKeyPath(''), false);

  assert.equal(c.base64('aGVsbG8=', 100), true);
  assert.equal(c.base64('<script>', 100), false);
});

test('produced-files registry only re-opens what main created', () => {
  const produced = new security.ProducedFiles(3);
  produced.add('/tmp/exports/guide.pdf');
  assert.equal(produced.has('/tmp/exports/guide.pdf'), true);
  assert.equal(produced.has('/tmp/exports/../exports/guide.pdf'), true, 'path normalization');
  assert.equal(produced.has('/etc/passwd'), false);
  assert.equal(produced.has(null), false);

  produced.add('/tmp/a');
  produced.add('/tmp/b');
  produced.add('/tmp/c'); // evicts guide.pdf (LRU bound)
  assert.equal(produced.has('/tmp/exports/guide.pdf'), false);
  assert.equal(produced.has('/tmp/c'), true);
});

// ---- source-level regression guards -----------------------------------------

test('main process never grants blanket permissions again', () => {
  const src = read('app/main.js');
  assert.doesNotMatch(src, /setPermissionCheckHandler\(\(\)\s*=>\s*true\)/);
  assert.doesNotMatch(src, /cb\(true\)\)/);
  assert.match(src, /security\.permissionAllowed/);
  assert.match(src, /installWindowSecurity\(mainWindow, 'main'\)/);
});

test('no generic shell path channels remain on the bridge', () => {
  const preload = read('app/preload.js');
  assert.doesNotMatch(preload, /shell:openPath/);
  assert.doesNotMatch(preload, /shell:showItemInFolder/);
  assert.match(preload, /shell:openProduced/);
  assert.match(preload, /shell:openExternal/);
});

test('every renderer window is created sandboxed', () => {
  for (const file of ['app/main.js', 'app/capture.js', 'app/stream-backend.js']) {
    const src = read(file);
    const created = src.match(/new BrowserWindow\(/g) || [];
    const sandboxed = src.match(/sandbox: true/g) || [];
    assert.ok(created.length > 0, `${file} should create a window`);
    assert.equal(
      sandboxed.length,
      created.length,
      `${file}: every BrowserWindow must set sandbox: true (${sandboxed.length}/${created.length})`
    );
  }
});
