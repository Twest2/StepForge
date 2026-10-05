'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GuideStore } = require('../../core/store');
const { CloudSync, snapshot, headsOf } = require('../../core/cloud-sync');
const { createSnapshot, listSnapshots, restoreSnapshot } = require('../../core/snapshots');
const { Settings } = require('../../core/settings');
const { writeJsonSync } = require('../../core/util');
const { makeTmpDir, rmrf, TINY_PNG } = require('./helpers');

function setup(t) {
  const root = makeTmpDir('cloud-sync');
  t.after(() => rmrf(root));
  const files = [];
  let nextFileId = 0;
  const bytes = new Map();
  const drive = {
    calls: 0,
    clientId: 'test-client',
    status: () => ({ connected: true }),
    account: async () => 'account-a',
    cancel() {},
    async listVersions() { this.calls++; return files.filter((file) => file.appProperties?.stepforge === 'guide-v1'); },
    async listDeletions() { return files.filter((file) => file.appProperties?.stepforge === 'deletion-v1'); },
    async listParts() { return files.filter((file) => file.appProperties?.stepforge === 'part-v1'); },
    async upload({ data, name, properties }) {
      // Like Drive: ordered creation times, and the size shows up in listings.
      const file = { id: `file-${++nextFileId}`, name, appProperties: properties, size: String(data.length),
        createdTime: new Date(Date.UTC(2026, 0, 1) + nextFileId * 1000).toISOString() };
      files.push(file); bytes.set(file.id, data); return file;
    },
    async download(id) { return bytes.get(id); },
    async deleteFile(id) {
      const index = files.findIndex((file) => file.id === id);
      if (index >= 0) files.splice(index, 1);
      bytes.delete(id);
    },
  };
  function device(name, options = {}) {
    const store = new GuideStore(path.join(root, name));
    const sync = new CloudSync({ store, drive, enabled: () => true, settleMs: 0, ...options });
    t.after(() => sync.stop());
    return { store, sync };
  }
  return { root, drive, files, bytes, device };
}
function edit(store, id, title) { const guide = store.getGuide(id); guide.title = title; store.saveGuide(guide); }
function addGuide(store, steps = 0) {
  const guide = store.createGuide({ title: 'Original' });
  if (!steps) store.addStep(guide.guideId, { title: 'Screenshot' }, TINY_PNG, { width: 1, height: 1 });
  for (let i = 1; i <= steps; i++) store.addStep(guide.guideId, { title: `Step ${i}` }, TINY_PNG, { width: 1, height: 1 });
  return guide.guideId;
}
function editStep(store, id, stepId, patch) { store.saveStep(id, { ...store.getStep(id, stepId), ...patch }); }
const versionFiles = (files) => files.filter((file) => file.appProperties?.stepforge === 'guide-v1');
// Merges let the most recent save win. Saves are timed to the second, so
// tests date a guide's last save explicitly.
function savedAt(store, id, iso) { writeJsonSync(path.join(store.guideDir(id), 'guide.json'), { ...store.getGuide(id), updatedAt: iso }); }
async function synced(sync) { const status = await sync.sync(); assert.notEqual(status.phase, 'error', status.message); return status; }

test('cloud sharing is off by default and makes no network requests while disabled', async (t) => {
  const { device, drive } = setup(t);
  const { store, sync } = device('a', { enabled: () => false });
  assert.equal(new Settings(store.settingsDir).get('cloud.enabled'), false);
  addGuide(store);
  assert.equal((await sync.sync()).phase, 'off');
  assert.equal(drive.calls, 0);
});

test('archive upload and download preserve guide identity, steps and screenshots without repeated uploads', async (t) => {
  const { device, files } = setup(t);
  const a = device('a'); const b = device('b');
  const id = addGuide(a.store);
  await synced(a.sync); await synced(b.sync);
  assert.equal(snapshot(a.store, id).hash, snapshot(b.store, id).hash);
  await synced(a.sync); await synced(b.sync);
  assert.equal(files.length, 1);
  assert.equal(b.store.listSteps(id).size, 1);
});

test('remote changes safely replace a clean guide and preserve a disk backup', async (t) => {
  const { device } = setup(t);
  const a = device('a'); const b = device('b');
  const id = addGuide(a.store);
  await synced(a.sync); await synced(b.sync);
  edit(a.store, id, 'Updated on A');
  await synced(a.sync); await synced(b.sync);
  assert.equal(b.store.getGuide(id).title, 'Updated on A');
  assert.equal(b.store.listGuides().length, 1);
  assert.equal(fs.readdirSync(path.join(b.sync.directory, 'backups')).length, 1);
});

test('edits to different steps on two computers end up in the one guide on both', async (t) => {
  const { device, files } = setup(t);
  const a = device('a'); const b = device('b');
  const id = addGuide(a.store, 3);
  await synced(a.sync); await synced(b.sync);
  const [first, , third] = a.store.getGuide(id).stepsOrder;
  editStep(a.store, id, first, { title: 'Edited on A' });
  editStep(b.store, id, third, { title: 'Edited on B' });
  await synced(a.sync);
  const status = await synced(b.sync);
  assert.equal(status.phase, 'synced');
  assert.match(status.message, /Combined changes from more than one computer in 1 guide\./);
  await synced(a.sync);
  for (const { store } of [a, b]) {
    assert.equal(store.listGuides().length, 1, 'no conflict copies');
    assert.equal(store.getStep(id, first).title, 'Edited on A');
    assert.equal(store.getStep(id, third).title, 'Edited on B');
  }
  assert.equal(snapshot(a.store, id).hash, snapshot(b.store, id).hash);
  assert.equal(headsOf(versionFiles(files)).length, 1, 'the cloud is back to one version');
  const count = files.length;
  for (let i = 0; i < 3; i++) { await synced(a.sync); await synced(b.sync); }
  assert.equal(files.length, count, 'later polls upload nothing');
});

