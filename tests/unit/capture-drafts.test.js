'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GuideStore } = require('../../core/store');
const { SearchIndex } = require('../../core/search');
const { makeTmpDir, rmrf } = require('./helpers');

function setup(t) {
  const root = makeTmpDir('capture-drafts');
  t.after(() => rmrf(root));
  return { root, store: new GuideStore(root) };
}

test('untouched captures remain accessible as drafts but absent from the library after restart', t => {
  const { root, store } = setup(t);
  const draft = store.createGuide({ title: 'Untitled capture' }, { captureDraft: true });
  store.saveGuide(draft);
  const emptyMarkup = store.getGuide(draft.guideId);
  emptyMarkup.descriptionHtml = '<p><br></p>';
  store.saveGuide(emptyMarkup);
  const reopened = new GuideStore(root);
  assert.equal(reopened.getGuide(draft.guideId).title, 'Untitled capture');
  assert.deepEqual(reopened.listGuides(), []);
  assert.equal(reopened.isCaptureDraft(reopened.getGuide(draft.guideId)), true);
});

test('any meaningful guide edit permanently publishes a capture draft', t => {
  const { store } = setup(t);
  const edits = [
    g => { g.title = 'My workflow'; },
    g => { g.descriptionHtml = '<p>Instructions</p>'; },
    g => { g.metadata.author = 'Tyler'; },
    g => { g.placeholders.Team = 'Support'; },
    g => { g.favorite = true; },
    g => { g.flags.focusedViewDefault = true; },
    g => { g.exportProfiles.html = { title: 'Custom' }; },
  ];
  for (const edit of edits) {
    const original = store.createGuide({ title: 'Untitled capture' }, { captureDraft: true });
    const changed = store.getGuide(original.guideId);
    edit(changed);
    store.saveGuide(changed);
    assert.ok(store.listGuides().some(g => g.guideId === original.guideId));
    store.saveGuide({ ...original });
    assert.equal(store.isCaptureDraft(store.getGuide(original.guideId)), false, 'undoing content must not hide a published guide');
  }
});

test('adding a step publishes a draft and deleting the last step does not hide it', t => {
  const { store } = setup(t);
  const draft = store.createGuide({ title: 'Untitled capture' }, { captureDraft: true });
  const step = store.addStep(draft.guideId, { kind: 'content', title: 'First step' });
  assert.equal(store.listGuides().length, 1);
  store.deleteStep(draft.guideId, step.stepId);
  assert.equal(store.listGuides().length, 1);
});

test('ordinary empty guides are preserved even with the automatic capture title', t => {
  const { store } = setup(t);
  store.createGuide({ title: 'Untitled capture' });
  store.createGuide({ title: 'Named guide' });
  store.createGuide();
  assert.equal(store.listGuides().length, 3);
});

test('search reconciliation removes untouched drafts and indexes them after publication', t => {
  const { store } = setup(t);
  const draft = store.createGuide({ title: 'UniqueDraftTitle' }, { captureDraft: true });
  const index = new SearchIndex(store.indexDir);
  index.indexGuide(draft, []);
  index.reconcile(store);
  assert.equal(index.search('UniqueDraftTitle').length, 0);
  draft.descriptionHtml = '<p>Actual content</p>';
  store.saveGuide(draft);
  index.reconcile(store);
  assert.ok(index.search('UniqueDraftTitle').length > 0);
});

test('filing a draft in a folder publishes it', t => {
  const { store } = setup(t);
  const draft = store.createGuide({}, { captureDraft: true });
  const folder = store.createFolder('Work');
  store.moveGuideToFolder(draft.guideId, folder.id);
  assert.equal(store.listGuides().length, 1);
});

test('navigation waits for pending edits and refreshes the library after draft publication', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const context = { window: {}, document: { addEventListener() {} } };
  const source = fs.readFileSync(path.join(__dirname, '../../app/renderer/app.js'), 'utf8');
  vm.runInNewContext(source.replace('\nboot();', '\n'), context);
  const app = Object.create(context.window.StepForgeApp.prototype);
  const events = [];
  app.editor = {
    pendingGuideSave: true,
    async saveAll() { await Promise.resolve(); events.push('save'); this.pendingGuideSave = false; },
    setActive() { events.push('deactivate'); },
  };
  app.setView = () => {};
  app.refreshData = async () => { events.push('refresh'); };
  app.renderLibrary = () => { events.push('render'); };
  await app.showLibrary();
  assert.deepEqual(events, ['save', 'deactivate', 'refresh', 'render']);
  events.length = 0;
  app.editor.pendingGuideSave = true;
  app.editor.saveAll = async () => { events.push('failed save'); };
  await app.showLibrary();
  assert.deepEqual(events, ['failed save'], 'stay in the editor when content has not been saved');
});
