'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rendererI18n } = require('./helpers');

/**
 * The Steps pane's threads: a line from a step down past its substeps, as in
 * a Reddit comment thread. Clicking it folds the substeps away (view only).
 * Runs the real renderStepList on an el() stand-in.
 */

function node(spec, props = {}, ...children) {
  const classes = new Set(String(props.className || spec.split('.').slice(1).join(' ')).split(' ').filter(Boolean));
  return {
    spec, props, dataset: { ...(props.dataset || {}) },
    children: children.flat().filter((c) => c != null && c !== false),
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    focus() { focused.push(this); },
  };
}
let focused = [];
const all = (n, out = []) => { if (n && typeof n === 'object') { out.push(n); n.children.forEach((c) => all(c, out)); } return out; };

// 1 A (substeps 1.1, 1.2 with 1.2.1), 2 B, 3 C (substep 3.1)
const STEPS = [
  { stepId: 'A', title: 'Open settings' }, { stepId: 'a1', parentStepId: 'A', title: 'General' },
  { stepId: 'a2', parentStepId: 'A', title: 'Security' }, { stepId: 'a21', parentStepId: 'a2', title: 'Password' },
  { stepId: 'B', title: 'Save' }, { stepId: 'C', title: 'Sign out' }, { stepId: 'c1', parentStepId: 'C', title: 'Confirm' },
];