test('when both computers change the same thing, the newest change wins and the other is kept under Backups', async (t) => {
  const { device } = setup(t);
  const a = device('a'); const b = device('b');
  const id = addGuide(a.store, 2);
  await synced(a.sync); await synced(b.sync);
  const [first, second] = a.store.getGuide(id).stepsOrder;
  edit(b.store, id, 'Older title from B');
  editStep(b.store, id, second, { status: 'done' });
  savedAt(b.store, id, '2030-01-01T10:00:00Z');
  edit(a.store, id, 'Newer title from A');
  savedAt(a.store, id, '2030-01-01T11:00:00Z');
  await synced(a.sync);
  const status = await synced(b.sync);
  assert.match(status.message, /newest change was kept/);
  await synced(a.sync);
  for (const { store } of [a, b]) {
    assert.equal(store.listGuides().length, 1);
    assert.equal(store.getGuide(id).title, 'Newer title from A');
    assert.equal(store.getStep(id, second).status, 'done', 'a change only B made is kept');
    assert.equal(store.getStep(id, first).title, 'Step 1');
  }
  const [backup] = listSnapshots(b.store, id).filter((name) => name.includes('before-sync-merge'));
  assert.ok(backup, 'B keeps its version from before the merge');
  restoreSnapshot(b.store, id, backup);
  assert.equal(b.store.getGuide(id).title, 'Older title from B');
});

test('concurrent uploads based on the same version are merged back into one version', async (t) => {
  const { device, drive, files } = setup(t);
  const a = device('a'); const b = device('b');
  const id = addGuide(a.store, 2);
  await synced(a.sync); await synced(b.sync);
  const [first, second] = a.store.getGuide(id).stepsOrder;
  const staleListing = [...files];
  edit(a.store, id, 'A concurrent');
  editStep(a.store, id, first, { title: 'Step edited on A' });
  savedAt(a.store, id, '2030-01-01T10:00:00Z');
  edit(b.store, id, 'B concurrent');
  editStep(b.store, id, second, { title: 'Step edited on B' });
  savedAt(b.store, id, '2030-01-01T11:00:00Z');
  await synced(a.sync);
  const list = drive.listVersions;
  drive.listVersions = async () => staleListing.filter((file) => file.appProperties?.stepforge === 'guide-v1');
  await synced(b.sync);
  drive.listVersions = list;
  assert.equal(headsOf(versionFiles(files)).length, 2, 'two branches in the cloud');
  await synced(a.sync); await synced(b.sync);
  for (const { store } of [a, b]) {
    assert.equal(store.listGuides().length, 1, 'no conflict copies');
    assert.equal(store.getGuide(id).title, 'B concurrent', 'the newer title');
    assert.equal(store.getStep(id, first).title, 'Step edited on A');
    assert.equal(store.getStep(id, second).title, 'Step edited on B');
  }
  assert.equal(snapshot(a.store, id).hash, snapshot(b.store, id).hash);
  assert.equal(headsOf(versionFiles(files)).length, 1, 'the merge closes the branch');
  const count = files.length;
  for (let i = 0; i < 3; i++) { await synced(a.sync); await synced(b.sync); }
  assert.equal(files.length, count);
});

test('concurrent uploads merge back into one version even when the merge equals the newest one', async (t) => {
  const { device, drive, files } = setup(t);
  const a = device('a'); const b = device('b');
  const id = addGuide(a.store, 1);
  await synced(a.sync); await synced(b.sync);
  const staleListing = [...files];
  // Only the title changes on both, so the merged guide is exactly B's newer version.
  edit(a.store, id, 'Older title from A');
  savedAt(a.store, id, '2030-01-01T10:00:00Z');
  edit(b.store, id, 'Newer title from B');
  savedAt(b.store, id, '2030-01-01T11:00:00Z');
  await synced(a.sync);
  const list = drive.listVersions;
  drive.listVersions = async () => staleListing.filter((file) => file.appProperties?.stepforge === 'guide-v1');
  await synced(b.sync);
  drive.listVersions = list;
  assert.equal(headsOf(versionFiles(files)).length, 2, 'two branches in the cloud');
  await synced(a.sync); await synced(b.sync); await synced(a.sync);
  for (const { store } of [a, b]) assert.equal(store.getGuide(id).title, 'Newer title from B');
  assert.equal(snapshot(a.store, id).hash, snapshot(b.store, id).hash);
  assert.equal(headsOf(versionFiles(files)).length, 1, 'the merge closes the branch');
  const count = files.length;
  for (let i = 0; i < 3; i++) { await synced(a.sync); await synced(b.sync); }
  assert.equal(files.length, count, 'later polls upload nothing');
  assert.equal(headsOf(versionFiles(files)).length, 1);
});

test('added, deleted and reordered steps merge, and a step edited on one computer survives deletion on the other', async (t) => {
  const { device } = setup(t);
  const a = device('a'); const b = device('b');
  const id = addGuide(a.store, 4);
  await synced(a.sync); await synced(b.sync);
  const [s1, s2, s3, s4] = a.store.getGuide(id).stepsOrder;
  // A: add a step after s1, delete s3, edit s4.
  const added = a.store.addStep(id, { title: 'Added on A' }, TINY_PNG, { width: 1, height: 1 }, { position: 1 }).stepId;
  a.store.deleteStep(id, s3);
  editStep(a.store, id, s4, { title: 'Step 4 kept' });
  // B: delete s4 (edited on A), move s2 to the end.
  b.store.deleteStep(id, s4);
  b.store.reorderSteps(id, [s1, s3, s2]);
  await synced(a.sync); await synced(b.sync); await synced(a.sync);
  for (const { store } of [a, b]) {
    // B's order wins (only B reordered); A's new step and kept step slot in after their neighbours on A.
    assert.deepEqual(store.getGuide(id).stepsOrder, [s1, added, s2, s4]);
    assert.equal(store.listSteps(id).size, 4);
    assert.equal(store.getStep(id, s4).title, 'Step 4 kept');
    assert.ok(!store.listSteps(id).has(s3), 'deleted on A and untouched on B');
  }
  assert.equal(snapshot(a.store, id).hash, snapshot(b.store, id).hash);
});

