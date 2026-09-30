'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { GuideStore } = require('../../core/store');
const { forgetScreenshotChecks } = require('../../core/redaction');
const { makeTmpDir, rmrf, TINY_PNG } = require('./helpers');

const OTHER_PNG = Buffer.concat([TINY_PNG, Buffer.from('different bytes')]);

test('a new screenshot replaces both copies and keeps the step’s text and annotations', (t) => {
  const root = makeTmpDir('choose-screenshot');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'Guide' });
  const step = store.addStep(guide.guideId, { title: 'Open settings', annotations: [{ type: 'arrow', x: 0.1, y: 0.2, w: 0.3, h: 0.1 }] }, TINY_PNG, { width: 10, height: 10 });
  const saved = store.replaceImages(guide.guideId, step.stepId, { original: OTHER_PNG }, { width: 20, height: 15 }, store.getStep(guide.guideId, step.stepId));
  assert.deepEqual(saved.image.size, { width: 20, height: 15 });
  assert.equal(saved.title, 'Open settings');
  assert.equal(saved.annotations.length, 1);
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guide.guideId, step.stepId, 'original')), OTHER_PNG);
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guide.guideId, step.stepId, 'working')), OTHER_PNG, 'a crop of the old screenshot is gone');

  // Undo puts back an original and a cropped working copy separately.
  store.replaceImages(guide.guideId, step.stepId, { original: TINY_PNG, working: OTHER_PNG }, { width: 5, height: 5 });
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guide.guideId, step.stepId, 'original')), TINY_PNG);
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guide.guideId, step.stepId, 'working')), OTHER_PNG);
  assert.throws(() => store.replaceImages(guide.guideId, step.stepId, {}, { width: 1, height: 1 }), /No screenshot/);
});

test('a step without a screenshot gets one', (t) => {
  const root = makeTmpDir('choose-screenshot');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'Guide' });
  const step = store.addStep(guide.guideId, { title: 'Read this first', kind: 'content' });
  assert.equal(step.image, null);
  const saved = store.replaceImages(guide.guideId, step.stepId, { original: TINY_PNG }, { width: 1, height: 1 });
  assert.equal(saved.kind, 'image');
  assert.equal(saved.title, 'Read this first');
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guide.guideId, step.stepId)), TINY_PNG);
});

test('private-detail blurs for the old screenshot are removed, and the step is checked again', () => {
  const step = {
    annotations: [
      { type: 'blur', redact: { kind: 'email', key: 'k1' } },
      { type: 'blur' }, // drawn by the user
      { type: 'arrow' },
    ],
    redaction: { checked: '1:working.png:10x10', dismissed: ['k2'] },
  };
  assert.equal(forgetScreenshotChecks(step), 1);
  assert.deepEqual(step.annotations.map((a) => a.type), ['blur', 'arrow']);
  assert.deepEqual(step.redaction, { checked: '', dismissed: ['k2'] }, '“not private” choices are kept');
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
  return instance;
}

test('Choose screenshot… can be undone and redone, including the original image', async () => {
  const calls = [];
  const api = {
    saved: null,
    step: {
      chooseImage: async (args) => {
        calls.push(['chooseImage', args]);
        api.saved = { stepId: 's1', title: 'Old', image: { size: { width: 20, height: 15 } }, annotations: [{ type: 'arrow' }] };
        return { ok: true, step: api.saved, removedBlurs: 0 };
      },
      setImages: async (args) => { calls.push(['setImages', args.originalBase64, args.workingBase64, args.size]); return args.step; },
    },
  };
  const e = editor(api);
  // Old screenshot: an original and a cropped working copy.
  e.stepImageToBase64 = async (step, which = 'working') => ({ base64: `${step.image.size.width}-${which}`, size: step.image.size });
  await e.chooseScreenshot('s1');
  // Arguments come from the editor's own realm, so compare by value.
  const plain = () => JSON.parse(JSON.stringify(calls));
  assert.deepEqual(plain()[0], ['chooseImage', { guideId: 'g1', stepId: 's1' }]);
  assert.match(e.toasts.at(-1), /annotations were kept.*Ctrl\+Z/);
  assert.equal(e.canvasHistory.length, 1);

  await e.undo();
  assert.deepEqual(plain()[1], ['setImages', '10-original', '10-working', { width: 10, height: 10 }], 'both old images come back');
  await e.redo();
  assert.deepEqual(plain()[2], ['setImages', '20-original', '20-working', { width: 20, height: 15 }]);
});

test('cancelling the file picker changes nothing', async () => {
  const api = { step: { chooseImage: async () => ({ ok: false }) } };
  const e = editor(api);
  e.stepImageToBase64 = async () => null;
  await e.chooseScreenshot('s1');
  assert.equal(e.canvasHistory.length, 0);
  assert.deepEqual(e.toasts, []);
});

test('the step menu offers Choose screenshot…', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8');
  assert.match(source, /label: 'Choose screenshot…', action: \(\) => this\.chooseScreenshot\(step\.stepId\)/);
});
