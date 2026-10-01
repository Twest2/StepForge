'use strict';

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

/*
 * Three-way merge of guide archives, used by cloud sync when the same guide
 * changed on more than one computer.
 *
 * Every side is compared with the version they all started from (the base).
 * Changes on different fields, steps, annotations or blocks are combined.
 * When sides changed the same thing differently, the side saved most
 * recently wins that one value. A step edited on one side and deleted on
 * another is kept. A step's screenshot files and image metadata are one
 * unit, so a merged step never pairs one side's crop with another's image.
 *
 * The result only depends on the base and the set of sides, never on which
 * computer runs it, so separate computers merging the same versions agree.
 * Without a base, nothing is treated as deleted: everything from every side
 * is kept and differing values go to the newest side.
 */

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const bytesOf = (entry) => (Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8'));
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => isDeepStrictEqual(a, b);
const STEP_FILE = /^steps\/([^/]+)\/(.+)$/;
const IMAGE = /\.(png|jpg|jpeg|gif|webp)$/i;
// Saved with the screenshot files: changing one without the other breaks the step.
const MEDIA_FIELDS = ['image', 'extraImages'];
// Bookkeeping that changes on every save; never a conflict.
const GUIDE_BOOKKEEPING = ['revision', 'updatedAt', 'createdAt', 'stepsOrder'];

function isKeyedList(value) {
  if (!Array.isArray(value)) return false;
  const ids = new Set();
  for (const item of value) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id)) return false;
    ids.add(item.id);
  }
  return true;
}

/**
 * Merge an ordered list of ids. The highest-priority side that reordered
 * the base sets the order; ids only other sides have are slotted in after
 * the id they follow there. `keep` is the set of ids in the result.
 */
function mergeOrder(base, orders, keep) {
  const relative = (order) => order.filter((id) => base.includes(id));
  const primary = orders.find((order) => {
    const kept = relative(order);
    return !same(kept, base.filter((id) => kept.includes(id)));
  }) || base;
  const result = primary.filter((id) => keep.has(id));
  const placed = new Set(result);
  for (const order of [...orders, base]) {
    order.forEach((id, index) => {
      if (placed.has(id) || !keep.has(id)) return;
      const before = order.slice(0, index).reverse().find((other) => placed.has(other));
      result.splice(before === undefined ? 0 : result.indexOf(before) + 1, 0, id);
      placed.add(id);
    });
  }
  for (const id of keep) if (!placed.has(id)) result.push(id);
  return result;
}

/** Merge one value. `values` are the sides' values, highest priority first. */
function mergeValue(base, values, stats) {
  let changed = values.filter((value) => !same(value, base));
  if (!changed.length) return base;
  // Changing something beats removing it.
  if (changed.some((value) => value !== undefined)) changed = changed.filter((value) => value !== undefined);
  if (changed.every((value) => same(value, changed[0]))) return changed[0];
  if (changed.every(isObject) && (base === undefined || isObject(base))) {
    const from = base || {};
    const result = {};
    const keys = [...new Set([...Object.keys(from), ...changed.flatMap((value) => Object.keys(value))])];
    for (const key of keys) {
      const merged = mergeValue(from[key], changed.map((value) => value[key]), stats);
      if (merged !== undefined) result[key] = merged;
    }
    return result;
  }
  if (changed.every(isKeyedList) && (base === undefined || isKeyedList(base))) {
    const from = new Map((base || []).map((item) => [item.id, item]));
    const sides = changed.map((list) => new Map(list.map((item) => [item.id, item])));
    const ids = new Set([...from.keys(), ...sides.flatMap((side) => [...side.keys()])]);
    const items = new Map();
    for (const id of ids) {
      // A side without the item removed it only if the base had it.
      const merged = mergeValue(from.get(id), sides.map((side) => side.get(id)), stats);
      if (merged !== undefined) items.set(id, merged);
    }
    const order = mergeOrder([...from.keys()], changed.map((list) => list.map((item) => item.id)), new Set(items.keys()));
    return order.map((id) => items.get(id));
  }
  stats.conflicts += 1;
  return changed[0];
}

function parseJson(entry) {
  return JSON.parse(bytesOf(entry).toString('utf8'));
}

/**
 * Split archive entries into the guide, its steps and their files.
 * Base entries may carry only a `sha` for screenshots (a cloud manifest);
 * JSON entries must have their data.
 */
function readSide(entries) {
  const side = { manifest: null, guide: null, steps: new Map() };
  const step = (id) => {
    if (!side.steps.has(id)) side.steps.set(id, { json: null, files: new Map() });
    return side.steps.get(id);
  };
  for (const entry of entries) {
    if (entry.name === 'manifest.json') side.manifest = entry;
    else if (entry.name === 'guide.json') side.guide = parseJson(entry);
    else {
      const match = STEP_FILE.exec(entry.name);
      if (!match) continue;
      if (match[2] === 'step.json') step(match[1]).json = parseJson(entry);
      else step(match[1]).files.set(match[2], { sha: entry.sha || sha256(bytesOf(entry)), entry: entry.data == null ? null : entry });
    }
  }
  if (!side.guide) throw new Error('A guide version is missing guide.json.');
  for (const [id, value] of side.steps) if (!value.json) side.steps.delete(id);
  return side;
}

