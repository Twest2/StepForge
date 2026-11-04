'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GuideStore } = require('../../core/store');
const { CloudSync } = require('../../core/cloud-sync');
const { FolderStorage } = require('../../core/folder-storage');
const parts = require('../../core/cloud-parts');
const { makeTmpDir, rmrf, TINY_PNG } = require('./helpers');

// Folder changes are dated by the folders.json file time, so tests set it
// explicitly: at(n) is the n-th second of 2026.
const at = (n) => new Date(Date.UTC(2026, 0, 1) + n * 1000);

function setup(t) {
  const root = makeTmpDir('cloud-folders');
  t.after(() => rmrf(root));
  const files = [];
  const bytes = new Map();
  let nextFileId = 0;
  function driveFor({ folders = true } = {}) {
    const drive = {
      offline: false,
      clientId: 'test-client',
      label: 'Google Drive',
      status: () => ({ connected: true }),
      account: async () => 'account-a',
      cancel() {},
      check() { if (drive.offline) throw new Error('Google Drive is unreachable.'); },
      async listVersions() { drive.check(); return files.filter((file) => file.appProperties?.stepforge === 'guide-v1'); },
      async listDeletions() { drive.check(); return files.filter((file) => file.appProperties?.stepforge === 'deletion-v1'); },
      async listParts() { drive.check(); return files.filter((file) => file.appProperties?.stepforge === 'part-v1'); },
      async listSettings() { drive.check(); return files.filter((file) => file.appProperties?.stepforge === 'settings-v1'); },
      async listFolders() { drive.check(); return files.filter((file) => file.appProperties?.stepforge === 'folders-v1'); },
      async upload({ data, name, properties }) {
        drive.check();
        const file = { id: `file-${++nextFileId}`, name, appProperties: properties, size: String(data.length),
          createdTime: new Date(Date.UTC(2026, 1, 1) + nextFileId * 1000).toISOString() };
        files.push(file);
        bytes.set(file.id, data);
        return file;
      },
      async download(id) { drive.check(); return bytes.get(id); },
      async deleteFile(id) {
        drive.check();
        const index = files.findIndex((file) => file.id === id);
        if (index >= 0) files.splice(index, 1);
        bytes.delete(id);
      },
    };
    if (!folders) delete drive.listFolders;
    return drive;
  }
  function device(name, { folders = true, drive = driveFor({ folders }) } = {}) {
    const store = new GuideStore(path.join(root, name));
    const folderChanges = [];
    const sync = new CloudSync({ store, drive, enabled: () => true, settleMs: 0, onFoldersChange: () => folderChanges.push(Date.now()) });
    t.after(() => sync.stop());
    return { store, sync, drive, folderChanges };
  }
  return { root, files, bytes, driveFor, device };
}

function addGuide(store, title) {
  const guide = store.createGuide({ title });
  store.addStep(guide.guideId, { title: 'Screenshot' }, TINY_PNG, { width: 1, height: 1 });
  return guide.guideId;
}
const folderVersions = (files) => files.filter((file) => file.appProperties?.stepforge === 'folders-v1');
const guideVersions = (files) => files.filter((file) => file.appProperties?.stepforge === 'guide-v1');

async function synced(sync) {
  const status = await sync.sync();
  assert.notEqual(status.phase, 'error', status.message);
  return status;
}

/** Folder names with their parent names, and the folder each guide title is in. */
function view(store) {
  const data = store.loadFolders();
  const byId = new Map(data.folders.map((folder) => [folder.id, folder]));
  const folders = data.folders
    .map((folder) => `${folder.parentId ? byId.get(folder.parentId)?.name ?? '?' : '/'} > ${folder.name}`)
    .sort();
  const placement = Object.fromEntries(store.listGuides().map((guide) => {
    const folderId = data.guideFolders[guide.guideId];
    return [guide.title, folderId ? byId.get(folderId)?.name ?? '?' : '/'];
  }));
  return { folders, placement };
}

function folderId(store, name) {
  const folder = store.loadFolders().folders.find((item) => item.name === name);
  assert.ok(folder, `no folder named ${name}`);
  return folder.id;
}

/** Make a change to the library's folders as the user would, dated `n` seconds into 2026. */
function change(device, n, action) {
  action();
  fs.utimesSync(device.store.foldersFile, at(n), at(n));
}

