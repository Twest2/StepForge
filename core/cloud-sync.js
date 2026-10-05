'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { GuideStore } = require('./store');
const { buildArchiveEntries, readArchive, importGuideArchive } = require('./archive');
const { zipSync, unzipSync } = require('./zip');
const { atomicWriteFileSync, writeJsonSync, readJsonIfExists } = require('./util');
const { TransferMeter } = require('./transfer-meter');
const { mergeGuideEntries } = require('./guide-merge');
const { createSnapshot } = require('./snapshots');
const parts = require('./cloud-parts');

const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
const archiveTitle = (file) => file.name?.replace(/( \(deleted\))?\.sfgz$/, '') || 'Guide';
function snapshot(store, id) {
  const entries = buildArchiveEntries(store, id);
  return { hash: parts.contentHash(entries), entries };
}
/**
 * The versions a version was made from: its parent, plus any other branches
 * a merge folded in (`merged`, comma-separated ids).
 */
function parentsOf(file) {
  const props = file.appProperties || {};
  return [props.parent, ...String(props.merged || '').split(',')].filter(validId);
}
function headsOf(files) {
  const parents = new Set(files.flatMap(parentsOf));
  return files.filter((f) => !parents.has(f.id)).sort((a, b) =>
    compareText(a.createdTime || '', b.createdTime || '') || compareText(a.id, b.id));
}
// Drive limits a property to 124 bytes, key included.
const MERGED_LIMIT = 110;
function mergedProperty(ids) {
  let value = '';
  for (const id of ids) {
    const next = value ? `${value},${id}` : id;
    if (next.length > MERGED_LIMIT) break;
    value = next;
  }
  return value;
}

