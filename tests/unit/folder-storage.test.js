'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { FolderStorage, ORPHAN_GRACE_MS } = require('../../core/folder-storage');
const { GuideStore } = require('../../core/store');
const { CloudSync, snapshot } = require('../../core/cloud-sync');
const { makeTmpDir, rmrf, TINY_PNG } = require('./helpers');

/** Files in folders, like OneDrive, Dropbox or WebDAV. */
function memoryBackend() {
  const files = new Map();
  const calls = [];
  let clock = Date.UTC(2026, 0, 1);
  return {
    files,
    calls,
    async list(folder) {
      calls.push(['list', folder]);
      return [...files].filter(([name]) => name.startsWith(`${folder}/`))
        .map(([name, file]) => ({ name: name.slice(folder.length + 1), size: file.data.length, modified: file.modified }));
    },
    async put(name, data, { onProgress } = {}) {
      calls.push(['put', name]);
      clock += 1000;
      files.set(name, { data: Buffer.from(data), modified: new Date(clock).toISOString() });
      onProgress?.(data.length);
    },
    async get(name) {
      calls.push(['get', name]);
      if (!files.has(name)) { const err = new Error('not found'); err.status = 404; throw err; }
      return Buffer.from(files.get(name).data);
    },
    async remove(name) { calls.push(['remove', name]); files.delete(name); },
    async quota() { return { limit: 1000, usage: 10 }; },
  };
}

function account(backend, root, name) {
  const storage = new FolderStorage({ backend, cacheFile: path.join(root, `${name}-files.json`) });
  return Object.assign(storage, {
    label: 'OneDrive', clientId: 'onedrive:test', status: () => ({ connected: true }), account: async () => 'drive-1', cancel() {},
  });
}

