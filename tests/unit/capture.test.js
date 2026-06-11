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

function makeFrame(name, ageMs = 0, overrides = {}) {
  return {
    mode: overrides.mode || 'fullscreen',
    png: Buffer.from(name),
    size: overrides.size || { width: 100, height: 100 },
    display: overrides.display || { bounds: { x: 0, y: 0, width: 100, height: 100 } },
    cursor: overrides.cursor || { x: 50, y: 50 },
    capturedAt: Date.now() - ageMs,
  };
}

test('rapid click watcher bursts are parsed one click at a time', () => {
  const service = makeService();
  let clicks = 0;
  service.onOsClick = () => {
    clicks += 1;
  };

  service.processClickWatcherData([
    'EVENT type 17 (RawButtonPress)',
    'EVENT type 18 (RawButtonRelease)',
    'EVENT type 17 (RawButtonPress)',
    'EVENT type 18 (RawButtonRelease)',
  ].join('\n'), 'linux');

  assert.equal(clicks, 2);
});

test('windows click watcher output is counted line by line', () => {
  const service = makeService();
  let clicks = 0;
  service.onOsClick = () => {
    clicks += 1;
  };

  service.processClickWatcherData('CLICK\r\nCLICK\r\n', 'win32');

  assert.equal(clicks, 2);
});

test('a click is served instantly from the freshly buffered frame', async () => {
  const service = makeService();
  service.session = { guideId: 'guide-2', paused: false, count: 0, intervalSec: 0 };
  service.latestFrame = makeFrame('buffered-png');
  service.shoot = async () => {
    throw new Error('must not take a fresh shot when a buffered frame is ready');
  };
  const added = [];
  service.store.addStep = (guideId, fields, png) => {
    added.push(png.toString());
    return { stepId: 'step-1' };
  };

  const result = await service.sessionCapture('click', { x: 10, y: 10 });

  assert.equal(result.ok, true);
  assert.deepEqual(added, ['buffered-png']);
  assert.equal(service.session.count, 1);
});

test('a buffered frame from a different display is ignored for click capture', async () => {
  const service = makeService();
  service.session = { guideId: 'guide-display', paused: false, count: 0, intervalSec: 0 };
  service.frameLoopRunning = true;
  service.frameLoopInFlight = true;
  service.latestFrame = makeFrame('wrong-display', 0, {
    display: { bounds: { x: 0, y: 0, width: 100, height: 100 } },
  });

  service.nextFrame = async () => makeFrame('right-display', 0, {
    display: { bounds: { x: 100, y: 0, width: 100, height: 100 } },
    cursor: { x: 150, y: 10 },
  });
  service.shoot = async () => {
    throw new Error('click capture should not fall back when a matching frame arrives');
  };

  const added = [];
  service.store.addStep = (guideId, fields, png) => {
    added.push(png.toString());
    return { stepId: 'step-display' };
  };

  const result = await service.sessionCapture('click', { x: 150, y: 10 });

  assert.equal(result.ok, true);
  assert.deepEqual(added, ['right-display']);
  assert.equal(service.session.count, 1);
});

test('a stale buffered frame is not reused — the click falls back to a fresh shot', async () => {
  const service = makeService();
  service.session = { guideId: 'guide-stale', paused: false, count: 0, intervalSec: 0 };
  service.latestFrame = makeFrame('stale-png', 10_000);

  let shootCalled = false;
  service.shoot = async () => {
    shootCalled = true;
    return { ok: true, step: { stepId: 'fresh-step' } };
  };

  const result = await service.sessionCapture('click', { x: 1, y: 1 });

  assert.equal(result.ok, true);
  assert.equal(shootCalled, true, 'a stale buffered frame must not be reused');
});

