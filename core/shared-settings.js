'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { DEFAULT_SETTINGS } = require('./settings');
const { normalizeProfile, profileAssetIds, prepareAsset } = require('./branding');
const { contentHash } = require('./cloud-parts');

/*
 * Settings that follow you to every computer that syncs: global
 * placeholders, brand profiles (with their logos, banners and fonts), the
 * active brand profile, and the interface language. The rest of Settings
 * describes one computer (capture, hotkeys, storage, AI) and stays on it.
 *
 * Cloud sync (core/cloud-sync.js) keeps them as one archive:
 *   placeholders.json                global placeholders, by name
 *   settings.json                    language and activeProfileId, omitting
 *                                    untouched defaults, with per-value
 *                                    edit times (modifiedAt), so unrelated
 *                                    saves can't promote an older choice
 *   branding/profiles/<id>.json      one brand profile each
 *   branding/assets/<id>.json        an asset's kind, extension and file name
 *   branding/assets/<id>.<ext>       the image or font
 *   branding/assets/<id>.raster.png  its PNG drawing, when it has one
 * Only assets a profile uses are included.
 *
 * Merging works like guides (core/guide-merge.js): each placeholder, setting
 * and profile field is compared with the version every side started from.
 * Changes to different ones combine; when sides changed the same one differently,
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
const newerSettings = () => new Error('These settings were synced by a newer StepForge. Update StepForge on this computer.');
const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

// Refuse fields an older client would silently strip when publishing a merge.
function checkKnownFields(raw, shape) {
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(shape, key)) throw newerSettings();
    if (plainObject(value) && plainObject(shape[key])) checkKnownFields(value, shape[key]);
  }
}

const textOf = (entry) => (Buffer.isBuffer(entry.data) ? entry.data.toString('utf8') : String(entry.data));

function emptyModel() {
  return { placeholders: {}, settings: {}, profiles: {}, assets: {}, modifiedAt: {} };
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
    { name: 'settings.json', data: json({ ...sortedObject(model.settings), ...(Object.keys(model.modifiedAt || {}).length ? { modifiedAt: sortedObject(model.modifiedAt) } : {}) }) },
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
  const names = new Set();
  for (const entry of entries) {
    if (names.has(entry.name)) throw damaged();
    names.add(entry.name);
    if (entry.name === 'manifest.json') continue;
    if (entry.name === 'placeholders.json') {
      const raw = parse(entry);
      if (!plainObject(raw)) throw damaged();
      for (const value of Object.values(raw)) {
        if (plainObject(value)) checkKnownFields(value, { text: '', format: '' });
      }
      model.placeholders = cleanPlaceholders(raw);
    } else if (entry.name === 'settings.json') {
      const raw = parse(entry);
      if (!plainObject(raw)) throw damaged();
      const { modifiedAt = {}, ...values } = raw;
      checkKnownFields(values, SHARED_KEYS);
      if (!plainObject(modifiedAt) || Object.entries(modifiedAt).some(([key, time]) =>
        !(/^(setting:(language|activeProfileId)|placeholder:[A-Za-z0-9_ .-]{1,200})$/.test(key))
        || typeof time !== 'string' || !Number.isFinite(Date.parse(time)))) throw damaged();
      model.modifiedAt = modifiedAt;
      model.settings = cleanSettings(values);
      // A deliberate reset has an edit clock; a new computer's untouched
      // defaults have none. Keep the former as a value, not a deletion.
      for (const key of Object.keys(SHARED_KEYS)) {
        if (Object.hasOwn(values, key) && same(values[key], DEFAULTS[key]) && modifiedAt[`setting:${key}`]) model.settings[key] = values[key];
      }
    } else if (PROFILE_ENTRY.test(entry.name)) {
      const id = PROFILE_ENTRY.exec(entry.name)[1];
      if (!PROFILE_ID.test(id)) throw damaged();
      const raw = parse(entry);
      if (!plainObject(raw)) throw damaged();
      if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) throw newerSettings();
      checkKnownFields(raw, normalizeProfile({}, { id, createdAt: 'schema', updatedAt: 'schema' }));
      model.profiles[id] = normalizeProfile(raw, { id });
    } else if (ASSET_ENTRY.test(entry.name)) files.set(entry.name, entry);
    else throw newerSettings();
  }
  if (!names.has('placeholders.json') || !names.has('settings.json')) throw damaged();
  for (const [name, entry] of files) {
    const [, id, suffix] = ASSET_ENTRY.exec(name);
    if (suffix !== '.json') continue;
    const meta = parse(entry);
    if (!plainObject(meta)) throw damaged();
    checkKnownFields(meta, { id: '', kind: '', ext: '', name: '' });
    if (meta.id !== id || !Object.hasOwn(ASSET_EXTS, meta.kind) || !ASSET_EXTS[meta.kind].includes(meta.ext)) throw damaged();
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
 * `sides` run oldest to newest; `rank(value, sideIndex, key)` orders
 * conflicting edits before side order.
 */
