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
  const [item] = store.listTrashItems();
  assert.equal(item.name, trash[0]);
  assert.equal(item.title, 'Disposable');
  assert.equal(item.stepCount, 1);
  assert.ok(Math.abs(Date.parse(item.deletedAt) - Date.now()) < 60000);

  const restoredId = store.restoreFromTrash(trash[0]);
  assert.equal(restoredId, guide.guideId);
  assert.equal(store.getGuide(guide.guideId).title, 'Disposable');
  assert.equal(store.listSteps(guide.guideId).size, 1);

  store.deleteGuide(guide.guideId);
  store.purgeTrash();
  assert.equal(store.listTrash().length, 0);
});

test('purgeExpiredTrash deletes only guides older than the limit, counting from `since`', (t) => {
  const root = makeTmpDir('trash-expiry');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-10-24T12:00:00Z');
  const trashGuide = (title, deletedAt) => {
    const guide = store.createGuide({ title });
    fs.renameSync(store.deleteGuide(guide.guideId), path.join(store.trashDir, `${guide.guideId}-${deletedAt}`));
  };
  trashGuide('Old', now - 40 * day);
  trashGuide('Recent', now - 10 * day);
  // A leftover with no deletion time is never purged.
  fs.mkdirSync(path.join(store.trashDir, 'no-stamp'));
  fs.writeFileSync(path.join(store.trashDir, 'no-stamp', 'guide.json'), JSON.stringify({ title: 'Undated' }));

  // Emptying turned on 5 days ago: the 40-day-old guide still has 25 days.
  assert.deepEqual(store.purgeExpiredTrash({ days: 30, since: now - 5 * day, now }), []);
  // 0 days means keep everything.
  assert.deepEqual(store.purgeExpiredTrash({ days: 0, now }), []);

  const removed = store.purgeExpiredTrash({ days: 30, since: now - 31 * day, now });
  assert.equal(removed.length, 1);
  const titles = store.listTrashItems().map((item) => item.title).sort();
  assert.deepEqual(titles, ['Recent', 'Undated']);

  assert.equal(store.purgeExpiredTrash({ days: 7, since: 0, now }).length, 1);
  assert.deepEqual(store.listTrashItems().map((item) => item.title), ['Undated']);
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

test('an uncropped screenshot is stored once; a crop adds working.png and un-crop removes it', (t) => {
  const root = makeTmpDir('one-copy');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const { guideId } = store.createGuide({ title: 'One copy' });
  const { stepId } = store.addStep(guideId, { title: 'shot' }, TINY_PNG, { width: 1, height: 1 });
  const dir = store.stepDir(guideId, stepId);
  const files = () => fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  assert.deepEqual(files(), ['original.png']);
  assert.equal(store.stepImagePath(guideId, stepId, 'working'), store.stepImagePath(guideId, stepId, 'original'));

  const cropped = Buffer.concat([TINY_PNG, Buffer.from('crop')]);
  store.setWorkingImage(guideId, stepId, cropped, { width: 1, height: 1 });
  assert.deepEqual(files(), ['original.png', 'working.png']);

  // Undoing the crop puts the original's bytes back: one file again.
  store.setWorkingImage(guideId, stepId, TINY_PNG, { width: 1, height: 1 });
  assert.deepEqual(files(), ['original.png']);

  store.setWorkingImage(guideId, stepId, cropped, { width: 1, height: 1 });
  store.resetWorkingImage(guideId, stepId, { width: 1, height: 1 });
  assert.deepEqual(files(), ['original.png']);
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guideId, stepId, 'working')), TINY_PNG);
});

