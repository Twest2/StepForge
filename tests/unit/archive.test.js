'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { zipSync, unzipSync, extractZipSync, assertSafeEntryName } = require('../../core/zip');
const { GuideStore } = require('../../core/store');
const { exportGuideArchive, importGuideArchive, readArchive, saveLinkedGuide } = require('../../core/archive');
const { acquireLock, releaseLock, lockPathFor, readLock } = require('../../core/locks');
const { createSnapshot, listSnapshots, restoreSnapshot } = require('../../core/snapshots');
const { makeTmpDir, rmrf, TINY_PNG } = require('./helpers');

function makeGuide(store) {
  const guide = store.createGuide({
    title: 'Install VPN',
    descriptionHtml: '<p>Company VPN setup</p>',
    placeholders: { Company: 'Acme' },
  });
  const s1 = store.addStep(guide.guideId, {
    title: 'Download installer',
    annotations: [{ type: 'rect', x: 0.1, y: 0.1, w: 0.5, h: 0.3 }],
  }, TINY_PNG, { width: 1, height: 1 });
  const s2 = store.addStep(guide.guideId, { kind: 'content', title: 'Notes', descriptionHtml: '<p>VPN notes</p>' });
  const sub = store.addStep(guide.guideId, { kind: 'empty', title: 'Substep', parentStepId: s1.stepId });
  return { guide: store.getGuide(guide.guideId), s1, s2, sub };
}

test('zip round-trips data through actual zip bytes and rejects unsafe names', (t) => {
  const dir = makeTmpDir('zip');
  t.after(() => rmrf(dir));

  const buf = zipSync([
    { name: 'a.txt', data: 'alpha' },
    { name: 'nested/deep/b.bin', data: Buffer.from([0, 255, 1, 254]) },
    { name: 'stored.png', data: TINY_PNG, store: true },
  ]);
  const entries = unzipSync(buf);
  assert.deepEqual(entries.map((e) => e.name), ['a.txt', 'nested/deep/b.bin', 'stored.png']);
  assert.equal(entries[0].data.toString(), 'alpha');
  assert.deepEqual([...entries[1].data], [0, 255, 1, 254]);
  assert.deepEqual(entries[2].data, TINY_PNG);

  extractZipSync(buf, dir);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'alpha');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'nested/deep/b.bin'))[1], 255);

  for (const bad of ['../evil', '/abs', 'C:/win', 'a/../../b', 'a\\b', 'a/./b', '']) {
    assert.throws(() => assertSafeEntryName(bad), `should reject: ${bad}`);
  }

  // A corrupted byte must be caught by CRC verification.
  const corrupted = Buffer.from(buf);
  corrupted[35] ^= 0xff;
  assert.throws(() => unzipSync(corrupted));
});

test('.sfgz export -> import(copy) round-trips full guide content with new ids', (t) => {
  const dir = makeTmpDir('sfgz');
  t.after(() => rmrf(dir));
  const store = new GuideStore(path.join(dir, 'data'));
  const { guide, s1 } = makeGuide(store);

  const file = path.join(dir, 'install-vpn.sfgz');
  const manifest = exportGuideArchive(store, guide.guideId, file);
  assert.equal(manifest.stepCount, 3);
  assert.ok(fs.statSync(file).size > 0);

  // Import into a second, empty library as an independent copy.
  const store2 = new GuideStore(path.join(dir, 'data2'));
  const imported = importGuideArchive(store2, file, { mode: 'copy' });
  assert.notEqual(imported.guideId, guide.guideId);
  assert.equal(imported.title, 'Install VPN');
  assert.equal(imported.placeholders.Company, 'Acme');
  assert.equal(imported.linkedSource, null);
  assert.equal(imported.stepsOrder.length, 3);

  const steps = store2.listSteps(imported.guideId);
  const titles = imported.stepsOrder.map((id) => steps.get(id).title);
  assert.deepEqual(titles, ['Download installer', 'Notes', 'Substep']);
  // Substep parent remapped to the copied parent's new id.
  const subStep = [...steps.values()].find((s) => s.title === 'Substep');
  const parent = [...steps.values()].find((s) => s.title === 'Download installer');
  assert.equal(subStep.parentStepId, parent.stepId);
  // Image bytes survive the round trip.
  assert.deepEqual(
    fs.readFileSync(store2.stepImagePath(imported.guideId, parent.stepId, 'original')),
    TINY_PNG
  );
  assert.equal(parent.annotations[0].type, 'rect');
});

