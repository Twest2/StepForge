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
        // Mirrors store.reorderSteps: same steps, and a checked outline whenever parents is passed.
        if (order.length !== db.order.length || !order.every((id) => db.steps.has(id))) throw new Error('exactly the existing steps');
        const parentOf = new Map(db.order.map((id) => [id, db.steps.get(id).parentStepId || null]));
        const wasValid = isValidOutline(db.order, parentOf);
        for (const [id, parentId] of Object.entries(parents || {})) parentOf.set(id, parentId);
        if (parents && wasValid && !isValidOutline(order, parentOf)) throw new Error('numbering');
        for (const [id, parentId] of parentOf) db.steps.get(id).parentStepId = parentId;
        db.order = [...order];
      },
    },
    ai: {},
  };
  // Images "load" from paths like "size:1920x1080", so a test can give a step's file a size.
  class Image {
    set src(value) {
      const m = /^size:(\d+)x(\d+)$/.exec(value);
      setImmediate(() => {
        if (!m) return this.onerror && this.onerror();
        this.naturalWidth = Number(m[1]);
        this.naturalHeight = Number(m[2]);
        return this.onload && this.onload();
      });
    }
  }
  const context = { window: { stepforge: api }, document: { activeElement: null }, confirmDialog: confirm, clearNode() {}, el() {}, Image, setImmediate };
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

test('pasting an annotation onto selected steps skips other aspect ratios, and one Ctrl+Z reverts all', async () => {
  const source = { id: 'ann-1', type: 'blur', x: 0.1, y: 0.2, w: 0.3, h: 0.05 };
  const img = (width, height) => ({ size: { width, height } });
  const { editor, db, toasts } = setup({
    steps: [
      { stepId: 'a', image: img(1920, 1080), annotations: [source] },
      { stepId: 'b', image: img(1920, 1080) },
      { stepId: 'c', image: img(1280, 721) }, // within 1% of 16:9
      { stepId: 'd', image: img(1000, 1000) }, // a crop
      { stepId: 'e' }, // no image
      { stepId: 'f', image: img(1920, 1080) }, // not selected
    ],
  });
  await editor.reload('a');
  editor.annotationClipboard = { ...source };
  editor.annotationClipboardStepId = 'a';
  editor.annotationClipboardAspect = 1920 / 1080;
  editor.selectedSteps = new Set(['a', 'b', 'c', 'd', 'e']);

  await editor.pasteAnnotationToSelectedSteps();
  const ids = ['b', 'c'].map((id) => db.steps.get(id).annotations.map((x) => x.id));
  assert.equal(ids[0].length, 1);
  assert.notEqual(ids[0][0], 'ann-1');
  assert.notEqual(ids[0][0], ids[1][0]);
  for (const id of ['b', 'c']) {
    const ann = db.steps.get(id).annotations[0];
    assert.deepEqual([ann.x, ann.y, ann.w, ann.h], [0.1, 0.2, 0.3, 0.05]);
  }
  assert.equal(db.steps.get('a').annotations.length, 1);
  for (const id of ['d', 'e', 'f']) assert.equal(db.steps.get(id).annotations.length, 0);
  assert.equal(editor.canvasHistory.length, 1);
  assert.equal(editor.canvasHistory[0].type, 'multi-step');
  assert.match(toasts.at(-1), /pasted onto 2 steps/);
  assert.match(toasts.at(-1), /Skipped 3 steps.*: 1, 4, 5\./);

  await editor.undo();
  for (const id of ['b', 'c', 'd', 'e', 'f']) assert.equal(db.steps.get(id).annotations.length, 0);
  assert.equal(db.steps.get('a').annotations.length, 1);
  await editor.redo();
  assert.equal(db.steps.get('b').annotations.length, 1);
  assert.equal(db.steps.get('c').annotations.length, 1);
});

test('an AI write of the blocks shows the new blocks, and a later save keeps them', async () => {
  const { editor, db, api } = setup({
    steps: [{ stepId: 'a', title: 'one', textBlocks: [{ id: 't1', html: '<p>old</p>' }] }, { stepId: 'b' }],
  });
  await editor.reload('a');
  api.ai.fillStep = async () => ({
    ok: true,
    step: await api.step.save({ step: { ...db.steps.get('a'), textBlocks: [{ id: 't2', html: '<p>AI</p>' }] } }),
  });
  await editor.writeStepWithAi('blocks');
  assert.deepEqual(editor.currentStep.textBlocks.map((b) => b.html), ['<p>AI</p>']);
  editor.currentStep.title = 'renamed';
  await editor.flushStep();
  assert.deepEqual(db.steps.get('a').textBlocks.map((b) => b.html), ['<p>AI</p>']);
  await editor.undo();
  assert.deepEqual(db.steps.get('a').textBlocks.map((b) => b.html), ['<p>old</p>']);
});

test('undoing a move keeps steps added since in place, and a move that cannot be restored is dropped', async () => {
  const { editor, db, toasts } = setup({ steps: three() });
  await editor.reload('c');
  await editor.moveSelectedStep(-1);
  assert.deepEqual(db.order, ['a', 'c', 'b']);
  // A live capture adds a step at the end after the move.
  db.steps.set('d', { stepId: 'd', revision: 1, annotations: [] });
  db.order.push('d');
  await editor.reload('c');
  await editor.undo();
  assert.deepEqual(db.order, ['a', 'b', 'c', 'd']);
  assert.equal(editor.canvasFuture.length, 1);

  // An outline record the store refuses is reported and dropped, so it can't block older undos.
  editor.pushCanvasHistory({ type: 'move-steps', order: ['a', 'b', 'c', 'd'], parents: { a: 'b' } });
  const before = editor.canvasHistory.length;
  await editor.undo();
  assert.equal(editor.canvasHistory.length, before - 1);
  assert.match(toasts.at(-1), /Could not undo the move/);
});

