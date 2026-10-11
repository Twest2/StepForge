'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { zipSync, unzipSync } = require('./zip');
const { isDeepStrictEqual } = require('node:util');
const { newId, nowIso, atomicWriteFileSync, writeJsonSync, readJsonIfExists, deepClone } = require('./util');
const { normalizeGuide, normalizeStep, validateGuide, validateStep, SCHEMA_VERSION } = require('./schema');
const { acquireLock, releaseLock } = require('./locks');
const { contentHash, sha256 } = require('./cloud-parts');
const { mergeGuideEntries } = require('./guide-merge');
const { createSnapshot } = require('./snapshots');

const ARCHIVE_FORMAT = 'stepforge-guide-archive';
const APP_VERSION = require('../package.json').version;

/**
 * Single-file share archive (.sfgz). Zip layout:
 *   manifest.json
 *   guide.json
 *   steps/<stepId>/step.json
 *   steps/<stepId>/<image files>
 */

function buildArchiveEntries(store, guideId) {
  const guide = store.getGuide(guideId);
  const steps = store.listSteps(guideId);
  const entries = [];

  const manifest = {
    format: ARCHIVE_FORMAT,
    formatVersion: 1,
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    guideId: guide.guideId,
    title: guide.title,
    exportedAt: nowIso(),
    stepCount: guide.stepsOrder.length,
  };
  entries.push({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });

  const portableGuide = deepClone(guide);
  portableGuide.linkedSource = null; // links are a property of the library, not the file
  entries.push({ name: 'guide.json', data: JSON.stringify(portableGuide, null, 2) });

  for (const stepId of guide.stepsOrder) {
    const step = steps.get(stepId);
    if (!step) continue;
    entries.push({ name: `steps/${stepId}/step.json`, data: JSON.stringify(step, null, 2) });
    const dir = store.stepDir(guideId, stepId);
    for (const file of fs.readdirSync(dir)) {
      if (file === 'step.json') continue;
      entries.push({ name: `steps/${stepId}/${file}`, data: fs.readFileSync(path.join(dir, file)), store: /\.(png|jpg|jpeg|gif|webp)$/i.test(file) });
    }
  }
  return entries;
}

/** Export a guide to a .sfgz file. Returns the manifest written. */
function exportGuideArchive(store, guideId, destFile) {
  const entries = buildArchiveEntries(store, guideId);
  atomicWriteFileSync(destFile, zipSync(entries));
  return JSON.parse(entries[0].data);
}

function readArchive(file) {
  const entries = unzipSync(fs.readFileSync(file));
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  if (!byName.has('manifest.json') || !byName.has('guide.json')) {
    throw new Error('not a StepForge guide archive (missing manifest)');
  }
  const manifest = JSON.parse(byName.get('manifest.json').toString('utf8'));
  if (manifest.format !== ARCHIVE_FORMAT) throw new Error(`unsupported archive format: ${manifest.format}`);
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`archive uses newer schema (${manifest.schemaVersion}) than this app supports`);
  }
  const guide = normalizeGuide(JSON.parse(byName.get('guide.json').toString('utf8')));
  validateGuide(guide);
  return { manifest, guide, entries };
}

/**
 * Import a .sfgz into the library.
 * mode 'copy'  — fresh ids, fully independent local guide.
 * mode 'linked' — keeps archive identity; edits autosave locally and write
 *                 back to the file only on explicit save (saveLinkedGuide).
 */
function importGuideArchive(store, file, { mode = 'copy' } = {}) {
  const { guide, entries } = readArchive(file);

  const idMap = new Map();
  const stepFiles = new Map(); // newStepId -> [{name, data}]
  const stepJsons = new Map();

  for (const { name, data } of entries) {
    const m = /^steps\/([^/]+)\/(.+)$/.exec(name);
    if (!m) continue;
    const [, oldStepId, rest] = m;
    if (!idMap.has(oldStepId)) {
      idMap.set(oldStepId, mode === 'copy' ? newId('step') : oldStepId);
    }
    const stepId = idMap.get(oldStepId);
    if (rest === 'step.json') stepJsons.set(stepId, { oldStepId, raw: JSON.parse(data.toString('utf8')) });
    else {
      if (!stepFiles.has(stepId)) stepFiles.set(stepId, []);
      if (!/^[A-Za-z0-9._-]+$/.test(rest)) continue; // only flat, safe file names
      stepFiles.get(stepId).push({ name: rest, data });
    }
  }

  const newGuide = deepClone(guide);
  if (mode === 'copy') {
    newGuide.guideId = newId('guide');
    newGuide.linkedSource = null;
  } else {
    if (store.guideExists(newGuide.guideId)) {
      throw new Error('this shared guide is already in the library');
    }
    newGuide.linkedSource = {
      path: path.resolve(file),
      openedAt: nowIso(),
      lastSavedAt: null,
    };
  }
  newGuide.stepsOrder = guide.stepsOrder.map((id) => idMap.get(id)).filter(Boolean);

  const imported = finalizeImport(store, newGuide, idMap, stepJsons, stepFiles);
  if (mode === 'linked') rememberLinkedBase(store, imported.guideId, buildArchiveEntries(store, imported.guideId), contentHash(entries));
  return imported;
}