test('versions, deletion records and parts round-trip with their properties', async (t) => {
  const root = makeTmpDir('folder-storage');
  t.after(() => rmrf(root));
  const backend = memoryBackend();
  const storage = account(backend, root, 'a');
  const big = Buffer.alloc(10000, 7);
  const version = await storage.upload({ data: big, name: 'Guide.sfgz', properties: { stepforge: 'guide-v1', guideId: 'g1', hash: 'a'.repeat(64) } });
  const marker = await storage.upload({ data: Buffer.from('{}'), name: 'Deleted Guide', properties: { stepforge: 'deletion-v1', guideId: 'g2', state: 'deleted' } });
  const sha = 'b'.repeat(64);
  const part = await storage.upload({ data: Buffer.from('part'), name: `part-${sha}`, properties: { stepforge: 'part-v1', sha } });

  assert.ok(backend.files.has(`objects/${version.id}.bin`), 'large data is its own file');
  assert.ok(backend.files.has(`objects/${version.id}.json`));
  assert.equal(backend.files.has(`objects/${marker.id}.bin`), false, 'small records live inside their details');
  assert.ok(backend.files.has(`parts/${sha}`), 'parts are named by their hash');

  const versions = await storage.listVersions();
  assert.deepEqual(versions.map((file) => [file.id, file.name, file.size, file.appProperties.guideId]), [[version.id, 'Guide.sfgz', '10000', 'g1']]);
  assert.match(versions[0].createdTime, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual((await storage.listDeletions()).map((file) => file.appProperties.state), ['deleted']);
  assert.deepEqual((await storage.listParts()).map((file) => [file.id, file.appProperties.sha, file.size]), [[part.id, sha, '4']]);

  assert.deepEqual(await storage.download(version.id), big);
  assert.deepEqual((await storage.download(marker.id)).toString(), '{}');
  assert.deepEqual((await storage.download(part.id)).toString(), 'part');

  await storage.deleteFile(version.id);
  await storage.deleteFile(part.id);
  assert.deepEqual(await storage.listVersions(), []);
  assert.deepEqual(await storage.listParts(), []);
  assert.equal([...backend.files.keys()].some((name) => name.includes(version.id)), false);
});

test('details are read once and remembered across restarts; damaged ones are ignored', async (t) => {
  const root = makeTmpDir('folder-storage');
  t.after(() => rmrf(root));
  const backend = memoryBackend();
  const writer = account(backend, root, 'writer');
  for (let i = 0; i < 3; i += 1) {
    await writer.upload({ data: Buffer.alloc(5000, i), name: `v${i}`, properties: { stepforge: 'guide-v1', guideId: 'g1', hash: 'c'.repeat(64) } });
  }
  backend.files.set('objects/zzzz-0000000000000000.json', { data: Buffer.from('not json'), modified: new Date().toISOString() });
  backend.files.set('objects/readme.txt', { data: Buffer.from('hello'), modified: new Date().toISOString() });

  const reader = account(backend, root, 'reader');
  assert.equal((await reader.listVersions()).length, 3);
  const detailReads = () => backend.calls.filter(([op, name]) => op === 'get' && name.endsWith('.json')).length;
  const first = detailReads();
  assert.equal((await reader.listVersions()).length, 3);
  const restarted = account(backend, root, 'reader');
  assert.equal((await restarted.listVersions()).length, 3);
  // Only the damaged file is fetched again; it never counts as a version.
  assert.equal(detailReads() - first, 2);
});

test('versions and deletion records share one folder listing', async (t) => {
  const root = makeTmpDir('folder-storage');
  t.after(() => rmrf(root));
  const backend = memoryBackend();
  const storage = account(backend, root, 'a');
  await Promise.all([storage.listVersions(), storage.listDeletions()]);
  assert.equal(backend.calls.filter(([op, name]) => op === 'list' && name === 'objects').length, 1);
});

test('unfinished uploads are removed once they are old enough', async (t) => {
  const root = makeTmpDir('folder-storage');
  t.after(() => rmrf(root));
  const backend = memoryBackend();
  const storage = account(backend, root, 'a');
  const kept = await storage.upload({ data: Buffer.alloc(6000), name: 'v', properties: { stepforge: 'guide-v1', guideId: 'g1', hash: 'd'.repeat(64) } });
  backend.files.set('objects/abc-0123456789abcdef.bin', { data: Buffer.alloc(6000), modified: new Date(Date.UTC(2026, 0, 1)).toISOString() });
  backend.files.set('objects/abd-0123456789abcdef.bin', { data: Buffer.alloc(6000), modified: new Date().toISOString() });
  assert.equal(await storage.removeOrphans({ now: Date.now() }), 1);
  assert.ok(backend.files.has(`objects/${kept.id}.bin`));
  assert.ok(backend.files.has('objects/abd-0123456789abcdef.bin'), 'a recent upload may still be in progress');
  assert.equal(ORPHAN_GRACE_MS, 24 * 60 * 60 * 1000);
});

test('two computers sync, share unchanged screenshots and delete guides through a folder-based service', async (t) => {
  const root = makeTmpDir('folder-sync');
  t.after(() => rmrf(root));
  const backend = memoryBackend();
  const device = (name) => {
    const store = new GuideStore(path.join(root, name));
    // Every file becomes a part, so the screenshot is stored once and shared.
    const sync = new CloudSync({ store, drive: account(backend, root, name), enabled: () => true, settleMs: 0, inlineLimit: 0 });
    t.after(() => sync.stop());
    return { store, sync };
  };
  const synced = async (sync) => { const status = await sync.sync(); assert.equal(status.phase, 'synced', status.message); };
  const a = device('a');
  const b = device('b');
  const guide = a.store.createGuide({ title: 'Folder guide' });
  a.store.addStep(guide.guideId, { title: 'Screenshot' }, TINY_PNG, { width: 1, height: 1 });
  await synced(a.sync);
  assert.match(a.sync.status.message, /OneDrive/);
  await synced(b.sync);
  assert.equal(snapshot(a.store, guide.guideId).hash, snapshot(b.store, guide.guideId).hash);

  const partsBefore = [...backend.files.keys()].filter((name) => name.startsWith('parts/'));
  const edited = b.store.getGuide(guide.guideId);
  edited.title = 'Edited on B';
  b.store.saveGuide(edited);
  b.sync.markChanged(guide.guideId);
  await synced(b.sync);
  await synced(a.sync);
  assert.equal(a.store.getGuide(guide.guideId).title, 'Edited on B');
  const partsAfter = [...backend.files.keys()].filter((name) => name.startsWith('parts/'));
  const newParts = partsAfter.filter((name) => !partsBefore.includes(name));
  assert.ok(newParts.length <= 2, 'only the changed guide file is uploaded again, not the screenshot');

  a.sync.stageDeletion(guide.guideId);
  a.store.deleteGuide(guide.guideId);
  await synced(a.sync);
  await synced(b.sync);
  assert.equal(b.store.guideExists(guide.guideId), false);
  assert.equal((await b.sync.deletedGuides()).length, 1);
});
