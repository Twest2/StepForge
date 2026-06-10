'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function newId(prefix) {
  const uuid = crypto.randomUUID();
  return prefix ? `${prefix}-${uuid}` : uuid;
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Crash-safe write: write to a temp file in the same directory, then rename
 * over the target so readers never observe a half-written file.
 */
function atomicWriteFileSync(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function writeJsonSync(file, obj) {
  atomicWriteFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function readJsonSync(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonIfExists(file, fallback) {
  try {
    return readJsonSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+|#39);/g, (m, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X'
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : m;
  });
}

/** Convert an HTML fragment to plain text (for search indexing and exports). */
function htmlToText(html) {
  if (!html) return '';
  let text = String(html)
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
    .replace(/<li[\s>]/gi, '• <')
    .replace(/<[^>]*>/g, '');
  text = decodeEntities(text);
  return text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeXml(text) {
  return escapeHtml(text).replace(/'/g, '&apos;');
}

function deepClone(obj) {
  return obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/** Filesystem-safe slug for export folder names like steps-<title>. */
function slugify(text, fallback = 'untitled') {
  const slug = String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._ -]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return slug || fallback;
}

module.exports = {
  newId,
  nowIso,
  atomicWriteFileSync,
  writeJsonSync,
  readJsonSync,
  readJsonIfExists,
  htmlToText,
  decodeEntities,
  escapeHtml,
  escapeXml,
  deepClone,
  clamp,
  slugify,
};
