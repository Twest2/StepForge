'use strict';

const { decodeEntities } = require('../core/util');

/**
 * Convert sanitized description HTML fragments to Markdown. Handles the tags
 * the sanitizer allows; anything unexpected degrades to its text content.
 */

function htmlToMarkdown(html) {
  if (!html) return '';
  let out = String(html);

  // tables first (their inner tags would otherwise be consumed)
  out = out.replace(/<table>([\s\S]*?)<\/table>/gi, (m, body) => tableToMd(body));

  out = out
    .replace(/<pre>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (m, code) => `\n\`\`\`\n${decodeEntities(code)}\n\`\`\`\n`)
    .replace(/<pre>([\s\S]*?)<\/pre>/gi, (m, code) => `\n\`\`\`\n${decodeEntities(code)}\n\`\`\`\n`)
    .replace(/<h1>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<h4>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
    .replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, (m, q) => `\n> ${stripTags(q).trim().replace(/\n/g, '\n> ')}\n`)
    .replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<u>([\s\S]*?)<\/u>/gi, '$1')
    .replace(/<s>([\s\S]*?)<\/s>/gi, '~~$1~~')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (m, c) => `\`${decodeEntities(c)}\``)
    .replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
      if (href.startsWith('step:')) return `[${stripTags(label)}](#step-${href.slice(5)})`;
      return `[${stripTags(label)}](${href})`;
    })
    .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1');

  // lists
  out = out.replace(/<ol>([\s\S]*?)<\/ol>/gi, (m, body) => listToMd(body, true));
  out = out.replace(/<ul>([\s\S]*?)<\/ul>/gi, (m, body) => listToMd(body, false));

  out = out
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<p>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<div>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  return decodeEntities(out).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function listToMd(body, ordered) {
  let i = 0;
  const items = [];
  for (const m of body.matchAll(/<li>([\s\S]*?)<\/li>/gi)) {
    i += 1;
    const text = stripTags(m[1]).trim();
    items.push(ordered ? `${i}. ${text}` : `- ${text}`);
  }
  return `\n${items.join('\n')}\n`;
}

function tableToMd(body) {
  const rows = [];
  for (const rowM of body.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
    const cells = [];
    for (const cellM of rowM[1].matchAll(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi)) {
      cells.push(stripTags(cellM[2]).trim().replace(/\|/g, '\\|'));
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

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ''));
}

module.exports = { htmlToMarkdown };
