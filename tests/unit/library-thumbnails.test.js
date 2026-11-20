'use strict';

// Library cards show a step's screenshot; a guide file on the command line opens straight away.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const { GuideStore } = require('../../core/store');
const { exportGuideArchive, importGuideArchive, archiveArgument } = require('../../core/archive');
const { makeTmpDir, rmrf, TINY_PNG, rendererI18n } = require('./helpers');

const png = Buffer.from(TINY_PNG, 'base64');

/** The editor's pick (its step menu marks this step "current"). */
function editorPick(guide, steps) {
  const context = { ...rendererI18n(), window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/editor.js'), 'utf8'), context);
  const editor = Object.create(context.window.GuideEditor.prototype);
  Object.assign(editor, { guide, steps });
  return editor.thumbnailStepId();
}

test('a card shows the chosen step, else the first shown step with a screenshot, else the first with one', (t) => {
  const root = makeTmpDir('thumbs');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const { guideId } = store.createGuide({ title: 'Guide' });
  const text = store.addStep(guideId, { title: 'Text only' });
  const hidden = store.addStep(guideId, { title: 'Hidden', hidden: true }, png);
  const shown = store.addStep(guideId, { title: 'Shown' }, png);
  const later = store.addStep(guideId, { title: 'Later' }, png);
  const file = (step) => store.stepImagePath(guideId, step.stepId);
  const pick = () => store.thumbnailSource(store.getGuide(guideId))?.file;
  const steps = () => store.getGuide(guideId).stepsOrder.map((id) => store.getStep(guideId, id));

  assert.equal(pick(), file(shown));
  assert.equal(editorPick(store.getGuide(guideId), steps()), shown.stepId);

  // Use as library thumbnail is kept in guide.json.
  store.saveGuide({ ...store.getGuide(guideId), thumbnailStepId: later.stepId });
  assert.equal(store.getGuide(guideId).thumbnailStepId, later.stepId);
  assert.equal(pick(), file(later));
  assert.equal(editorPick(store.getGuide(guideId), steps()), later.stepId);

  // A chosen step without a screenshot, or deleted, falls back to the default.
  store.saveGuide({ ...store.getGuide(guideId), thumbnailStepId: text.stepId });
  assert.equal(pick(), file(shown));
  assert.equal(editorPick(store.getGuide(guideId), steps()), shown.stepId);
  store.saveGuide({ ...store.getGuide(guideId), thumbnailStepId: later.stepId });
  store.deleteStep(guideId, later.stepId);
  assert.equal(pick(), file(shown));

  store.saveStep(guideId, { ...store.getStep(guideId, shown.stepId), hidden: true });
  assert.equal(pick(), file(hidden), 'all hidden: the first screenshot');
  assert.equal(store.thumbnailSource(store.createGuide({ title: 'Empty' })), null);
});

test('the chosen thumbnail follows a duplicated or imported copy to its new step ids', (t) => {
  const root = makeTmpDir('thumbcopy');
  t.after(() => rmrf(root));
  const store = new GuideStore(path.join(root, 'data'));
  const { guideId } = store.createGuide({ title: 'Guide' });
  store.addStep(guideId, { title: 'One' }, png);
  const two = store.addStep(guideId, { title: 'Two' }, png);
  store.saveGuide({ ...store.getGuide(guideId), thumbnailStepId: two.stepId });

  const chosenTitle = (guide) => store.getStep(guide.guideId, guide.thumbnailStepId).title;
  assert.equal(chosenTitle(store.duplicateGuide(guideId)), 'Two');
  const file = path.join(root, 'guide.sfgz');
  exportGuideArchive(store, guideId, file);
  const copy = importGuideArchive(store, file, { mode: 'copy' });
  assert.notEqual(copy.thumbnailStepId, two.stepId);
  assert.equal(chosenTitle(store.getGuide(copy.guideId)), 'Two');
});

test('a guide file on the command line is found as a path or a file:// URI', (t) => {
  const root = makeTmpDir('launcharg');
  t.after(() => rmrf(root));
  const file = path.join(root, 'My guide.SFGZ');
  fs.writeFileSync(file, 'x');
  assert.equal(archiveArgument(['stepforge', file], '/'), file);
  assert.equal(archiveArgument(['electron', '.', '--flag', pathToFileURL(file).href], '/'), file);
  assert.equal(archiveArgument(['stepforge', 'My guide.SFGZ'], root), file, 'relative to the working folder');
  assert.equal(archiveArgument([file], '/'), null, 'the program itself is not an argument');
  assert.equal(archiveArgument(['stepforge', path.join(root, 'missing.sfgz')], '/'), null);
  assert.equal(archiveArgument(['stepforge', '.'], root), null);
});