test('two devices with different folder structures end up with the same folders and guide placement', async (t) => {
  const { device, files } = setup(t);
  const a = device('a');
  const b = device('b');
  change(a, 1, () => {
    const work = a.store.createFolder('Work');
    const projects = a.store.createFolder('Projects', work.id);
    const guide = addGuide(a.store, 'Release notes');
    a.store.moveGuideToFolder(guide, projects.id);
  });
  change(b, 2, () => {
    const personal = b.store.createFolder('Personal');
    const recipes = b.store.createFolder('Recipes', personal.id);
    // The same folder name, created independently: it must not appear twice.
    b.store.createFolder('Work');
    const guide = addGuide(b.store, 'Bread');
    b.store.moveGuideToFolder(guide, recipes.id);
  });
  await synced(a.sync);
  await synced(b.sync);
  await synced(a.sync);
  await synced(b.sync);

  const expected = {
    folders: ['/ > Personal', '/ > Work', 'Personal > Recipes', 'Work > Projects'],
    placement: { 'Release notes': 'Projects', Bread: 'Recipes' },
  };
  assert.deepEqual(view(a.store), expected);
  assert.deepEqual(view(b.store), expected);
  assert.equal(folderVersions(files).length, 1, 'superseded folder versions are removed');
});

test('a folder renamed on both devices at once keeps the later rename, and its guides', async (t) => {
  for (const [aTime, bTime, winner] of [[10, 20, 'Beta'], [30, 20, 'Alpha']]) {
    const { device } = setup(t);
    const a = device('a');
    const b = device('b');
    change(a, 1, () => { const f = a.store.createFolder('Old'); a.store.moveGuideToFolder(addGuide(a.store, 'Guide'), f.id); });
    await synced(a.sync);
    await synced(b.sync);
    const id = folderId(a.store, 'Old');
    change(a, aTime, () => a.store.renameFolder(id, 'Alpha'));
    change(b, bTime, () => b.store.renameFolder(id, 'Beta'));
    await synced(a.sync);
    await synced(b.sync);
    await synced(a.sync);
    assert.equal(view(a.store).folders[0], `/ > ${winner}`);
    assert.equal(view(b.store).folders[0], `/ > ${winner}`);
    assert.deepEqual(view(a.store).placement, { Guide: winner });
    assert.deepEqual(view(b.store).placement, { Guide: winner });
  }
});

test('moving guides between folders reaches every device, including back to the root', async (t) => {
  const { device } = setup(t);
  const a = device('a');
  const b = device('b');
  change(a, 1, () => { a.store.createFolder('One'); a.store.createFolder('Two'); });
  const guide = addGuide(a.store, 'Moving');
  await synced(a.sync);
  await synced(b.sync);
  change(a, 2, () => a.store.moveGuideToFolder(guide, folderId(a.store, 'One')));
  await synced(a.sync);
  await synced(b.sync);
  assert.equal(view(b.store).placement.Moving, 'One');
  change(b, 3, () => b.store.moveGuideToFolder(guide, folderId(b.store, 'Two')));
  await synced(b.sync);
  await synced(a.sync);
  assert.equal(view(a.store).placement.Moving, 'Two');
  change(a, 4, () => a.store.moveGuideToFolder(guide, null));
  await synced(a.sync);
  await synced(b.sync);
  assert.equal(view(b.store).placement.Moving, '/');
  assert.equal(view(a.store).placement.Moving, '/');
});

test('deleting a folder on one device keeps its guides and sub-folders, moved to the root', async (t) => {
  const { device } = setup(t);
  const a = device('a');
  const b = device('b');
  change(a, 1, () => {
    const parent = a.store.createFolder('Parent');
    const child = a.store.createFolder('Child', parent.id);
    a.store.moveGuideToFolder(addGuide(a.store, 'In parent'), parent.id);
    a.store.moveGuideToFolder(addGuide(a.store, 'In child'), child.id);
  });
  await synced(a.sync);
  await synced(b.sync);
  change(a, 2, () => a.store.deleteFolder(folderId(a.store, 'Parent')));
  await synced(a.sync);
  await synced(b.sync);
  const expected = { folders: ['/ > Child'], placement: { 'In parent': '/', 'In child': 'Child' } };
  assert.deepEqual(view(a.store), expected);
  assert.deepEqual(view(b.store), expected);
  assert.equal(b.store.listGuides().length, 2, 'no guide is removed by a folder deletion');
});

