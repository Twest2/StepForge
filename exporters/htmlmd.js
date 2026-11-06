'use strict';

const { decodeEntities } = require('../core/util');

/**
 * Convert sanitized description HTML fragments to Markdown. Handles the tags
 * the sanitizer allows; anything unexpected degrades to its text content.
 */

function htmlToMarkdown(html) {
  if (!html) return '';
  return decodeEntities(tidy(convert(String(html)))).trim();
}

const tidy = (md) => md.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');

// Innermost first, so nested quotes and lists keep their structure.
const INNER_QUOTE = /<blockquote>((?:(?!<\/?blockquote>)[\s\S])*?)<\/blockquote>/i;
const INNER_LIST = /<(ul|ol)>((?:(?!<\/?(?:ul|ol)>)[\s\S])*?)<\/\1>/i;

/** Markdown with entities still encoded (see stripTags). */
function convert(html) {
  let out = html;

  // tables first (their inner tags would otherwise be consumed)
  out = out.replace(/<table>([\s\S]*?)<\/table>/gi, (m, body) => tableToMd(body));

  // A quote's contents are converted on their own, then every line gets "> ".
  while (INNER_QUOTE.test(out)) {
    out = out.replace(INNER_QUOTE, (m, q) => {
      const inner = tidy(convert(q)).trim();
      return `\n${inner.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')}\n`;
    });
  }

  out = out
    .replace(/<pre>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<pre>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<h1>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<h4>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
    .replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<u>([\s\S]*?)<\/u>/gi, '$1')
    .replace(/<s>([\s\S]*?)<\/s>/gi, '~~$1~~')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
      if (href.startsWith('step:')) return `[${stripTags(label)}](#step-${href.slice(5)})`;
      return `[${stripTags(label)}](${href})`;
    })
    .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1');

  // lists
  while (INNER_LIST.test(out)) {
    out = out.replace(INNER_LIST, (m, tag, body) => listToMd(body, tag.toLowerCase() === 'ol'));
  }

  out = out
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<p>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<div>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  return out;
}

function listToMd(body, ordered) {
  let i = 0;
  const items = [];
  for (const m of body.matchAll(/<li>([\s\S]*?)<\/li>/gi)) {
    i += 1;
    const marker = ordered ? `${i}. ` : '- ';
    // A nested list is already Markdown text here; indent it under its item.
    const lines = stripTags(m[1].replace(/<br\s*\/?>/gi, '\n')).trim().split('\n').filter((line) => line.trim());
    items.push(`${marker}${(lines.shift() || '').trim()}`, ...lines.map((line) => `${' '.repeat(marker.length)}${line}`));
  }
  return `\n${items.join('\n')}\n`;
}

function tableToMd(body) {
  const rows = [];
  for (const rowM of body.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
    const cells = [];
    for (const cellM of rowM[1].matchAll(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi)) {
      cells.push(convert(cellM[2]).trim().replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|'));
    }
    rows.push(cells);
  }
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => { while (r.length < width) r.push(''); return r; };
  const lines = [`| ${pad(rows[0]).join(' | ')} |`, `|${' --- |'.repeat(width)}`];
  for (const row of rows.slice(1)) lines.push(`| ${pad(row).join(' | ')} |`);
  return `\n${lines.join('\n')}\n`;
}

// Entities stay encoded until htmlToMarkdown's final decode, so escaped text
// such as `&lt;b&gt;` is never mistaken for a tag and decoded only once.
function stripTags(html) {
  return String(html).replace(/<[^>]+>/g, '');
}

module.exports = { htmlToMarkdown };