test('bulk paste measures images stored without a size, and a second paste adds no duplicates', async () => {
  const source = { id: 'ann-1', type: 'blur', x: 0.1, y: 0.2, w: 0.3, h: 0.05 };
  const zero = { size: { width: 0, height: 0 } };
  const { editor, db, api, toasts } = setup({
    steps: [
      { stepId: 'a', image: { size: { width: 1920, height: 1080 } }, annotations: [source] },
      { stepId: 'b', image: zero }, // an older import: no stored size, but a 16:9 file
      { stepId: 'c', image: zero }, // no stored size, and a square file
    ],
  });
  api.step.imagePath = async ({ stepId }) => ({ b: 'size:1600x900', c: 'size:500x500' })[stepId] || null;
  await editor.reload('a');
  editor.annotationClipboard = { ...source };
  editor.annotationClipboardAspect = 1920 / 1080;
  editor.selectedSteps = new Set(['a', 'b', 'c']);

  await editor.pasteAnnotationToSelectedSteps();
  assert.equal(db.steps.get('a').annotations.length, 1, 'the source already has it');
  assert.equal(db.steps.get('b').annotations.length, 1);
  assert.equal(db.steps.get('c').annotations.length, 0);
  assert.match(toasts.at(-1), /pasted onto 1 step\./);

  // Pasting again changes nothing: every step either has it or does not fit.
  await editor.pasteAnnotationToSelectedSteps();
  assert.equal(db.steps.get('b').annotations.length, 1);
  assert.match(toasts.at(-1), /No steps changed\./);
  assert.equal(editor.canvasHistory.length, 1);

  // Moving the source's copy away means the source step gets the paste too.
  db.steps.get('a').annotations[0].x = 0.5;
  await editor.reload('a');
  await editor.pasteAnnotationToSelectedSteps();
  assert.equal(db.steps.get('a').annotations.length, 2);
});

test('a move undo keeps a substep added since under its parent', async () => {
  // A, B; move B up; then add a substep under B: B, B-child, A.
  const { editor, db, toasts } = setup({ steps: [{ stepId: 'A' }, { stepId: 'B' }] });
  await editor.reload('B');
  await editor.moveSelectedStep(-1);
  assert.deepEqual(db.order, ['B', 'A']);
  db.steps.set('Bc', { stepId: 'Bc', parentStepId: 'B', revision: 1, annotations: [] });
  db.order = ['B', 'Bc', 'A'];
  await editor.reload('B');
  await editor.undo();
  assert.deepEqual(outline(db), ['A', 'B', 'Bc<B']);
  assert.equal(toasts.filter((t) => /Could not/.test(t)).length, 0);
  // ... and it can be redone.
  await editor.redo();
  assert.deepEqual(outline(db), ['B', 'Bc<B', 'A']);
});

test('a partly failed multi-step undo keeps the failed steps for a retry and the rest for redo', async () => {
  const rect = (id, color) => ({ id, type: 'rect', style: { stroke: color } });
  const { editor, db, api, toasts } = setup({ steps: [
    { stepId: 'A', annotations: [rect('a1', 'red'), rect('a2', 'blue')] },
    { stepId: 'B', annotations: [rect('b1', 'green')] },
  ] });
  await editor.reload('A');
  editor.canvas.selected = () => rect('a1', 'red');
  await editor.applyStyleAcross('guide');
  assert.equal(db.steps.get('B').annotations[0].style.stroke, 'red');

  // B's restore fails (a full disk, say); A's works.
  const save = api.step.save;
  api.step.save = async (args) => {
    if (args.step.stepId === 'B') throw new Error('ENOSPC');
    return save(args);
  };
  await editor.undo();
  assert.equal(db.steps.get('A').annotations[1].style.stroke, 'blue');
  assert.equal(db.steps.get('B').annotations[0].style.stroke, 'red');
  assert.match(toasts.at(-1), /Could not undo every step/);

  // Once the disk has room again, Ctrl+Z puts B back too.
  api.step.save = save;
  await editor.undo();
  assert.equal(db.steps.get('B').annotations[0].style.stroke, 'green');
  assert.equal(editor.canvasHistory.length, 0);
  // Both steps can be redone.
  await editor.redo();
  await editor.redo();
  assert.equal(db.steps.get('A').annotations[1].style.stroke, 'red');
  assert.equal(db.steps.get('B').annotations[0].style.stroke, 'red');
});

test('undo stops when the current step\'s pending edits cannot be saved', async () => {
  const { editor, db, api } = setup({ steps: three() });
  await editor.reload('b');
  await editor.moveSelectedStep(-1);
  editor.currentStep.title = 'typed, not saved yet';
  editor.pendingSave = true;
  const save = api.step.save;
  api.step.save = async () => { throw new Error('EIO'); };
  await editor.undo();
  assert.deepEqual(db.order, ['b', 'a', 'c'], 'nothing was undone');
  assert.equal(editor.currentStep.title, 'typed, not saved yet', 'the edit is still in the editor');
  assert.equal(editor.canvasHistory.length, 1);
  api.step.save = save;
  await editor.undo();
  assert.deepEqual(db.order, ['a', 'b', 'c']);
  assert.equal(db.steps.get('b').title, 'typed, not saved yet');
});
