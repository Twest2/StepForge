'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rendererI18n } = require('./helpers');

/**
 * The message on the empty canvas: a guide with no steps asks for a first
 * capture or import, while a guide with steps keeps the annotation hint.
 */
const OLD_HINT = 'Select an image step to edit annotations.';
const EMPTY_GUIDE = 'Start recording or import images to begin.';

function loadEditorClass(language = 'en') {
  const context = {
    ...rendererI18n(language),
    stepforge: {},
  };
  // Renderer scripts are plain browser scripts: window is the global.
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  return context.window.GuideEditor;
}

/**
 * An editor with just the state renderCanvas reads. The canvas is not under
 * test, so it is a no-op, and the message is read back from its DOM node.
 */
function makeEditor(language = 'en') {
  const GuideEditor = loadEditorClass(language);
  const editor = Object.create(GuideEditor.prototype);
  const node = { hidden: true, text: OLD_HINT }; // as mountShell() creates it
  editor.dom = {
    canvasEmpty: {
      get textContent() { return node.text; },
      set textContent(value) { node.text = value; },
      classList: {
        add() { node.hidden = true; },
        remove() { node.hidden = false; },
      },
    },
  };
  editor.canvas = { setTool() {}, setZoom() {}, setImage() {}, setAnnotations() {}, setFocusedView() {} };
  editor.currentTool = 'select';
  editor.currentZoom = 'fit';
  editor.imageLoadToken = 0;
  editor.guideId = 'g1';
  // What reload() leaves behind: the guide's steps, and the selection.
  const show = async (steps, selectedStepId = null) => {
    editor.steps = steps;
    editor.stepMap = new Map(steps.map((step) => [step.stepId, step]));
    editor.selectedStepId = selectedStepId;
    await editor.renderCanvas();
    return node.hidden ? null : node.text;
  };
  return { show };
}

const stepWithoutImage = { stepId: 's1', title: 'Open the page', image: null, annotations: [] };

test('an empty guide says to start recording or import images, not to edit annotations', async () => {
  const { show } = makeEditor();
  assert.equal(await show([], null), EMPTY_GUIDE);
});

test('a guide with steps keeps the annotation hint when nothing is selected', async () => {
  const { show } = makeEditor();
  assert.equal(await show([stepWithoutImage], null), OLD_HINT);
});

test('a guide with steps keeps the annotation hint when the selected step has no image', async () => {
  const { show } = makeEditor();
  assert.equal(await show([stepWithoutImage], 's1'), OLD_HINT);
});

test('the message follows the guide from empty, to steps, to empty again', async () => {
  const { show } = makeEditor();
  assert.equal(await show([], null), EMPTY_GUIDE);
  assert.equal(await show([stepWithoutImage], 's1'), OLD_HINT);
  assert.equal(await show([], null), EMPTY_GUIDE);
});

test('the empty-guide message is translated', async () => {
  const { show } = makeEditor('ru');
  const text = await show([], null);
  assert.notEqual(text, EMPTY_GUIDE);
  assert.match(text, /[А-Яа-я]/);
});
