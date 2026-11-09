'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { assertSafeEntryName } = require('./zip');
const { t } = require('./ui-text');

/*
 * Space-saving Google Drive snapshots.
 *
 * A full snapshot is a .sfgz archive with every file in the guide. A "parts"
 * snapshot is a small gzipped JSON manifest instead: it lists each archive
 * entry with its size and SHA-256, keeps small entries (guide and step JSON)
 * inline, and points at larger ones (screenshots) by hash. Each large file is
 * stored in Drive once, as a part file named by its hash, and every version
 * and guide that contains it shares that one copy. A new version therefore
 * only uploads what changed.
 *
 * Parts snapshots keep `stepforge: 'guide-v1'` so older StepForge versions
 * still see them as versions. They can't read them and report a sync error
 * rather than forking the guide, which is the safe failure.
 */

const PARTS_FORMAT = 'parts-v1';   // appProperties.format of a parts snapshot
const PART_KIND = 'part-v1';       // appProperties.stepforge of a part file
const MANIFEST_FORMAT = 'stepforge-snapshot';
// Entries this size or smaller live inside the manifest.
const INLINE_LIMIT = 32 * 1024;
// A manifest comes from Drive, so it is checked like any untrusted archive.
const LIMITS = Object.freeze({
  maxManifestBytes: 64 * 1024 * 1024,
  maxEntries: 50000,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
});
const SHA_PATTERN = /^[a-f0-9]{64}$/;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const entryBytes = (entry) => (Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8'));
const isImageName = (name) => /\.(png|jpg|jpeg|gif|webp)$/i.test(name);

/**
 * The content hash Drive snapshots are labelled with. manifest.json carries
 * an export time, so it is left out.
 */
function contentHash(entries) {
  const hash = crypto.createHash('sha256');
  for (const entry of entries.filter((e) => e.name !== 'manifest.json').sort((a, b) => compareText(a.name, b.name))) {
    const bytes = entryBytes(entry);
    hash.update(`${entry.name}:${bytes.length}:`).update(bytes);
  }
  return hash.digest('hex');
}

function isPartsSnapshot(file) {
  return file?.appProperties?.format === PARTS_FORMAT;
}

/**
 * Split archive entries into a manifest and the parts it needs.
 * Returns { manifest: Buffer, parts: Map<sha, Buffer>, bytes } where `bytes`
 * is the guide's full size.
 */
function encodeSnapshot(entries, { inlineLimit = INLINE_LIMIT } = {}) {
  const parts = new Map();
  let bytes = 0;
  const list = entries.map((entry) => {
    const data = entryBytes(entry);
    const sha = sha256(data);
    bytes += data.length;
    if (data.length <= inlineLimit) return { name: entry.name, size: data.length, sha, data: data.toString('base64') };
    parts.set(sha, data);
    return { name: entry.name, size: data.length, sha };
  });
  const manifest = zlib.gzipSync(JSON.stringify({ format: MANIFEST_FORMAT, version: 1, entries: list }));
  return { manifest, parts, bytes };
}

/** Read and check a manifest downloaded from Drive. */
function decodeSnapshot(buffer, limits = LIMITS) {
  const damaged = () => new Error(t('A cloud version is damaged and can’t be read.'));
  let raw;
  try {
    raw = JSON.parse(zlib.gunzipSync(buffer, { maxOutputLength: limits.maxManifestBytes }).toString('utf8'));
  } catch { throw damaged(); }
  if (!raw || raw.format !== MANIFEST_FORMAT || !Array.isArray(raw.entries)) throw damaged();
  if (raw.version !== 1) throw new Error(t('A cloud version was saved by a newer StepForge. Update StepForge on this computer.'));
  if (raw.entries.length > limits.maxEntries) throw damaged();
  const names = new Set();
  let total = 0;
  const entries = raw.entries.map((entry) => {
    if (!entry || typeof entry.name !== 'string' || names.has(entry.name)) throw damaged();
    try { assertSafeEntryName(entry.name); } catch { throw damaged(); }
    names.add(entry.name);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.maxEntryBytes) throw damaged();
    if (typeof entry.sha !== 'string' || !SHA_PATTERN.test(entry.sha)) throw damaged();
    total += entry.size;
    if (total > limits.maxTotalBytes) throw damaged();
    let data = null;
    if (entry.data !== undefined) {
      if (typeof entry.data !== 'string') throw damaged();
      data = Buffer.from(entry.data, 'base64');
      if (data.length !== entry.size || sha256(data) !== entry.sha) throw damaged();
    }
    return { name: entry.name, size: entry.size, sha: entry.sha, data };
  });
  return { entries, bytes: total };
}

