'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const blurFill = require('../../core/blur-fill');
const { rendererI18n } = require('./helpers');

const IMG_W = 400;
const IMG_H = 300;

// A source pixel that depends on where it is, so a fill read from the wrong
// place gives different output.
function sourcePixel(x, y) {
  return [(x * 7 + y) & 255, (y * 5 + x * 3) & 255, (x ^ y) & 255, 255];
}

// A 2D context that keeps a log of the calls the canvas makes. getImageData
// returns real pixels from the fake screenshot above.
function fakeContext(log) {
  const ctx = {
    getImageData(x0, y0, w, h) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) data.set(sourcePixel(x0 + x, y0 + y), (y * w + x) * 4);
      }
      return { data, width: w, height: h };
    },
    putImageData(pixels) { log.put.push(pixels.data.slice()); },
    setTransform(...args) { log.transforms.push(args); },
  };
  return new Proxy(ctx, {
    get: (target, key) => (key in target ? target[key] : () => {}),
    set: (target, key, value) => { target[key] = value; return true; },
  });
}

function fakeCanvasElement(log) {
  return {
    width: 0,
    height: 0,
    style: {},
    parentElement: { clientWidth: 2000, clientHeight: 2000 },
    addEventListener() {},
    setPointerCapture() {},
    getContext: () => fakeContext(log),
    // On screen the canvas has its CSS size, not its pixel-grid size.
    getBoundingClientRect() {
      return { left: 0, top: 0, width: parseFloat(this.style.width), height: parseFloat(this.style.height) };
    },
  };
}

