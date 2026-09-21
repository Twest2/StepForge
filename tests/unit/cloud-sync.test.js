'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GuideStore } = require('../../core/store');
const { CloudSync, snapshot } = require('../../core/cloud-sync');
const { Settings } = require('../../core/settings');
const { writeJsonSync } = require('../../core/util');
const { makeTmpDir, rmrf, TINY_PNG } = require('./helpers');

function setup(t) {
  const root = makeTmpDir('cloud-sync');
  t.after(() => rmrf(root));
  const files = [];
  const bytes = new Map();
  const drive = {
    calls: 0,
    status: () => ({ connected: true, clientId: 'test-client' }),
    account: async () => 'account-a',
    cancel() {},
    async listVersions() { this.calls++; return [...files]; },
    async upload({ data, name, properties }) {
      const file = { id: `file-${files.length + 1}`, name, appProperties: properties, createdTime: String(files.length).padStart(6, '0') };
      files.push(file); bytes.set(file.id, data); return file;
    },
    async download(id) { return bytes.get(id); },
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
function addGuide(store) {
  const guide = store.createGuide({ title: 'Original' });
  store.addStep(guide.guideId, { title: 'Screenshot' }, TINY_PNG, { width: 1, height: 1 });
  return guide.guideId;
}
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

test('diverging local and remote edits keep both versions and do not duplicate conflicts on later polls', async (t) => {
  const { device } = setup(t);
  const a = device('a'); const b = device('b');
  const id = addGuide(a.store);
  await synced(a.sync); await synced(b.sync);
  edit(a.store, id, 'A edit'); edit(b.store, id, 'B edit');
  await synced(a.sync);
  assert.equal((await synced(b.sync)).phase, 'conflict');
  assert.equal(b.store.getGuide(id).title, 'A edit');
  assert.ok(b.store.listGuides().some((g) => g.title.startsWith('B edit (conflict')));
  for (let i = 0; i < 3; i++) { await synced(a.sync); await synced(b.sync); }
  assert.equal(b.store.listGuides().length, 2);
  assert.equal(a.store.listGuides().length, 2);
});

test('concurrent uploads remain separate immutable versions and preserve the losing branch', async (t) => {
  const { device, drive, files } = setup(t);
  const a = device('a'); const b = device('b');
  const id = addGuide(a.store);
  await synced(a.sync); await synced(b.sync);
  const staleListing = [...files];
  edit(a.store, id, 'A concurrent'); edit(b.store, id, 'B concurrent');
  await synced(a.sync);
  const list = drive.listVersions;
  drive.listVersions = async () => staleListing;
  await synced(b.sync);
  drive.listVersions = list;
  assert.equal(files.length, 3);
  await synced(a.sync); await synced(b.sync);
  assert.equal(a.store.getGuide(id).title, 'B concurrent');
  assert.ok(a.store.listGuides().some((g) => g.title.startsWith('A concurrent (conflict')));
  for (let i = 0; i < 3; i++) { await synced(a.sync); await synced(b.sync); }
  assert.equal(a.store.listGuides().length, 2);
  assert.equal(b.store.listGuides().length, 2);
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