/** Hashes of the parts a decoded manifest needs from Drive. */
function partShas(manifest) {
  return [...new Set(manifest.entries.filter((entry) => !entry.data).map((entry) => entry.sha))];
}

/** Rebuild archive entries. `part(sha)` returns that part's bytes. */
function assembleEntries(manifest, part) {
  return manifest.entries.map((entry) => {
    const data = entry.data || part(entry.sha);
    if (!data || data.length !== entry.size) throw new Error(t('A cloud version is missing some of its files.'));
    return { name: entry.name, data, store: isImageName(entry.name) };
  });
}

/** Local entries by hash, so unchanged files never need downloading. */
function entriesBySha(entries) {
  const found = new Map();
  for (const entry of entries) {
    const data = entryBytes(entry);
    found.set(sha256(data), data);
  }
  return found;
}

// ---- library folders -----------------------------------------------------
/*
 * Library folders sync as one small `folders-v1` version: a gzipped JSON table
 * with every folder (name and parent) and the folder of each guide that has
 * one. Nothing else is stored, so an account with no folders uploads nothing.
 *
 * Each field carries the time it last changed. Two computers that changed the
 * same field merge to the later change, with ties broken by value, so every
 * computer reaches the same result. A deleted folder stays as a tombstone so
 * an offline computer can't bring it back. Deleting a folder moves its guides
 * and sub-folders to the library root, as deleting one locally does. A guide
 * is never removed by a folder change.
 *
 * A table is { folders: { id: { name, parentId, nameAt, parentAt, deletedAt } },
 * guides: { guideId: { folderId, at } } }. Times are whole milliseconds.
 */

const FOLDERS_FORMAT = 'folders-v1';           // appProperties.stepforge of a folder table
const FOLDER_TABLE_FORMAT = 'stepforge-folders';
const FOLDER_LIMITS = Object.freeze({ maxFolders: 5000, maxGuides: 100000, maxName: 500, maxBytes: 16 * 1024 * 1024 });
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

const isId = (id) => typeof id === 'string' && ID_PATTERN.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
const isTime = (value) => Number.isSafeInteger(value) && value >= 0;
const emptyTable = () => ({ folders: {}, guides: {} });
// A change must be later than the one it replaces, even if the clock went back.
const stampAfter = (stamp, previous) => (previous === undefined || previous === null ? stamp : Math.max(stamp, previous + 1));
// A folder deleted at or after its last rename or move is gone; a later edit brings it back.
const isLiveFolder = (rec) => rec.deletedAt === null || rec.deletedAt <= Math.max(rec.nameAt, rec.parentAt);
const compareKeys = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The library's folders.json, validated and in the table's shape without stamps. */
function readLocalFolders(data) {
  const folders = [];
  const seen = new Set();
  for (const folder of Array.isArray(data?.folders) ? data.folders : []) {
    if (!folder || !isId(folder.id) || seen.has(folder.id) || typeof folder.name !== 'string') continue;
    seen.add(folder.id);
    folders.push({ id: folder.id, name: folder.name.slice(0, FOLDER_LIMITS.maxName), parentId: isId(folder.parentId) ? folder.parentId : null });
  }
  const guideFolders = {};
  const members = data?.guideFolders && typeof data.guideFolders === 'object' && !Array.isArray(data.guideFolders) ? data.guideFolders : {};
  for (const [guideId, folderId] of Object.entries(members)) {
    if (isId(guideId) && isId(folderId)) guideFolders[guideId] = folderId;
  }
  return { folders, guideFolders };
}

/**
 * This computer's folders as a table. `base` is the table last applied here
 * and `applied` the guide folders written then, so only changes made since
 * then get `stamp` (when folders.json was last written). With no base, the
 * first sync, changes take stamp 0 and anything from the cloud is newer.
 * A guide that's gone from this computer keeps its folder, so a guide deleted
 * and restored later comes back where it was.
 */
