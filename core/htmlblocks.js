'use strict';

const { decodeEntities } = require('./util');

/**
 * Parse sanitized description HTML (see core/sanitize.js) into a flat list
 * of blocks with inline formatting runs, for renderers (PDF) that need to
 * preserve bold/italic/links/lists rather than flattening to plain text.
 *
 * Each block: { type, runs, indent, n? }
 *   type:   'p' | 'h1'..'h4' | 'blockquote' | 'li' | 'oli' | 'hr'
 *   runs:   [{ text, bold, italic, code, href }] (absent for 'hr')
 *   indent: list/quote nesting depth (0 = top level)
 *   n:      list item number, only for 'oli'
 */

const TAG_RE = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const HREF_RE = /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i;

function htmlToBlocks(html) {
  const blocks = [];
  let current = null;
  const styleStack = [{}];
  const context = []; // nesting of <ul>/<ol>/<blockquote>

  const indentLevel = () => context.length;
  const currentStyle = () => styleStack[styleStack.length - 1];

  const flushBlock = () => {
    if (!current) return;
    if (current.type === 'hr' || current.runs.some((r) => r.text.trim() !== '')) blocks.push(current);
    current = null;
  };
  const startBlock = (type, extra = {}) => {
    flushBlock();
    current = { type, runs: [], indent: indentLevel(), ...extra };
  };
  const pushText = (text) => {
    if (!text) return;
    if (!current) current = { type: 'p', runs: [], indent: indentLevel() };
    current.runs.push({ text, ...currentStyle() });
  };

  let last = 0;
  let m;
  while ((m = TAG_RE.exec(html)) !== null) {
    if (m.index > last) pushText(decodeEntities(html.slice(last, m.index)));
    last = TAG_RE.lastIndex;
    const closing = Boolean(m[1]);
    const tag = m[2].toLowerCase();
    const rawAttrs = m[3];

    switch (tag) {
      case 'p':
      case 'div':
        if (closing) flushBlock();
        else startBlock('p');
        break;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
        if (closing) flushBlock();
        else startBlock(tag);
        break;
      case 'blockquote':
        if (closing) { flushBlock(); context.pop(); }
        else { context.push({ kind: 'blockquote' }); startBlock('blockquote'); }
        break;
      case 'ul':
      case 'ol':
        if (closing) context.pop();
        else context.push({ kind: tag, counter: 0 });
        break;
      case 'li':
        if (closing) flushBlock();
        else {
          const ctx = context[context.length - 1];
          const depth = Math.max(0, indentLevel() - 1);
          if (ctx && ctx.kind === 'ol') { ctx.counter += 1; startBlock('oli', { n: ctx.counter, indent: depth }); }
          else startBlock('li', { indent: depth });
        }
        break;
      case 'br':
        flushBlock();
        break;
      case 'hr':
        flushBlock();
        blocks.push({ type: 'hr' });
        break;
      case 'b':
      case 'strong':
        if (closing) styleStack.pop();
        else styleStack.push({ ...currentStyle(), bold: true });
        break;
      case 'i':
      case 'em':
        if (closing) styleStack.pop();
        else styleStack.push({ ...currentStyle(), italic: true });
        break;
      case 'code':
      case 'pre':
        if (closing) styleStack.pop();
        else styleStack.push({ ...currentStyle(), code: true });
        break;
      case 'a':
        if (closing) styleStack.pop();
        else {
          const hrefM = HREF_RE.exec(rawAttrs);
          styleStack.push({ ...currentStyle(), href: hrefM ? (hrefM[1] ?? hrefM[2]) : undefined });
        }
        break;
      default:
        // Unrecognized/transparent allowed tags (table*, span, u, s, sub, sup):
        // no block or style change.
        break;
    }
  }
  pushText(decodeEntities(html.slice(last)));
  flushBlock();

  return blocks;
}

module.exports = { htmlToBlocks };
