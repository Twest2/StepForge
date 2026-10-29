'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { GuideStore } = require('../../core/store');
const { saveGuideFromEditor, saveStepFromEditor } = require('../../core/editor-save');
const { makeTmpDir, rmrf, rendererI18n, TINY_PNG } = require('./helpers');
const { Settings } = require('../../core/settings');
const { createAgentTools } = require('../../core/agent-tools');
const { encodePng } = require('../../core/png');
const { createImage } = require('../../core/raster');

function library(t) {
  const root = makeTmpDir('agent-editor');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'Guide' });
  const a = store.addStep(guide.guideId, { title: 'A' });
  const b = store.addStep(guide.guideId, { title: 'B' });
  return { store, guideId: guide.guideId, a, b };
}

test('saving stale guide details preserves steps added, moved and deleted outside the editor', (t) => {
  const { store, guideId, a, b } = library(t);
  const stale = store.getGuide(guideId);
  const baseline = structuredClone(stale);
  const c = store.addStep(guideId, { title: 'C' });
  store.reorderSteps(guideId, [c.stepId, b.stepId, a.stepId]);
  store.deleteStep(guideId, a.stepId);
  stale.title = 'User typed title';
  const revision = store.getGuide(guideId).revision;
  const saved = saveGuideFromEditor(store, stale, baseline);
  assert.equal(saved.revision, revision + 1);
  assert.equal(saved.title, 'User typed title');
  assert.deepEqual(saved.stepsOrder, [c.stepId, b.stepId]);
});

test('a late editor save cannot recreate a deleted step or a trashed guide', (t) => {
  const { store, guideId, a } = library(t);
  const guide = store.getGuide(guideId);
  store.deleteStep(guideId, a.stepId);
  assert.throws(() => saveStepFromEditor(store, guideId, a), /step was deleted/);
  assert.equal(fs.existsSync(store.stepDir(guideId, a.stepId)), false);
  store.deleteGuide(guideId);
  assert.throws(() => saveStepFromEditor(store, guideId, a), /Trash/);
  assert.throws(() => saveGuideFromEditor(store, guide), /Trash/);
  assert.equal(store.guideExists(guideId), false);
});

