'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { GuideStore } = require('../../core/store');
const { makeTmpDir, rmrf, TINY_PNG } = require('./helpers');

test('create a guide, add image steps, and reload everything from disk', (t) => {
  const root = makeTmpDir('store');
  t.after(() => rmrf(root));

  const store = new GuideStore(root);
  const guide = store.createGuide({
    title: 'Reset a password',
    descriptionHtml: '<p>How to reset a <strong>user</strong> password.</p>',
    placeholders: { Department: 'IT' },
  });

  const s1 = store.addStep(guide.guideId, { title: 'Open the admin portal' }, TINY_PNG, { width: 1, height: 1 });
  const s2 = store.addStep(guide.guideId, {
    title: 'Click Users',
    descriptionHtml: '<p>In the left nav.</p>',
    annotations: [{ type: 'arrow', x: 0.1, y: 0.2, w: 0.3, h: 0.1 }],
  }, TINY_PNG, { width: 1, height: 1 });
  const sub = store.addStep(guide.guideId, { kind: 'empty', title: 'Note', parentStepId: s2.stepId });

  // A brand-new store instance must see exactly what was written.
  const fresh = new GuideStore(root);
  const loaded = fresh.getGuide(guide.guideId);
  assert.equal(loaded.title, 'Reset a password');
  assert.equal(loaded.placeholders.Department, 'IT');
  assert.deepEqual(loaded.stepsOrder, [s1.stepId, s2.stepId, sub.stepId]);

  const steps = fresh.listSteps(guide.guideId);
  assert.equal(steps.size, 3);
  assert.equal(steps.get(s2.stepId).annotations.length, 1);
  assert.equal(steps.get(s2.stepId).annotations[0].type, 'arrow');
  assert.equal(steps.get(sub.stepId).parentStepId, s2.stepId);
  assert.equal(steps.get(sub.stepId).kind, 'empty');

  // Image files exist and original equals what was captured.
  const imgPath = fresh.stepImagePath(guide.guideId, s1.stepId, 'original');
  assert.deepEqual(fs.readFileSync(imgPath), TINY_PNG);
});

test('step reorder, delete with substep reparenting, and order integrity', (t) => {
  const root = makeTmpDir('reorder');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'Order test' });
  const a = store.addStep(guide.guideId, { kind: 'empty', title: 'A' });
  const b = store.addStep(guide.guideId, { kind: 'empty', title: 'B' });
  const c = store.addStep(guide.guideId, { kind: 'empty', title: 'C', parentStepId: b.stepId });

  store.reorderSteps(guide.guideId, [b.stepId, c.stepId, a.stepId]);
  assert.deepEqual(store.getGuide(guide.guideId).stepsOrder, [b.stepId, c.stepId, a.stepId]);

  // Reorder must reject losing or inventing steps.
  assert.throws(() => store.reorderSteps(guide.guideId, [a.stepId]));
  assert.throws(() => store.reorderSteps(guide.guideId, [a.stepId, b.stepId, 'step-bogus']));

  // Deleting B reparents its substep C to top level and drops B from order.
  store.deleteStep(guide.guideId, b.stepId);
  const after = store.getGuide(guide.guideId);
  assert.deepEqual(after.stepsOrder, [c.stepId, a.stepId]);
  assert.equal(store.getStep(guide.guideId, c.stepId).parentStepId, null);
});

test('restoreStep recreates a deleted step with its original id, data, and images', (t) => {
  const root = makeTmpDir('restore');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'Restore test' });
  const a = store.addStep(guide.guideId, { kind: 'empty', title: 'A' });
  const b = store.addStep(guide.guideId, { title: 'B', annotations: [{ id: 'ann1', type: 'arrow', x: 1, y: 2 }] }, TINY_PNG, { width: 1, height: 1 });
  const c = store.addStep(guide.guideId, { kind: 'empty', title: 'C' });

  const deleted = store.getStep(guide.guideId, b.stepId);
  store.deleteStep(guide.guideId, b.stepId);
  assert.deepEqual(store.getGuide(guide.guideId).stepsOrder, [a.stepId, c.stepId]);

  const restored = store.restoreStep(guide.guideId, deleted, { original: TINY_PNG, working: TINY_PNG }, 1);
  assert.equal(restored.stepId, b.stepId);
  assert.equal(restored.title, 'B');
  assert.equal(restored.annotations[0].type, 'arrow');

  const after = store.getGuide(guide.guideId);
  assert.deepEqual(after.stepsOrder, [a.stepId, b.stepId, c.stepId]);
  assert.deepEqual(store.getStep(guide.guideId, b.stepId).annotations, deleted.annotations);
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guide.guideId, b.stepId, 'original')), TINY_PNG);
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guide.guideId, b.stepId, 'working')), TINY_PNG);
});

