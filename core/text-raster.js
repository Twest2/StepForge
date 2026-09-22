'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { decodePng } = require('./png');

/**
 * Anti-aliased text for the software rasterizer. Glyphs come from Lato
 * atlases rendered at 64px (see scripts/make-font-atlas.js) and are
 * resampled to the requested size: box-filtered when shrinking, bilinear
 * when enlarging. Characters outside the atlas render as '?'.
 */

const FONT_DIR = path.join(__dirname, 'fonts');
const CAP_HEIGHT = 0.72; // Lato cap height as a fraction of font size
const LINE_HEIGHT = 1.25; // matches the editor canvas
const faces = new Map();

function face(weight = 'regular') {
  const id = weight === 'bold' ? 'bold' : 'regular';
  if (!faces.has(id)) {
    const meta = JSON.parse(fs.readFileSync(path.join(FONT_DIR, `sans-${id}.json`), 'utf8'));
    const png = decodePng(fs.readFileSync(path.join(FONT_DIR, `sans-${id}.png`)));
    const alpha = new Uint8Array(png.width * png.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = png.data[i * 4 + 3];
    faces.set(id, { ...meta, cellH: meta.ascent + meta.descent, alpha });
  }
  return faces.get(id);
}

function glyph(f, ch) {
  return f.glyphs[ch.codePointAt(0)] || f.glyphs[63];
}

function lineWidth(line, sizePx, weight) {
  const f = face(weight);
  let w = 0;
  for (const ch of line) w += glyph(f, ch)[4];
  return (w * sizePx) / f.size;
}

function measureText(text, sizePx, weight) {
  const lines = String(text).split('\n');
  const lineHeight = sizePx * LINE_HEIGHT;
  return {
    width: Math.ceil(Math.max(0, ...lines.map((l) => lineWidth(l, sizePx, weight)))),
    height: Math.ceil(lines.length * lineHeight),
    lineHeight,
  };
}

function coverageAt(f, gx, gy, gw, x0, y0, x1, y1) {
  // Average atlas alpha over the source footprint [x0,x1)x[y0,y1) of one glyph cell.
  const cx0 = Math.max(0, Math.floor(x0)), cx1 = Math.min(gw, Math.ceil(x1));
  const cy0 = Math.max(0, Math.floor(y0)), cy1 = Math.min(f.cellH, Math.ceil(y1));
  if (cx1 <= cx0 || cy1 <= cy0) return 0;
  let sum = 0, area = 0;
  for (let y = cy0; y < cy1; y++) {
    const wy = Math.min(y + 1, y1) - Math.max(y, y0);
    const row = (gy + y) * f.width + gx;
    for (let x = cx0; x < cx1; x++) {
      const wx = Math.min(x + 1, x1) - Math.max(x, x0);
      sum += f.alpha[row + x] * wx * wy;
      area += wx * wy;
    }
  }
  return area ? sum / ((x1 - x0) * (y1 - y0)) : 0;
}

function bilinearAt(f, gx, gy, gw, sx, sy) {
  const x0 = Math.floor(sx), y0 = Math.floor(sy);
  const fx = sx - x0, fy = sy - y0;
  const at = (x, y) => (x < 0 || y < 0 || x >= gw || y >= f.cellH ? 0 : f.alpha[(gy + y) * f.width + gx + x]);
  return at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy)
    + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
}

function blend(img, x, y, color, cov) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height || cov <= 0) return;
  const a = (color[3] / 255) * Math.min(1, cov / 255);
  const p = (y * img.width + x) * 4;
  const d = img.data;
  d[p] = Math.round(color[0] * a + d[p] * (1 - a));
  d[p + 1] = Math.round(color[1] * a + d[p + 1] * (1 - a));
  d[p + 2] = Math.round(color[2] * a + d[p + 2] * (1 - a));
  d[p + 3] = Math.max(d[p + 3], Math.round(255 * a));
}

/** Draw one line with its line box's top-left at (x, top). */
function drawLine(img, x, top, line, sizePx, color, weight) {
  const f = face(weight);
  const k = sizePx / f.size;
  let pen = x;
  for (const ch of line) {
    const [gx, gy, gw, left, advance] = glyph(f, ch);
    const ox = pen + left * k;
    const dx0 = Math.floor(ox), dx1 = Math.ceil(ox + gw * k);
    const dy0 = Math.floor(top), dy1 = Math.ceil(top + f.cellH * k);
    for (let dy = dy0; dy < dy1; dy++) {
      for (let dx = dx0; dx < dx1; dx++) {
        const cov = k < 1
          ? coverageAt(f, gx, gy, gw, (dx - ox) / k, (dy - top) / k, (dx + 1 - ox) / k, (dy + 1 - top) / k)
          : bilinearAt(f, gx, gy, gw, (dx + 0.5 - ox) / k - 0.5, (dy + 0.5 - top) / k - 0.5);
        blend(img, dx, dy, color, cov);
      }
    }
    pen += advance * k;
  }
}

/** Draw text with the first line box's top-left at (x, y). */
function drawText(img, x, y, text, sizePx, color, { weight = 'regular' } = {}) {
  const f = face(weight);
  const lineHeight = sizePx * LINE_HEIGHT;
  // Center the glyph cell within each line box.
  const inset = (lineHeight - (f.cellH * sizePx) / f.size) / 2;
  String(text).split('\n').forEach((line, i) => {
    drawLine(img, x, y + i * lineHeight + inset, line, sizePx, color, weight);
  });
}

/** Draw text centered on (cx, cy), optically centered on the cap height. */
function drawTextCentered(img, cx, cy, text, sizePx, color, { weight = 'regular' } = {}) {
  const f = face(weight);
  const k = sizePx / f.size;
  const lines = String(text).split('\n');
  const lineHeight = sizePx * LINE_HEIGHT;
  const firstBaseline = cy - ((lines.length - 1) * lineHeight) / 2 + (CAP_HEIGHT * sizePx) / 2;
  lines.forEach((line, i) => {
    const w = lineWidth(line, sizePx, weight);
    drawLine(img, cx - w / 2, firstBaseline + i * lineHeight - f.ascent * k, line, sizePx, color, weight);
  });
}

/** Shorten text with an ellipsis so it fits within maxWidth. */
function fitText(text, sizePx, maxWidth, { weight = 'regular' } = {}) {
  const t = String(text);
  if (lineWidth(t, sizePx, weight) <= maxWidth) return t;
  let lo = 0, hi = t.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (lineWidth(`${t.slice(0, mid).trimEnd()}…`, sizePx, weight) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${t.slice(0, lo).trimEnd()}…`;
}

/** Greedy word wrap; the last allowed line is ellipsized. */
function wrapText(text, sizePx, maxWidth, { weight = 'regular', maxLines = Infinity } = {}) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && lineWidth(next, sizePx, weight) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  if (lines.length <= maxLines) return lines.map((l) => fitText(l, sizePx, maxWidth, { weight }));
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = fitText(`${kept[maxLines - 1]}…`, sizePx, maxWidth, { weight });
  return kept.map((l, i) => (i < maxLines - 1 ? fitText(l, sizePx, maxWidth, { weight }) : l));
}

module.exports = { measureText, drawText, drawTextCentered, fitText, wrapText, lineWidth };
