'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { GuideStore } = require('../../core/store');
const { buildArchiveEntries, exportGuideArchive, importGuideArchive } = require('../../core/archive');
const { contentHash, encodeSnapshot, decodeSnapshot } = require('../../core/cloud-parts');
const { mergeGuideEntries, mergeOrder } = require('../../core/guide-merge');
const { writeJsonSync } = require('../../core/util');
const { makeTmpDir, rmrf, TINY_PNG } = require('./helpers');

// Two libraries holding the same guide, as two computers would.
const SHOT = Buffer.concat([TINY_PNG, Buffer.alloc(4000, 1)]);
function twoCopies(t, steps = 3) {
  const root = makeTmpDir('guide-merge');
  t.after(() => rmrf(root));
  const a = new GuideStore(path.join(root, 'a'));
  const guide = a.createGuide({ title: 'Original' });
  for (let i = 1; i <= steps; i++) a.addStep(guide.guideId, { title: `Step ${i}` }, SHOT, { width: 1, height: 1 });
  const file = path.join(root, 'guide.sfgz');
  exportGuideArchive(a, guide.guideId, file);
  const b = new GuideStore(path.join(root, 'b'));
  importGuideArchive(b, file, { mode: 'linked' });
  return { a, b, id: guide.guideId, base: buildArchiveEntries(a, guide.guideId) };
}
const side = (store, id) => { const entries = buildArchiveEntries(store, id); return { entries, hash: contentHash(entries) }; };
const guideOf = (entries) => JSON.parse(entries.find((e) => e.name === 'guide.json').data);
const stepOf = (entries, stepId) => JSON.parse(entries.find((e) => e.name === `steps/${stepId}/step.json`).data);
function savedAt(store, id, iso) { writeJsonSync(path.join(store.guideDir(id), 'guide.json'), { ...store.getGuide(id), updatedAt: iso }); }

test('the merge result does not depend on which computer runs it', async (t) => {
  const { a, b, id, base } = twoCopies(t);
  const [s1, s2, s3] = a.getGuide(id).stepsOrder;
  a.saveStep(id, { ...a.getStep(id, s1), title: 'A title', status: 'done' });
  a.deleteStep(id, s3);
  const addedA = a.addStep(id, { title: 'Added on A' }).stepId;
  b.saveStep(id, { ...b.getStep(id, s1), title: 'B title' });
  b.reorderSteps(id, [s2, s1, s3]);
  const addedB = b.addStep(id, { title: 'Added on B' }).stepId;
  savedAt(a, id, '2030-01-01T10:00:00Z');
  savedAt(b, id, '2030-01-01T09:00:00Z');
  const one = mergeGuideEntries({ base, sides: [side(a, id), side(b, id)] });
  const two = mergeGuideEntries({ base, sides: [side(b, id), side(a, id)] });
  assert.equal(contentHash(one.entries), contentHash(two.entries));
  assert.equal(one.conflicts, 1, 'only the step title was changed on both');
  const step = stepOf(one.entries, s1);
  assert.equal(step.title, 'A title', 'the newer save wins the conflict');
  assert.equal(step.status, 'done');
  // B's order (only B reordered), with A's new step after the step it followed on A.
  assert.deepEqual(guideOf(one.entries).stepsOrder, [s2, addedA, s1, addedB]);
});

test('a cloud manifest without screenshot bytes works as the base', async (t) => {
  const { a, b, id, base } = twoCopies(t, 1);
  const [stepId] = a.getGuide(id).stepsOrder;
  a.saveStep(id, { ...a.getStep(id, stepId), title: 'From A' });
  b.replaceImages(id, stepId, { original: Buffer.concat([TINY_PNG, Buffer.from('B')]) }, { width: 3, height: 3 });
  // Screenshots bigger than the inline limit are only hashes in a manifest.
  const manifest = decodeSnapshot(encodeSnapshot(base, { inlineLimit: 1024 }).manifest);
  assert.ok(manifest.entries.some((entry) => entry.name.endsWith('.png') && !entry.data));
  const result = mergeGuideEntries({ base: manifest.entries, sides: [side(a, id), side(b, id)] });
  const step = stepOf(result.entries, stepId);
  assert.equal(step.title, 'From A');
  assert.deepEqual(step.image.size, { width: 3, height: 3 });
  const original = result.entries.find((e) => e.name === `steps/${stepId}/original.png`);
  assert.deepEqual(original.data, Buffer.concat([TINY_PNG, Buffer.from('B')]));
  assert.equal(result.conflicts, 0);
});

test('without a base nothing is deleted and differing values go to the newest save', async (t) => {
  const { a, b, id } = twoCopies(t, 2);
  const [s1, s2] = a.getGuide(id).stepsOrder;
  a.deleteStep(id, s2);
  const onlyA = a.addStep(id, { title: 'Only on A' }).stepId;
  const onlyB = b.addStep(id, { title: 'Only on B' }).stepId;
  a.saveStep(id, { ...a.getStep(id, s1), title: 'Older' });
  b.saveStep(id, { ...b.getStep(id, s1), title: 'Newer' });
  savedAt(a, id, '2030-01-01T09:00:00Z');
  savedAt(b, id, '2030-01-01T10:00:00Z');
  const result = mergeGuideEntries({ base: null, sides: [side(a, id), side(b, id)] });
  const order = guideOf(result.entries).stepsOrder;
  assert.deepEqual([...order].sort(), [s1, s2, onlyA, onlyB].sort());
  assert.equal(stepOf(result.entries, s1).title, 'Newer');
});

test('a substep whose parent was deleted moves to the top level', async (t) => {
  const { a, b, id, base } = twoCopies(t, 2);
  const [parent, child] = a.getGuide(id).stepsOrder;
  a.deleteStep(id, parent);
  b.saveStep(id, { ...b.getStep(id, child), parentStepId: parent, title: 'Nested on B' });
  const result = mergeGuideEntries({ base, sides: [side(a, id), side(b, id)] });
  assert.deepEqual(guideOf(result.entries).stepsOrder, [child]);
  assert.equal(stepOf(result.entries, child).parentStepId, null);
  assert.equal(stepOf(result.entries, child).title, 'Nested on B');
});

test('step order: one side reorders while the other inserts', () => {
  assert.deepEqual(mergeOrder(['a', 'b', 'c'], [['c', 'b', 'a'], ['a', 'x', 'b', 'c']], new Set(['a', 'b', 'c', 'x'])), ['c', 'b', 'a', 'x']);
  assert.deepEqual(mergeOrder(['a', 'b', 'c'], [['a', 'b', 'c', 'y'], ['b', 'a', 'c']], new Set(['a', 'b', 'c', 'y'])), ['b', 'a', 'c', 'y']);
  assert.deepEqual(mergeOrder(['a', 'b'], [['x', 'a', 'b']], new Set(['a', 'b', 'x'])), ['x', 'a', 'b']);
});
