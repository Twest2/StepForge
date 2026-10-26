'use strict';

const { isDeepStrictEqual } = require('node:util');
const { htmlToText } = require('./util');
const { orderedBlocks, blockText } = require('./blocks');

/*
 * Compare two versions of a guide — a snapshot and the guide as it is now —
 * for the Compare view. Steps and blocks are matched by id, so an edited
 * step is "changed" rather than deleted and added again, and one that
 * changed place among the others is "moved". Text is compared word by word
 * and code line by line, like a git diff. The result is plain JSON for the
 * renderer to draw.
 *
 * Bookkeeping that changes on its own (revision, timestamps, capture
 * metadata, the private-detail check, the author's todo/done status) is not
 * a difference.
 */

const same = (a, b) => isDeepStrictEqual(a, b);
// Past this many edits two texts are "rewritten": shown as all removed, all added.
const MAX_EDITS = 2000;

/** Myers' diff of two token arrays: [op, token] pairs, op 'eq' | 'del' | 'add'. */
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const off = max + 1;
  const v = new Int32Array(2 * off + 1);
  // trace[d] holds v for diagonals -d..d after round d.
  const trace = [];
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(off - d, off + d + 1));
        return backtrack(trace, a, b);
      }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  return null;
}

function backtrack(trace, a, b) {
  const out = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1];
    const at = (k) => prev[k + d - 1];
    const k = x - y;
    const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { out.push(['eq', a[--x]]); y--; }
    if (x === prevX) out.push(['add', b[--y]]);
    else out.push(['del', a[--x]]);
  }
  while (x > 0 && y > 0) { out.push(['eq', a[--x]]); y--; }
  return out.reverse();
}

/** Diff two token arrays into runs: [{ op, items }]. */
function diffSequences(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const runs = [];
  const push = (op, item) => {
    const last = runs.at(-1);
    if (last && last.op === op) last.items.push(item);
    else runs.push({ op, items: [item] });
  };
  for (let i = 0; i < start; i++) push('eq', a[i]);
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle = midA.length && midB.length ? myers(midA, midB) : null;
  if (middle) {
    for (const [op, item] of middle) push(op, item);
  } else {
    midA.forEach((item) => push('del', item));
    midB.forEach((item) => push('add', item));
  }
  for (let i = endA; i < a.length; i++) push('eq', a[i]);
  return runs;
}

const WORD = /\s+|[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*|[^\s\p{L}\p{N}_]/gu;
const tokens = (text) => String(text || '').match(WORD) || [];

/**
 * Word diff: [{ op, text }] where the 'eq' and 'del' parts spell `before`
 * and the 'eq' and 'add' parts spell `after`. A space between two
 * replacements joins them, so "red cat" → "blue dog" reads as one change.
 */
function diffWords(before, after) {
  const runs = diffSequences(tokens(before), tokens(after)).map((run) => ({ op: run.op, text: run.items.join('') }));
  const kinds = (i) => {
    const ops = new Set();
    for (let j = i; j >= 0 && runs[j].op !== 'eq'; j--) ops.add(runs[j].op);
    return ops;
  };
  const kindsAfter = (i) => {
    const ops = new Set();
    for (let j = i; j < runs.length && runs[j].op !== 'eq'; j++) ops.add(runs[j].op);
    return ops;
  };
  const parts = [];
  let del = '';
  let add = '';
  const flush = () => {
    if (del) parts.push({ op: 'del', text: del });
    if (add) parts.push({ op: 'add', text: add });
    del = '';
    add = '';
  };
  runs.forEach((run, i) => {
    if (run.op === 'del') { del += run.text; return; }
    if (run.op === 'add') { add += run.text; return; }
    const prev = i > 0 ? kinds(i - 1) : new Set();
    const next = i < runs.length - 1 ? kindsAfter(i + 1) : new Set();
    // Fold the space into the change unless both sides only add (or only remove).
    const sameKind = prev.size === 1 && next.size === 1 && [...prev][0] === [...next][0];
    if (/^\s+$/.test(run.text) && prev.size && next.size && !sameKind) {
      del += run.text;
      add += run.text;
      return;
    }
    flush();
    parts.push({ op: 'eq', text: run.text });
  });
  flush();
  return parts;
}

const textOf = (parts, op) => parts.filter((p) => p.op === 'eq' || p.op === op).map((p) => p.text).join('');

/**
 * Line diff, git style: [{ op, text }] per line. Removed lines followed by
 * added ones are paired up in order, and each paired line also gets
 * `parts`, a word diff of the two, so the changed words stand out.
 */
function diffLines(before, after) {
  const split = (text) => (text ? String(text).replace(/\r\n?/g, '\n').split('\n') : []);
  const runs = diffSequences(split(before), split(after));
  const lines = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run.op === 'del' && runs[i + 1]?.op === 'add') {
      const added = runs[i + 1].items;
      const pairs = Math.min(run.items.length, added.length);
      run.items.forEach((text, j) => lines.push(j < pairs ? { op: 'del', text, parts: diffWords(text, added[j]).filter((p) => p.op !== 'add') } : { op: 'del', text }));
      added.forEach((text, j) => lines.push(j < pairs ? { op: 'add', text, parts: diffWords(run.items[j], text).filter((p) => p.op !== 'del') } : { op: 'add', text }));
      i++;
      continue;
    }
    for (const text of run.items) lines.push({ op: run.op, text });
  }
  return lines;
}