function finalizeImport(store, newGuide, idMap, stepJsons, stepFiles) {
  // Transactional import: validate the guide and EVERY step first, then write
  // the whole guide into a temporary staging directory, and only publish it
  // with a single atomic rename. Previously guide.json was written before the
  // steps validated, so a bad step left a partial guide in the library.
  validateGuide(newGuide);
  const normalizedSteps = [];
  for (const [stepId, { raw }] of stepJsons) {
    const step = normalizeStep({ ...raw, stepId });
    step.parentStepId = raw.parentStepId ? idMap.get(raw.parentStepId) || null : null;
    validateStep(step); // throws before anything is written on a bad step
    normalizedSteps.push([stepId, step]);
  }

  const finalDir = store.guideDir(newGuide.guideId);
  if (fs.existsSync(finalDir)) throw new Error(`guide already exists: ${newGuide.guideId}`);
  const stagingDir = `${finalDir}.importing-${Date.now()}`;
  fs.rmSync(stagingDir, { recursive: true, force: true });
  try {
    fs.mkdirSync(stagingDir, { recursive: true });
    writeJsonSync(path.join(stagingDir, 'guide.json'), newGuide);
    for (const [stepId, step] of normalizedSteps) {
      const dir = path.join(stagingDir, 'steps', stepId);
      fs.mkdirSync(dir, { recursive: true });
      writeJsonSync(path.join(dir, 'step.json'), step);
      for (const { name, data } of stepFiles.get(stepId) || []) {
        atomicWriteFileSync(path.join(dir, name), data);
      }
    }
    // Publish atomically. If the final dir appeared meanwhile, fail cleanly.
    if (fs.existsSync(finalDir)) throw new Error(`guide already exists: ${newGuide.guideId}`);
    fs.renameSync(stagingDir, finalDir);
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
  return store.getGuide(newGuide.guideId);
}

// The version of a linked guide that this library last agreed on with the
// shared file, kept for the three-way merge on save. It lives in history/ so
// backups leave it alone and restoring one is saved like any other edit.
// Screenshots are kept as hashes only.
const linkedBasePath = (store, guideId) => path.join(store.guideDir(guideId), 'history', 'linked-base.json');

function rememberLinkedBase(store, guideId, entries, hash) {
  try {
    const list = entries.filter((entry) => entry.name !== 'manifest.json').map((entry) => {
      const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
      return entry.name.endsWith('.json') ? { name: entry.name, data: data.toString('utf8') } : { name: entry.name, sha: sha256(data) };
    });
    writeJsonSync(linkedBasePath(store, guideId), { hash, entries: list });
  } catch { /* only a cache: without it the next save merges without a base */ }
}

/** { hash, entries } of the remembered base, or null when there is none. */
function recalledLinkedBase(store, guideId) {
  const saved = readJsonIfExists(linkedBasePath(store, guideId), null);
  if (!saved || typeof saved.hash !== 'string' || !Array.isArray(saved.entries)) return null;
  return { hash: saved.hash, entries: saved.entries.map((entry) => ({ name: entry.name, sha: entry.sha, data: entry.data === undefined ? null : entry.data })) };
}

/**
 * Decide what to write to the shared file. If someone saved it since this
 * library last did, their version and ours are merged. Returns
 * { entries, merged, conflicts } where `merged` says the result differs from
 * what this library had.
 */
function planLinkedWrite(store, guideId, target, ours, oursHash, { force }) {
  if (!fs.existsSync(target)) return { entries: ours, merged: false, conflicts: 0 };
  let theirs;
  try {
    theirs = readArchive(target);
    if (theirs.guide.guideId !== guideId) throw new Error('it holds a different guide');
  } catch (err) {
    // Overwriting what can't be read could erase someone's work; saving anyway is the user's call.
    if (force) return { entries: ours, merged: false, conflicts: 0 };
    throw new Error(`The shared archive could not be read (${err.message}), so it was not overwritten. Your changes are saved locally.`);
  }
  const theirsHash = contentHash(theirs.entries);
  const base = recalledLinkedBase(store, guideId);
  if (theirsHash === oursHash || (base && base.hash === theirsHash)) return { entries: ours, merged: false, conflicts: 0 };
  const result = mergeGuideEntries({
    base: base ? base.entries : null,
    sides: [{ entries: theirs.entries, hash: theirsHash }, { entries: ours, hash: oursHash }],
  });
  return { entries: result.entries, merged: contentHash(result.entries) !== oursHash || result.conflicts > 0, conflicts: result.conflicts };
}

/**
 * Replace a library guide's content with merged archive entries. Everything
 * is validated before anything is written. The guide stays linked.
 */
function applyMergedEntries(store, guideId, entries) {
  const byName = new Map(entries.map((entry) => [entry.name, entry.data]));
  const local = store.getGuide(guideId);
  const guide = normalizeGuide(JSON.parse(byName.get('guide.json').toString('utf8')));
  if (guide.guideId !== guideId) throw new Error('merged guide has a different id');
  guide.linkedSource = local.linkedSource;
  guide.revision = Math.max(local.revision || 0, guide.revision || 0) + 1;
  validateGuide(guide);

  const steps = new Map(); // stepId -> { step, files }
  for (const { name, data } of entries) {
    const m = /^steps\/([^/]+)\/(.+)$/.exec(name);
    if (!m) continue;
    const [, stepId, rest] = m;
    store.stepDir(guideId, stepId); // throws on an unsafe id
    if (!steps.has(stepId)) steps.set(stepId, { step: null, files: [] });
    if (rest === 'step.json') {
      const step = normalizeStep({ ...JSON.parse(data.toString('utf8')), stepId });
      validateStep(step);
      steps.get(stepId).step = step;
    } else {
      if (!/^[A-Za-z0-9._-]+$/.test(rest)) throw new Error(`merged guide has an unsafe file name: ${rest}`);
      steps.get(stepId).files.push({ name: rest, data });
    }
  }
  for (const [stepId, { step }] of steps) if (!step) throw new Error(`merged step has no step.json: ${stepId}`);

  for (const [stepId, { step, files }] of steps) {
    const dir = store.stepDir(guideId, stepId);
    const existing = readJsonIfExists(path.join(dir, 'step.json'), null);
    if (existing && !isDeepStrictEqual({ ...existing, revision: 0 }, { ...step, revision: 0 })) {
      step.revision = Math.max(existing.revision || 0, step.revision || 0) + 1;
    }
    writeJsonSync(path.join(dir, 'step.json'), step);
    const keep = new Set(['step.json', ...files.map((file) => file.name)]);
    for (const { name, data } of files) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file) || !fs.readFileSync(file).equals(data)) atomicWriteFileSync(file, data);
    }
    for (const name of fs.readdirSync(dir)) {
      if (!keep.has(name) && !name.startsWith('.')) fs.rmSync(path.join(dir, name), { force: true, recursive: true });
    }
  }
  const stepsRoot = path.join(store.guideDir(guideId), 'steps');
  if (fs.existsSync(stepsRoot)) {
    for (const entry of fs.readdirSync(stepsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !steps.has(entry.name)) fs.rmSync(path.join(stepsRoot, entry.name), { recursive: true, force: true });
    }
  }
  writeJsonSync(path.join(store.guideDir(guideId), 'guide.json'), guide);
}

