'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { directoryEntries, extractZipSync, unzipSync, zipSync } = require('./zip');
const { atomicWriteFileSync, readJsonSync } = require('./util');
const { validateGuide } = require('./schema');
const parts = require('./cloud-parts');

/**
 * Snapshot backups of a guide directory (excluding history/), for automated
 * backups and manual backup/restore. A snapshot is a small manifest in
 * <guide>/history/snapshots/<name>.snapshot that lists every file by hash,
 * keeping guide and step JSON inline. Screenshots are stored once, by hash,
 * in history/snapshot-files/, and every snapshot that contains one shares
 * that copy, so a snapshot only adds what changed since the last.
 *
 * Snapshots from before this were whole zips (<name>.zip). They still list
 * and restore, and convertZipSnapshots() turns them into manifests.
 */

const SNAPSHOT_EXT = '.snapshot';
// A file saved for a snapshot whose manifest isn't written yet is this new;
// cleanup leaves files this young alone.
const FRESH_FILE_MS = 10 * 60 * 1000;

function snapshotsDir(store, guideId) {
  return path.join(store.guideDir(guideId), 'history', 'snapshots');
}

function filesDir(store, guideId) {
  return path.join(store.guideDir(guideId), 'history', 'snapshot-files');
}

const isSnapshotName = (name) => name.endsWith(SNAPSHOT_EXT) || name.endsWith('.zip');
const notHistory = (rel) => rel !== 'history' && !rel.startsWith('history/');

let lastSnapshotMs = 0;
function snapshotName(label) {
  // Reserve a monotonically increasing timestamp even for multiple backups
  // in one clock tick (or a backwards clock adjustment).
  lastSnapshotMs = Math.max(Date.now(), lastSnapshotMs + 1);
  const stamp = new Date(lastSnapshotMs).toISOString().replace(/[:.]/g, '-');
  return `${stamp}${label ? `-${label.replace(/[^A-Za-z0-9_-]+/g, '_')}` : ''}${SNAPSHOT_EXT}`;
}

/** Save `entries` as snapshot `name`: new screenshots first, then the manifest. */
function writeSnapshot(store, guideId, name, entries) {
  const { manifest, parts: files } = parts.encodeSnapshot(entries);
  const dir = filesDir(store, guideId);
  fs.mkdirSync(dir, { recursive: true });
  for (const [sha, data] of files) {
    const file = path.join(dir, sha);
    if (!fs.existsSync(file)) atomicWriteFileSync(file, data);
  }
  fs.mkdirSync(snapshotsDir(store, guideId), { recursive: true });
  atomicWriteFileSync(path.join(snapshotsDir(store, guideId), name), manifest);
}

/**
 * Take a snapshot. With `background` it returns a promise, as it did when
 * snapshots were zipped in a worker; hashing the files is quick enough now.
 */
function createSnapshot(store, guideId, { label = '', keepLast = 0, background = false } = {}) {
  const guideDir = store.guideDir(guideId);
  if (!fs.existsSync(path.join(guideDir, 'guide.json'))) throw new Error(`guide not found: ${guideId}`);
  const name = snapshotName(label);
  const take = () => {
    writeSnapshot(store, guideId, name, directoryEntries(guideDir, { filter: notHistory }));
    if (keepLast > 0) pruneSnapshots(store, guideId, keepLast);
    return name;
  };
  if (background) return new Promise((resolve) => resolve(take()));
  return take();
}

