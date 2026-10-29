'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { GuideStore } = require('../../core/store');
const { saveGuideFromEditor, saveStepFromEditor } = require('../../core/editor-save');
const { makeTmpDir, rmrf, rendererI18n } = require('./helpers');

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
  const c = store.addStep(guideId, { title: 'C' });
  store.reorderSteps(guideId, [c.stepId, b.stepId, a.stepId]);
  store.deleteStep(guideId, a.stepId);
  stale.title = 'User typed title';
  const revision = store.getGuide(guideId).revision;
  const saved = saveGuideFromEditor(store, stale);
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
  dirty.title = 'Unsaved user text';
  store.deleteStep(guideId, a.stepId);
  const revision = store.getStep(guideId, b.stepId).revision;
  const saved = saveStepFromEditor(store, guideId, dirty);
  assert.equal(saved.revision, revision + 1);
  assert.equal(saved.title, 'Unsaved user text');
  assert.equal(saved.parentStepId, null, 'do not restore a deleted parent');
});
