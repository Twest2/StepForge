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
  const json = JSON.stringify(obj, null, 2);
  if (json === undefined) throw new TypeError(`writeJsonSync: value for ${file} is not JSON-serializable`);
  atomicWriteFileSync(file, json + '\n');
}

function readJsonSync(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonIfExists(file, fallback) {
  try {
    return readJsonSync(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return fallback;
    throw err;
  }
}

// Named HTML entities beyond the XML five, as code points.
const NAMED_ENTITIES = {
  nbsp: 160, iexcl: 161, cent: 162, pound: 163, euro: 8364, yen: 165, copy: 169, reg: 174, trade: 8482,
  deg: 176, plusmn: 177, times: 215, divide: 247, micro: 181, para: 182, middot: 183, sect: 167,
  laquo: 171, raquo: 187, lsquo: 8216, rsquo: 8217, ldquo: 8220, rdquo: 8221, sbquo: 8218, bdquo: 8222,
  ndash: 8211, mdash: 8212, hellip: 8230, bull: 8226, prime: 8242, larr: 8592, rarr: 8594, uarr: 8593,
  darr: 8595, harr: 8596, check: 10003, ensp: 8194, emsp: 8195, thinsp: 8201, zwj: 8205, zwnj: 8204,
  agrave: 224, aacute: 225, acirc: 226, atilde: 227, auml: 228, aring: 229, aelig: 230, ccedil: 231,
  egrave: 232, eacute: 233, ecirc: 234, euml: 235, igrave: 236, iacute: 237, icirc: 238, iuml: 239,
  ntilde: 241, ograve: 242, oacute: 243, ocirc: 244, otilde: 245, ouml: 246, oslash: 248, ugrave: 249,
  uacute: 250, ucirc: 251, uuml: 252, yacute: 253, yuml: 255, szlig: 223,
  Agrave: 192, Aacute: 193, Acirc: 194, Atilde: 195, Auml: 196, Aring: 197, AElig: 198, Ccedil: 199,
  Egrave: 200, Eacute: 201, Ecirc: 202, Euml: 203, Igrave: 204, Iacute: 205, Icirc: 206, Iuml: 207,
  Ntilde: 209, Ograve: 210, Oacute: 211, Ocirc: 212, Otilde: 213, Ouml: 214, Oslash: 216, Ugrave: 217,
  Uacute: 218, Ucirc: 219, Uuml: 220, Yacute: 221,
};

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
  ...Object.fromEntries(Object.entries(NAMED_ENTITIES).filter(([k]) => k !== 'nbsp').map(([k, v]) => [k, String.fromCodePoint(v)])),
};

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

// Matches literal markdown-style links typed in the description editor,
// e.g. "[Settings](https://example.com)". Excludes < > so it never spans
// across an existing HTML tag boundary.
const MD_LINK_RE = /\[([^[\]<>]*)\]\(([^()<>]+)\)/g;

/**
 * Turn literal "[text](url)" markdown link syntax (as inserted by the
 * description editor's Link button) into real <a href> tags, so exporters
 * that consume HTML render an actual link instead of the raw brackets.
 */
function linkifyMarkdownLinks(html) {
  return String(html || '').replace(MD_LINK_RE, (m, label, href) => `<a href="${escapeHtml(href)}">${label}</a>`);
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
  NAMED_ENTITIES,
  linkifyMarkdownLinks,
  decodeEntities,
  escapeHtml,
  escapeXml,
  deepClone,
  clamp,
  slugify,
};
