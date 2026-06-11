'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const CaptureService = require('../../app/capture');

function makeService() {
  const store = {
    addStep() {
      throw new Error('not used in this test');
    },
  };
  const settings = {
    get(key) {
      if (key === 'capture.mode') return 'fullscreen';
      if (key === 'capture.delayMs') return 0;
      return null;
    },
  };
  return new CaptureService({
    store,
    settings,
    getWindow: () => null,
    notify: () => {},
  });
}

test('click-triggered session capture uses the low-latency hide pause', async () => {
  const service = makeService();
  service.session = { guideId: 'guide-1', paused: false, count: 0, intervalSec: 0 };

  let seenOptions = null;
  service.shoot = async (options) => {
    seenOptions = options;
    return { ok: true, step: { stepId: 'step-1' } };
  };

  const result = await service.sessionCapture('click');

  assert.equal(result.ok, true);
  assert.equal(service.session.count, 1);
  assert.deepEqual(seenOptions, {
    guideId: 'guide-1',
    mode: 'fullscreen',
    delayMs: 0,
    hideWindowDelayMs: 25,
    refocus: false,
    clickPos: null,
  });
});

test('click-triggered session capture prefers the cached frame when ready', async () => {
  const service = makeService();
  service.settings.get = (key) => {
    if (key === 'capture.mode') return 'fullscreen';
    if (key === 'capture.delayMs') return 0;
    if (key === 'capture.clickMarker') return true;
    if (key === 'capture.clickMarkerColor') return '#E5484D';
    if (key === 'editor.focusedViewDefaultForNewSteps') return false;
    return null;
  };
  service.session = { guideId: 'guide-2', paused: false, count: 0, intervalSec: 0 };
  service.captureCache = {
    mode: 'fullscreen',
    png: Buffer.from('cached-png'),
    size: { width: 120, height: 80 },
    display: { bounds: { x: 10, y: 20, width: 120, height: 80 } },
    cursor: { x: 70, y: 40 },
    capturedAt: Date.now(),
  };

  let shootCalled = false;
  service.shoot = async () => {
    shootCalled = true;
    throw new Error('fresh shot should not run when cache is ready');
  };

  const added = [];
  service.store.addStep = (guideId, fields, png, size) => {
    added.push({ guideId, fields, png, size });
    return { stepId: 'step-2', ...fields };
  };
  service.notify = (channel, payload) => {
    added.push({ channel, payload });
  };

  const result = await service.sessionCapture('click');

  assert.equal(result.ok, true);
  assert.equal(shootCalled, false);
  assert.equal(service.session.count, 1);
  assert.equal(added[0].guideId, 'guide-2');
  assert.deepEqual(added[0].png, Buffer.from('cached-png'));
  assert.deepEqual(added[0].size, { width: 120, height: 80 });
  assert.equal(added[0].fields.annotations.length, 1);
  assert.equal(added[0].fields.annotations[0].type, 'oval');
});

test('click-triggered capture marks the click-time cursor position, not the cached frame\'s (possibly stale) cursor', async () => {
  const service = makeService();
  service.settings.get = (key) => {
    if (key === 'capture.mode') return 'fullscreen';
    if (key === 'capture.delayMs') return 0;
    if (key === 'capture.clickMarker') return true;
    if (key === 'capture.clickMarkerColor') return '#E5484D';
    if (key === 'editor.focusedViewDefaultForNewSteps') return false;
    return null;
  };
  service.session = { guideId: 'guide-3', paused: false, count: 0, intervalSec: 0 };
  service.captureCache = {
    mode: 'fullscreen',
    png: Buffer.from('cached-png'),
    size: { width: 120, height: 80 },
    display: { bounds: { x: 0, y: 0, width: 120, height: 80 } },
    // Stale cursor position from the cache-refresh loop, well outside the
    // display — if this were used for the marker, no annotation would be
    // placed at all.
    cursor: { x: 9999, y: 9999 },
    capturedAt: Date.now(),
  };

  service.shoot = async () => {
    throw new Error('fresh shot should not run when cache is ready');
  };

  let added = null;
  service.store.addStep = (guideId, fields, png, size) => {
    added = { guideId, fields, png, size };
    return { stepId: 'step-3', ...fields };
  };
  service.notify = () => {};

  // The user clicked dead center of the display.
  const result = await service.sessionCapture('click', { x: 60, y: 40 });

  assert.equal(result.ok, true);
  assert.equal(added.fields.annotations.length, 1);
  const marker = added.fields.annotations[0];
  assert.equal(marker.type, 'oval');
  const d = 0.035;
  assert.ok(Math.abs(marker.x - (0.5 - d / 2)) < 1e-9);
  assert.ok(Math.abs(marker.y - (0.5 - (d * 120 / 80) / 2)) < 1e-9);
});