test('duplicate guide produces independent deep copy with fresh ids', (t) => {
  const root = makeTmpDir('dup');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'Original' });
  const s1 = store.addStep(guide.guideId, { title: 'Step one' }, TINY_PNG, { width: 1, height: 1 });
  const s2 = store.addStep(guide.guideId, { kind: 'empty', title: 'Child', parentStepId: s1.stepId });

  const copy = store.duplicateGuide(guide.guideId);
  assert.notEqual(copy.guideId, guide.guideId);
  assert.equal(copy.title, 'Original (copy)');
  assert.equal(copy.stepsOrder.length, 2);
  assert.ok(!copy.stepsOrder.includes(s1.stepId), 'copied steps must have new ids');

  // Parent/child relationship is remapped to the new ids.
  const copySteps = store.listSteps(copy.guideId);
  const copiedChild = [...copySteps.values()].find((s) => s.title === 'Child');
  const copiedParent = [...copySteps.values()].find((s) => s.title === 'Step one');
  assert.equal(copiedChild.parentStepId, copiedParent.stepId);

  // Image bytes were copied, and editing the copy does not touch the original.
  assert.deepEqual(fs.readFileSync(store.stepImagePath(copy.guideId, copiedParent.stepId, 'original')), TINY_PNG);
  copiedParent.title = 'Edited in copy';
  store.saveStep(copy.guideId, copiedParent);
  assert.equal(store.getStep(guide.guideId, s1.stepId).title, 'Step one');
});

test('delete moves guide to trash and restore brings it back intact', (t) => {
  const root = makeTmpDir('trash');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'Disposable' });
  store.addStep(guide.guideId, { kind: 'empty', title: 'only step' });

  store.deleteGuide(guide.guideId);
  assert.equal(store.guideExists(guide.guideId), false);
  const trash = store.listTrash();
  assert.equal(trash.length, 1);

  const restoredId = store.restoreFromTrash(trash[0]);
  assert.equal(restoredId, guide.guideId);
  assert.equal(store.getGuide(guide.guideId).title, 'Disposable');
  assert.equal(store.listSteps(guide.guideId).size, 1);

  store.deleteGuide(guide.guideId);
  store.purgeTrash();
  assert.equal(store.listTrash().length, 0);
});

test('folders and favorites round-trip', (t) => {
  const root = makeTmpDir('folders');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const g1 = store.createGuide({ title: 'In folder' });
  const g2 = store.createGuide({ title: 'Loose' });

  const folder = store.createFolder('IT Support');
  store.moveGuideToFolder(g1.guideId, folder.id);
  store.setFavorite(g2.guideId, true);

  const fresh = new GuideStore(root);
  assert.equal(fresh.loadFolders().guideFolders[g1.guideId], folder.id);
  assert.equal(fresh.getGuide(g2.guideId).favorite, true);

  // Deleting the folder unassigns guides but keeps them in the library.
  fresh.deleteFolder(folder.id);
  assert.equal(fresh.loadFolders().guideFolders[g1.guideId], undefined);
  assert.equal(fresh.guideExists(g1.guideId), true);

  assert.throws(() => fresh.moveGuideToFolder(g1.guideId, 'folder-missing'));
});

test('working image can be replaced (crop) and reset without touching original', (t) => {
  const root = makeTmpDir('crop');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'Crop test' });
  const step = store.addStep(guide.guideId, { title: 'shot' }, TINY_PNG, { width: 1, height: 1 });

  const cropped = Buffer.from('not-really-a-png-but-different-bytes');
  store.setWorkingImage(guide.guideId, step.stepId, cropped, { width: 10, height: 5 });
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guide.guideId, step.stepId, 'working')), cropped);
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guide.guideId, step.stepId, 'original')), TINY_PNG);
  assert.deepEqual(store.getStep(guide.guideId, step.stepId).image.size, { width: 10, height: 5 });

  store.resetWorkingImage(guide.guideId, step.stepId, { width: 1, height: 1 });
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guide.guideId, step.stepId, 'working')), TINY_PNG);
});

test('stored HTML is sanitized: scripts and handlers cannot round-trip', (t) => {
  const root = makeTmpDir('sanitize');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({
    title: 'XSS attempt',
    descriptionHtml: '<p onclick="evil()">hi<script>alert(1)</script> <a href="javascript:evil()">x</a> <a href="https://example.com">ok</a></p>',
  });
  const loaded = store.getGuide(guide.guideId);
  // The dangerous parts are gone; the safe parts survive exactly.
  assert.equal(
    loaded.descriptionHtml,
    '<p>hi <a>x</a> <a href="https://example.com">ok</a></p>'
  );

  const step = store.addStep(guide.guideId, {
    kind: 'content',
    descriptionHtml: '<div><iframe src="https://evil"></iframe><b>bold</b></div>',
  });
  assert.equal(store.getStep(guide.guideId, step.stepId).descriptionHtml, '<div><b>bold</b></div>');
});

test('guide ids are validated against path traversal', (t) => {
  const root = makeTmpDir('traverse');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  assert.throws(() => store.getGuide('../../etc'));
  assert.throws(() => store.guideDir('a/b'));
  assert.throws(() => store.stepDir('ok', '..'));
});
