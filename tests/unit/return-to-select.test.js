'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Settings } = require('../../core/settings');
const { makeTmpDir, rmrf, rendererI18n } = require('./helpers');

// A 2D context that accepts every drawing call, so the canvas renders headlessly.
function fakeContext() {
  const fn = () => proxy;
  const proxy = new Proxy(fn, {
    get: (_target, key) => {
      if (key === Symbol.toPrimitive) return () => 0;
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      return proxy;
    },
    set: () => true,
    apply: () => proxy,
  });
  return proxy;
}

function fakeCanvasElement() {
  return {
    width: 0, height: 0,
    parentElement: { clientWidth: 1040, clientHeight: 840 },
    addEventListener() {},
    setPointerCapture() {},
    getContext: () => fakeContext(),
    getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; },
  };
}

function loadRenderer() {
  const context = {
    ...rendererI18n(),
    window: { stepforge: {}, StepForgeDialogs: {} },
    document: { createElement: () => fakeCanvasElement() },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/canvas.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  return context.window;
}

// The editor's tool wiring on top of a real AnnotationCanvas, as built in editor.js.
function editorWithCanvas(settings) {
  const { AnnotationCanvas, GuideEditor } = loadRenderer();
  const editor = Object.create(GuideEditor.prototype);
  editor.dom = {
    'tool-select': { dataset: { tool: 'select' }, classList: { toggle() {} } },
    'tool-blur': { dataset: { tool: 'blur' }, classList: { toggle() {} } },
  };
  editor.setSettings(settings);
  const changes = [];
  editor.canvas = new AnnotationCanvas(fakeCanvasElement(), {
    onChange: (annotations) => changes.push(annotations.length),
    onCrop: () => {},
    onToolUsed: () => editor.onCanvasToolUsed(),
  });
  editor.canvas.setImage({}, 1000, 800);
  return { editor, canvas: editor.canvas, changes };
}

// Press at one point and release at another, in canvas pixels.
function drag(canvas, [x0, y0], [x1, y1]) {
  canvas.onDown({ pointerId: 1, clientX: x0, clientY: y0 });
  canvas.onMove({ pointerId: 1, clientX: x1, clientY: y1 });
  canvas.onUp({ pointerId: 1, clientX: x1, clientY: y1 });
}

test('going back to Select after each use is on by default and the choice is saved', (t) => {
  const dir = makeTmpDir();
  t.after(() => rmrf(dir));
  const settings = new Settings(dir);
  assert.equal(settings.get('editor.returnToSelect'), true);
  settings.set('editor.returnToSelect', false);
  assert.equal(new Settings(dir).get('editor.returnToSelect'), false);
});

test('by default, drawing one annotation goes back to Select with it selected', () => {
  for (const tool of ['blur', 'rect', 'oval', 'arrow', 'line', 'text', 'tooltip', 'number', 'highlight', 'magnify', 'cursor']) {
    const { editor, canvas, changes } = editorWithCanvas({});
    editor.setTool(tool);
    drag(canvas, [100, 100], [300, 250]);
    assert.equal(editor.currentTool, 'select', tool);
    assert.equal(canvas.tool, 'select', tool);
    assert.equal(canvas.annotations.length, 1, tool);
    assert.equal(canvas.annotations[0].type, tool);
    assert.equal(canvas.selectedId, canvas.annotations[0].id, tool);
    assert.deepEqual(changes, [1], tool);

    // The next drag moves what was drawn instead of drawing another one.
    const { x } = canvas.annotations[0];
    drag(canvas, [150, 150], [250, 150]);
    assert.equal(canvas.annotations.length, 1, tool);
    assert.ok(canvas.annotations[0].x > x, tool);
  }
});

test('with the setting off, the tool stays picked for the next annotation', () => {
  const { editor, canvas } = editorWithCanvas({ editor: { returnToSelect: false } });
  editor.setTool('blur');
  drag(canvas, [100, 100], [300, 250]);
  drag(canvas, [400, 400], [500, 500]);
  assert.equal(editor.currentTool, 'blur');
  assert.deepEqual([...canvas.annotations.map((a) => a.type)], ['blur', 'blur']);
});

test('cropping goes back to Select, but a click too small to crop keeps the crop tool', () => {
  const { editor, canvas } = editorWithCanvas({});
  editor.setTool('crop');
  drag(canvas, [100, 100], [102, 101]);
  assert.equal(editor.currentTool, 'crop');
  drag(canvas, [100, 100], [500, 400]);
  assert.equal(editor.currentTool, 'select');
});
