'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { DEFAULT_SETTINGS } = require('./settings');
const { normalizeProfile, profileAssetIds } = require('./branding');
const { contentHash } = require('./cloud-parts');

/*
 * Settings that follow you to every computer that syncs: global
 * placeholders, brand profiles (with their logos, banners and fonts), the
 * active brand profile, and the interface language. The rest of Settings
 * describes one computer (capture, hotkeys, storage, AI) and stays on it.
 *
 * Cloud sync (core/cloud-sync.js) keeps them as one archive:
 *   placeholders.json                global placeholders, by name
 *   settings.json                    language and activeProfileId, each only
 *                                    when it isn't the default, so a new
 *                                    computer's defaults never win a merge
 *   branding/profiles/<id>.json      one brand profile each
 *   branding/assets/<id>.json        an asset's kind, extension and file name
 *   branding/assets/<id>.<ext>       the image or font
 *   branding/assets/<id>.raster.png  its PNG drawing, when it has one
 * Only assets a profile uses are included.
 *
 * Merging works like guides (core/guide-merge.js): each placeholder, setting
 * and profile is compared with the version every side started from. Changes
 * to different ones combine; when sides changed the same one differently,
 * the newest wins, and an edit beats a deletion. Without a base nothing is
 * treated as deleted.
 */

const SHARED_KEYS = { language: 'language', activeProfileId: 'branding.activeProfileId' };
const DEFAULTS = { language: DEFAULT_SETTINGS.language, activeProfileId: DEFAULT_SETTINGS.branding.activeProfileId };

const PLACEHOLDER_NAME = /^[A-Za-z0-9_ .-]{1,200}$/;
const LANGUAGE = /^(system|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3})$/;
const PROFILE_ID = /^brand-[A-Za-z0-9-]{1,64}$/;
const ASSET_ID = /^[a-f0-9]{32}$/;
const ASSET_EXTS = { image: ['png', 'jpg', 'svg'], font: ['woff2', 'woff', 'ttf', 'otf'] };

const PROFILE_ENTRY = /^branding\/profiles\/([^/]+)\.json$/;
const ASSET_ENTRY = /^branding\/assets\/([a-f0-9]{32})(\.raster\.png|\.[a-z0-9]+)$/;

// A downloaded archive is checked like any other: no more than a few
// hundred profiles' worth of files.
const UNZIP_LIMITS = { maxEntries: 5000, maxTotalUncompressed: 1024 * 1024 * 1024, maxEntryUncompressed: 128 * 1024 * 1024 };

const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const same = (a, b) => isDeepStrictEqual(a, b);
const sortedObject = (obj) => Object.fromEntries(Object.keys(obj).sort(compareText).map((key) => [key, obj[key]]));
const textOf = (entry) => (Buffer.isBuffer(entry.data) ? entry.data.toString('utf8') : String(entry.data));

function emptyModel() {
  return { placeholders: {}, settings: {}, profiles: {}, assets: {} };
}

/** A placeholder value as StepForge stores it, or undefined for anything else. */
function cleanPlaceholder(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.text === 'string') {
    return value.format === undefined ? { text: value.text } : { format: String(value.format), text: value.text };
  }
  return undefined;
}

function cleanPlaceholders(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw)) {
    const clean = cleanPlaceholder(value);
    if (PLACEHOLDER_NAME.test(name) && clean !== undefined) out[name] = clean;
  }
  return out;
}

/** The shared settings that aren't the default. */
function cleanSettings(raw) {
  const out = {};
  if (typeof raw?.language === 'string' && LANGUAGE.test(raw.language) && raw.language !== DEFAULTS.language) out.language = raw.language;
  if (typeof raw?.activeProfileId === 'string' && PROFILE_ID.test(raw.activeProfileId)) out.activeProfileId = raw.activeProfileId;
  return out;
}

/** Archive entries for a model. The same model always gives the same bytes. */
function toEntries(model) {
  const json = (value) => JSON.stringify(value, null, 2);
  const entries = [
    { name: 'placeholders.json', data: json(sortedObject(model.placeholders)) },
    { name: 'settings.json', data: json(sortedObject(model.settings)) },
  ];
  const used = new Set();
  for (const id of Object.keys(model.profiles).sort(compareText)) {
    entries.push({ name: `branding/profiles/${id}.json`, data: json(model.profiles[id]) });
    profileAssetIds(model.profiles[id]).forEach((asset) => used.add(asset));
  }
  for (const id of [...used].sort(compareText)) {
    const asset = model.assets[id];
    if (!asset?.data) continue;
    entries.push({ name: `branding/assets/${id}.json`, data: json({ id, kind: asset.kind, ext: asset.ext, name: asset.name }) });
    entries.push({ name: `branding/assets/${id}.${asset.ext}`, data: asset.data });
    if (asset.raster) entries.push({ name: `branding/assets/${id}.raster.png`, data: asset.raster });
  }
  return entries;
}

/**
 * Read an archive's entries into a model. Asset bytes may be missing (a
 * remembered merge base keeps only hashes). Anything unknown means a newer
 * StepForge wrote it, and merging without it would lose it.
 */