test('annotations added on both computers, and a new screenshot with new text, are all kept', async (t) => {
  const { device } = setup(t);
  const a = device('a'); const b = device('b');
  const id = addGuide(a.store, 1);
  await synced(a.sync); await synced(b.sync);
  const [stepId] = a.store.getGuide(id).stepsOrder;
  const screenshot = Buffer.concat([TINY_PNG, Buffer.from('new screenshot')]);
  const stepA = a.store.getStep(id, stepId);
  stepA.annotations.push({ id: 'ann-a', type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  a.store.replaceImages(id, stepId, { original: screenshot }, { width: 2, height: 2 }, stepA);
  const stepB = b.store.getStep(id, stepId);
  stepB.annotations.push({ id: 'ann-b', type: 'arrow', x: 0.5, y: 0.5, w: 0.1, h: 0.1 });
  stepB.descriptionHtml = '<p>Written on B</p>';
  b.store.saveStep(id, stepB);
  await synced(a.sync); await synced(b.sync); await synced(a.sync);
  for (const { store } of [a, b]) {
    const step = store.getStep(id, stepId);
    assert.deepEqual(step.annotations.map((ann) => ann.id).sort(), ['ann-a', 'ann-b']);
    assert.equal(step.descriptionHtml, '<p>Written on B</p>');
    assert.deepEqual(step.image.size, { width: 2, height: 2 });
    assert.deepEqual(fs.readFileSync(store.stepImagePath(id, stepId, 'original')), screenshot);
    assert.deepEqual(fs.readFileSync(store.stepImagePath(id, stepId, 'working')), screenshot);
  }
});

test('when both computers replace the same screenshot, the newest one is kept whole', async (t) => {
  const { device } = setup(t);
  const a = device('a'); const b = device('b');
  const id = addGuide(a.store, 1);
  await synced(a.sync); await synced(b.sync);
  const [stepId] = a.store.getGuide(id).stepsOrder;
  const original = fs.readFileSync(a.store.stepImagePath(id, stepId, 'original'));
  // B crops (new working image only) and changes the height; A, saved later,
  // replaces the whole screenshot and changes the width.
  const cropped = Buffer.concat([TINY_PNG, Buffer.from('cropped on B')]);
  b.store.setWorkingImage(id, stepId, cropped, { width: 1, height: 3 });
  savedAt(b.store, id, '2030-01-01T10:00:00Z');
  const replaced = Buffer.concat([TINY_PNG, Buffer.from('replaced on A')]);
  a.store.replaceImages(id, stepId, { original: replaced }, { width: 2, height: 1 });
  savedAt(a.store, id, '2030-01-01T11:00:00Z');
  await synced(a.sync);
  const status = await synced(b.sync);
  assert.match(status.message, /newest change was kept/);
  await synced(a.sync);
  for (const { store } of [a, b]) {
    const step = store.getStep(id, stepId);
    assert.deepEqual(step.image.size, { width: 2, height: 1 }, 'size of the kept screenshot, not a mix');
    assert.deepEqual(fs.readFileSync(store.stepImagePath(id, stepId, 'original')), replaced);
    assert.deepEqual(fs.readFileSync(store.stepImagePath(id, stepId, 'working')), replaced);
    assert.notDeepEqual(fs.readFileSync(store.stepImagePath(id, stepId, 'original')), original);
  }
  assert.equal(snapshot(a.store, id).hash, snapshot(b.store, id).hash);
});

test('local edits merge against the remembered version when the cloud no longer has it', async (t) => {
  const { device, files } = setup(t);
  const a = device('a'); const b = device('b');
  const id = addGuide(a.store, 3);
  await synced(a.sync); await synced(b.sync);
  const [, second, third] = a.store.getGuide(id).stepsOrder;
  a.store.deleteStep(id, third);
  await synced(a.sync);
  // More versions than are kept, so the one B last saw is removed.
  for (let i = 1; i <= 4; i++) { edit(a.store, id, `A edit ${i}`); await synced(a.sync); }
  assert.ok(!versionFiles(files).some((file) => file.id === b.sync.state.records[id].head));
  b.sync.state.records[id].syncedAt = 0; // long enough ago that it isn't Drive lagging
  editStep(b.store, id, second, { title: 'Edited on B' });
  await synced(b.sync); await synced(a.sync);
  for (const { store } of [a, b]) {
    assert.equal(store.listGuides().length, 1);
    assert.equal(store.getGuide(id).title, 'A edit 4');
    assert.equal(store.getStep(id, second).title, 'Edited on B');
    assert.ok(!store.listSteps(id).has(third), 'the step A deleted stays deleted');
  }
});

test('updates from another computer keep this computer\'s backups', async (t) => {
  const { device } = setup(t);
  const a = device('a'); const b = device('b');
  const id = addGuide(a.store);
  await synced(a.sync); await synced(b.sync);
  const backup = createSnapshot(b.store, id, { label: 'manual' });
  edit(a.store, id, 'Updated on A');
  await synced(a.sync); await synced(b.sync);
  assert.equal(b.store.getGuide(id).title, 'Updated on A');
  assert.deepEqual(listSnapshots(b.store, id), [backup]);
});

test('incoming changes wait while editor is active, then load after it closes', async (t) => {
  const { device } = setup(t);
  const a = device('a'); let active = false;
  const b = device('b', { canReplace: () => !active });
  const id = addGuide(a.store);
  await synced(a.sync); await synced(b.sync);
  active = true;
  edit(a.store, id, 'Incoming'); await synced(a.sync);
  assert.equal((await synced(b.sync)).phase, 'pending');
  assert.equal(b.store.getGuide(id).title, 'Original');
  active = false; await synced(b.sync);
  assert.equal(b.store.getGuide(id).title, 'Incoming');
});

test('an edit arriving during download is not overwritten', async (t) => {
  const { device, drive } = setup(t);
  const a = device('a'); const b = device('b');
  const id = addGuide(a.store);
  await synced(a.sync); await synced(b.sync);
  edit(a.store, id, 'Remote'); await synced(a.sync);
  const download = drive.download;
  drive.download = async (file) => { edit(b.store, id, 'Just typed'); return download(file); };
  assert.equal((await synced(b.sync)).phase, 'pending');
  assert.equal(b.store.getGuide(id).title, 'Just typed');
});

test('edit settling delays uploads and multiple sync callers share one run', async (t) => {
  const { device, files } = setup(t);
  const { store, sync } = device('a', { settleMs: 3000 });
  const id = addGuide(store); sync.markChanged(id);
  const first = sync.sync(); assert.equal(sync.sync(), first);
  assert.equal((await first).phase, 'pending');
  assert.equal(files.length, 0);
  sync.changedAt.set(id, Date.now() - 4000);
  await synced(sync); assert.equal(files.length, 1);
});

test('bad downloads never replace a local guide', async (t) => {
  const { device, bytes, files } = setup(t);
  const a = device('a'); const b = device('b');
  const id = addGuide(a.store);
  await synced(a.sync); await synced(b.sync);
  edit(a.store, id, 'Remote'); await synced(a.sync);
  bytes.set(files.at(-1).id, Buffer.from('broken zip'));
  assert.equal((await b.sync.sync()).phase, 'error');
  assert.equal(b.store.getGuide(id).title, 'Original');
});

test('advertised hash mismatch leaves local data intact', async (t) => {
  const { device, files } = setup(t);
  const a = device('a'); const b = device('b');
  const id = addGuide(a.store); await synced(a.sync); await synced(b.sync);
  edit(a.store, id, 'Remote'); await synced(a.sync);
  files.at(-1).appProperties.hash = 'a'.repeat(64);
  const status = await b.sync.sync();
  assert.equal(status.phase, 'error'); assert.match(status.message, /integrity/);
  assert.equal(b.store.getGuide(id).title, 'Original');
});

test('network failure preserves local edits and retry uploads them', async (t) => {
  const { device, drive, files } = setup(t);
  const { store, sync } = device('a'); const id = addGuide(store);
  const upload = drive.upload;
  drive.upload = async () => { throw new Error('Offline'); };
  assert.equal((await sync.sync()).phase, 'error');
  assert.equal(store.getGuide(id).title, 'Original');
  drive.upload = upload; await synced(sync); assert.equal(files.length, 1);
});

test('disabling during a download stops installation', async (t) => {
  const { device, drive } = setup(t);
  const a = device('a'); let enabled = true;
  const b = device('b', { enabled: () => enabled });
  const id = addGuide(a.store); await synced(a.sync);
  const download = drive.download;
  drive.download = async (file) => { enabled = false; b.sync.stop(); return download(file); };
  assert.equal((await b.sync.sync()).phase, 'off');
  assert.equal(b.store.guideExists(id), false);
});

test('local trash is not silently restored or propagated to other devices', async (t) => {
  const { device } = setup(t);
  const a = device('a'); const b = device('b');
  const id = addGuide(a.store); await synced(a.sync); await synced(b.sync);
  b.store.deleteGuide(id); await synced(b.sync); await synced(a.sync);
  assert.equal(b.store.guideExists(id), false);
  assert.equal(a.store.guideExists(id), true);
});

test('interrupted replacement restores the previous guide from its journal', (t) => {
  const { device } = setup(t); const a = device('a');
  const id = addGuide(a.store);
  const backup = `${id}-interrupted`;
  fs.mkdirSync(path.join(a.sync.directory, 'backups'), { recursive: true });
  fs.renameSync(a.store.guideDir(id), path.join(a.sync.directory, 'backups', backup));
  writeJsonSync(path.join(a.sync.directory, 'install.json'), { guideId: id, backup });
  a.sync.recover();
  assert.equal(a.store.getGuide(id).title, 'Original');
});

test('delayed Drive listings cannot roll a guide back to an earlier version', async (t) => {
  const { device, drive, files } = setup(t); const a = device('a');
  const id = addGuide(a.store); await synced(a.sync);
  const old = [...files];
  edit(a.store, id, 'Newer'); await synced(a.sync);
  drive.listVersions = async () => old;
  assert.equal((await synced(a.sync)).phase, 'pending');
  assert.equal(a.store.getGuide(id).title, 'Newer');
});

test('a failed guide does not block other guide uploads', async (t) => {
  const { device, drive, files } = setup(t); const a = device('a');
  const bad = addGuide(a.store); const good = addGuide(a.store);
  const upload = drive.upload;
  drive.upload = async (args) => {
    if (args.properties.guideId === bad) throw new Error('Quota or transfer error');
    return upload.call(drive, args);
  };
  assert.equal((await a.sync.sync()).phase, 'error');
  assert.ok(files.some((f) => f.appProperties.guideId === good));
  assert.equal(a.store.listGuides().length, 2);
});

test('unsaved editor input prevents reporting a partially saved guide as uploaded', async (t) => {
  const { device, files } = setup(t); let dirty = true;
  const a = device('a', { canUpload: () => !dirty }); addGuide(a.store);
  assert.equal((await synced(a.sync)).phase, 'pending'); assert.equal(files.length, 0);
  dirty = false; await synced(a.sync); assert.equal(files.length, 1);
});

test('Drive retention keeps the current snapshot and two prior snapshots', async (t) => {
  const { device, files } = setup(t); const a = device('a');
  const id = addGuide(a.store); await synced(a.sync);
  for (const title of ['Second', 'Third', 'Fourth']) {
    edit(a.store, id, title); await synced(a.sync);
  }
  const versions = files.filter((file) => file.appProperties.guideId === id);
  assert.equal(versions.length, 3);
  assert.deepEqual(versions.map((file) => file.name), ['Second.sfgz', 'Third.sfgz', 'Fourth.sfgz']);
  const usage = await a.sync.storage();
  assert.equal(usage.snapshotCount, 3);
  assert.equal(usage.pruneCount, 2);
  assert.equal(usage.bytes, usage.latestBytes + usage.previousBytes);
});

test('manual pruning keeps only the latest snapshot of every guide', async (t) => {
  const { device, files } = setup(t); const a = device('a');
  const id = addGuide(a.store); await synced(a.sync);
  for (const title of ['Second', 'Third']) { edit(a.store, id, title); await synced(a.sync); }
  const other = addGuide(a.store); await synced(a.sync);
  const result = await a.sync.prune();
  assert.equal(result.pruned, 2);
  assert.deepEqual(files.filter((file) => file.appProperties.guideId === id).map((file) => file.name), ['Third.sfgz']);
  assert.equal(files.filter((file) => file.appProperties.guideId === other).length, 1);
  assert.equal((await a.sync.storage()).pruneCount, 0);
  assert.equal(a.store.getGuide(id).title, 'Third');
});

test('a device whose baseline was pruned remotely catches up instead of waiting forever', async (t) => {
  const { device } = setup(t); const a = device('a'); const b = device('b');
  const id = addGuide(a.store); await synced(a.sync); await synced(b.sync);
  for (const title of ['Second', 'Third', 'Fourth']) { edit(a.store, id, title); await synced(a.sync); }
  await a.sync.prune();
  assert.equal((await synced(b.sync)).phase, 'pending');
  const record = b.sync.state.records[id];
  record.syncedAt = Date.now() - 10 * 60 * 1000;
  assert.equal((await synced(b.sync)).phase, 'synced');
  assert.equal(b.store.getGuide(id).title, 'Fourth');
});

test('storage separates deleted-guide recovery copies from live guides', async (t) => {
  const { device } = setup(t); const a = device('a');
  const kept = addGuide(a.store); const removed = addGuide(a.store); await synced(a.sync);
  assert.equal(a.sync.stageDeletion(removed), true);
  a.store.deleteGuide(removed); await synced(a.sync);
  const usage = await a.sync.storage();
  assert.equal(usage.guideCount, 1);
  assert.ok(usage.recoveryBytes >= 0);
  assert.equal(usage.snapshotCount, 2);
  assert.ok(a.store.guideExists(kept));
});

test('replacing Drive with this computer removes everything else and propagates to other devices', async (t) => {
  const { device, files } = setup(t); const a = device('a'); const b = device('b');
  const shared = addGuide(a.store); const elsewhere = addGuide(b.store);
  await synced(a.sync); await synced(b.sync); await synced(a.sync);
  const deleted = addGuide(a.store); await synced(a.sync);
  assert.equal(a.sync.stageDeletion(deleted), true);
  a.store.deleteGuide(deleted); await synced(a.sync);
  a.store.deleteGuide(elsewhere);
  edit(a.store, shared, 'Source of truth');
  const result = await a.sync.replaceCloudWithLocal();
  assert.equal(result.uploading, 1);
  const versions = files.filter((file) => file.appProperties.stepforge === 'guide-v1');
  assert.deepEqual(versions.map((file) => file.appProperties.guideId), [shared]);
  assert.equal(versions[0].appProperties.parent, undefined);
  const markers = files.filter((file) => file.appProperties.stepforge === 'deletion-v1');
  assert.deepEqual(markers.map((file) => file.appProperties.state).sort(), ['purged', 'purged']);
  for (const record of Object.values(b.sync.state.records)) record.syncedAt = 0;
  await synced(b.sync);
  assert.equal(b.store.guideExists(elsewhere), false);
  assert.equal(b.store.getGuide(shared).title, 'Source of truth');
  assert.deepEqual((await b.sync.guides()).map((guide) => guide.guideId), [shared]);
});

test('replacing Drive requires automatic sync to be on', async (t) => {
  const { device, files } = setup(t); const a = device('a');
  addGuide(a.store); await synced(a.sync);
  const off = device('off', { enabled: () => false });
  await assert.rejects(off.sync.replaceCloudWithLocal(), /Turn on automatic sync/);
  assert.equal(files.length, 1);
});

test('guide cloud opt-out stops uploads and removing cloud copies leaves the guide local', async (t) => {
  const { device, files } = setup(t); const a = device('a');
  const id = addGuide(a.store); await synced(a.sync);
  await a.sync.setSharing(id, false);
  edit(a.store, id, 'Private'); await synced(a.sync);
  assert.equal(files.length, 1);
  const result = await a.sync.removeGuideSnapshots(id);
  assert.equal(result.removed, 1);
  assert.equal(a.store.guideExists(id), true);
  assert.equal(a.store.getGuide(id).cloud.sharingEnabled, false);
  assert.equal(files.length, 0);
});

test('a retained previous cloud snapshot can be restored', async (t) => {
  const { device } = setup(t); const a = device('a');
  const id = addGuide(a.store); await synced(a.sync);
  edit(a.store, id, 'Changed'); await synced(a.sync);
  const history = await a.sync.history(id);
  assert.equal(history.length, 2);
  await a.sync.restore(id, history[1].id);
  assert.equal(a.store.getGuide(id).title, 'Original');
});

test('a shared guide deletion reaches another device and leaves one cloud recovery snapshot', async (t) => {
  const { device, files } = setup(t); const a = device('a'); const b = device('b');
  const id = addGuide(a.store); await synced(a.sync); await synced(b.sync);
  assert.equal(a.sync.stageDeletion(id), true);
  a.store.deleteGuide(id); await synced(a.sync); await synced(b.sync);
  assert.equal(a.store.guideExists(id), false);
  assert.equal(b.store.guideExists(id), false);
  const recovery = files.filter((file) => file.appProperties?.guideId === id && file.appProperties?.stepforge === 'guide-v1');
  assert.equal(recovery.length, 1);
  const deleted = await a.sync.deletedGuides();
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].recoveryId, recovery[0].id);
});

