'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { smartCrop } = require('../../core/smart-crop');
const raster = require('../../core/raster');

const bounds = { x: -1920, y: 120, width: 1920, height: 1080 };
const size = { width: 3840, height: 2160 };

test('smart crop centers clicks and clamps all edges on scaled secondary displays', () => {
  for (const [x, y, panX, panY] of [
    [0.5, 0.5, 0.5, 0.5], [0, 0, 0, 1], [1, 0, 1, 1],
    [0, 1, 0, 0], [1, 1, 1, 0], [0, 0.5, 0, 0.5],
    [1, 0.5, 1, 0.5], [0.5, 0, 0.5, 1], [0.5, 1, 0.5, 0],
  ]) {
    const view = smartCrop(size, bounds, { x: bounds.x + x * bounds.width, y: bounds.y + y * bounds.height });
    assert.deepEqual(view, { enabled: true, zoom: 1.5, panX, panY });
  }
});

test('smart crop preserves minimum context and ignores invalid or absent clicks', () => {
  assert.equal(smartCrop(size, bounds, null), null);
  assert.equal(smartCrop(size, bounds, { x: 100, y: 200 }), null);
  assert.equal(smartCrop(size, bounds, { x: NaN, y: 200 }), null);
  assert.equal(smartCrop(size, { ...bounds, width: 0 }, { x: 0, y: 0 }), null);
  assert.equal(smartCrop({ width: 600, height: 300 }, { x: 0, y: 0, width: 600, height: 300 }, { x: 300, y: 150 }), null);
  assert.equal(smartCrop(size, { x: 0, y: 0, width: 960, height: 540 }, { x: 480, y: 270 }).zoom, 1.5);
});

test('exported focus includes the bottom-right target without modifying the source', () => {
  const img = raster.createImage(1280, 720, [0, 0, 0, 255]);
  raster.fillRect(img, 1200, 640, 80, 80, [255, 0, 0, 255]);
  const original = Buffer.from(img.data);
  const view = smartCrop(img, { x: 0, y: 0, width: 1280, height: 720 }, { x: 1240, y: 680 });
  const output = raster.applyFocusedView(img, view);
  const offset = (640 * output.width + 1200) * 4;
  assert.deepEqual(Array.from(output.data.slice(offset, offset + 4)), [255, 0, 0, 255]);
  assert.deepEqual(Buffer.from(img.data), original);
});

test('user focus amount supports full context, increments, and safe limits', () => {
  const point = { x: -960, y: 660 };
  assert.equal(smartCrop(size, bounds, point, 1), null);
  assert.equal(smartCrop(size, bounds, point, 1.25).zoom, 1.25);
  assert.equal(smartCrop(size, bounds, point, 1.26).zoom, 1.25);
  assert.equal(smartCrop(size, bounds, point, 1.75).zoom, 1.75);
  assert.equal(smartCrop(size, bounds, point, 2).zoom, 2);
  assert.equal(smartCrop(size, bounds, point, 100).zoom, 2);
  assert.equal(smartCrop(size, { x: 0, y: 0, width: 960, height: 540 }, { x: 480, y: 270 }, 2).zoom, 1.5);
  assert.equal(smartCrop(size, bounds, point, -1), null);
  for (const bad of [NaN, Infinity, 'bad', null]) assert.equal(smartCrop(size, bounds, point, bad).zoom, 1.5);
});
