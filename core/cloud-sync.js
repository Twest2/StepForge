'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { GuideStore } = require('./store');
const { buildArchiveEntries, readArchive, importGuideArchive } = require('./archive');
const { zipSync } = require('./zip');
const { encodeArchive } = require('./background-archive');
const { atomicWriteFileSync, writeJsonSync, readJsonIfExists } = require('./util');

const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
function snapshot(store, id) {
  const entries = buildArchiveEntries(store, id);
  const hash = crypto.createHash('sha256');
  for (const entry of entries.filter((e) => e.name !== 'manifest.json').sort((a, b) => compareText(a.name, b.name))) {
    const bytes = Buffer.from(entry.data);
    hash.update(`${entry.name}:${bytes.length}:`).update(bytes);
  }
  return { hash: hash.digest('hex'), entries };
}
function headsOf(files) {
  const parents = new Set(files.map((f) => f.appProperties.parent).filter(Boolean));
  return files.filter((f) => !parents.has(f.id)).sort((a, b) =>
    compareText(a.createdTime || '', b.createdTime || '') || compareText(a.id, b.id));
}

const RETAIN_PER_BRANCH = 3; // current snapshot plus the two prior snapshots

function guideVersions(files) {
  const groups = new Map();
  for (const file of files) {
    const props = file.appProperties || {};
    if (!validId(props.guideId) || !validId(file.id) || !/^[a-f0-9]{64}$/.test(props.hash || '')) continue;
    if (!groups.has(props.guideId)) groups.set(props.guideId, []);
    groups.get(props.guideId).push(file);
  }
  return groups;
}

function protectedVersions(versions, retain = RETAIN_PER_BRANCH) {
  const byId = new Map(versions.map((file) => [file.id, file]));
  const keep = new Set();
  for (const head of headsOf(versions)) {
    let current = head;
    for (let count = 0; current && count < retain; count += 1) {
      keep.add(current.id);
      current = byId.get(current.appProperties?.parent);
    }
  }
  return keep;
}

function storageSummary(files, recoveryIds = new Set()) {
  const groups = guideVersions(files);
  const size = (file) => { const n = Number(file.size || 0); return Number.isFinite(n) ? n : 0; };
  let latestBytes = 0;
  let previousBytes = 0;
  let recoveryBytes = 0;
  let pruneCount = 0;
  let guideCount = 0;
  let snapshotCount = 0;
  for (const versions of groups.values()) {
    const latest = protectedVersions(versions, 1);
    const live = versions.filter((file) => !recoveryIds.has(file.id));
    if (live.length) guideCount += 1;
    for (const file of versions) {
      snapshotCount += 1;
      if (recoveryIds.has(file.id)) recoveryBytes += size(file);
      else if (latest.has(file.id)) latestBytes += size(file);
      else { previousBytes += size(file); pruneCount += 1; }
    }
  }
  return { guideCount, snapshotCount, bytes: latestBytes + previousBytes + recoveryBytes,
    latestBytes, previousBytes, recoveryBytes, pruneCount, reclaimableBytes: previousBytes };
}

// A missing baseline head can be Drive's listing lagging behind our own upload.
// Past this age it was pruned or replaced remotely, so re-evaluate from the cloud.
const STALE_HEAD_MS = 2 * 60 * 1000;

/** Immutable Drive snapshots: concurrent writers create branches, never overwrite bytes. */
class CloudSync {
  constructor({ store, drive, enabled, canReplace = () => true, canUpload = () => true, onChange = () => {}, onDelete = () => {}, onStatus = () => {}, settleMs = 3000 }) {
    Object.assign(this, { store, drive, enabled, canReplace, canUpload, onChange, onDelete, onStatus, settleMs });
    this.directory = path.join(store.root, 'cloud');
    fs.mkdirSync(this.directory, { recursive: true });
    this.changedAt = new Map();
    this.fingerprints = new Map();
    this.generation = 0;
    this.state = { records: {} };
    this.pendingFile = path.join(this.directory, 'pending-deletions.json');
    this.pending = readJsonIfExists(this.pendingFile, { records: {} });
    this.pending.records ||= {};
    this.status = { phase: 'off', message: 'Google Drive sharing is off.' };
    this.recover();
  }