test('a permanent deletion record prevents a stale device from recreating a guide', async (t) => {
  const { device, files } = setup(t); const a = device('a'); const stale = device('stale');
  const id = addGuide(a.store); await synced(a.sync); await synced(stale.sync);
  assert.equal(a.sync.stageDeletion(id), true);
  a.store.deleteGuide(id); await synced(a.sync);
  await a.sync.permanentlyDeleteRecovery(id);
  await synced(stale.sync);
  assert.equal(stale.store.guideExists(id), false);
  assert.equal(files.filter((file) => file.appProperties?.guideId === id && file.appProperties?.stepforge === 'guide-v1').length, 0);
  assert.equal((await a.sync.deletedGuides())[0].purged, true);
});

test('restoring a deleted cloud guide makes it available to another device again', async (t) => {
  const { device } = setup(t); const a = device('a'); const b = device('b');
  const id = addGuide(a.store); await synced(a.sync); await synced(b.sync);
  a.sync.stageDeletion(id); a.store.deleteGuide(id); await synced(a.sync); await synced(b.sync);
  await a.sync.restoreDeletedGuide(id); await synced(a.sync); await synced(b.sync);
  assert.equal(a.store.getGuide(id).title, 'Original');
  assert.equal(b.store.getGuide(id).title, 'Original');
  assert.deepEqual(await a.sync.deletedGuides(), []);
});

