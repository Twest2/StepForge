'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { GuideStore } = require('../../core/store');
const { SearchIndex } = require('../../core/search');
const { unzipSync, zipSync, crc32 } = require('../../core/zip');
const { exportGuideArchive, importGuideArchive } = require('../../core/archive');
const { createSnapshot, restoreSnapshot, autoSnapshotIfDue } = require('../../core/snapshots');
const { acquireLock, releaseLock } = require('../../core/locks');
const { makeTmpDir, rmrf, TINY_PNG } = require('./helpers');

// ---- ZIP bomb / resource limits ---------------------------------------------

test('unzip rejects an archive that declares too many entries', () => {
  const many = [];
  for (let i = 0; i < 20; i += 1) many.push({ name: `f${i}.txt`, data: 'x' });
  const buf = zipSync(many);
  assert.throws(() => unzipSync(buf, { limits: { maxEntries: 5 } }), /too many entries/);
});

test('unzip rejects an entry whose declared size exceeds the per-entry limit', () => {
  const buf = zipSync([{ name: 'big.txt', data: Buffer.alloc(1000, 65) }]);
  assert.throws(() => unzipSync(buf, { limits: { maxEntryUncompressed: 100 } }), /entry too large/);
});

test('unzip caps inflation so a deflate bomb cannot exhaust memory', () => {
  // A hand-built entry whose deflate stream expands far past the cap. The
  // maxOutputLength guard must abort inflation rather than allocating it all.
  const bomb = Buffer.alloc(10 * 1024 * 1024, 0); // 10 MiB of zeros -> tiny deflate
  const raw = zlib.deflateRawSync(bomb, { level: 9 });
  const name = 'bomb';
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc32(bomb), 14);
  local.writeUInt32LE(raw.length, 18);
  local.writeUInt32LE(bomb.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(bomb), 16);
  central.writeUInt32LE(raw.length, 20);
  central.writeUInt32LE(bomb.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const localBlock = Buffer.concat([local, nameBuf, raw]);
  const centralBlock = Buffer.concat([central, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);
  const buf = Buffer.concat([localBlock, centralBlock, eocd]);

  assert.throws(() => unzipSync(buf, { limits: { maxEntryUncompressed: 64 * 1024 } }));
});

// ---- transactional archive import -------------------------------------------

test('a corrupt step aborts the import leaving no partial guide', (t) => {
  const root = makeTmpDir('import-atomic');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);

  const guide = store.createGuide({ title: 'Src' });
  store.addStep(guide.guideId, { title: 'S1' }, TINY_PNG, { width: 1, height: 1 });
  const archiveFile = path.join(root, 'out.sfgz');
  exportGuideArchive(store, guide.guideId, archiveFile);

  // Corrupt the exported step so validation fails during import.
  const { unzipSync: uz } = require('../../core/zip');
  const entries = uz(fs.readFileSync(archiveFile));
  const tampered = entries.map((e) => {
    if (e.name.endsWith('step.json')) {
      const obj = JSON.parse(e.data.toString('utf8'));
      // Corrupt the image size to non-finite values — validateStep rejects
      // an image step with an invalid size.
      obj.image = { originalPath: 'original.png', workingPath: 'working.png', size: { width: 'x', height: null } };
      return { name: e.name, data: Buffer.from(JSON.stringify(obj)) };
    }
    return { name: e.name, data: e.data };
  });
  fs.writeFileSync(archiveFile, zipSync(tampered));

  const before = store.listGuides().length;
  assert.throws(() => importGuideArchive(store, archiveFile, { mode: 'copy' }));
  // No partial guide was left behind, and no staging dir remains.
  assert.equal(store.listGuides().length, before);
  const leftover = fs.readdirSync(store.guidesDir).filter((n) => n.includes('.importing'));
  assert.deepEqual(leftover, []);
});