test('live-shot click capture also marks the click-time cursor position', async () => {
  const service = makeService();
  service.settings.get = (key) => {
    if (key === 'capture.mode') return 'fullscreen';
    if (key === 'capture.delayMs') return 0;
    if (key === 'capture.clickMarker') return true;
    if (key === 'capture.clickMarkerColor') return '#E5484D';
    if (key === 'editor.focusedViewDefaultForNewSteps') return false;
    return null;
  };
  service.session = { guideId: 'guide-4', paused: false, count: 0, intervalSec: 0 };
  // No capture cache, so sessionCapture falls back to a fresh shoot().
  service.captureCurrentFrame = async () => ({
    mode: 'fullscreen',
    png: Buffer.from('live-png'),
    size: { width: 100, height: 100 },
    display: { bounds: { x: 0, y: 0, width: 100, height: 100 } },
    // Grab-time cursor, well outside the display — must not be used.
    cursor: { x: -1, y: -1 },
    capturedAt: Date.now(),
  });

  let added = null;
  service.store.addStep = (guideId, fields, png, size) => {
    added = { guideId, fields, png, size };
    return { stepId: 'step-4', ...fields };
  };
  service.notify = () => {};

  const result = await service.sessionCapture('click', { x: 50, y: 50 });

  assert.equal(result.ok, true);
  assert.equal(added.fields.annotations.length, 1);
  assert.equal(added.fields.annotations[0].type, 'oval');
});

test('a new session starts paused and does not hide the window or arm the click cache until "Start recording" is pressed', async () => {
  const service = makeService();
  const win = {
    destroyed: false, visible: true, minimized: false, hidden: 0, shown: 0,
    isDestroyed() { return this.destroyed; },
    isVisible() { return this.visible; },
    isMinimized() { return this.minimized; },
    hide() { this.visible = false; this.hidden += 1; },
    show() { this.visible = true; this.shown += 1; },
    showInactive() { this.visible = true; this.shown += 1; },
    focus() {},
    getTitle() { return 'StepForge'; },
    getBounds() { return { x: 0, y: 0, width: 800, height: 600 }; },
  };
  service.getWindow = () => win;
  service.clickCaptureAvailable = () => true;
  let cacheStarted = 0;
  service.startClickCaptureCache = () => { cacheStarted += 1; };

  try {
    service.startSession('guide-5');

    assert.equal(service.session.paused, true, 'sessions start paused');
    assert.equal(service.state().paused, true);
    assert.equal(win.hidden, 0, 'window must stay visible until recording starts');
    assert.equal(cacheStarted, 0, 'click-capture cache must not start before recording starts');

    // User clicks "Start recording" (the resume action).
    service.togglePause(false);
    assert.equal(service.session.paused, false);
    assert.equal(win.hidden, 0, 'hide is deferred briefly so the user sees it happen');

    await new Promise((r) => setTimeout(r, 450));
    assert.equal(win.hidden, 1, 'window hides once recording actually starts');
    assert.equal(cacheStarted, 1, 'click-capture cache is armed once recording starts');
  } finally {
    service.finishSession();
  }
});
