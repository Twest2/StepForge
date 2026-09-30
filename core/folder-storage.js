'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { writeJsonSync, readJsonIfExists } = require('./util');

/*
 * Sync storage for services that keep plain files in a folder: OneDrive,
 * Dropbox and Nextcloud/WebDAV.
 *
 * CloudSync works with Google Drive-style files: an id, a name, a creation
 * time, a size and string `appProperties`. Other services have no per-file
 * properties, so this stores them as files:
 *
 *   parts/<sha>        a shared part (core/cloud-parts.js), named by its hash,
 *                      so listing the folder is all a sync needs.
 *   objects/<id>.bin   the data of a version or deletion record.
 *   objects/<id>.json  its name, time, size and properties. Written last, so
 *                      a file only counts once its data is complete. Small
 *                      data such as deletion records lives inside it.
 *
 * Files never change once written, so details that have been read are cached
 * on disk and a sync only downloads the details of files it hasn't seen.
 *
 * A backend provides:
 *   list(folder)                  → [{ name, size, modified }], [] if missing
 *   put(path, data, { onProgress }) creates missing parent folders
 *   get(path, { onProgress })     → Buffer
 *   remove(path)                  succeeds if the file is already gone
 *   quota()                       → { limit, usage } (either may be null)
 */

const PART_PREFIX = 'p-';
const INLINE_BYTES = 4 * 1024;
const MAX_DETAILS_BYTES = 256 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const OBJECT_ID = /^[a-z0-9]{1,16}-[a-f0-9]{16}$/;
// A version's data without details is an upload that never finished.
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