test('a folder edited on one device after it was deleted elsewhere is kept, and only then', async (t) => {
  const { device } = setup(t);
  const a = device('a');
  const b = device('b');
  change(a, 1, () => a.store.createFolder('Keep me'));
  await synced(a.sync);
  await synced(b.sync);
  const id = folderId(a.store, 'Keep me');
  change(a, 5, () => a.store.deleteFolder(id));
  // A rename made after the deletion, on the device that still has the folder.
  change(b, 9, () => b.store.renameFolder(id, 'Kept by rename'));
  await synced(a.sync);
  await synced(b.sync);
  await synced(a.sync);
  assert.deepEqual(view(a.store).folders, ['/ > Kept by rename']);
  assert.deepEqual(view(b.store).folders, ['/ > Kept by rename']);
});

test('reconnecting after being offline keeps the offline edits and merges them by time', async (t) => {
  const { device } = setup(t);
  const a = device('a');
  const b = device('b');
  change(a, 1, () => a.store.createFolder('Shared'));
  await synced(a.sync);
  await synced(b.sync);
  const id = folderId(a.store, 'Shared');
  a.drive.offline = true;
  change(a, 10, () => { a.store.renameFolder(id, 'Offline name'); a.store.createFolder('Made offline'); });
  const failed = await a.sync.sync();
  assert.equal(failed.phase, 'error');
  assert.deepEqual(view(a.store).folders, ['/ > Made offline', '/ > Offline name'], 'the offline edit is kept locally');
  change(b, 20, () => b.store.renameFolder(id, 'Online name'));
  await synced(b.sync);
  a.drive.offline = false;
  await synced(a.sync);
  await synced(b.sync);
  // The rename on B is later than the offline rename on A, so B's name wins.
  assert.deepEqual(view(a.store).folders, ['/ > Made offline', '/ > Online name']);
  assert.deepEqual(view(b.store).folders, ['/ > Made offline', '/ > Online name']);
});

test('the first sync after upgrading keeps existing synced guides and adds folders without new guide uploads', async (t) => {
  const { device, files, driveFor } = setup(t);
  // The library as the previous version synced it: no folder support at all.
  const legacy = device('library', { folders: false });
  const guide = addGuide(legacy.store, 'Existing guide');
  await synced(legacy.sync);
  legacy.sync.stop();
  const guidesBefore = guideVersions(files).map((file) => file.id);
  assert.equal(guidesBefore.length, 1);

  // Upgrade the same library: a new sync engine with folder support reads the saved sync state.
  const upgraded = device('library', { drive: driveFor() });
  change(upgraded, 1, () => { const work = upgraded.store.createFolder('Work'); upgraded.store.moveGuideToFolder(guide, work.id); });
  await synced(upgraded.sync);
  assert.deepEqual(guideVersions(files).map((file) => file.id), guidesBefore, 'existing guide versions are untouched');
  assert.equal(folderVersions(files).length, 1);

  // A computer still on the previous version syncs the guides and ignores the folder version.
  const other = device('other', { folders: false });
  await synced(other.sync);
  assert.deepEqual(guideVersions(files).map((file) => file.id), guidesBefore);
  assert.equal(other.store.listGuides().length, 1);
  assert.equal(other.store.loadFolders().folders.length, 0);

  // A new computer gets the guide and its folder.
  const fresh = device('fresh');
  await synced(fresh.sync);
  assert.deepEqual(view(fresh.store), { folders: ['/ > Work'], placement: { 'Existing guide': 'Work' } });
});

test('a library without folders stores no folder version', async (t) => {
  const { device, files } = setup(t);
  const a = device('a');
  const b = device('b');
  addGuide(a.store, 'Plain');
  await synced(a.sync);
  await synced(b.sync);
  await synced(a.sync);
  assert.equal(folderVersions(files).length, 0);
  assert.equal(guideVersions(files).length, 1);
});