/**
 * Write a linked guide back to its shared archive (explicit Ctrl+S save).
 * Takes the advisory lock, then re-reads the shared file inside it: if
 * another session saved since this library last did, the two versions are
 * merged (core/guide-merge.js), the merge is written to the shared file and
 * becomes the local guide. Resolves to { saved, path, merged?, conflicts? }.
 */
async function writeLinkedGuide(store, guideId, { force = false } = {}) {
  const guide = store.getGuide(guideId);
  if (!guide.linkedSource || !guide.linkedSource.path) {
    throw new Error('guide is not linked to a shared archive');
  }
  const target = guide.linkedSource.path;
  const result = acquireLock(target, { force });
  if (!result.acquired) {
    return { saved: false, conflict: result.conflict };
  }
  try {
    const ours = buildArchiveEntries(store, guideId);
    const oursHash = contentHash(ours);
    const plan = planLinkedWrite(store, guideId, target, ours, oursHash, { force });
    if (contentHash(plan.entries) !== oursHash) {
      // Backups keep the pre-merge guide. Nothing is applied until the merge validates.
      createSnapshot(store, guideId, { label: 'before-linked-merge' });
      applyMergedEntries(store, guideId, plan.entries);
    }
    await require('./background-archive').writeArchive(plan.entries, target);
    rememberLinkedBase(store, guideId, plan.entries, contentHash(plan.entries));
    // Re-read metadata: editing can continue while the worker writes.
    const latest = store.getGuide(guideId);
    if (latest.linkedSource?.path === target) {
      latest.linkedSource.lastSavedAt = nowIso();
      store.saveGuide(latest, { touch: false });
    }
    return { saved: true, path: target, ...(plan.merged ? { merged: true, conflicts: plan.conflicts } : {}) };
  } finally {
    // Release by our acquisition token so we never remove a lock a concurrent
    // force-steal replaced with theirs.
    releaseLock(target, { lock: result.lock });
  }
}

// Serialize the entire lock lifecycle, including repeated Ctrl+S requests.
const linkedSaves = new Map();
function saveLinkedGuide(store, guideId, options) {
  const key = store.guideDir(guideId);
  const previous = linkedSaves.get(key) || Promise.resolve();
  const job = previous.catch(() => {}).then(() => writeLinkedGuide(store, guideId, options));
  linkedSaves.set(key, job);
  const cleanup = () => { if (linkedSaves.get(key) === job) linkedSaves.delete(key); };
  job.then(cleanup, cleanup);
  return job;
}

module.exports = {
  ARCHIVE_FORMAT,
  buildArchiveEntries,
  exportGuideArchive,
  readArchive,
  importGuideArchive,
  saveLinkedGuide,
};
