'use strict';

const { htmlToBlocks } = require('../core/htmlblocks');

/**
 * Step text for slides: sanitized description HTML as paragraphs of
 * formatted runs, ready to measure and split.
 *
 * Each paragraph is { text, runs, list, quote, heading }:
 *   runs:  [{ text, bold, italic, strike, code, href }]
 *   text:  the runs' text joined, whitespace collapsed to single spaces and
 *          trimmed, so it wraps and splits the same way it's measured
 *   list:  { ordered, n, level } for a list item, else null
 *   quote: true inside a block quote; heading: true for a heading
 * A line break inside a paragraph starts a new paragraph (a list item's
 * continuation keeps its indent, without a bullet). Table rows come out as
 * { rows } groups, in place.
 */

/** Runs with whitespace collapsed across them, leading and trailing space dropped. */
function normalizeRuns(runs) {
  const out = [];
  let prevSpace = true;
  for (const run of runs) {
    let text = '';
    for (const ch of run.text.replace(/\s/g, ' ')) {
      if (ch === ' ' && prevSpace) continue;
      text += ch;
      prevSpace = ch === ' ';
    }
    if (text) out.push({ ...run, text });
  }
  // Trailing space.
  while (out.length && out[out.length - 1].text.endsWith(' ')) {
    const last = out[out.length - 1];
    last.text = last.text.slice(0, -1);
    if (!last.text) out.pop();
  }
  return out;
}

/** Split runs at line breaks into one run list per line. */
function splitLines(runs) {
  const lines = [[]];
  for (const run of runs) {
    run.text.split('\n').forEach((part, i) => {
      if (i) lines.push([]);
      if (part) lines[lines.length - 1].push({ ...run, text: part });
    });
  }
  return lines;
}

/** The runs between character offsets `start` and `end` of their joined text. */
function sliceRuns(runs, start, end = Infinity) {
  const out = [];
  let at = 0;
  for (const run of runs) {
    const from = Math.max(start, at);
    const to = Math.min(end, at + run.text.length);
    if (to > from) out.push({ ...run, text: run.text.slice(from - at, to - at) });
    at += run.text.length;
  }
  return normalizeRuns(out);
}

const joinRuns = (runs) => runs.map((r) => r.text).join('');

function richParagraphs(html) {
  const out = [];
  let table = null;
  for (const block of htmlToBlocks(html || '')) {
    if (block.type === 'tr') {
      if (!table) { table = { rows: [] }; out.push(table); }
      table.rows.push(block.cells.map((c) => String(c ?? '')));
      continue;
    }
    table = null;
    if (block.type === 'hr') continue;
    const isList = block.type === 'li' || block.type === 'oli';
    splitLines(block.runs).forEach((lineRuns, i) => {
      const runs = normalizeRuns(lineRuns);
      if (!runs.length) return;
      const continued = block.cont || i > 0;
      out.push({
        runs,
        text: joinRuns(runs),
        list: isList ? { ordered: block.type === 'oli', n: block.n || 1, level: block.indent || 0, continued } : null,
        quote: block.type === 'blockquote',
        heading: /^h[1-4]$/.test(block.type),
      });
    });
  }
  return out;
}

/** Plain text for a paragraph with its list marker: "• item", "2. item". */
function markedText(para) {
  if (!para.list) return para.text;
  const indent = '  '.repeat(para.list.level);
  if (para.list.continued) return `${indent}  ${para.text}`;
  return `${indent}${para.list.ordered ? `${para.list.n}.` : '•'} ${para.text}`;
}

module.exports = { richParagraphs, sliceRuns, joinRuns, normalizeRuns, markedText };