test('backup history changes do not invalidate cached cloud content', (t) => {
  const { device } = setup(t);
  const { store, sync } = device('a');
  const id = addGuide(store);
  const before = sync.localSnapshot(id).hash;
  const cached = sync.fingerprints.get(id);
  writeJsonSync(path.join(store.guideDir(id), 'history', 'autosave-counter.json'), { count: 5 });
  assert.equal(sync.localSnapshot(id).hash, before);
  assert.equal(sync.fingerprints.get(id), cached);
  edit(store, id, 'Real edit');
  assert.notEqual(sync.localSnapshot(id).hash, before);
});

test('stopping sync while the archive worker runs prevents upload', async (t) => {
  const { device, files } = setup(t);
  let sync;
  const a = device('a', { canUpload: () => {
    setImmediate(() => sync.stop());
    return true;
  } });
  sync = a.sync;
  addGuide(a.store);
  await sync.sync();
  assert.equal(files.length, 0);
});

test('edits during archive encoding remain pending and the uploaded hash matches its bytes', async (t) => {
  const { device, files } = setup(t);
  let a, id, scheduled = false;
  a = device('a', { canUpload: () => {
    if (!scheduled) {
      scheduled = true;
      setImmediate(() => edit(a.store, id, 'Edited during encoding'));
    }
    return true;
  } });
  id = addGuide(a.store);
  await synced(a.sync);
  assert.equal(files.length, 1);
  a.sync.validateDownload(await a.sync.downloadVersion(files[0]), id, files[0].appProperties.hash);
  assert.notEqual(snapshot(a.store, id).hash, files[0].appProperties.hash);
  await synced(a.sync);
  assert.equal(files.length, 2);
  assert.equal(snapshot(a.store, id).hash, files[1].appProperties.hash);
});