test('a valid archive imports cleanly', (t) => {
  const root = makeTmpDir('import-ok');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'Src' });
  store.addStep(guide.guideId, { title: 'S1' }, TINY_PNG, { width: 1, height: 1 });
  const archiveFile = path.join(root, 'out.sfgz');
  exportGuideArchive(store, guide.guideId, archiveFile);

  const imported = importGuideArchive(store, archiveFile, { mode: 'copy' });
  assert.equal(imported.title, 'Src');
  assert.equal(imported.stepsOrder.length, 1);
});

// ---- atomic snapshot restore ------------------------------------------------

test('restoring a corrupt snapshot never destroys the live guide', (t) => {
  const root = makeTmpDir('snap-atomic');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'Live' });
  store.addStep(guide.guideId, { title: 'keep me' }, TINY_PNG, { width: 1, height: 1 });
  const snap = createSnapshot(store, guide.guideId, { label: 'good' });

  // Corrupt the snapshot zip so restore must abort.
  const snapFile = path.join(store.guideDir(guide.guideId), 'history', 'snapshots', snap);
  fs.writeFileSync(snapFile, Buffer.from('not a zip at all'));

  assert.throws(() => restoreSnapshot(store, guide.guideId, snap), /restore aborted|invalid|zip/i);
  // The live guide and its step are intact.
  const after = store.getGuide(guide.guideId);
  assert.equal(after.title, 'Live');
  assert.equal(after.stepsOrder.length, 1);
});

test('restoring a valid snapshot swaps content and keeps history', (t) => {
  const root = makeTmpDir('snap-ok');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'V1' });
  const s1 = store.addStep(guide.guideId, { title: 'first' }, TINY_PNG, { width: 1, height: 1 });
  const snap = createSnapshot(store, guide.guideId, { label: 'v1' });

  // Change the guide, then restore.
  store.saveGuide({ ...store.getGuide(guide.guideId), title: 'V2' });
  store.deleteStep(guide.guideId, s1.stepId);
  assert.equal(store.getGuide(guide.guideId).title, 'V2');

  const restored = restoreSnapshot(store, guide.guideId, snap);
  assert.equal(restored.title, 'V1');
  assert.equal(restored.stepsOrder.length, 1);
  // history/ survived the restore (pre-restore snapshot exists too).
  assert.ok(fs.existsSync(path.join(store.guideDir(guide.guideId), 'history')));
});

// ---- atomic locks -----------------------------------------------------------

test('another process holding a fresh lock is a conflict; release-by-token frees ours', (t) => {
  const root = makeTmpDir('lock');
  t.after(() => rmrf(root));
  const { lockPathFor } = require('../../core/locks');
  const target = path.join(root, 'shared.sfgz');
  fs.writeFileSync(target, 'x');

  // Simulate a different process already holding a fresh lock.
  fs.writeFileSync(lockPathFor(target), JSON.stringify({
    host: 'other-host', user: 'someone-else', pid: 999999,
    token: 'their-token', acquiredAt: new Date().toISOString(),
  }));

  const attempt = acquireLock(target);
  assert.equal(attempt.acquired, false);
  assert.ok(attempt.conflict);
  // We must not be able to release their lock with a guessed/absent token.
  assert.equal(releaseLock(target, { token: 'wrong' }), false);

  // Force-steal (user confirmed), then release by our own acquisition token.
  const stolen = acquireLock(target, { force: true });
  assert.equal(stolen.acquired, true);
  assert.equal(releaseLock(target, { lock: stolen.lock }), true);
  assert.equal(acquireLock(target).acquired, true);
});

test('the same process can re-acquire its own lock', (t) => {
  const root = makeTmpDir('lock-reacquire');
  t.after(() => rmrf(root));
  const target = path.join(root, 'shared.sfgz');
  fs.writeFileSync(target, 'x');
  assert.equal(acquireLock(target).acquired, true);
  // Same process, second acquire: not a conflict.
  assert.equal(acquireLock(target).acquired, true);
});

test('force steal takes over a held lock', (t) => {
  const root = makeTmpDir('lock-force');
  t.after(() => rmrf(root));
  const target = path.join(root, 'shared.sfgz');
  fs.writeFileSync(target, 'x');
  acquireLock(target);
  const stolen = acquireLock(target, { force: true });
  assert.equal(stolen.acquired, true);
});

