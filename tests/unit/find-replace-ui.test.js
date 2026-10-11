'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { findMatches, applyReplacements } = require('../../core/find-replace');
const { createStep } = require('../../core/schema');

const json = (v) => JSON.parse(JSON.stringify(v));

/** The editor against an in-memory stand-in for the main process (see undo-coverage.test.js). */
function setupEditor(steps) {
  const db = { order: steps.map((s) => s.stepId), steps: new Map(steps.map((s) => [s.stepId, { ...s, revision: 1 }])) };
  const toasts = [];
  const ordered = () => db.order.map((id) => json(db.steps.get(id)));
  const api = {
    guide: { get: async () => ({ guide: { stepsOrder: db.order }, steps: ordered() }) },
    step: {
      save: async ({ step }) => {
        const saved = { ...json(step), revision: db.steps.get(step.stepId).revision + 1 };
        db.steps.set(step.stepId, saved);
        return json(saved);
      },
    },
    findReplace: {
      find: async ({ query, replacement, caseSensitive, wholeWord }) => ({
        matches: json(findMatches(ordered(), query, { replacement, caseSensitive, wholeWord })), truncated: false,
      }),
      apply: async ({ matches, replacement }) => json(applyReplacements(ordered(), matches, replacement)),
    },
  };
  const shown = [];
  const dialogs = { showFindReplace: async (options) => { shown.push(options); } };
  const context = {
    window: { stepforge: api, StepForgeDialogs: dialogs }, document: { activeElement: null },
    confirmDialog: async () => true, clearNode() {}, el() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const editor = Object.create(context.window.GuideEditor.prototype);
  Object.assign(editor, {
    guideId: 'g1', canvasHistory: [], canvasFuture: [], beforeCanvasSnapshot: null, pendingSave: false, steps: [], stepMap: new Map(),
    onToast: (text) => toasts.push(text), renderAll() {}, renderStepList() {}, emitMeta() {},
    saveStepDebounced: Object.assign(() => {}, { cancel() {} }),
    canvas: { setAnnotations() {}, select() {}, selected: () => null },
    syncStepFields() {}, renderAnnotationPanel() {}, dom: { annotationEditor: { contains: () => false } },
    reload: async (stepId) => {
      const { steps: fresh } = await api.guide.get();
      editor.steps = fresh;
      editor.stepMap = new Map(fresh.map((s) => [s.stepId, s]));
      editor.selectedStepId = stepId && editor.stepMap.has(stepId) ? stepId : fresh[0].stepId;
    },
  });
  return { editor, db, toasts, shown, api };
}

const guideSteps = () => [
  createStep({ stepId: 'a', title: 'Open Widget', descriptionHtml: '<p>The Widget menu</p>' }),
  createStep({ stepId: 'b', title: 'Other', tableBlocks: [{ rows: [['Widget', 'x']] }] }),
  createStep({ stepId: 'c', title: 'Widget again', annotations: [{ type: 'text', text: 'Widget' }] }),
];

test('Ctrl+H opens the find and replace dialog with the step numbers', async () => {
  const { editor, shown } = setupEditor(guideSteps());
  await editor.reload('a');
  Object.assign(editor, { active: true, guide: { guideId: 'g1' } });
  let prevented = false;
  editor.onDocumentKeyDown({ ctrlKey: true, key: 'h', shiftKey: false, altKey: false, preventDefault: () => { prevented = true; }, target: {} });
  await new Promise((r) => setImmediate(r));
  assert.ok(prevented);
  assert.equal(shown.length, 1);
  assert.deepEqual(json(shown[0].stepNumbers), { a: '1', b: '2', c: '3' });
});

test('one replace batch is one multi-step undo record, undone and redone by one Ctrl+Z / Ctrl+Y', async () => {
  const { editor, db, toasts } = setupEditor(guideSteps());
  await editor.reload('a');
  const before = json(editor.steps);
  const matches = findMatches(editor.steps, 'Widget');
  const replaced = await editor.replaceMatches(json(matches), 'Gadget');
  assert.equal(replaced, 5);
  assert.equal(db.steps.get('a').title, 'Open Gadget');
  assert.equal(db.steps.get('a').descriptionHtml, '<p>The Gadget menu</p>');
  assert.equal(db.steps.get('b').tableBlocks[0].rows[0][0], 'Gadget');
  assert.equal(db.steps.get('c').annotations[0].text, 'Gadget');
  assert.equal(editor.canvasHistory.length, 1);
  assert.equal(editor.canvasHistory[0].type, 'multi-step');
  assert.deepEqual(editor.canvasHistory[0].steps.map((s) => s.stepId), ['a', 'b', 'c']);
  assert.match(toasts.at(-1), /Replaced 5 in 3 steps/);

  await editor.undo();
  for (const step of before) assert.equal(JSON.stringify({ ...db.steps.get(step.stepId), revision: 0 }), JSON.stringify({ ...step, revision: 0 }));
  assert.equal(editor.canvasHistory.length, 0);
  await editor.redo();
  assert.equal(db.steps.get('c').title, 'Gadget again');
  assert.equal(db.steps.get('b').tableBlocks[0].rows[0][0], 'Gadget');
});

test('refused matches are skipped and reported, and a batch that changes nothing pushes no record', async () => {
  const { editor, db, toasts } = setupEditor([createStep({ stepId: 'a', title: 'x', tableBlocks: [{ rows: [['x']] }] })]);
  await editor.reload('a');
  const matches = json(findMatches(editor.steps, 'x'));
  assert.equal(await editor.replaceMatches(matches, 'a|b'), 1);
  assert.equal(db.steps.get('a').title, 'a|b');
  assert.deepEqual(db.steps.get('a').tableBlocks[0].rows, [['x']]);
  assert.match(toasts.at(-1), /1 skipped/);
  assert.equal(editor.canvasHistory.length, 1);

  const only = json(findMatches([createStep({ stepId: 'a', tableBlocks: [{ rows: [['x']] }] })], 'x'));
  assert.equal(await editor.replaceMatches(only, 'a|b'), 0);
  assert.equal(editor.canvasHistory.length, 1, 'nothing changed, nothing to undo');
  assert.match(toasts.at(-1), /Nothing was replaced/);
});

/** The dialog, with a fake DOM just big enough to drive it. */
function setupDialog({ find, replace }) {
  const nodes = [];
  const context = {
    window: {}, setTimeout: () => {}, debounce: (fn) => fn,
    clearNode: (node) => { node.children = []; },
    openModal: (options) => { context.modal = options; return { close() { context.closed = true; } }; },
    el(selector, attrs = {}, ...children) {
      const node = {
        selector, ...attrs, children: children.flat().filter((c) => c != null && c !== false), handlers: {},
        append(...kids) { this.children.push(...kids); },
        addEventListener(name, fn) { this.handlers[name] = fn; },
      };
      nodes.push(node);
      return node;
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/dialogs.js'), 'utf8'), context);
  const result = context.window.StepForgeDialogs.showFindReplace({ stepNumbers: { a: '1', b: '2' }, find, replace });
  const byPlaceholder = (p) => nodes.find((n) => n.placeholder === p);
  const text = (node) => (node.children || []).map((c) => (typeof c === 'string' ? c : text(c))).join('');
  return { result, context, nodes, byPlaceholder, text, replaceButton: context.modal.footer[1] };
}

test('the dialog lists matches, locks blocked ones, and sends only the ticked ones to replace', async () => {
  const steps = [createStep({ stepId: 'a', title: 'x one x' }), createStep({ stepId: 'b', tableBlocks: [{ rows: [['x']] }] })];
  let sent;
  const d = setupDialog({
    find: async (o) => ({ matches: json(findMatches(steps, o.query, { replacement: o.replacement })), truncated: false }),
    replace: async (matches, replacement) => { sent = { matches, replacement }; },
  });
  assert.ok(d.text(d.context.modal.body).includes('Screenshots are not changed.'));
  assert.equal(d.replaceButton.disabled, true);

  const query = d.byPlaceholder('Find');
  const replacement = d.byPlaceholder('Replace with');
  query.value = 'x';
  replacement.value = 'a|b';
  await query.handlers.input();
  const list = d.nodes.find((n) => n.selector === 'div.qa-results.fr-results');
  assert.equal(list.children.length, 3);
  const [first, second, cell] = list.children;
  assert.match(d.text(first), /Step 1 · Title/);
  assert.equal(cell.title.includes('table cell'), true, 'the refusal reason is shown');
  const cellBox = cell.children[0];
  assert.equal(cellBox.disabled, true);
  assert.equal(cellBox.checked, false);
  assert.equal(d.replaceButton.textContent, 'Replace 2');

  // Untick the second match, then replace.
  second.children[0].checked = false;
  second.children[0].handlers.change();
  assert.equal(d.replaceButton.textContent, 'Replace 1');
  await d.replaceButton.handlers.click();
  assert.equal(sent.replacement, 'a|b');
  assert.equal(sent.matches.length, 1);
  assert.equal(sent.matches[0].start, 0);
  assert.equal(await d.result, true);
  assert.equal(d.context.closed, true);
});
