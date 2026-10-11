'use strict';

const { sanitizeHtml } = require('./sanitize');
const { decodeEntities, escapeHtml, deepClone } = require('./util');
const { TOKEN_RE } = require('./placeholders');

/**
 * Find and replace across a guide's steps. Pure: findMatches() lists every
 * occurrence, applyReplacements() returns edited clones of the steps it
 * touched. Callers do the saving and the undo record.
 *
 * Searched: step titles and descriptions, text block titles and bodies, code
 * blocks, table cells and annotation labels. Screenshots are never touched.
 *
 * Rules:
 *  - HTML fields are edited in text nodes only (tags and attributes are never
 *    matched), each node on its own, so a phrase split by <b>…</b> is not
 *    found. Text outside the matches keeps its original entities, and the
 *    result goes back through sanitizeHtml().
 *  - [[placeholder]] tokens are never altered: a match that overlaps one is
 *    not listed.
 *  - A replacement that would break the field it lands in is refused (see
 *    refusalReason()): `|` or a line break in a table cell, a line break in a
 *    title.
 */

const WORD = '[\\p{L}\\p{N}_]';
const TAG_RE = /(<\s*\/?\s*[a-zA-Z][a-zA-Z0-9]*(?:"[^"]*"|'[^']*'|[^>"'])*>)/;
const ENTITY_RE = /&(?:#x?[0-9a-fA-F]+|[a-zA-Z]+|#39);/g;
const CONTEXT = 28; // characters of surrounding text shown with a match

/** The regex for a query, or null when it is empty. */
function buildPattern(query, { caseSensitive = false, wholeWord = false } = {}) {
  const q = String(query == null ? '' : query);
  if (!q) return null;
  let source = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Only demand a word boundary on a side that starts or ends with a word character.
  if (wholeWord) {
    if (new RegExp(`^${WORD}`, 'u').test(q)) source = `(?<!${WORD})${source}`;
    if (new RegExp(`${WORD}$`, 'u').test(q)) source = `${source}(?!${WORD})`;
  }
  return new RegExp(source, caseSensitive ? 'gu' : 'giu');
}

/** Every searchable string of a step: { path, kind, where, html }. */
function stepFields(step) {
  const out = [];
  out.push({ path: ['title'], kind: 'title', where: 'Title', html: false });
  out.push({ path: ['descriptionHtml'], kind: 'description', where: 'Description', html: true });
  (step.textBlocks || []).forEach((tb, i) => {
    out.push({ path: ['textBlocks', i, 'title'], kind: 'text-block-title', where: 'Text block title', html: false });
    out.push({ path: ['textBlocks', i, 'descriptionHtml'], kind: 'text-block', where: 'Text block', html: true });
  });
  (step.codeBlocks || []).forEach((cb, i) => {
    out.push({ path: ['codeBlocks', i, 'code'], kind: 'code', where: 'Code block', html: false });
  });
  (step.tableBlocks || []).forEach((tbl, i) => {
    (tbl.rows || []).forEach((row, r) => {
      (row || []).forEach((cell, c) => {
        out.push({ path: ['tableBlocks', i, 'rows', r, c], kind: 'table', where: `Table cell (row ${r + 1}, column ${c + 1})`, html: false });
      });
    });
  });
  (step.annotations || []).forEach((a, i) => {
    out.push({ path: ['annotations', i, 'text'], kind: 'annotation', where: 'Annotation label', html: false });
  });
  return out;
}

function getAt(obj, pathParts) {
  let cur = obj;
  for (const key of pathParts) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function setAt(obj, pathParts, value) {
  let cur = obj;
  for (let i = 0; i < pathParts.length - 1; i++) cur = cur[pathParts[i]];
  cur[pathParts[pathParts.length - 1]] = value;
}

/** Plain text of an HTML text node, with the raw offset of each character. */
function decodeWithMap(raw) {
  let text = '';
  const rawAt = [];
  const plain = (str, from) => {
    for (let i = 0; i < str.length; i++) { text += str[i]; rawAt.push(from + i); }
  };
  let pos = 0;
  for (const m of raw.matchAll(ENTITY_RE)) {
    plain(raw.slice(pos, m.index), pos);
    const decoded = decodeEntities(m[0]);
    if (decoded === m[0]) plain(m[0], m.index); // unknown entity: ordinary characters
    else for (const unit of decoded) { for (let i = 0; i < unit.length; i++) { text += unit[i]; rawAt.push(m.index); } }
    pos = m.index + m[0].length;
  }
  plain(raw.slice(pos), pos);
  rawAt.push(raw.length);
  return { text, rawAt };
}

/**
 * The searchable text pieces of one field: an array of { text, rawAt? } for
 * an HTML field's text nodes, or a single { text } for a plain field. `parts`
 * lets the HTML writer put the field back together.
 */
function fieldNodes(value, html) {
  if (!html) return { parts: null, nodes: [{ text: String(value == null ? '' : value) }] };
  const parts = String(value == null ? '' : value).split(TAG_RE);
  const nodes = [];
  parts.forEach((part, i) => {
    if (i % 2 === 1 || part === '') return; // a tag, or nothing between two tags
    const decoded = decodeWithMap(part);
    nodes.push({ ...decoded, partIndex: i });
  });
  return { parts, nodes };
}

function protectedSpans(text) {
  const spans = [];
  for (const m of text.matchAll(new RegExp(TOKEN_RE.source, 'g'))) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/** Why `replacement` cannot go into a match's field, or null if it can. */
function refusalReason(match, replacement) {
  const text = String(replacement == null ? '' : replacement);
  if (match.kind === 'table') {
    if (text.includes('|')) return 'A table cell cannot contain “|”.';
    if (/[\r\n]/.test(text)) return 'A table cell cannot contain a line break.';
  }
  if ((match.kind === 'title' || match.kind === 'text-block-title') && /[\r\n]/.test(text)) {
    return 'A title cannot contain a line break.';
  }
  return null;
}

/**
 * List the matches of `query` in `steps` (an array of step objects, in guide
 * order). Options: caseSensitive, wholeWord, limit (stop after this many) and
 * replacement (when given, each match gets `blocked`: the refusal reason or
 * null). Each match is
 *   { id, stepId, stepIndex, kind, where, path, node, start, end, index,
 *     matched, before, after, blocked? }
 * where `path` locates the field in the step, `node` the text node inside an
 * HTML field (0 for plain fields), and start/end the offsets in that node's
 * text. `index` counts the matches within the field.
 */
function findMatches(steps, query, options = {}) {
  const { limit = Infinity, replacement } = options;
  const pattern = buildPattern(query, options);
  const matches = [];
  if (!pattern) return matches;

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex];
    for (const field of stepFields(step)) {
      const { nodes } = fieldNodes(getAt(step, field.path), field.html);
      let index = 0;
      for (let nodeNo = 0; nodeNo < nodes.length; nodeNo++) {
        const node = nodes[nodeNo];
        const spans = protectedSpans(node.text);
        pattern.lastIndex = 0;
        for (let m = pattern.exec(node.text); m; m = pattern.exec(node.text)) {
          const start = m.index;
          const end = start + m[0].length;
          if (spans.some(([s, e]) => start < e && end > s)) continue;
          const match = {
            id: `${step.stepId}|${field.path.join('.')}|${nodeNo}|${start}`,
            stepId: step.stepId,
            stepIndex,
            kind: field.kind,
            where: field.where,
            path: field.path,
            node: nodeNo,
            start,
            end,
            index: index++,
            matched: m[0],
            before: node.text.slice(Math.max(0, start - CONTEXT), start).replace(/\s+/g, ' '),
            after: node.text.slice(end, end + CONTEXT).replace(/\s+/g, ' '),
          };
          if (replacement !== undefined) match.blocked = refusalReason(match, replacement);
          matches.push(match);
          if (matches.length >= limit) return matches;
        }
      }
    }
  }
  return matches;
}

/** Replace the given [start, end) ranges of `text` (sorted, non-overlapping). */
function spliceText(text, edits, replacement) {
  let out = text;
  for (const { start, end } of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, start) + replacement + out.slice(end);
  }
  return out;
}

/**
 * Apply `matches` (as listed by findMatches) with `replacement` to `steps`.
 * Returns { steps, before, applied, refused, stale }: `steps` are edited
 * clones of only the steps that changed and `before` their originals (for an
 * undo record); `refused` and `stale` list the matches that were skipped,
 * with a reason for refusals. A match is stale when the
 * text it pointed at is no longer there. Nothing in `steps` is modified.
 */
function applyReplacements(steps, matches, replacement) {
  const text = String(replacement == null ? '' : replacement);
  const byId = new Map(steps.map((s) => [s.stepId, s]));
  const result = { steps: [], before: [], applied: 0, refused: [], stale: [] };
  const groups = new Map(); // stepId -> field key -> { path, matches }

  for (const match of matches || []) {
    if (!match || !Array.isArray(match.path) || !byId.has(match.stepId)) {
      result.stale.push(match && match.id);
      continue;
    }
    if (!groups.has(match.stepId)) groups.set(match.stepId, new Map());
    const fields = groups.get(match.stepId);
    const key = match.path.join('.');
    if (!fields.has(key)) fields.set(key, { path: match.path, matches: [] });
    fields.get(key).matches.push(match);
  }

  for (const [stepId, fields] of groups) {
    const original = byId.get(stepId);
    const step = deepClone(original);
    const known = new Map(stepFields(step).map((f) => [f.path.join('.'), f]));
    let changed = false;

    for (const [key, group] of fields) {
      const field = known.get(key);
      const stale = (m) => result.stale.push(m.id);
      if (!field) { group.matches.forEach(stale); continue; }
      // Judge the replacement by the field it really lands in, not the kind the caller sent.
      const reason = refusalReason(field, text);
      if (reason) { group.matches.forEach((m) => result.refused.push({ id: m.id, reason })); continue; }
      const { parts, nodes } = fieldNodes(getAt(step, field.path), field.html);

      // Check each match against the text it points at; apply the rest per node.
      const edits = new Map(); // node number -> [{ start, end }]
      for (const m of [...group.matches].sort((a, b) => (a.node - b.node) || (a.start - b.start) || 0)) {
        const node = nodes[m.node];
        const list = edits.get(m.node) || [];
        const last = list[list.length - 1];
        if (!Number.isInteger(m.node) || !node || !Number.isInteger(m.start) || !Number.isInteger(m.end)
          || node.text.slice(m.start, m.end) !== m.matched || (last && m.start < last.end)
          || protectedSpans(node.text).some(([s, e]) => m.start < e && m.end > s)) {
          stale(m);
          continue;
        }
        list.push({ start: m.start, end: m.end });
        edits.set(m.node, list);
      }
      if (!edits.size) continue;

      let next;
      if (!field.html) {
        next = spliceText(nodes[0].text, edits.get(0), text);
      } else {
        // Splice into the raw HTML so untouched text keeps its entities.
        const escaped = escapeText(text);
        for (const [nodeNo, list] of edits) {
          const node = nodes[nodeNo];
          let raw = parts[node.partIndex];
          for (const { start, end } of [...list].sort((a, b) => b.start - a.start)) {
            raw = raw.slice(0, node.rawAt[start]) + escaped + raw.slice(node.rawAt[end]);
          }
          parts[node.partIndex] = raw;
        }
        next = sanitizeHtml(parts.join(''));
      }
      setAt(step, field.path, next);
      result.applied += [...edits.values()].reduce((n, list) => n + list.length, 0);
      changed = true;
    }
    if (changed) {
      result.steps.push(step);
      result.before.push(deepClone(original));
    }
  }
  return result;
}

const isIndex = (n) => Number.isInteger(n) && n >= 0 && n <= 10_000_000;

/**
 * True when `m` has the shape of a match findMatches() made, as far as
 * applyReplacements() reads it: for checking matches that come back over IPC.
 * The path must also name a real field of the step, which applyReplacements()
 * checks itself; here it only has to be short and made of names and indexes.
 * main.js also checks stepId with its usual id rule.
 */
function isMatchArg(m) {
  return Boolean(m) && typeof m === 'object' && !Array.isArray(m)
    && typeof m.stepId === 'string' && m.stepId.length >= 1 && m.stepId.length <= 128
    && (m.id === undefined || (typeof m.id === 'string' && m.id.length <= 2000))
    && typeof m.matched === 'string' && m.matched.length <= 4000
    && Array.isArray(m.path) && m.path.length >= 1 && m.path.length <= 5
    && m.path.every((p) => (typeof p === 'string' && /^[A-Za-z]{1,32}$/.test(p)) || isIndex(p))
    && isIndex(m.node) && isIndex(m.start) && isIndex(m.end) && m.start <= m.end;
}

/** Escape replacement text for an HTML text node (quotes are fine there). */
function escapeText(text) {
  return escapeHtml(text).replace(/&quot;/g, '"');
}

module.exports = { findMatches, applyReplacements, refusalReason, buildPattern, isMatchArg };
