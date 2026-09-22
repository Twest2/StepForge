'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function editor() {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const instance = Object.create(context.window.GuideEditor.prototype);
  Object.assign(instance, {
    steps: ['a', 'b', 'child', 'd', 'e'].map((stepId) => ({ stepId })),
    selectedSteps: new Set(), stepSelectionAnchor: null, stepSelectMode: true,
    renderStepList() {},
  });
  return instance;
}
const selected = (e) => [...e.selectedSteps].sort();

test('shift-click selects inclusive forward and backward ranges, retaining unrelated selections', () => {
  const e = editor();
  e.toggleStepSelection('e');
  e.toggleStepSelection('a');
  e.toggleStepSelection('child', true);
  assert.deepEqual(selected(e), ['a', 'b', 'child', 'e']);
  e.clearStepSelection();
  e.toggleStepSelection('d');
  e.toggleStepSelection('b', true);
  assert.deepEqual(selected(e), ['b', 'child', 'd']);
  assert.equal(e.stepSelectionAnchor, 'd');
  e.toggleStepSelection('a', true);
  assert.deepEqual(selected(e), ['a', 'b', 'child', 'd']);
});

test('ordinary clicks toggle, while shift without an anchor behaves as a click', () => {
  const e = editor();
  e.toggleStepSelection('b', true);
  assert.deepEqual(selected(e), ['b']);
  e.toggleStepSelection('b');
  assert.deepEqual(selected(e), []);
  e.stepSelectionAnchor = 'deleted';
  e.toggleStepSelection('e', true);
  assert.deepEqual(selected(e), ['e']);
  e.toggleStepSelection('missing', true);
  assert.deepEqual(selected(e), ['e']);
});

test('clear, select all, and exiting/reentering Select mode reset the range anchor', () => {
  const e = editor();
  for (const action of ['clearStepSelection', 'selectAllSteps', 'toggleStepSelectMode']) {
    e.toggleStepSelection('b');
    e[action]();
    assert.equal(e.stepSelectionAnchor, null);
  }
  e.toggleStepSelectMode();
  assert.deepEqual(selected(e), []);
  e.toggleStepSelection('e', true);
  assert.deepEqual(selected(e), ['e']);
});
