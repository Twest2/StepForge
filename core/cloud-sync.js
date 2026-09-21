'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { GuideStore } = require('./store');
const { buildArchiveEntries, readArchive, importGuideArchive } = require('./archive');
const { zipSync } = require('./zip');
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

/** Immutable Drive snapshots: concurrent writers create branches, never overwrite bytes. */
class CloudSync {
  constructor({ store, drive, enabled, canReplace = () => true, canUpload = () => true, onChange = () => {}, onStatus = () => {}, settleMs = 3000 }) {
    Object.assign(this, { store, drive, enabled, canReplace, canUpload, onChange, onStatus, settleMs });
    this.directory = path.join(store.root, 'cloud');
    fs.mkdirSync(this.directory, { recursive: true });
    this.changedAt = new Map();
    this.fingerprints = new Map();
    this.generation = 0;
    this.state = { records: {} };
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

  // Poll file metadata rather than rereading every screenshot in an unchanged
  // library. Keep only hashes in memory; archive bytes are built when needed.
  localSnapshot(id) {
    const signature = [];
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name))) {
        const file = path.join(dir, entry.name);
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
    const account = await this.drive.account();
    check();
    const stateFile = path.join(this.directory, `sync-${digest(`${this.drive.clientId}:${account}`)}.json`);
    if (this.stateFile !== stateFile) {
      this.stateFile = stateFile;
      this.state = readJsonIfExists(stateFile, { records: {} });
    }
    const files = await this.drive.listVersions();
    check();
    const groups = new Map();
    for (const file of files) {
      const props = file.appProperties || {};
      if (!validId(props.guideId) || !validId(file.id) || !/^[a-f0-9]{64}$/.test(props.hash || '')) continue;
      if (!groups.has(props.guideId)) groups.set(props.guideId, []);
      groups.get(props.guideId).push(file);
    }
    for (const guide of this.store.listGuides()) if (!groups.has(guide.guideId)) groups.set(guide.guideId, []);
    let pending = false;
    let conflicts = 0;
    const errors = [];
    for (const [id, versions] of groups) {
      try {
        check();
        const record = Object.hasOwn(this.state.records, id) ? this.state.records[id] : null;
        if (record?.head && !versions.some((f) => f.id === record.head)) { pending = true; continue; }
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
          local = this.localSnapshot(id);
          exists = true;
          this.state.records[id] = { head: latest.id, heads: heads.map((h) => h.id), hash: local.hash };
          this.saveState();
        }
        if (!exists) continue;
        const baseline = Object.hasOwn(this.state.records, id) ? this.state.records[id] : null;
        if (!baseline || local.hash !== baseline.hash) {
          if (!this.canUpload(id)) { pending = true; continue; }
          const file = await this.drive.upload({ data: zipSync(local.entries), name: `${this.store.getGuide(id).title}.sfgz`,
            properties: { stepforge: 'guide-v1', guideId: id, hash: local.hash, ...(baseline?.head ? { parent: baseline.head } : {}) } });
          check();
          this.state.records[id] = { head: file.id, heads: [...heads.filter((h) => h.id !== baseline?.head).map((h) => h.id), file.id], hash: local.hash };
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

module.exports = { CloudSync, snapshot, headsOf };
