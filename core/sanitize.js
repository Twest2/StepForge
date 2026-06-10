'use strict';

/**
 * Allowlist HTML sanitizer for guide/step description fragments.
 *
 * Descriptions are stored as sanitized HTML and re-sanitized before display
 * or export, so this is the single place that defines what rich text may
 * contain. No scripts, no event handlers, no styles, no embedded resources.
 */

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup',
  'ul', 'ol', 'li', 'a', 'code', 'pre', 'blockquote',
  'h1', 'h2', 'h3', 'h4',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'div',
]);

const VOID_TAGS = new Set(['br', 'hr']);

// href schemes a link may use. step: is the internal step-link scheme.
const SAFE_HREF = /^(https?:|mailto:|step:|#)/i;

const ALLOWED_ATTRS = {
  a: ['href', 'data-step-id'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
};

function sanitizeAttrs(tag, rawAttrs) {
  const allowed = ALLOWED_ATTRS[tag];
  if (!allowed || !rawAttrs) return '';
  let out = '';
  const attrRe = /([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = attrRe.exec(rawAttrs)) !== null) {
    const name = m[1].toLowerCase();
    if (!allowed.includes(name)) continue;
    const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
    if (name === 'href' && !SAFE_HREF.test(value.trim())) continue;
    if (/[<>"]/.test(value)) continue;
    out += ` ${name}="${value.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')}"`;
  }
  return out;
}

/**
 * Sanitize an HTML fragment. Unknown/dangerous tags are dropped entirely
 * (their text content is kept); script/style/iframe content is removed
 * including the text inside.
 */
function sanitizeHtml(html) {
  if (html == null) return '';
  let text = String(html);
  // Remove comments and the content of actively dangerous containers.
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(script|style|iframe|object|embed|template)\b[\s\S]*?<\/\1\s*>/gi, '');
  text = text.replace(/<(script|style|iframe|object|embed|template)\b[^>]*>/gi, '');

  return text.replace(
    /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g,
    (whole, slash, rawTag, rawAttrs) => {
      const tag = rawTag.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return '';
      if (slash) return VOID_TAGS.has(tag) ? '' : `</${tag}>`;
      if (VOID_TAGS.has(tag)) return `<${tag}>`;
      return `<${tag}${sanitizeAttrs(tag, rawAttrs)}>`;
    }
  );
}

module.exports = { sanitizeHtml, ALLOWED_TAGS };