test('an interrupted folder upload is retried by the next sync, and no change is lost', async (t) => {
  const { device } = setup(t);
  const a = device('a');
  const b = device('b');
  change(a, 1, () => a.store.createFolder('Interrupted'));
  const upload = a.drive.upload;
  a.drive.upload = async (request) => {
    if (request.properties?.stepforge !== 'folders-v1') return upload(request);
    a.drive.upload = upload;
    throw new Error('connection lost');
  };
  const status = await a.sync.sync();
  assert.equal(status.phase, 'error');
  assert.match(status.message, /Folders could not sync: connection lost/);
  // The local change was applied before the upload failed, and stays.
  assert.deepEqual(view(a.store).folders, ['/ > Interrupted']);
  await synced(a.sync);
  await synced(b.sync);
  assert.deepEqual(view(b.store).folders, ['/ > Interrupted']);
});

test('a damaged folder version is a sync error that changes no folders, and guides keep syncing', async (t) => {
  const { device, files, bytes } = setup(t);
  const a = device('a');
  const b = device('b');
  change(a, 1, () => a.store.createFolder('Local folder'));
  await synced(a.sync);
  const broken = Buffer.from('not a folder table');
  files.push({ id: 'broken-folders', name: 'StepForge folders', appProperties: { stepforge: 'folders-v1', hash: 'a'.repeat(64) }, size: String(broken.length), createdTime: new Date().toISOString() });
  bytes.set('broken-folders', broken);
  const before = view(b.store);
  const status = await b.sync.sync();
  assert.equal(status.phase, 'error');
  assert.match(status.message, /Folders could not sync/);
  assert.deepEqual(view(b.store), before);
  addGuide(b.store, 'Still syncs');
  assert.equal((await b.sync.sync()).phase, 'error');
  assert.equal(guideVersions(files).length, 1, 'the guide still syncs while folders are damaged');
});

test('replacing the cloud with this computer makes its folders the only ones, on every computer', async (t) => {
  const { device } = setup(t);
  const a = device('a');
  const b = device('b');
  change(a, 1, () => a.store.createFolder('Keep'));
  await synced(a.sync);
  await synced(b.sync);
  change(b, 2, () => b.store.createFolder('Drop'));
  await synced(b.sync);
  await a.sync.replaceCloudWithLocal();
  await synced(b.sync);
  await synced(a.sync);
  assert.deepEqual(view(a.store).folders, ['/ > Keep']);
  assert.deepEqual(view(b.store).folders, ['/ > Keep']);
});

test('restoring a guide from Trash puts it back in its folder', async (t) => {
  const { device } = setup(t);
  const a = device('a');
  change(a, 1, () => a.store.createFolder('Kept'));
  const guide = addGuide(a.store, 'Trashed then restored');
  change(a, 2, () => a.store.moveGuideToFolder(guide, folderId(a.store, 'Kept')));
  await synced(a.sync);
  const trashed = a.store.deleteGuide(guide);
  a.sync.restoredFromTrash(guide);
  a.store.restoreFromTrash(path.basename(trashed));
  a.sync.restoredFromTrash(guide);
  await synced(a.sync);
  assert.deepEqual(view(a.store).placement, { 'Trashed then restored': 'Kept' });
});

test('a folder table stays small for a large library, with real-looking ids', () => {
  const { randomUUID } = require('node:crypto');
  const folders = {};
  const guides = {};
  const ids = Array.from({ length: 50 }, () => `folder-${randomUUID()}`);
  ids.forEach((id, i) => { folders[id] = { name: `Folder ${i}`, parentId: i ? ids[0] : null, nameAt: 1762000000000 + i, parentAt: 1762000000000 + i, deletedAt: null }; });
  for (let i = 0; i < 500; i++) guides[`guide-${randomUUID()}`] = { folderId: ids[i % ids.length], at: 1762000000000 + i };
  const bytes = parts.encodeFolderTable({ folders, guides });
  assert.ok(bytes.length < 20 * 1024, `folder table is ${bytes.length} bytes`);
  assert.deepEqual(parts.decodeFolderTable(bytes), parts.mergeFolderTables([{ folders, guides }]));
});

