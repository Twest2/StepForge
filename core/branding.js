'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { newId, nowIso, writeJsonSync, readJsonIfExists, atomicWriteFileSync } = require('./util');
const { zipSync, unzipSync } = require('./zip');
const { decodePng } = require('./png');
const { sanitizeSvg, svgSize } = require('./svg-sanitize');

/**
 * Brand profiles: a company's logo, banner, colors, fonts, header/footer
 * text, cover style, watermark and HTML CSS, applied to every export.
 * Stored under settings/branding/:
 *   profiles/<id>.json       one profile each
 *   assets/<hash>.<ext>      uploaded images and fonts, named by content
 *   assets/<hash>.json       what an asset is (type, size, font family)
 *   assets/<hash>.raster.png a PNG copy of an image, for exports that can't
 *                            use SVG or JPEG (PDF, Word, PowerPoint, GIF…)
 * Settings → Branding picks the active profile (settings.branding).
 * Profiles are shared as .sfbrand files.
 */

const COVER_STYLES = ['standard', 'band', 'centered'];
const WATERMARK_POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
const COLOR_SCHEMES = ['light', 'auto'];
const DEFAULT_COLORS = { primary: '#2563EB', accent: '#0EA5E9', text: '#18212B' };

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FONT_BYTES = 10 * 1024 * 1024;
const MAX_CSS_CHARS = 200000;
const MAX_RASTER_DIM = 4096;
// PNGs up to this size are their own raster; anything else is drawn to a PNG
// by the renderer (it can decode SVG and JPEG) and handed back.
const SELF_RASTER_DIM = 2400;

const ASSET_ID = /^[a-f0-9]{32}$/;
// Unreferenced assets this new are kept: they may belong to a profile still being edited.
const ASSET_GRACE_MS = 24 * 60 * 60 * 1000;