/**
 * A table's rows, matched up. Same column count: rows are diffed as lines,
 * and a removed row followed by an added one is a changed row whose cells are
 * word-diffed. A different column count is a structure change, shown as the
 * two whole tables.
 */
function diffTable(beforeRows, afterRows) {
  const width = (rows) => rows.reduce((max, row) => Math.max(max, row.length), 0);
  const columns = Math.max(width(beforeRows), width(afterRows));
  if (beforeRows.length && afterRows.length && width(beforeRows) !== width(afterRows)) {
    return { structure: true, before: beforeRows, after: afterRows };
  }
  const pad = (row) => Array.from({ length: columns }, (_, i) => String(row[i] ?? ''));
  const key = (row) => pad(row).join('\u0000');
  const keyed = (rows) => rows.map(key);
  const byKey = (rows) => new Map(rows.map((row) => [key(row), pad(row)]));
  const beforeByKey = byKey(beforeRows);
  const afterByKey = byKey(afterRows);
  const rows = [];
  const runs = diffSequences(keyed(beforeRows), keyed(afterRows));
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run.op === 'del' && runs[i + 1]?.op === 'add') {
      const added = runs[i + 1].items;
      const pairs = Math.min(run.items.length, added.length);
      for (let j = 0; j < pairs; j++) {
        const a = beforeByKey.get(run.items[j]);
        const b = afterByKey.get(added[j]);
        rows.push({ op: 'change', cells: a.map((cell, c) => (cell === b[c] ? [{ op: 'eq', text: cell }] : diffWords(cell, b[c]))) });
      }
      run.items.slice(pairs).forEach((k) => rows.push({ op: 'del', cells: beforeByKey.get(k).map((text) => [{ op: 'del', text }]) }));
      added.slice(pairs).forEach((k) => rows.push({ op: 'add', cells: afterByKey.get(k).map((text) => [{ op: 'add', text }]) }));
      i++;
      continue;
    }
    const source = run.op === 'add' ? afterByKey : beforeByKey;
    for (const k of run.items) rows.push({ op: run.op, cells: source.get(k).map((text) => [{ op: run.op, text }]) });
  }
  return { structure: false, columns, rows };
}

/** Ids in both lists whose order relative to the others changed. */
function movedIds(beforeIds, afterIds) {
  const inAfter = new Set(afterIds);
  const inBefore = new Set(beforeIds);
  const runs = diffSequences(beforeIds.filter((id) => inAfter.has(id)), afterIds.filter((id) => inBefore.has(id)));
  return new Set(runs.filter((run) => run.op !== 'eq').flatMap((run) => run.items));
}