test('a step saved from an older copy keeps the crop the store made since', (t) => {
  const root = makeTmpDir('stale-paths');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const { guideId } = store.createGuide({ title: 'Stale' });
  const { stepId } = store.addStep(guideId, { title: 'shot' }, TINY_PNG, { width: 1, height: 1 });
  const before = store.getStep(guideId, stepId); // the editor's copy, from before the crop
  const cropped = Buffer.concat([TINY_PNG, Buffer.from('crop')]);
  store.setWorkingImage(guideId, stepId, cropped, { width: 1, height: 1 });

  store.saveStep(guideId, { ...before, title: 'Renamed' });
  assert.equal(store.getStep(guideId, stepId).title, 'Renamed');
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guideId, stepId, 'working')), cropped);
  // The same holds for a crop sent with a step patch from before it.
  store.setWorkingImage(guideId, stepId, Buffer.concat([cropped, Buffer.from('2')]), { width: 1, height: 1 }, before);
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guideId, stepId, 'original')), TINY_PNG);
});

test('replacing a cropped screenshot drops the old crop', (t) => {
  const root = makeTmpDir('replace-crop');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const { guideId } = store.createGuide({ title: 'Replace' });
  const { stepId } = store.addStep(guideId, { title: 'shot' }, TINY_PNG, { width: 1, height: 1 });
  store.setWorkingImage(guideId, stepId, Buffer.concat([TINY_PNG, Buffer.from('crop')]), { width: 1, height: 1 });
  const fresh = Buffer.concat([TINY_PNG, Buffer.from('new')]);
  store.replaceImages(guideId, stepId, { original: fresh }, { width: 2, height: 2 });
  const dir = store.stepDir(guideId, stepId);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.png')), ['original.png']);
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guideId, stepId, 'working')), fresh);

  // Undo of Choose image… sends both images; a different working one is kept.
  const crop = Buffer.concat([TINY_PNG, Buffer.from('crop')]);
  store.replaceImages(guideId, stepId, { original: TINY_PNG, working: crop }, { width: 1, height: 1 });
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guideId, stepId, 'working')), crop);
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guideId, stepId, 'original')), TINY_PNG);
});

test('steps from before one-copy storage, with both files, keep working', (t) => {
  const root = makeTmpDir('legacy-copies');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const { guideId } = store.createGuide({ title: 'Legacy' });
  const { stepId } = store.addStep(guideId, { title: 'shot' });
  const dir = store.stepDir(guideId, stepId);
  fs.writeFileSync(path.join(dir, 'original.png'), TINY_PNG);
  fs.writeFileSync(path.join(dir, 'working.png'), TINY_PNG);
  const step = store.getStep(guideId, stepId);
  step.kind = 'image';
  step.image = { originalPath: 'original.png', workingPath: 'working.png', size: { width: 1, height: 1 } };
  fs.writeFileSync(path.join(dir, 'step.json'), JSON.stringify(step));

  const cropped = Buffer.concat([TINY_PNG, Buffer.from('crop')]);
  store.setWorkingImage(guideId, stepId, cropped, { width: 1, height: 1 });
  assert.deepEqual(fs.readFileSync(path.join(dir, 'working.png')), cropped);
  store.resetWorkingImage(guideId, stepId, { width: 1, height: 1 });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.png')), ['original.png']);
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

test('guide metadata: optional fields default to empty strings and round-trip via save/load', (t) => {
  const root = makeTmpDir('metadata');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'Metadata test' });
  const empty = { author: '', coAuthors: '', organization: '', lastVerified: '', softwareVersion: '', reviewAfterDays: null };
  assert.deepEqual(guide.metadata, empty);

  guide.metadata = { author: 'Jane Doe', coAuthors: 'Alex Lee, Sam Patel', organization: 'Acme Corp' };
  store.saveGuide(guide);

  const fresh = new GuideStore(root);
  const loaded = fresh.getGuide(guide.guideId);
  assert.deepEqual(loaded.metadata, { ...empty, author: 'Jane Doe', coAuthors: 'Alex Lee, Sam Patel', organization: 'Acme Corp' });

  // A guide saved before metadata existed normalizes to the same defaults.
  const legacy = fresh.getGuide(guide.guideId);
  delete legacy.metadata;
  store.saveGuide(legacy);
  assert.deepEqual(fresh.getGuide(guide.guideId).metadata, empty);

  loaded.metadata = 'not an object';
  assert.throws(() => store.saveGuide(loaded), /metadata must be an object/);
});

