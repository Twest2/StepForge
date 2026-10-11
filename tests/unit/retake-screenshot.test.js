'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CaptureService = require('../../app/capture');

function makeService() {
  return new CaptureService({
    store: {},
    settings: { get: () => null },
    getWindow: () => null,
    notify: () => {},
    screenApi: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getAllDisplays: () => [] },
  });
}

const frame = { png: Buffer.from('new'), size: { width: 20, height: 15 } };

test('a retake grabs one frame and returns its PNG without storing a step', async () => {
  const service = makeService();
  const modes = [];
  service.captureCurrentFrame = async (mode) => { modes.push(mode); return frame; };
  service.storeFrameAsStep = async () => { throw new Error('a retake must not add a step'); };
  const result = await service.retakeFrame({ mode: 'window', delayMs: 0 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.png, frame.png);
  assert.deepEqual(result.size, frame.size);
  assert.deepEqual(modes, ['window']);
  assert.equal(service.shooting, false);
});

test('a retake waits out the countdown before it grabs', async () => {
  const service = makeService();
  const started = Date.now();
  let grabbedAt = 0;
  service.captureCurrentFrame = async () => { grabbedAt = Date.now(); return frame; };
  await service.retakeFrame({ mode: 'fullscreen', delayMs: 60 });
  assert.ok(grabbedAt - started >= 50, `grabbed after ${grabbedAt - started} ms`);
});

test('a retake is refused while a recording session is active, even a paused one', async () => {
  const service = makeService();
  service.captureCurrentFrame = async () => { throw new Error('should not capture'); };
  service.session = { guideId: 'g1', paused: true, count: 0, intervalSec: 0 };
  const result = await service.retakeFrame({ mode: 'fullscreen', delayMs: 0 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /recording session/);
});

test('a region retake uses the region picker, and cancelling changes nothing', async () => {
  const service = makeService();
  const cropped = { toPNG: () => Buffer.from('crop'), getSize: () => ({ width: 5, height: 4 }) };
  const image = { crop: () => cropped, getSize: () => ({ width: 100, height: 80 }) };
  service.grab = async () => ({ image, display: { bounds: { x: 0, y: 0, width: 100, height: 80 } } });
  service.pickRegion = async () => ({ x: 1, y: 1, width: 5, height: 4 });
  const result = await service.retakeFrame({ mode: 'region', delayMs: 0 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.png, Buffer.from('crop'));
  assert.deepEqual(result.size, { width: 5, height: 4 });

  service.pickRegion = async () => null;
  const cancelled = await service.retakeFrame({ mode: 'region', delayMs: 0 });
  assert.equal(cancelled.ok, false);
  assert.equal(service.shooting, false);
});

test('a failed grab is reported and clears the in-progress flag', async () => {
  const service = makeService();
  service.captureCurrentFrame = async () => { throw new Error('no capture sources available'); };
  const result = await service.retakeFrame({ mode: 'fullscreen', delayMs: 0 });
  assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: 'no capture sources available' });
  assert.equal(service.shooting, false);
});

function editor(api) {
  const context = { window: { stepforge: api }, el: () => ({}), clearNode() {}, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const instance = Object.create(context.window.GuideEditor.prototype);
  const step = { stepId: 's1', title: 'Old', image: { size: { width: 10, height: 10 } }, annotations: [{ type: 'arrow' }] };
  Object.assign(instance, {
    guideId: 'g1', selectedStepId: 's1', steps: [step], stepMap: new Map([['s1', step]]),
    canvasHistory: [], canvasFuture: [], pendingSave: false, toasts: [],
    saveStepDebounced: { cancel() {} },
    onToast(message) { this.toasts.push(message); },
    async reload() { const fresh = api.saved; if (fresh) { this.steps = [fresh]; this.stepMap = new Map([['s1', fresh]]); } },
    renderAll() {}, renderStepList() {}, syncStepFields() {}, renderAnnotationPanel() {}, emitMeta() {},
    canvas: { setAnnotations() {} },
    dom: { annotationEditor: { contains: () => false } },
  });
  instance.stepImageToBase64 = async (s, which = 'working') => ({ base64: `${s.image.size.width}-${which}`, size: s.image.size });
  return instance;
}

test('Retake screenshot keeps the step, can be undone, and defaults to a 3 second countdown', async () => {
  const calls = [];
  const api = {
    saved: null,
    capture: { state: async () => ({ active: null }) },
    step: {
      retake: async (args) => {
        calls.push(['retake', args]);
        api.saved = { stepId: 's1', title: 'Old', image: { size: { width: 20, height: 15 } }, annotations: [{ type: 'arrow' }] };
        return { ok: true, step: api.saved, removedBlurs: 0 };
      },
      setImages: async (args) => { calls.push(['setImages', args.originalBase64, args.workingBase64]); return args.step; },
    },
  };
  const e = editor(api);
  await e.retakeScreenshot('s1', 'region');
  const plain = () => JSON.parse(JSON.stringify(calls));
  assert.deepEqual(plain()[0], ['retake', { guideId: 'g1', stepId: 's1', mode: 'region', delayMs: 3000 }]);
  assert.match(e.toasts.at(-1), /Screenshot retaken.*annotations were kept.*Ctrl\+Z/);
  assert.equal(e.canvasHistory.length, 1);
  await e.undo();
  assert.deepEqual(plain()[1], ['setImages', '10-original', '10-working'], 'the old images come back');
});

test('a refused or failed retake shows the reason and leaves the undo history alone', async () => {
  const api = {
    capture: { state: async () => ({ active: null }) },
    step: { retake: async () => ({ ok: false, reason: 'capture already in progress' }) },
  };
  const e = editor(api);
  await e.retakeScreenshot('s1', 'fullscreen');
  assert.deepEqual(e.toasts, ['capture already in progress']);
  assert.equal(e.canvasHistory.length, 0);
});

test('the editor does not even start a retake while a recording session is active', async () => {
  const api = {
    capture: { state: async () => ({ active: { guideId: 'g1' } }) },
    step: { retake: async () => { throw new Error('should not be called'); } },
  };
  const e = editor(api);
  await e.retakeScreenshot('s1', 'fullscreen');
  assert.match(e.toasts[0], /Stop the recording session/);
  assert.equal(e.canvasHistory.length, 0);
});

test('the step menu offers Full screen, Window and Region retakes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8');
  for (const mode of ['fullscreen', 'window', 'region']) {
    assert.match(source, new RegExp(`this\\.retakeScreenshot\\(step\\.stepId, '${mode}'\\)`));
  }
});