test('merging folder tables is the same in either order and settles bad references', () => {
  const rec = (name, nameAt, parentId = null, parentAt = 1, deletedAt = null) => ({ name, nameAt, parentId, parentAt, deletedAt });
  const one = { folders: { x: rec('Alpha', 5), y: rec('Beta', 5) }, guides: {} };
  const two = { folders: { x: rec('Beta', 5), y: rec('Alpha', 5) }, guides: {} };
  assert.deepEqual(parts.mergeFolderTables([one, two]), parts.mergeFolderTables([two, one]));

  // A child whose parent was deleted goes to the root, a guide in a deleted folder goes to no folder, and nothing is removed.
  const dangling = { folders: { child: rec('Child', 2, 'gone', 2), gone: rec('Gone', 1, null, 1, 3) },
    guides: { g: { folderId: 'gone', at: 4 } } };
  const merged = parts.mergeFolderTables([dangling]);
  assert.equal(merged.folders.child.parentId, null);
  assert.deepEqual(merged.guides.g, { folderId: null, at: 4 });

  // Two folders moved into each other concurrently: the older move is undone.
  const cycle = { folders: { p: rec('P', 1, 'q', 7), q: rec('Q', 1, 'p', 3) }, guides: {} };
  const settled = parts.mergeFolderTables([cycle]);
  assert.equal(settled.folders.q.parentId, null);
  assert.equal(settled.folders.p.parentId, 'q');
});

test('folder storage on file-based services lists folder versions apart from guides', async () => {
  const files = new Map();
  let clock = Date.UTC(2026, 0, 1);
  const backend = {
    async list(folder) {
      return [...files].filter(([name]) => name.startsWith(`${folder}/`))
        .map(([name, file]) => ({ name: name.slice(folder.length + 1), size: file.data.length, modified: file.modified }));
    },
    async put(name, data) { clock += 1000; files.set(name, { data: Buffer.from(data), modified: new Date(clock).toISOString() }); },
    async get(name) { const file = files.get(name); if (!file) throw Object.assign(new Error('missing'), { status: 404 }); return file.data; },
    async remove(name) { files.delete(name); },
    async quota() { return { limit: null, usage: null }; },
  };
  const storage = new FolderStorage({ backend });
  const bytes = Buffer.from('{"folders":[]}');
  const folder = await storage.upload({ data: bytes, name: 'StepForge folders', properties: { stepforge: 'folders-v1', hash: 'b'.repeat(64) } });
  assert.deepEqual((await storage.listFolders()).map((file) => file.id), [folder.id]);
  assert.deepEqual(await storage.listVersions(), []);
  assert.deepEqual(await storage.download(folder.id), bytes);
});

function overlapFolderListings(devices) {
  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  for (const { drive } of devices) {
    const list = drive.listFolders.bind(drive);
    let first = true;
    drive.listFolders = async () => {
      const files = await list();
      if (first) {
        first = false;
        if (++arrived === devices.length) release();
        await gate;
      }
      return files;
    };
  }
}

test('simultaneous first syncs coalesce matching folder trees and keep both guides', async (t) => {
  const { device } = setup(t);
  const a = device('concurrent-a');
  const b = device('concurrent-b');
  for (const [index, d] of [a, b].entries()) change(d, index + 1, () => {
    const root = d.store.createFolder('Work');
    const child = d.store.createFolder('Projects', root.id);
    d.store.moveGuideToFolder(addGuide(d.store, `Guide ${index}`), child.id);
  });
  overlapFolderListings([a, b]);
  await Promise.all([synced(a.sync), synced(b.sync)]);
  await synced(a.sync);
  await synced(b.sync);
  await synced(a.sync);
  const expected = { folders: ['/ > Work', 'Work > Projects'], placement: { 'Guide 0': 'Projects', 'Guide 1': 'Projects' } };
  assert.deepEqual(view(a.store), expected);
  assert.deepEqual(view(b.store), expected);
});