const IMAGE_TYPES = {
  png: { mime: 'image/png', ext: 'png' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  svg: { mime: 'image/svg+xml', ext: 'svg' },
};
const FONT_TYPES = {
  woff2: { mime: 'font/woff2', ext: 'woff2', format: 'woff2' },
  woff: { mime: 'font/woff', ext: 'woff', format: 'woff' },
  ttf: { mime: 'font/ttf', ext: 'ttf', format: 'truetype' },
  otf: { mime: 'font/otf', ext: 'otf', format: 'opentype' },
};

// Offered in the font boxes; any installed font name can be typed instead.
const FONT_SUGGESTIONS = [
  'Arial', 'Calibri', 'Cambria', 'Candara', 'Century Gothic', 'Consolas', 'Constantia', 'Corbel', 'Franklin Gothic',
  'Garamond', 'Georgia', 'Helvetica', 'Inter', 'Lato', 'Montserrat', 'Noto Sans', 'Noto Serif', 'Open Sans',
  'Palatino Linotype', 'Roboto', 'Segoe UI', 'Source Sans 3', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
];

// The largest file of each kind, and what StepForge says about one that's bigger.
// CSS is limited by characters; a UTF-8 file under 4 bytes a character can't fit.
const MAX_FILE_BYTES = { image: MAX_IMAGE_BYTES, font: MAX_FONT_BYTES, css: MAX_CSS_CHARS * 4 };
const TOO_LARGE = {
  image: 'This image is larger than 10 MB. Choose a smaller one.',
  font: 'This font file is larger than 10 MB. Choose a smaller one, such as its WOFF2 version.',
  css: 'This CSS file is longer than 200,000 characters, the most a profile can hold. Shorten it and load it again.',
};

/** Refuse a file that's too large for its kind (image, font or css) before it's read. */
function checkFileSize(kind, bytes) {
  if (bytes > MAX_FILE_BYTES[kind]) throw new Error(TOO_LARGE[kind]);
}

/** The text of a loaded .css file; one over the limit is refused, never cut short. */
function cssFromFile(data) {
  const css = data.toString('utf8').replace(/^\uFEFF/, '');
  if (css.length > MAX_CSS_CHARS) throw new Error(TOO_LARGE.css);
  return css;
}

function oneOf(value, values, fallback) {
  return values.includes(value) ? value : fallback;
}

function normalizeColor(value, fallback) {
  const v = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v.slice(1).split('').map((c) => c + c).join('')}`.toUpperCase();
  return fallback;
}

/** One line of plain text: no control characters, trimmed, bounded. */
function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A font family name safe to put in CSS, XML and PDF: letters, digits, spaces, . _ - ' only. */
function cleanFontName(value) {
  return String(value ?? '').replace(/[^\p{L}\p{N} ._'-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function assetRef(value) {
  return typeof value === 'string' && ASSET_ID.test(value) ? value : null;
}

/** A complete, valid profile from whatever was stored or sent. */
function normalizeProfile(raw = {}, { id = raw.id, createdAt = raw.createdAt, updatedAt = raw.updatedAt } = {}) {
  const fonts = raw.fonts || {};
  const font = (f) => ({ name: cleanFontName(f?.name), asset: assetRef(f?.asset) });
  const opacity = Number(raw.watermark?.opacity);
  return {
    schemaVersion: 1,
    id,
    name: cleanText(raw.name, 80) || 'Untitled brand',
    createdAt: createdAt || nowIso(),
    updatedAt: updatedAt || nowIso(),
    colors: {
      primary: normalizeColor(raw.colors?.primary, DEFAULT_COLORS.primary),
      accent: normalizeColor(raw.colors?.accent, DEFAULT_COLORS.accent),
      text: normalizeColor(raw.colors?.text, DEFAULT_COLORS.text),
    },
    fonts: { heading: font(fonts.heading), body: font(fonts.body) },
    logo: assetRef(raw.logo),
    banner: assetRef(raw.banner),
    header: { text: cleanText(raw.header?.text, 160), logo: raw.header?.logo !== false },
    footer: { text: cleanText(raw.footer?.text, 200), pageNumbers: raw.footer?.pageNumbers !== false },
    cover: oneOf(raw.cover, COVER_STYLES, 'standard'),
    html: {
      css: String(raw.html?.css ?? '').replace(/\r\n?/g, '\n').slice(0, MAX_CSS_CHARS),
      colorScheme: oneOf(raw.html?.colorScheme, COLOR_SCHEMES, 'light'),
    },
    watermark: {
      enabled: raw.watermark?.enabled === true,
      position: oneOf(raw.watermark?.position, WATERMARK_POSITIONS, 'bottom-right'),
      opacity: Number.isFinite(opacity) ? Math.round(Math.max(0.05, Math.min(1, opacity)) * 100) / 100 : 0.6,
    },
  };
}

function profileAssetIds(profile) {
  return [profile.logo, profile.banner, profile.fonts?.heading?.asset, profile.fonts?.body?.asset].filter(Boolean);
}

// ---- file sniffing -----------------------------------------------------------

function imageType(bytes) {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) return 'png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  const head = bytes.subarray(0, 4096).toString('utf8');
  if (/<svg[\s>]/i.test(head) && !/^\s*<(!doctype\s+)?html/i.test(head)) return 'svg';
  return null;
}

function fontType(bytes) {
  if (bytes.length < 12) return null;
  const tag = bytes.toString('latin1', 0, 4);
  if (tag === 'wOF2') return 'woff2';
  if (tag === 'wOFF') return 'woff';
  if (tag === 'OTTO') return 'otf';
  if (bytes.readUInt32BE(0) === 0x00010000 || tag === 'true') return 'ttf';
  return null;
}

function pngSize(bytes) {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegSize(bytes) {
  let pos = 2;
  while (pos + 9 < bytes.length) {
    if (bytes[pos] !== 0xff) { pos += 1; continue; }
    const marker = bytes[pos + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { pos += marker === 0xff ? 1 : 2; continue; }
    const len = bytes.readUInt16BE(pos + 2);
    // Start-of-frame markers carry the size (not DHT c4, JPG c8 or DAC cc).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: bytes.readUInt16BE(pos + 7), height: bytes.readUInt16BE(pos + 5) };
    }
    pos += 2 + len;
  }
  return { width: 0, height: 0 };
}

/** The family name in a font's `name` table (typographic family first). */
function nameTableFamily(table) {
  const count = table.readUInt16BE(2);
  const strings = table.readUInt16BE(4);
  const found = {};
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (r + 12 > table.length) break;
    const platform = table.readUInt16BE(r);
    const encoding = table.readUInt16BE(r + 2);
    const language = table.readUInt16BE(r + 4);
    const nameId = table.readUInt16BE(r + 6);
    const length = table.readUInt16BE(r + 8);
    const offset = table.readUInt16BE(r + 10);
    if (nameId !== 1 && nameId !== 16) continue;
    const raw = table.subarray(strings + offset, strings + offset + length);
    let text = '';
    if ((platform === 0 || platform === 3) && raw.length % 2 === 0) text = Buffer.from(raw).swap16().toString('utf16le');
    else if (platform === 1 && encoding === 0) text = raw.toString('latin1');
    if (text && (!found[nameId] || (platform === 3 && language === 0x409))) found[nameId] = text;
  }
  return found[16] || found[1] || '';
}

/** A font file's family name, or '' (WOFF2 tables are Brotli-packed; the file name is used instead). */
function fontFamilyName(bytes) {
  try {
    const type = fontType(bytes);
    if (type === 'ttf' || type === 'otf') {
      const tables = bytes.readUInt16BE(4);
      for (let i = 0; i < tables; i++) {
        const rec = 12 + i * 16;
        if (bytes.toString('latin1', rec, rec + 4) !== 'name') continue;
        const offset = bytes.readUInt32BE(rec + 8);
        return cleanFontName(nameTableFamily(bytes.subarray(offset, offset + bytes.readUInt32BE(rec + 12))));
      }
    } else if (type === 'woff') {
      const tables = bytes.readUInt16BE(12);
      for (let i = 0; i < tables; i++) {
        const rec = 44 + i * 20;
        if (bytes.toString('latin1', rec, rec + 4) !== 'name') continue;
        const offset = bytes.readUInt32BE(rec + 4);
        const packed = bytes.readUInt32BE(rec + 8);
        const length = bytes.readUInt32BE(rec + 12);
        let table = bytes.subarray(offset, offset + packed);
        if (packed < length) table = zlib.inflateSync(table, { maxOutputLength: 1024 * 1024 });
        return cleanFontName(nameTableFamily(table));
      }
    }
  } catch {
    // A damaged table just means no name; the file name is used.
  }
  return '';
}

/** "AcmeSans-Bold.woff2" -> "AcmeSans". */
function familyFromFileName(fileName) {
  const base = path.basename(String(fileName || '')).replace(/\.[^.]+$/, '');
  return cleanFontName(base.split(/[-_]/)[0] || base) || 'Brand font';
}

// ---- store ---------------------------------------------------------------------

class BrandingStore {
  constructor(settingsDir) {
    this.dir = path.join(settingsDir, 'branding');
    this.profilesDir = path.join(this.dir, 'profiles');
    this.assetsDir = path.join(this.dir, 'assets');
  }

  profileFile(id) {
    if (typeof id !== 'string' || !/^brand-[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error('Unknown brand profile.');
    return path.join(this.profilesDir, `${id}.json`);
  }

  /** Every profile, by name: { id, name, updatedAt }. */
  list() {
    if (!fs.existsSync(this.profilesDir)) return [];
    return fs.readdirSync(this.profilesDir)
      .filter((f) => /^brand-[A-Za-z0-9-]+\.json$/.test(f))
      .map((f) => this.get(f.slice(0, -5)))
      .filter(Boolean)
      .map(({ id, name, updatedAt }) => ({ id, name, updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id));
  }

  get(id) {
    let file;
    try { file = this.profileFile(id); } catch { return null; }
    const raw = readJsonIfExists(file, null);
    return raw && typeof raw === 'object' ? normalizeProfile(raw, { id }) : null;
  }

  /** Create (no id, or an unknown one) or update a profile. Asset references that don't exist are dropped. */
  save(raw) {
    const existing = raw?.id ? this.get(raw.id) : null;
    const id = existing ? existing.id : newId('brand');
    const profile = normalizeProfile(raw, { id, createdAt: existing?.createdAt || nowIso(), updatedAt: nowIso() });
    const exists = (asset) => (asset && this.assetMeta(asset) ? asset : null);
    profile.logo = exists(profile.logo);
    profile.banner = exists(profile.banner);
    profile.fonts.heading.asset = exists(profile.fonts.heading.asset);
    profile.fonts.body.asset = exists(profile.fonts.body.asset);
    writeJsonSync(this.profileFile(id), profile);
    this.collectGarbage();
    return profile;
  }

  remove(id) {
    fs.rmSync(this.profileFile(id), { force: true });
    this.collectGarbage();
  }

  duplicate(id) {
    const source = this.get(id);
    if (!source) throw new Error('That brand profile no longer exists.');
    const { id: _id, createdAt, updatedAt, ...rest } = source;
    return this.save({ ...rest, name: `${source.name} copy`.slice(0, 80) });
  }

  // ---- assets ------------------------------------------------------------------

  assetFile(meta) {
    return path.join(this.assetsDir, `${meta.id}.${meta.ext}`);
  }

  rasterFile(meta) {
    return path.join(this.assetsDir, `${meta.id}.raster.png`);
  }

  assetMeta(id) {
    if (!assetRef(id)) return null;
    const meta = readJsonIfExists(path.join(this.assetsDir, `${id}.json`), null);
    if (!meta || meta.id !== id || !fs.existsSync(this.assetFile(meta))) return null;
    return meta;
  }

  /**
   * Store an uploaded image or font. Images are PNG, JPG or SVG (sanitized);
   * fonts WOFF2, WOFF, TTF or OTF. Returns the asset's description;
   * `needsRaster` means the renderer should draw it to a PNG (setRaster).
   */
  addAsset(bytes, { kind, fileName = '' }) {
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('That file is empty.');
    let data = bytes;
    let meta;
    if (kind === 'image') {
      checkFileSize('image', bytes.length);
      const type = imageType(bytes);
      if (!type) throw new Error('Choose a PNG, JPG or SVG image.');
      let size;
      if (type === 'svg') {
        data = Buffer.from(sanitizeSvg(bytes), 'utf8');
        size = svgSize(data.toString('utf8'));
      } else {
        size = type === 'png' ? pngSize(bytes) : jpegSize(bytes);
      }
      if (!(size.width > 0 && size.height > 0) && type !== 'svg') throw new Error('StepForge couldn’t read the size of that image.');
      meta = { kind, ...IMAGE_TYPES[type], width: size.width || 0, height: size.height || 0 };
    } else if (kind === 'font') {
      checkFileSize('font', bytes.length);
      const type = fontType(bytes);
      if (!type) throw new Error('Choose a WOFF2, WOFF, TTF or OTF font file.');
      meta = { kind, ...FONT_TYPES[type], family: fontFamilyName(bytes) || familyFromFileName(fileName) };
    } else {
      throw new Error('Unknown asset kind.');
    }
    const id = crypto.createHash('sha256').update(data).digest('hex').slice(0, 32);
    meta = { id, ...meta, name: cleanText(path.basename(String(fileName)), 160), addedAt: nowIso() };
    fs.mkdirSync(this.assetsDir, { recursive: true });
    const file = this.assetFile(meta);
    if (!fs.existsSync(file)) atomicWriteFileSync(file, data);
    const known = this.assetMeta(id);
    if (known?.raster) meta.raster = known.raster;
    else if (meta.mime === 'image/png') {
      // A PNG StepForge can decode at a sensible size is used as it is.
      try {
        const img = decodePng(data);
        if (img.width <= SELF_RASTER_DIM && img.height <= SELF_RASTER_DIM) {
          atomicWriteFileSync(this.rasterFile(meta), data);
          meta.raster = { width: img.width, height: img.height };
        }
      } catch { /* the renderer draws it instead */ }
    }
    writeJsonSync(path.join(this.assetsDir, `${id}.json`), meta);
    // Touch it so garbage collection gives a new upload its grace period.
    const now = new Date();
    fs.utimesSync(file, now, now);
    return this.describe(meta);
  }

  /** The renderer's PNG drawing of an image asset (for SVG, JPG, and PNGs StepForge can't decode). */
  setRaster(id, png) {
    const meta = this.assetMeta(id);
    if (!meta || meta.kind !== 'image') throw new Error('Unknown image.');
    let img;
    try { img = decodePng(png); } catch { throw new Error('The image couldn’t be converted to PNG.'); }
    if (img.width > MAX_RASTER_DIM || img.height > MAX_RASTER_DIM) throw new Error('The converted image is too large.');
    atomicWriteFileSync(this.rasterFile(meta), png);
    meta.raster = { width: img.width, height: img.height };
    if (!meta.width || !meta.height) { meta.width = img.width; meta.height = img.height; }
    writeJsonSync(path.join(this.assetsDir, `${id}.json`), meta);
    return this.describe(meta);
  }

  /** What the renderer shows for an asset; images include a data: URL to draw or preview. */
  describe(metaOrId) {
    const meta = typeof metaOrId === 'string' ? this.assetMeta(metaOrId) : metaOrId;
    if (!meta) return null;
    const out = { id: meta.id, kind: meta.kind, mime: meta.mime, name: meta.name, width: meta.width, height: meta.height };
    if (meta.kind === 'font') return { ...out, family: meta.family, format: meta.format };
    const data = fs.readFileSync(this.assetFile(meta));
    return { ...out, needsRaster: !meta.raster, dataUrl: `data:${meta.mime};base64,${data.toString('base64')}` };
  }

  /** Delete assets no profile uses, except recent uploads (a profile may still be being edited). */
  collectGarbage({ now = Date.now() } = {}) {
    if (!fs.existsSync(this.assetsDir)) return;
    const used = new Set();
    for (const { id } of this.list()) for (const asset of profileAssetIds(this.get(id))) used.add(asset);
    // An asset is its file, description and raster; it's as new as the newest of them.
    const unused = new Map(); // id -> { files, newest }
    for (const f of fs.readdirSync(this.assetsDir)) {
      const id = f.slice(0, 32);
      if (!ASSET_ID.test(id) || used.has(id)) continue;
      const file = path.join(this.assetsDir, f);
      let mtime;
      try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
      const entry = unused.get(id) || { files: [], newest: 0 };
      entry.files.push(file);
      entry.newest = Math.max(entry.newest, mtime);
      unused.set(id, entry);
    }
    for (const { files, newest } of unused.values()) {
      if (now - newest > ASSET_GRACE_MS) for (const file of files) fs.rmSync(file, { force: true });
    }
  }

  /**
   * What the export worker needs for a profile: the profile and the files
   * of its assets. Plain JSON, so it can go to the worker process.
   */
  resolve(id) {
    const profile = id ? this.get(id) : null;
    return profile ? this.resolveProfile(profile) : null;
  }

  /** Like resolve(), for a profile being edited and not saved yet (Preview in the editor). */
  resolveDraft(raw) {
    return this.resolveProfile(normalizeProfile(raw, { id: raw?.id || 'brand-draft' }));
  }

  resolveProfile(profile) {
    const image = (asset) => {
      const meta = this.assetMeta(asset);
      if (!meta || meta.kind !== 'image') return null;
      return {
        mime: meta.mime, width: meta.width, height: meta.height, file: this.assetFile(meta),
        raster: meta.raster && fs.existsSync(this.rasterFile(meta)) ? { file: this.rasterFile(meta), ...meta.raster } : null,
      };
    };
    const font = (role) => {
      const meta = this.assetMeta(profile.fonts[role].asset);
      return meta && meta.kind === 'font' ? { file: this.assetFile(meta), mime: meta.mime, format: meta.format, family: meta.family } : null;
    };
    return { profile, logo: image(profile.logo), banner: image(profile.banner), fonts: { heading: font('heading'), body: font('body') } };
  }

  // ---- sharing -----------------------------------------------------------------

  /** Write a profile and its assets as a .sfbrand file. */
  exportProfile(id, destFile) {
    const profile = this.get(id);
    if (!profile) throw new Error('That brand profile no longer exists.');
    const entries = [
      { name: 'manifest.json', data: JSON.stringify({ format: 'stepforge-brand-profile', formatVersion: 1, name: profile.name, exportedAt: nowIso() }, null, 2) },
      { name: 'profile.json', data: JSON.stringify(profile, null, 2) },
    ];
    for (const asset of new Set(profileAssetIds(profile))) {
      const meta = this.assetMeta(asset);
      if (!meta) continue;
      entries.push({ name: `assets/${meta.id}.json`, data: JSON.stringify(meta, null, 2) });
      entries.push({ name: `assets/${meta.id}.${meta.ext}`, data: fs.readFileSync(this.assetFile(meta)) });
      if (meta.raster && fs.existsSync(this.rasterFile(meta))) {
        entries.push({ name: `assets/${meta.id}.raster.png`, data: fs.readFileSync(this.rasterFile(meta)) });
      }
    }
    atomicWriteFileSync(destFile, zipSync(entries));
    return destFile;
  }

  /** Add the profile in a .sfbrand file. Every asset is checked again as if uploaded. Returns the new profile. */
  importProfile(file) {
    const entries = new Map(unzipSync(fs.readFileSync(file), {
      limits: { maxEntries: 64, maxTotalUncompressed: 96 * 1024 * 1024, maxEntryUncompressed: 16 * 1024 * 1024 },
    }).map((e) => [e.name, e.data]));
    const json = (name) => {
      try { return JSON.parse(entries.get(name).toString('utf8')); } catch { return null; }
    };
    const manifest = entries.has('manifest.json') ? json('manifest.json') : null;
    if (manifest?.format !== 'stepforge-brand-profile') throw new Error('This isn’t a StepForge brand profile.');
    if (manifest.formatVersion > 1) throw new Error('This brand profile was made by a newer StepForge. Update StepForge to import it.');
    const raw = json('profile.json');
    if (!raw || typeof raw !== 'object') throw new Error('This brand profile is damaged.');
    const mapped = new Map();
    const extensions = [...Object.values(IMAGE_TYPES), ...Object.values(FONT_TYPES)].map((t) => t.ext);
    for (const asset of new Set(profileAssetIds(normalizeProfile(raw)))) {
      const meta = json(`assets/${asset}.json`);
      const data = meta && extensions.includes(meta.ext) ? entries.get(`assets/${asset}.${meta.ext}`) : null;
      if (!data) continue;
      const added = this.addAsset(data, { kind: meta.kind === 'font' ? 'font' : 'image', fileName: meta.name });
      const raster = entries.get(`assets/${asset}.raster.png`);
      if (added.kind === 'image' && added.needsRaster && raster) {
        try { this.setRaster(added.id, raster); } catch { /* drawn again the next time the profile is opened */ }
      }
      mapped.set(asset, added.id);
    }
    const remap = (asset) => (asset ? mapped.get(asset) || null : null);
    const names = new Set(this.list().map((p) => p.name));
    let name = cleanText(raw.name, 80) || 'Imported brand';
    if (names.has(name)) name = `${name} (imported)`.slice(0, 80);
    return this.save({
      ...raw,
      id: undefined,
      name,
      logo: remap(raw.logo),
      banner: remap(raw.banner),
      fonts: {
        heading: { ...raw.fonts?.heading, asset: remap(raw.fonts?.heading?.asset) },
        body: { ...raw.fonts?.body, asset: remap(raw.fonts?.body?.asset) },
      },
    });
  }
}

// ---- export side -------------------------------------------------------------

/**
 * Read a resolved profile's files for exporting (in the export worker). The
 * result is `ast.branding`: colors, fonts (with font file bytes), the logo
 * and banner (original bytes plus a PNG raster when there is one), and the
 * rest of the profile.
 */
function loadBranding(resolved) {
  if (!resolved || !resolved.profile) return null;
  const read = (file) => {
    try { return fs.readFileSync(file); } catch { return null; }
  };
  const image = (asset) => {
    if (!asset) return null;
    const data = read(asset.file);
    if (!data) return null;
    const png = asset.raster ? read(asset.raster.file) : null;
    return {
      mime: asset.mime,
      data,
      png,
      width: asset.raster?.width || asset.width,
      height: asset.raster?.height || asset.height,
    };
  };
  const font = (role) => {
    const asset = resolved.fonts?.[role];
    const data = asset ? read(asset.file) : null;
    const name = resolved.profile.fonts[role].name || (data ? asset.family : '');
    return { name, file: data ? { data, mime: asset.mime, format: asset.format, family: asset.family } : null };
  };
  const p = normalizeProfile(resolved.profile);
  return {
    id: p.id,
    name: p.name,
    colors: p.colors,
    fonts: { heading: font('heading'), body: font('body') },
    logo: image(resolved.logo),
    banner: image(resolved.banner),
    header: p.header,
    footer: p.footer,
    cover: p.cover,
    html: p.html,
    watermark: p.watermark,
  };
}

function hexToRgb(hex) {
  const n = Number.parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Export options a profile sets, merged over each exporter's defaults (and
 * under anything chosen in the Export dialog or a saved template). The
 * Export dialog shows these as the defaults.
 */
function brandTemplateDefaults(format, profile) {
  const primary = profile?.colors?.primary;
  if (!primary) return {};
  switch (format) {
    case 'html-simple':
    case 'html-rich':
    case 'gif':
    case 'image-bundle':
      return { accentColor: primary };
    case 'pdf':
      return { accentColor: hexToRgb(primary) };
    default:
      return {};
  }
}

module.exports = {
  BrandingStore,
  normalizeProfile,
  loadBranding,
  brandTemplateDefaults,
  checkFileSize,
  cssFromFile,
  fontFamilyName,
  familyFromFileName,
  cleanFontName,
  hexToRgb,
  COVER_STYLES,
  WATERMARK_POSITIONS,
  COLOR_SCHEMES,
  DEFAULT_COLORS,
  FONT_SUGGESTIONS,
  MAX_CSS_CHARS,
};