function mergeMessage(label, merged, conflicts) {
  const synced = `Guides are synced with ${label}.`;
  if (!merged) return synced;
  const guides = merged === 1 ? '1 guide' : `${merged} guides`;
  const newest = conflicts ? ' Where both computers changed the same thing, the newest change was kept.' : '';
  return `${synced} Combined changes from more than one computer in ${guides}.${newest}`;
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

const sizeOf = (file) => { const n = Number(file?.size || 0); return Number.isFinite(n) && n > 0 ? n : 0; };

/**
 * Where Drive space goes. `partFiles` are the shared files of parts
 * snapshots and `refs` maps each parts snapshot to the part hashes it uses.
 * A part counts once, as "latest" if any latest version uses it, so
 * "previous" is exactly what Free up space can reclaim.
 */
function storageSummary(files, recoveryIds = new Set(), { partFiles = [], refs = new Map() } = {}) {
  const groups = guideVersions(files);
  let latestBytes = 0;
  let previousBytes = 0;
  let recoveryBytes = 0;
  let pruneCount = 0;
  let guideCount = 0;
  let snapshotCount = 0;
  let fullCount = 0;
  const latestShas = new Set();
  const recoveryShas = new Set();
  for (const versions of groups.values()) {
    const latest = protectedVersions(versions, 1);
    const live = versions.filter((file) => !recoveryIds.has(file.id));
    if (live.length) guideCount += 1;
    for (const file of versions) {
      snapshotCount += 1;
      const shas = refs.get(file.id) || [];
      if (recoveryIds.has(file.id)) { recoveryBytes += sizeOf(file); shas.forEach((sha) => recoveryShas.add(sha)); }
      else if (latest.has(file.id)) {
        latestBytes += sizeOf(file);
        shas.forEach((sha) => latestShas.add(sha));
        if (!parts.isPartsSnapshot(file)) fullCount += 1;
      } else { previousBytes += sizeOf(file); pruneCount += 1; }
    }
  }
  const counted = new Set();
  for (const part of partFiles) {
    const sha = part.appProperties?.sha;
    if (counted.has(sha)) { previousBytes += sizeOf(part); continue; } // a duplicate copy
    counted.add(sha);
    if (latestShas.has(sha)) latestBytes += sizeOf(part);
    else if (recoveryShas.has(sha)) recoveryBytes += sizeOf(part);
    else previousBytes += sizeOf(part);
  }
  return { guideCount, snapshotCount, bytes: latestBytes + previousBytes + recoveryBytes,
    latestBytes, previousBytes, recoveryBytes, pruneCount, fullCount, reclaimableBytes: previousBytes };
}

// A missing baseline head can be Drive's listing lagging behind our own upload.
// Past this age it was pruned or replaced remotely, so re-evaluate from the cloud.
const STALE_HEAD_MS = 2 * 60 * 1000;
// A part nothing uses is only removed once it is this old, so a part another
// computer has just uploaded for a version it hasn't finished saving is safe.
const PART_GRACE_MS = 60 * 60 * 1000;
// Clean up unused parts at least this often, even when nothing was pruned.
const PART_CLEANUP_MS = 6 * 60 * 60 * 1000;

/** Immutable Drive snapshots: concurrent writers create branches, never overwrite bytes. */
class CloudSync {
  constructor({ store, drive, enabled, canReplace = () => true, canUpload = () => true, onChange = () => {}, onDelete = () => {}, onStatus = () => {}, settleMs = 3000,
    inlineLimit = parts.INLINE_LIMIT, partGraceMs = PART_GRACE_MS }) {
    Object.assign(this, { store, drive, enabled, canReplace, canUpload, onChange, onDelete, onStatus, settleMs, inlineLimit, partGraceMs });
    this.directory = path.join(store.root, 'cloud');
    this.partIndexCache = null;
    this.lastPartCleanup = 0;
    fs.mkdirSync(this.directory, { recursive: true });
    this.changedAt = new Map();
    this.fingerprints = new Map();
    this.generation = 0;
    this.state = { records: {} };
    this.pendingFile = path.join(this.directory, 'pending-deletions.json');
    this.pending = readJsonIfExists(this.pendingFile, { records: {} });
    this.pending.records ||= {};
    this.status = { phase: 'off', message: `${this.label} sharing is off.` };
    this.recover();
  }

  /** The service's name for messages, such as "Google Drive" or "OneDrive". */
  get label() { return this.drive.label || 'Google Drive'; }

  /**
   * Sync with another service or account. The caller stops sync first; each
   * account keeps its own sync records, so nothing carries over by mistake.
   */
  setDrive(drive) {
    this.stop();
    this.drive = drive;
    this.stateFile = null;
    this.state = { records: {} };
    this.partIndexCache = null;
    this.lastPartCleanup = 0;
    this.partCleanupNeeded = false;
  }

  publish(phase, message, extra = {}) {
    this.status = { ...this.status, phase, message, ...extra };
    this.onStatus(this.status);
    return this.status;
  }

  // Publishes live progress for one archive transfer. Tiny deletion markers
  // are not worth showing, so only guide archives go through here.
  async transfer(direction, name, total, action) {
    const meter = new TransferMeter({ direction, name, total,
      onUpdate: (transfer) => this.publish(this.status.phase, this.status.message, { transfer }) });
    meter.report();
    try { return await action((loaded) => meter.update(loaded)); }
    finally { this.publish(this.status.phase, this.status.message, { transfer: null }); }
  }

  downloadArchive(file) {
    return this.transfer('download', archiveTitle(file), file.size,
      (onProgress) => this.drive.download(file.id, { onProgress }));
  }

  uploadArchive({ data, name, properties }) {
    return this.transfer('upload', name.replace(/\.sfgz$/, ''), data.length,
      (onProgress) => this.drive.upload({ data, name, properties, onProgress }));
  }

  // ---- parts snapshots (core/cloud-parts.js) ------------------------------

  /** Part files in Drive by hash. The oldest copy of a hash wins. */
  async partIndex(refresh = false) {
    if (refresh || !this.partIndexCache) {
      const index = new Map();
      const files = (await this.drive.listParts())
        .filter((file) => validId(file.id) && parts.SHA_PATTERN.test(file.appProperties?.sha || ''))
        .sort((a, b) => compareText(a.createdTime || '', b.createdTime || '') || compareText(a.id, b.id));
      for (const file of files) if (!index.has(file.appProperties.sha)) index.set(file.appProperties.sha, file);
      this.partIndexCache = index;
    }
    return this.partIndexCache;
  }

  manifestPath(id) { return path.join(this.directory, 'manifests', `${id}.gz`); }

  /**
   * A parts snapshot's manifest. Snapshots never change, so it is cached on
   * disk. `progress` shows the download like any other guide transfer.
   */
  async manifestFor(file, { progress = false } = {}) {
    if (!validId(file.id)) throw new Error(`A ${this.label} version is damaged and can’t be read.`);
    const cached = this.manifestPath(file.id);
    try { return parts.decodeSnapshot(fs.readFileSync(cached)); } catch { /* not cached yet, or unreadable */ }
    const bytes = progress ? await this.downloadArchive(file) : await this.drive.download(file.id);
    const manifest = parts.decodeSnapshot(bytes);
    this.cacheManifest(file.id, bytes);
    return manifest;
  }

  cacheManifest(id, bytes) {
    try {
      fs.mkdirSync(path.dirname(this.manifestPath(id)), { recursive: true });
      atomicWriteFileSync(this.manifestPath(id), bytes);
    } catch { /* only a cache */ }
  }

  /**
   * Part hashes used by each parts snapshot in `files`. With `strict` a
   * manifest that can't be read is an error; otherwise it's skipped.
   */
  async partRefs(files, { strict = false } = {}) {
    const refs = new Map();
    const queue = files.filter((file) => parts.isPartsSnapshot(file));
    const worker = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        try { refs.set(file.id, parts.partShas(await this.manifestFor(file))); } catch (err) { if (strict) throw err; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    return refs;
  }

  /**
   * Save a version as a parts snapshot: upload the parts Drive doesn't have
   * yet, then the manifest. Returns { file, uploaded } (bytes sent).
   */
  async uploadVersion({ encoded, name, properties, check = () => {} }) {
    const index = await this.partIndex();
    check();
    const missing = [...encoded.parts].filter(([sha]) => !index.has(sha));
    const total = missing.reduce((n, [, data]) => n + data.length, 0) + encoded.manifest.length;
    const file = await this.transfer('upload', name.replace(/\.sfgz$/, ''), total, async (onProgress) => {
      let done = 0;
      for (const [sha, data] of missing) {
        const part = await this.drive.upload({ data, name: `part-${sha}`, properties: { stepforge: parts.PART_KIND, sha },
          onProgress: (n) => onProgress(done + n) });
        check();
        index.set(sha, { ...part, size: String(data.length) });
        done += data.length;
      }
      return this.drive.upload({ data: encoded.manifest, name,
        properties: { ...properties, format: parts.PARTS_FORMAT, bytes: String(encoded.bytes) },
        onProgress: (n) => onProgress(done + n) });
    });
    this.cacheManifest(file.id, encoded.manifest);
    let uploaded = total;
    // Another computer may have cleaned up a part this version reuses while
    // it was uploading. Put back anything that's gone.
    const reused = [...encoded.parts.keys()].filter((sha) => !missing.some(([m]) => m === sha));
    if (reused.length) {
      const fresh = await this.partIndex(true);
      for (const sha of reused.filter((hash) => !fresh.has(hash))) {
        const data = encoded.parts.get(sha);
        const part = await this.drive.upload({ data, name: `part-${sha}`, properties: { stepforge: parts.PART_KIND, sha } });
        fresh.set(sha, { ...part, size: String(data.length) });
        uploaded += data.length;
      }
    }
    return { file, uploaded };
  }

  /**
   * The archive bytes of any version, full or parts. For a parts snapshot
   * only files this computer doesn't already have are downloaded.
   */
  async downloadVersion(file) {
    if (!parts.isPartsSnapshot(file)) return this.downloadArchive(file);
    const manifest = await this.manifestFor(file, { progress: true });
    const id = file.appProperties?.guideId;
    const have = validId(id) && this.store.guideExists(id) ? parts.entriesBySha(buildArchiveEntries(this.store, id)) : new Map();
    const needed = parts.partShas(manifest).filter((sha) => !have.has(sha));
    if (needed.length) {
      let index = await this.partIndex();
      // Parts saved by another computer since this one last looked.
      if (needed.some((sha) => !index.has(sha))) index = await this.partIndex(true);
      const sizes = new Map(manifest.entries.map((entry) => [entry.sha, entry.size]));
      await this.transfer('download', archiveTitle(file), needed.reduce((n, sha) => n + sizes.get(sha), 0), async (onProgress) => {
        let done = 0;
        for (const sha of needed) {
          const part = index.get(sha);
          if (!part) throw new Error(`A ${this.label} version is missing some of its files. Sync the computer that saved it, then try again.`);
          const data = await this.drive.download(part.id, { onProgress: (n) => onProgress(done + n) });
          if (parts.sha256(data) !== sha) throw new Error(`A ${this.label} file failed its integrity check. Local guides are unchanged.`);
          have.set(sha, data);
          done += data.length;
        }
      });
    }
    return zipSync(parts.assembleEntries(manifest, (sha) => have.get(sha)));
  }

  // ---- merging (core/guide-merge.js) --------------------------------------

  basePath(id) { return path.join(this.directory, 'bases', `${id}.json`); }

  /**
   * Remember the content this computer last agreed on with the cloud, so a
   * later merge has a base even when that version is gone from the cloud.
   * Screenshots are kept as hashes only.
   */
  rememberBase(id, entries) {
    try {
      const list = entries.filter((entry) => entry.name !== 'manifest.json').map((entry) => {
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
        return entry.name.endsWith('.json') ? { name: entry.name, data: data.toString('base64') } : { name: entry.name, sha: parts.sha256(data) };
      });
      fs.mkdirSync(path.dirname(this.basePath(id)), { recursive: true });
      writeJsonSync(this.basePath(id), { hash: parts.contentHash(entries), entries: list });
    } catch { /* only a cache */ }
  }

  /** The remembered base entries, if they are the content with this hash. */
  rememberedBase(id, hash) {
    const saved = readJsonIfExists(this.basePath(id), null);
    if (!hash || saved?.hash !== hash || !Array.isArray(saved.entries)) return null;
    return saved.entries.map((entry) => ({ name: entry.name, sha: entry.sha, data: entry.data === undefined ? null : Buffer.from(entry.data, 'base64') }));
  }

  /**
   * Base entries for merging `tips` (and the local guide, when `record` is
   * given): the newest version every side descends from. Without one, the
   * remembered base for the local guide, or null to merge without a base.
   */
  async mergeBase(id, versions, tips, record) {
    const byId = new Map(versions.map((file) => [file.id, file]));
    const ancestry = (start) => {
      const seen = new Set();
      for (const queue = [start]; queue.length;) {
        const current = queue.shift();
        if (!byId.has(current) || seen.has(current)) continue;
        seen.add(current);
        queue.push(...parentsOf(byId.get(current)));
      }
      return seen;
    };
    const starts = [...tips.map((tip) => tip.id), ...(record ? [record.head] : [])];
    const lines = starts.map(ancestry);
    const common = [...lines[0]].filter((vid) => lines.every((line) => line.has(vid))).map((vid) => byId.get(vid))
      .sort((a, b) => compareText(a.createdTime || '', b.createdTime || '') || compareText(a.id, b.id)).at(-1);
    if (!common) return record ? this.rememberedBase(id, record.hash) : null;
    return this.rememberedBase(id, common.appProperties.hash) || this.versionEntries(common);
  }

  /** A version's entries for use as a merge base; screenshots may be hashes only. */
  async versionEntries(file) {
    if (!parts.isPartsSnapshot(file)) {
      const entries = unzipSync(await this.downloadArchive(file));
      return parts.contentHash(entries) === file.appProperties.hash ? entries : null;
    }
    const manifest = await this.manifestFor(file);
    const entries = [];
    for (const entry of manifest.entries) {
      let data = entry.data;
      if (!data && entry.name.endsWith('.json')) {
        // A step too big to sit inside the manifest.
        const part = (await this.partIndex()).get(entry.sha) || (await this.partIndex(true)).get(entry.sha);
        if (!part) return null;
        data = await this.drive.download(part.id);
        if (parts.sha256(data) !== entry.sha) throw new Error(`A ${this.label} file failed its integrity check. Local guides are unchanged.`);
      }
      entries.push({ name: entry.name, sha: entry.sha, data });
    }
    return entries;
  }

  /**
   * Remove parts no version uses, and extra copies of the same part. Parts
   * younger than the grace period are left for a later run.
   */
  async removeUnusedParts() {
    const [files, partFiles] = await Promise.all([this.drive.listVersions(), this.drive.listParts()]);
    this.partIndexCache = null;
    const versions = files.filter((file) => file.appProperties?.stepforge === 'guide-v1');
    // If any manifest can't be read, it's unknown what it uses: keep everything.
    let refs;
    try { refs = await this.partRefs(versions, { strict: true }); } catch { return { removed: 0, bytes: 0 }; }
    const used = new Set([...refs.values()].flat());
    const now = Date.now();
    const old = (file) => now - Date.parse(file.createdTime || '') > this.partGraceMs;
    const kept = new Set();
    const remove = [];
    for (const part of [...partFiles].sort((a, b) => compareText(a.createdTime || '', b.createdTime || '') || compareText(a.id, b.id))) {
      const sha = part.appProperties?.sha;
      if (used.has(sha) && !kept.has(sha)) { kept.add(sha); continue; }
      if (old(part) && validId(part.id)) remove.push(part);
    }
    for (const part of remove) await this.drive.deleteFile(part.id);
    // Folder-based services can be left with half-finished uploads.
    if (this.drive.removeOrphans) { try { await this.drive.removeOrphans(); } catch { /* try again next time */ } }
    this.lastPartCleanup = now;
    this.partCleanupNeeded = false;
    // Forget cached manifests of versions that are gone.
    const live = new Set(versions.map((file) => file.id));
    const cacheDir = path.join(this.directory, 'manifests');
    for (const name of fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []) {
      if (!live.has(name.replace(/\.gz$/, ''))) fs.rmSync(path.join(cacheDir, name), { force: true });
    }
    return { removed: remove.length, bytes: remove.reduce((n, part) => n + sizeOf(part), 0) };
  }

  /**
   * Free up space turns full-copy versions into parts snapshots. The new
   * version is a child of the old one with the same content, so other
   * computers simply move their baseline to it.
   */
  async convertToParts(files) {
    await this.loadAccountState();
    const markers = await this.drive.listDeletions();
    const recovery = new Set([...this.deletionStates(markers).values()]
      .filter((file) => file.appProperties?.state === 'deleted').map((file) => file.appProperties.recoveryId));
    let converted = 0;
    let uploaded = 0;
    let removed = 0;
    for (const versions of guideVersions(files).values()) {
      for (const file of versions) {
        if (parts.isPartsSnapshot(file) || recovery.has(file.id)) continue;
        let entries;
        try {
          entries = unzipSync(await this.downloadArchive(file));
          if (parts.contentHash(entries) !== file.appProperties.hash) continue;
        } catch (err) {
          if (!err.message?.startsWith('zip:')) throw err;
          continue; // a damaged old version is left exactly as it is
        }
        const { stepforge, guideId, hash } = file.appProperties;
        const result = await this.uploadVersion({ encoded: parts.encodeSnapshot(entries, { inlineLimit: this.inlineLimit }), name: file.name,
          properties: { stepforge, guideId, hash, parent: file.id } });
        await this.drive.deleteFile(file.id);
        this.renameVersion(file.id, result.file.id);
        uploaded += result.uploaded;
        removed += sizeOf(file);
        converted += 1;
      }
    }
    return { converted, uploaded, removed };
  }

  renameVersion(from, to) {
    for (const record of Object.values(this.state.records)) {
      if (record.head === from) record.head = to;
      if (Array.isArray(record.heads)) record.heads = record.heads.map((id) => (id === from ? to : id));
    }
    if (this.stateFile) this.saveState();
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
    if (!this.drive.status().connected) throw new Error(`Sign in to ${this.label} first.`);
    const [files, markers, partFiles, quota] = await Promise.all([this.drive.listVersions(), this.drive.listDeletions(), this.drive.listParts(),
      this.drive.quota ? this.drive.quota().catch(() => null) : null]);
    const recoveryIds = new Set([...this.deletionStates(markers).values()]
      .filter((file) => file.appProperties?.state === 'deleted').map((file) => file.appProperties.recoveryId));
    return { ...storageSummary(files, recoveryIds, { partFiles, refs: await this.partRefs(files) }), quota };
  }

  async guides() {
    if (!this.drive.status().connected) throw new Error(`Sign in to ${this.label} first.`);
    const [files, markers, partFiles] = await Promise.all([this.drive.listVersions(), this.drive.listDeletions(), this.drive.listParts()]);
    const deleted = this.deletionStates(markers);
    const refs = await this.partRefs(files);
    const partSizes = new Map();
    for (const part of partFiles) if (!partSizes.has(part.appProperties?.sha)) partSizes.set(part.appProperties?.sha, sizeOf(part));
    return [...guideVersions(files)].filter(([id]) =>
      !['deleted', 'purged'].includes(deleted.get(id)?.appProperties.state)
    ).map(([id, versions]) => {
      versions.sort((a, b) => compareText(b.createdTime || '', a.createdTime || '') || compareText(b.id, a.id));
      const latest = versions[0];
      // Files shared between this guide's versions count once.
      const shas = new Set(versions.flatMap((file) => refs.get(file.id) || []));
      const shared = [...shas].reduce((n, sha) => n + (partSizes.get(sha) || 0), 0);
      return { guideId: id, title: latest.name?.replace(/\.sfgz$/, '') || 'Untitled guide',
        snapshotCount: versions.length, bytes: versions.reduce((n, f) => n + sizeOf(f), 0) + shared,
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
    if (!this.drive.status().connected) throw new Error(`Sign in to ${this.label} first.`);
    return (await this.drive.listVersions())
      .filter((file) => file.appProperties?.guideId === id)
      .sort((a, b) => compareText(b.createdTime || '', a.createdTime || '') || compareText(b.id, a.id))
      // A parts snapshot's own file is small; report the version's full size.
      .map((file, index) => ({ id: file.id, createdTime: file.createdTime || '',
        size: parts.isPartsSnapshot(file) ? Number(file.appProperties.bytes) || 0 : sizeOf(file), current: index === 0 }));
  }

  // Manual pruning keeps only the newest snapshot on every branch, and
  // switches full-copy versions to parts snapshots. Automatic pruning after a
  // sync keeps two previous snapshots for restoring.
  prune() { return this.mutate(() => this.pruneNow(1, { convert: true })); }

  async pruneNow(retain = RETAIN_PER_BRANCH, { convert = false } = {}) {
    if (!this.drive.status().connected) throw new Error(`Sign in to ${this.label} first.`);
    const files = await this.drive.listVersions();
    const remove = [];
    for (const versions of guideVersions(files).values()) {
      const keep = protectedVersions(versions, retain);
      remove.push(...versions.filter((file) => !keep.has(file.id)));
    }
    for (const file of remove) await this.drive.deleteFile(file.id);
    let reclaimedBytes = remove.reduce((n, file) => n + sizeOf(file), 0);
    let converted = 0;
    if (convert) {
      const gone = new Set(remove.map((file) => file.id));
      const result = await this.convertToParts(files.filter((file) => !gone.has(file.id)));
      converted = result.converted;
      reclaimedBytes += result.removed - result.uploaded;
    }
    if (convert || remove.length || this.partCleanupNeeded || Date.now() - this.lastPartCleanup > PART_CLEANUP_MS) {
      reclaimedBytes += (await this.removeUnusedParts()).bytes;
    }
    return { pruned: remove.length, reclaimedBytes: Math.max(0, reclaimedBytes), converted };
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
    if (!this.drive.status().connected) throw new Error(`Sign in to ${this.label} first.`);
    if (!this.enabled()) throw new Error(`Turn on automatic sync before replacing ${this.label}.`);
    await this.loadAccountState();
    const [files, markers] = await Promise.all([this.drive.listVersions(), this.drive.listDeletions()]);
    const local = new Set(this.store.listGuides().map((guide) => guide.guideId));
    const groups = guideVersions(files);
    const states = this.deletionStates(markers);
    const titles = new Map();
    for (const [id, versions] of groups) {
      const latest = [...versions].sort((a, b) => compareText(b.createdTime || '', a.createdTime || ''))[0];
      titles.set(id, archiveTitle(latest));
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
    for (const file of await this.drive.listParts()) await this.drive.deleteFile(file.id);
    this.partIndexCache = null;
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
    if (!this.drive.status().connected) throw new Error(`Sign in to ${this.label} first.`);
    if (this.store.guideExists(id)) await this.setSharing(id, false);
    const files = (await this.drive.listVersions()).filter((file) => file.appProperties?.guideId === id);
    for (const file of files) await this.drive.deleteFile(file.id);
    delete this.state.records[id];
    if (this.stateFile) this.saveState();
    await this.removeUnusedParts();
    return { removed: files.length };
  }

  restore(id, versionId) { return this.mutate(() => this.restoreNow(id, versionId)); }

  async restoreNow(id, versionId) {
    if (!this.drive.status().connected) throw new Error(`Sign in to ${this.label} first.`);
    if (!this.canReplace(id)) throw new Error('Close the editor or stop capture before restoring a cloud snapshot.');
    await this.loadAccountState();
    const files = await this.drive.listVersions();
    const version = files.find((file) => file.id === versionId && file.appProperties?.guideId === id);
    if (!version) throw new Error('That cloud snapshot is no longer available.');
    const bytes = await this.downloadVersion(version);
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
    if (!this.drive.status().connected) throw new Error(`Sign in to ${this.label} first.`);
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
    const bytes = await this.downloadVersion(recovery);
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
      // Local backups aren't synced; keep them with the updated guide.
      const history = path.join(target, 'history');
      if (sourceId === targetId && fs.existsSync(history)) fs.cpSync(history, path.join(staged.guideDir(sourceId), 'history'), { recursive: true });
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
      else this.publish('off', `${this.label} sharing is off.`);
      return this.status;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  async run() {
    if (!this.enabled()) return this.publish('off', `${this.label} sharing is off.`);
    if (!this.drive.status().connected) return this.publish('disconnected', this.drive.status().error || `Sign in to ${this.label} in Settings.`);
    const generation = this.generation;
    const check = () => {
      if (!this.enabled() || generation !== this.generation) throw new Error('Cloud synchronization stopped.');
    };
    this.publish('syncing', `Syncing with ${this.label}…`);
    this.partIndexCache = null;
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
      const recovery = await this.uploadArchive({ data: fs.readFileSync(archive), name: `${pendingDelete.title} (deleted).sfgz`,
        properties: { stepforge: 'guide-v1', guideId: id, hash: pendingDelete.hash } });
      check();
      const marker = await this.drive.upload({ data: Buffer.from('{}'), name: `Deleted ${pendingDelete.title}`,
        properties: { stepforge: 'deletion-v1', guideId: id, state: 'deleted', title: pendingDelete.title, deletedAt: pendingDelete.deletedAt, recoveryId: recovery.id } });
      check();
      await Promise.all(files.filter((file) => file.appProperties?.guideId === id && file.id !== recovery.id).map((file) => this.drive.deleteFile(file.id)));
      await Promise.all(deletionFiles.filter((file) => file.appProperties?.guideId === id && file.id !== marker.id).map((file) => this.drive.deleteFile(file.id)));
      // The deleted guide's parts are now unused.
      this.partCleanupNeeded = true;
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
    let merged = 0;
    let mergeConflicts = 0;
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
        
        const successor = record?.head && !versions.some((f) => f.id === record.head)
          && versions.find((f) => f.appProperties.parent === record.head && f.appProperties.hash === record.hash);
        if (successor) {
          // Free up space replaced this computer's baseline with the same
          // content in the parts format; nothing is lagging, so don't wait.
          record = { ...record, head: successor.id, heads: (record.heads || []).map((h) => (h === record.head ? successor.id : h)) };
          this.state.records[id] = record;
          this.saveState();
        } else if (record?.head && !versions.some((f) => f.id === record.head)) {
          if (versions.length === 0) {
            // Cloud history was removed externally.
            // Reset the baseline so the local guide can be uploaded again.
            delete this.state.records[id];
            this.saveState();
            record = null;
          } else if (Date.now() - (record.syncedAt || 0) > STALE_HEAD_MS
              || versions.some((f) => parentsOf(f).includes(record.head))) {
            // Pruned or replaced, not lagging: a newer version names it. Keep
            // the content hash so local edits merge against the remembered base.
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
        if (remoteChanged && record?.hash && heads.every((h) => h.appProperties.hash === record.hash)) {
          // Same content as this computer's baseline, e.g. a version Free up
          // space converted to parts: move the baseline, download nothing.
          this.state.records[id] = { ...record, head: latest.id, heads: heads.map((h) => h.id), syncedAt: Date.now() };
          this.saveState();
        } else if (remoteChanged) {
          // Never replace a live editor's guide, including unsaved input or capture.
          if (!this.canReplace(id)) { pending = true; continue; }
          const localChanged = local && (!record || local.hash !== record.hash);
          // The newest head of each distinct content. Branches with different
          // content, and unsynced local edits, are merged into one guide.
          const tips = [...new Map(heads.map((h) => [h.appProperties.hash, h])).values()];
          const withLocal = localChanged && !tips.some((h) => h.appProperties.hash === local.hash);
          const merging = tips.length > 1 || withLocal;
          const downloads = [];
          for (const tip of merging ? tips : [latest]) {
            downloads.push({ tip, bytes: await this.downloadVersion(tip) });
            check();
          }
          const base = merging ? await this.mergeBase(id, versions, tips, withLocal ? record : null) : null;
          check();
          if (!this.canReplace(id) || this.store.guideExists(id) !== exists
              || (exists && this.localSnapshot(id).hash !== local.hash)) { pending = true; continue; }
          // Validate fully in an isolated store, including the advertised content hash,
          // before merging or touching the real guide.
          for (const { tip, bytes } of downloads) this.validateDownload(bytes, id, tip.appProperties.hash);
          let incoming = downloads[0].bytes;
          if (merging) {
            const sides = downloads.map(({ tip, bytes }) => ({ entries: unzipSync(bytes), hash: tip.appProperties.hash }));
            if (withLocal) sides.push({ entries: local.entries, hash: local.hash });
            const result = mergeGuideEntries({ base, sides });
            incoming = zipSync(result.entries);
            // Unsynced local edits that lost a conflict stay recoverable under Backups.
            if (withLocal) createSnapshot(this.store, id, { label: 'before-sync-merge' });
            merged += 1;
            mergeConflicts += result.conflicts;
          }
          if (!local || local.hash !== parts.contentHash(unzipSync(incoming))) this.install(incoming, id, id);
          const alreadyMarkedShared = this.store.getGuide(id).cloud?.wasShared === true;
          if (!alreadyMarkedShared) this.markWasShared(id);
          local = this.localSnapshot(id);
          exists = true;
          // A merge is uploaded next as a child of the newest head that also
          // names the other heads, so the cloud is back to one head.
          this.state.records[id] = { head: latest.id, heads: heads.map((h) => h.id), hash: latest.appProperties.hash, syncedAt: Date.now(),
            ...(merging ? { merged: heads.filter((h) => h.id !== latest.id).map((h) => h.id) } : {}) };
          this.saveState();
          if (!merging) this.rememberBase(id, unzipSync(incoming));
        }
        if (!exists) continue;
        const baseline = Object.hasOwn(this.state.records, id) ? this.state.records[id] : null;
        // Heads a merge absorbed must be named by an upload even when the
        // merged guide equals the newest head, or the cloud keeps both heads.
        const absorbed = mergedProperty((baseline?.merged || []).filter((vid) => vid !== baseline.head && validId(vid)));
        if (!baseline || local.hash !== baseline.hash || absorbed) {
          if (!this.canUpload(id)) { pending = true; continue; }
          // Persist the shared marker in the first archive so a later offline
          // deletion can safely tell a shared guide from a local-only guide.
          if (!this.store.getGuide(id).cloud?.wasShared) {
            this.markWasShared(id);
            local = this.localSnapshot(id);
          }
          const name = `${this.store.getGuide(id).title}.sfgz`;
          // Only files Drive doesn't have yet are uploaded (core/cloud-parts.js).
          const uploaded = local.entries;
          const encoded = parts.encodeSnapshot(uploaded, { inlineLimit: this.inlineLimit });
          // Hashing a big guide takes a moment; let a Stop or an edit land first.
          await new Promise((resolve) => setImmediate(resolve));
          await this.partIndex();
          check();
          if (!this.store.guideExists(id) || !this.isSharingEnabled(id) || !this.canUpload(id)) {
            pending = true;
            continue;
          }
          const { file } = await this.uploadVersion({ encoded, name, check,
            properties: { stepforge: 'guide-v1', guideId: id, hash: local.hash, ...(baseline?.head ? { parent: baseline.head } : {}),
              ...(absorbed ? { merged: absorbed } : {}) } });
          check();
          this.state.records[id] = { head: file.id, heads: [...heads.filter((h) => h.id !== baseline?.head).map((h) => h.id), file.id], hash: local.hash, syncedAt: Date.now() };
          this.saveState();
          this.rememberBase(id, uploaded);
          // If edits happened during upload, this baseline describes only uploaded bytes.
          if (this.store.guideExists(id) && this.localSnapshot(id).hash !== local.hash) pending = true;
        }
      } catch (err) {
        check();
        errors.push(err.message);
      }
    }
    if (errors.length) this.publish('error', `${errors.length} guide(s) could not sync: ${errors[0]}`);
    else if (pending) this.publish('pending', 'Changes pending. Incoming updates wait until the guide is closed.');
    else this.publish('synced', mergeMessage(this.label, merged, mergeConflicts), { lastSync: new Date().toISOString() });
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

module.exports = { CloudSync, snapshot, headsOf, guideVersions, protectedVersions, storageSummary, RETAIN_PER_BRANCH, PART_GRACE_MS };