function media(step) {
  if (!step) return undefined;
  const fields = {};
  for (const key of MEDIA_FIELDS) fields[key] = step.json[key];
  return { fields, files: Object.fromEntries([...step.files].map(([name, file]) => [name, file.sha]).sort(([a], [b]) => compareText(a, b))) };
}

function withoutKeys(object, keys) {
  if (!object) return undefined;
  const copy = { ...object };
  for (const key of keys) delete copy[key];
  return copy;
}

const maxRevision = (values) => Math.max(0, ...values.map((value) => (Number.isInteger(value?.revision) ? value.revision : 0)));

/**
 * Merge archive entries.
 *   base:  entries of the common version, or null when there is none
 *   sides: [{ entries, hash }]; the side saved last (guide.updatedAt) wins
 *          a conflicting value, and `hash` breaks ties
 * Returns { entries, conflicts } where `conflicts` counts values that both
 * sides changed differently (the newest side's value was used).
 */
function mergeGuideEntries({ base, sides }) {
  if (!sides.length) throw new Error('Nothing to merge.');
  // Newest save first; the content hash breaks ties the same way everywhere.
  const read = sides.map((side) => ({ ...readSide(side.entries), hash: String(side.hash || '') }))
    .sort((a, b) => compareText(String(b.guide.updatedAt || ''), String(a.guide.updatedAt || '')) || compareText(b.hash, a.hash));
  const from = base ? readSide(base) : null;
  const stats = { conflicts: 0 };

  // ---- steps
  const stepIds = new Set([...(from ? from.steps.keys() : []), ...read.flatMap((side) => [...side.steps.keys()])]);
  const steps = new Map();
  for (const id of stepIds) {
    const was = from?.steps.get(id);
    const present = read.map((side) => side.steps.get(id)).filter(Boolean);
    if (!present.length) continue;
    if (was && present.length < read.length) {
      // Deleted somewhere: keep it only if a side that still has it changed it.
      const edited = present.some((step) => !same(step.json, was.json) || !same(media(step), media(was)));
      if (!edited) continue;
    }
    const pickedMedia = mergeValue(media(was), present.map(media), stats);
    const json = mergeValue(withoutKeys(was?.json, [...MEDIA_FIELDS, 'revision']),
      present.map((step) => withoutKeys(step.json, [...MEDIA_FIELDS, 'revision'])), stats);
    // Screenshot bytes come from any side holding the chosen files.
    const files = new Map();
    for (const [name, sha] of Object.entries(pickedMedia.files)) {
      const holder = present.map((step) => step.files.get(name)).find((file) => file?.sha === sha && file.entry);
      if (!holder) throw new Error('A merged step is missing a screenshot.');
      files.set(name, holder.entry);
    }
    const merged = { ...json, revision: maxRevision(present.map((step) => step.json)) };
    for (const key of MEDIA_FIELDS) if (pickedMedia.fields[key] !== undefined) merged[key] = pickedMedia.fields[key];
    steps.set(id, { json: merged, files });
  }
  // A substep whose parent is gone moves to the top level, as deleting a step does.
  for (const step of steps.values()) {
    if (step.json.parentStepId && !steps.has(step.json.parentStepId)) step.json.parentStepId = null;
  }

  // ---- guide
  const guide = mergeValue(withoutKeys(from?.guide, GUIDE_BOOKKEEPING),
    read.map((side) => withoutKeys(side.guide, GUIDE_BOOKKEEPING)), stats);
  guide.stepsOrder = mergeOrder(from ? from.guide.stepsOrder : [], read.map((side) => side.guide.stepsOrder), new Set(steps.keys()));
  guide.revision = maxRevision(read.map((side) => side.guide));
  guide.createdAt = [...read.map((side) => side.guide.createdAt), from?.guide.createdAt].filter(Boolean).sort(compareText)[0];
  guide.updatedAt = read.map((side) => side.guide.updatedAt).filter(Boolean).sort(compareText).at(-1);

  // ---- entries, in archive order
  const manifest = read[0].manifest ? parseJson(read[0].manifest) : {};
  Object.assign(manifest, { guideId: guide.guideId, title: guide.title, stepCount: guide.stepsOrder.length });
  const entries = [
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    { name: 'guide.json', data: JSON.stringify(guide, null, 2) },
  ];
  for (const id of guide.stepsOrder) {
    const step = steps.get(id);
    entries.push({ name: `steps/${id}/step.json`, data: JSON.stringify(step.json, null, 2) });
    for (const [name, entry] of [...step.files].sort(([a], [b]) => compareText(a, b))) {
      entries.push({ name: `steps/${id}/${name}`, data: entry.data, store: IMAGE.test(name) });
    }
  }
  return { entries, conflicts: stats.conflicts };
}

module.exports = { mergeGuideEntries, mergeOrder, mergeValue };
