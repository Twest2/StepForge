'use strict';

const { escapeHtml } = require('./util');
const { placeholderText } = require('./placeholder-markdown');
const { systemPlaceholders } = require('./placeholders');

/**
 * Placeholders for AI: which ones a model or agent may use in text, and the
 * rules for the ones it creates. Placeholders go in descriptions and blocks,
 * not titles: the step list and library show titles as typed.
 */

// Same characters a [[token]] accepts (core/placeholders.js TOKEN_RE).
const PLACEHOLDER_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,39}$/;
// A value longer than this (or with a line break) is a paragraph, such as a
// [[stepforge]] credit, not something that reads naturally inside a sentence.
const MAX_INLINE_VALUE_CHARS = 80;
const BUILT_IN_NAMES = Object.keys(systemPlaceholders(null));

function cleanPlaceholderName(name) {
  return String(name ?? '').trim().replace(/^\[\[|\]\]$/g, '').trim();
}

function isValidPlaceholderName(name) {
  return PLACEHOLDER_NAME_RE.test(name) && !BUILT_IN_NAMES.includes(name);
}

/** A value that can stand in for words in a sentence: one short line. */
function isInlineValue(value) {
  return Boolean(value) && value.length <= MAX_INLINE_VALUE_CHARS && !/\n/.test(value);
}

/**
 * The placeholders AI may use in this guide: { name, value, scope }, guide
 * placeholders first (they win over global ones with the same name, as in exports).
 */
function usablePlaceholders({ globals = {}, guidePlaceholders = {} } = {}) {
  const out = [];
  const seen = new Set();
  for (const [scope, values] of [['guide', guidePlaceholders], ['global', globals]]) {
    for (const [name, raw] of Object.entries(values || {})) {
      if (seen.has(name)) continue;
      seen.add(name);
      const value = placeholderText(raw).trim();
      if (isInlineValue(value)) out.push({ name, value, scope });
    }
  }
  return out;
}

/** Prompt lines describing the placeholders, or [] when there are none. */
function placeholderPromptLines(list) {
  if (!list.length) return [];
  return [
    'Placeholders (write the [[name]] token instead of its value in descriptions and blocks, never in titles):',
    ...list.map((p) => `- [[${p.name}]] = ${JSON.stringify(p.value)}`),
  ];
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace each placeholder's value with its [[name]] token in description
 * HTML. Matches whole words only, never inside tags, existing tokens, or
 * inline code, and tries longer values first so "StepForge Setup" wins over
 * "StepForge".
 */
function substitutePlaceholders(html, list) {
  const usable = list
    .filter((p) => p.value.length >= 3 && /[A-Za-z0-9]/.test(p.value))
    .sort((a, b) => b.value.length - a.value.length);
  if (!html || !usable.length) return html || '';
  let inCode = 0;
  return String(html).split(/(<[^>]+>)/g).map((part) => {
    if (part.startsWith('<')) {
      if (/^<code\b/i.test(part)) inCode += 1;
      else if (/^<\/code>/i.test(part)) inCode = Math.max(0, inCode - 1);
      return part;
    }
    if (inCode || !part) return part;
    let out = part;
    for (const p of usable) {
      const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(escapeHtml(p.value))}(?![A-Za-z0-9_])`, 'g');
      // Tokens, existing or just inserted, are never matched into.
      out = out.split(/(\[\[[^\]]*\]\])/g)
        .map((piece) => (piece.startsWith('[[') ? piece : piece.replace(re, (match, before) => `${before}[[${p.name}]]`)))
        .join('');
    }
    return out;
  }).join('');
}

module.exports = {
  BUILT_IN_NAMES,
  MAX_INLINE_VALUE_CHARS,
  cleanPlaceholderName,
  isValidPlaceholderName,
  isInlineValue,
  usablePlaceholders,
  placeholderPromptLines,
  substitutePlaceholders,
};