function localFolderTable(base, local, { stamp = 0, applied = {}, guideExists = () => true } = {}) {
  const prev = base || emptyTable();
  const folders = {};
  const here = new Map(local.folders.map((folder) => [folder.id, folder]));
  for (const [id, folder] of here) {
    const was = prev.folders[id];
    if (!was) {
      folders[id] = { name: folder.name, parentId: folder.parentId, nameAt: stamp, parentAt: stamp, deletedAt: null };
    } else {
      folders[id] = { name: folder.name, parentId: folder.parentId,
        nameAt: was.name === folder.name ? was.nameAt : stampAfter(stamp, was.nameAt),
        parentAt: was.parentId === folder.parentId ? was.parentAt : stampAfter(stamp, was.parentAt),
        deletedAt: was.deletedAt };
    }
  }
  for (const [id, was] of Object.entries(prev.folders)) {
    if (folders[id]) continue;
    // Missing here: deleted on this computer, unless it was already a tombstone.
    folders[id] = isLiveFolder(was) ? { ...was, deletedAt: stampAfter(stamp, Math.max(was.nameAt, was.parentAt)) } : was;
  }
  const guides = {};
  const members = local.guideFolders;
  const ids = new Set([...Object.keys(members), ...Object.keys(applied), ...Object.keys(prev.guides)]);
  for (const guideId of ids) {
    const was = prev.guides[guideId];
    const now = members[guideId] ?? null;
    const before = applied[guideId] ?? null;
    if (now === before || (now === null && !guideExists(guideId)) || (was && was.folderId === now)) {
      if (was) guides[guideId] = was;
      continue;
    }
    guides[guideId] = { folderId: now, at: stampAfter(stamp, was?.at) };
  }
  return { folders, guides };
}

/**
 * Settle a merged table without deleting anything: a folder whose parent is
 * gone moves to the root, a guide whose folder is gone goes to no folder, and
 * cycles are broken. Guides are kept even when their folder can't be resolved.
 */
function normalizeFolderTable(table) {
  const folders = {};
  for (const [id, rec] of Object.entries(table.folders)) folders[id] = { ...rec };
  const live = new Set(Object.keys(folders).filter((id) => isLiveFolder(folders[id])));
  for (const id of live) if (!live.has(folders[id].parentId)) folders[id].parentId = null;
  // Folders moved into each other at the same time: the oldest move is undone.
  const findCycle = () => {
    for (const start of [...live].sort(compareKeys)) {
      const path = [];
      let current = start;
      while (current !== null && live.has(current) && !path.includes(current)) {
        path.push(current);
        current = folders[current].parentId;
      }
      if (current !== null && path.includes(current)) return path.slice(path.indexOf(current));
    }
    return null;
  };
  for (let cycle = findCycle(); cycle; cycle = findCycle()) {
    const oldest = cycle.reduce((a, b) => (folders[b].parentAt < folders[a].parentAt || (folders[b].parentAt === folders[a].parentAt && b < a) ? b : a));
    folders[oldest].parentId = null;
  }
  const guides = {};
  for (const [id, rec] of Object.entries(table.guides)) {
    guides[id] = { folderId: rec.folderId !== null && live.has(rec.folderId) ? rec.folderId : null, at: rec.at };
  }
  return { folders, guides };
}

/**
 * The merged table of several versions. Each field takes the newest change
 * (ties go to the larger value), a folder is deleted only when its deletion
 * is newer than its last rename or move, and every result is normalized.
 */
function mergeFolderTables(tables) {
  const folderRecords = new Map();
  const guideRecords = new Map();
  const add = (map, key, rec) => { if (!map.has(key)) map.set(key, []); map.get(key).push(rec); };
  for (const table of tables) {
    for (const [id, rec] of Object.entries(table.folders)) add(folderRecords, id, rec);
    for (const [id, rec] of Object.entries(table.guides)) add(guideRecords, id, rec);
  }
  const newest = (recs, stampKey, valueKey) => recs.reduce((best, rec) => {
    if (rec[stampKey] !== best[stampKey]) return rec[stampKey] > best[stampKey] ? rec : best;
    return String(rec[valueKey] ?? '') > String(best[valueKey] ?? '') ? rec : best;
  });
  const folders = {};
  for (const [id, recs] of folderRecords) {
    const name = newest(recs, 'nameAt', 'name');
    const parent = newest(recs, 'parentAt', 'parentId');
    const deleted = Math.max(-1, ...recs.map((rec) => rec.deletedAt ?? -1));
    folders[id] = { name: name.name, nameAt: name.nameAt, parentId: parent.parentId, parentAt: parent.parentAt, deletedAt: deleted < 0 ? null : deleted };
  }
  const guides = {};
  for (const [id, recs] of guideRecords) {
    const best = newest(recs, 'at', 'folderId');
    guides[id] = { folderId: best.folderId, at: best.at };
  }
  return normalizeFolderTable({ folders, guides });
}

