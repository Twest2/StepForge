'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rendererI18n } = require('./helpers');

function editor() {
  const context = { ...rendererI18n(), document: { activeElement: null }, window: { StepForgeOutline: require('../../core/step-outline') },
    clone: value => JSON.parse(JSON.stringify(value)),
    el: (tag, props, ...children) => ({ tag, props, children }),
    clearNode: (node) => { node.children = []; },
  };
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


test('rendered rows and checkboxes carry Shift-click and normal mode still opens a step', () => {
  const e = editor();
  e.stepMap = new Map(e.steps.map((s) => [s.stepId, s]));
  e.selectedStepId = 'a';
  e.dom = {
    stepsList: { children: [], append(item) { this.children.push(item); } },
    stepCount: {}, selectStepsBtn: {},
  };
  e.renderStepBulkBar = () => {};
  Object.getPrototypeOf(e).renderStepList.call(e);
  const rows = e.dom.stepsList.children;
  rows[0].props.onClick({ shiftKey: false });
  let stopped = false;
  rows[2].children[0].props.onClick({ shiftKey: true, stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.deepEqual(selected(e), ['a', 'b', 'child']);
  rows[4].props.onClick({ shiftKey: true });
  assert.deepEqual(selected(e), ['a', 'b', 'child', 'd', 'e']);
  let prevented = false;
  rows[4].props.onMouseDown({ shiftKey: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  e.stepSelectMode = false;
  let opened;
  e.selectStep = (id) => { opened = id; };
  rows[3].props.onClick({ shiftKey: true });
  assert.equal(opened, 'd');
});

test('focused step/annotation controls and native selects keep plain keys without editing the canvas', () => {
  const e = editor();let saved = 0;
  Object.assign(e, { active: true, guide: {}, selectedAnnotationId: 'annotation', saveAll() { saved++; }, setTool() { assert.fail('changed a tool from a focused control'); }, canvas: { nudgeSelected() { assert.fail('nudged an annotation from a focused control'); }, select() { assert.fail('deselected an annotation from a focused control'); }, deleteSelected() { assert.fail('deleted an annotation from a focused control'); } } });
  for (const className of ['.step-control', '.annotation-select']) {
    const target = { tagName: 'BUTTON', closest: selector => selector === className ? {} : null };
    for (const key of ['ArrowLeft', 'ArrowDown', 'Escape', 'Delete', 'r']) e.onDocumentKeyDown({ key, target, preventDefault() {} });
    e.onDocumentKeyDown({ key: 's', ctrlKey: true, target, preventDefault() {} });
  }
  const select = { tagName: 'SELECT', closest: () => null };
  for (const key of ['ArrowDown', 'r', 'Escape']) e.onDocumentKeyDown({ key, target: select, preventDefault() { assert.fail('intercepted native select keys'); } });
  assert.equal(saved, 2, 'explicit save remains available from editor controls');
});

test('keyboard annotation movement records its previous geometry for undo', () => {
  const e = editor(), ann = { id: 'annotation', x: 0.2 }, step = { stepId: 'a', annotations: [ann] };
  Object.assign(e, { active: true, guide: {}, selectedStepId: 'a', selectedAnnotationId: ann.id, stepMap: new Map([['a', step]]), canvasHistory: [], canvasFuture: [], saveStepDebounced() {}, canvas: { annotations: [ann], selected: () => ann, nudgeSelected() { ann.x = 0.3;return true; } } });
  e.onDocumentKeyDown({ key: 'ArrowRight', target: { tagName: 'CANVAS', closest: () => null }, preventDefault() {} });
  assert.equal(e.canvasHistory.at(-1).step.annotations[0].x, 0.2);assert.equal(step.annotations[0].x, 0.3);
});
