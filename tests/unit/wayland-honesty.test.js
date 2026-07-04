'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { chooseCaptureTrigger, detectLinuxCapabilities } = require('../../app/platform/linux/diagnostics');
const platform = require('../../app/platform');

const ROOT = path.resolve(__dirname, '..', '..');
// Strip CR so assertions are robust to CRLF checkouts on Windows CI.
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// ---- honest trigger decisions ----------------------------------------------

test('X11 + xinput promises per-click capture with a marker', () => {
  const t = chooseCaptureTrigger({ os: 'linux', isWayland: false, clickCapture: 'x11-xinput' });
  assert.equal(t.trigger, 'click');
  assert.equal(t.coordinates, true);
  assert.equal(t.marker, true);
});

test('Wayland evdev captures per click but never promises coordinates or a marker', () => {
  const t = chooseCaptureTrigger({ os: 'linux', isWayland: true, clickCapture: 'evdev-wayland' });
  assert.equal(t.trigger, 'click');
  assert.equal(t.coordinates, false, 'Wayland exposes no pointer position');
  assert.equal(t.marker, false);
});

test('Wayland without a click source falls back to the user trigger, honestly', () => {
  const interval = chooseCaptureTrigger({ os: 'linux', isWayland: true, clickCapture: 'hotkey-or-interval-only' }, 'interval');
  assert.equal(interval.trigger, 'interval');
  assert.equal(interval.coordinates, false);
  assert.match(interval.note, /Wayland does not expose global clicks/i);

  const hotkey = chooseCaptureTrigger({ os: 'linux', isWayland: true, clickCapture: 'hotkey-or-interval-only' }, 'hotkey');
  assert.equal(hotkey.trigger, 'hotkey');
});

test('the platform facade wires the Linux trigger decision from real capabilities', () => {
  const caps = detectLinuxCapabilities({
    env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' },
    hasBinary: () => false,
    existsSync: () => false,
    readdirSync: () => [],
  });
  const t = platform.chooseCaptureTrigger(caps, 'interval');
  assert.equal(t.trigger, 'interval');
  assert.equal(t.marker, false);
});

test('Windows always reports per-click capture', () => {
  const t = platform.chooseCaptureTrigger({ os: 'windows' });
  assert.equal(t.trigger, 'click');
  assert.equal(t.coordinates, true);
});

// ---- least-privilege input access -------------------------------------------

test('the udev rule grants mouse-only access and excludes keyboards', () => {
  assert.ok(exists('packaging/linux/common/60-stepforge-input.rules'));
  const rule = read('packaging/linux/common/60-stepforge-input.rules');
  assert.match(rule, /ID_INPUT_MOUSE\}=="1"/);
  assert.match(rule, /ID_INPUT_KEYBOARD\}!="1"/, 'must exclude keyboards');
  assert.match(rule, /TAG\+="uaccess"/, 'session-scoped ACL, not a permanent group');
});

test('the enable script is opt-in and installs the least-privilege rule, not the input group', () => {
  assert.ok(exists('scripts/linux/enable-click-capture.sh'));
  const script = read('scripts/linux/enable-click-capture.sh');
  assert.match(script, /read -r reply/, 'must confirm before installing');
  assert.match(script, /60-stepforge-input\.rules/, 'installs the least-privilege udev rule');
  // usermod may only appear in a comment (warning), never as an executed
  // command. Check command position (line start, optional sudo) so this is
  // robust to CRLF vs LF line endings across platforms.
  assert.doesNotMatch(script, /^\s*(sudo\s+)?usermod\b/m, 'must not run the broad input-group command');
});

// ---- docs no longer push the broad input group ------------------------------

test('Linux docs recommend the least-privilege path and warn against the input group', () => {
  const doc = read('docs/GETTING_STARTED_WITH_LINUX.md');
  assert.match(doc, /enable-click-capture\.sh/);
  assert.match(doc, /least-privilege/i);
  // The broad group is now presented as a warning ("Do not use ..."), not a
  // recommended step.
  assert.match(doc, /Do \*\*not\*\* use `sudo usermod/);
});