/**
 * On a computer's first sync, folders that are not yet known to the cloud but
 * have the same name and parent as a cloud folder (matched in order from the
 * root) take that folder's id. Two computers that each created "Work" then end
 * up with one folder, not two. Returns the local folders with their ids mapped.
 */
function adoptFolderIds(local, remote, knownIds = new Set()) {
  const remoteLive = new Map(Object.entries(remote.folders).filter(([, rec]) => isLiveFolder(rec)));
  const claimed = new Set(local.folders.filter((folder) => remoteLive.has(folder.id)).map((folder) => folder.id));
  const mapping = new Map();
  const unmatched = local.folders.filter((folder) => !remoteLive.has(folder.id) && !knownIds.has(folder.id));
  for (let progress = true; progress;) {
    progress = false;
    for (const folder of unmatched) {
      if (mapping.has(folder.id)) continue;
      const parent = folder.parentId === null ? null
        : mapping.has(folder.parentId) ? mapping.get(folder.parentId)
          : remoteLive.has(folder.parentId) ? folder.parentId : undefined;
      if (parent === undefined) continue;
      const match = [...remoteLive].find(([id, rec]) => !claimed.has(id) && rec.name === folder.name && rec.parentId === parent);
      if (match) {
        mapping.set(folder.id, match[0]);
        claimed.add(match[0]);
        progress = true;
      }
    }
  }
  const mapId = (id) => (id === null ? null : mapping.get(id) ?? id);
  return {
    folders: local.folders.map((folder) => ({ id: mapId(folder.id), name: folder.name, parentId: mapId(folder.parentId) })),
    guideFolders: Object.fromEntries(Object.entries(local.guideFolders).map(([guideId, folderId]) => [guideId, mapId(folderId)])),
  };
}

/**
 * Give folders not yet synchronized a stable identity before their first
 * upload. Concurrent devices can then create the same tree without producing
 * two cloud identities. Known ids (including tombstones) never change; a
 * repeated sibling name gets another slot, preserving deliberate duplicates.
 */
function identifyNewFolders(local, known) {
  const occupied = new Set(Object.keys(known));
  const mapping = new Map(local.folders.filter((folder) => occupied.has(folder.id)).map((folder) => [folder.id, folder.id]));
  const pending = local.folders.filter((folder) => !mapping.has(folder.id)).sort((a, b) => compareKeys(a.id, b.id));
  for (let progress = true; progress;) {
    progress = false;
    for (const folder of pending) {
      if (mapping.has(folder.id)) continue;
      const parentId = folder.parentId === null ? null : mapping.get(folder.parentId);
      if (parentId === undefined) continue;
      let id;
      for (let slot = 0; ; slot++) {
        id = `folder-${sha256(JSON.stringify([parentId, folder.name, slot])).slice(0, 32)}`;
        if (!occupied.has(id)) break;
      }
      occupied.add(id);
      mapping.set(folder.id, id);
      progress = true;
    }
  }
  const mapped = (id) => mapping.get(id) ?? id;
  return {
    folders: local.folders.map((folder) => ({ ...folder, id: mapped(folder.id), parentId: mapped(folder.parentId) })),
    guideFolders: Object.fromEntries(Object.entries(local.guideFolders).map(([id, folderId]) => [id, mapped(folderId)])),
  };
}

function canonicalTable(table) {
  const sorted = (obj, pick) => Object.fromEntries(Object.keys(obj).sort(compareKeys).map((key) => [key, pick(obj[key])]));
  return {
    folders: sorted(table.folders, (rec) => ({ name: rec.name, parentId: rec.parentId, nameAt: rec.nameAt, parentAt: rec.parentAt, deletedAt: rec.deletedAt })),
    guides: sorted(table.guides, (rec) => ({ folderId: rec.folderId, at: rec.at })),
  };
}

