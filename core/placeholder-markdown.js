'use strict';
const { escapeHtml, htmlToText } = require('./util');
const { sanitizeHtml } = require('./sanitize');

// Deliberately small Markdown subset for reusable text. Raw HTML is always text.
function markdownHtml(source) {
  const inline = text => {
    const slots = [];
    const slot = html => { slots.push(html); return `\u0000${slots.length - 1}\u0000`; };
    let escaped = escapeHtml(text.replace(/\u0000/g, ''));
    escaped = escaped.replace(/`([^`]+)`/g, (_, code) => slot(`<code>${code}</code>`));
    escaped = escaped.replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g, (_, label, url) =>
      /^(https?:|mailto:|step:|#)/i.test(url) ? slot(`<a href="${url}">${label}</a>`) : label);
    escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    return escaped.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
  };
  const out = [];
  let paragraph = [], list = null, code = null;
  const flush = () => { if (paragraph.length) out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph = []; };
  const closeList = () => { if (list) out.push(`</${list}>`); list = null; };
  for (const line of String(source).replace(/\r\n?/g, '\n').split('\n')) {
    if (/^```/.test(line)) {
      flush(); closeList();
      if (code) { out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; }
      else code = [];
      continue;
    }
    if (code) { code.push(line); continue; }
    const item = /^(?:([-*])|\d+\.)\s+(.+)$/.exec(line);
    if (item) {
      flush(); const kind = item[1] ? 'ul' : 'ol';
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline(item[2])}</li>`); continue;
    }
    closeList();
    if (!line.trim()) flush();
    else paragraph.push(line);
  }
  flush(); closeList();
  if (code) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  return sanitizeHtml(out.join(''));
}
const isMarkdown = value => value && typeof value === 'object' && value.format === 'markdown' && typeof value.text === 'string';
const placeholderText = value => isMarkdown(value) ? htmlToText(markdownHtml(value.text)) : String(value ?? '');
module.exports = { markdownHtml, isMarkdown, placeholderText };
