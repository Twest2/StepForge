'use strict';

/**
 * Advance widths (1/1000 em) of printable ASCII (32–126) in the standard PDF
 * fonts Helvetica and Helvetica-Bold, from Adobe's core-font metrics. Their
 * oblique styles have the same widths, and Courier is 600 for every glyph.
 * Used where a drawing must line up with text a viewer lays out itself,
 * such as a line through struck-out words.
 */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

// PDF font resources (core/pdf.js FONT_FAMILIES) -> width table, or a fixed width.
const WIDTHS = { F1: HELVETICA, F4: HELVETICA, F2: HELVETICA_BOLD, F5: HELVETICA_BOLD, F3: 600, F6: 600, F7: 600, F8: 600 };

/**
 * Width of `text` in `font` at `size` points when every character is
 * printable ASCII and the font has a table here; otherwise null.
 */
function standardTextWidth(text, size, font) {
  const table = WIDTHS[font];
  if (!table) return null;
  let units = 0;
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) return null;
    units += typeof table === 'number' ? table : table[code - 32];
  }
  return (units * size) / 1000;
}

module.exports = { HELVETICA, HELVETICA_BOLD, standardTextWidth };
