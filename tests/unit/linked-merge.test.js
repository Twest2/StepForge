'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GuideStore } = require('../../core/store');
const { exportGuideArchive, importGuideArchive, readArchive, saveLinkedGuide } = require('../../core/archive');
const { readLock } = require('../../core/locks');
const { listSnapshots } = require('../../core/snapshots');
const { writeJsonSync } = require('../../core/util');
const { makeTmpDir, rmrf, TINY_PNG } = require('./helpers');

// Two people with their own libraries, both linked to one shared .sfgz.
function sharedGuide(t) {
  const root = makeTmpDir('linked-merge');
  t.after(() => rmrf(root));
  const owner = new GuideStore(path.join(root, 'owner'));
  const guide = owner.createGuide({ title: 'Shared guide' });
  const steps = [1, 2, 3].map((n) => owner.addStep(guide.guideId, { title: `Step ${n}` }, TINY_PNG, { width: 1, height: 1 }).stepId);
  const shared = path.join(root, 'team.sfgz');
  exportGuideArchive(owner, guide.guideId, shared);
  const a = new GuideStore(path.join(root, 'a'));
  const b = new GuideStore(path.join(root, 'b'));
  importGuideArchive(a, shared, { mode: 'linked' });
  importGuideArchive(b, shared, { mode: 'linked' });
  return { root, id: guide.guideId, steps, shared, a, b };
}
const edit = (store, id, stepId, patch) => store.saveStep(id, { ...store.getStep(id, stepId), ...patch });
const sharedStep = (shared, stepId) => JSON.parse(readArchive(shared).entries.find((e) => e.name === `steps/${stepId}/step.json`).data);
// Guide times have one-second resolution, so tests that need an order set it.
const editedAt = (store, id, iso) => writeJsonSync(path.join(store.guideDir(id), 'guide.json'), { ...store.getGuide(id), updatedAt: iso });

test('a save with nothing changed on the shared file writes without merging', async (t) => {
  const { id, steps, shared, a } = sharedGuide(t);
  edit(a, id, steps[0], { title: 'A edit' });
  const result = await saveLinkedGuide(a, id);
  assert.equal(result.saved, true);
  assert.equal(result.merged, undefined);
  assert.equal(sharedStep(shared, steps[0]).title, 'A edit');
  assert.equal(listSnapshots(a, id).length, 0, 'no merge, no backup');
  assert.equal(readLock(shared), null);
  // The base moved with the save, so a second save still does not merge.
  edit(a, id, steps[1], { title: 'A second edit' });
  const again = await saveLinkedGuide(a, id);
  assert.equal(again.saved, true);
  assert.equal(again.merged, undefined);
  assert.equal(sharedStep(shared, steps[1]).title, 'A second edit');
});

test('changes to different steps by two sessions both survive', async (t) => {
  const { id, steps, shared, a, b } = sharedGuide(t);
  edit(a, id, steps[0], { title: 'From A' });
  await saveLinkedGuide(a, id);
  edit(b, id, steps[1], { title: 'From B' });
  const added = b.addStep(id, { title: 'Added on B' }).stepId;
  const result = await saveLinkedGuide(b, id);
  assert.equal(result.saved, true);
  assert.equal(result.merged, true);
  assert.equal(result.conflicts, 0);

  const sharedGuideJson = readArchive(shared).guide;
  assert.deepEqual([...sharedGuideJson.stepsOrder].sort(), [...steps, added].sort());
  assert.equal(sharedStep(shared, steps[0]).title, 'From A');
  assert.equal(sharedStep(shared, steps[1]).title, 'From B');
  // B's own library now holds the merged guide, still linked, with its images.
  assert.equal(b.getStep(id, steps[0]).title, 'From A');
  assert.equal(b.getStep(id, steps[1]).title, 'From B');
  assert.equal(b.getGuide(id).linkedSource.path, path.resolve(shared));
  assert.ok(b.getGuide(id).linkedSource.lastSavedAt);
  assert.ok(fs.existsSync(b.stepImagePath(id, steps[0], 'original')));
  assert.equal(listSnapshots(b, id).length, 1, 'the pre-merge guide is backed up');

  // A picks the merge up on its next save and nothing is lost.
  const fromA = await saveLinkedGuide(a, id);
  assert.equal(fromA.merged, true);
  assert.equal(a.getStep(id, added).title, 'Added on B');
  assert.equal(a.getStep(id, steps[1]).title, 'From B');
  assert.equal(readLock(shared), null);
});

