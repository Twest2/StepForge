'use strict';

/**
 * Line breaking shared by the editor canvas (app/renderer/canvas.js), the
 * export rasterizer (core/raster.js, core/text-raster.js) and PDF text
 * (core/pdf.js), so a tooltip wraps the same way on screen and in exports.
 *
 * Text breaks at spaces and at the line breaks the writer typed. Chinese,
 * Japanese and Korean have no spaces between words, so a line may also
 * break between any two of their characters, except before closing
 * punctuation (、。」…) or after opening punctuation (「（…). A word too
 * wide for the line on its own is split between characters.
 *
 * Widths come from a `measure(text)` function, so each caller uses its own
 * font: the canvas's measureText, or the export fonts' glyph advances.
 */
(function attachTextWrap(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.StepForgeTextWrap = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const WIDE = /[ᄀ-ᇿ⺀-〿぀-ヿ㄀-ㇿ㈀-鿿가-힯豈-﫿︰-﹏＀-￯\u{20000}-\u{3134f}]/u;
  const NO_BREAK_BEFORE = new Set([...'、。，．：；！？）」』】〉》〕｝〙〗”’ゝゞーヽヾ々ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ']);
  const NO_BREAK_AFTER = new Set([...'（「『【〈《〔｛〘〖“‘']);

  /** True for a character that takes two columns in monospaced text. */
  const isWide = (ch) => WIDE.test(ch);

  /**
   * Split a word (no spaces) into the pieces a line may break between: each
   * Chinese, Japanese or Korean character on its own, other text kept whole.
   */
  function breakChunks(word) {
    const chunks = [];
    let prev = '';
    for (const ch of String(word)) {
      const breakable = chunks.length && (isWide(ch) || isWide(prev))
        && !NO_BREAK_BEFORE.has(ch) && !NO_BREAK_AFTER.has(prev);
      if (!chunks.length || breakable) chunks.push(ch);
      else chunks[chunks.length - 1] += ch;
      prev = ch;
    }
    return chunks;
  }

  /** A piece wider than the line, cut between characters (never inside one). */
  function splitWide(piece, maxWidth, measure) {
    const out = [];
    let cur = '';
    for (const ch of Array.from(piece)) {
      if (cur && measure(cur + ch) > maxWidth) { out.push(cur); cur = ch; } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }

  /** The lines `text` takes at `maxWidth`. An empty typed line stays empty. */
  function wrapLines(text, maxWidth, measure) {
    const lines = [];
    for (const para of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
      let line = '';
      const place = (piece, glue) => {
        const next = line ? line + glue + piece : piece;
        if (!line || measure(next) <= maxWidth) { line = next; return; }
        lines.push(line);
        line = piece;
      };
      for (const word of para.split(/[^\S\n]+/).filter(Boolean)) {
        breakChunks(word).forEach((chunk, i) => {
          const glue = i ? '' : ' ';
          if (measure(chunk) <= maxWidth) { place(chunk, glue); return; }
          splitWide(chunk, maxWidth, measure).forEach((part, j) => place(part, j ? '' : glue));
        });
      }
      lines.push(line);
    }
    return lines;
  }

  /** `line` shortened with an ellipsis to fit `maxWidth`. */
  function ellipsize(line, maxWidth, measure) {
    const chars = Array.from(line);
    while (chars.length && measure(`${chars.join('').trimEnd()}…`) > maxWidth) chars.pop();
    return `${chars.join('').trimEnd()}…`;
  }

  /**
   * Lay out tooltip text in a box: wrapped at the annotation's font size,
   * and only if that's too tall, at a smaller size (down to minSize), the
   * same smaller size for every line. Text is never squeezed sideways.
   * If it still doesn't fit at minSize, the last line that fits ends in "…".
   * `measure(text, size)` gives a width at a font size.
   * Returns { lines, size, lineHeight }.
   */
  function layoutBoxText({ text, width, height, size, minSize = Math.min(size, 8), lineHeight = 1.25, measure }) {
    const w = Math.max(1, width);
    let s = size;
    for (;;) {
      const at = (str) => measure(str, s);
      const lines = wrapLines(text, w, at);
      const fits = lines.length * s * lineHeight <= height;
      if (fits || s <= minSize) {
        const max = Math.max(1, Math.floor(height / (s * lineHeight) + 1e-6));
        if (lines.length > max) {
          lines.length = max;
          lines[max - 1] = ellipsize(lines[max - 1], w, at);
        }
        return { lines, size: s, lineHeight: s * lineHeight };
      }
      s = Math.max(minSize, s * 0.9);
    }
  }

  /** A tooltip's inner padding, on each side, for text at `size` px. */
  const tooltipPadding = (size) => ({ x: Math.max(4, size * 0.5), y: Math.max(2, size * 0.25) });

  /** The height (px) a tooltip `width` px wide needs for `text` at `size` px. */
  function tooltipHeight({ text, width, size, lineHeight = 1.25, measure }) {
    const pad = tooltipPadding(size);
    const lines = wrapLines(text, Math.max(1, width - pad.x * 2), (str) => measure(str, size));
    return lines.length * size * lineHeight + pad.y * 2;
  }

  return { isWide, breakChunks, wrapLines, ellipsize, layoutBoxText, tooltipPadding, tooltipHeight };
});