/** The table's content hash, stored with the version so a download can be checked. */
const folderTableHash = (table) => sha256(JSON.stringify(canonicalTable(table)));

function encodeFolderTable(table) {
  return zlib.gzipSync(JSON.stringify({ format: FOLDER_TABLE_FORMAT, version: 1, ...canonicalTable(table) }));
}

/** Read a folder table from Drive. Anything malformed is an error, never a partial table. */
function decodeFolderTable(buffer) {
  const damaged = () => new Error(t('A cloud folder list is damaged and can’t be read.'));
  let raw;
  try { raw = JSON.parse(zlib.gunzipSync(buffer, { maxOutputLength: FOLDER_LIMITS.maxBytes }).toString('utf8')); } catch { throw damaged(); }
  if (!raw || raw.format !== FOLDER_TABLE_FORMAT || !raw.folders || !raw.guides || typeof raw.folders !== 'object' || typeof raw.guides !== 'object'
    || Array.isArray(raw.folders) || Array.isArray(raw.guides)) throw damaged();
  if (raw.version !== 1) throw new Error(t('The cloud folder list was saved by a newer StepForge. Update StepForge on this computer.'));
  const folderEntries = Object.entries(raw.folders);
  const guideEntries = Object.entries(raw.guides);
  if (folderEntries.length > FOLDER_LIMITS.maxFolders || guideEntries.length > FOLDER_LIMITS.maxGuides) throw damaged();
  const folders = {};
  for (const [id, rec] of folderEntries) {
    if (!isId(id) || !rec || typeof rec !== 'object') throw damaged();
    if (typeof rec.name !== 'string' || rec.name.length > FOLDER_LIMITS.maxName) throw damaged();
    if (!(rec.parentId === null || isId(rec.parentId)) || !isTime(rec.nameAt) || !isTime(rec.parentAt)) throw damaged();
    if (!(rec.deletedAt === null || isTime(rec.deletedAt))) throw damaged();
    folders[id] = { name: rec.name, parentId: rec.parentId, nameAt: rec.nameAt, parentAt: rec.parentAt, deletedAt: rec.deletedAt };
  }
  const guides = {};
  for (const [id, rec] of guideEntries) {
    if (!isId(id) || !rec || typeof rec !== 'object') throw damaged();
    if (!(rec.folderId === null || isId(rec.folderId)) || !isTime(rec.at)) throw damaged();
    guides[id] = { folderId: rec.folderId, at: rec.at };
  }
  return { folders, guides };
}

/**
 * Write the table to folders.json (only if it changed). Returns the guide
 * folders written, as `applied` (only guides that are on this computer get
 * one, so a folder entry never points at a guide that isn't here), and
 * whether folders.json `changed`.
 */
function applyFolderTable(store, table, guideExists) {
  const folders = Object.keys(table.folders).filter((id) => isLiveFolder(table.folders[id])).sort(compareKeys)
    .map((id) => ({ id, name: table.folders[id].name, parentId: table.folders[id].parentId }));
  const guideFolders = {};
  for (const [guideId, rec] of Object.entries(table.guides)) {
    if (rec.folderId !== null && guideExists(guideId)) guideFolders[guideId] = rec.folderId;
  }
  const view = { folders, guideFolders };
  const current = store.loadFolders();
  const key = (data) => {
    const local = readLocalFolders(data);
    return JSON.stringify({
      folders: [...local.folders].sort((a, b) => compareKeys(a.id, b.id)),
      guideFolders: Object.keys(local.guideFolders).sort(compareKeys).map((guideId) => [guideId, local.guideFolders[guideId]]),
    });
  };
  const changed = key(current) !== key(view);
  if (changed) store.saveFolders({ ...current, folders, guideFolders });
  return { applied: guideFolders, changed };
}

module.exports = {
  PARTS_FORMAT, PART_KIND, INLINE_LIMIT, LIMITS, SHA_PATTERN,
  sha256, contentHash, isPartsSnapshot, encodeSnapshot, decodeSnapshot, partShas, assembleEntries, entriesBySha,
  FOLDERS_FORMAT, FOLDER_LIMITS, readLocalFolders, localFolderTable, mergeFolderTables, adoptFolderIds, identifyNewFolders,
  folderTableHash, encodeFolderTable, decodeFolderTable, applyFolderTable, emptyTable,
};