// Loads the real canvas.js with a counting blur fill and, optionally, a
// display scale factor and a frame queue standing in for requestAnimationFrame.
function loadCanvas({ dpr = 1, frames = null } = {}) {
  const log = { fills: 0, put: [], transforms: [], renders: 0 };
  const window = {
    devicePixelRatio: dpr,
    StepForgeBlurFill: {
      pixelRect: blurFill.pixelRect,
      fillFromSurroundings: (...args) => { log.fills++; return blurFill.fillFromSurroundings(...args); },
    },
  };
  const context = {
    ...rendererI18n(),
    window,
    document: { createElement: () => fakeCanvasElement(log) },
  };
  if (frames) {
    context.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    context.cancelAnimationFrame = (id) => { frames[id - 1] = null; };
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/canvas.js'), 'utf8'), context);
  const canvas = new window.AnnotationCanvas(fakeCanvasElement(log), {});
  const render = canvas.render.bind(canvas);
  canvas.render = () => { log.renders++; render(); };
  return { canvas, log };
}

function runFrames(frames) {
  const queued = frames.splice(0);
  for (const fn of queued) if (fn) fn();
}

const blur = (id, x, y, w, h) => ({ id, type: 'blur', x, y, w, h, radius: 8, style: {} });

test('on a scaled display the canvas pixel grid matches the screen, at the same on-screen size', () => {
  const { canvas, log } = loadCanvas({ dpr: 1.5 });
  canvas.setZoom(1);
  canvas.setImage({}, IMG_W, IMG_H);

  assert.equal(canvas.canvas.style.width, `${IMG_W}px`);
  assert.equal(canvas.canvas.style.height, `${IMG_H}px`);
  assert.equal(canvas.canvas.width, IMG_W * 1.5);
  assert.equal(canvas.canvas.height, IMG_H * 1.5);
  // Drawing is scaled up onto the finer grid.
  assert.deepEqual(log.transforms.at(-1), [1.5, 0, 0, 1.5, 0, 0]);

  // Pointer positions are in CSS pixels and still land where they should.
  canvas.setTool('rect');
  canvas.onDown({ pointerId: 1, clientX: 100, clientY: 75 });
  canvas.onMove({ pointerId: 1, clientX: 300, clientY: 225 });
  canvas.onUp({ pointerId: 1, clientX: 300, clientY: 225 });
  const [rect] = canvas.annotations;
  assert.deepEqual([rect.x, rect.y, rect.w, rect.h], [0.25, 0.25, 0.5, 0.5]);

  // Its resize handle is found at the same CSS position.
  canvas.setTool('select');
  canvas.select(rect.id);
  assert.equal(canvas.handleAt({ clientX: 300, clientY: 225 }), 'se');
});

test('zoom levels larger than the pane shrink to fit it and keep the image shape', () => {
  const { canvas } = loadCanvas({ dpr: 2 });
  canvas.canvas.parentElement = { clientWidth: 220, clientHeight: 1000 };
  canvas.setImage({}, IMG_W, IMG_H);
  canvas.setZoom(1.5);
  assert.equal(canvas.canvas.style.width, '220px');
  assert.equal(canvas.canvas.style.height, '165px');
  assert.equal(canvas.canvas.width, 440);
  assert.equal(canvas.canvas.height, 330);
});

test('blur fills are kept between redraws and match a fresh fill', () => {
  const { canvas, log } = loadCanvas();
  canvas.setImage({}, IMG_W, IMG_H);
  canvas.setAnnotations([blur('a', 0.1, 0.1, 0.2, 0.2), blur('b', 0.6, 0.6, 0.2, 0.2)]);
  assert.equal(log.fills, 2);
  const first = log.put.slice();

  // Picking tools, selecting and redrawing don't fill again.
  canvas.setTool('arrow');
  canvas.setTool('select');
  canvas.select('a');
  canvas.render();
  assert.equal(log.fills, 2);

  // The kept fills are what a fresh canvas computes for the same blurs.
  const fresh = loadCanvas();
  fresh.canvas.setImage({}, IMG_W, IMG_H);
  fresh.canvas.setAnnotations([blur('a', 0.1, 0.1, 0.2, 0.2), blur('b', 0.6, 0.6, 0.2, 0.2)]);
  assert.deepEqual(fresh.log.put, first);
});

test('moving a blur refills it and only the blurs whose edges it touches', () => {
  const { canvas, log } = loadCanvas();
  canvas.setImage({}, IMG_W, IMG_H);
  const anns = [blur('a', 0.1, 0.1, 0.2, 0.2), blur('b', 0.6, 0.6, 0.2, 0.2), blur('c', 0.6, 0.1, 0.1, 0.1)];
  canvas.setAnnotations(anns);
  assert.equal(log.fills, 3);

  // b moves somewhere clear of the others: only b is refilled.
  anns[1].x = 0.55;
  canvas.render();
  assert.equal(log.fills, 4);

  // b now overlaps c's bottom edge, so c is refilled too, since a fill never
  // reads pixels under another blur.
  anns[1].y = 0.15;
  canvas.render();
  assert.equal(log.fills, 6);

  // Changing the radius refills that blur.
  anns[0].radius = 4;
  canvas.render();
  assert.equal(log.fills, 7);

  // A new screenshot (crop, undo, another step) starts over.
  canvas.setImage({}, IMG_W, IMG_H);
  canvas.render();
  assert.equal(log.fills, 10);
});

test('switching steps and picking a tool redraw once per frame', () => {
  const frames = [];
  const { canvas, log } = loadCanvas({ frames });
  canvas.setImage({}, IMG_W, IMG_H);
  runFrames(frames);
  log.renders = 0;

  // What the editor does when a step's screenshot loads.
  canvas.setImage({}, IMG_W, IMG_H);
  canvas.setAnnotations([blur('a', 0.1, 0.1, 0.2, 0.2)]);
  canvas.setFocusedView(null);
  canvas.setTool('select');
  canvas.setZoom('fit');
  assert.equal(log.renders, 0);
  runFrames(frames);
  assert.equal(log.renders, 1);

  canvas.setTool('blur');
  runFrames(frames);
  assert.equal(log.renders, 2);
  assert.equal(log.fills, 1);
});
