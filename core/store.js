'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const {
  newId, nowIso, writeJsonSync, readJsonSync, readJsonIfExists,
  atomicWriteFileSync, deepClone,
} = require('./util');
const {
  createGuide, createStep, validateGuide, validateStep,
  normalizeGuide, normalizeStep,
} = require('./schema');
const { sanitizeHtml } = require('./sanitize');
const { isValidOutline } = require('./step-outline');
const { toDateOnly } = require('./review');

// A step's screenshot is original.png. Cropping it writes working.png;
// until then the working path is the original's, so there is one copy.
const ORIGINAL_FILE = 'original.png';
const WORKING_FILE = 'working.png';

const DAY_MS = 24 * 60 * 60 * 1000;

/** When a trashed guide was deleted (ms), from its `<guideId>-<ms>` name. */
function trashStamp(name) {
  return Number(name.match(/-(\d{10,})$/)?.[1]);
}

/**
 * Thrown by revision-aware saves when the on-disk revision no longer matches
 * the caller's expectation — i.e. someone else wrote in between. Callers that
 * pass expectedRevision (background/AI/capture writes) use this to avoid
 * clobbering a newer user edit.
 */
class RevisionConflictError extends Error {
  constructor(kind, id, expected, actual) {
    super(`${kind} ${id} changed since it was read (expected revision ${expected}, found ${actual})`);
    this.name = 'RevisionConflictError';
    this.code = 'STEPFORGE_REVISION_CONFLICT';
    this.expected = expected;
    this.actual = actual;
  }
}

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
    this.quarantineDir = path.join(this.libraryDir, 'quarantine');
    this.tempDir = path.join(rootDir, 'temp');
    this.sharedLinksDir = path.join(rootDir, 'shared-links');
    this.foldersFile = path.join(this.libraryDir, 'folders.json');
    // In-memory log of files quarantined this session (corrupt/unreadable),
    // surfaced to the UI instead of silently vanishing.
    this.recoveryReport = [];
    this.ensureLayout();
  }

  ensureLayout() {
    for (const dir of [
      this.settingsDir, this.templatesDir, this.guidesDir, this.indexDir,
      this.trashDir, this.quarantineDir, this.tempDir, this.sharedLinksDir,
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Move a corrupt/unreadable file or directory into quarantine (preserving
   * the original bytes) and record it, rather than silently dropping it. A
   * guide/step never just disappears without an explanation.
   */
  quarantine(sourcePath, kind, reason) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dest = path.join(this.quarantineDir, `${kind}-${path.basename(sourcePath)}-${stamp}`);
    try {
      fs.mkdirSync(this.quarantineDir, { recursive: true });
      fs.renameSync(sourcePath, dest);
    } catch {
      // If we cannot move it (e.g. cross-device or vanished), still record it.
    }
    const entry = { kind, source: sourcePath, quarantined: dest, reason: String(reason || 'unreadable'), at: nowIso() };
    this.recoveryReport.push(entry);
    return entry;
  }

  /** Corrupt files quarantined this session (for a recovery UI). */
  getRecoveryReport() {
    return [...this.recoveryReport];
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

  createGuide(fields = {}, { captureDraft = false } = {}) {
    const guide = createGuide(fields);
    validateGuide(guide);
    if (captureDraft) writeJsonSync(path.join(this.guideDir(guide.guideId), 'capture-draft.json'), guide);
    writeJsonSync(path.join(this.guideDir(guide.guideId), 'guide.json'), guide);
    return guide;
  }

  // Only explicitly created capture drafts qualify. Never infer this from a
  // default-looking title: old, imported, and intentionally empty guides count.
  isCaptureDraft(guide) {
    const file = path.join(this.guideDir(guide.guideId), 'capture-draft.json');
    if (!fs.existsSync(file)) return false;
    try {
      const comparable = value => {
        const { revision, createdAt, updatedAt, ...content } = normalizeGuide(value);
        content.title = content.title.trim();
        if (!content.descriptionHtml.replace(/<\/?(?:p|div|br)\b[^>]*>|&nbsp;|\s/gi, '')) content.descriptionHtml = '';
        return content;
      };
      return isDeepStrictEqual(comparable(guide), comparable(readJsonSync(file)));
    } catch {
      // If the marker cannot be read, show the guide rather than hide data.
      return false;
    }
  }

  publishCaptureDraft(guideId) {
    fs.rmSync(path.join(this.guideDir(guideId), 'capture-draft.json'), { force: true });
  }

  guideExists(guideId) {
    return fs.existsSync(path.join(this.guideDir(guideId), 'guide.json'));
  }

  getGuide(guideId) {
    const raw = readJsonSync(path.join(this.guideDir(guideId), 'guide.json'));
    return normalizeGuide(raw);
  }

  saveGuide(guide, { touch = true, expectedRevision = null } = {}) {
    validateGuide(guide);
    // Optimistic concurrency: a caller that read the guide can pass the
    // revision it saw; if disk moved on since, refuse rather than clobber.
    if (expectedRevision !== null) {
      const current = this.guideExists(guide.guideId) ? this.getGuide(guide.guideId).revision : 0;
      if (current !== expectedRevision) {
        throw new RevisionConflictError('guide', guide.guideId, expectedRevision, current);
      }
    }
    const stored = deepClone(guide);
    stored.descriptionHtml = sanitizeHtml(stored.descriptionHtml);
    stored.revision = (Number.isInteger(stored.revision) ? stored.revision : 0) + 1;
    if (touch) stored.updatedAt = nowIso();
    writeJsonSync(path.join(this.guideDir(guide.guideId), 'guide.json'), stored);
    if (!this.isCaptureDraft(stored)) this.publishCaptureDraft(stored.guideId);
    return stored;
  }

  listGuides() {
    const out = [];
    for (const entry of fs.readdirSync(this.guidesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.guidesDir, entry.name);
      const file = path.join(dir, 'guide.json');
      if (!fs.existsSync(file)) continue; // in-progress/empty dir, not corruption
      try {
        const guide = normalizeGuide(readJsonSync(file));
        if (!this.isCaptureDraft(guide)) out.push(guide);
      } catch (err) {
        // A corrupt guide.json used to make the guide silently vanish from the
        // library. Quarantine the directory (preserving it) and record it so
        // the user can be told, instead of losing it without explanation.
        this.quarantine(dir, 'guide', err && err.message);
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

  /**
   * Record that someone checked the guide still matches the software today.
   * It restarts the review clock (core/review.js) without counting as an
   * edit, so the library's "edited" time stays as it was.
   */
  markVerified(guideId, now = Date.now()) {
    const guide = this.getGuide(guideId);
    guide.metadata = { ...(guide.metadata || {}), lastVerified: toDateOnly(now) };
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

  /** Trashed guides with their titles and deletion times, newest first. */
  listTrashItems() {
    return this.listTrash().map((name) => {
      const guide = readJsonIfExists(path.join(this.trashDir, name, 'guide.json'), {});
      const stamp = trashStamp(name);
      return { name, title: guide.title || 'Untitled guide', stepCount: (guide.stepsOrder || []).length,
        deletedAt: Number.isFinite(stamp) ? new Date(stamp).toISOString() : null };
    }).sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')));
  }

  /**
   * Permanently delete trashed guides older than `days`. A guide's age
   * counts from when it was deleted, or from `since` if that is later, so
   * guides already in the trash when emptying was turned on get the full
   * time. Guides with no deletion time are kept. Returns the names removed.
   */
  purgeExpiredTrash({ days, since = 0, now = Date.now() } = {}) {
    if (!(days > 0) || !fs.existsSync(this.trashDir)) return [];
    const removed = [];
    for (const name of this.listTrash()) {
      const stamp = trashStamp(name);
      if (!Number.isFinite(stamp)) continue;
      if (Math.max(stamp, since) + days * DAY_MS > now) continue;
      fs.rmSync(path.join(this.trashDir, name), { recursive: true, force: true });
      removed.push(name);
    }
    return removed;
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
   * `imageBuffer` (PNG bytes) is optional; when given it is stored as
   * original.png, which is never changed. A crop goes to working.png.
   */
  addStep(guideId, fields = {}, imageBuffer = null, imageSize = null, { position } = {}) {
    const guide = this.getGuide(guideId);
    const step = createStep(fields);
    if (imageBuffer) {
      const dir = this.stepDir(guideId, step.stepId);
      fs.mkdirSync(dir, { recursive: true });
      atomicWriteFileSync(path.join(dir, ORIGINAL_FILE), imageBuffer);
      step.kind = 'image';
      step.image = {
        originalPath: ORIGINAL_FILE,
        workingPath: ORIGINAL_FILE,
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
      const dir = path.join(stepsRoot, entry.name);
      const file = path.join(dir, 'step.json');
      if (!fs.existsSync(file)) continue;
      try {
        map.set(entry.name, normalizeStep(readJsonSync(file)));
      } catch (err) {
        // Quarantine a corrupt step (preserving it) and record it rather than
        // silently dropping it from the guide.
        this.quarantine(dir, 'step', err && err.message);
      }
    }
    return map;
  }

  /**
   * `touch: false` leaves the guide's updatedAt alone, for bookkeeping that
   * doesn't change what the guide shows (a private-detail check that found
   * nothing). Its revision still moves, so caches keyed on it refresh.
   */
  saveStep(guideId, step, { expectedRevision = null, touch = true, imagePaths = false } = {}) {
    // A capture/image/background operation can finish after an agent trashed
    // the guide. Refuse before creating any files in the old location.
    const guide = this.getGuide(guideId);
    // Optimistic concurrency for background/AI/capture writes: refuse to
    // overwrite a step that changed since it was read. Direct user edits pass
    // no expectedRevision (last-write-wins — the user is the authority).
    if (expectedRevision !== null) {
      let current = 0;
      try {
        current = this.getStep(guideId, step.stepId).revision;
      } catch {
        current = 0; // step vanished; treat as revision 0
      }
      if (current !== expectedRevision) {
        throw new RevisionConflictError('step', step.stepId, expectedRevision, current);
      }
    }
    const stored = normalizeStep(deepClone(step));
    // Which files a screenshot uses is the store's to decide (a crop moves
    // the working path), so a caller's copy of the step can't point it back.
    if (!imagePaths) this.currentImagePaths(guideId, stored);
    stored.descriptionHtml = sanitizeHtml(stored.descriptionHtml);
    stored.revision = (Number.isInteger(stored.revision) ? stored.revision : 0) + 1;
    validateStep(stored);
    writeJsonSync(path.join(this.stepDir(guideId, step.stepId), 'step.json'), stored);
    this.saveGuide(guide, { touch }); // bump updatedAt
    return stored;
  }

  deleteStep(guideId, stepId) {
    const guide = this.getGuide(guideId);
    // Substeps of the deleted step move up a level, to its parent (or the
    // top level), so the outline still reads top to bottom.
    const steps = this.listSteps(guideId);
    const parentId = steps.get(stepId)?.parentStepId || null;
    for (const [, step] of steps) {
      if (step.parentStepId === stepId) {
        step.parentStepId = parentId;
        step.revision = (Number.isInteger(step.revision) ? step.revision : 0) + 1;
        writeJsonSync(path.join(this.stepDir(guideId, step.stepId), 'step.json'), step);
      }
    }
    fs.rmSync(this.stepDir(guideId, stepId), { recursive: true, force: true });
    guide.stepsOrder = guide.stepsOrder.filter((id) => id !== stepId);
    this.saveGuide(guide);
  }

  /**
   * Recreate a previously-deleted step, preserving its stepId, and splice it
   * back into the guide's order. Used to undo step deletion.
   */
  restoreStep(guideId, step, images, position) {
    const guide = this.getGuide(guideId);
    const restored = normalizeStep(deepClone(step));
    validateStep(restored);
    const dir = this.stepDir(guideId, restored.stepId);
    fs.mkdirSync(dir, { recursive: true });
    if (restored.image && images) {
      const { originalPath, workingPath } = restored.image;
      if (images.original) atomicWriteFileSync(path.join(dir, originalPath), images.original);
      if (images.working && (workingPath !== originalPath || !images.original)) {
        atomicWriteFileSync(path.join(dir, workingPath), images.working);
      }
    }
    writeJsonSync(path.join(dir, 'step.json'), restored);
    const at = Number.isInteger(position) ? Math.min(position, guide.stepsOrder.length) : guide.stepsOrder.length;
    guide.stepsOrder.splice(at, 0, restored.stepId);
    this.saveGuide(guide);
    return restored;
  }

  /**
   * Put the steps in `newOrder`. `parents` (optional, { stepId: parentStepId | null })
   * also re-parents the steps it names, in the same call. Whenever `parents` is
   * passed, even empty, the resulting outline must read top to bottom
   * (isValidOutline) or nothing is changed; the one exception is a guide whose
   * outline is already broken on disk (an old move), which keeps reordering
   * the way it always could. Without `parents` only the order changes and the
   * outline is not checked.
   */
  reorderSteps(guideId, newOrder, parents = null) {
    const guide = this.getGuide(guideId);
    const current = new Set(guide.stepsOrder);
    if (newOrder.length !== guide.stepsOrder.length || !newOrder.every((id) => current.has(id))) {
      throw new Error('reorderSteps: new order must contain exactly the existing steps');
    }
    const changes = [];
    if (parents) {
      const steps = this.listSteps(guideId);
      const parentOf = new Map();
      for (const id of newOrder) parentOf.set(id, steps.has(id) ? steps.get(id).parentStepId || null : null);
      const wasValid = isValidOutline(guide.stepsOrder, parentOf);
      for (const [id, parentId] of Object.entries(parents)) {
        if (!parentOf.has(id)) throw new Error(`reorderSteps: unknown step ${id} in parents`);
        if ((parentId || null) !== parentOf.get(id)) changes.push([id, parentId || null]);
        parentOf.set(id, parentId || null);
      }
      if (wasValid && !isValidOutline(newOrder, parentOf)) {
        throw new Error('reorderSteps: that order would break the step numbering');
      }
    }
    for (const [id, parentId] of changes) {
      const step = this.getStep(guideId, id);
      step.parentStepId = parentId;
      step.revision = (Number.isInteger(step.revision) ? step.revision : 0) + 1;
      writeJsonSync(path.join(this.stepDir(guideId, id), 'step.json'), step);
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

  /**
   * Make `buffer` the step's working image. One with the original's
   * bytes (an undone crop) uses the original's file; anything else is
   * written to working.png. Returns the working file that is no longer used, to delete
   * once step.json no longer names it.
   */
  placeWorkingImage(dir, image, buffer) {
    const originalFile = path.join(dir, image.originalPath);
    if (fs.existsSync(originalFile) && fs.readFileSync(originalFile).equals(buffer)) {
      const unused = image.workingPath !== image.originalPath ? path.join(dir, image.workingPath) : null;
      image.workingPath = image.originalPath;
      return unused;
    }
    if (image.workingPath === image.originalPath) {
      image.workingPath = image.originalPath === WORKING_FILE ? `crop-${WORKING_FILE}` : WORKING_FILE;
    }
    atomicWriteFileSync(path.join(dir, image.workingPath), buffer);
    return null;
  }

  /** The image paths on disk, which a caller's copy of the step may predate. */
  currentImagePaths(guideId, step) {
    const onDisk = readJsonIfExists(path.join(this.stepDir(guideId, step.stepId), 'step.json'), null)?.image;
    if (onDisk && step.image) Object.assign(step.image, { originalPath: onDisk.originalPath, workingPath: onDisk.workingPath });
    return step;
  }

  /** Replace the working image (crop result). The original is never touched. */
  setWorkingImage(guideId, stepId, pngBuffer, size, stepPatch = null) {
    this.getGuide(guideId);
    const current = this.getStep(guideId, stepId);
    const step = stepPatch ? this.currentImagePaths(guideId, deepClone(stepPatch)) : current;
    step.revision = current.revision;
    if (!step.image) throw new Error('step has no image');
    const unused = this.placeWorkingImage(this.stepDir(guideId, stepId), step.image, pngBuffer);
    step.image.size = size;
    const saved = this.saveStep(guideId, step, { imagePaths: true });
    if (unused) fs.rmSync(unused, { force: true });
    return saved;
  }

  /**
   * Replace a step's screenshot (Choose image…, and undoing it).
   * `images.original` becomes original.png; `images.working`, when it
   * differs, becomes working.png. A step without a screenshot gets one.
   * `stepPatch` is saved with it, so text and annotations go in one write.
   */
  replaceImages(guideId, stepId, images, size, stepPatch = null) {
    this.getGuide(guideId);
    const current = this.getStep(guideId, stepId);
    const step = stepPatch ? this.currentImagePaths(guideId, deepClone(stepPatch)) : current;
    step.revision = current.revision;
    if (!images?.original && !images?.working) throw new Error('No screenshot to use.');
    if (!step.image) {
      step.image = { originalPath: ORIGINAL_FILE, workingPath: ORIGINAL_FILE, size };
    }
    step.kind = 'image';
    const dir = this.stepDir(guideId, stepId);
    fs.mkdirSync(dir, { recursive: true });
    if (images.original) atomicWriteFileSync(path.join(dir, step.image.originalPath), images.original);
    const unused = this.placeWorkingImage(dir, step.image, images.working || images.original);
    step.image.size = size;
    const saved = this.saveStep(guideId, step, { imagePaths: true });
    if (unused) fs.rmSync(unused, { force: true });
    return saved;
  }

  /** Un-crop: the working image is the original again, and working.png goes. */
  resetWorkingImage(guideId, stepId, size) {
    const step = this.getStep(guideId, stepId);
    if (!step.image) throw new Error('step has no image');
    const { originalPath, workingPath } = step.image;
    step.image.workingPath = originalPath;
    if (size) step.image.size = size;
    const saved = this.saveStep(guideId, step, { imagePaths: true });
    if (workingPath !== originalPath) fs.rmSync(path.join(this.stepDir(guideId, stepId), workingPath), { force: true });
    return saved;
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
    if (folderId !== null) this.publishCaptureDraft(guideId);
  }
}

module.exports = { GuideStore, RevisionConflictError };