  publish(phase, message, extra = {}) {
    this.status = { ...this.status, phase, message, ...extra };
    this.onStatus(this.status);
    return this.status;
  }

  start() {
    if (!this.interval) { this.interval = setInterval(() => { void this.sync(); }, 30000); this.interval.unref?.(); }
    void this.sync();
  }

  stop() {
    this.generation += 1;
    clearInterval(this.interval);
    clearTimeout(this.timer);
    this.interval = null;
    this.drive.cancel();
  }

  markChanged(id) {
    this.changedAt.set(id, Date.now());
    this.fingerprints.delete(id);
    if (!this.enabled()) return;
    this.publish('pending', 'Changes waiting to sync.');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.sync(); }, this.settleMs + 50);
    this.timer.unref?.();
  }

  isSharingEnabled(id) {
    return this.store.guideExists(id) && this.store.getGuide(id).cloud?.sharingEnabled !== false;
  }

  async storage() {
    if (!this.drive.status().connected) throw new Error('Sign in to Google Drive first.');
    const [files, markers, quota] = await Promise.all([this.drive.listVersions(), this.drive.listDeletions(),
      this.drive.quota ? this.drive.quota().catch(() => null) : null]);
    const recoveryIds = new Set([...this.deletionStates(markers).values()]
      .filter((file) => file.appProperties?.state === 'deleted').map((file) => file.appProperties.recoveryId));
    return { ...storageSummary(files, recoveryIds), quota };
  }

  async guides() {
    if (!this.drive.status().connected) throw new Error('Sign in to Google Drive first.');
    const [files, markers] = await Promise.all([this.drive.listVersions(), this.drive.listDeletions()]);
    const deleted = this.deletionStates(markers);
    return [...guideVersions(files)].filter(([id]) =>
      !['deleted', 'purged'].includes(deleted.get(id)?.appProperties.state)
    ).map(([id, versions]) => {
      versions.sort((a, b) => compareText(b.createdTime || '', a.createdTime || '') || compareText(b.id, a.id));
      const latest = versions[0];
      return { guideId: id, title: latest.name?.replace(/\.sfgz$/, '') || 'Untitled guide',
        snapshotCount: versions.length, bytes: versions.reduce((n, f) => n + (Number(f.size) || 0), 0),
        updatedAt: latest.createdTime || '', latestId: latest.id, local: this.store.guideExists(id) };
    }).sort((a, b) => compareText(a.title, b.title) || compareText(a.guideId, b.guideId));
  }

  // A manual mutation waits for any active sync and prevents another cycle
  // from uploading/deleting snapshots while the user changes cloud history.
  mutate(action) {
    this.manualCount = (this.manualCount || 0) + 1;
    const job = (this.manualTail || Promise.resolve()).catch(() => {}).then(async () => {
      await this.running;
      return action();
    });
    this.manualTail = job;
    return job.finally(() => { this.manualCount -= 1; });
  }

  async history(id) {
    if (!this.drive.status().connected) throw new Error('Sign in to Google Drive first.');
    return (await this.drive.listVersions())
      .filter((file) => file.appProperties?.guideId === id)
      .sort((a, b) => compareText(b.createdTime || '', a.createdTime || '') || compareText(b.id, a.id))
      .map((file, index) => ({ id: file.id, createdTime: file.createdTime || '', size: Number(file.size || 0), current: index === 0 }));
  }

  // Manual pruning keeps only the newest snapshot on every branch. Automatic
  // pruning after a sync keeps two previous snapshots for restoring.
  prune() { return this.mutate(() => this.pruneNow(1)); }

  async pruneNow(retain = RETAIN_PER_BRANCH) {
    if (!this.drive.status().connected) throw new Error('Sign in to Google Drive first.');
    const files = await this.drive.listVersions();
    const remove = [];
    for (const versions of guideVersions(files).values()) {
      const keep = protectedVersions(versions, retain);
      remove.push(...versions.filter((file) => !keep.has(file.id)));
    }
    for (const file of remove) await this.drive.deleteFile(file.id);
    return { pruned: remove.length, reclaimedBytes: remove.reduce((n, file) => n + (Number(file.size) || 0), 0) };
  }

  async loadAccountState() {
    const account = await this.drive.account();
    const stateFile = path.join(this.directory, `sync-${digest(`${this.drive.clientId}:${account}`)}.json`);
    if (this.stateFile !== stateFile) {
      this.stateFile = stateFile;
      this.state = readJsonIfExists(stateFile, { records: {} });
    }
    this.state.records ||= {};
  }

  // Makes this computer's library the whole of Google Drive: every cloud
  // snapshot and recovery copy is deleted, guides missing here are marked
  // purged so other devices move them to trash, then local guides re-upload.
  replaceCloudWithLocal() {
    return this.mutate(() => this.replaceCloudWithLocalNow()).then(async (result) => {
      await this.sync();
      return result;
    });
  }

  async replaceCloudWithLocalNow() {
    if (!this.drive.status().connected) throw new Error('Sign in to Google Drive first.');
    if (!this.enabled()) throw new Error('Turn on automatic sync before replacing Google Drive.');
    await this.loadAccountState();
    const [files, markers] = await Promise.all([this.drive.listVersions(), this.drive.listDeletions()]);
    const local = new Set(this.store.listGuides().map((guide) => guide.guideId));
    const groups = guideVersions(files);
    const states = this.deletionStates(markers);
    const titles = new Map();
    for (const [id, versions] of groups) {
      const latest = [...versions].sort((a, b) => compareText(b.createdTime || '', a.createdTime || ''))[0];
      titles.set(id, latest.name?.replace(/( \(deleted\))?\.sfgz$/, '') || 'Guide');
    }
    for (const [id, marker] of states) {
      if (['deleted', 'purged'].includes(marker.appProperties?.state)) titles.set(id, marker.appProperties.title || titles.get(id) || 'Guide');
    }
    const keepMarkers = new Set();
    let purged = 0;
    for (const [id, title] of titles) {
      if (local.has(id)) continue;
      const marker = await this.drive.upload({ data: Buffer.from('{}'), name: `Deleted ${title}`,
        properties: { stepforge: 'deletion-v1', guideId: id, state: 'purged', title, deletedAt: new Date().toISOString() } });
      keepMarkers.add(marker.id);
      purged += 1;
    }
    for (const file of files) await this.drive.deleteFile(file.id);
    for (const file of markers) if (!keepMarkers.has(file.id)) await this.drive.deleteFile(file.id);
    for (const id of Object.keys(this.pending.records)) this.clearPendingDeletion(id);
    this.state.records = {};
    this.saveState();
    this.fingerprints.clear();
    return { removed: files.length, purged, uploading: [...local].filter((id) => this.isSharingEnabled(id)).length };
  }

  async setSharing(id, sharingEnabled) {
    if (!this.store.guideExists(id)) throw new Error('Guide no longer exists.');
    const guide = this.store.getGuide(id);
    guide.cloud = { ...(guide.cloud || {}), sharingEnabled: Boolean(sharingEnabled) };
    this.store.saveGuide(guide);
    this.fingerprints.delete(id);
    if (sharingEnabled) this.markChanged(id);
    return guide.cloud;
  }

  removeGuideSnapshots(id) { return this.mutate(() => this.removeGuideSnapshotsNow(id)); }

  async removeGuideSnapshotsNow(id) {
    if (!this.drive.status().connected) throw new Error('Sign in to Google Drive first.');
    if (this.store.guideExists(id)) await this.setSharing(id, false);
    const files = (await this.drive.listVersions()).filter((file) => file.appProperties?.guideId === id);
    for (const file of files) await this.drive.deleteFile(file.id);
    delete this.state.records[id];
    if (this.stateFile) this.saveState();
    return { removed: files.length };
  }

  restore(id, versionId) { return this.mutate(() => this.restoreNow(id, versionId)); }

  async restoreNow(id, versionId) {
    if (!this.drive.status().connected) throw new Error('Sign in to Google Drive first.');
    if (!this.canReplace(id)) throw new Error('Close the editor or stop capture before restoring a cloud snapshot.');
    await this.loadAccountState();
    const files = await this.drive.listVersions();
    const version = files.find((file) => file.id === versionId && file.appProperties?.guideId === id);
    if (!version) throw new Error('That cloud snapshot is no longer available.');
    const bytes = await this.drive.download(version.id);
    this.validateDownload(bytes, id, version.appProperties.hash);
    if (!this.canReplace(id)) throw new Error('The guide became active while restoring. No changes were made.');
    const sharing = this.store.guideExists(id) ? this.store.getGuide(id).cloud?.sharingEnabled : undefined;
    this.install(bytes, id, id);
    if (sharing === false) await this.setSharing(id, false);
    // Accept the current remote heads as the baseline, then upload the
    // restored content as a new version instead of downloading those heads.
    const heads = headsOf(files.filter((file) => file.appProperties?.guideId === id));
    const latest = heads.at(-1);
    this.state.records[id] = { head: latest?.id, heads: heads.map((file) => file.id), hash: latest?.appProperties.hash, syncedAt: Date.now() };

    if (this.stateFile) this.saveState();
    this.markChanged(id);
    return { ok: true };
  }

  // Poll file metadata rather than rereading every screenshot in an unchanged
  // library. Keep only hashes in memory; archive bytes are built when needed.
  localSnapshot(id) {
    const signature = [];
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name))) {
        const file = path.join(dir, entry.name);
        // History is not uploaded; backup counter/snapshot changes must not
        // invalidate the screenshot hash cache on every autosave.
        if (dir === this.store.guideDir(id) && entry.name === 'history') continue;
        if (entry.isDirectory()) visit(file);
        else {
          const stat = fs.statSync(file);
          signature.push(`${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`);
        }
      }
    };
    visit(this.store.guideDir(id));
    const key = signature.join('\n');
    let cached = this.fingerprints.get(id);
    if (!cached || cached.key !== key) {
      cached = { key, hash: snapshot(this.store, id).hash };
      this.fingerprints.set(id, cached);
    }
    const store = this.store;
    return { hash: cached.hash, get entries() { return buildArchiveEntries(store, id); } };
  }

  saveState() { writeJsonSync(this.stateFile, this.state); }

  savePending() { writeJsonSync(this.pendingFile, this.pending); }

  pendingArchive(id) { return path.join(this.directory, 'deletions', `${id}.sfgz`); }

  stageDeletion(id) {
    // Only a guide which this device has already synchronized gets a cloud
    // deletion record. A local-only guide remains local-only.
    if (!this.store.guideExists(id) || (!this.state.records[id] && !this.store.getGuide(id).cloud?.wasShared) || !this.isSharingEnabled(id)) return false;
    const guide = this.store.getGuide(id);
    const local = this.localSnapshot(id);
    const archive = this.pendingArchive(id);
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    atomicWriteFileSync(archive, zipSync(local.entries));
    this.pending.records[id] = { title: guide.title, hash: local.hash, deletedAt: new Date().toISOString() };
    this.savePending();
    if (this.enabled()) this.markChanged(id);
    return true;
  }

  clearPendingDeletion(id) {
    delete this.pending.records[id];
    fs.rmSync(this.pendingArchive(id), { force: true });
    this.savePending();
  }

  deletionStates(files) {
    const states = new Map();
    for (const file of files) {
      const props = file.appProperties || {};
      if (!validId(props.guideId) || !validId(file.id)) continue;
      const previous = states.get(props.guideId);
      if (!previous || compareText(`${previous.createdTime || ''}:${previous.id}`, `${file.createdTime || ''}:${file.id}`) <= 0) states.set(props.guideId, file);
    }
    return states;
  }

  async deletedGuides() {
    if (!this.drive.status().connected) throw new Error('Sign in to Google Drive first.');
    const [files, deletionFiles] = await Promise.all([this.drive.listVersions(), this.drive.listDeletions()]);
    const states = this.deletionStates(deletionFiles);
    return [...states.values()].filter((file) => ['deleted', 'purged'].includes(file.appProperties?.state)).map((file) => {
      const recovery = files.find((candidate) => candidate.id === file.appProperties.recoveryId);
      return { guideId: file.appProperties.guideId, title: file.appProperties.title || 'Deleted guide', deletedAt: file.appProperties.deletedAt || file.createdTime || '',
        recoveryId: recovery?.id || null, size: Number(recovery?.size || 0), purged: file.appProperties.state === 'purged' };
    });
  }

  async restoreDeletedGuide(id) {
    if (!this.canReplace(id)) throw new Error('Close the editor or stop capture before restoring a cloud guide.');
    const [files, deletionFiles] = await Promise.all([this.drive.listVersions(), this.drive.listDeletions()]);
    const marker = this.deletionStates(deletionFiles).get(id);
    const recovery = files.find((file) => file.id === marker?.appProperties?.recoveryId);
    if (!marker || marker.appProperties.state !== 'deleted' || !recovery) throw new Error('No recoverable cloud snapshot is available for this guide.');
    const bytes = await this.drive.download(recovery.id);
    this.validateDownload(bytes, id, recovery.appProperties.hash);
    if (!this.canReplace(id)) throw new Error('The guide became active while restoring. No changes were made.');
    this.install(bytes, id, id);
    const restored = await this.drive.upload({ data: Buffer.from('{}'), name: `Restored ${marker.appProperties.title || 'guide'}`,
      properties: { stepforge: 'deletion-v1', guideId: id, state: 'restored', restoredAt: new Date().toISOString() } });
    await Promise.all(deletionFiles.filter((file) => file.appProperties?.guideId === id && file.id !== restored.id).map((file) => this.drive.deleteFile(file.id)));
    delete this.state.records[id];
    if (this.stateFile) this.saveState();
    this.markChanged(id);
    return { ok: true };
  }

  async permanentlyDeleteRecovery(id) {
    const [files, deletionFiles] = await Promise.all([this.drive.listVersions(), this.drive.listDeletions()]);
    const marker = this.deletionStates(deletionFiles).get(id);
    if (!marker || marker.appProperties.state !== 'deleted') throw new Error('No deleted-guide recovery snapshot is available.');
    const purged = await this.drive.upload({ data: Buffer.from('{}'), name: `Deleted ${marker.appProperties.title || 'guide'}`,
      properties: { stepforge: 'deletion-v1', guideId: id, state: 'purged', title: marker.appProperties.title || '', deletedAt: marker.appProperties.deletedAt || new Date().toISOString() } });
    const recoveryId = marker.appProperties.recoveryId;
    if (recoveryId) await this.drive.deleteFile(recoveryId);
    await Promise.all(deletionFiles.filter((file) => file.appProperties?.guideId === id && file.id !== purged.id).map((file) => this.drive.deleteFile(file.id)));
    delete this.state.records[id];
    if (this.stateFile) this.saveState();
    return { ok: true };
  }

  markWasShared(id) {
    if (!this.store.guideExists(id)) return;
    const guide = this.store.getGuide(id);
    if (guide.cloud?.wasShared) return;
    guide.cloud = { ...(guide.cloud || {}), wasShared: true };
    this.store.saveGuide(guide);
    this.fingerprints.delete(id);
  }

  recover() {
    const journal = path.join(this.directory, 'install.json');
    const pending = readJsonIfExists(journal, null);
    if (!pending || !validId(pending.guideId) || !validId(pending.backup)) return;
    const target = this.store.guideDir(pending.guideId);
    const backup = path.join(this.directory, 'backups', pending.backup);
    if (!fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target);
    fs.rmSync(journal, { force: true });
  }

  // All network awaits precede this synchronous, staged install. Existing bytes
  // remain in cloud/backups, with a journal to recover an interrupted directory swap.
  install(data, sourceId, targetId, title = null) {
    const stagingRoot = fs.mkdtempSync(path.join(this.store.tempDir, 'cloud-'));
    try {
      const file = path.join(stagingRoot, 'incoming.sfgz');
      atomicWriteFileSync(file, data);
      const archive = readArchive(file);
      if (archive.guide.guideId !== sourceId || !validId(sourceId) || !validId(targetId)
          || archive.guide.stepsOrder.some((id) => !validId(id))
          || archive.entries.some((e) => e.name.startsWith('steps/') && !validId(e.name.split('/')[1]))) {
        throw new Error('Cloud archive contains an invalid guide or step identity.');
      }
      const staged = new GuideStore(path.join(stagingRoot, 'staged'));
      const guide = importGuideArchive(staged, file, { mode: 'linked' });
      guide.guideId = targetId;
      guide.linkedSource = this.store.guideExists(targetId) ? this.store.getGuide(targetId).linkedSource : null;
      if (title) guide.title = title;
      writeJsonSync(path.join(staged.guideDir(sourceId), 'guide.json'), guide);
      const target = this.store.guideDir(targetId);
      const backup = crypto.randomUUID();
      const backupPath = path.join(this.directory, 'backups', backup);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      writeJsonSync(path.join(this.directory, 'install.json'), { guideId: targetId, backup });
      if (fs.existsSync(target)) fs.renameSync(target, backupPath);
      try { fs.renameSync(staged.guideDir(sourceId), target); }
      catch (err) { if (fs.existsSync(backupPath)) fs.renameSync(backupPath, target); throw err; }
      fs.rmSync(path.join(this.directory, 'install.json'), { force: true });
      this.onChange(targetId);
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  }

  sync() {
    if (this.manualCount) return Promise.resolve(this.status);
    if (this.running) return this.running;
    this.running = this.run().catch((err) => {
      if (this.enabled()) this.publish('error', err.message);
      else this.publish('off', 'Google Drive sharing is off.');
      return this.status;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  async run() {
    if (!this.enabled()) return this.publish('off', 'Google Drive sharing is off.');
    if (!this.drive.status().connected) return this.publish('disconnected', this.drive.status().error || 'Sign in to Google Drive in Settings.');
    const generation = this.generation;
    const check = () => {
      if (!this.enabled() || generation !== this.generation) throw new Error('Cloud synchronization stopped.');
    };
    this.publish('syncing', 'Syncing with Google Drive…');
    await this.loadAccountState();
    check();
    const [files, deletionFiles] = await Promise.all([this.drive.listVersions(), this.drive.listDeletions()]);
    check();
    const deletions = this.deletionStates(deletionFiles);
    // Deletions are explicit Drive records, never inferred from a missing
    // directory. This makes an offline device converge without allowing an
    // old local copy to recreate the guide.
    for (const [id, marker] of deletions) {
      if (!['deleted', 'purged'].includes(marker.appProperties?.state)) continue;
      if (this.store.guideExists(id)) {
        this.store.deleteGuide(id);
        this.onDelete(id);
      }
      delete this.state.records[id];
      if (this.pending.records[id]) this.clearPendingDeletion(id);
    }
    for (const [id, pendingDelete] of Object.entries(this.pending.records)) {
      check();
      const remote = deletions.get(id);
      if (remote && ['deleted', 'purged'].includes(remote.appProperties?.state)) {
        this.clearPendingDeletion(id);
        continue;
      }
      const archive = this.pendingArchive(id);
      if (!fs.existsSync(archive)) throw new Error(`Pending cloud deletion for ${id} is missing its recovery archive.`);
      const recovery = await this.drive.upload({ data: fs.readFileSync(archive), name: `${pendingDelete.title} (deleted).sfgz`,
        properties: { stepforge: 'guide-v1', guideId: id, hash: pendingDelete.hash } });
      check();
      const marker = await this.drive.upload({ data: Buffer.from('{}'), name: `Deleted ${pendingDelete.title}`,
        properties: { stepforge: 'deletion-v1', guideId: id, state: 'deleted', title: pendingDelete.title, deletedAt: pendingDelete.deletedAt, recoveryId: recovery.id } });
      check();
      await Promise.all(files.filter((file) => file.appProperties?.guideId === id && file.id !== recovery.id).map((file) => this.drive.deleteFile(file.id)));
      await Promise.all(deletionFiles.filter((file) => file.appProperties?.guideId === id && file.id !== marker.id).map((file) => this.drive.deleteFile(file.id)));
      deletions.set(id, marker);
      delete this.state.records[id];
      this.clearPendingDeletion(id);
      this.saveState();
    }
    const groups = guideVersions(files);
    for (const [id, marker] of deletions) {
      if (['deleted', 'purged'].includes(marker.appProperties?.state)) groups.delete(id);
    }
    for (const guide of this.store.listGuides()) if (!groups.has(guide.guideId)) groups.set(guide.guideId, []);
    let pending = false;
    let conflicts = 0;
    const errors = [];
    for (const [id, versions] of groups) {
      try {
        check();
        // A guide can remain local while all of its private Drive snapshots
        // are removed. Never download or upload it while it is opted out.
        if (this.store.guideExists(id) && !this.isSharingEnabled(id)) continue;
        let record = Object.hasOwn(this.state.records, id)
          ? this.state.records[id]
          : null;
        
        if (record?.head && !versions.some((f) => f.id === record.head)) {
          if (versions.length === 0) {
            // Cloud history was removed externally.
            // Reset the baseline so the local guide can be uploaded again.
            delete this.state.records[id];
            this.saveState();
            record = null;
          } else if (Date.now() - (record.syncedAt || 0) > STALE_HEAD_MS) {
            // Keep the content hash so local edits still become conflict copies.
            record = { hash: record.hash };
          } else {
            pending = true;
            continue;
          }
        }
        let exists = this.store.guideExists(id);
        // Local trash stays local: don't silently restore or delete on another device.
        if (!exists && record) continue;
        if (Date.now() - (this.changedAt.get(id) || 0) < this.settleMs) { pending = true; continue; }
        let local = exists ? this.localSnapshot(id) : null;
        const heads = headsOf(versions);
        const latest = heads.at(-1);
        const newHeads = heads.filter((h) => !record?.heads?.includes(h.id));
        const remoteChanged = latest && newHeads.length > 0;
        if (remoteChanged) {
          // Never replace a live editor's guide, including unsaved input or capture.
          if (!this.canReplace(id)) { pending = true; continue; }
          const incoming = await this.drive.download(latest.id);
          check();
          if (!this.canReplace(id) || this.store.guideExists(id) !== exists
              || (exists && this.localSnapshot(id).hash !== local.hash)) { pending = true; continue; }
          // Validate fully in an isolated store, including the advertised content hash,
          // before preserving conflicts or touching the real guide.
          this.validateDownload(incoming, id, latest.appProperties.hash);
          const localChanged = local && (!record || local.hash !== record.hash);
          if (localChanged && local.hash !== latest.appProperties.hash) {
            const copyId = `guide-conflict-${digest(`${id}:${local.hash}`).slice(0, 32)}`;
            if (!this.store.guideExists(copyId)) {
              this.install(zipSync(local.entries), id, copyId, `${this.store.getGuide(id).title} (conflict — this device)`);
              conflicts += 1;
            }
          }
          // Other concurrent tips are durable conflict copies, with stable identities
          // so repeated polls and separate devices do not manufacture duplicates.
          for (const other of heads.filter((h) => h.id !== latest.id && h.appProperties.hash !== latest.appProperties.hash)) {
            const copyId = `guide-conflict-${digest(`${id}:${other.id}`).slice(0, 32)}`;
            if (this.store.guideExists(copyId)) continue;
            const bytes = await this.drive.download(other.id);
            check();
            this.validateDownload(bytes, id, other.appProperties.hash);
            this.install(bytes, id, copyId, `${other.name.replace(/\.sfgz$/, '')} (conflict — another device)`);
            conflicts += 1;
          }
          // A user can edit/open the guide while the other conflict branches download.
          if (!this.canReplace(id) || this.store.guideExists(id) !== exists
              || (exists && this.localSnapshot(id).hash !== local.hash)) { pending = true; continue; }
          if (!local || local.hash !== latest.appProperties.hash) this.install(incoming, id, id);
          const alreadyMarkedShared = this.store.getGuide(id).cloud?.wasShared === true;
          if (!alreadyMarkedShared) this.markWasShared(id);
          local = this.localSnapshot(id);
          exists = true;
          this.state.records[id] = { head: latest.id, heads: heads.map((h) => h.id), hash: alreadyMarkedShared ? local.hash : latest.appProperties.hash, syncedAt: Date.now() };
          this.saveState();
        }
        if (!exists) continue;
        const baseline = Object.hasOwn(this.state.records, id) ? this.state.records[id] : null;
        if (!baseline || local.hash !== baseline.hash) {
          if (!this.canUpload(id)) { pending = true; continue; }
          // Persist the shared marker in the first archive so a later offline
          // deletion can safely tell a shared guide from a local-only guide.
          if (!this.store.getGuide(id).cloud?.wasShared) {
            this.markWasShared(id);
            local = this.localSnapshot(id);
          }
          const name = `${this.store.getGuide(id).title}.sfgz`;
          const data = await encodeArchive(local.entries);
          check();
          if (!this.store.guideExists(id) || !this.isSharingEnabled(id) || !this.canUpload(id)) {
            pending = true;
            continue;
          }
          const file = await this.drive.upload({ data, name,
            properties: { stepforge: 'guide-v1', guideId: id, hash: local.hash, ...(baseline?.head ? { parent: baseline.head } : {}) } });
          check();
          this.state.records[id] = { head: file.id, heads: [...heads.filter((h) => h.id !== baseline?.head).map((h) => h.id), file.id], hash: local.hash, syncedAt: Date.now() };
          this.saveState();
          // If edits happened during upload, this baseline describes only uploaded bytes.
          if (this.store.guideExists(id) && this.localSnapshot(id).hash !== local.hash) pending = true;
        }
      } catch (err) {
        check();
        errors.push(err.message);
      }
    }
    if (errors.length) this.publish('error', `${errors.length} guide(s) could not sync: ${errors[0]}`);
    else if (conflicts) this.publish('conflict', `${conflicts} conflict ${conflicts === 1 ? 'copy preserved' : 'copies preserved'} in your library.`, { lastSync: new Date().toISOString() });
    else if (pending) this.publish('pending', 'Changes pending. Incoming updates wait until the guide is closed.');
    else this.publish('synced', 'Guides are synced with Google Drive.', { lastSync: new Date().toISOString() });
    // Snapshots are immutable. Retain the current version and two prior
    // versions on every live conflict branch after a successful sync.
    if (!errors.length && !pending) await this.pruneNow();
    return this.status;
  }

  validateDownload(data, id, expectedHash) {
    const root = fs.mkdtempSync(path.join(this.store.tempDir, 'cloud-check-'));
    try {
      const staging = new GuideStore(root);
      const checker = new CloudSync({ store: staging, drive: this.drive, enabled: () => false });
      checker.install(data, id, id);
      if (snapshot(staging, id).hash !== expectedHash) throw new Error('Cloud archive integrity check failed. Local guides are unchanged.');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}

module.exports = { CloudSync, snapshot, headsOf, guideVersions, protectedVersions, storageSummary, RETAIN_PER_BRANCH };
