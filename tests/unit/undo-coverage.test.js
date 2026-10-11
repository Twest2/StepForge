'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isValidOutline } = require('../../core/step-outline');

/**
 * The editor's undo history for step moves, bulk edits and single-step AI
 * writes, driven against an in-memory stand-in for the main process.
 */
function setup({ steps, confirm = async () => true }) {
  const db = {
    order: steps.map((s) => s.stepId),
    steps: new Map(steps.map((s) => [s.stepId, { revision: 1, annotations: [], ...s }])),
  };
  const toasts = [];
  const api = {
    guide: { get: async () => ({ guide: { stepsOrder: db.order }, steps: db.order.map((id) => JSON.parse(JSON.stringify(db.steps.get(id)))) }) },
    step: {
      imagePath: async () => null,
      save: async ({ step }) => {
        const saved = { ...JSON.parse(JSON.stringify(step)), revision: db.steps.get(step.stepId).revision + 1 };
        db.steps.set(step.stepId, saved);
        return JSON.parse(JSON.stringify(saved));
      },
      reorder: async ({ order, parents }) => {
        const parentOf = new Map(db.order.map((id) => [id, db.steps.get(id).parentStepId || null]));
        for (const [id, parentId] of Object.entries(parents || {})) parentOf.set(id, parentId);
        if (parents && Object.keys(parents).length && !isValidOutline(order, parentOf)) throw new Error('numbering');
        for (const [id, parentId] of parentOf) db.steps.get(id).parentStepId = parentId;
        db.order = [...order];
      },
    },
    ai: {},
  };
  const context = { window: { stepforge: api }, document: { activeElement: null }, confirmDialog: confirm, clearNode() {}, el() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const editor = Object.create(context.window.GuideEditor.prototype);
  Object.assign(editor, {
    guideId: 'g1', canvasHistory: [], canvasFuture: [], beforeCanvasSnapshot: null, pendingSave: false, steps: [], stepMap: new Map(),
    onToast: (text) => toasts.push(text), renderAll() {}, renderStepList() {}, emitMeta() {}, isAiEnabled: () => true,
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
  return { editor, db, api, toasts };
}
const outline = (db) => db.order.map((id) => `${id}${db.steps.get(id).parentStepId ? `<${db.steps.get(id).parentStepId}` : ''}`);
const three = () => [{ stepId: 'a' }, { stepId: 'b' }, { stepId: 'c' }];

test('moving a step is one undo step, and redo moves it again', async () => {
  const { editor, db } = setup({ steps: three() });
  await editor.reload('b');
  await editor.moveSelectedStep(-1);
  assert.deepEqual(db.order, ['b', 'a', 'c']);
  assert.equal(editor.canvasHistory[0].type, 'move-steps');
  await editor.undo();
  assert.deepEqual(db.order, ['a', 'b', 'c']);
  await editor.redo();
  assert.deepEqual(db.order, ['b', 'a', 'c']);
  await editor.undo();
  assert.deepEqual(db.order, ['a', 'b', 'c']);
});

test('undoing Make substep of puts the order and the parent back', async () => {
  const { editor, db } = setup({ steps: three() });
  await editor.reload('a');
  await editor.makeSubstepOf('a', 'c');
  assert.deepEqual(outline(db), ['b', 'c', 'a<c']);
  const record = editor.canvasHistory[0];
  assert.deepEqual([...record.order], ['a', 'b', 'c']);
  assert.deepEqual({ ...record.parents }, { a: null, b: null, c: null });
  await editor.undo();
  assert.deepEqual(outline(db), ['a', 'b', 'c']);
  await editor.redo();
  assert.deepEqual(outline(db), ['b', 'c', 'a<c']);
});

test('a move record restores substep parents along with the order', async () => {
  const steps = [{ stepId: 'a' }, { stepId: 'a1', parentStepId: 'a' }, { stepId: 'b' }];
  const { editor, db, api } = setup({ steps });
  await editor.reload('a');
  editor.pushCanvasHistory(editor.outlineRecord());
  // A later move un-nests a1 and puts b first.
  await api.step.reorder({ order: ['b', 'a', 'a1'], parents: { a1: null } });
  await editor.reload('a');
  await editor.undo();
  assert.deepEqual(outline(db), ['a', 'a1<a', 'b']);
});

test('one undo reverses a Style across guide on every step it touched', async () => {
  const rect = (id, color) => ({ id, type: 'rect', style: { stroke: color } });
  const steps = [
    { stepId: 'a', annotations: [rect('a1', 'red'), rect('a2', 'blue')] },
    { stepId: 'b', annotations: [] },
    { stepId: 'c', annotations: [rect('c1', 'green')] },
  ];
  const { editor, db } = setup({ steps });
  await editor.reload('a');
  editor.canvas.selected = () => rect('a1', 'red');
  await editor.applyStyleAcross('guide');
  assert.equal(db.steps.get('a').annotations[1].style.stroke, 'red');
  assert.equal(db.steps.get('c').annotations[0].style.stroke, 'red');
  assert.equal(editor.canvasHistory.length, 1);
  assert.equal(editor.canvasHistory[0].type, 'multi-step');
  assert.deepEqual([...editor.canvasHistory[0].steps.map((s) => s.stepId)], ['a', 'c']);
  await editor.undo();
  assert.equal(db.steps.get('a').annotations[1].style.stroke, 'blue');
  assert.equal(db.steps.get('c').annotations[0].style.stroke, 'green');
  await editor.redo();
  assert.equal(db.steps.get('a').annotations[1].style.stroke, 'red');
  assert.equal(db.steps.get('c').annotations[0].style.stroke, 'red');
});

test('Write this step with AI can be undone, and undo asks before overwriting a later change', async () => {
  let answer = false;
  const asked = [];
  const { editor, db, api } = setup({
    steps: [{ stepId: 'a', title: 'Click Save', descriptionHtml: '<p>mine</p>' }, { stepId: 'b' }],
    confirm: async (text) => { asked.push(text); return answer; },
  });
  await editor.reload('a');
  api.ai.fillStep = async () => {
    const saved = await api.step.save({ step: { ...db.steps.get('a'), descriptionHtml: '<p>AI</p>' } });
    return { ok: true, step: saved };
  };
  await editor.writeStepWithAi('description');
  assert.equal(db.steps.get('a').descriptionHtml, '<p>AI</p>');
  assert.equal(editor.canvasHistory.length, 1);
  await editor.undo();
  assert.equal(db.steps.get('a').descriptionHtml, '<p>mine</p>');
  assert.equal(asked.length, 0);
  await editor.redo();
  assert.equal(db.steps.get('a').descriptionHtml, '<p>AI</p>');
  assert.equal(asked.length, 0);

  // An agent edits the step; undo asks, and "no" leaves it alone and keeps the record.
  await api.step.save({ step: { ...db.steps.get('a'), title: 'Agent title' } });
  await editor.undo();
  assert.equal(asked.length, 1);
  assert.equal(db.steps.get('a').title, 'Agent title');
  assert.equal(db.steps.get('a').descriptionHtml, '<p>AI</p>');
  assert.equal(editor.canvasHistory.length, 1);
  answer = true;
  await editor.undo();
  assert.equal(db.steps.get('a').descriptionHtml, '<p>mine</p>');
  assert.equal(db.steps.get('a').title, 'Click Save');
});

test('undoing an AI write works from another step', async () => {
  const { editor, db, api } = setup({ steps: [{ stepId: 'a', title: 'one' }, { stepId: 'b', title: 'two' }] });
  await editor.reload('a');
  api.ai.fillStep = async () => ({ ok: true, step: await api.step.save({ step: { ...db.steps.get('a'), title: 'AI' } }) });
  await editor.writeStepWithAi('title');
  await editor.reload('b');
  await editor.undo();
  assert.equal(db.steps.get('a').title, 'one');
  assert.equal(db.steps.get('b').title, 'two');
});

test('pasting an annotation is its own undo step, and only nudges inside the step it came from', async () => {
  const source = { id: 'ann-1', type: 'highlight', x: 0.4, y: 0.5, w: 0.2, h: 0.1 };
  const { editor } = setup({
    steps: [{ stepId: 'a', image: {}, annotations: [source] }, { stepId: 'b', image: {}, annotations: [] }],
  });
  await editor.reload('a');
  editor.annotationClipboard = { ...source };
  editor.annotationClipboardStepId = 'a';

  assert.equal(editor.pasteAnnotation(), true);
  const same = editor.currentStep.annotations[1];
  assert.ok(Math.abs(same.x - 0.43) < 1e-9 && Math.abs(same.y - 0.53) < 1e-9);
  assert.equal(editor.canvasHistory.length, 1);
  await editor.undo();
  assert.deepEqual([...editor.currentStep.annotations.map((a) => a.id)], ['ann-1']);

  editor.selectedStepId = 'b';
  assert.equal(editor.pasteAnnotation(), true);
  const other = editor.currentStep.annotations[0];
  assert.equal(other.x, 0.4);
  assert.equal(other.y, 0.5);
  assert.equal(editor.canvasHistory.length, 1);
});