function editor(language = 'en') {
  const menus = [];
  const context = { ...rendererI18n(language), window: { StepForgeOutline: require('../../core/step-outline') },
    el: node, clearNode: (n) => { n.children = []; }, contextMenu: (x, y, items) => menus.push(items) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const e = Object.create(context.window.GuideEditor.prototype);
  const steps = STEPS.map((s) => ({ ...s, status: 'todo' }));
  const list = node('div.steps-list');
  list.append = (item) => list.children.push(item);
  list.querySelectorAll = (selector) => all(list).filter((n) => {
    if (selector.startsWith('[data-thread=')) return n.dataset?.thread === selector.match(/"(.*)"/)[1];
    return selector.split(',').some((s) => n.spec === `button${s.trim()}`);
  });
  Object.assign(e, {
    guideId: 'g1', steps, stepMap: new Map(steps.map((s) => [s.stepId, s])), selectedStepId: 'B',
    collapsedStepsByGuide: new Map(), selectedSteps: new Set(), stepSelectMode: false,
    dom: { stepsList: list, stepCount: {}, selectStepsBtn: {} },
    renderStepBulkBar() {},
    async selectStep(stepId) { this.selectedStepId = stepId; },
  });
  Object.defineProperty(e, 'currentStep', { get() { return this.stepMap.get(this.selectedStepId); } });
  e.renderStepList();
  return { e, list, menus, context };
}
const rows = (list) => list.children.map((r) => r.dataset.stepId);
const row = (list, id) => list.children.find((r) => r.dataset.stepId === id);
const lines = (r) => r.children.filter((c) => c.spec === 'span.step-thread-line');
const start = (r) => r.children.find((c) => c.spec === 'button.step-thread-start');
const fold = (r) => all(r).find((c) => c.spec === 'button.step-fold-count');
const click = async (n) => { n.props.onClick({ stopPropagation() {} }); await new Promise((resolve) => setImmediate(resolve)); };

test('a step with substeps starts a thread that each of its substeps continues, one line per level', () => {
  const { list } = editor();
  assert.deepEqual(rows(list), ['A', 'a1', 'a2', 'a21', 'B', 'C', 'c1']);
  assert.ok(start(row(list, 'A')), 'A starts a thread');
  assert.ok(start(row(list, 'a2')), 'a2 starts its own, nested thread');
  assert.equal(start(row(list, 'B')), undefined, 'a step without substeps has no thread');
  assert.deepEqual(lines(row(list, 'a21')).map((l) => l.dataset.thread), ['A', 'a2']);
  // Every piece of a thread sits under that step's status dot, whatever row it is on.
  const x = (r, thread) => Number.parseFloat(lines(r).find((l) => l.dataset.thread === thread).props.style.left);
  assert.equal(x(row(list, 'a1'), 'A') - x(row(list, 'a21'), 'A'), 18, 'one level deeper, the same line is 18px further left in the row');
  // The thread stops at its last substep.
  assert.ok(lines(row(list, 'a21')).every((l) => l.props.className.includes('end')), 'a21 ends both threads');
  assert.ok(!lines(row(list, 'a1'))[0].props.className.includes('end'));
});

test('clicking a thread folds its substeps away and leaves a "+N" that brings them back', async () => {
  const { e, list } = editor();
  await click(lines(row(list, 'a21'))[0]); // the A thread, clicked down at a21
  assert.deepEqual(rows(list), ['A', 'B', 'C', 'c1']);
  const plus = fold(row(list, 'A'));
  assert.equal(plus.children[0], '+3');
  assert.equal(plus.props['aria-expanded'], 'false');
  assert.equal(plus.props.title, 'Show 3 substeps');
  assert.equal(start(row(list, 'A')), undefined, 'a folded step has no line');
  assert.deepEqual([...e.steps.map((s) => s.stepId)], STEPS.map((s) => s.stepId), 'no step is removed or moved');
  await click(plus);
  assert.deepEqual(rows(list), ['A', 'a1', 'a2', 'a21', 'B', 'C', 'c1']);
  assert.equal(start(row(list, 'A')).props['aria-expanded'], 'true');
});

test('a nested thread folds on its own, and stays folded inside a folded parent', async () => {
  const { list } = editor();
  await click(start(row(list, 'a2')));
  assert.deepEqual(rows(list), ['A', 'a1', 'a2', 'B', 'C', 'c1']);
  await click(start(row(list, 'A')));
  await click(fold(row(list, 'A')));
  assert.deepEqual(rows(list), ['A', 'a1', 'a2', 'B', 'C', 'c1'], 'a2 is still folded');
});

test('folding away the selected step selects the step it is under; opening a folded-away step unfolds it', async () => {
  const { e, list } = editor();
  e.selectedStepId = 'a21';
  await click(start(row(list, 'A')));
  assert.equal(e.selectedStepId, 'A');
  assert.deepEqual(rows(list), ['A', 'B', 'C', 'c1']);
  // The real selectStep (Page Down, search, Move to…) unfolds the steps above the one it opens.
  const real = Object.getPrototypeOf(e).selectStep;
  Object.assign(e, { pendingSave: false, canvas: { select() {} }, syncStepFields() {}, syncFocusedControls() {},
    renderCanvas: async () => {}, renderAnnotationPanel() {}, renderBlocksPanel() {}, emitMeta() {} });
  await real.call(e, 'a21');
  assert.ok(rows(list).includes('a21'), 'a21 is listed again');
  assert.ok(!e.collapsedSteps().has('A'));
});

test('the right-click menu ends with Collapse step / Expand step, in its own section, for steps with substeps', async () => {
  const { list, menus } = editor('ru');
  row(list, 'A').props.onContextMenu({ preventDefault() {}, clientX: 0, clientY: 0 });
  let items = menus.pop();
  assert.equal(items.at(-2), 'sep');
  assert.equal(items.at(-1).label, 'Свернуть шаг');
  await items.at(-1).action();
  row(list, 'A').props.onContextMenu({ preventDefault() {}, clientX: 0, clientY: 0 });
  items = menus.pop();
  assert.equal(items.at(-1).label, 'Развернуть шаг');
  row(list, 'B').props.onContextMenu({ preventDefault() {}, clientX: 0, clientY: 0 });
  assert.equal(menus.pop().at(-1).label, 'Удалить шаг', 'no collapse item on a step without substeps');
});

test('the thread controls are labelled buttons for keyboard and screen readers, and keep focus', async () => {
  const { list, context } = editor();
  const button = start(row(list, 'C'));
  assert.equal(button.props.type, 'button');
  assert.equal(button.props['aria-label'], 'Collapse step 3 Sign out');
  focused = [];
  await click(button);
  const plus = fold(row(list, 'C'));
  assert.equal(plus.props['aria-label'], 'Expand step 3 Sign out');
  assert.equal(focused.length, 0, 'a mouse click leaves focus alone');
  // From the keyboard (Enter or Space on the focused button), focus follows to the control that unfolds it.
  context.document = { activeElement: plus };
  await click(plus);
  assert.equal(focused.at(-1), start(row(list, 'C')));
  // Thread lines on the rows are for the mouse; the button is the keyboard way in.
  assert.ok(lines(row(list, 'a1')).every((l) => l.props['aria-hidden'] === 'true'));
});

test('in Select mode every step is listed and no threads are drawn', () => {
  const { e, list } = editor();
  e.collapsedSteps().add('A');
  e.stepSelectMode = true;
  e.renderStepList();
  assert.deepEqual(rows(list), ['A', 'a1', 'a2', 'a21', 'B', 'C', 'c1']);
  assert.equal(all(list).filter((n) => /step-thread|step-fold/.test(n.spec)).length, 0);
  e.stepSelectMode = false;
  e.renderStepList();
  assert.deepEqual(rows(list), ['A', 'B', 'C', 'c1'], 'the fold comes back after Select mode');
});
