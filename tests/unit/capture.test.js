'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const CaptureService = require('../../app/capture');

function makeService({ settings: settingsOverrides, screenApi } = {}) {
  const store = {
    addStep() {
      throw new Error('not used in this test');
    },
  };
  const settingsData = {
    'capture.mode': 'fullscreen',
    'capture.delayMs': 0,
    ...settingsOverrides,
  };
  const settings = {
    get(key) {
      return key in settingsData ? settingsData[key] : null;
    },
  };
  return new CaptureService({
    store,
    settings,
    getWindow: () => null,
    notify: () => {},
    screenApi: screenApi || {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getAllDisplays: () => [],
    },
  });
}

// The raw/regular twin window plus margin: how long a test must wait for a
// held Linux raw press to fire when no coordinate twin arrives.
const TWIN_FLUSH_MS = 60;
const settle = (ms = TWIN_FLUSH_MS) => new Promise((r) => setTimeout(r, ms));

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

// ---- fresh-shot fallback path ----------------------------------------------

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

// ---- Linux watcher parsing ---------------------------------------------------

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

test('raw button presses fire; scroll-wheel ticks (buttons 4-7) are ignored', async () => {
  const service = makeService();
  let clicks = 0;
  service.onOsClick = () => {
    clicks += 1;
  };

  service.processClickWatcherData([
    'EVENT type 15 (RawButtonPress)',
    '    device: 11 (11)',
    '    detail: 1',
    '    valuators:',
    'EVENT type 15 (RawButtonPress)', // scroll-wheel tick
    '    device: 11 (11)',
    '    detail: 4',
    'EVENT type 15 (RawButtonPress)', // horizontal scroll
    '    device: 11 (11)',
    '    detail: 7',
    'EVENT type 15 (RawButtonPress)',
    '    device: 11 (11)',
    '    detail: 3',
  ].join('\n'), 'linux');

  await settle(); // raw presses hold briefly for a coordinate twin
  assert.equal(clicks, 2, 'buttons 4-7 are scroll ticks, not clicks');
});

test('regular ButtonPress blocks carry their root coordinates into onOsClick', () => {
  // The event-time root position is what keeps the marker on the real click
  // even when the pointer keeps moving after the press — a live cursor read
  // at parse time would drift.
  const service = makeService();
  const seen = [];
  service.onOsClick = (at, osPoint, button) => {
    seen.push({ osPoint, button });
  };

  service.processClickWatcherData([
    'EVENT type 4 (ButtonPress)',
    '    device: 11 (10)',
    '    detail: 1',
    '    flags:',
    '    root: 644.52/343.55',
    '    event: 644.52/343.55',
  ].join('\n'), 'linux');

  assert.deepEqual(seen, [{ osPoint: { x: 645, y: 344 }, button: 'button-1' }]);
});

test('a raw press and its regular twin merge into a single click with coordinates', async () => {
  // One physical press can be delivered as both a RawButtonPress and a
  // ButtonPress block. That duplication is resolved structurally — never by
  // a time debounce that could swallow real fast clicks.
  const service = makeService();
  const seen = [];
  service.onOsClick = (at, osPoint, button) => {
    seen.push({ osPoint, button });
  };

  service.processClickWatcherData([
    'EVENT type 15 (RawButtonPress)',
    '    device: 11 (11)',
    '    detail: 1',
    '    valuators:',
    'EVENT type 4 (ButtonPress)',
    '    device: 11 (10)',
    '    detail: 1',
    '    root: 100.00/200.00',
  ].join('\n'), 'linux');

  await settle();
  assert.deepEqual(seen, [{ osPoint: { x: 100, y: 200 }, button: 'button-1' }],
    'exactly one click, carrying the regular twin\'s coordinates');
});

test('two genuine fast presses of the same button both fire', async () => {
  const service = makeService();
  const seen = [];
  service.onOsClick = (at, osPoint, button) => {
    seen.push({ osPoint, button });
  };

  service.processClickWatcherData([
    'EVENT type 4 (ButtonPress)',
    '    detail: 1',
    '    root: 10.00/10.00',
    'EVENT type 4 (ButtonPress)',
    '    detail: 1',
    '    root: 12.00/11.00',
  ].join('\n'), 'linux');

  await settle();
  assert.equal(seen.length, 2, 'fast clicking must never be dropped by the parser');
});

