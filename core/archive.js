'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { zipSync, unzipSync } = require('./zip');
const { newId, nowIso, atomicWriteFileSync, writeJsonSync, deepClone } = require('./util');
const { normalizeGuide, normalizeStep, validateGuide, validateStep, SCHEMA_VERSION } = require('./schema');
const { acquireLock, releaseLock } = require('./locks');

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

  return finalizeImport(store, newGuide, idMap, stepJsons, stepFiles);
}

function finalizeImport(store, newGuide, idMap, stepJsons, stepFiles) {
  validateGuide(newGuide);
  writeJsonSync(path.join(store.guideDir(newGuide.guideId), 'guide.json'), newGuide);

  for (const [stepId, { raw }] of stepJsons) {
    const step = normalizeStep({ ...raw, stepId });
    step.parentStepId = raw.parentStepId ? idMap.get(raw.parentStepId) || null : null;
    validateStep(step);
    const dir = store.stepDir(newGuide.guideId, stepId);
    writeJsonSync(path.join(dir, 'step.json'), step);
    for (const { name, data } of stepFiles.get(stepId) || []) {
      atomicWriteFileSync(path.join(dir, name), data);
    }
  }
  return store.getGuide(newGuide.guideId);
}

/**
 * Write a linked guide back to its shared archive (explicit Ctrl+S save).
 * Takes the advisory lock for the duration of the write.
 */
function saveLinkedGuide(store, guideId, { force = false } = {}) {
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
    exportGuideArchive(store, guideId, target);
    guide.linkedSource.lastSavedAt = nowIso();
    store.saveGuide(guide, { touch: false });
    return { saved: true, path: target };
  } finally {
    releaseLock(target);
  }
}

module.exports = {
  ARCHIVE_FORMAT,
  exportGuideArchive,
  readArchive,
  importGuideArchive,
  saveLinkedGuide,
};
