'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const layout = require('../../core/editor-layout');
const { Settings } = require('../../core/settings');
const { makeTmpDir, rmrf, rendererI18n } = require('./helpers');

test('normal window growth changes the canvas width while both side panes remain fixed', () => {
  const preferred = { steps: 380, properties: 360 };
  const before = layout.layoutPanes(1100, preferred);
  const after = layout.layoutPanes(1400, preferred);
  assert.equal(after.steps, before.steps);
  assert.equal(after.properties, before.properties);
  assert.equal(after.canvas - before.canvas, 300);
});

test('narrow windows retain sensible side-pane minimums and restore at most the saved widths', () => {
  const preferred = { steps: 420, properties: 380 };
  const narrow = layout.layoutPanes(864, preferred);
  assert.ok(narrow.steps >= layout.MIN_WIDTHS.steps);
  assert.ok(narrow.properties >= layout.MIN_WIDTHS.properties);
  assert.ok(narrow.canvas >= layout.MIN_CANVAS_WIDTH);
  assert.equal(narrow.steps + narrow.properties + narrow.canvas + 2 * layout.DIVIDER_WIDTH, 864);
  assert.equal(narrow.canvas, 320, 'the canvas must retain a usable minimum at the supported 880 px window width');
  assert.equal(layout.layoutPanes(584, preferred).canvas, 320, 'an unsupported container size must not shrink the canvas');
  const restored = layout.layoutPanes(1500, preferred);
  assert.equal(restored.steps, 420);
  assert.equal(restored.properties, 380);
});