test('motion events with detail lines do not fire clicks', () => {
  const service = makeService();
  let clicks = 0;
  service.onOsClick = () => {
    clicks += 1;
  };

  service.processClickWatcherData([
    'EVENT type 17 (RawMotion)',
    '    device: 11 (11)',
    '    detail: 0',
    '    valuators:',
  ].join('\n'), 'linux');

  assert.equal(clicks, 0);
});

test('event lines split across stdout chunks are reassembled before parsing', async () => {
  const service = makeService();
  let clicks = 0;
  service.onOsClick = () => {
    clicks += 1;
  };

  service.ingestClickWatcherChunk('EVENT type 15 (RawButt', 'linux');
  assert.equal(clicks, 0, 'a partial line must not be parsed yet');
  service.ingestClickWatcherChunk('onPress)\n    detail: 1\n', 'linux');

  await settle();
  assert.equal(clicks, 1);
});

// ---- click queue --------------------------------------------------------------

test('clicks queue behind an in-progress capture instead of being dropped', async () => {
  const service = makeService();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((r) => { releaseFirst = r; });
  service.sessionCapture = async (trigger, clickPos) => {
    order.push(`start-${clickPos.x}`);
    if (clickPos.x === 1) await firstGate;
    order.push(`done-${clickPos.x}`);
    return { ok: true };
  };

  service.enqueueClickCapture({ x: 1, y: 1 });
  const second = service.enqueueClickCapture({ x: 2, y: 2 });
  releaseFirst();
  await second;

  assert.deepEqual(order, ['start-1', 'done-1', 'start-2', 'done-2'],
    'the second click must run after the first, not be dropped');
});

test('fast clicks are paired with their frames at event time, not behind the store queue', async () => {
  // With a slow PNG encode or store, the click queue can run seconds late.
  // The frame request must go out at click time anyway, or the second
  // click's frame would be selected (and possibly evicted) far too late.
  const service = makeService();
  service.session = { guideId: 'guide-eager', paused: false, count: 0, intervalSec: 0 };
  service.userIsInApp = () => false;
  const requested = [];
  let releaseFirst;
  const firstGate = new Promise((r) => { releaseFirst = r; });
  service.frameForClick = (clickPos, clickAt) => {
    requested.push(clickAt);
    const frame = makeFrame(`frame-${clickAt}`);
    return clickAt === 1000 ? firstGate.then(() => frame) : Promise.resolve(frame);
  };
  let stored = 0;
  service.storeFrameAsStep = () => {
    stored += 1;
    return { ok: true, step: { stepId: `step-${stored}` } };
  };

  service.enqueueClickCapture({ x: 1, y: 1 }, 1000, 'left');
  const queue = service.enqueueClickCapture({ x: 2, y: 2 }, 1040, 'left');

  assert.deepEqual(requested, [1000, 1040],
    'both frames must be requested immediately, while the first store is still pending');
  releaseFirst();
  await queue;
  assert.equal(stored, 2);
  assert.equal(service.session.count, 2);
});

test('queued click captures preserve the original event time and button', async () => {
  const service = makeService();
  const seen = [];
  service.sessionCapture = async (trigger, clickPos, clickMeta) => {
    seen.push({ trigger, clickPos, clickMeta });
    return { ok: true };
  };

  await service.enqueueClickCapture({ x: 7, y: 8 }, 1770000000456, 'left');

  assert.deepEqual(seen, [{
    trigger: 'click',
    clickPos: { x: 7, y: 8 },
    clickMeta: { at: 1770000000456, button: 'left' },
  }]);
});

// ---- Windows watcher parsing ---------------------------------------------------

test('windows click watcher output is counted line by line', () => {
  const service = makeService();
  let clicks = 0;
  service.onOsClick = () => {
    clicks += 1;
  };

  service.processClickWatcherData('CLICK\r\nCLICK\r\n', 'win32');

  assert.equal(clicks, 2);
});