/**
 * The ids of both versions in one list: the current order, with each
 * removed id placed after the one it followed before.
 */
function mergedOrder(beforeIds, afterIds) {
  const inAfter = new Set(afterIds);
  const removedAfter = new Map(); // anchor id (or '') -> removed ids that follow it
  let anchor = '';
  for (const id of beforeIds) {
    if (inAfter.has(id)) { anchor = id; continue; }
    if (!removedAfter.has(anchor)) removedAfter.set(anchor, []);
    removedAfter.get(anchor).push(id);
  }
  const order = [...(removedAfter.get('') || [])];
  for (const id of afterIds) order.push(id, ...(removedAfter.get(id) || []));
  return order;
}

/** "1", "1.1", "2" … for steps in order, as the editor numbers them. */
function stepNumbers(order, stepMap) {
  const numbers = new Map();
  const childCounts = new Map();
  let top = 0;
  for (const id of order) {
    const parent = stepMap.get(id)?.parentStepId;
    if (parent && numbers.has(parent)) {
      const next = (childCounts.get(parent) || 0) + 1;
      childCounts.set(parent, next);
      numbers.set(id, `${numbers.get(parent)}.${next}`);
    } else {
      top += 1;
      numbers.set(id, String(top));
    }
  }
  return numbers;
}

function textChange(label, before, after) {
  if ((before || '') === (after || '')) return null;
  return { type: 'text', label, parts: diffWords(before || '', after || '') };
}

/** Rich text: a word diff of the words, or a note when only formatting changed. */
function richTextChange(label, beforeHtml, afterHtml) {
  if ((beforeHtml || '') === (afterHtml || '')) return null;
  const before = htmlToText(beforeHtml);
  const after = htmlToText(afterHtml);
  if (before === after) return { type: 'formatting', label };
  return { type: 'text', label, parts: diffWords(before, after) };
}

function fieldChange(label, before, after) {
  return same(before, after) ? null : { type: 'field', label, before, after };
}

const yesNo = (value) => (value ? 'Yes' : 'No');
const STEP_KIND_LABELS = { image: 'Screenshot', empty: 'Blank', content: 'Content only' };
const TEXT_LEVEL_LABELS = { info: 'Info', warn: 'Warning', error: 'Error', success: 'Success' };
const POSITION_LABELS = {
  'before-title': 'Before the title', 'after-title': 'After the title',
  'before-image': 'Before the screenshot', 'after-image': 'After the screenshot',
  'before-description': 'Before the description', 'after-description': 'After the description',
};
const BLOCK_LABELS = { text: 'Text block', code: 'Code block', table: 'Table' };

/** What a screenshot looks like to a reader: the file, its annotations and focused view. */
function imageRef(step, image, fileSha) {
  const rel = image && (image.workingPath || image.path || image.originalPath);
  if (!rel) return null;
  const file = `steps/${step.stepId}/${rel}`;
  return {
    file,
    sha: fileSha(file),
    size: image.size || null,
    annotations: image === step.image ? step.annotations || [] : image.annotations || [],
    focusedView: image === step.image && step.focusedView?.enabled ? step.focusedView : null,
  };
}

function imageChange(label, before, after) {
  if (!before && !after) return null;
  const reasons = [];
  if (before && after) {
    if (before.sha !== after.sha) reasons.push('screenshot');
    if (!same(before.annotations, after.annotations)) reasons.push('annotations');
    if (!same(before.focusedView, after.focusedView)) reasons.push('focused view');
    if (!reasons.length) return null;
  }
  const strip = (ref) => (ref ? { file: ref.file, size: ref.size, annotations: ref.annotations, focusedView: ref.focusedView } : null);
  return {
    type: 'image', label, status: !before ? 'added' : !after ? 'deleted' : 'changed', reasons,
    before: strip(before), after: strip(after),
  };
}

