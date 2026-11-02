'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const focused = require('../../core/focused-view');
const { createImage, applyFocusedView } = require('../../core/raster');
const { rendererI18n } = require('./helpers');

const { zoomFromInput, formatZoom, panToPercent, panFromPercent } = focused;

test('zoom from a box or slider is clamped to 1–3 and kept to two decimals', () => {
  assert.equal(zoomFromInput('1.5'), 1.5);
  assert.equal(zoomFromInput('2.345'), 2.35);
  assert.equal(zoomFromInput('0.4'), 1);
  assert.equal(zoomFromInput('7'), 3);
  assert.equal(zoomFromInput(2), 2);
  for (const bad of ['', '  ', 'abc', null, undefined]) assert.ok(Number.isNaN(zoomFromInput(bad)), `${JSON.stringify(bad)} is not a zoom`);
  assert.equal(formatZoom(1.5), '1.50');
  assert.equal(formatZoom(1.25), '1.25');
  assert.equal(formatZoom(9), '3.00');
  assert.equal(formatZoom(undefined), '1.50');
});

test('pan shows as a whole percentage, with Pan Y counted from the top', () => {
  assert.equal(panToPercent(0, 'x'), 0);
  assert.equal(panToPercent(1, 'x'), 100);
  assert.equal(panToPercent(0.4372, 'x'), 44);
  // Stored panY increases upward: 1 is the top edge, shown as 0%.
  assert.equal(panToPercent(1, 'y'), 0);
  assert.equal(panToPercent(0, 'y'), 100);
  assert.equal(panToPercent(0.25, 'y'), 75);
  assert.equal(panToPercent(undefined, 'x'), 50);
  assert.equal(panToPercent(1.5, 'y'), 0, 'an out-of-range stored value shows clamped');
});

test('a typed percentage is clamped to 0–100 and stored in the guide’s format', () => {
  assert.equal(panFromPercent('25', 'x'), 0.25);
  assert.equal(panFromPercent('25', 'y'), 0.75);
  assert.equal(panFromPercent('0', 'y'), 1);
  assert.equal(panFromPercent('100', 'y'), 0);
  assert.equal(panFromPercent('-10', 'x'), 0);
  assert.equal(panFromPercent('150', 'x'), 1);
  assert.equal(panFromPercent('33.6', 'x'), 0.34);
  for (const bad of ['', 'abc', null]) assert.ok(Number.isNaN(panFromPercent(bad, 'x')));
  for (let percent = 0; percent <= 100; percent += 1) {
    for (const axis of ['x', 'y']) assert.equal(panToPercent(panFromPercent(String(percent), axis), axis), percent, `${axis} ${percent}%`);
  }
});

test('Pan Y at 0% exports the top of the image and 100% the bottom', () => {
  const red = [255, 0, 0, 255];
  const blue = [0, 0, 255, 255];
  const img = createImage(8, 8, blue);
  for (let p = 0; p < 8 * 4 * 4; p += 4) img.data.set(red, p); // top half red
  const pixel = (out, x, y) => [...out.data.subarray((y * out.width + x) * 4, (y * out.width + x) * 4 + 4)];
  const top = applyFocusedView(img, { enabled: true, zoom: 2, panX: 0.5, panY: panFromPercent('0', 'y') });
  const bottom = applyFocusedView(img, { enabled: true, zoom: 2, panX: 0.5, panY: panFromPercent('100', 'y') });
  assert.deepEqual(pixel(top, 4, 4), red);
  assert.deepEqual(pixel(bottom, 4, 4), blue);
});

// ---- the editor ------------------------------------------------------------

