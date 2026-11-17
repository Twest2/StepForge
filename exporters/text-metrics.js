'use strict';

const { fontKind } = require('./branding');

/**
 * Estimates how much room text takes when an app we don't control (PowerPoint,
 * LibreOffice, Keynote) sets it: line breaks, line count and height. Exporters
 * that position text boxes themselves use it so boxes never overlap.
 *
 * Widths come from per-character classes of a typical sans-serif, scaled for
 * the font's family. The estimates lean wide, so text wraps a little earlier
 * here than on screen and boxes have room to spare rather than overflowing.
 */

const EMU_PER_PT = 12700;
// Single line spacing in Office is about 1.2 × the font size.
const LINE_HEIGHT = 1.2;
// Text is measured this much wider than the estimate, for fonts we don't know.
const SAFETY = 1.06;

// Advance widths as a fraction of the font size (em), for an Arial-like sans.
const NARROW = new Set("ijl|!.,:;'`".split(''));
const SEMI = new Set('frtI()[]{}/\\-"'.split(''));
const WIDE = new Set('mwMW@%'.split(''));

// How much wider (or narrower) a family sets than Arial.
const FAMILY_SCALE = [
  [/calibri|carlito|candara|corbel/i, 0.92],
  [/times|liberation serif|tinos/i, 0.92],
  [/cambria|caladea|constantia|garamond|palatino|book antiqua/i, 0.98],
  [/georgia|merriweather|lora/i, 1.06],
  [/open sans|source sans|noto sans|lato|roboto|inter|segoe/i, 1.04],
  [/verdana|tahoma|trebuchet|franklin/i, 1.12],
  [/montserrat|century gothic|poppins|raleway|nunito/i, 1.16],
];

function familyScale(font) {
  const name = String(font || '');
  for (const [re, scale] of FAMILY_SCALE) if (re.test(name)) return scale;
  return 1;
}

function isWideGlyph(code) {
  return (code >= 0x1100 && code <= 0x115F) // Hangul Jamo
    || (code >= 0x2E80 && code <= 0xA4CF) // CJK, kana, Yi
    || (code >= 0xAC00 && code <= 0xD7A3) // Hangul syllables
    || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0xFE30 && code <= 0xFE4F)
    || (code >= 0xFF00 && code <= 0xFF60)
    || (code >= 0xFFE0 && code <= 0xFFE6)
    || code >= 0x1F300; // emoji
}

/** The width of one character, in ems, for an Arial-like sans. */
function charEm(ch) {
  if (ch === ' ') return 0.28;
  const code = ch.codePointAt(0);
  if (isWideGlyph(code)) return 1;
  if (NARROW.has(ch)) return 0.25;
  if (SEMI.has(ch)) return 0.34;
  if (WIDE.has(ch)) return 0.88;
  if (ch >= 'A' && ch <= 'Z') return 0.68;
  if (ch >= '0' && ch <= '9') return 0.56;
  if (ch >= 'a' && ch <= 'z') return 0.52;
  // Accented Latin, Cyrillic, Greek and the rest: a generous average.
  return 0.6;
}

/** A measurer for one font, size (pt) and weight: `width(text)` in points. */
function fontMetrics({ size, font = '', bold = false } = {}) {
  const mono = fontKind(font) === 'mono';
  const scale = (mono ? 1 : familyScale(font)) * (bold ? 1.07 : 1) * SAFETY;
  const width = (text) => {
    let em = 0;
    for (const ch of String(text)) em += mono ? (isWideGlyph(ch.codePointAt(0)) ? 1.2 : 0.6) : charEm(ch);
    return em * size * scale;
  };
  return { size, width, lineHeight: size * LINE_HEIGHT };
}

/** Split a word wider than `maxPt` into pieces that fit. */
function breakWord(word, maxPt, width) {
  const pieces = [];
  let piece = '';
  for (const ch of word) {
    if (piece && width(piece + ch) > maxPt) {
      pieces.push(piece);
      piece = ch;
    } else {
      piece += ch;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/**
 * The lines one paragraph wraps to in a box `widthEmu` wide. Breaks at spaces;
 * a word longer than a line (or text with no spaces, like Chinese) breaks
 * between characters. An empty paragraph is one empty line.
 */
function wrapParagraph(text, widthEmu, metrics) {
  const maxPt = Math.max(1, widthEmu / EMU_PER_PT);
  const { width } = metrics;
  const tokens = String(text).split(/(\s+)/).filter((tok) => tok !== '');
  const lines = [];
  let line = '';
  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      if (line) line += ' ';
      continue;
    }
    const candidate = line + token;
    if (width(candidate.trimEnd()) <= maxPt) {
      line = candidate;
      continue;
    }
    if (line.trim()) lines.push(line.trimEnd());
    line = '';
    if (width(token) <= maxPt) {
      line = token;
    } else {
      const pieces = breakWord(token, maxPt, width);
      lines.push(...pieces.slice(0, -1));
      line = pieces[pieces.length - 1] || '';
    }
  }
  lines.push(line.trimEnd());
  return lines;
}

/** Lines for text that may hold several paragraphs (split on newlines). */
function wrapText(text, widthEmu, metrics) {
  return String(text ?? '').split('\n').map((para) => wrapParagraph(para, widthEmu, metrics));
}

/**
 * The height (EMU) of paragraphs set at `metrics`, with `spaceAfterPt`
 * between paragraphs (not after the last).
 */
function textHeight(text, widthEmu, metrics, { spaceAfterPt = 0 } = {}) {
  const paras = wrapText(text, widthEmu, metrics);
  const lines = paras.reduce((sum, p) => sum + p.length, 0);
  return Math.ceil((lines * metrics.lineHeight + Math.max(0, paras.length - 1) * spaceAfterPt) * EMU_PER_PT);
}

/** `text` cut to fit on one line `widthEmu` wide, with an ellipsis when cut. */
function fitOneLine(text, widthEmu, metrics) {
  const maxPt = widthEmu / EMU_PER_PT;
  const value = String(text ?? '');
  if (metrics.width(value) <= maxPt) return value;
  let cut = value;
  while (cut && metrics.width(`${cut}…`) > maxPt) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

module.exports = {
  EMU_PER_PT,
  LINE_HEIGHT,
  fontMetrics,
  wrapParagraph,
  wrapText,
  textHeight,
  fitOneLine,
};