function blockContent(kind, a, b) {
  const empty = { title: '', descriptionHtml: '', code: '', rows: [], language: '', level: null, position: null };
  a = a || empty;
  b = b || empty;
  if (kind === 'text') {
    const added = a === empty;
    const removed = b === empty;
    return {
      level: added || removed ? null : fieldChange('Style', TEXT_LEVEL_LABELS[a.level] || a.level, TEXT_LEVEL_LABELS[b.level] || b.level),
      position: added || removed ? null : fieldChange('Placed', POSITION_LABELS[a.position] || a.position, POSITION_LABELS[b.position] || b.position),
      levelValue: (removed ? a : b).level,
      title: (a.title || b.title) ? { parts: diffWords(a.title || '', b.title || '') } : null,
      description: richTextChange('Text', a.descriptionHtml, b.descriptionHtml)
        || (htmlToText(b.descriptionHtml) ? { type: 'text', label: 'Text', parts: [{ op: 'eq', text: htmlToText(b.descriptionHtml) }] } : null),
    };
  }
  if (kind === 'code') {
    return {
      language: a === empty || b === empty ? null : fieldChange('Language', a.language || 'Plain text', b.language || 'Plain text'),
      languageValue: (b === empty ? a : b).language || '',
      lines: diffLines(blockText(a), blockText(b)),
    };
  }
  return { table: diffTable(a.rows || [], b.rows || []) };
}

function blockChanged(kind, a, b) {
  if (kind === 'text') return a.title !== b.title || a.descriptionHtml !== b.descriptionHtml || a.level !== b.level || a.position !== b.position;
  if (kind === 'code') return blockText(a) !== blockText(b) || (a.language || '') !== (b.language || '');
  return !same(a.rows, b.rows);
}

function blockChanges(before, after) {
  const key = (block) => `${block.kind}:${block.id}`;
  const beforeBlocks = orderedBlocks(before);
  const afterBlocks = orderedBlocks(after);
  const beforeMap = new Map(beforeBlocks.map((block) => [key(block), block]));
  const afterMap = new Map(afterBlocks.map((block) => [key(block), block]));
  const moved = movedIds(beforeBlocks.map(key), afterBlocks.map(key));
  const changes = [];
  for (const k of mergedOrder(beforeBlocks.map(key), afterBlocks.map(key))) {
    const a = beforeMap.get(k) || null;
    const b = afterMap.get(k) || null;
    const kind = (a || b).kind;
    const status = !a ? 'added' : !b ? 'deleted' : blockChanged(kind, a, b) ? 'changed' : 'unchanged';
    if (status === 'unchanged' && !moved.has(k)) continue;
    changes.push({ type: 'block', kind, id: (a || b).id, label: BLOCK_LABELS[kind], status, moved: moved.has(k), ...blockContent(kind, a, b) });
  }
  return changes;
}

const linkLabels = (links) => (links || []).map((link) => link.label || 'Link');

/** The differences between two copies of one step (either may be null). */
function stepChanges(before, after, beforeSha, afterSha) {
  const blank = { stepId: (before || after).stepId, title: '', descriptionHtml: '', annotations: [], extraImages: [] };
  const a = before || blank;
  const b = after || blank;
  const both = before && after;
  const changes = [
    textChange('Title', a.title, b.title),
    richTextChange('Description', a.descriptionHtml, b.descriptionHtml),
    both ? fieldChange('Step type', STEP_KIND_LABELS[a.kind] || a.kind, STEP_KIND_LABELS[b.kind] || b.kind) : null,
    both ? fieldChange('Hidden', yesNo(a.hidden), yesNo(b.hidden)) : null,
    both ? fieldChange('Skipped', yesNo(a.skipped), yesNo(b.skipped)) : null,
    both ? fieldChange('Starts a new page', yesNo(a.forceNewPage), yesNo(b.forceNewPage)) : null,
    both ? fieldChange('Links', linkLabels(a.links).join(', ') || 'None', linkLabels(b.links).join(', ') || 'None') : null,
    imageChange('Screenshot', imageRef(a, a.image, beforeSha), imageRef(b, b.image, afterSha)),
  ];
  const extras = Math.max((a.extraImages || []).length, (b.extraImages || []).length);
  for (let i = 0; i < extras; i++) {
    changes.push(imageChange(`Image ${i + 2}`, imageRef(a, a.extraImages?.[i], beforeSha), imageRef(b, b.extraImages?.[i], afterSha)));
  }
  changes.push(...blockChanges(a, b));
  return changes.filter(Boolean);
}