test('Drive guide browser lists local and cloud-only guides with all available versions', async (t) => {
  const { device, files } = setup(t); const a = device('a'); const b = device('b');
  a.sync.prune = async () => ({});
  const id = addGuide(a.store); await synced(a.sync);
  for (let i = 0; i < 4; i++) { edit(a.store, id, `Revision ${i}`); await synced(a.sync); }
  const local = await a.sync.guides(); const remote = await b.sync.guides();
  assert.equal(local.length, 1);
  assert.equal(local[0].local, true);
  assert.equal(remote[0].local, false);
  assert.equal(remote[0].guideId, id);
  assert.equal(remote[0].snapshotCount, files.length);
  assert.equal((await b.sync.history(id)).length, files.length);
  assert.equal(a.sync.stageDeletion(id), true);
  a.store.deleteGuide(id); await synced(a.sync);
  assert.equal((await b.sync.guides()).length, 0);
  assert.equal((await b.sync.deletedGuides()).length, 1);
});

test('cloud-only snapshots can be deleted without creating or deleting local guides', async (t) => {
  const { device } = setup(t); const a = device('a'); const b = device('b');
  const id = addGuide(a.store); await synced(a.sync);
  assert.equal((await b.sync.removeGuideSnapshots(id)).removed, 1);
  assert.equal(b.store.guideExists(id), false);
  assert.equal(a.store.guideExists(id), true);
  assert.equal((await b.sync.guides()).length, 0);
});

test('restored snapshot stays restored through sync and reaches another device', async (t) => {
  const { device } = setup(t); const a = device('a'); const b = device('b');
  const id = addGuide(a.store); await synced(a.sync); await synced(b.sync);
  edit(a.store, id, 'Newer'); await synced(a.sync); await synced(b.sync);
  const history = await a.sync.history(id);
  await a.sync.restore(id, history[1].id);
  await synced(a.sync); await synced(b.sync);
  assert.equal(a.store.getGuide(id).title, 'Original');
  assert.equal(b.store.getGuide(id).title, 'Original');
  assert.equal(a.store.listGuides().length, 1);
});

test('restore before the first sync preserves its baseline and local sharing opt-out', async (t) => {
  const { device } = setup(t); const a = device('a'); const b = device('b', { enabled: () => false });
  const id = addGuide(a.store); await synced(a.sync);
  edit(a.store, id, 'Newer'); await synced(a.sync);
  const history = await b.sync.history(id);
  await b.sync.restore(id, history[1].id);
  assert.equal(b.store.getGuide(id).title, 'Original');
  await b.sync.setSharing(id, false);
  await b.sync.restore(id, history[0].id);
  assert.equal(b.store.getGuide(id).cloud.sharingEnabled, false);
  assert.equal(b.store.getGuide(id).title, 'Newer');
});