test('agent reload cancels an unsaved deleted step rather than saving it onto another step', async () => {
  const context = { ...(rendererI18n ? rendererI18n() : {}), window: { stepforge: { guide: { get: async () => ({ guide: { stepsOrder: ['remaining'] } }) } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const editor = Object.create(context.window.GuideEditor.prototype);
  let cancelled = false, reloaded = false;
  Object.assign(editor, { guideId: 'g', selectedStepId: 'deleted', pendingSave: true,
    saveStepDebounced: { cancel() { cancelled = true; } },
    flushStep() { assert.fail('must not save a deleted step'); },
    onToast() {}, reload: async () => { reloaded = true; } });
  await editor.reloadAfterOutsideChange();
  assert.equal(cancelled, true);
  assert.equal(editor.pendingSave, false);
  assert.equal(reloaded, true);
});


test('a dirty step save preserves the parent changed by an agent move or deletion', (t) => {
  const { store, guideId, a, b } = library(t);
  store.reorderSteps(guideId, [a.stepId, b.stepId], { [b.stepId]: a.stepId });
  const dirty = store.getStep(guideId, b.stepId);
  const baseline = structuredClone(dirty);
  dirty.title = 'Unsaved user text';
  store.deleteStep(guideId, a.stepId);
  const revision = store.getStep(guideId, b.stepId).revision;
  const saved = saveStepFromEditor(store, guideId, dirty, baseline);
  assert.equal(saved.revision, revision + 1);
  assert.equal(saved.title, 'Unsaved user text');
  assert.equal(saved.parentStepId, null, 'do not restore a deleted parent');
});


test('stale text saves preserve screenshots removed, replaced or added by an agent', async (t) => {
  const { store, guideId, a } = library(t);
  const dir = makeTmpDir('agent-editor-image');
  t.after(() => rmrf(dir));
  const png = path.join(dir, 'replacement.png');
  fs.writeFileSync(png, encodePng(createImage(40, 30, [0, 128, 0, 255])));
  const settings = new Settings(store.settingsDir);
  settings.set('ai.agents', { enabled: true });
  const tools = createAgentTools({ store, agentSettings: () => settings.get('ai.agents') });
  const call = (name, args = {}) => tools.find((tool) => tool.name === name).handler({ guide_id: guideId, step_id: a.stepId, ...args });
  store.replaceImages(guideId, a.stepId, { original: TINY_PNG }, { width: 1, height: 1 });

  const beforeRemoval = store.getStep(guideId, a.stepId);
  const removalBase = structuredClone(beforeRemoval);
  beforeRemoval.title = 'User kept typing';
  beforeRemoval.redaction = { checked: 'check-of-the-old-image' };
  await call('remove_screenshot');
  const removed = saveStepFromEditor(store, guideId, beforeRemoval, removalBase);
  assert.equal(removed.title, 'User kept typing');
  assert.equal(removed.image, null, 'a text save cannot recreate the removed screenshot');
  assert.equal(removed.kind, 'content');
  assert.deepEqual(removed.annotations, []);
  assert.equal(removed.redaction, null);
  assert.equal(store.stepImagePath(guideId, a.stepId), null);

  const beforeAddition = store.getStep(guideId, a.stepId);
  const additionBase = structuredClone(beforeAddition);
  beforeAddition.title = 'Typed while an image was added';
  await call('set_screenshot', { image_path: png });
  const added = saveStepFromEditor(store, guideId, beforeAddition, additionBase);
  assert.equal(added.title, beforeAddition.title);
  assert.equal(added.kind, 'image');
  assert.deepEqual(added.image.size, { width: 40, height: 30 });

  const beforeReplacement = store.getStep(guideId, a.stepId);
  const replacementBase = structuredClone(beforeReplacement);
  beforeReplacement.title = 'Typed during replacement';
  beforeReplacement.annotations = [{ id: 'old', type: 'rect', x: 0, y: 0, w: 1, h: 1 }];
  beforeReplacement.redaction = { checked: 'stale-check' };
  fs.writeFileSync(png, TINY_PNG);
  await call('set_screenshot', { image_path: png });
  const replacement = store.getStep(guideId, a.stepId);
  const saved = saveStepFromEditor(store, guideId, beforeReplacement, replacementBase);
  assert.equal(saved.title, beforeReplacement.title);
  assert.deepEqual(saved.image, replacement.image, 'keep new dimensions and paths');
  assert.deepEqual(saved.annotations, replacement.annotations, 'do not restore annotations for the old geometry');
  assert.deepEqual(saved.redaction, replacement.redaction, 'do not restore a check for the old pixels');
  assert.deepEqual(saved.image.size, { width: 1, height: 1 });
});


test('three-way editor saves keep agent block deletions and new annotations alongside local text', async (t) => {
  const { store, guideId, a } = library(t);
  store.replaceImages(guideId, a.stepId, { original: TINY_PNG }, { width: 1, height: 1 });
  let step = store.getStep(guideId, a.stepId);
  step.textBlocks = [{ id: 'delete-me', order: 1, title: 'Gone' }, { id: 'keep-me', order: 2, title: 'Original' }];
  step.codeBlocks = [{ id: 'code', order: 3, code: 'old' }];
  step.tableBlocks = [{ id: 'table', order: 4, rows: [['old']] }];
  step = store.saveStep(guideId, step);
  const baseline = structuredClone(step);
  const local = structuredClone(step);
  local.title = 'Unsaved user title';
  local.textBlocks[1].title = 'User changed this block';
  const external = structuredClone(step);
  external.textBlocks = external.textBlocks.filter((b) => b.id !== 'delete-me');
  external.codeBlocks = [];
  external.tableBlocks = [];
  external.annotations = [{ id: 'new', type: 'blur', x: 0, y: 0, w: .5, h: 1 }];
  store.saveStep(guideId, external);

  const api = { step: { save: async ({ step, baseStep }) => saveStepFromEditor(store, guideId, step, baseStep) } };
  const context = { ...(rendererI18n ? rendererI18n() : {}), window: { stepforge: api } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const editor = Object.create(context.window.GuideEditor.prototype);
  Object.assign(editor, { guideId, selectedStepId: null, steps: [local], stepMap: new Map([[a.stepId, local]]),
    savedStepBaselines: new Map([[a.stepId, baseline]]), pendingSave: true,
    onToast: (message) => assert.fail(message), emitMeta() {}, renderAll() {} });
  const saved = await editor.flushStep(local);
  assert.equal(saved.title, local.title);
  assert.deepEqual(saved.textBlocks.map((b) => [b.id, b.title]), [['keep-me', 'User changed this block']]);
  assert.deepEqual(saved.codeBlocks, []);
  assert.deepEqual(saved.tableBlocks, []);
  assert.deepEqual(saved.annotations.map((a) => a.id), ['new']);
  assert.deepEqual(editor.stepMap.get(a.stepId).textBlocks.map((b) => b.id), ['keep-me'], 'live blocks adopt the merged result');
  assert.equal(editor.savedStepBaselines.get(a.stepId).revision, saved.revision);
});

test('a stale editor save without a baseline refuses rather than losing external changes', (t) => {
  const { store, guideId, a } = library(t);
  const local = store.getStep(guideId, a.stepId);
  store.saveStep(guideId, { ...local, title: 'Agent title' });
  assert.throws(() => saveStepFromEditor(store, guideId, { ...local, title: 'Local title' }), /unsaved edits are kept/);
  assert.equal(store.getStep(guideId, a.stepId).title, 'Agent title');
});

test('late image and background saves cannot recreate files after a guide moves to Trash', (t) => {
  const { store, guideId, a } = library(t);
  store.replaceImages(guideId, a.stepId, { original: TINY_PNG }, { width: 1, height: 1 });
  const stale = store.getStep(guideId, a.stepId);
  store.deleteGuide(guideId);
  for (const lateWrite of [
    () => store.saveStep(guideId, stale),
    () => store.replaceImages(guideId, a.stepId, { original: TINY_PNG }, { width: 1, height: 1 }, stale),
    () => store.setWorkingImage(guideId, a.stepId, TINY_PNG, { width: 1, height: 1 }, stale),
    () => store.addStep(guideId, {}, TINY_PNG, { width: 1, height: 1 }),
    () => store.restoreStep(guideId, stale, { original: TINY_PNG }, 0),
  ]) assert.throws(lateWrite, /ENOENT/);
  assert.equal(fs.existsSync(store.guideDir(guideId)), false, 'no ghost guide directory blocks restoration');
  const [trashed] = store.listTrash();
  assert.equal(store.restoreFromTrash(trashed), guideId);
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guideId, a.stepId)), TINY_PNG);
});


test('undoing a saved edit uses the current revision and remains available after baseline-aware saving', async (t) => {
  const { store, guideId, a } = library(t);
  const before = store.getStep(guideId, a.stepId);
  const current = saveStepFromEditor(store, guideId, { ...before, title: 'Saved user edit' });
  const priorRevision = current.revision;
  const api = { step: { save: async ({ step, baseStep }) => saveStepFromEditor(store, guideId, step, baseStep) } };
  const context = { ...(rendererI18n ? rendererI18n() : {}), document: { activeElement: null }, window: { stepforge: api } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const editor = Object.create(context.window.GuideEditor.prototype);
  Object.assign(editor, { guideId, steps: [current], stepMap: new Map([[a.stepId, current]]),
    savedStepBaselines: new Map([[a.stepId, structuredClone(current)]]),
    saveStepDebounced: { cancel() {} }, onToast: (message) => assert.fail(message),
    emitMeta() {}, renderAll() {}, renderStepList() {}, syncStepFields() {}, renderAnnotationPanel() {},
    canvas: { setAnnotations() {} }, dom: { annotationEditor: { contains: () => false } } });
  await editor.restoreHistoryRecord({ step: before });
  assert.equal(store.getStep(guideId, a.stepId).title, before.title);
  assert.equal(store.getStep(guideId, a.stepId).revision, priorRevision + 1);
});


test('guide autosaves combine an unsaved description with an external title and reject unknown stale baselines', async (t) => {
  const { store, guideId } = library(t);
  const baseline = store.getGuide(guideId);
  const local = { ...structuredClone(baseline), descriptionHtml: '<p>Unsaved user introduction</p>' };
  store.saveGuide({ ...baseline, title: 'Agent title' });
  const api = { guide: { save: async ({ guide, baseGuide }) => saveGuideFromEditor(store, guide, baseGuide) } };
  const context = { ...(rendererI18n ? rendererI18n() : {}), window: { stepforge: api } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const editor = Object.create(context.window.GuideEditor.prototype);
  Object.assign(editor, { guide: local, savedGuideBaseline: baseline, pendingGuideSave: true,
    onToast: (message) => assert.fail(message), emitMeta() {} });
  await editor.flushGuide();
  assert.equal(editor.pendingGuideSave, false);
  assert.equal(editor.guide.title, 'Agent title');
  assert.equal(editor.guide.descriptionHtml, local.descriptionHtml);
  assert.equal(editor.savedGuideBaseline.revision, store.getGuide(guideId).revision);
  assert.throws(() => saveGuideFromEditor(store, { ...baseline, title: 'Another stale title' }), /unsaved edits are kept/);
  assert.equal(store.getGuide(guideId).title, 'Agent title');
});
