'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  newId, nowIso, writeJsonSync, readJsonSync, readJsonIfExists,
  atomicWriteFileSync, deepClone,
} = require('./util');
const {
  createGuide, createStep, validateGuide, validateStep,
  normalizeGuide, normalizeStep,
} = require('./schema');
const { sanitizeHtml } = require('./sanitize');

/**
 * Folder-based guide store. One directory per guide, one directory per step,
 * all JSON written atomically. This is the only module that knows the
 * on-disk layout of the library.
 */
class GuideStore {
  constructor(rootDir) {
    if (!rootDir) throw new Error('GuideStore requires a root directory');
    this.root = rootDir;
    this.settingsDir = path.join(rootDir, 'settings');
    this.templatesDir = path.join(this.settingsDir, 'templates');
    this.libraryDir = path.join(rootDir, 'library');
    this.guidesDir = path.join(this.libraryDir, 'guides');
    this.indexDir = path.join(this.libraryDir, 'index');
    this.trashDir = path.join(this.libraryDir, 'trash');
    this.tempDir = path.join(rootDir, 'temp');
    this.sharedLinksDir = path.join(rootDir, 'shared-links');
    this.foldersFile = path.join(this.libraryDir, 'folders.json');
    this.ensureLayout();
  }

  ensureLayout() {
    for (const dir of [
      this.settingsDir, this.templatesDir, this.guidesDir, this.indexDir,
      this.trashDir, this.tempDir, this.sharedLinksDir,
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  guideDir(guideId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(guideId)) throw new Error(`bad guide id: ${guideId}`);
    return path.join(this.guidesDir, guideId);
  }

  stepDir(guideId, stepId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(stepId)) throw new Error(`bad step id: ${stepId}`);
    return path.join(this.guideDir(guideId), 'steps', stepId);
  }

  // ---- guides -------------------------------------------------------------

  createGuide(fields = {}) {
    const guide = createGuide(fields);
    validateGuide(guide);
    writeJsonSync(path.join(this.guideDir(guide.guideId), 'guide.json'), guide);
    return guide;
  }

  guideExists(guideId) {
    return fs.existsSync(path.join(this.guideDir(guideId), 'guide.json'));
  }

  getGuide(guideId) {
    const raw = readJsonSync(path.join(this.guideDir(guideId), 'guide.json'));
    return normalizeGuide(raw);
  }

  saveGuide(guide, { touch = true } = {}) {
    validateGuide(guide);
    const stored = deepClone(guide);
    stored.descriptionHtml = sanitizeHtml(stored.descriptionHtml);
    if (touch) stored.updatedAt = nowIso();
    writeJsonSync(path.join(this.guideDir(guide.guideId), 'guide.json'), stored);
    return stored;
  }

  listGuides() {
    const out = [];
    for (const entry of fs.readdirSync(this.guidesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this.guidesDir, entry.name, 'guide.json');
      try {
        out.push(normalizeGuide(readJsonSync(file)));
      } catch {
        // skip unreadable entries rather than failing the whole library
      }
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out;
  }

  setFavorite(guideId, favorite) {
    const guide = this.getGuide(guideId);
    guide.favorite = Boolean(favorite);
    return this.saveGuide(guide, { touch: false });
  }

  /** Move a guide directory into trash (recoverable until purged). */
  deleteGuide(guideId) {
    const dir = this.guideDir(guideId);
    if (!fs.existsSync(dir)) throw new Error(`guide not found: ${guideId}`);
    const dest = path.join(this.trashDir, `${guideId}-${Date.now()}`);
    fs.renameSync(dir, dest);
    const folders = this.loadFolders();
    delete folders.guideFolders[guideId];
    this.saveFolders(folders);
    return dest;
  }

  restoreFromTrash(trashName) {
    const src = path.join(this.trashDir, path.basename(trashName));
    const guide = readJsonSync(path.join(src, 'guide.json'));
    const dest = this.guideDir(guide.guideId);
    if (fs.existsSync(dest)) throw new Error(`guide already exists: ${guide.guideId}`);
    fs.renameSync(src, dest);
    return guide.guideId;
  }

  listTrash() {
    if (!fs.existsSync(this.trashDir)) return [];
    return fs.readdirSync(this.trashDir).filter((n) => {
      return fs.existsSync(path.join(this.trashDir, n, 'guide.json'));
    });
  }

  purgeTrash() {
    for (const name of fs.readdirSync(this.trashDir)) {
      fs.rmSync(path.join(this.trashDir, name), { recursive: true, force: true });
    }
  }

  purgeTrashItems(names) {
    for (const name of names) {
      fs.rmSync(path.join(this.trashDir, path.basename(name)), { recursive: true, force: true });
    }
  }

  duplicateGuide(guideId, { title } = {}) {
    const src = this.getGuide(guideId);
    const steps = this.listSteps(guideId);
    const copy = createGuide({
      ...deepClone(src),
      guideId: undefined,
      title: title || `${src.title} (copy)`,
      linkedSource: null,
    });
    const idMap = new Map();
    for (const oldId of src.stepsOrder) idMap.set(oldId, newId('step'));

    this.createGuide({ ...copy });
    for (const oldId of src.stepsOrder) {
      const oldStep = steps.get(oldId);
      if (!oldStep) continue;
      const newStep = deepClone(oldStep);
      newStep.stepId = idMap.get(oldId);
      newStep.parentStepId = oldStep.parentStepId ? idMap.get(oldStep.parentStepId) || null : null;
      writeJsonSync(path.join(this.stepDir(copy.guideId, newStep.stepId), 'step.json'), newStep);
      const oldDir = this.stepDir(guideId, oldId);
      for (const file of fs.readdirSync(oldDir)) {
        if (file === 'step.json') continue;
        fs.copyFileSync(path.join(oldDir, file), path.join(this.stepDir(copy.guideId, newStep.stepId), file));
      }
    }
    copy.stepsOrder = src.stepsOrder.map((id) => idMap.get(id)).filter(Boolean);
    return this.saveGuide(copy);
  }

  // ---- steps --------------------------------------------------------------

  /**
   * Create a step and append it to the guide's order.
   * `imageBuffer` (PNG bytes) is optional; when given it is stored as both
   * original.png (immutable) and working.png (crop target).
   */
  addStep(guideId, fields = {}, imageBuffer = null, imageSize = null, { position } = {}) {
    const guide = this.getGuide(guideId);
    const step = createStep(fields);
    if (imageBuffer) {
      const dir = this.stepDir(guideId, step.stepId);
      fs.mkdirSync(dir, { recursive: true });
      atomicWriteFileSync(path.join(dir, 'original.png'), imageBuffer);
      atomicWriteFileSync(path.join(dir, 'working.png'), imageBuffer);
      step.kind = 'image';
      step.image = {
        originalPath: 'original.png',
        workingPath: 'working.png',
        size: imageSize || { width: 0, height: 0 },
      };
    }
    validateStep(step);
    writeJsonSync(path.join(this.stepDir(guideId, step.stepId), 'step.json'), step);
    const at = Number.isInteger(position) ? position : guide.stepsOrder.length;
    guide.stepsOrder.splice(at, 0, step.stepId);
    this.saveGuide(guide);
    return step;
  }

  getStep(guideId, stepId) {
    return normalizeStep(readJsonSync(path.join(this.stepDir(guideId, stepId), 'step.json')));
  }

  /** Map of stepId -> step for every step directory of the guide. */
  listSteps(guideId) {
    const stepsRoot = path.join(this.guideDir(guideId), 'steps');
    const map = new Map();
    if (!fs.existsSync(stepsRoot)) return map;
    for (const entry of fs.readdirSync(stepsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        map.set(entry.name, normalizeStep(readJsonSync(path.join(stepsRoot, entry.name, 'step.json'))));
      } catch {
        // skip unreadable step
      }
    }
    return map;
  }

  saveStep(guideId, step) {
    const stored = normalizeStep(deepClone(step));
    stored.descriptionHtml = sanitizeHtml(stored.descriptionHtml);
    validateStep(stored);
    writeJsonSync(path.join(this.stepDir(guideId, step.stepId), 'step.json'), stored);
    const guide = this.getGuide(guideId);
    this.saveGuide(guide); // bump updatedAt
    return stored;
  }

  deleteStep(guideId, stepId) {
    const guide = this.getGuide(guideId);
    // Re-parent substeps of the deleted step to the top level.
    for (const [, step] of this.listSteps(guideId)) {
      if (step.parentStepId === stepId) {
        step.parentStepId = null;
        writeJsonSync(path.join(this.stepDir(guideId, step.stepId), 'step.json'), step);
      }
    }
    fs.rmSync(this.stepDir(guideId, stepId), { recursive: true, force: true });
    guide.stepsOrder = guide.stepsOrder.filter((id) => id !== stepId);
    this.saveGuide(guide);
  }

  reorderSteps(guideId, newOrder) {
    const guide = this.getGuide(guideId);
    const current = new Set(guide.stepsOrder);
    if (newOrder.length !== guide.stepsOrder.length || !newOrder.every((id) => current.has(id))) {
      throw new Error('reorderSteps: new order must contain exactly the existing steps');
    }
    guide.stepsOrder = [...newOrder];
    return this.saveGuide(guide);
  }

  stepImagePath(guideId, stepId, which = 'working') {
    const step = this.getStep(guideId, stepId);
    if (!step.image) return null;
    const rel = which === 'original' ? step.image.originalPath : step.image.workingPath;
    return path.join(this.stepDir(guideId, stepId), rel);
  }

  /** Replace the working image (crop result). The original is never touched. */
  setWorkingImage(guideId, stepId, pngBuffer, size, stepPatch = null) {
    const step = stepPatch ? deepClone(stepPatch) : this.getStep(guideId, stepId);
    if (!step.image) throw new Error('step has no image');
    atomicWriteFileSync(path.join(this.stepDir(guideId, stepId), step.image.workingPath), pngBuffer);
    step.image.size = size;
    return this.saveStep(guideId, step);
  }

  /** Restore working.png from original.png (un-crop). */
  resetWorkingImage(guideId, stepId, size) {
    const step = this.getStep(guideId, stepId);
    if (!step.image) throw new Error('step has no image');
    const dir = this.stepDir(guideId, stepId);
    fs.copyFileSync(path.join(dir, step.image.originalPath), path.join(dir, step.image.workingPath));
    if (size) step.image.size = size;
    return this.saveStep(guideId, step);
  }

  // ---- folders & favorites ------------------------------------------------

  loadFolders() {
    return readJsonIfExists(this.foldersFile, { folders: [], guideFolders: {} });
  }

  saveFolders(data) {
    writeJsonSync(this.foldersFile, data);
    return data;
  }

  createFolder(name, parentId = null) {
    const data = this.loadFolders();
    const folder = { id: newId('folder'), name, parentId };
    data.folders.push(folder);
    this.saveFolders(data);
    return folder;
  }

  renameFolder(folderId, name) {
    const data = this.loadFolders();
    const folder = data.folders.find((f) => f.id === folderId);
    if (!folder) throw new Error(`folder not found: ${folderId}`);
    folder.name = name;
    this.saveFolders(data);
    return folder;
  }

  deleteFolder(folderId) {
    const data = this.loadFolders();
    data.folders = data.folders.filter((f) => f.id !== folderId);
    for (const [gid, fid] of Object.entries(data.guideFolders)) {
      if (fid === folderId) delete data.guideFolders[gid];
    }
    for (const f of data.folders) {
      if (f.parentId === folderId) f.parentId = null;
    }
    this.saveFolders(data);
  }

  moveGuideToFolder(guideId, folderId) {
    const data = this.loadFolders();
    if (folderId === null) delete data.guideFolders[guideId];
    else {
      if (!data.folders.some((f) => f.id === folderId)) throw new Error(`folder not found: ${folderId}`);
      data.guideFolders[guideId] = folderId;
    }
    this.saveFolders(data);
  }
}

module.exports = { GuideStore };
