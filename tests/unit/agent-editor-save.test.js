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
  beforeRemoval.title = 'User kept typing';
  beforeRemoval.redaction = { checked: 'check-of-the-old-image' };
  await call('remove_screenshot');
  const removed = saveStepFromEditor(store, guideId, beforeRemoval);
  assert.equal(removed.title, 'User kept typing');
  assert.equal(removed.image, null, 'a text save cannot recreate the removed screenshot');
  assert.equal(removed.kind, 'content');
  assert.deepEqual(removed.annotations, []);
  assert.equal(removed.redaction, null);
  assert.equal(store.stepImagePath(guideId, a.stepId), null);

  const beforeAddition = store.getStep(guideId, a.stepId);
  beforeAddition.title = 'Typed while an image was added';
  await call('set_screenshot', { image_path: png });
  const added = saveStepFromEditor(store, guideId, beforeAddition);
  assert.equal(added.title, beforeAddition.title);
  assert.equal(added.kind, 'image');
  assert.deepEqual(added.image.size, { width: 40, height: 30 });

  const beforeReplacement = store.getStep(guideId, a.stepId);
  beforeReplacement.title = 'Typed during replacement';
  beforeReplacement.annotations = [{ id: 'old', type: 'rect', x: 0, y: 0, w: 1, h: 1 }];
  beforeReplacement.redaction = { checked: 'stale-check' };
  fs.writeFileSync(png, TINY_PNG);
  await call('set_screenshot', { image_path: png });
  const replacement = store.getStep(guideId, a.stepId);
  const saved = saveStepFromEditor(store, guideId, beforeReplacement);
  assert.equal(saved.title, beforeReplacement.title);
  assert.deepEqual(saved.image, replacement.image, 'keep new dimensions and paths');
  assert.deepEqual(saved.annotations, replacement.annotations, 'do not restore annotations for the old geometry');
  assert.deepEqual(saved.redaction, replacement.redaction, 'do not restore a check for the old pixels');
  assert.deepEqual(saved.image.size, { width: 1, height: 1 });
});
