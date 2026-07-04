'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { zipDirSync, extractZipSync } = require('./zip');
const { atomicWriteFileSync, readJsonSync } = require('./util');
const { validateGuide } = require('./schema');

/**
 * Snapshot backups: a zip of the guide directory (excluding history/) stored
 * under <guide>/history/snapshots/. Used for automated backups and manual
 * backup/restore.
 */

function snapshotsDir(store, guideId) {
  return path.join(store.guideDir(guideId), 'history', 'snapshots');
}

function snapshotName(label) {
  // Keep milliseconds: stripping them made two snapshots taken within the same
  // second collide on filename (the second silently overwrote the first, so
  // rapid automatic backups produced only one file). ms keeps names unique and
  // still chronologically sortable.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return label ? `${stamp}-${label.replace(/[^A-Za-z0-9_-]+/g, '_')}.zip` : `${stamp}.zip`;
}

function createSnapshot(store, guideId, { label = '', keepLast = 0 } = {}) {
  const guideDir = store.guideDir(guideId);
  if (!fs.existsSync(path.join(guideDir, 'guide.json'))) throw new Error(`guide not found: ${guideId}`);
  const buf = zipDirSync(guideDir, {
    filter: (rel) => rel !== 'history' && !rel.startsWith('history/'),
  });
  const dir = snapshotsDir(store, guideId);
  fs.mkdirSync(dir, { recursive: true });
  const name = snapshotName(label);
  atomicWriteFileSync(path.join(dir, name), buf);
  if (keepLast > 0) pruneSnapshots(store, guideId, keepLast);
  return name;
}

function listSnapshots(store, guideId) {
  const dir = snapshotsDir(store, guideId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.zip')).sort().reverse();
}

function pruneSnapshots(store, guideId, keepLast) {
  const all = listSnapshots(store, guideId);
  for (const name of all.slice(keepLast)) {
    fs.rmSync(path.join(snapshotsDir(store, guideId), name), { force: true });
  }
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
  const file = path.join(snapshotsDir(store, guideId), path.basename(name));
  if (!fs.existsSync(file)) throw new Error(`snapshot not found: ${name}`);
  const buf = fs.readFileSync(file);
  const guideDir = store.guideDir(guideId);

  // 1. Extract + validate into a temp staging dir. Nothing live is touched yet.
  const staging = `${guideDir}.restoring-${Date.now()}`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    fs.mkdirSync(staging, { recursive: true });
    extractZipSync(buf, staging);
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
function autoSnapshotIfDue(store, guideId, settings) {
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
      createSnapshot(store, guideId, { label: 'auto', keepLast });
      count = 0;
      atomicWriteFileSync(counterFile, JSON.stringify({ count }));
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
  autoSnapshotIfDue,
};
