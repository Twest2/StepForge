'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * The editor during a linked save that merges another session's changes:
 * edits made while the archive is written must survive the reload, and must
 * not be saved over the merge from the editor's older copy.
 */
function setup(steps) {
  const json = (v) => JSON.parse(JSON.stringify(v));
  const db = {
    guide: { guideId: 'g1', title: 'Guide', stepsOrder: steps.map((s) => s.stepId), linkedSource: { path: '/team.sfgz' } },
    steps: new Map(steps.map((s) => [s.stepId, { revision: 1, annotations: [], ...s }])),
  };
  const saves = [];
  const api = {
    guide: {
      get: async () => ({ guide: json(db.guide), steps: db.guide.stepsOrder.map((id) => json(db.steps.get(id))) }),
      save: async ({ guide }) => { db.guide = json(guide); return json(guide); },
    },
    step: {
      save: async ({ step }) => {
        saves.push(json(step));
        const saved = { ...json(step), revision: db.steps.get(step.stepId).revision + 1 };
        db.steps.set(step.stepId, saved);
        return json(saved);
      },
    },
    archive: {},
  };
  const context = { window: { stepforge: api }, document: { activeElement: null }, confirmDialog: async () => true, clearNode() {}, el() {}, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const editor = Object.create(context.window.GuideEditor.prototype);
  const toasts = [];
  let timer = null;
  Object.assign(editor, {
    guideId: 'g1', canvasHistory: [], canvasFuture: [], pendingSave: false, pendingGuideSave: false, steps: [], stepMap: new Map(),
    linkedSaveInFlight: null,
    onToast: (text) => toasts.push(text), renderAll() {}, renderStepList() {}, emitMeta() {},
    // The real autosave, shortened.
    saveStepDebounced: Object.assign(() => { clearTimeout(timer); timer = setTimeout(() => editor.flushStep(), 5); }, { cancel() { clearTimeout(timer); } }),
    saveGuideDebounced: Object.assign(() => setTimeout(() => editor.flushGuide(), 5), { cancel() {} }),
    canvas: { setAnnotations() {}, select() {}, selected: () => null },
    syncStepFields() {}, renderAnnotationPanel() {}, dom: { annotationEditor: { contains: () => false } },
    reload: async (stepId) => {
      const { guide, steps: fresh } = await api.guide.get();
      editor.guide = guide;
      editor.steps = fresh;
      editor.stepMap = new Map(fresh.map((s) => [s.stepId, s]));
      editor.selectedStepId = stepId && editor.stepMap.has(stepId) ? stepId : (editor.selectedStepId || fresh[0].stepId);
    },
  });
  return { editor, db, api, toasts, saves };
}

test('edits made while a merged linked save is written are kept, and the merge is not undone', async () => {
  const { editor, db, api, toasts } = setup([
    { stepId: 'a', title: 'Old title', descriptionHtml: '<p>a</p>' },
    { stepId: 'b', title: 'B', descriptionHtml: '<p>b</p>' },
  ]);
  await editor.reload('a');
  api.archive.saveLinked = async () => {
    // Main merges another session's changes into the library copy first...
    db.steps.set('a', { ...db.steps.get('a'), descriptionHtml: '<p>a from the other session</p>', revision: 9 });
    db.steps.set('b', { ...db.steps.get('b'), title: 'B from the other session', revision: 9 });
    db.guide = { ...db.guide, title: 'Guide from the other session' };
    // ...and while the archive is written, the person retitles step a, and
    // its autosave comes due before the write finishes.
    editor.currentStep.title = 'New title';
    editor.pendingSave = true;
    editor.saveStepDebounced();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { saved: true, merged: true, conflicts: 0 };
  };
  await editor.saveAll();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(db.steps.get('a').title, 'New title', 'the edit made during the save is kept');
  assert.equal(db.steps.get('a').descriptionHtml, '<p>a from the other session</p>', 'the merge in the same step is kept');
  assert.equal(db.steps.get('b').title, 'B from the other session');
  assert.equal(db.guide.title, 'Guide from the other session');
  assert.equal(editor.currentStep.title, 'New title');
  assert.match(toasts.at(-1), /Merged changes from another session/);
});

test('a guide title typed during a merged linked save is kept too', async () => {
  const { editor, db, api } = setup([{ stepId: 'a', title: 'A' }]);
  await editor.reload('a');
  api.archive.saveLinked = async () => {
    db.guide = { ...db.guide, description: 'from the other session' };
    editor.guide.title = 'Typed meanwhile';
    editor.pendingGuideSave = true;
    return { saved: true, merged: true, conflicts: 0 };
  };
  await editor.runLinkedSave();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(db.guide.title, 'Typed meanwhile');
  assert.equal(db.guide.description, 'from the other session');
});

test('a title typed just before a merged save finishes is not lost to the reload', async () => {
  const { editor, db, api } = setup([{ stepId: 'a', title: 'Old title' }, { stepId: 'b', title: 'B' }]);
  await editor.reload('a');
  api.archive.saveLinked = async () => {
    db.steps.set('b', { ...db.steps.get('b'), title: 'B from the other session', revision: 9 });
    // Typed right before the write completes: the autosave is still waiting.
    editor.currentStep.title = 'New title';
    editor.pendingSave = true;
    editor.saveStepDebounced();
    return { saved: true, merged: true, conflicts: 0 };
  };
  await editor.saveAll();
  assert.equal(editor.currentStep.title, 'New title', 'still on screen after the reload');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(db.steps.get('a').title, 'New title');
  assert.equal(db.steps.get('b').title, 'B from the other session');
});