function listSnapshots(store, guideId) {
  const dir = snapshotsDir(store, guideId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(isSnapshotName).sort().reverse();
}

function readManifest(store, guideId, name) {
  return parts.decodeSnapshot(fs.readFileSync(path.join(snapshotsDir(store, guideId), name)));
}

/** Delete saved screenshots that no snapshot lists any more. */
function removeUnusedFiles(store, guideId, now = Date.now()) {
  const dir = filesDir(store, guideId);
  if (!fs.existsSync(dir)) return;
  const used = new Set();
  for (const name of listSnapshots(store, guideId).filter((n) => n.endsWith(SNAPSHOT_EXT))) {
    try {
      parts.partShas(readManifest(store, guideId, name)).forEach((sha) => used.add(sha));
    } catch {
      return; // can't tell what a damaged manifest uses, so keep everything
    }
  }
  for (const sha of fs.readdirSync(dir)) {
    if (used.has(sha)) continue;
    const file = path.join(dir, sha);
    if (now - fs.statSync(file).mtimeMs < FRESH_FILE_MS) continue;
    fs.rmSync(file, { force: true });
  }
}

function pruneSnapshots(store, guideId, keepLast) {
  const all = listSnapshots(store, guideId);
  for (const name of all.slice(keepLast)) {
    fs.rmSync(path.join(snapshotsDir(store, guideId), name), { force: true });
  }
  removeUnusedFiles(store, guideId);
}

/** A snapshot as zip bytes, whichever way it is stored. */
function snapshotZip(store, guideId, name) {
  const file = path.join(snapshotsDir(store, guideId), name);
  if (name.endsWith('.zip')) return fs.readFileSync(file);
  let manifest;
  try {
    manifest = readManifest(store, guideId, name);
  } catch {
    throw new Error('the snapshot is damaged');
  }
  const dir = filesDir(store, guideId);
  return zipSync(parts.assembleEntries(manifest, (sha) => {
    const data = fs.existsSync(path.join(dir, sha)) ? fs.readFileSync(path.join(dir, sha)) : null;
    if (!data || parts.sha256(data) !== sha) throw new Error('a screenshot the snapshot needs is missing or damaged');
    return data;
  }));
}

/**
 * Turn a guide's zip snapshots into manifests, keeping their names apart
 * from the extension. Each zip goes only after its manifest is written; one
 * that can't be read is left as it is. Returns how many were converted.
 */
function convertZipSnapshots(store, guideId) {
  const dir = snapshotsDir(store, guideId);
  let converted = 0;
  for (const zip of listSnapshots(store, guideId).filter((n) => n.endsWith('.zip'))) {
    let entries;
    try {
      entries = unzipSync(fs.readFileSync(path.join(dir, zip)));
    } catch {
      continue;
    }
    writeSnapshot(store, guideId, zip.replace(/\.zip$/, SNAPSHOT_EXT), entries);
    fs.rmSync(path.join(dir, zip), { force: true });
    converted += 1;
  }
  return converted;
}

/**
 * Restore a snapshot: replaces the guide's current content (guide.json and
 * steps/) with the snapshot's, keeping the history/ directory intact.
 *
 * The extraction is staged and validated BEFORE any live content is touched:
 * a corrupt or truncated snapshot can no longer destroy the current guide.
 * The swap itself moves the old content aside, moves the new content in, then
 * deletes the old — so a failure mid-swap leaves a recoverable state.
 */
function restoreSnapshot(store, guideId, name) {
  name = path.basename(name);
  if (!isSnapshotName(name) || !fs.existsSync(path.join(snapshotsDir(store, guideId), name))) {
    throw new Error(`snapshot not found: ${name}`);
  }
  const guideDir = store.guideDir(guideId);

  // 1. Extract + validate into a temp staging dir. Nothing live is touched yet.
  const staging = `${guideDir}.restoring-${Date.now()}`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    fs.mkdirSync(staging, { recursive: true });
    extractZipSync(snapshotZip(store, guideId, name), staging);
    const guideJson = path.join(staging, 'guide.json');
    if (!fs.existsSync(guideJson)) throw new Error('snapshot is missing guide.json');
    validateGuide(readJsonSync(guideJson)); // throws on a corrupt snapshot
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`snapshot restore aborted (snapshot invalid): ${err.message}`);
  }

  // 2. Snapshot the pre-restore state so the restore is itself undoable.
  createSnapshot(store, guideId, { label: 'pre-restore' });

  // 3. Swap in the validated content, preserving history/. Move live content
  //    aside first so we can roll back if a step fails.
  const backup = `${guideDir}.prev-${Date.now()}`;
  const liveEntries = fs.readdirSync(guideDir).filter((e) => e !== 'history');
  fs.mkdirSync(backup, { recursive: true });
  try {
    for (const entry of liveEntries) {
      fs.renameSync(path.join(guideDir, entry), path.join(backup, entry));
    }
    for (const entry of fs.readdirSync(staging)) {
      if (entry === 'history') continue;
      fs.renameSync(path.join(staging, entry), path.join(guideDir, entry));
    }
  } catch (err) {
    // Roll back: restore whatever we moved aside.
    for (const entry of fs.readdirSync(backup)) {
      const dest = path.join(guideDir, entry);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(path.join(backup, entry), dest);
    }
    fs.rmSync(backup, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  fs.rmSync(backup, { recursive: true, force: true });
  fs.rmSync(staging, { recursive: true, force: true });
  return store.getGuide(guideId);
}

/**
 * Automatic backup policy. Every guide keeps a small save counter in its
 * history dir; once `everyNSaves` saves accumulate (and backups.automatic is
 * on) an automatic snapshot is taken and old ones pruned to backups.keepLast.
 * Returns the snapshot name when one was taken, else null. Never throws — a
 * backup failure must not break the save that triggered it.
 */
async function autoSnapshotIfDue(store, guideId, settings) {
  try {
    const backups = (settings && settings.get && settings.get('backups')) || {};
    if (backups.automatic === false) return null;
    const everyN = Number.isInteger(backups.everyNSaves) && backups.everyNSaves > 0 ? backups.everyNSaves : 25;
    const keepLast = Number.isInteger(backups.keepLast) && backups.keepLast > 0 ? backups.keepLast : 10;

    const dir = path.join(store.guideDir(guideId), 'history');
    fs.mkdirSync(dir, { recursive: true });
    const counterFile = path.join(dir, 'autosave-counter.json');
    let count = 0;
    try {
      count = JSON.parse(fs.readFileSync(counterFile, 'utf8')).count || 0;
    } catch { count = 0; }
    count += 1;

    if (count >= everyN) {
      const pending = createSnapshot(store, guideId, { label: 'auto', keepLast, background: true });
      count = 0;
      atomicWriteFileSync(counterFile, JSON.stringify({ count }));
      await pending;
      return true;
    }
    atomicWriteFileSync(counterFile, JSON.stringify({ count }));
    return null;
  } catch (err) {
    // Best effort: report, never break the caller's save.
    console.error(`[stepforge] automatic backup failed for ${guideId}: ${err && err.message}`);
    return null;
  }
}

module.exports = {
  createSnapshot, listSnapshots, pruneSnapshots, restoreSnapshot, snapshotsDir,
  autoSnapshotIfDue, convertZipSnapshots, removeUnusedFiles,
};
