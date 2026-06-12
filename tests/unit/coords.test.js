'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  physicalBoundsOf,
  physicalToDip,
  displayForPhysicalPoint,
  displayForDipPoint,
} = require('../../app/coords');

const display = (id, x, y, width, height, scaleFactor = 1) => ({
  id, scaleFactor, bounds: { x, y, width, height },
});

test('at 100% scale, physical and DIP coordinates are identical', () => {
  const displays = [display(1, 0, 0, 1920, 1080, 1)];

  assert.deepEqual(physicalToDip({ x: 640, y: 360 }, displays), { x: 640, y: 360 });
});

test('at 200% scale, physical pixels halve into DIP', () => {
  // This is the classic marker-offset bug: a click at physical (1500, 900)
  // on a 2x display is the DIP point (750, 450); drawing the marker at the
  // raw values lands it far below-right of the real click.
  const displays = [display(1, 0, 0, 1440, 900, 2)];

  assert.deepEqual(physicalToDip({ x: 1500, y: 900 }, displays), { x: 750, y: 450 });
});

test('fractional scale factors convert exactly', () => {
  const displays = [display(1, 0, 0, 1280, 800, 1.5)];

  assert.deepEqual(physicalToDip({ x: 960, y: 600 }, displays), { x: 640, y: 400 });
});

test('physical bounds are DIP bounds times the scale factor', () => {
  assert.deepEqual(physicalBoundsOf(display(1, 100, 50, 1280, 800, 2)),
    { x: 200, y: 100, width: 2560, height: 1600 });
});

test('multi-monitor: a click on the secondary display converts in that display space', () => {
  // Two 1920x1080 displays side by side, uniform 2x scale. Physical x=4800
  // is the middle of the second display; its DIP x must be 1920 + 480.
  const displays = [
    display(1, 0, 0, 1920, 1080, 2),
    display(2, 1920, 0, 1920, 1080, 2),
  ];

  assert.equal(displayForPhysicalPoint({ x: 4800, y: 500 }, displays).id, 2);
  assert.deepEqual(physicalToDip({ x: 4800, y: 540 }, displays), { x: 2400, y: 270 });
});

test('multi-monitor with negative origin (display left of primary)', () => {
  const displays = [
    display(1, 0, 0, 1920, 1080, 1),
    display(2, -1920, 0, 1920, 1080, 1),
  ];

  assert.deepEqual(physicalToDip({ x: -960, y: 540 }, displays), { x: -960, y: 540 });
  assert.equal(displayForPhysicalPoint({ x: -960, y: 540 }, displays).id, 2);
});

test('a point just outside every display maps via the nearest one', () => {
  // Clicks on the outermost pixel row can round to one pixel outside the
  // display bounds; they must not be dropped or mapped to the wrong screen.
  const displays = [display(1, 0, 0, 1920, 1080, 1)];

  assert.deepEqual(physicalToDip({ x: 1921, y: 540 }, displays), { x: 1921, y: 540 });
});

test('no display geometry means no conversion (caller falls back to a cursor read)', () => {
  assert.equal(physicalToDip({ x: 10, y: 10 }, []), null);
  assert.equal(physicalToDip(null, [display(1, 0, 0, 100, 100)]), null);
  assert.equal(physicalToDip({ x: Number.NaN, y: 10 }, [display(1, 0, 0, 100, 100)]), null);
});

test('displayForDipPoint routes a click to the containing display, else the nearest', () => {
  const displays = [
    display(1, 0, 0, 1920, 1080, 1),
    display(2, 1920, 0, 1920, 1080, 1),
  ];

  assert.equal(displayForDipPoint({ x: 2000, y: 10 }, displays).id, 2);
  assert.equal(displayForDipPoint({ x: 10, y: 10 }, displays).id, 1);
  assert.equal(displayForDipPoint({ x: 5000, y: 10 }, displays).id, 2, 'nearest display wins for out-of-bounds points');
});
