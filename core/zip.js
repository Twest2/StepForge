'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/**
 * Minimal ZIP writer/reader using only node:zlib. Supports methods 0 (store)
 * and 8 (deflate), UTF-8 names, and CRC-32 verification on read. This backs
 * .sfgz / .sfglt archives, snapshots, DOCX, and PPTX — no dependency needed.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date || new Date(2026, 0, 1);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const day = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, day };
}

/**
 * Throws unless `name` is a safe relative archive entry path.
 * Rejects absolute paths, drive letters, backslashes, and `..` segments.
 */
function assertSafeEntryName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 4096) {
    throw new Error('zip: invalid entry name');
  }
  if (name.includes('\\')) throw new Error(`zip: backslash in entry name: ${name}`);
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw new Error(`zip: absolute entry name: ${name}`);
  }
  const isDir = name.endsWith('/');
  const segs = (isDir ? name.slice(0, -1) : name).split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`zip: unsafe entry name: ${name}`);
  }
  if (name.includes('\u0000')) throw new Error('zip: NUL in entry name');
  return name;
}

/**
 * Build a zip from entries: [{ name, data (Buffer|string), store? }].
 * Deterministic when `date` is fixed.
 */
function zipSync(entries, { date = new Date(2026, 0, 1) } = {}) {
  const { time, day } = dosDateTime(date);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    assertSafeEntryName(entry.name);
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const crc = crc32(data);
    let method = 8;
    let payload = zlib.deflateRawSync(data, { level: 6 });
    if (entry.store || payload.length >= data.length) {
      method = 0;
      payload = data;
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra len

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);          // made by
    central.writeUInt16LE(20, 6);          // needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // extra/comment/disk/attrs all zero
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBuf, payload);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

/** Parse a zip buffer into [{ name, data }] with CRC verification. */
function unzipSync(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('zip: too small');
  // Find end-of-central-directory record (scan backwards over the comment).
  let eocd = -1;
  const scanStart = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= scanStart; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: end record not found');
  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error('zip: bad central header');
    const method = buffer.readUInt16LE(pos + 10);
    const crc = buffer.readUInt32LE(pos + 16);
    const compSize = buffer.readUInt32LE(pos + 20);
    const uncompSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + commentLen;

    assertSafeEntryName(name);
    if (name.endsWith('/')) continue; // directory entry

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('zip: bad local header');
    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`zip: unsupported method ${method} for ${name}`);

    if (data.length !== uncompSize) throw new Error(`zip: size mismatch for ${name}`);
    if (crc32(data) !== crc) throw new Error(`zip: CRC mismatch for ${name}`);
    entries.push({ name, data });
  }
  return entries;
}

/** Extract a zip buffer under destDir; every path is traversal-checked. */
function extractZipSync(buffer, destDir) {
  const resolvedDest = path.resolve(destDir);
  const written = [];
  for (const { name, data } of unzipSync(buffer)) {
    const target = path.resolve(resolvedDest, name);
    if (target !== resolvedDest && !target.startsWith(resolvedDest + path.sep)) {
      throw new Error(`zip: entry escapes destination: ${name}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    written.push(target);
  }
  return written;
}

/** Zip a directory tree (relative names, sorted for determinism). */
function zipDirSync(dir, { filter = () => true, prefix = '' } = {}) {
  const entries = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (!filter(childRel, entry)) continue;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) {
        entries.push({ name: prefix + childRel, data: fs.readFileSync(path.join(dir, childRel)) });
      }
    }
  };
  walk('');
  return zipSync(entries);
}

module.exports = { crc32, zipSync, unzipSync, extractZipSync, zipDirSync, assertSafeEntryName };