test('windows click lines carry the click-time cursor position', () => {
  const service = makeService();
  const seen = [];
  service.onOsClick = (at, osPoint) => {
    seen.push(osPoint);
  };

  service.processClickWatcherData('READY\r\nCLICK 1280 -64\r\nCLICK\r\n', 'win32');

  assert.deepEqual(seen, [{ x: 1280, y: -64 }, null],
    'coordinates ride along with the event; bare CLICK still works');
});

test('windows hook click lines carry button and event timestamp', () => {
  const service = makeService();
  const seen = [];
  service.onOsClick = (at, osPoint, button) => {
    seen.push({ at, osPoint, button });
  };

  service.processClickWatcherData('READY\r\nCLICK 321 -9 left 1770000000123\r\n', 'win32');

  assert.deepEqual(seen, [{
    at: 1770000000123,
    osPoint: { x: 321, y: -9 },
    button: 'left',
  }]);
});

// ---- click dedupe (source-aware, not a debounce) -------------------------------

test('fast same-button hook clicks are all captured — there is no time debounce', () => {
  const service = makeService();
  service.session = { guideId: 'guide-burst', paused: false, count: 0, intervalSec: 0 };
  const seen = [];
  service.enqueueClickCapture = (clickPos, at) => {
    seen.push(at);
  };

  // A 5-click burst 15ms apart — faster than the old 40ms debounce allowed.
  const base = 1770000000000;
  for (let i = 0; i < 5; i++) {
    service.onOsClick(base + i * 15, { x: 100 + i, y: 200 }, 'left');
  }

  assert.equal(seen.length, 5, 'every distinct hook event is one click');
});

test('duplicate delivery of one physical press is suppressed', () => {
  const service = makeService();
  service.session = { guideId: 'guide-dupe', paused: false, count: 0, intervalSec: 0 };
  const seen = [];
  service.enqueueClickCapture = (clickPos, at) => {
    seen.push(at);
  };

  // Same button, same coordinates, 3ms apart: the same event delivered twice.
  service.onOsClick(1770000000000, { x: 50, y: 60 }, 'left');
  service.onOsClick(1770000000003, { x: 50, y: 60 }, 'left');
  // Different coordinates inside the same window: a real second click.
  service.onOsClick(1770000000006, { x: 80, y: 60 }, 'left');
  // Different button inside the same window: also real.
  service.onOsClick(1770000000007, { x: 80, y: 60 }, 'right');

  assert.deepEqual(seen, [1770000000000, 1770000000006, 1770000000007]);
});

// ---- coordinate conversion ------------------------------------------------------

test('hook coordinates are converted physical → DIP via screenToDipPoint when available', () => {
  const service = makeService({
    screenApi: {
      screenToDipPoint: (p) => ({ x: p.x / 2, y: p.y / 2 }),
      getCursorScreenPoint: () => { throw new Error('must not fall back to a cursor read'); },
    },
  });
  service.session = { guideId: 'guide-dip', paused: false, count: 0, intervalSec: 0 };
  const seen = [];
  service.enqueueClickCapture = (clickPos) => {
    seen.push(clickPos);
  };

  service.onOsClick(1770000000000, { x: 1280, y: 640 }, 'left');

  assert.deepEqual(seen, [{ x: 640, y: 320 }]);
});

test('without screenToDipPoint, coordinates convert via display geometry (Linux/X11)', () => {
  const service = makeService({
    screenApi: {
      getAllDisplays: () => [
        { id: 1, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1440, height: 900 } },
      ],
      getCursorScreenPoint: () => { throw new Error('must not fall back to a cursor read'); },
    },
  });
  service.session = { guideId: 'guide-x11', paused: false, count: 0, intervalSec: 0 };
  const seen = [];
  service.enqueueClickCapture = (clickPos) => {
    seen.push(clickPos);
  };

  service.onOsClick(1770000000000, { x: 1500, y: 900 }, 'button-1');

  assert.deepEqual(seen, [{ x: 750, y: 450 }],
    'a physical click on a 2x display must land at the halved DIP point');
});

