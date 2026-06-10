'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { zipDirSync, extractZipSync } = require('./zip');
const { atomicWriteFileSync } = require('./util');

/**
 * Snapshot backups: a zip of the guide directory (excluding history/) stored
 * under <guide>/history/snapshots/. Used for automated backups and manual
 * backup/restore.
 */

function snapshotsDir(store, guideId) {
  return path.join(store.guideDir(guideId), 'history', 'snapshots');
}

function snapshotName(label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
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
 */
function restoreSnapshot(store, guideId, name) {
  const file = path.join(snapshotsDir(store, guideId), path.basename(name));
  if (!fs.existsSync(file)) throw new Error(`snapshot not found: ${name}`);
  const buf = fs.readFileSync(file);
  const guideDir = store.guideDir(guideId);
  // Safety: snapshot the pre-restore state too, so a restore is undoable.
  createSnapshot(store, guideId, { label: 'pre-restore' });
  for (const entry of fs.readdirSync(guideDir)) {
    if (entry === 'history') continue;
    fs.rmSync(path.join(guideDir, entry), { recursive: true, force: true });
  }
  extractZipSync(buf, guideDir);
  return store.getGuide(guideId);
}

module.exports = { createSnapshot, listSnapshots, pruneSnapshots, restoreSnapshot, snapshotsDir };
