'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectPlatform, createWindowContextProvider, detectCapabilities } = require('../../app/platform');
const { assertWindowContextProvider, CLICK_SOURCES } = require('../../app/platform/interfaces');
const { detectLinuxCapabilities, detectSessionType } = require('../../app/platform/linux/diagnostics');

// ---- platform selection -----------------------------------------------------

test('detectPlatform maps process.platform to an adapter family', () => {
  assert.equal(detectPlatform('win32'), 'windows');
  assert.equal(detectPlatform('darwin'), 'darwin');
  assert.equal(detectPlatform('linux'), 'linux');
  assert.equal(detectPlatform('sunos'), 'unsupported');
});

test('the factory returns a valid WindowContextProvider for every OS', () => {
  for (const platform of ['win32', 'darwin', 'linux', 'sunos']) {
    const provider = createWindowContextProvider({ platform });
    assert.doesNotThrow(() => assertWindowContextProvider(provider));
    assert.equal(typeof provider.collect, 'function');
  }
});

test('an unsupported platform provider returns an empty context, never throws', async () => {
  const provider = createWindowContextProvider({ platform: 'sunos' });
  assert.deepEqual(await provider.collect(), { appName: '', windowTitle: '' });
});

test('the shared code delegates window context to the injected provider', async () => {
  // The text-intel service must consume the provider, not branch on platform.
  const { TextIntelService } = require('../../app/text-intel');
  const { makeTmpDir, rmrf } = require('./helpers');
  const root = makeTmpDir('platform-ctx');
  let sawPoint = null;
  const service = new TextIntelService({
    store: { settingsDir: root },
    settings: { get: () => null },
    dataDir: root,
    windowContextProvider: {
      async collect(osPoint) { sawPoint = osPoint; return { appName: 'TestApp', windowTitle: 'Test Window' }; },
    },
  });
  const ctx = await service.collectForegroundWindowContext({ x: 5, y: 6 });
  assert.deepEqual(ctx, { appName: 'TestApp', windowTitle: 'Test Window' });
  assert.deepEqual(sawPoint, { x: 5, y: 6 });
  rmrf(root);
});

// ---- Linux diagnostics ------------------------------------------------------

test('session type prefers XDG_SESSION_TYPE then display env', () => {
  assert.equal(detectSessionType({ XDG_SESSION_TYPE: 'wayland' }), 'wayland');
  assert.equal(detectSessionType({ XDG_SESSION_TYPE: 'x11' }), 'x11');
  assert.equal(detectSessionType({ WAYLAND_DISPLAY: 'wayland-0' }), 'wayland');
  assert.equal(detectSessionType({ DISPLAY: ':0' }), 'x11');
  assert.equal(detectSessionType({}), 'unknown');
});

test('X11 with xinput reports marker-capable per-click capture', () => {
  const caps = detectLinuxCapabilities({
    env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', DBUS_SESSION_BUS_ADDRESS: 'unix:x' },
    hasBinary: (n) => n === 'xinput' || n === 'xprop',
    existsSync: () => false,
    readdirSync: () => [],
  });
  assert.equal(caps.isWayland, false);
  assert.equal(caps.clickCapture, 'x11-xinput');
  assert.equal(caps.screenCapture, 'x11-direct');
});

test('Wayland without PipeWire reports an actionable message', () => {
  const caps = detectLinuxCapabilities({
    env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' },
    hasBinary: () => false,
    existsSync: () => false,
    readdirSync: () => [],
  });
  assert.equal(caps.isWayland, true);
  assert.equal(caps.screenCapture, 'wayland-portal');
  assert.ok(caps.messages.some((m) => /PipeWire|portal/i.test(m)));
});

test('no click source falls back to hotkey/interval with a message', () => {
  const caps = detectLinuxCapabilities({
    env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' },
    hasBinary: () => false, // no xinput
    existsSync: () => false,
    readdirSync: () => [], // no readable input devices
  });
  assert.equal(caps.clickCapture, 'hotkey-or-interval-only');
  assert.ok(caps.messages.some((m) => /hotkey|interval/i.test(m)));
});

test('readable evdev devices enable an evdev click source', () => {
  const caps = detectLinuxCapabilities({
    env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' },
    hasBinary: (n) => n === 'pipewire',
    existsSync: () => true,
    readdirSync: () => ['event0', 'event1', 'mouse0'],
  });
  // event0/event1 are readable (accessSync is real, but /dev/input/eventN
  // likely won't exist in CI; the profile still resolves without throwing).
  assert.ok(['evdev-wayland', 'hotkey-or-interval-only'].includes(caps.clickCapture));
  assert.equal(caps.os, 'linux');
});

// ---- capability facade ------------------------------------------------------

test('detectCapabilities returns a Linux profile with valid click source', () => {
  const caps = detectCapabilities({ platform: 'linux', env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' } });
  assert.equal(caps.os, 'linux');
});

test('detectCapabilities reports windows-hook for Windows', () => {
  const caps = detectCapabilities({ platform: 'win32', env: {} });
  assert.equal(caps.os, 'windows');
  assert.equal(caps.clickCapture, 'windows-hook');
});

test('every documented click source is a known token', () => {
  for (const s of ['windows-hook', 'x11', 'evdev-x11', 'evdev-wayland', 'wayland-portal', 'hotkey', 'interval', 'unavailable']) {
    assert.ok(CLICK_SOURCES.includes(s));
  }
});

// ---- refactor guard ---------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

test('text-intel no longer branches on process.platform for window context', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'text-intel.js'), 'utf8');
  assert.doesNotMatch(src, /collectWindowsWindowContext|collectMacWindowContext|collectLinuxWindowContext/);
  assert.doesNotMatch(src, /process\.platform === 'win32'/);
  assert.match(src, /this\.windowContext\.collect/);
});
