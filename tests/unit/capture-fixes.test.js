'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const CaptureService = require('../../app/capture');

function makeService({ settings: settingsOverrides, powerPolicy } = {}) {
  const settingsData = {
    'capture.mode': 'fullscreen',
    'capture.delayMs': 0,
    ...settingsOverrides,
  };
  return new CaptureService({
    store: {},
    settings: { get: (k) => (k in settingsData ? settingsData[k] : null) },
    getWindow: () => null,
    notify: () => {},
    powerPolicy,
    screenApi: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getAllDisplays: () => [],
    },
  });
}

// ---- region rect clamping (bug: out-of-bounds / negative drags) -------------

test('overlayRectToImageRect scales, clamps, and normalizes selections', () => {
  const svc = makeService();
  const display = { bounds: { x: 0, y: 0, width: 100, height: 100 } };
  const imgSize = { width: 200, height: 200 }; // 2x DPI

  // Simple selection: display px -> image px (2x).
  assert.deepEqual(
    svc.overlayRectToImageRect({ x: 10, y: 20, w: 30, h: 40 }, display, imgSize),
    { x: 20, y: 40, width: 60, height: 80 }
  );

  // Negative-size drag (drawn up/left) normalizes to a positive rect.
  assert.deepEqual(
    svc.overlayRectToImageRect({ x: 40, y: 40, w: -20, h: -20 }, display, imgSize),
    { x: 40, y: 40, width: 40, height: 40 }
  );

  // Selection larger than the screen is clamped to the image bounds.
  const clamped = svc.overlayRectToImageRect({ x: -10, y: -10, w: 200, h: 200 }, display, imgSize);
  assert.deepEqual(clamped, { x: 0, y: 0, width: 200, height: 200 });

  // Degenerate selections return null instead of an out-of-bounds crop.
  assert.equal(svc.overlayRectToImageRect({ x: 0, y: 0, w: 0, h: 0 }, display, imgSize), null);
  assert.equal(svc.overlayRectToImageRect({ x: 999, y: 999, w: 10, h: 10 }, display, imgSize), null);
  assert.equal(svc.overlayRectToImageRect(null, display, imgSize), null);
});

// ---- power ownership follows recording state --------------------------------

test('the power blocker is held only while actively recording', () => {
  const calls = [];
  const powerPolicy = { setRecording: (on) => calls.push(on) };
  const svc = makeService({ powerPolicy });

  // startSession begins PAUSED — must not hold power.
  svc.startSession('g1', { intervalSec: 0 });
  assert.deepEqual(calls, [], 'a paused new session must not start the power blocker');

  // Resume records -> power on. (togglePause(false) arms recording.)
  svc.togglePause(false);
  assert.deepEqual(calls, [true]);

  // Pause -> power off. This is the tray/second-instance path that used to leak.
  svc.togglePause(true);
  assert.deepEqual(calls, [true, false]);

  // Resume again -> on, finish -> off.
  svc.togglePause(false);
  svc.finishSession();
  assert.deepEqual(calls, [true, false, true, false]);
});

test('finishSession releases power even if it was recording', () => {
  const calls = [];
  const svc = makeService({ powerPolicy: { setRecording: (on) => calls.push(on) } });
  svc.startSession('g1', { intervalSec: 0 });
  svc.togglePause(false);
  calls.length = 0;
  svc.finishSession();
  assert.deepEqual(calls, [false]);
});

// ---- explicit click-source reporting ----------------------------------------

test('click source is unavailable outside a session and after stop', () => {
  const svc = makeService();
  assert.equal(svc.state().clickSource, 'unavailable');
  assert.equal(svc.state().clickCapture, undefined); // no session -> no field
  svc.clickSource = 'evdev-x11';
  svc.stopClickWatcher();
  assert.equal(svc.clickSource, 'unavailable');
});

test('state reports clickCapture true for a non-process (evdev) source', () => {
  const svc = makeService();
  svc.session = { guideId: 'g', paused: false, count: 0, intervalSec: 0 };
  // evdev has no child process; the old Boolean(clickWatcher) reported false.
  svc.clickSource = 'evdev-wayland';
  const st = svc.state();
  assert.equal(st.clickCapture, true);
  assert.equal(st.clickSource, 'evdev-wayland');
});

// ---- drain never hangs quit -------------------------------------------------

test('drainPendingClicks resolves within the deadline even if the queue hangs', async () => {
  const svc = makeService();
  svc.clickQueue = new Promise(() => {}); // never settles
  const start = Date.now();
  await svc.drainPendingClicks(60);
  assert.ok(Date.now() - start < 1000, 'drain must not block on a hung queue');
});