const newObjectId = () => `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
const isoTime = (value) => {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
};

function validDetails(value) {
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !isoTime(value.createdTime)) return false;
  const props = value.appProperties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return false;
  if (!Object.values(props).every((v) => typeof v === 'string')) return false;
  return value.data === undefined || typeof value.data === 'string';
}

class FolderStorage {
  constructor({ backend, cacheFile = null }) {
    this.backend = backend;
    this.cacheFile = cacheFile;
    this.details = new Map(Object.entries((cacheFile && readJsonIfExists(cacheFile, null)?.objects) || {})
      .filter(([id, value]) => OBJECT_ID.test(id) && validDetails(value)));
    this.listing = null;
  }

  saveCache() {
    if (!this.cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      writeJsonSync(this.cacheFile, { objects: Object.fromEntries(this.details) });
    } catch { /* only a cache */ }
  }

  clearCache() {
    this.details.clear();
    if (this.cacheFile) fs.rmSync(this.cacheFile, { force: true });
  }

  file(id, value, size) {
    const { data, ...details } = value;
    return { id, name: details.name, createdTime: details.createdTime, size: String(size ?? details.size ?? 0), appProperties: { ...details.appProperties } };
  }

  // Versions and deletion records together. listVersions and listDeletions
  // run side by side, so they share one listing.
  objects() {
    this.listing ||= (async () => {
      const entries = await this.backend.list('objects');
      const ids = new Set();
      const sizes = new Map();
      for (const entry of entries) {
        const match = /^(.+)\.(json|bin)$/.exec(entry.name);
        if (!match || !OBJECT_ID.test(match[1])) continue;
        if (match[2] === 'json') ids.add(match[1]);
        else sizes.set(match[1], Number(entry.size) || 0);
      }
      const unknown = [...ids].filter((id) => !this.details.has(id));
      let changed = unknown.length > 0;
      const worker = async () => {
        for (let id = unknown.shift(); id; id = unknown.shift()) {
          let bytes;
          try { bytes = await this.backend.get(`objects/${id}.json`); } catch (err) {
            // Deleted by another computer since the listing: skip it.
            if (err.status === 404) continue;
            throw err;
          }
          // Anything unreadable isn't a StepForge file; leave it alone.
          let value = null;
          try { value = bytes.length <= MAX_DETAILS_BYTES ? JSON.parse(bytes.toString('utf8')) : null; } catch { /* skipped */ }
          if (validDetails(value)) this.details.set(id, { ...value, createdTime: isoTime(value.createdTime) });
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, unknown.length) }, worker));
      for (const id of [...this.details.keys()]) {
        if (!ids.has(id)) { this.details.delete(id); changed = true; }
      }
      if (changed) this.saveCache();
      return [...ids].filter((id) => this.details.has(id)).map((id) => {
        const value = this.details.get(id);
        return this.file(id, value, value.data !== undefined ? Buffer.from(value.data, 'base64').length : sizes.get(id) ?? value.size);
      });
    })().finally(() => { this.listing = null; });
    return this.listing;
  }

  async listVersions() {
    return (await this.objects()).filter((file) => file.appProperties.stepforge === 'guide-v1');
  }

  async listDeletions() {
    return (await this.objects()).filter((file) => file.appProperties.stepforge === 'deletion-v1');
  }

  async listParts() {
    return (await this.backend.list('parts')).filter((entry) => SHA.test(entry.name)).map((entry) => ({
      id: `${PART_PREFIX}${entry.name}`, name: `part-${entry.name}`, createdTime: isoTime(entry.modified),
      size: String(Number(entry.size) || 0), appProperties: { stepforge: 'part-v1', sha: entry.name },
    }));
  }

  async upload({ data, name, properties, onProgress }) {
    const createdTime = new Date().toISOString();
    if (properties.stepforge === 'part-v1') {
      if (!SHA.test(properties.sha || '')) throw new Error('A shared part has no valid hash.');
      // Parts are named by their content, so writing one twice is harmless.
      await this.backend.put(`parts/${properties.sha}`, data, { onProgress });
      return { id: `${PART_PREFIX}${properties.sha}`, name, createdTime, size: String(data.length), appProperties: { ...properties } };
    }
    const id = newObjectId();
    const details = { name, createdTime, size: data.length, appProperties: { ...properties } };
    if (data.length <= INLINE_BYTES) details.data = data.toString('base64');
    else await this.backend.put(`objects/${id}.bin`, data, { onProgress });
    await this.backend.put(`objects/${id}.json`, Buffer.from(JSON.stringify(details)));
    if (details.data !== undefined) onProgress?.(data.length);
    this.details.set(id, details);
    this.saveCache();
    return this.file(id, details, data.length);
  }

  async download(id, { onProgress } = {}) {
    if (id.startsWith(PART_PREFIX)) {
      const sha = id.slice(PART_PREFIX.length);
      if (!SHA.test(sha)) throw new Error('That file isn’t in cloud storage.');
      return this.backend.get(`parts/${sha}`, { onProgress });
    }
    if (!OBJECT_ID.test(id)) throw new Error('That file isn’t in cloud storage.');
    let details = this.details.get(id);
    if (!details) {
      details = JSON.parse((await this.backend.get(`objects/${id}.json`)).toString('utf8'));
      if (!validDetails(details)) throw new Error('A cloud version is damaged and can’t be read.');
    }
    if (details.data !== undefined) {
      const data = Buffer.from(details.data, 'base64');
      onProgress?.(data.length);
      return data;
    }
    return this.backend.get(`objects/${id}.bin`, { onProgress });
  }

  async deleteFile(id) {
    if (id.startsWith(PART_PREFIX)) {
      const sha = id.slice(PART_PREFIX.length);
      if (SHA.test(sha)) await this.backend.remove(`parts/${sha}`);
      return null;
    }
    if (!OBJECT_ID.test(id)) return null;
    // Details first: without them the data is ignored, then cleaned up.
    await this.backend.remove(`objects/${id}.json`);
    await this.backend.remove(`objects/${id}.bin`);
    if (this.details.delete(id)) this.saveCache();
    return null;
  }

  /** Remove data files whose upload never finished. */
  async removeOrphans({ olderThanMs = ORPHAN_GRACE_MS, now = Date.now() } = {}) {
    const entries = await this.backend.list('objects');
    const complete = new Set(entries.filter((entry) => entry.name.endsWith('.json')).map((entry) => entry.name.slice(0, -5)));
    let removed = 0;
    for (const entry of entries) {
      const match = /^(.+)\.bin$/.exec(entry.name);
      if (!match || !OBJECT_ID.test(match[1]) || complete.has(match[1])) continue;
      const modified = Date.parse(entry.modified || '');
      if (!Number.isFinite(modified) || now - modified < olderThanMs) continue;
      await this.backend.remove(`objects/${entry.name}`);
      removed += 1;
    }
    return removed;
  }

  quota() { return this.backend.quota(); }
}

module.exports = { FolderStorage, INLINE_BYTES, ORPHAN_GRACE_MS, newObjectId };