function fromEntries(entries) {
  const damaged = () => new Error('Synced settings are damaged and can’t be read.');
  const model = emptyModel();
  const parse = (entry) => {
    try { return JSON.parse(textOf(entry)); } catch { throw damaged(); }
  };
  const files = new Map();
  for (const entry of entries) {
    if (entry.name === 'manifest.json') continue;
    if (entry.name === 'placeholders.json') model.placeholders = cleanPlaceholders(parse(entry));
    else if (entry.name === 'settings.json') model.settings = cleanSettings(parse(entry));
    else if (PROFILE_ENTRY.test(entry.name)) {
      const id = PROFILE_ENTRY.exec(entry.name)[1];
      if (!PROFILE_ID.test(id)) throw damaged();
      const raw = parse(entry);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw damaged();
      model.profiles[id] = normalizeProfile(raw, { id });
    } else if (ASSET_ENTRY.test(entry.name)) files.set(entry.name, entry);
    else throw new Error('These settings were synced by a newer StepForge. Update StepForge on this computer.');
  }
  for (const [name, entry] of files) {
    const [, id, suffix] = ASSET_ENTRY.exec(name);
    if (suffix !== '.json') continue;
    const meta = parse(entry);
    if (meta?.id !== id || !ASSET_EXTS[meta.kind]?.includes(meta.ext)) throw damaged();
    const data = files.get(`branding/assets/${id}.${meta.ext}`);
    const raster = files.get(`branding/assets/${id}.raster.png`);
    if (!data) throw damaged();
    model.assets[id] = { kind: meta.kind, ext: meta.ext, name: typeof meta.name === 'string' ? meta.name.slice(0, 160) : '',
      data: data.data ?? null, raster: raster ? raster.data ?? null : null };
  }
  return model;
}

/**
 * Three-way merge of one kind of item (placeholders, settings, profiles).
 * `sides` run oldest to newest; `rank` orders two edits before side order.
 */
function mergeItems(base, sides, rank = () => '') {
  const out = {};
  let conflicts = 0;
  const keys = new Set([...Object.keys(base), ...sides.flatMap((side) => Object.keys(side))]);
  for (const key of [...keys].sort(compareText)) {
    const before = Object.hasOwn(base, key) ? base[key] : undefined;
    const changed = sides.map((side, order) => ({ value: Object.hasOwn(side, key) ? side[key] : undefined, order }))
      .filter(({ value }) => !same(value, before));
    let value = before;
    if (changed.length) {
      if (changed.some(({ value: v }) => !same(v, changed[0].value))) conflicts += 1;
      const edits = changed.filter(({ value: v }) => v !== undefined);
      value = edits.length
        ? edits.reduce((best, edit) => (compareText(rank(edit.value), rank(best.value)) >= 0 ? edit : best)).value
        : undefined;
    }
    if (value !== undefined) out[key] = value;
  }
  return { items: out, conflicts };
}

/**
 * Merge shared settings. `sides` are [{ entries, time, hash }], where `time`
 * is when that side last changed. The result depends only on the base and
 * the sides, never on which computer merges.
 */
function mergeSharedSettings({ base = null, sides }) {
  const before = base ? fromEntries(base) : emptyModel();
  const models = sides.map((side) => ({ model: fromEntries(side.entries), time: String(side.time || ''), hash: side.hash || '' }))
    .sort((a, b) => compareText(a.time, b.time) || compareText(a.hash, b.hash))
    .map(({ model }) => model);
  const placeholders = mergeItems(before.placeholders, models.map((m) => m.placeholders));
  const settings = mergeItems(before.settings, models.map((m) => m.settings));
  const profiles = mergeItems(before.profiles, models.map((m) => m.profiles), (profile) => profile.updatedAt || '');
  const merged = { placeholders: placeholders.items, settings: settings.items, profiles: profiles.items, assets: {} };
  // Assets are named by their content, so any side's copy will do; the
  // newest side's is used, with the newest PNG drawing any side has.
  for (const profile of Object.values(merged.profiles)) {
    for (const id of profileAssetIds(profile)) {
      const copies = models.map((m) => m.assets[id]).filter((asset) => asset?.data).reverse();
      if (copies.length) merged.assets[id] = { ...copies[0], raster: copies.find((asset) => asset.raster)?.raster || null };
    }
  }
  return { entries: toEntries(merged), conflicts: placeholders.conflicts + settings.conflicts + profiles.conflicts };
}

/** This computer's shared settings, read from and written to Settings and the branding store. */
class SharedSettings {
  constructor({ settings, branding }) {
    Object.assign(this, { settings, branding });
    this.cached = null;
  }