test('simultaneous new folders after the first sync converge without collapsing intentional siblings', async (t) => {
  const { device } = setup(t);
  const a = device('new-a');
  const b = device('new-b');
  change(a, 1, () => a.store.createFolder('Existing'));
  await synced(a.sync);
  await synced(b.sync);
  for (const [index, d] of [a, b].entries()) change(d, index + 2, () => {
    const first = d.store.createFolder('Shared');
    const second = d.store.createFolder('Shared');
    d.store.moveGuideToFolder(addGuide(d.store, `First ${index}`), first.id);
    d.store.moveGuideToFolder(addGuide(d.store, `Second ${index}`), second.id);
  });
  overlapFolderListings([a, b]);
  await Promise.all([synced(a.sync), synced(b.sync)]);
  await synced(a.sync);
  await synced(b.sync);
  const folders = a.store.loadFolders().folders;
  assert.equal(folders.filter(f => f.name === 'Shared').length, 2, 'intentional duplicate siblings survive, without cross-device duplication');
  assert.deepEqual(view(a.store), view(b.store));
  assert.equal(a.store.listGuides().length, 4);
});

test('a renamed folder keeps its identity and deleting then recreating its name does not revive old placement', async (t) => {
  const { device } = setup(t);
  const a = device('recreate-a');
  const b = device('recreate-b');
  change(a, 1, () => { const f = a.store.createFolder('Work'); a.store.moveGuideToFolder(addGuide(a.store, 'Kept guide'), f.id); });
  await synced(a.sync);
  await synced(b.sync);
  const id = folderId(a.store, 'Work');
  change(a, 2, () => a.store.renameFolder(id, 'Renamed'));
  await synced(a.sync);
  await synced(b.sync);
  assert.equal(folderId(a.store, 'Renamed'), id);
  assert.equal(folderId(b.store, 'Renamed'), id);
  change(a, 3, () => a.store.deleteFolder(id));
  await synced(a.sync);
  await synced(b.sync);
  change(a, 4, () => a.store.createFolder('Work'));
  await synced(a.sync);
  await synced(b.sync);
  assert.notEqual(folderId(a.store, 'Work'), id, 'a tombstone is not reused');
  assert.deepEqual(view(a.store), { folders: ['/ > Work'], placement: { 'Kept guide': '/' } });
  assert.deepEqual(view(a.store), view(b.store));
});

test('folder tables reject arrays instead of accepting malformed maps as an empty library', () => {
  const { gzipSync } = require('node:zlib');
  for (const maps of [{ folders: [], guides: {} }, { folders: {}, guides: [] }]) {
    const bytes = gzipSync(JSON.stringify({ format: 'stepforge-folders', version: 1, ...maps }));
    assert.throws(() => parts.decodeFolderTable(bytes), /damaged/);
  }
});

test('moving a folder and renaming it on different devices preserves its subtree and guide membership', async (t) => {
  const { device } = setup(t);
  const a = device('move-a');
  const b = device('move-b');
  change(a, 1, () => {
    const first = a.store.createFolder('First');
    a.store.createFolder('Second');
    const child = a.store.createFolder('Child', first.id);
    a.store.moveGuideToFolder(addGuide(a.store, 'Inside child'), child.id);
  });
  await synced(a.sync);
  await synced(b.sync);
  const childId = folderId(a.store, 'Child');
  change(a, 2, () => a.store.renameFolder(childId, 'Renamed child'));
  change(b, 3, () => {
    const data = b.store.loadFolders();
    data.folders.find(f => f.id === childId).parentId = folderId(b.store, 'Second');
    b.store.saveFolders(data);
  });
  await synced(a.sync);
  await synced(b.sync);
  await synced(a.sync);
  assert.equal(folderId(a.store, 'Renamed child'), childId);
  assert.deepEqual(view(a.store), { folders: ['/ > First', '/ > Second', 'Second > Renamed child'], placement: { 'Inside child': 'Renamed child' } });
  assert.deepEqual(view(a.store), view(b.store));
});

test('the window is told when a sync changes this computer’s folders, and only then', async (t) => {
  const { device } = setup(t);
  const a = device('a');
  const b = device('b');
  change(a, 1, () => a.store.createFolder('Work'));
  await synced(a.sync);
  // a's new folder took its synced id, so a's own window must reload it too.
  assert.equal(a.folderChanges.length, 1);
  await synced(b.sync);
  assert.equal(b.folderChanges.length, 1, 'folders from another computer reach the window');
  assert.deepEqual(view(b.store).folders, ['/ > Work']);
  await synced(b.sync);
  await synced(a.sync);
  assert.equal(b.folderChanges.length, 1, 'nothing changed, no reload');
  assert.equal(a.folderChanges.length, 1);
});