// ---- search reconcile -------------------------------------------------------

test('reconcile rebuilds a missing index from the store', (t) => {
  const root = makeTmpDir('search-rebuild');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'Password reset guide' });
  store.addStep(guide.guideId, { title: 'Open admin portal' }, TINY_PNG, { width: 1, height: 1 });

  // A brand-new index (nothing persisted) must recover by reconciling.
  const index = new SearchIndex(store.indexDir);
  const summary = index.reconcile(store);
  assert.equal(summary.reindexed, 1);
  assert.ok(index.search('password').length > 0);
});

test('reconcile drops entries for deleted guides and reindexes changed ones', (t) => {
  const root = makeTmpDir('search-reconcile');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const g1 = store.createGuide({ title: 'alpha guide' });
  const g2 = store.createGuide({ title: 'beta guide' });
  const index = new SearchIndex(store.indexDir);
  index.reconcile(store);
  assert.ok(index.search('alpha').length > 0);

  // Delete g1 out from under the index and change g2's title.
  store.deleteGuide(g1.guideId);
  store.saveGuide({ ...store.getGuide(g2.guideId), title: 'beta renamed gamma' });

  const summary = index.reconcile(store);
  assert.equal(index.search('alpha').length, 0, 'deleted guide is gone from search');
  assert.ok(index.search('gamma').length > 0, 'changed guide is reindexed');
  assert.equal(summary.removed, 1);
});

test('a corrupt index file resets to a recoverable status', (t) => {
  const root = makeTmpDir('search-corrupt');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  store.createGuide({ title: 'recoverable' });
  fs.mkdirSync(store.indexDir, { recursive: true });
  fs.writeFileSync(path.join(store.indexDir, 'search-index.json'), '{ corrupt json');

  const index = new SearchIndex(store.indexDir);
  const summary = index.reconcile(store);
  assert.equal(summary.status, 'reset');
  assert.ok(index.search('recoverable').length > 0);
});

// ---- automatic backups ------------------------------------------------------

test('autoSnapshotIfDue takes a snapshot every N saves and prunes', (t) => {
  const root = makeTmpDir('auto-backup');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'G' });
  const settings = {
    get: (k) => ({ automatic: true, everyNSaves: 3, keepLast: 2 }[k.replace('backups.', '')] ?? ({ backups: { automatic: true, everyNSaves: 3, keepLast: 2 } }[k])),
  };
  // The helper reads settings.get('backups'):
  const s = { get: (k) => (k === 'backups' ? { automatic: true, everyNSaves: 3, keepLast: 2 } : null) };

  const dir = path.join(store.guideDir(guide.guideId), 'history', 'snapshots');
  const count = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.zip')).length : 0);

  assert.equal(autoSnapshotIfDue(store, guide.guideId, s), null); // 1
  assert.equal(autoSnapshotIfDue(store, guide.guideId, s), null); // 2
  assert.equal(autoSnapshotIfDue(store, guide.guideId, s), true); // 3 -> snapshot
  assert.equal(count(), 1);
  autoSnapshotIfDue(store, guide.guideId, s); // 1
  autoSnapshotIfDue(store, guide.guideId, s); // 2
  autoSnapshotIfDue(store, guide.guideId, s); // 3 -> snapshot
  assert.equal(count(), 2);
  autoSnapshotIfDue(store, guide.guideId, s);
  autoSnapshotIfDue(store, guide.guideId, s);
  autoSnapshotIfDue(store, guide.guideId, s); // 3rd snapshot, pruned to keepLast=2
  assert.equal(count(), 2, 'pruned to keepLast');
});

test('autoSnapshotIfDue is a no-op when automatic backups are off', (t) => {
  const root = makeTmpDir('auto-backup-off');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'G' });
  const s = { get: () => ({ automatic: false, everyNSaves: 1 }) };
  assert.equal(autoSnapshotIfDue(store, guide.guideId, s), null);
  assert.equal(autoSnapshotIfDue(store, guide.guideId, s), null);
  const dir = path.join(store.guideDir(guide.guideId), 'history', 'snapshots');
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0);
});