test('manual deletion waits for an in-flight upload and prevents a racing sync', async (t) => {
  const { device, drive } = setup(t); const a = device('a');
  const id = addGuide(a.store);
  const upload = drive.upload.bind(drive);
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  drive.upload = async (args) => { entered(); await gate; return upload(args); };
  const syncing = a.sync.sync(); await started;
  const removing = a.sync.removeGuideSnapshots(id);
  await a.sync.sync();
  release(); await syncing; await removing;
  assert.equal((await a.sync.guides()).length, 0);
  assert.equal(a.store.getGuide(id).cloud.sharingEnabled, false);
});

test('guide uploads and downloads publish live transfer progress, then clear it', async (t) => {
  const { device, drive } = setup(t);
  const upload = drive.upload.bind(drive);
  const download = drive.download.bind(drive);
  drive.upload = async (args) => {
    args.onProgress?.(Math.floor(args.data.length / 2)); args.onProgress?.(args.data.length);
    return Object.assign(await upload(args), { size: String(args.data.length) });
  };
  drive.download = async (id, { onProgress } = {}) => { const bytes = await download(id); onProgress?.(bytes.length); return bytes; };
  const seen = [];
  const a = device('a', { onStatus: (status) => seen.push(status) });
  const b = device('b', { onStatus: (status) => seen.push(status) });
  const id = addGuide(a.store);
  edit(a.store, id, 'Transfer me');
  await synced(a.sync);
  const uploads = seen.filter((status) => status.transfer?.direction === 'upload');
  assert.equal(uploads[0].phase, 'syncing');
  assert.deepEqual({ ...uploads.at(-1).transfer, bytesPerSecond: 0 },
    { direction: 'upload', name: 'Transfer me', loaded: uploads.at(-1).transfer.total, total: uploads.at(-1).transfer.total, bytesPerSecond: 0 });
  assert.ok(uploads.at(-1).transfer.total > 0);
  seen.length = 0;
  await synced(b.sync);
  const downloads = seen.filter((status) => status.transfer?.direction === 'download');
  assert.equal(downloads[0].transfer.name, 'Transfer me');
  assert.equal(downloads.at(-1).transfer.loaded, downloads.at(-1).transfer.total);
  assert.equal(a.sync.status.transfer, null);
  assert.equal(b.sync.status.transfer, null);
  assert.equal(seen.at(-1).phase, 'synced');
});

// ---- space-saving parts snapshots (core/cloud-parts.js) ---------------------

const { zipSync } = require('../../core/zip');
const { buildArchiveEntries } = require('../../core/archive');
// Small limits so the test screenshots become shared parts.
const PARTS = { inlineLimit: 1024, partGraceMs: 0 };
const shot = (seed) => Buffer.concat([TINY_PNG, Buffer.alloc(4000, seed)]);
const partFiles = (files) => files.filter((file) => file.appProperties?.stepforge === 'part-v1');
function addShotGuide(store) {
  const guide = store.createGuide({ title: 'Original' });
  const step = store.addStep(guide.guideId, { title: 'Screenshot' }, shot(1), { width: 1, height: 1 });
  return { id: guide.guideId, stepId: step.stepId };
}
const setShot = (store, id, stepId, seed) => store.setWorkingImage(id, stepId, shot(seed), { width: 1, height: 1 });
// Logs what moves: 'part' for a shared screenshot, else the version's format.
function recordTransfers(drive, files) {
  const log = { uploads: [], downloads: [] };
  const kind = (properties) => (properties?.stepforge === 'part-v1' ? 'part' : properties?.format || 'full');
  const upload = drive.upload.bind(drive);
  const download = drive.download.bind(drive);
  drive.upload = async (args) => { log.uploads.push(kind(args.properties)); return upload(args); };
  drive.download = async (id, options) => { log.downloads.push(kind(files.find((file) => file.id === id)?.appProperties)); return download(id, options); };
  return log;
}
const partDownloads = (log) => log.downloads.filter((kind) => kind === 'part').length;

test('versions share unchanged screenshots, and each sync only moves what changed', async (t) => {
  const { device, drive, files } = setup(t);
  const log = recordTransfers(drive, files);
  const a = device('a', PARTS);
  const { id, stepId } = addShotGuide(a.store);
  await synced(a.sync);
  assert.equal(versionFiles(files).length, 1);
  assert.equal(versionFiles(files)[0].appProperties.format, 'parts-v1', 'new versions store changes only, by default');
  assert.equal(partFiles(files).length, 1, 'original.png and working.png are the same screenshot, stored once');

  log.uploads.length = 0;
  edit(a.store, id, 'Renamed');
  await synced(a.sync);
  assert.deepEqual(log.uploads, ['parts-v1'], 'a text edit uploads no screenshots');
  setShot(a.store, id, stepId, 2);
  log.uploads.length = 0;
  await synced(a.sync);
  assert.deepEqual(log.uploads, ['part', 'parts-v1'], 'a changed screenshot uploads just that screenshot');
  assert.equal(partFiles(files).length, 2);

  const b = device('b', PARTS);
  log.downloads.length = 0;
  await synced(b.sync);
  assert.equal(snapshot(b.store, id).hash, snapshot(a.store, id).hash);
  assert.equal(partDownloads(log), 2, 'the two screenshots, once each');

  edit(a.store, id, 'Renamed again');
  await synced(a.sync);
  log.downloads.length = 0;
  await synced(b.sync);
  assert.equal(b.store.getGuide(id).title, 'Renamed again');
  assert.equal(partDownloads(log), 0, 'screenshots this computer already has are not downloaded again');

  const history = await b.sync.history(id);
  assert.equal(history[0].size, buildArchiveEntries(b.store, id).reduce((n, e) => n + Buffer.byteLength(e.data), 0),
    'history shows each version’s full size');
});

test('an earlier version can be restored after its screenshot changed', async (t) => {
  const { device, files } = setup(t);
  const a = device('a', PARTS);
  const { id, stepId } = addShotGuide(a.store);
  await synced(a.sync);
  const first = versionFiles(files)[0];
  setShot(a.store, id, stepId, 2);
  await synced(a.sync);

  const b = device('b', PARTS);
  await b.sync.restore(id, first.id);
  assert.deepEqual(fs.readFileSync(b.store.stepImagePath(id, stepId)), shot(1));
  assert.equal(snapshot(b.store, id).hash, first.appProperties.hash);
});