test('manually resizing either pane leaves the other pane unchanged and respects its available bounds', () => {
  const context = { ...rendererI18n(), window: { StepForgePaneLayout: layout } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const editor = Object.create(context.window.GuideEditor.prototype);
  editor.dom = { root: { clientWidth: 1280 } };
  editor.paneMinimums = () => layout.MIN_WIDTHS;
  editor.effectivePaneWidths = layout.layoutPanes(1280, layout.DEFAULT_WIDTHS);
  editor.applyPaneWidths = next => { editor.effectivePaneWidths = next; };
  editor.resizePane('steps', 410);
  assert.equal(editor.effectivePaneWidths.steps, 410);
  assert.equal(editor.effectivePaneWidths.properties, 330);
  editor.resizePane('properties', 380);
  assert.equal(editor.effectivePaneWidths.steps, 410);
  assert.equal(editor.effectivePaneWidths.properties, 380);
  editor.resizePane('steps', 10000);
  assert.equal(editor.effectivePaneWidths.canvas, layout.MIN_CANVAS_WIDTH);
  assert.equal(editor.effectivePaneWidths.properties, 380);
  editor.resizePane('properties', -100);
  assert.equal(editor.effectivePaneWidths.properties, layout.MIN_WIDTHS.properties);
});

test('legacy settings gain defaults and manually chosen widths survive a settings reload', t => {
  const root = makeTmpDir('pane-widths'); t.after(() => rmrf(root));
  fs.writeFileSync(path.join(root, 'app-settings.json'), JSON.stringify({ editor: { returnToSelect: false } }));
  const settings = new Settings(root);
  assert.deepEqual(settings.get('editor.paneWidths'), layout.DEFAULT_WIDTHS);
  assert.equal(settings.get('editor.returnToSelect'), false);
  settings.set('editor.paneWidths', { steps: 410, properties: 380 });
  assert.deepEqual(new Settings(root).get('editor.paneWidths'), { steps: 410, properties: 380 });
});

test('invalid stored widths cannot produce non-finite CSS or sizes below the pane minimums', () => {
  const cases = [null, [], { steps: -30, properties: '500' }, { steps: Infinity, properties: NaN }, { steps: 1e308, properties: 1e308 }];
  for (const value of cases) {
    const result = layout.layoutPanes(900, value);
    assert.ok(Number.isFinite(result.steps) && Number.isFinite(result.properties));
    assert.ok(result.steps >= layout.MIN_WIDTHS.steps && result.properties >= layout.MIN_WIDTHS.properties);
    assert.equal(result.steps + result.properties + result.canvas + 2 * layout.DIVIDER_WIDTH, 900);
  }
});

test('the steps pane minimum fits its header and its ↑ ↓ Duplicate Delete row', () => {
  const context = { ...rendererI18n(), window: { StepForgePaneLayout: layout },
    getComputedStyle: (node) => ({ columnGap: '8px', paddingLeft: node.pad || '0px', paddingRight: node.pad || '0px' }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const item = (width) => ({ offsetWidth: width, classList: { contains: () => false }, getBoundingClientRect: () => ({ width }) });
  const row = (...children) => ({ children, offsetWidth: 1, classList: { contains: (name) => name === 'row' }, getBoundingClientRect: () => ({ width: 0 }) });
  const foot = { pad: '14px', children: [item(35), item(35), item(114), item(81), item(0)] }; // a hidden button doesn't count
  const head = { pad: '14px', children: [item(51), row(item(80), item(92))] };
  const editor = Object.create(context.window.GuideEditor.prototype);
  editor.dom = { paneFoot: foot, stepsPane: { offsetWidth: 320, clientWidth: 320, querySelector: () => head } };
  // 35 + 35 + 114 + 81, three 8px gaps and 14px padding each side.
  assert.equal(editor.paneMinimums().steps, 317);
  assert.equal(editor.paneMinimums().properties, layout.MIN_WIDTHS.properties);
  // Select mode hides the row; the minimum stays where it was.
  foot.children = [];
  assert.equal(editor.paneMinimums().steps, 317);
  // Short labels (Japanese) keep the usual minimum.
  const short = Object.create(context.window.GuideEditor.prototype);
  short.dom = { paneFoot: { pad: '14px', children: [item(35), item(35), item(40), item(40)] }, stepsPane: { offsetWidth: 320, clientWidth: 320, querySelector: () => ({ pad: '14px', children: [item(40), row(item(40), item(47))] }) } };
  assert.equal(short.paneMinimums().steps, layout.MIN_WIDTHS.steps);
});

test('a raised steps minimum (its button row in a longer language) holds when resizing and laying out', () => {
  const mins = { ...layout.MIN_WIDTHS, steps: 317 };
  assert.equal(layout.clampPaneWidth('steps', 200, 1400, 330, mins), 317);
  assert.equal(layout.paneBounds('steps', 1400, 330, mins).min, 317);
  assert.equal(layout.layoutPanes(1400, { steps: 240, properties: 330 }, mins).steps, 317);
  const narrow = layout.layoutPanes(900, { steps: 500, properties: 500 }, mins);
  assert.equal(narrow.steps, 317);
  assert.ok(narrow.canvas >= layout.MIN_CANVAS_WIDTH);
  // Without a raised minimum nothing changes.
  assert.equal(layout.clampPaneWidth('steps', 200, 1400, 330), layout.MIN_WIDTHS.steps);
});

test('Fit zoom still fits an image when manual pane resizing leaves less than 100 pixels', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/canvas.js'), 'utf8'), context);
  const canvas = { parentElement: { clientWidth: 80, clientHeight: 120 }, getContext: () => ({}), addEventListener() {} };
  const annotationCanvas = new context.window.AnnotationCanvas(canvas);
  Object.assign(annotationCanvas, { image: {}, imgW: 640, imgH: 360, render() {}, requestRender() {} });
  annotationCanvas.applyZoom();
  assert.equal(canvas.width, 40);
  assert.ok(canvas.height <= 80);
});

test('pane divider keys cannot nudge annotations, deselect them, or switch canvas tools; Ctrl+S still saves', () => {
  const context = { ...rendererI18n(), window: { StepForgePaneLayout: layout } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const editor = Object.create(context.window.GuideEditor.prototype);
  editor.active = true; editor.guide = {}; editor.selectedAnnotationId = 'selected';
  editor.canvas = { select() { assert.fail('deselected annotation'); } };
  editor.setTool = () => assert.fail('switched canvas tool');
  let saves = 0; editor.saveAll = () => { saves++; };
  const target = { closest: selector => selector === '.pane-divider' ? {} : null };
  for (const key of ['ArrowLeft', 'ArrowRight', 'Escape', 'r', 'Delete']) {
    editor.onDocumentKeyDown({ key, target, preventDefault() { assert.fail('canvas consumed divider key'); } });
  }
  editor.onDocumentKeyDown({ key: 's', ctrlKey: true, target, preventDefault() {} });
  assert.equal(saves, 1);
});