function mergeItems(base, sides, rank = () => '', changedSinceBase = (value, _index, _key, before) => !same(value, before)) {
  const out = {};
  let conflicts = 0;
  const chosen = {};
  const keys = new Set([...Object.keys(base), ...sides.flatMap((side) => Object.keys(side))]);
  for (const key of [...keys].sort(compareText)) {
    const before = Object.hasOwn(base, key) ? base[key] : undefined;
    const changed = sides.map((side, order) => ({ value: Object.hasOwn(side, key) ? side[key] : undefined, order }))
      .filter(({ value, order }) => changedSinceBase(value, order, key, before));
    let value = before;
    if (changed.length) {
      if (changed.some(({ value: v }) => !same(v, changed[0].value))) conflicts += 1;
      const edits = changed.filter(({ value: v }) => v !== undefined);
      const winner = edits.length
        ? edits.reduce((best, edit) => (compareText(rank(edit.value, edit.order, key), rank(best.value, best.order, key)) >= 0 ? edit : best))
        : null;
      value = winner?.value;
      if (winner) chosen[key] = winner.order;
    }
    if (value !== undefined) out[key] = value;
  }
  return { items: out, conflicts, chosen };
}

/**
 * Merge shared settings. `sides` are [{ entries, time, hash }], where `time`
 * is when that side last changed. The result depends only on the base and
 * the sides, never on which computer merges.
 */