test('an idle click capture does not wait for the next frame loop tick', async () => {
  const service = makeService();
  service.session = { guideId: 'guide-idle', paused: false, count: 0, intervalSec: 0 };
  service.frameLoopRunning = true;
  service.frameLoopInFlight = false;

  let nextFrameCalled = false;
  service.nextFrame = async () => {
    nextFrameCalled = true;
    throw new Error('idle clicks must not wait for a new frame');
  };

  let shootCalled = false;
  service.shoot = async () => {
    shootCalled = true;
    return { ok: true, step: { stepId: 'idle-step' } };
  };

  const result = await service.sessionCapture('click', { x: 1, y: 1 });

  assert.equal(result.ok, true);
  assert.equal(shootCalled, true);
  assert.equal(nextFrameCalled, false);
});

test('clicks during an in-flight grab wait for the frame instead of being dropped', async () => {
  const service = makeService();
  service.session = { guideId: 'guide-fast', paused: false, count: 0, intervalSec: 0 };
  service.frameLoopRunning = true; // a grab is in flight, no frame buffered yet
  service.frameLoopInFlight = true;
  service.shoot = async () => {
    throw new Error('waiting clicks must use the loop frame, not a competing shot');
  };
  const added = [];
  service.store.addStep = (guideId, fields, png) => {
    added.push(png.toString());
    return { stepId: `step-${added.length}` };
  };

  // Two rapid clicks land before the grab completes.
  const first = service.sessionCapture('click', { x: 1, y: 1 });
  const second = service.sessionCapture('click', { x: 2, y: 2 });
  service.acceptFrame(makeFrame('loop-frame'));
  const [r1, r2] = await Promise.all([first, second]);

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.deepEqual(added, ['loop-frame', 'loop-frame'],
    'both clicks must become steps from the frame that was in flight');
  assert.equal(service.session.count, 2);
});

test('pausing stops the frame loop and discards the buffered frame', () => {
  const service = makeService();
  service.session = { guideId: 'guide-pause', paused: false, count: 0, intervalSec: 0 };
  service.frameLoopRunning = true;
  service.latestFrame = makeFrame('pre-pause');

  service.togglePause(true);

  assert.equal(service.frameLoopRunning, false);
  assert.equal(service.latestFrame, null, 'a resume must never serve a pre-pause frame');
});

test('click capture marks the click-time cursor position', async () => {
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
  let seenCapturePoint = null;
  service.captureCurrentFrame = async (_mode, capturePoint) => {
    seenCapturePoint = capturePoint;
    return {
      mode: 'fullscreen',
      png: Buffer.from('live-png'),
      size: { width: 100, height: 100 },
      display: { bounds: { x: 0, y: 0, width: 100, height: 100 } },
      // Grab-time cursor, well outside the display — must not be used.
      cursor: { x: -1, y: -1 },
      capturedAt: Date.now(),
    };
  };

  let added = null;
  service.store.addStep = (guideId, fields, png, size) => {
    added = { guideId, fields, png, size };
    return { stepId: 'step-4', ...fields };
  };
  service.notify = () => {};

  const result = await service.sessionCapture('click', { x: 50, y: 50 });

  assert.equal(result.ok, true);
  assert.deepEqual(seenCapturePoint, { x: 50, y: 50 });
  assert.equal(added.fields.annotations.length, 1);
  assert.equal(added.fields.annotations[0].type, 'oval');
});

test('a new session starts paused and does not hide the window until "Start recording" is pressed', async () => {
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

  try {
    service.startSession('guide-5');

    assert.equal(service.session.paused, true, 'sessions start paused');
    assert.equal(service.state().paused, true);
    assert.equal(win.hidden, 0, 'window must stay visible until recording starts');

    // User clicks "Start recording" (the resume action).
    service.togglePause(false);
    assert.equal(service.session.paused, false);
    assert.equal(win.hidden, 0, 'hide is deferred briefly so the user sees it happen');

    await new Promise((r) => setTimeout(r, 450));
    assert.equal(win.hidden, 1, 'window hides once recording actually starts');
  } finally {
    service.finishSession();
  }
});