test('clicks without event coordinates fall back to a live cursor read', () => {
  const service = makeService({
    screenApi: {
      getCursorScreenPoint: () => ({ x: 11, y: 22 }),
      getAllDisplays: () => [],
    },
  });
  service.session = { guideId: 'guide-cursor', paused: false, count: 0, intervalSec: 0 };
  const seen = [];
  service.enqueueClickCapture = (clickPos) => {
    seen.push(clickPos);
  };

  service.onOsClick(1770000000000, null, 'mouse');

  assert.deepEqual(seen, [{ x: 11, y: 22 }]);
});

// ---- watcher loss -----------------------------------------------------------------

test('losing the click watcher mid-session falls back to interval capture', () => {
  const service = makeService();
  service.settings.get = (key) => (key === 'capture.autoIntervalSec' ? 3 : null);
  service.session = { guideId: 'guide-loss', paused: false, count: 0, intervalSec: 0 };
  const states = [];
  service.notify = (channel, payload) => {
    states.push({ channel, payload });
  };

  try {
    service.handleClickWatcherLoss('exited with code 1');

    assert.equal(service.session.intervalSec, 3,
      'captures must not silently stop when the watcher dies');
    assert.ok(states.some((s) => s.channel === 'capture:state'));
  } finally {
    service.finishSession();
  }
});

// ---- strict frame selection -----------------------------------------------------

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

test('click capture uses the newest frame completed before the click time', async () => {
  const service = makeService();
  const clickAt = Date.now();
  service.session = { guideId: 'guide-history', paused: false, count: 0, intervalSec: 0 };
  const before = makeFrame('before-click');
  before.startedAt = clickAt - 40;
  before.capturedAt = clickAt - 30;
  const after = makeFrame('after-click');
  after.startedAt = clickAt + 5;
  after.capturedAt = clickAt + 15;
  service.recentFrames = [before, after];
  service.latestFrame = after;
  service.shoot = async () => {
    throw new Error('a matching pre-click frame should be used');
  };
  const added = [];
  service.store.addStep = (guideId, fields, png) => {
    added.push(png.toString());
    return { stepId: 'step-history' };
  };

  const result = await service.sessionCapture('click', { x: 10, y: 10 }, { at: clickAt });

  assert.equal(result.ok, true);
  assert.deepEqual(added, ['before-click']);
});