test('files no version uses are removed, but shared and just-uploaded files are kept', async (t) => {
  const { device, drive, files } = setup(t);
  const a = device('a', PARTS);
  const { id, stepId } = addShotGuide(a.store);
  await synced(a.sync);
  for (const seed of [2, 3, 4]) { setShot(a.store, id, stepId, seed); await synced(a.sync); }
  assert.equal(versionFiles(files).length, 3, 'automatic pruning still keeps three versions');
  assert.equal(partFiles(files).length, 4, 'the first screenshot is still used by original.png');

  const result = await a.sync.prune();
  assert.equal(versionFiles(files).length, 1);
  const kept = new Set(partFiles(files).map((file) => file.appProperties.sha));
  const { sha256 } = require('../../core/cloud-parts');
  assert.deepEqual(kept, new Set([sha256(shot(1)), sha256(shot(4))]), 'screenshots only earlier versions used are gone');
  assert.ok(result.reclaimedBytes >= 2 * shot(2).length);

  // Another computer's upload in progress: a part with no version yet.
  const fresh = await drive.upload({ data: shot(9), name: 'part-fresh', properties: { stepforge: 'part-v1', sha: sha256(shot(9)) } });
  fresh.createdTime = new Date().toISOString();
  const stale = await drive.upload({ data: shot(8), name: 'part-stale', properties: { stepforge: 'part-v1', sha: sha256(shot(8)) } });
  const c = device('c', { inlineLimit: 1024 });
  await c.sync.prune();
  assert.ok(files.includes(fresh), 'a part younger than the grace period is kept');
  assert.ok(!files.includes(stale), 'an old unused part is removed');
});

test('Free up space converts full-copy versions, and other computers just move their baseline', async (t) => {
  const { device, drive, files } = setup(t);
  const log = recordTransfers(drive, files);
  const a = device('a', PARTS);
  const b = device('b', PARTS);
  const { id } = addShotGuide(a.store);
  a.sync.markWasShared(id);
  // A version saved by an older StepForge: one full .sfgz archive.
  const legacy = await drive.upload({ data: zipSync(buildArchiveEntries(a.store, id)), name: 'Original.sfgz',
    properties: { stepforge: 'guide-v1', guideId: id, hash: snapshot(a.store, id).hash } });
  await synced(a.sync);
  await synced(b.sync);
  assert.deepEqual(versionFiles(files), [legacy], 'nothing re-uploads unchanged content');
  const before = (await a.sync.storage()).fullCount;
  assert.equal(before, 1, 'storage reports the version that can be converted');

  edit(b.store, id, 'Edited on B before it heard about the conversion');
  const result = await a.sync.prune();
  assert.equal(result.converted, 1);
  const [converted] = versionFiles(files);
  assert.equal(converted.appProperties.format, 'parts-v1');
  assert.equal(converted.appProperties.hash, legacy.appProperties.hash);
  assert.equal(converted.appProperties.parent, legacy.id);
  assert.ok(!files.includes(legacy));
  assert.equal((await a.sync.storage()).fullCount, 0);

  log.downloads.length = 0;
  await synced(a.sync);
  assert.deepEqual(log.downloads, [], 'this computer already knows the converted version');
  log.downloads.length = 0;
  await synced(b.sync);
  assert.equal(b.store.listGuides().length, 1, 'no conflict copy for a conversion');
  assert.equal(versionFiles(files).at(-1).appProperties.parent, converted.id, 'B’s edit continues from the converted version');
  await synced(a.sync);
  assert.equal(a.store.getGuide(id).title, 'Edited on B before it heard about the conversion');
});

test('storage counts shared screenshots once and knows what Free up space can reclaim', async (t) => {
  const { device, files } = setup(t);
  const a = device('a', PARTS);
  const { id, stepId } = addShotGuide(a.store);
  await synced(a.sync);
  const first = versionFiles(files)[0];
  setShot(a.store, id, stepId, 2);
  await synced(a.sync);
  const storage = await a.sync.storage();
  const total = [...versionFiles(files), ...partFiles(files)].reduce((n, file) => n + Number(file.size), 0);
  assert.equal(storage.bytes, total);
  assert.equal(storage.pruneCount, 1);
  assert.equal(storage.previousBytes, Number(first.size), 'the first screenshot is shared with the latest version, so only its manifest is reclaimable');
  assert.equal(storage.fullCount, 0);
  const [guide] = await a.sync.guides();
  assert.equal(guide.bytes, total, 'a guide’s shared screenshots count once');
});

test('a version missing one of its files fails clearly and leaves this computer alone', async (t) => {
  const { device, drive, files } = setup(t);
  const a = device('a', PARTS);
  addShotGuide(a.store);
  await synced(a.sync);
  await drive.deleteFile(partFiles(files)[0].id);
  const b = device('b', PARTS);
  const status = await b.sync.sync();
  assert.equal(status.phase, 'error');
  assert.match(status.message, /missing some of its files/);
  assert.equal(b.store.listGuides().length, 0);
});

test('a shared file another computer removed during an upload is put back', async (t) => {
  const { device, drive, files } = setup(t);
  const a = device('a', PARTS);
  const { id } = addShotGuide(a.store);
  await synced(a.sync);
  const upload = drive.upload.bind(drive);
  drive.upload = async (args) => {
    // Just before the manifest lands, the part it reuses disappears.
    if (args.properties?.format === 'parts-v1') for (const part of partFiles(files)) await drive.deleteFile(part.id);
    return upload(args);
  };
  edit(a.store, id, 'Reuses the screenshot');
  await synced(a.sync);
  assert.equal(partFiles(files).length, 1);
  const b = device('b', PARTS);
  await synced(b.sync);
  assert.equal(snapshot(b.store, id).hash, snapshot(a.store, id).hash);
});
