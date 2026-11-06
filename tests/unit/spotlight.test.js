'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const raster = require('../../core/raster');
const { encodePng, decodePng } = require('../../core/png');
const { createStep, normalizeAnnotation, validateStep } = require('../../core/schema');
const { spotlightAreas } = require('../../core/annotation-properties');
const { GuideStore } = require('../../core/store');
const { buildRenderAst } = require('../../core/renderast');
const { exportHtmlSimple } = require('../../exporters/html');
const { makeTmpDir, rmrf } = require('./helpers');

/**
 * The spotlight annotation: everything outside it is darkened, once, by one
 * overlay that all of a step's spotlights are cut out of.
 */

// A screenshot-like image: every pixel a different color, so nothing passes by luck.
function gradient(width, height) {
  const img = raster.createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      img.data[p] = 40 + (x * 2) % 200;
      img.data[p + 1] = 60 + (y * 3) % 180;
      img.data[p + 2] = 220 - (x + y) % 150;
    }
  }
  return img;
}

const pixel = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const darkened = (rgba, darkness) => [...rgba.slice(0, 3).map((c) => Math.round(c * (1 - darkness))), 255];

const spotlight = (x, y, w, h, style = {}) => ({ type: 'spotlight', x, y, w, h, style: { shape: 'rect', darkness: 0.55, cornerRadius: 0, ...style } });

test('a spotlight leaves its area exactly as it was and darkens everything outside it', () => {
  const base = gradient(200, 100);
  const out = raster.renderAnnotations(base, [spotlight(0.25, 0.2, 0.5, 0.6)]); // pixels 50..150 x 20..80
  for (const [x, y] of [[50, 20], [100, 50], [149, 79], [60, 70]]) {
    assert.deepEqual(pixel(out, x, y), pixel(base, x, y), `inside at ${x},${y}`);
  }
  for (const [x, y] of [[0, 0], [49, 50], [150, 50], [100, 19], [100, 80], [199, 99]]) {
    assert.deepEqual(pixel(out, x, y), darkened(pixel(base, x, y), 0.55), `outside at ${x},${y}`);
  }
  // The base image is not changed in place.
  assert.deepEqual(pixel(base, 0, 0), pixel(gradient(200, 100), 0, 0));
});

test('two spotlights both stay bright and share one overlay, not two', () => {
  const base = gradient(200, 100);
  const out = raster.renderAnnotations(base, [
    spotlight(0.05, 0.1, 0.2, 0.3),
    spotlight(0.6, 0.5, 0.3, 0.4),
    // Overlapping the first: the overlap stays bright, not darkened by the other.
    spotlight(0.15, 0.2, 0.2, 0.3),
  ]);
  for (const [x, y] of [[20, 20], [140, 70], [175, 85], [60, 40], [40, 30]]) {
    assert.deepEqual(pixel(out, x, y), pixel(base, x, y), `inside at ${x},${y}`);
  }
  // Between and around them: darkened once (0.45 of the color), not 0.45 * 0.45.
  for (const [x, y] of [[100, 20], [100, 95], [5, 95], [190, 5]]) {
    assert.deepEqual(pixel(out, x, y), darkened(pixel(base, x, y), 0.55), `outside at ${x},${y}`);
  }
});

test('the overlay is as dark as the darkest spotlight on the step', () => {
  const base = gradient(100, 100);
  const out = raster.renderAnnotations(base, [
    spotlight(0.1, 0.1, 0.2, 0.2, { darkness: 0.3 }),
    spotlight(0.6, 0.6, 0.2, 0.2, { darkness: 0.8 }),
  ]);
  assert.deepEqual(pixel(out, 50, 50), darkened(pixel(base, 50, 50), 0.8));
  assert.deepEqual(pixel(out, 20, 20), pixel(base, 20, 20));
  // Darkness 0 leaves the whole screenshot as it was.
  const none = raster.renderAnnotations(base, [spotlight(0.1, 0.1, 0.2, 0.2, { darkness: 0 })]);
  assert.deepEqual(none.data, base.data);
});

test('an oval spotlight is bright inside the ellipse and dark in the corners of its box', () => {
  const base = gradient(200, 100);
  const out = raster.renderAnnotations(base, [spotlight(0.25, 0.2, 0.5, 0.6, { shape: 'oval' })]); // centre 100,50; radii 50,30
  for (const [x, y] of [[100, 50], [60, 50], [139, 50], [100, 25], [100, 74]]) {
    assert.deepEqual(pixel(out, x, y), pixel(base, x, y), `inside at ${x},${y}`);
  }
  // Inside the bounding box, outside the ellipse.
  for (const [x, y] of [[52, 22], [147, 22], [52, 77], [147, 77]]) {
    assert.deepEqual(pixel(out, x, y), darkened(pixel(base, x, y), 0.55), `box corner at ${x},${y}`);
  }
});

test('a rectangle spotlight’s corner radius rounds off its corners', () => {
  const base = gradient(200, 100);
  // cornerRadius is in pixels on a 1000px-wide image: 100 here is 20px on this 200px one.
  const round = raster.renderAnnotations(base, [spotlight(0.25, 0.2, 0.5, 0.6, { cornerRadius: 100 })]);
  const square = raster.renderAnnotations(base, [spotlight(0.25, 0.2, 0.5, 0.6, { cornerRadius: 0 })]);
  assert.deepEqual(pixel(square, 51, 21), pixel(base, 51, 21));
  assert.deepEqual(pixel(round, 51, 21), darkened(pixel(base, 51, 21), 0.55), 'the corner is cut off');
  assert.deepEqual(pixel(round, 100, 21), pixel(base, 100, 21), 'the straight edge stays bright');
  assert.deepEqual(pixel(round, 70, 40), pixel(base, 70, 40), 'inside the curve stays bright');
});

