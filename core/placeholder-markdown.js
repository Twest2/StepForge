'use strict';
const { escapeHtml, htmlToText } = require('./util');
const { sanitizeHtml } = require('./sanitize');

// A small Markdown subset for descriptions and reusable text: **bold**,
// *italic*, ~~strikethrough~~, `code`, links, # headings, > quotes, lists
// (nested by indenting), tables, --- dividers and ``` code blocks.
// Raw HTML is always text.

function inline(text) {
  const slots = [];
  const slot = html => { slots.push(html); return `\u0000${slots.length - 1}\u0000`; };
  let escaped = escapeHtml(text.replace(/\u0000/g, ''));
  escaped = escaped.replace(/`([^`]+)`/g, (_, code) => slot(`<code>${code}</code>`));
  escaped = escaped.replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g, (_, label, url) =>
    /^(https?:|mailto:|step:|#)/i.test(url) ? slot(`<a href="${url}">${label}</a>`) : label);
  // As in CommonMark, `5 * 3 * 2` stays text: emphasis can't open or close on a space.
  escaped = escaped.replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, '<em>$1</em>')
    .replace(/~~(?!\s)([^~\n]+?)(?<!\s)~~/g, '<s>$1</s>');
  return escaped.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
// Any spacing counts, including non-breaking spaces that pasted text often has.
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^(\s*)(?:([-*+])|\d+[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const FENCE = /^\s*```/;

/** The cells of a table row: outer pipes dropped, `\|` kept as a pipe. */
function tableCells(line) {
  const cells = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
  return cells;
}

const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length
  && lines[i + 1].includes('-') && lines[i + 1].includes('|') && TABLE_DIVIDER.test(lines[i + 1]);

const indentOf = (spaces) => spaces.replace(/\t/g, '    ').length;

function blocksHtml(lines) {
  const out = [];
  let paragraph = [];
  // Open lists, outermost first: { kind: 'ul' | 'ol', indent }. Each has an open <li>.
  let lists = [];
  let blankInList = false;
  const flush = () => { if (paragraph.length) out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph = []; };
  const closeListsTo = (depth) => {
    while (lists.length > depth) out.push(`</li></${lists.pop().kind}>`);
  };
  const closeLists = () => { closeListsTo(0); blankInList = false; };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (FENCE.test(line)) {
      flush(); closeLists();
      const code = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      flush();
      if (lists.length) blankInList = true;
      continue;
    }

    // Checked before list items, so "* * *" and "- - -" are dividers.
    if (RULE.test(line)) { flush(); closeLists(); out.push('<hr>'); continue; }

    const item = ITEM.exec(line);
    if (item) {
      flush(); blankInList = false;
      const indent = indentOf(item[1]);
      const kind = item[2] ? 'ul' : 'ol';
      while (lists.length && lists[lists.length - 1].indent > indent) closeListsTo(lists.length - 1);
      const top = lists[lists.length - 1];
      if (top && top.indent === indent && top.kind === kind) out.push('</li>');
      else {
        if (top && top.indent === indent) closeListsTo(lists.length - 1);
        out.push(`<${kind}>`);
        lists.push({ kind, indent });
      }
      out.push(`<li>${inline(item[3])}`);
      continue;
    }

    // An indented line right under a list item continues that item.
    if (lists.length && !blankInList && /^\s{2,}\S/.test(line)) {
      out.push(`<br>${inline(line.trim())}`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush(); closeLists();
      const level = Math.min(heading[1].length, 4);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (QUOTE.test(line)) {
      flush(); closeLists();
      const quoted = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) quoted.push(QUOTE.exec(lines[i])[1]);
      i--;
      out.push(`<blockquote>${blocksHtml(quoted)}</blockquote>`);
      continue;
    }

    if (isTableStart(lines, i)) {
      flush(); closeLists();
      const head = tableCells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(tableCells(lines[i]));
      i--;
      const cells = (row, tag) => head.map((_, c) => `<${tag}>${inline(row[c] ?? '')}</${tag}>`).join('');
      out.push(`<table><thead><tr>${cells(head, 'th')}</tr></thead>`
        + (rows.length ? `<tbody>${rows.map(row => `<tr>${cells(row, 'td')}</tr>`).join('')}</tbody>` : '')
        + '</table>');
      continue;
    }

    closeLists();
    paragraph.push(line);
  }
  flush(); closeLists();
  return out.join('');
}

function markdownHtml(source) {
  return sanitizeHtml(blocksHtml(String(source).replace(/\r\n?/g, '\n').split('\n')));
}

const isMarkdown = value => value && typeof value === 'object' && value.format === 'markdown' && typeof value.text === 'string';
const placeholderText = value => isMarkdown(value) ? htmlToText(markdownHtml(value.text)) : String(value ?? '');
module.exports = { markdownHtml, isMarkdown, placeholderText };