test('linked import keeps identity; explicit save writes back to the archive', (t) => {
  const dir = makeTmpDir('linked');
  t.after(() => rmrf(dir));
  const storeA = new GuideStore(path.join(dir, 'userA'));
  const { guide } = makeGuide(storeA);
  const shared = path.join(dir, 'shared.sfgz');
  exportGuideArchive(storeA, guide.guideId, shared);

  const storeB = new GuideStore(path.join(dir, 'userB'));
  const linked = importGuideArchive(storeB, shared, { mode: 'linked' });
  assert.equal(linked.guideId, guide.guideId, 'linked mode preserves guide identity');
  assert.equal(linked.linkedSource.path, path.resolve(shared));

  // Importing the same shared file twice must be refused.
  assert.throws(() => importGuideArchive(storeB, shared, { mode: 'linked' }));

  // Local edit + explicit save-back, then the other user re-reads the file.
  linked.title = 'Install VPN v2';
  storeB.saveGuide(linked);
  const result = saveLinkedGuide(storeB, linked.guideId);
  assert.equal(result.saved, true);
  assert.equal(readArchive(shared).guide.title, 'Install VPN v2');
  // Lock is released after a successful save.
  assert.equal(readLock(shared), null);
});

test('lock conflicts block linked save until forced', (t) => {
  const dir = makeTmpDir('locks');
  t.after(() => rmrf(dir));
  const store = new GuideStore(path.join(dir, 'data'));
  const { guide } = makeGuide(store);
  const shared = path.join(dir, 'team.sfgz');
  exportGuideArchive(store, guide.guideId, shared);
  const linkedStore = new GuideStore(path.join(dir, 'data2'));
  const linked = importGuideArchive(linkedStore, shared, { mode: 'linked' });

  // Simulate another user holding the lock.
  fs.writeFileSync(lockPathFor(shared), JSON.stringify({
    host: 'other-machine', user: 'colleague', pid: 1234,
    acquiredAt: new Date().toISOString(),
  }));

  const blocked = saveLinkedGuide(linkedStore, linked.guideId);
  assert.equal(blocked.saved, false);
  assert.equal(blocked.conflict.host, 'other-machine');

  // Forcing (the user chose "save anyway" in the conflict dialog) succeeds.
  const forced = saveLinkedGuide(linkedStore, linked.guideId, { force: true });
  assert.equal(forced.saved, true);

  // A stale lock (crashed peer) does not block.
  fs.writeFileSync(lockPathFor(shared), JSON.stringify({
    host: 'other-machine', user: 'colleague', pid: 99,
    acquiredAt: new Date(Date.now() - 9 * 3600 * 1000).toISOString(),
  }));
  assert.equal(saveLinkedGuide(linkedStore, linked.guideId).saved, true);
});

test('acquire/release lock lifecycle for this process', (t) => {
  const dir = makeTmpDir('lock2');
  t.after(() => rmrf(dir));
  const archive = path.join(dir, 'g.sfgz');
  fs.writeFileSync(archive, 'placeholder');

  const r1 = acquireLock(archive);
  assert.equal(r1.acquired, true);
  // Re-acquiring our own lock succeeds (same holder).
  assert.equal(acquireLock(archive).acquired, true);
  assert.equal(releaseLock(archive), true);
  assert.equal(readLock(archive), null);
});

test('snapshot and restore recover a damaged guide, and restores are undoable', (t) => {
  const dir = makeTmpDir('snap');
  t.after(() => rmrf(dir));
  const store = new GuideStore(path.join(dir, 'data'));
  const { guide, s1 } = makeGuide(store);

  createSnapshot(store, guide.guideId, { label: 'before-edit' });
  assert.equal(listSnapshots(store, guide.guideId).length, 1);

  // Damage the guide: change title and delete a step.
  const g = store.getGuide(guide.guideId);
  g.title = 'Ruined';
  store.saveGuide(g);
  store.deleteStep(guide.guideId, s1.stepId);
  assert.equal(store.getGuide(guide.guideId).stepsOrder.length, 2);

  const restored = restoreSnapshot(store, guide.guideId, listSnapshots(store, guide.guideId).find((n) => n.includes('before-edit')));
  assert.equal(restored.title, 'Install VPN');
  assert.equal(restored.stepsOrder.length, 3);
  assert.deepEqual(
    fs.readFileSync(store.stepImagePath(guide.guideId, s1.stepId, 'original')),
    TINY_PNG
  );
  // The pre-restore state was snapshotted too (restore is undoable).
  assert.ok(listSnapshots(store, guide.guideId).some((n) => n.includes('pre-restore')));
});

test('snapshot pruning keeps only the most recent N', (t) => {
  const dir = makeTmpDir('prune');
  t.after(() => rmrf(dir));
  const store = new GuideStore(path.join(dir, 'data'));
  const { guide } = makeGuide(store);
  for (let i = 0; i < 5; i++) createSnapshot(store, guide.guideId, { label: `s${i}`, keepLast: 3 });
  const names = listSnapshots(store, guide.guideId);
  assert.equal(names.length, 3);
  assert.ok(names[0].includes('s4'));
});
