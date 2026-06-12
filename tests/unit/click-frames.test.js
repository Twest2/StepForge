'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FrameRing,
  frameUsableForClick,
  selectFrameForClick,
} = require('../../app/click-frames');

function frame(name, { startedAt, capturedAt, mode = 'fullscreen', display = null } = {}) {
  return { name, mode, startedAt, capturedAt, display };
}

// ---- FrameRing --------------------------------------------------------------

test('the ring keeps at most `limit` frames and drops the oldest first', () => {
  let now = 1000;
  const evicted = [];
  const ring = new FrameRing({ limit: 2, retentionMs: 60_000, now: () => now, onEvict: (f) => evicted.push(f.name) });
  ring.push(frame('a', { capturedAt: 1000 }));
  ring.push(frame('b', { capturedAt: 1100 }));
  now = 1200;
  ring.push(frame('c', { capturedAt: 1200 }));

  assert.deepEqual(ring.frames().map((f) => f.name), ['b', 'c']);
  assert.deepEqual(evicted, ['a'], 'eviction must release the dropped frame');
  assert.equal(ring.latest().name, 'c');
});

test('the ring evicts frames older than the retention window', () => {
  let now = 1000;
  const ring = new FrameRing({ limit: 10, retentionMs: 500, now: () => now });
  ring.push(frame('old', { capturedAt: 1000 }));
  now = 2000;
  ring.push(frame('new', { capturedAt: 2000 }));

  assert.deepEqual(ring.frames().map((f) => f.name), ['new']);
});

test('clear() releases every frame through onEvict', () => {
  const evicted = [];
  const ring = new FrameRing({ onEvict: (f) => evicted.push(f.name) });
  ring.push(frame('a', { capturedAt: Date.now() }));
  ring.push(frame('b', { capturedAt: Date.now() }));
  ring.clear();

  assert.deepEqual(ring.frames(), []);
  assert.deepEqual(evicted.sort(), ['a', 'b']);
});

// ---- strict selection -------------------------------------------------------

test('strict mode picks the newest frame completed at or before the click', () => {
  const clickAt = 10_000;
  const frames = [
    frame('older', { startedAt: 9300, capturedAt: 9400 }),
    frame('best', { startedAt: 9800, capturedAt: 9900 }),
    frame('post-click', { startedAt: 10_050, capturedAt: 10_150 }),
  ];

  const chosen = selectFrameForClick(frames, { clickAt, mode: 'fullscreen', strict: true });

  assert.equal(chosen.name, 'best');
});

test('strict mode never accepts a frame whose grab started after the click', () => {
  const clickAt = 10_000;
  // Even one millisecond after the click, and even via the in-flight path:
  // a post-click grab can already show the click's effects.
  const f = frame('late', { startedAt: 10_001, capturedAt: 10_200 });

  assert.equal(frameUsableForClick(f, { clickAt, strict: true, allowInFlight: true }), false);
  assert.equal(selectFrameForClick([f], { clickAt, strict: true }), null);
});

test('strict mode accepts an in-flight frame whose grab started before the click', () => {
  const clickAt = 10_000;
  const f = frame('in-flight', { startedAt: 9950, capturedAt: 10_300 });

  assert.equal(frameUsableForClick(f, { clickAt, strict: true, allowInFlight: true }), true);
  assert.equal(frameUsableForClick(f, { clickAt, strict: true, allowInFlight: false }), false,
    'a not-yet-needed in-flight frame must not be selected from the buffer path');
});

test('a frame older than maxAgeMs is too stale for the click', () => {
  const clickAt = 10_000;
  const f = frame('stale', { startedAt: 9000, capturedAt: 9100 });

  assert.equal(frameUsableForClick(f, { clickAt, strict: true, maxAgeMs: 600 }), false);
  assert.equal(frameUsableForClick(f, { clickAt, strict: true, maxAgeMs: 2000 }), true);
});

test('balanced mode accepts a grab started within the slack window after the click', () => {
  const clickAt = 10_000;
  const f = frame('slack', { startedAt: 10_100, capturedAt: 10_350 });

  assert.equal(frameUsableForClick(f, {
    clickAt, strict: false, allowInFlight: true, startSlackMs: 300,
  }), true);
  assert.equal(frameUsableForClick(f, {
    clickAt, strict: true, allowInFlight: true, startSlackMs: 300,
  }), false, 'slack acceptance is balanced-mode only');
});

test('frames from another display are rejected when the click position is known', () => {
  const clickAt = 10_000;
  const left = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  const right = { bounds: { x: 1920, y: 0, width: 1920, height: 1080 } };
  const f = frame('left-screen', { startedAt: 9900, capturedAt: 9950, display: left });

  assert.equal(frameUsableForClick(f, { clickAt, clickPos: { x: 2500, y: 500 } }), false);
  assert.equal(frameUsableForClick(f, { clickAt, clickPos: { x: 500, y: 500 } }), true);
  const g = frame('right-screen', { startedAt: 9960, capturedAt: 9980, display: right });
  assert.equal(selectFrameForClick([f, g], { clickAt, clickPos: { x: 2500, y: 500 } }).name, 'right-screen');
});

test('frames of the wrong capture mode are rejected', () => {
  const clickAt = 10_000;
  const f = frame('window-grab', { startedAt: 9900, capturedAt: 9950, mode: 'window' });

  assert.equal(frameUsableForClick(f, { clickAt, mode: 'fullscreen' }), false);
  assert.equal(frameUsableForClick(f, { clickAt, mode: 'window' }), true);
});

test('a frame without startedAt falls back to capturedAt for the strict check', () => {
  const clickAt = 10_000;
  const before = frame('legacy-before', { capturedAt: 9950 });
  const after = frame('legacy-after', { capturedAt: 10_050 });

  assert.equal(frameUsableForClick(before, { clickAt, strict: true }), true);
  assert.equal(frameUsableForClick(after, { clickAt, strict: true, allowInFlight: true }), false);
});