function loadEditor(api) {
  const context = {
    ...rendererI18n(),
    window: { stepforge: api, StepForgeOutline: require('../../core/step-outline'), StepForgeFocusedView: focused },
    document: { activeElement: null },
    clearNode() {},
    el() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  return context.window.GuideEditor;
}

function fakeInput(value) {
  const handlers = {};
  return {
    value: String(value),
    addEventListener: (type, fn) => { handlers[type] = fn; },
    fire(type, text) {
      if (text !== undefined) this.value = text;
      handlers[type]();
    },
  };
}

function editorWithControls(focusedView) {
  const GuideEditor = loadEditor({});
  const editor = Object.create(GuideEditor.prototype);
  const step = { stepId: 's1', focusedView: { enabled: true, ...focusedView } };
  let saves = 0;
  const shown = [];
  Object.assign(editor, {
    steps: [step],
    stepMap: new Map([['s1', step]]),
    selectedStepId: 's1',
    saveStepDebounced: () => { saves += 1; },
    canvas: { setFocusedView: (fv) => shown.push({ ...fv }) },
    dom: {
      fvZoom: fakeInput(''), fvZoomNum: fakeInput(''),
      fvPanX: fakeInput(''), fvPanXNum: fakeInput(''),
      fvPanY: fakeInput(''), fvPanYNum: fakeInput(''),
    },
  });
  editor.bindFocusedControls();
  editor.showFocusedValues();
  return { editor, step, dom: editor.dom, saves: () => saves, shown };
}

test('the editor shows a step’s view in its sliders and boxes', () => {
  const { dom } = editorWithControls({ zoom: 1.25, panX: 0.4372, panY: 0.9 });
  assert.equal(String(dom.fvZoom.value), '1.25');
  assert.equal(String(dom.fvZoomNum.value), '1.25');
  assert.equal(String(dom.fvPanXNum.value), '44');
  assert.equal(String(dom.fvPanYNum.value), '10', 'stored panY 0.9 is near the top');
  assert.equal(String(dom.fvPanY.value), '10', 'the Pan Y slider runs the same way as its box');
});

test('typing in a box moves the view and its slider, and keeps the text until Enter', () => {
  const { step, dom, saves, shown } = editorWithControls({ zoom: 1.5, panX: 0.5, panY: 0.5 });
  dom.fvZoomNum.fire('input', '2');
  assert.equal(step.focusedView.zoom, 2);
  assert.equal(String(dom.fvZoom.value), '2.00');
  assert.equal(dom.fvZoomNum.value, '2', 'the box is not rewritten mid-typing');
  dom.fvZoomNum.fire('change');
  assert.equal(String(dom.fvZoomNum.value), '2.00');

  dom.fvZoomNum.fire('input', '7');
  assert.equal(step.focusedView.zoom, 3, 'too much zoom is clamped');
  dom.fvZoomNum.fire('change');
  assert.equal(String(dom.fvZoomNum.value), '3.00');

  dom.fvPanYNum.fire('input', '25');
  assert.equal(step.focusedView.panY, 0.75, '25% from the top is stored upward');
  assert.equal(String(dom.fvPanY.value), '25');
  dom.fvPanXNum.fire('input', '-5');
  assert.equal(step.focusedView.panX, 0);
  assert.equal(String(dom.fvPanX.value), '0');

  assert.equal(saves(), 4);
  assert.equal(shown.length, 4, 'every change redraws the canvas');
});

test('an emptied or unreadable box changes nothing and shows the stored value again', () => {
  const { step, dom, saves } = editorWithControls({ zoom: 1.5, panX: 0.3, panY: 0.5 });
  dom.fvPanXNum.fire('input', '');
  dom.fvPanXNum.fire('input', 'abc');
  assert.equal(step.focusedView.panX, 0.3);
  assert.equal(saves(), 0);
  dom.fvPanXNum.fire('change');
  assert.equal(String(dom.fvPanXNum.value), '30');
});

test('dragging the Pan Y slider left moves the view to the top', () => {
  const { step, dom } = editorWithControls({ zoom: 2, panX: 0.5, panY: 0.5 });
  dom.fvPanY.fire('input', '0');
  assert.equal(step.focusedView.panY, 1);
  assert.equal(String(dom.fvPanYNum.value), '0');
});