const METADATA_LABELS = { author: 'Author', coAuthors: 'Co-authors', organization: 'Organization' };
const FLAG_LABELS = {
  focusedViewDefault: 'Focused view for new steps',
  hideSkippedStepsInExports: 'Hide skipped steps in exports',
};
const pretty = (key) => METADATA_LABELS[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

function guideChanges(a, b) {
  const changes = [
    textChange('Guide title', a.title, b.title),
    richTextChange('Guide description', a.descriptionHtml, b.descriptionHtml),
  ];
  const keys = (x, y) => [...new Set([...Object.keys(x || {}), ...Object.keys(y || {})])];
  for (const key of keys(a.metadata, b.metadata)) {
    changes.push(fieldChange(pretty(key), a.metadata?.[key] ?? '', b.metadata?.[key] ?? ''));
  }
  for (const key of keys(a.placeholders, b.placeholders).sort()) {
    changes.push(fieldChange(`Placeholder [[${key}]]`, a.placeholders?.[key] ?? null, b.placeholders?.[key] ?? null));
  }
  for (const key of keys(a.flags, b.flags)) {
    changes.push(fieldChange(FLAG_LABELS[key] || pretty(key), yesNo(a.flags?.[key]), yesNo(b.flags?.[key])));
  }
  changes.push(fieldChange('Theme', a.themeOverride || 'system', b.themeOverride || 'system'));
  return changes.filter(Boolean);
}

/**
 * Compare two versions of a guide. Each is { guide, steps, fileSha } where
 * `steps` lists its steps (any order) and `fileSha(name)` returns the SHA-256
 * of a file such as "steps/<id>/original.png", or null when it is missing.
 */
function diffGuides(before, after) {
  const index = (side) => {
    const map = new Map(side.steps.map((step) => [step.stepId, step]));
    const order = (side.guide.stepsOrder || []).filter((id) => map.has(id));
    return { map, order, numbers: stepNumbers(order, map) };
  };
  const a = index(before);
  const b = index(after);
  const moved = movedIds(a.order, b.order);
  for (const id of a.order) {
    if (b.map.has(id) && (a.map.get(id).parentStepId || null) !== (b.map.get(id).parentStepId || null)) moved.add(id);
  }
  const summary = { added: 0, deleted: 0, changed: 0, moved: 0, unchanged: 0 };
  const steps = mergedOrder(a.order, b.order).map((id) => {
    const was = a.map.get(id) || null;
    const now = b.map.get(id) || null;
    const changes = stepChanges(was, now, before.fileSha, after.fileSha);
    const status = !was ? 'added' : !now ? 'deleted' : changes.length ? 'changed' : 'unchanged';
    const isMoved = Boolean(was && now && moved.has(id));
    summary[status] += 1;
    if (isMoved) summary.moved += 1;
    const step = now || was;
    let depth = 0;
    const map = now ? b.map : a.map;
    for (let p = step.parentStepId; p && map.has(p) && depth < 20; p = map.get(p).parentStepId) depth += 1;
    return {
      stepId: id,
      status,
      moved: isMoved,
      number: { before: a.numbers.get(id) || null, after: b.numbers.get(id) || null },
      depth,
      title: step.title || '',
      changes,
    };
  });
  const guide = guideChanges(before.guide, after.guide);
  return {
    guide,
    steps,
    summary,
    identical: !guide.length && steps.every((step) => step.status === 'unchanged' && !step.moved),
  };
}

module.exports = { diffGuides, diffWords, diffLines, diffTable, diffSequences, movedIds, mergedOrder, textOf };