test('a step deleted by one session stays deleted when the other did not touch it', async (t) => {
  const { id, steps, shared, a, b } = sharedGuide(t);
  a.deleteStep(id, steps[2]);
  await saveLinkedGuide(a, id);
  edit(b, id, steps[0], { title: 'B only' });
  const result = await saveLinkedGuide(b, id);
  assert.equal(result.merged, true);
  assert.deepEqual(readArchive(shared).guide.stepsOrder, [steps[0], steps[1]]);
  assert.equal(b.listSteps(id).has(steps[2]), false);
  assert.equal(fs.existsSync(b.stepDir(id, steps[2])), false);
});

test('the same field changed by both sessions is a conflict that the later edit wins', async (t) => {
  const { id, steps, shared, a, b } = sharedGuide(t);
  edit(a, id, steps[0], { title: 'A title', status: 'done' });
  editedAt(a, id, '2030-01-01T10:00:00Z');
  await saveLinkedGuide(a, id);
  edit(b, id, steps[0], { title: 'B title' });
  editedAt(b, id, '2030-01-01T10:00:05Z');
  const result = await saveLinkedGuide(b, id);
  assert.equal(result.merged, true);
  assert.equal(result.conflicts, 1);
  assert.equal(sharedStep(shared, steps[0]).title, 'B title');
  assert.equal(sharedStep(shared, steps[0]).status, 'done', 'the other field from A is kept');
  assert.equal(b.getStep(id, steps[0]).title, 'B title');
  assert.equal(b.getStep(id, steps[0]).status, 'done');
});

test('a guide linked before bases were recorded merges without a base', async (t) => {
  const { id, steps, shared, a, b } = sharedGuide(t);
  // Guides linked by older versions have no remembered base.
  fs.rmSync(path.join(b.guideDir(id), 'history', 'linked-base.json'));
  const added = a.addStep(id, { title: 'Added on A' }).stepId;
  editedAt(a, id, '2030-01-01T10:00:00Z');
  await saveLinkedGuide(a, id);
  edit(b, id, steps[1], { title: 'From B' });
  b.deleteStep(id, steps[2]);
  editedAt(b, id, '2030-01-01T10:00:05Z');
  const result = await saveLinkedGuide(b, id);
  assert.equal(result.merged, true);
  assert.equal(b.getStep(id, added).title, 'Added on A');
  // Without a base the shared copy can't be told apart from an edit, so the
  // newer side (B) wins differing values, and nothing counts as deleted.
  assert.equal(sharedStep(shared, steps[1]).title, 'From B');
  assert.ok(readArchive(shared).guide.stepsOrder.includes(steps[2]));
  assert.ok(b.listSteps(id).has(steps[2]));
  // The save recorded a base: the next one is a plain write.
  edit(b, id, steps[1], { title: 'From B again' });
  const next = await saveLinkedGuide(b, id);
  assert.equal(next.merged, undefined);
  assert.equal(sharedStep(shared, steps[1]).title, 'From B again');
});

test('a shared file that cannot be read is not overwritten unless forced', async (t) => {
  const { id, steps, shared, a } = sharedGuide(t);
  fs.writeFileSync(shared, 'not an archive');
  edit(a, id, steps[0], { title: 'Local' });
  await assert.rejects(saveLinkedGuide(a, id), /could not be read/);
  assert.equal(fs.readFileSync(shared, 'utf8'), 'not an archive');
  assert.equal(readLock(shared), null);
  assert.equal((await saveLinkedGuide(a, id, { force: true })).saved, true);
  assert.equal(sharedStep(shared, steps[0]).title, 'Local');
});