function mergeSharedSettings({ base = null, sides }) {
  const before = base ? fromEntries(base) : emptyModel();
  const ranked = sides.map((side) => ({ model: fromEntries(side.entries), time: String(side.time || ''), hash: side.hash || '' }))
    .sort((a, b) => compareText(a.time, b.time) || compareText(a.hash, b.hash));
  const models = ranked.map(({ model }) => model);
  const stamp = (prefix, index, key) => models[index].modifiedAt[`${prefix}:${key}`] || ranked[index].time;
  const valueChanged = (prefix) => (value, index, key, baseValue) => !same(value, baseValue)
    || (value !== undefined && models[index].modifiedAt[`${prefix}:${key}`]
      && models[index].modifiedAt[`${prefix}:${key}`] !== before.modifiedAt[`${prefix}:${key}`]);
  const placeholders = mergeItems(before.placeholders, models.map((m) => m.placeholders), (_value, index, key) => stamp('placeholder', index, key), valueChanged('placeholder'));
  const settings = mergeItems(before.settings, models.map((m) => m.settings), (_value, index, key) => stamp('setting', index, key), valueChanged('setting'));
  const profiles = mergeItems(before.profiles, models.map((m) => m.profiles), (profile) => profile.updatedAt || '');
  // First decide whether a profile survives a deletion. For profiles with a
  // common base, merge fields from the surviving edits so changing a logo on
  // one computer doesn't discard a color changed on another.
  for (const id of Object.keys(profiles.items)) {
    if (!before.profiles[id]) continue;
    const present = models.map((m) => m.profiles[id]).filter(Boolean);
    const flatten = (value, prefix = '', out = {}) => {
      for (const [key, item] of Object.entries(value)) {
        const name = prefix ? `${prefix}.${key}` : key;
        if (plainObject(item)) flatten(item, name, out); else out[name] = item;
      }
      return out;
    };
    const fields = mergeItems(flatten(before.profiles[id]), present.map((profile) => flatten(profile)), (_value, index) => present[index].updatedAt || '');
    const profile = {};
    for (const [name, value] of Object.entries(fields.items)) {
      const path = name.split('.');
      let object = profile;
      for (const key of path.slice(0, -1)) object = object[key] ||= {};
      object[path.at(-1)] = value;
    }
    profiles.items[id] = profile;
  }
  const merged = { placeholders: placeholders.items, settings: settings.items, profiles: profiles.items, assets: {}, modifiedAt: {} };
  for (const [prefix, result] of [['placeholder', placeholders], ['setting', settings]]) {
    for (const key of Object.keys(result.items)) {
      const index = result.chosen[key];
      const time = index === undefined ? before.modifiedAt[`${prefix}:${key}`] : stamp(prefix, index, key);
      if (time) merged.modifiedAt[`${prefix}:${key}`] = time;
    }
  }
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
    const times = this.settings.getSharedChangeTimes();
    for (const [key, keyPath] of Object.entries(SHARED_KEYS)) {
      if (same(this.settings.get(keyPath), DEFAULTS[key]) && times[`setting:${key}`]) model.settings[key] = DEFAULTS[key];
    }
    for (const [prefix, values] of [['placeholder', model.placeholders], ['setting', model.settings]]) {
      for (const key of Object.keys(values)) if (times[`${prefix}:${key}`]) model.modifiedAt[`${prefix}:${key}`] = times[`${prefix}:${key}`];
    }
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
    const lines = [JSON.stringify(Object.values(SHARED_KEYS).map((keyPath) => this.settings.get(keyPath) ?? null)), stat(this.settings.globalPlaceholdersFile), stat(this.settings.sharedTimesFile)];
    for (const dir of [this.branding.profilesDir, this.branding.assetsDir]) {
      let names = [];
      try { names = fs.readdirSync(dir).sort(compareText); } catch { /* none yet */ }
      for (const name of names) lines.push(stat(path.join(dir, name)));
    }
    return lines.join('\n');
  }

  /** When shared settings last changed here, for merges where both computers changed the same thing. */
  modifiedAt() {
    const times = Object.values(this.settings.getSharedChangeTimes());
    for (const { updatedAt } of this.branding.list()) times.push(updatedAt);
    const newest = Math.max(0, ...times.map((time) => Date.parse(time) || 0));
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
    // Validate every required asset before changing placeholders or profiles.
    // Otherwise a refused image could be turned into a deleted logo and synced
    // back to every other computer as a successful settings version.
    const prepared = new Map();
    for (const [id, asset] of Object.entries(next.assets)) {
      try { prepared.set(id, prepareAsset(asset.data, { kind: asset.kind, fileName: asset.name })); }
      catch (error) { throw new Error(`Synced brand asset ${id} could not be read: ${error.message}`); }
    }
    for (const profile of Object.values(next.profiles)) {
      for (const id of profileAssetIds(profile)) {
        if (!prepared.has(id)) throw new Error(`Synced brand asset ${id} is missing. Settings here are unchanged.`);
      }
    }
    const changes = [];
    // An asset that comes out with another id (a sanitized SVG) is renamed in the profiles.
    const renamed = new Map();
    for (const [id, asset] of Object.entries(next.assets)) {
      const { data, meta } = prepared.get(id);
      const known = this.branding.assetMeta(meta.id);
      // Names are part of the archive too: an existing content-addressed asset
      // must adopt the merged name, or two devices continually undo each other.
      if (!known || known.name !== meta.name || known.kind !== meta.kind || known.ext !== meta.ext
          || !fs.readFileSync(this.branding.assetFile(known)).equals(data)) {
        this.branding.addAsset(asset.data, { kind: asset.kind, fileName: asset.name });
      }
      if (meta.id !== id) renamed.set(id, meta.id);
      if (asset.raster) {
        const stored = this.branding.assetMeta(meta.id);
        let raster = null;
        if (stored.raster) { try { raster = fs.readFileSync(this.branding.rasterFile(stored)); } catch { /* replace missing raster */ } }
        if (!raster?.equals(asset.raster)) {
          try { this.branding.setRaster(meta.id, asset.raster); } catch { /* drawn again later */ }
        }
      }
    }
    if (!same(next.placeholders, now.placeholders)) {
      this.settings.setGlobalPlaceholders(next.placeholders);
      changes.push('placeholders');
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
    this.settings.setSharedChangeTimes(next.modifiedAt);
    return changes;
  }
}

module.exports = { SharedSettings, mergeSharedSettings, toEntries, fromEntries, UNZIP_LIMITS };