test('reorderSteps can re-parent steps in the same call, and refuses an outline that breaks numbering', (t) => {
  const root = makeTmpDir('reorder-parents');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'Outline test' });
  const a = store.addStep(guide.guideId, { kind: 'empty', title: 'A' });
  const a1 = store.addStep(guide.guideId, { kind: 'empty', title: 'A1', parentStepId: a.stepId });
  const b = store.addStep(guide.guideId, { kind: 'empty', title: 'B' });
  const id = guide.guideId;
  const parentOf = (stepId) => store.getStep(id, stepId).parentStepId;

  // A move that would orphan A1 is refused whole: neither order nor parents change.
  assert.throws(() => store.reorderSteps(id, [a1.stepId, a.stepId, b.stepId], { [a1.stepId]: a.stepId }), /numbering/);
  assert.throws(() => store.reorderSteps(id, [b.stepId, a1.stepId, a.stepId], { [a1.stepId]: a.stepId }), /numbering/);
  assert.deepEqual(store.getGuide(id).stepsOrder, [a.stepId, a1.stepId, b.stepId]);
  assert.equal(parentOf(a1.stepId), a.stepId);

  // Moving B first and the pair after it, with A1 re-parented, is a valid outline.
  const revision = store.getStep(id, a1.stepId).revision;
  store.reorderSteps(id, [b.stepId, a.stepId, a1.stepId], { [a1.stepId]: a.stepId });
  assert.deepEqual(store.getGuide(id).stepsOrder, [b.stepId, a.stepId, a1.stepId]);
  assert.equal(store.getStep(id, a1.stepId).revision, revision, 'unchanged parents are not rewritten');

  // Nest and un-nest together with the order.
  store.reorderSteps(id, [b.stepId, a.stepId, a1.stepId], { [a.stepId]: b.stepId, [a1.stepId]: null });
  assert.equal(parentOf(a.stepId), b.stepId);
  assert.equal(parentOf(a1.stepId), null);
  assert.ok(store.getStep(id, a.stepId).revision > 0);

  // Unknown steps in `parents` are refused; with no parents the old behavior holds.
  assert.throws(() => store.reorderSteps(id, [a.stepId, b.stepId, a1.stepId], { 'step-bogus': null }));
  store.reorderSteps(id, [a.stepId, b.stepId, a1.stepId]);
  assert.deepEqual(store.getGuide(id).stepsOrder, [a.stepId, b.stepId, a1.stepId]);
});

test('reorderSteps checks the outline whenever parents is passed, even empty, unless it was already broken', (t) => {
  const root = makeTmpDir('reorder-empty-parents');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'Outline test' });
  const id = guide.guideId;
  const a = store.addStep(id, { kind: 'empty', title: 'A' });
  const a1 = store.addStep(id, { kind: 'empty', title: 'A1', parentStepId: a.stepId });
  const b = store.addStep(id, { kind: 'empty', title: 'B' });

  // An empty map is still a checked move: putting A1 above A would orphan it.
  assert.throws(() => store.reorderSteps(id, [a1.stepId, a.stepId, b.stepId], {}), /numbering/);
  assert.deepEqual(store.getGuide(id).stepsOrder, [a.stepId, a1.stepId, b.stepId]);

  // A guide an old move already broke can still be reordered (and so undone).
  store.reorderSteps(id, [b.stepId, a1.stepId, a.stepId]);
  store.reorderSteps(id, [a1.stepId, b.stepId, a.stepId], {});
  assert.deepEqual(store.getGuide(id).stepsOrder, [a1.stepId, b.stepId, a.stepId]);
});