  /** The model of what's saved on this computer now. */
  read() {
    const model = emptyModel();
    model.placeholders = cleanPlaceholders(this.settings.getGlobalPlaceholders());
    model.settings = cleanSettings(Object.fromEntries(Object.entries(SHARED_KEYS).map(([key, keyPath]) => [key, this.settings.get(keyPath)])));
    for (const { id } of this.branding.list()) {
      const profile = this.branding.get(id);
      if (profile) model.profiles[id] = profile;
    }
    for (const profile of Object.values(model.profiles)) {
      for (const id of profileAssetIds(profile)) {
        const meta = this.branding.assetMeta(id);
        if (!meta || model.assets[id]) continue;
        let raster = null;
        if (meta.raster) { try { raster = fs.readFileSync(this.branding.rasterFile(meta)); } catch { /* drawn again later */ } }
        model.assets[id] = { kind: meta.kind, ext: meta.ext, name: meta.name || '', data: fs.readFileSync(this.branding.assetFile(meta)), raster };
      }
    }
    return model;
  }

  // Sizes and times of every file involved, so an unchanged state isn't
  // reread (fonts and logos can be large) on every sync.
  signature() {
    const stat = (file) => {
      try { const s = fs.statSync(file); return `${file}:${s.size}:${s.mtimeMs}:${s.ino}`; } catch { return `${file}:-`; }
    };
    const lines = [JSON.stringify(Object.values(SHARED_KEYS).map((keyPath) => this.settings.get(keyPath) ?? null)), stat(this.settings.globalPlaceholdersFile)];
    for (const dir of [this.branding.profilesDir, this.branding.assetsDir]) {
      let names = [];
      try { names = fs.readdirSync(dir).sort(compareText); } catch { /* none yet */ }
      for (const name of names) lines.push(stat(path.join(dir, name)));
    }
    return lines.join('\n');
  }

  /** When shared settings last changed here, for merges where both computers changed the same thing. */
  modifiedAt() {
    let newest = 0;
    const files = [this.settings.file, this.settings.globalPlaceholdersFile];
    try { files.push(...fs.readdirSync(this.branding.profilesDir).map((name) => path.join(this.branding.profilesDir, name))); } catch { /* none yet */ }
    for (const file of files) {
      try { newest = Math.max(newest, fs.statSync(file).mtimeMs); } catch { /* not saved yet */ }
    }
    return newest ? new Date(newest).toISOString() : '';
  }

  /** { hash, time, entries } of what's saved now; entries are read when asked for. */
  snapshot() {
    const key = this.signature();
    if (!this.cached || this.cached.key !== key) {
      this.cached = { key, hash: contentHash(toEntries(this.read())) };
    }
    const shared = this;
    return { hash: this.cached.hash, time: this.modifiedAt(), get entries() { return toEntries(shared.read()); } };
  }

  /**
   * Save synced settings on this computer. Every incoming image and font is
   * checked again as if uploaded. Returns what changed: any of
   * 'placeholders', 'branding', 'language'.
   */
  apply(entries) {
    const next = fromEntries(entries);
    const now = this.read();
    const changes = [];
    if (!same(next.placeholders, now.placeholders)) {
      this.settings.setGlobalPlaceholders(next.placeholders);
      changes.push('placeholders');
    }
    // An asset that comes out with another id (a sanitized SVG) is renamed in the profiles.
    const renamed = new Map();
    for (const [id, asset] of Object.entries(next.assets)) {
      if (this.branding.assetMeta(id)) {
        if (asset.raster && !this.branding.assetMeta(id).raster) {
          try { this.branding.setRaster(id, asset.raster); } catch { /* drawn again later */ }
        }
        continue;
      }
      try {
        const added = this.branding.addAsset(asset.data, { kind: asset.kind, fileName: asset.name });
        if (added.id !== id) renamed.set(id, added.id);
        if (asset.raster && added.needsRaster) {
          try { this.branding.setRaster(added.id, asset.raster); } catch { /* drawn again later */ }
        }
      } catch { /* refused; profiles that use it go without */ }
    }
    const rename = (id) => (id ? renamed.get(id) || id : id);
    const profiles = Object.values(next.profiles).map((profile) => ({
      ...profile, logo: rename(profile.logo), banner: rename(profile.banner),
      fonts: { heading: { ...profile.fonts.heading, asset: rename(profile.fonts.heading.asset) }, body: { ...profile.fonts.body, asset: rename(profile.fonts.body.asset) } },
    }));
    if (!same(next.profiles, now.profiles) || renamed.size || Object.keys(next.assets).some((id) => !now.assets[id])) {
      this.branding.replaceProfiles(profiles);
      changes.push('branding');
    }
    const activeProfileId = next.settings.activeProfileId && this.branding.get(next.settings.activeProfileId) ? next.settings.activeProfileId : DEFAULTS.activeProfileId;
    if (this.settings.get(SHARED_KEYS.activeProfileId) !== activeProfileId) {
      this.settings.set(SHARED_KEYS.activeProfileId, activeProfileId);
      if (!changes.includes('branding')) changes.push('branding');
    }
    const language = next.settings.language || DEFAULTS.language;
    if (this.settings.get(SHARED_KEYS.language) !== language) {
      this.settings.set(SHARED_KEYS.language, language);
      changes.push('language');
    }
    return changes;
  }
}

module.exports = { SharedSettings, mergeSharedSettings, toEntries, fromEntries, UNZIP_LIMITS };
