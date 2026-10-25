'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isValidOutline } = require('../../core/step-outline');

/**
 * Moving steps in the editor (Alt+Up/Down, drag and drop, Move to…) always
 * carries a step's substeps and keeps the outline valid.
 */
function setup({ steps, pick = async () => null }) {
  const db = {
    order: steps.map((s) => s.stepId),
    steps: new Map(steps.map((s) => [s.stepId, { revision: 1, annotations: [], ...s }])),
  };
  const toasts = [];
  const dialogOptions = [];
  const api = {
    guide: { get: async () => ({ guide: { stepsOrder: db.order }, steps: db.order.map((id) => JSON.parse(JSON.stringify(db.steps.get(id)))) }) },
    step: {
      imagePath: async () => null,
      imageData: async () => null,
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
  const context = { setTimeout, window: { stepforge: api, StepForgeOutline: require('../../core/step-outline'), StepForgeDialogs: { showMoveStepDialog: (options) => { dialogOptions.push(options); return pick(options); } } }, document: { activeElement: null }, confirmDialog: async () => true, clearNode() {}, el() {} };
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
  // A step list of 30px rows from y=0, for the drag-and-drop handlers.
  editor.dom = {
    ...editor.dom,
    stepsList: {
      scrollTop: 0,
      children: [],
      getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
      querySelectorAll: () => editor.steps.map((_, i) => ({ getBoundingClientRect: () => ({ top: i * 30, height: 26 }) })),
    },
  };
  editor.hideStepDropLine = () => {};
  editor.showStepDropLine = (target) => { editor.lastDropLine = target; };
  return { editor, db, api, toasts, dialogOptions };
}
const outline = (db) => db.order.map((id) => `${id}${db.steps.get(id).parentStepId ? `<${db.steps.get(id).parentStepId}` : ''}`);
const nested = () => [{ stepId: 'A' }, { stepId: 'a1', parentStepId: 'A' }, { stepId: 'a2', parentStepId: 'A' }, { stepId: 'B' }, { stepId: 'b1', parentStepId: 'B' }, { stepId: 'C' }]
  .map((s) => ({ ...s, title: s.stepId }));

test('Alt+Down on a step with substeps moves the whole subtree past the next one', async () => {
  const { editor, db } = setup({ steps: nested() });
  await editor.reload('A');
  await editor.moveSelectedStep(1);
  assert.deepEqual(outline(db), ['B', 'b1<B', 'A', 'a1<A', 'a2<A', 'C']);
  assert.ok(isValidOutline(db.order, new Map(db.order.map((id) => [id, db.steps.get(id).parentStepId || null]))));
  assert.equal(editor.selectedStepId, 'A');
  assert.equal(editor.canvasHistory.length, 1);
  assert.equal(editor.canvasHistory[0].type, 'move-steps');
});

test('Alt+Up moves a step above the whole previous subtree', async () => {
  const { editor, db } = setup({ steps: nested() });
  await editor.reload('C');
  await editor.moveSelectedStep(-1);
  assert.deepEqual(outline(db), ['A', 'a1<A', 'a2<A', 'C', 'B', 'b1<B']);
});

test('a substep swaps with its sibling and keeps its parent', async () => {
  const { editor, db } = setup({ steps: nested() });
  await editor.reload('a1');
  await editor.moveSelectedStep(1);
  assert.deepEqual(outline(db), ['A', 'a2<A', 'a1<A', 'B', 'b1<B', 'C']);
});

test('the last substep moving down leaves its parent instead of stranding itself', async () => {
  const { editor, db } = setup({ steps: nested() });
  await editor.reload('a2');
  await editor.moveSelectedStep(1);
  // It lands right after B as B's first substep, so Alt+Up brings it straight back.
  assert.deepEqual(outline(db), ['A', 'a1<A', 'B', 'a2<B', 'b1<B', 'C']);
  await editor.undo();
  assert.deepEqual(outline(db), ['A', 'a1<A', 'a2<A', 'B', 'b1<B', 'C']);
});

test('moving at the end of the list does nothing and records nothing', async () => {
  const { editor, db } = setup({ steps: nested() });
  await editor.reload('A');
  await editor.moveSelectedStep(-1);
  await editor.reload('C');
  await editor.moveSelectedStep(1);
  assert.deepEqual(db.order, ['A', 'a1', 'a2', 'B', 'b1', 'C']);
  assert.equal(editor.canvasHistory.length, 0);
});

test('dragging a step drops its subtree at the gap, one undo step', async () => {
  const { editor, db } = setup({ steps: nested() });
  await editor.reload('A');
  // y=140 is the gap before C (row 5 starts at y=150, midpoint 163); x unchanged keeps the level.
  editor.onStepDragStart({ clientX: 50, dataTransfer: null }, 'A');
  let prevented = false;
  await editor.onStepDrop({ clientX: 50, clientY: 150, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.deepEqual(outline(db), ['B', 'b1<B', 'A', 'a1<A', 'a2<A', 'C']);
  assert.equal(editor.stepDrag, null);
  await editor.undo();
  assert.deepEqual(outline(db), ['A', 'a1<A', 'a2<A', 'B', 'b1<B', 'C']);
});

test('dragging sideways changes the level the step lands at', async () => {
  const { editor, db } = setup({ steps: [{ stepId: 'A' }, { stepId: 'B' }, { stepId: 'C' }] });
  await editor.reload('C');
  editor.onStepDragStart({ clientX: 100 }, 'C');
  // Same gap (the end), 20px to the right: one indent deeper, so C becomes B's substep.
  await editor.onStepDrop({ clientX: 120, clientY: 500, preventDefault() {} });
  assert.deepEqual(outline(db), ['A', 'B', 'C<B']);
});

test('dropping a step inside its own substeps is refused with a toast', async () => {
  const { editor, db, toasts } = setup({ steps: nested() });
  await editor.reload('A');
  editor.onStepDragStart({ clientX: 50 }, 'A');
  // y=50 is the gap between a1 and a2.
  assert.equal(editor.stepDropTarget(50, 50).moved, null);
  await editor.onStepDrop({ clientX: 50, clientY: 50, preventDefault() {} });
  assert.deepEqual(db.order, ['A', 'a1', 'a2', 'B', 'b1', 'C']);
  assert.equal(editor.canvasHistory.length, 0);
  assert.match(toasts.at(-1), /own substeps/);
});

test('step dragging is off in step-select mode', () => {
  const { editor } = setup({ steps: nested() });
  editor.stepSelectMode = true;
  let prevented = false;
  editor.onStepDragStart({ clientX: 0, preventDefault() { prevented = true; } }, 'A');
  assert.ok(prevented);
  assert.equal(editor.stepDrag, undefined);
});

test('dragover near the list edges scrolls the list', () => {
  const { editor } = setup({ steps: nested() });
  editor.onStepDragStart({ clientX: 0 }, 'A');
  editor.onStepDragOver({ clientX: 0, clientY: 5, preventDefault() {}, dataTransfer: null });
  assert.ok(editor.dom.stepsList.scrollTop < 0, 'scrolled up');
  editor.dom.stepsList.scrollTop = 0;
  editor.onStepDragOver({ clientX: 0, clientY: 595, preventDefault() {}, dataTransfer: null });
  assert.ok(editor.dom.stepsList.scrollTop > 0, 'scrolled down');
  editor.dom.stepsList.scrollTop = 0;
  editor.onStepDragOver({ clientX: 0, clientY: 300, preventDefault() {}, dataTransfer: null });
  assert.equal(editor.dom.stepsList.scrollTop, 0);
});

test('Move to… offers only places and levels that keep the outline valid, and applies the choice', async () => {
  const { editor, db, dialogOptions } = setup({
    steps: nested(),
    pick: async ({ positions }) => {
      const afterC = positions.find((p) => p.label.startsWith('After 3'));
      return { gap: afterC.value, depth: afterC.levels[0].value };
    },
  });
  await editor.reload('A');
  await editor.moveStepTo('A');
  const { positions } = dialogOptions[0];
  // Gaps inside A's own subtree (and the same spot after it) are not offered.
  assert.deepEqual([...positions.map((p) => p.label.replace(/\s+/g, ' '))], ['At the top', 'After 2 B', 'After 2.1 b1', 'After 3 C']);
  assert.equal(positions[0].current, true);
  // After B's substep b1 the step can be top level, a substep of B, or a substep of b1.
  assert.deepEqual([...positions[2].levels.map((l) => l.label.replace(/\s+/g, ' '))], ['Top level', 'Substep of 2 B', 'Substep of 2.1 b1']);
  assert.deepEqual(outline(db), ['B', 'b1<B', 'C', 'A', 'a1<A', 'a2<A']);
});

test('Move to… with Cancel changes nothing', async () => {
  const { editor, db } = setup({ steps: nested() });
  await editor.reload('A');
  await editor.moveStepTo('A');
  assert.deepEqual(db.order, ['A', 'a1', 'a2', 'B', 'b1', 'C']);
  assert.equal(editor.canvasHistory.length, 0);
});

test('a guide whose outline is already broken is repaired by the next move', async () => {
  const steps = [{ stepId: 'A' }, { stepId: 'B' }, { stepId: 'x', parentStepId: 'A' }, { stepId: 'C' }];
  const { editor, db } = setup({ steps });
  await editor.reload('C');
  // x names A but sits under B. The move flattens x and still succeeds.
  await editor.moveSelectedStep(-1);
  assert.deepEqual(outline(db), ['A', 'B', 'C', 'x']);
});

test('undoing a move that repaired a broken guide puts the order back and keeps it valid', async () => {
  const steps = [{ stepId: 'A' }, { stepId: 'B' }, { stepId: 'x', parentStepId: 'A' }, { stepId: 'C' }];
  const { editor, db, toasts } = setup({ steps });
  await editor.reload('C');
  await editor.moveSelectedStep(-1);
  assert.deepEqual(outline(db), ['A', 'B', 'C', 'x']);
  await editor.undo();
  assert.deepEqual(outline(db), ['A', 'B', 'x', 'C'], 'x stays flattened rather than broken again');
  assert.equal(toasts.filter((t) => /Could not/.test(t)).length, 0);
  await editor.redo();
  assert.deepEqual(outline(db), ['A', 'B', 'C', 'x']);
});

test('undoing a move keeps a substep added since under its parent', async () => {
  // [A, a1 under A, B]; move A down; then add b1 under B: [B, b1, A, a1].
  const { editor, db, toasts } = setup({ steps: [{ stepId: 'A' }, { stepId: 'a1', parentStepId: 'A' }, { stepId: 'B' }] });
  await editor.reload('A');
  await editor.moveSelectedStep(1);
  assert.deepEqual(outline(db), ['B', 'A', 'a1<A']);
  db.steps.set('b1', { stepId: 'b1', parentStepId: 'B', revision: 1, annotations: [] });
  db.order = ['B', 'b1', 'A', 'a1'];
  await editor.reload('A');
  await editor.undo();
  assert.deepEqual(outline(db), ['A', 'a1<A', 'B', 'b1<B'], 'b1 stays a substep of B');
  assert.equal(toasts.filter((t) => /Could not/.test(t)).length, 0);
});

test('Move to… plans again on the outline as it is when the dialog closes', async () => {
  const steps = ['A', 'B', 'C', 'D'].map((id) => ({ stepId: id, title: id }));
  let agent;
  const { editor, db } = setup({
    steps,
    pick: async ({ positions }) => {
      // While the dialog is open an agent nests B under A, and the editor reloads.
      await agent();
      return { gap: positions.find((p) => p.label === 'At the top').value, depth: '0' };
    },
  });
  agent = async () => {
    db.steps.get('B').parentStepId = 'A';
    await editor.reload('D');
  };
  await editor.reload('D');
  await editor.moveStepTo('D');
  assert.deepEqual(outline(db), ['D', 'A', 'B<A', 'C'], "the agent's nesting survives the move");
});

test('Move to… does nothing when the place it was going to is gone', async () => {
  const steps = ['A', 'B', 'C'].map((id) => ({ stepId: id, title: id }));
  const { editor, db, toasts } = setup({
    steps,
    pick: async ({ positions }) => {
      // The step it should follow is deleted while the dialog is open.
      db.order = ['A', 'C'];
      db.steps.delete('B');
      await editor.reload('C');
      return { gap: positions.find((p) => p.label.includes('B')).value, depth: '0' };
    },
  });
  await editor.reload('A');
  await editor.moveStepTo('A');
  assert.deepEqual(db.order, ['A', 'C']);
  assert.match(toasts.at(-1), /guide changed/);
});