test('a buffered frame from a different display is ignored for click capture', async () => {
  const service = makeService();
  const clickAt = Date.now();
  service.session = { guideId: 'guide-display', paused: false, count: 0, intervalSec: 0 };
  service.frameLoopRunning = true;
  service.frameLoopInFlight = true;
  service.frameLoopGrabStartedAt = clickAt - 10; // the in-flight grab predates the click
  service.latestFrame = makeFrame('wrong-display', 0, {
    display: { bounds: { x: 0, y: 0, width: 100, height: 100 } },
  });

  service.nextFrame = async () => {
    const f = makeFrame('right-display', 0, {
      display: { bounds: { x: 100, y: 0, width: 100, height: 100 } },
      cursor: { x: 150, y: 10 },
    });
    f.startedAt = clickAt - 10;
    return f;
  };
  service.shoot = async () => {
    throw new Error('click capture should not fall back when a matching frame arrives');
  };

  const added = [];
  service.store.addStep = (guideId, fields, png) => {
    added.push(png.toString());
    return { stepId: 'step-display' };
  };

  const result = await service.sessionCapture('click', { x: 150, y: 10 }, { at: clickAt });

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

test('strict mode: a frame whose grab started after the click is rejected', async () => {
  // This replaces the old "idle click waits for the imminent loop frame"
  // behavior: a grab that begins after the click can already show the
  // click's effects, so strict mode takes the explicit fresh-shot fallback
  // instead of passing it off as the click-time screen.
  const service = makeService();
  service.session = { guideId: 'guide-strict', paused: false, count: 0, intervalSec: 0 };
  service.frameLoopRunning = true;
  service.frameLoopInFlight = false; // nothing in flight at click time

  const clickAt = Date.now();
  service.nextFrame = async () => {
    throw new Error('strict idle clicks must not wait for a post-click frame');
  };
  let shootCalled = false;
  service.shoot = async () => {
    shootCalled = true;
    return { ok: true, step: { stepId: 'fresh-step' } };
  };

  const result = await service.sessionCapture('click', { x: 1, y: 1 }, { at: clickAt });

  assert.equal(result.ok, true);
  assert.equal(shootCalled, true);
});

test('balanced mode keeps the legacy slack: an imminent post-click frame is accepted', async () => {
  const service = makeService({ settings: { 'capture.strictClickFrames': false } });
  service.session = { guideId: 'guide-balanced', paused: false, count: 0, intervalSec: 0 };
  service.frameLoopRunning = true;
  service.frameLoopInFlight = false;

  const clickAt = Date.now();
  service.nextFrame = async () => {
    const f = makeFrame('next-loop-frame');
    f.startedAt = clickAt + 100; // grab began one idle gap after the click
    f.capturedAt = clickAt + 350;
    return f;
  };
  service.shoot = async () => {
    throw new Error('balanced idle clicks wait for the loop frame');
  };
  const added = [];
  service.store.addStep = (guideId, fields, png) => {
    added.push(png.toString());
    return { stepId: 'balanced-step' };
  };

  const result = await service.sessionCapture('click', { x: 1, y: 1 }, { at: clickAt });

  assert.equal(result.ok, true);
  assert.deepEqual(added, ['next-loop-frame']);
});

test('balanced mode: a loop frame started too long after the click still falls back', async () => {
  const service = makeService({ settings: { 'capture.strictClickFrames': false } });
  service.session = { guideId: 'guide-late', paused: false, count: 0, intervalSec: 0 };
  service.frameLoopRunning = true;
  service.frameLoopInFlight = false;

  const clickAt = Date.now();
  service.nextFrame = async () => {
    const f = makeFrame('too-late-frame');
    f.startedAt = clickAt + 5000; // way past the slack window
    f.capturedAt = clickAt + 6000;
    return f;
  };
  let shootCalled = false;
  service.shoot = async () => {
    shootCalled = true;
    return { ok: true, step: { stepId: 'fresh-step' } };
  };

  const result = await service.sessionCapture('click', { x: 1, y: 1 }, { at: clickAt });

  assert.equal(result.ok, true);
  assert.equal(shootCalled, true, 'late frames must not be passed off as the click-time screen');
});

test('clicks during an in-flight pre-click grab wait for the frame instead of being dropped', async () => {
  const service = makeService();
  service.session = { guideId: 'guide-fast', paused: false, count: 0, intervalSec: 0 };
  service.frameLoopRunning = true; // a grab is in flight, no frame buffered yet
  service.frameLoopInFlight = true;
  const clickAt = Date.now();
  service.frameLoopGrabStartedAt = clickAt - 10;
  service.shoot = async () => {
    throw new Error('waiting clicks must use the loop frame, not a competing shot');
  };
  const added = [];
  const frames = [];
  service.store.addStep = (guideId, fields, png) => {
    added.push(png.toString());
    return { stepId: `step-${added.length}` };
  };
  const origStore = service.storeFrameAsStep.bind(service);
  service.storeFrameAsStep = (guideId, mode, frame, clickPos) => {
    frames.push(frame);
    return origStore(guideId, mode, frame, clickPos);
  };

  // Two rapid clicks land before the grab completes.
  const first = service.sessionCapture('click', { x: 1, y: 1 }, { at: clickAt });
  const second = service.sessionCapture('click', { x: 2, y: 2 }, { at: clickAt });
  const loopFrame = makeFrame('loop-frame');
  loopFrame.startedAt = clickAt - 10;
  service.acceptFrame(loopFrame);
  const [r1, r2] = await Promise.all([first, second]);

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(added.length, 2, 'one step per click — fast clicks are never dropped');
  assert.equal(service.session.count, 2);
  for (const frame of frames) {
    assert.ok(frame.startedAt <= clickAt,
      'strict mode: no step may use a frame whose grab started after its click');
  }
});

// ---- stream backend integration ---------------------------------------------------

test('click frames come from the stream backend when it is active', async () => {
  const service = makeService();
  const clickAt = Date.now();
  service.session = { guideId: 'guide-stream', paused: false, count: 0, intervalSec: 0 };
  const requests = [];
  service.streamBackend = {
    isActive: () => true,
    frameForClick: async (req) => {
      requests.push(req);
      return {
        mode: 'fullscreen',
        png: Buffer.from('stream-frame'),
        size: { width: 200, height: 100 },
        display: { bounds: { x: 0, y: 0, width: 100, height: 100 } },
        startedAt: clickAt - 50,
        capturedAt: clickAt - 40,
        source: 'stream',
      };
    },
    stop: () => {},
  };
  service.shoot = async () => {
    throw new Error('the stream frame must be used, not a fresh shot');
  };
  const added = [];
  service.store.addStep = (guideId, fields, png) => {
    added.push(png.toString());
    return { stepId: 'stream-step' };
  };

  const result = await service.sessionCapture('click', { x: 10, y: 10 }, { at: clickAt });

  assert.equal(result.ok, true);
  assert.deepEqual(added, ['stream-frame']);
  assert.deepEqual(requests, [{ clickPos: { x: 10, y: 10 }, clickAt, strict: true }],
    'the worker receives the hook-time click timestamp and strictness');
});

test('a stream backend with no qualifying frame falls through to the fresh-shot path', async () => {
  const service = makeService();
  service.session = { guideId: 'guide-stream-miss', paused: false, count: 0, intervalSec: 0 };
  service.streamBackend = {
    isActive: () => true,
    frameForClick: async () => null,
    stop: () => {},
  };
  let shootCalled = false;
  service.shoot = async () => {
    shootCalled = true;
    return { ok: true, step: { stepId: 'fresh-step' } };
  };

  const result = await service.sessionCapture('click', { x: 1, y: 1 });

  assert.equal(result.ok, true);
  assert.equal(shootCalled, true);
});

test('pausing stops the frame loop, drops buffered frames, and stops the stream backend', () => {
  const service = makeService();
  service.session = { guideId: 'guide-pause', paused: false, count: 0, intervalSec: 0 };
  service.frameLoopRunning = true;
  service.latestFrame = makeFrame('pre-pause');
  let backendStopped = false;
  service.streamBackend = { isActive: () => true, stop: () => { backendStopped = true; } };

  service.togglePause(true);

  assert.equal(service.frameLoopRunning, false);
  assert.equal(service.latestFrame, null, 'a resume must never serve a pre-pause frame');
  assert.equal(backendStopped, true);
  assert.equal(service.streamBackend, null);
});

test('an unhealthy stream backend degrades to the in-process frame loop', () => {
  const service = makeService();
  service.session = { guideId: 'guide-degrade', paused: false, count: 0, intervalSec: 0 };
  service.streamBackend = { isActive: () => true, stop: () => {} };
  let loopStarted = false;
  service.startFrameLoop = () => { loopStarted = true; };
  const states = [];
  service.notify = (channel) => states.push(channel);

  service.degradeToFrameLoop();

  assert.equal(service.streamBackend, null);
  assert.equal(loopStarted, true, 'capture must not silently stop when the worker dies');
  assert.ok(states.includes('capture:state'));
});

test('session state reports which frame recorder is serving clicks', () => {
  const service = makeService();
  service.session = { guideId: 'guide-state', paused: false, count: 0, intervalSec: 0 };

  assert.equal(service.state().clickFrameSource, 'idle');
  assert.equal(service.state().strictClickFrames, true);
  service.frameLoopRunning = true;
  assert.equal(service.state().clickFrameSource, 'loop');
  service.streamBackend = { isActive: () => true, stop: () => {} };
  assert.equal(service.state().clickFrameSource, 'stream');
  service.streamBackend = null;
  service.frameLoopRunning = false;
});

// ---- marker + session lifecycle ------------------------------------------------

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
