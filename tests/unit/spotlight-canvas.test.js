'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const properties = require('../../core/annotation-properties');

test('spotlight overlay keeps CSS geometry on a HiDPI backing grid', () => {
  const calls = [];
  const context = new Proxy({}, { get: (_target, method) => (...args) => calls.push([method, ...args]) });
  const layer = { getContext: () => context };
  const window = { StepForgeAnnotationProperties: properties };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/canvas.js'), 'utf8'), {
    window, document: { createElement: () => layer },
  });
  const view = Object.create(window.AnnotationCanvas.prototype);
  view.canvas = { width: 400, height: 200 };
  view.viewW = 200;
  view.viewH = 100;
  view.dpr = 2;
  view.ctx = context;
  view.annotations = [{ type: 'spotlight', x: 0.25, y: 0.25, w: 0.5, h: 0.5, style: { darkness: 0.6, cornerRadius: 10 } }];
  // px() supplies CSS positions in the sharp-canvas renderer (#254).
  view.px = (ann) => ({ x: ann.x * 200, y: ann.y * 100, w: ann.w * 200, h: ann.h * 100 });
  view.drawSpotlights();
  assert.deepEqual([layer.width, layer.height], [400, 200]);
  assert.deepEqual(calls.find(([method]) => method === 'setTransform'), ['setTransform', 2, 0, 0, 2, 0, 0]);
  assert.deepEqual(calls.find(([method]) => method === 'fillRect'), ['fillRect', 0, 0, 200, 100]);
  assert.deepEqual(calls.find(([method]) => method === 'roundRect'), ['roundRect', 50, 25, 100, 50, 2]);
  assert.deepEqual(calls.find(([method]) => method === 'drawImage').slice(2), [0, 0, 200, 100]);
});