test('shapes and text drawn on a step stay on top of the overlay', () => {
  const base = gradient(200, 100);
  const out = raster.renderAnnotations(base, [
    { type: 'rect', x: 0.0, y: 0.0, w: 0.2, h: 0.2, style: { stroke: '#E5484D', strokeWidth: 20, fill: 'transparent' } },
    spotlight(0.5, 0.5, 0.2, 0.2),
  ]);
  assert.deepEqual(pixel(out, 0, 0), [229, 72, 77, 255], 'the rectangle outline is not darkened');
});

test('spotlight areas: drags in any direction, and the radius never exceeds half the shorter side', () => {
  const toPx = (a) => ({ x: a.x * 100, y: a.y * 100, w: a.w * 100, h: a.h * 100 });
  const { areas, darkness } = spotlightAreas([
    { type: 'rect' },
    { type: 'spotlight', x: 0.5, y: 0.5, w: -0.2, h: -0.1, style: { cornerRadius: 1000 } },
    { type: 'spotlight', x: 0.1, y: 0.1, w: 0.2, h: 0.2, style: { shape: 'oval', cornerRadius: 50 } },
  ], toPx, 1);
  assert.equal(darkness, 0.55, 'the default darkness');
  assert.equal(areas.length, 2);
  assert.deepEqual(areas[0], { x: 30, y: 40, w: 20, h: 10, oval: false, radius: 5 });
  assert.equal(areas[1].oval, true);
  assert.equal(areas[1].radius, 0);
  assert.equal(spotlightAreas([{ type: 'rect' }], toPx, 1), null);
});

test('a spotlight survives a save and load with its shape, darkness and corner radius', () => {
  const step = createStep({ annotations: [
    { id: 'a1', type: 'spotlight', x: 0.1, y: 0.2, w: 0.3, h: 0.4, style: { shape: 'oval', darkness: 0.7, cornerRadius: 12 } },
    { id: 'a2', type: 'spotlight', x: 0.5, y: 0.5, w: 0.1, h: 0.1, style: { shape: 'star', darkness: 5, cornerRadius: -3 } },
    { id: 'a3', type: 'spotlight', x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
  ] });
  const loaded = createStep(JSON.parse(JSON.stringify(step)));
  assert.deepEqual(loaded.annotations, step.annotations);
  assert.doesNotThrow(() => validateStep(loaded));
  const [a1, a2, a3] = loaded.annotations;
  assert.equal(a1.type, 'spotlight');
  assert.deepEqual([a1.style.shape, a1.style.darkness, a1.style.cornerRadius], ['oval', 0.7, 12]);
  assert.deepEqual([a2.style.shape, a2.style.darkness, a2.style.cornerRadius], ['rect', 1, 0], 'bad values are clamped');
  assert.deepEqual([a3.style.shape, a3.style.darkness, a3.style.cornerRadius], ['rect', 0.55, 8], 'defaults');
  assert.deepEqual(normalizeAnnotation(a1), a1);
});

test('a spotlight saved in a guide library loads back the same', (t) => {
  const root = makeTmpDir('spotlight-store');
  t.after(() => rmrf(root));
  const store = new GuideStore(path.join(root, 'data'));
  const guide = store.createGuide({ title: 'Spotlight' });
  const ann = spotlight(0.1, 0.2, 0.3, 0.4, { shape: 'oval', darkness: 0.65 });
  const step = store.addStep(guide.guideId, { title: 'One', annotations: [ann] }, encodePng(gradient(20, 10)), { width: 20, height: 10 });
  const loaded = new GuideStore(path.join(root, 'data')).getStep(guide.guideId, step.stepId).annotations;
  assert.equal(loaded.length, 1);
  assert.deepEqual([loaded[0].type, loaded[0].x, loaded[0].y, loaded[0].w, loaded[0].h], ['spotlight', 0.1, 0.2, 0.3, 0.4]);
  assert.deepEqual([loaded[0].style.shape, loaded[0].style.darkness, loaded[0].style.cornerRadius], ['oval', 0.65, 0]);
});

test('an HTML export shows the spotlight: its area as it was, the rest darkened', (t) => {
  const root = makeTmpDir('spotlight');
  t.after(() => rmrf(root));
  const store = new GuideStore(path.join(root, 'data'));
  const guide = store.createGuide({ title: 'Spotlight' });
  const shot = gradient(320, 200);
  store.addStep(guide.guideId, {
    title: 'Click Save',
    annotations: [
      spotlight(0.1, 0.1, 0.25, 0.25),
      spotlight(0.6, 0.5, 0.3, 0.4, { shape: 'oval' }),
    ],
  }, encodePng(shot), { width: 320, height: 200 });

  const { file } = exportHtmlSimple(buildRenderAst(store, guide.guideId), path.join(root, 'out'));
  const html = fs.readFileSync(file, 'utf8');
  const [b64] = [...html.matchAll(/src="data:image\/png;base64,([^"]+)"/g)].map((m) => m[1]);
  const img = decodePng(Buffer.from(b64, 'base64'));
  assert.deepEqual([img.width, img.height], [320, 200]);
  for (const [x, y] of [[60, 35], [240, 140]]) assert.deepEqual(pixel(img, x, y), pixel(shot, x, y), `inside at ${x},${y}`);
  for (const [x, y] of [[160, 20], [5, 190], [195, 105]]) assert.deepEqual(pixel(img, x, y), darkened(pixel(shot, x, y), 0.55), `outside at ${x},${y}`);
});
