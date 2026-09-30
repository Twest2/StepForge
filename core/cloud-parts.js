'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { assertSafeEntryName } = require('./zip');

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
  const damaged = () => new Error('A Google Drive version is damaged and can’t be read.');
  let raw;
  try {
    raw = JSON.parse(zlib.gunzipSync(buffer, { maxOutputLength: limits.maxManifestBytes }).toString('utf8'));
  } catch { throw damaged(); }
  if (!raw || raw.format !== MANIFEST_FORMAT || !Array.isArray(raw.entries)) throw damaged();
  if (raw.version !== 1) throw new Error('A Google Drive version was saved by a newer StepForge. Update StepForge on this computer.');
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
    if (!data || data.length !== entry.size) throw new Error('A Google Drive version is missing some of its files.');
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

module.exports = {
  PARTS_FORMAT, PART_KIND, INLINE_LIMIT, LIMITS, SHA_PATTERN,
  sha256, contentHash, isPartsSnapshot, encodeSnapshot, decodeSnapshot, partShas, assembleEntries, entriesBySha,
};
