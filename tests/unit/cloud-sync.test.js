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
const parts = require('../../core/cloud-parts');
const { makeTmpDir, rmrf, TINY_PNG } = require('./helpers');

function setup(t, { idLength = 0 } = {}) {
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
      const file = { id: `file-${++nextFileId}`.padEnd(idLength, '_'), name, appProperties: properties, size: String(data.length),
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

test('merge base follows ancestry despite clock skew and breaks criss-cross ties deterministically', async (t) => {
  const { device } = setup(t); const { store, sync } = device('a');
  const id = addGuide(store);
  const entries = snapshot(store, id).entries;
  const version = (id, parent, merged = '', createdTime = '2026-01-01') => ({ id, createdTime,
    appProperties: { hash: parts.contentHash(entries), parent, merged } });
  const old = version('old', null, '', '2099-01-01');
  const base = version('base', 'old');
  const left = version('left', 'base'); const right = version('right', 'base');
  const fetched = [];
  sync.versionEntries = async file => { fetched.push(file.id); return entries; };
  assert.deepEqual(await sync.mergeBase(sync.basePath(id), [old, base, left, right], [left, right]), entries);
  assert.deepEqual(fetched, ['base']);
  const x = version('x', 'old'), y = version('y', 'old');
  const a = version('a', 'x', 'y'), b = version('b', 'y', 'x');
  for (const versions of [[old, x, y, a, b], [b, a, y, x, old]]) {
    await sync.mergeBase(sync.basePath(id), versions, [a, b]);
    assert.equal(fetched.at(-1), 'y');
  }
  assert.equal(await sync.mergeBase(sync.basePath(id), [], []), null);
  assert.equal(await sync.mergeBase(sync.basePath(id), [left, right], [left, right]), null);
  const cycleA = version('cycleA', 'cycleB'), cycleB = version('cycleB', 'cycleA');
  await assert.rejects(sync.mergeBase(sync.basePath(id), [cycleA, cycleB], [cycleA, cycleB]), /cycle/);
});

test('a corrupt remembered base is discarded and a verified cloud base preserves deletions', async (t) => {
  const { device } = setup(t); const a = device('a'), b = device('b');
  const id = addGuide(a.store, 3); await synced(a.sync); await synced(b.sync);
  const [first, , third] = a.store.getGuide(id).stepsOrder;
  const cacheFile = b.sync.basePath(id);
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const entry = cache.entries.find(entry => entry.name === `steps/${third}/step.json`);
  entry.data = Buffer.from('{"title":"corrupted"}').toString('base64');
  writeJsonSync(cacheFile, cache);
  a.store.deleteStep(id, third); editStep(b.store, id, first, { title: 'Offline edit' });
  await synced(a.sync); await synced(b.sync); await synced(a.sync);
  assert.ok(!b.store.listSteps(id).has(third));
  assert.equal(a.store.getStep(id, first).title, 'Offline edit');
  assert.equal(snapshot(a.store, id).hash, snapshot(b.store, id).hash);
});

test('damaged full and parts merge bases stop sync before installing or pruning anything', async (t) => {
  for (const format of ['full', 'parts']) {
    const { device, files, bytes } = setup(t); const a = device('a'), b = device('b');
    const id = addGuide(a.store); await synced(a.sync); await synced(b.sync);
    const base = versionFiles(files)[0];
    const changed = snapshot(a.store, id).entries.map(entry => entry.name === 'guide.json'
      ? { ...entry, data: JSON.stringify({ ...JSON.parse(entry.data), title: 'Damaged baseline' }) } : entry);
    if (format === 'full') { delete base.appProperties.format; bytes.set(base.id, zipSync(changed)); }
    else bytes.set(base.id, parts.encodeSnapshot(changed).manifest);
    fs.rmSync(b.sync.basePath(id));
    fs.rmSync(b.sync.manifestPath(base.id), { force: true });
    edit(a.store, id, 'Remote edit'); await synced(a.sync);
    edit(b.store, id, 'Offline edit');
    const before = snapshot(b.store, id).hash, ids = files.map(file => file.id);
    const status = await b.sync.sync();
    assert.equal(status.phase, 'error', status.message);
    assert.match(status.message, /merge base.*integrity/i);
    assert.equal(snapshot(b.store, id).hash, before);
    assert.deepEqual(files.map(file => file.id), ids);
  }
});

test('four devices converge after simultaneous offline edits, step deletion and failed uploads', async (t) => {
  const { device, drive, files } = setup(t);
  const devices = ['a', 'b', 'c', 'd'].map(name => device(name));
  const id = addGuide(devices[0].store, 8);
  for (const { sync } of devices) await synced(sync);
  const order = devices[0].store.getGuide(id).stepsOrder;
  for (let round = 0; round < 5; round++) {
    for (const [index, { store }] of devices.entries()) {
      editStep(store, id, order[index], { title: `Device ${index}, round ${round}` });
      edit(store, id, `Conflict ${index}, round ${round}`);
      savedAt(store, id, `2030-01-0${round + 1}T12:00:0${index}Z`);
    }
    if (!round) devices[0].store.deleteStep(id, order[7]);
    const list = drive.listVersions, upload = drive.upload;
    const stale = [...versionFiles(files)];
    drive.listVersions = async () => [...stale];
    drive.upload = async () => { throw new Error('Offline'); };
    const before = snapshot(devices[3].store, id).hash;
    assert.equal((await devices[3].sync.sync()).phase, 'error');
    assert.equal(snapshot(devices[3].store, id).hash, before);
    drive.upload = upload;
    try { await Promise.all(devices.map(({ sync }) => synced(sync))); }
    finally { drive.listVersions = list; }
    for (let poll = 0; poll < 3; poll++) for (const { sync } of [...devices].reverse()) await synced(sync);
    for (const { store } of devices) {
      for (let index = 0; index < 4; index++) assert.equal(store.getStep(id, order[index]).title, `Device ${index}, round ${round}`);
      assert.ok(!store.listSteps(id).has(order[7]));
      assert.equal(snapshot(store, id).hash, snapshot(devices[0].store, id).hash);
    }
    assert.equal(headsOf(versionFiles(files)).length, 1);
  }
});

test('an offline deletion keeps concurrent remote edits in history and offline local edits in Trash', async (t) => {
  const { device, files } = setup(t); const a = device('a'), b = device('b'), c = device('c');
  const id = addGuide(a.store); for (const { sync } of [a, b, c]) await synced(sync);
  a.sync.stageDeletion(id); a.store.deleteGuide(id);
  edit(b.store, id, 'Remote work while A was offline'); await synced(b.sync);
  const remote = versionFiles(files).find(file => file.appProperties.hash === snapshot(b.store, id).hash);
  edit(c.store, id, 'Unsynced work on C');
  await synced(a.sync); await synced(c.sync);
  assert.ok(files.some(file => file.id === remote.id), 'the remote edit has a retained cloud version');
  const [trash] = c.store.listTrash(); c.store.restoreFromTrash(trash);
  assert.equal(c.store.getGuide(id).title, 'Unsynced work on C');
  await a.sync.permanentlyDeleteRecovery(id);
  assert.equal(versionFiles(files).filter(file => file.appProperties.guideId === id).length, 0);
});

test('remote deletion waits for an open editor and then preserves its saved work in Trash', async (t) => {
  const { device, files } = setup(t); let open = false;
  const a = device('a'), b = device('b', { canReplace: () => !open });
  const id = addGuide(a.store); await synced(a.sync); await synced(b.sync);
  a.sync.stageDeletion(id); a.store.deleteGuide(id); await synced(a.sync);
  open = true;
  const count = files.length;
  assert.equal((await b.sync.sync()).phase, 'pending');
  assert.ok(b.store.guideExists(id));
  assert.equal(files.length, count, 'the deleted guide is not re-uploaded');
  edit(b.store, id, 'Saved before closing the editor'); open = false;
  await synced(b.sync);
  assert.ok(!b.store.guideExists(id));
  b.store.restoreFromTrash(b.store.listTrash()[0]);
  assert.equal(b.store.getGuide(id).title, 'Saved before closing the editor');
});

test('a never-synced local copy is merged conservatively without inferring step deletions', async t => {
  const { device } = setup(t); const a = device('a'), b = device('b');
  const id = addGuide(a.store, 3); await synced(a.sync);
  b.sync.install(zipSync(snapshot(a.store, id).entries), id, id);
  const [first, , third] = a.store.getGuide(id).stepsOrder;
  a.store.deleteStep(id, third); await synced(a.sync);
  editStep(b.store, id, first, { title: 'Local work before first sync' });
  savedAt(b.store, id, '2030-01-01T12:00:00Z');
  await synced(b.sync); await synced(a.sync);
  assert.ok(b.store.listSteps(id).has(third));
  assert.equal(a.store.getStep(id, first).title, 'Local work before first sync');
  assert.equal(snapshot(a.store, id).hash, snapshot(b.store, id).hash);
});

test('a fresh device merging remote conflicts can restore every losing version after cloud pruning', async (t) => {
  const { device, drive, files } = setup(t); const a = device('a'), b = device('b'), fresh = device('fresh');
  const id = addGuide(a.store); await synced(a.sync); await synced(b.sync);
  const stale = [...versionFiles(files)], list = drive.listVersions;
  edit(a.store, id, 'Conflict from A'); savedAt(a.store, id, '2030-01-01T10:00:00Z');
  edit(b.store, id, 'Conflict from B'); savedAt(b.store, id, '2030-01-01T11:00:00Z');
  drive.listVersions = async () => [...stale];
  try { await Promise.all([synced(a.sync), synced(b.sync)]); } finally { drive.listVersions = list; }
  await synced(fresh.sync); await fresh.sync.prune();
  const backups = listSnapshots(fresh.store, id).filter(name => name.includes('cloud-conflict-'));
  assert.equal(backups.length, 2);
  const titles = new Set();
  for (const backup of backups) { restoreSnapshot(fresh.store, id, backup); titles.add(fresh.store.getGuide(id).title); }
  assert.deepEqual([...titles].sort(), ['Conflict from A', 'Conflict from B']);
});

test('one online device closes all concurrent branches when provider IDs exceed one merged property', async t => {
  const { device, drive, files } = setup(t, { idLength: 44 });
  const writers = ['a', 'b', 'c', 'd'].map(name => device(name));
  const id = addGuide(writers[0].store);
  for (const { sync } of writers) await synced(sync);
  const stale = [...versionFiles(files)], list = drive.listVersions;
  for (const [index, { store }] of writers.entries()) {
    edit(store, id, `Concurrent branch ${index}`);
    savedAt(store, id, `2030-01-01T12:00:0${index}Z`);
  }
  drive.listVersions = async () => [...stale];
  try { await Promise.all(writers.map(({ sync }) => synced(sync))); } finally { drive.listVersions = list; }
  assert.equal(headsOf(versionFiles(files)).length, 4);
  const reader = device('only-online');
  for (let poll = 0; poll < 4; poll++) await synced(reader.sync);
  assert.equal(headsOf(versionFiles(files)).length, 1);
  assert.equal(reader.store.getGuide(id).title, 'Concurrent branch 3');
  assert.equal(listSnapshots(reader.store, id).filter(name => name.includes('cloud-conflict-')).length, 4);
  for (const file of versionFiles(files)) assert.ok((file.appProperties.merged || '').length <= 110);
});

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

for (const permanently of [false, true]) {
  test(`a guide restored from Trash stays restored after its cloud deletion${permanently ? ' and the recovery copy were deleted permanently' : ''}`, async (t) => {
    const { device, files } = setup(t); const a = device('a'); const b = device('b');
    const id = addGuide(a.store); await synced(a.sync); await synced(b.sync);
    a.sync.stageDeletion(id); a.store.deleteGuide(id); await synced(a.sync); await synced(b.sync);
    if (permanently) await a.sync.permanentlyDeleteRecovery(id);
    assert.equal(b.store.guideExists(id), false);

    const [name] = a.store.listTrash();
    a.store.restoreFromTrash(name);
    a.sync.restoredFromTrash(id);
    await synced(a.sync); await synced(b.sync); await synced(a.sync);
    assert.equal(a.store.getGuide(id).title, 'Original');
    assert.equal(b.store.getGuide(id).title, 'Original', 'the other computer gets it back too');
    assert.deepEqual(await a.sync.deletedGuides(), []);
    assert.equal(files.filter((file) => file.appProperties?.stepforge === 'deletion-v1' && file.appProperties.state !== 'restored').length, 0);
  });
}

test('restoring from Trash before the deletion was sent leaves nothing deleted in the cloud', async (t) => {
  const { device, files } = setup(t); const a = device('a'); const b = device('b');
  const id = addGuide(a.store); await synced(a.sync); await synced(b.sync);
  a.sync.stageDeletion(id); a.store.deleteGuide(id);
  a.store.restoreFromTrash(a.store.listTrash()[0]);
  a.sync.restoredFromTrash(id);
  await synced(a.sync); await synced(b.sync);
  assert.equal(a.store.guideExists(id), true);
  assert.equal(b.store.guideExists(id), true);
  assert.equal(files.filter((file) => file.appProperties?.stepforge === 'deletion-v1').length, 0);
  assert.equal(fs.existsSync(a.sync.pendingArchive(id)), false);
});

test('deleting a guide again after restoring it from Trash deletes it everywhere', async (t) => {
  const { device } = setup(t); const a = device('a'); const b = device('b');
  const id = addGuide(a.store); await synced(a.sync); await synced(b.sync);
  a.sync.stageDeletion(id); a.store.deleteGuide(id); await synced(a.sync);
  a.store.restoreFromTrash(a.store.listTrash()[0]);
  a.sync.restoredFromTrash(id);
  assert.equal(a.sync.stageDeletion(id), true);
  a.store.deleteGuide(id);
  await synced(a.sync); await synced(b.sync);
  assert.equal(a.store.guideExists(id), false);
  assert.equal(b.store.guideExists(id), false);
  assert.equal((await a.sync.deletedGuides()).length, 1);
});

test('guides restored from Trash while a sync is running are not moved back to Trash', async (t) => {
  const { device, drive } = setup(t); const a = device('a');
  const first = addGuide(a.store); const second = addGuide(a.store); await synced(a.sync);
  for (const id of [first, second]) { a.sync.stageDeletion(id); a.store.deleteGuide(id); }
  await synced(a.sync);
  const fromTrash = (id) => {
    a.store.restoreFromTrash(a.store.listTrashItems().map((item) => item.name).find((name) => name.startsWith(id)));
    a.sync.restoredFromTrash(id);
  };
  // Like restoring both at once from Trash: the second lands while the sync
  // started by the first is recording it as restored.
  fromTrash(first);
  const upload = drive.upload;
  drive.upload = async function (file) {
    if (file.properties?.state === 'restored') { drive.upload = upload; fromTrash(second); }
    return upload.call(this, file);
  };
  await synced(a.sync);
  assert.equal(a.store.guideExists(first), true);
  assert.equal(a.store.guideExists(second), true);
  await synced(a.sync);
  assert.equal(a.store.guideExists(second), true);
  assert.deepEqual(await a.sync.deletedGuides(), []);
});

test('a guide restored from Trash with its cloud sharing turned off stays local and changes nothing in the cloud', async (t) => {
  const { device, files } = setup(t); const a = device('a'); const b = device('b');
  const id = addGuide(a.store); await synced(a.sync); await synced(b.sync);
  await a.sync.setSharing(id, false);
  assert.equal(a.sync.stageDeletion(id), false, 'an opted-out guide is deleted locally only');
  a.store.deleteGuide(id);
  b.sync.stageDeletion(id); b.store.deleteGuide(id);
  await synced(b.sync); await synced(a.sync);

  a.store.restoreFromTrash(a.store.listTrash()[0]);
  a.sync.restoredFromTrash(id);
  await synced(a.sync); await synced(b.sync); await synced(a.sync);
  assert.equal(a.store.guideExists(id), true, 'the restored copy stays');
  assert.equal(a.store.getGuide(id).cloud.sharingEnabled, false);
  assert.equal(b.store.guideExists(id), false, 'the other computer does not get it back');
  assert.equal(files.filter((file) => file.appProperties?.state === 'restored').length, 0);
  assert.equal((await b.sync.deletedGuides()).length, 1, 'the cloud deletion is unchanged');
});

test('a restore is still published when the first listing after it misses the deletion', async (t) => {
  const { device, drive } = setup(t); const a = device('a'); const b = device('b');
  const id = addGuide(a.store); await synced(a.sync); await synced(b.sync);
  a.sync.stageDeletion(id); a.store.deleteGuide(id); await synced(a.sync); await synced(b.sync);

  a.store.restoreFromTrash(a.store.listTrash()[0]);
  a.sync.restoredFromTrash(id);
  // Like a delayed Drive listing: the deletion marker is missing once.
  const listDeletions = drive.listDeletions;
  drive.listDeletions = async function () {
    drive.listDeletions = listDeletions;
    return (await listDeletions.call(this)).filter((file) => file.appProperties?.guideId !== id);
  };
  await synced(a.sync);
  await synced(a.sync); await synced(b.sync);
  assert.equal(a.store.guideExists(id), true, 'not moved back to Trash by the next accurate listing');
  assert.equal(b.store.guideExists(id), true, 'the other computer gets it back');
  assert.deepEqual(await a.sync.deletedGuides(), []);
});

test('WebP screenshots sync as the bytes they are stored as, and an old PNG beside them is unchanged', async (t) => {
  const { device, files } = setup(t);
  const a = device('a'); const b = device('b');
  const id = addGuide(a.store, 0);
  const { createImageCodec } = require('../../core/image-codec');
  const { encodePng } = require('../../core/png');
  const { createImage } = require('../../core/raster');
  const webp = await createImageCodec().encodeWebp(encodePng(createImage(40, 30, [25, 75, 125, 128])));
  const step = a.store.addStep(id, { title: 'Optimized' }, webp, { width: 40, height: 30 });
  await synced(a.sync); await synced(b.sync);
  const onB = b.store.getStep(id, step.stepId);
  assert.equal(onB.image.originalPath, 'original.webp');
  assert.deepEqual(fs.readFileSync(b.store.stepImagePath(id, step.stepId, 'original')), webp);
  assert.equal(snapshot(a.store, id).hash, snapshot(b.store, id).hash);
  assert.ok(files.length >= 1, 'the guide was uploaded');
});
