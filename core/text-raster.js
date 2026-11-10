'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { decodePng } = require('./png');
const { FallbackFonts, systemFontCandidates, hanPreference, loadFont } = require('./pdf-fonts');
const { breakChunks } = require('./text-wrap');

/**
 * Anti-aliased text for the software rasterizer. Glyphs come from Lato
 * atlases rendered at 64px (see scripts/make-font-atlas.js) and are
 * resampled to the requested size: box-filtered when shrinking, bilinear
 * when enlarging. Characters outside the atlas (Chinese, Japanese, Korean,
 * Thai, Devanagari, ...) are drawn from the outlines of an installed font
 * (core/pdf-fonts.js), the way a browser falls back to another font.
 * Characters no installed font has render as '?'. Each character is drawn
 * on its own: scripts that need shaping or right-to-left ordering are not
 * joined or reordered.
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

// ---- installed fonts for characters the atlas lacks ------------------------

// Han characters are drawn differently in Chinese, Japanese and Korean fonts,
// so each preference keeps its own fallback list. Font files are shared.
const loadedFonts = new Map();
function loadShared(face) {
  const key = `${face.file}#${face.index}`;
  if (!loadedFonts.has(key)) {
    try { loadedFonts.set(key, loadFont(face, { cff: true })); } catch (err) { loadedFonts.set(key, err); }
  }
  const font = loadedFonts.get(key);
  if (font instanceof Error) throw font;
  return font;
}
const HAN_SAMPLE = { zh: '', ja: 'あ', ko: '가' };
const defaultFallbacks = (prefer) => new FallbackFonts(
  () => systemFontCandidates({ text: HAN_SAMPLE[prefer], cff: true }), { load: loadShared });
let makeFallbacks = defaultFallbacks;
const fallbacks = new Map();

function fallbackFonts(prefer) {
  if (!fallbacks.has(prefer)) fallbacks.set(prefer, makeFallbacks(prefer));
  return fallbacks.get(prefer);
}

/**
 * Replace where fallback fonts come from: `factory(prefer)` returns a
 * FallbackFonts (or null for none), prefer being 'zh', 'ja' or 'ko'. No
 * argument restores the installed fonts. For tests.
 */
function setFallbackFonts(factory) {
  makeFallbacks = factory || defaultFallbacks;
  fallbacks.clear();
}

// Characters that never draw anything (joiners, variation selectors, BOM).
const INVISIBLE = /^[\u00ad\u200b-\u200f\u2060-\u2064\ufe00-\ufe0f\ufeff]$/;
const outlines = new WeakMap(); // font -> Map(glyph -> path)

function outlineOf(font, glyph) {
  if (!outlines.has(font)) outlines.set(font, new Map());
  const cache = outlines.get(font);
  if (!cache.has(glyph)) {
    let path = [];
    try { path = font.outline(glyph); } catch { path = []; } // a damaged glyph draws nothing
    cache.set(glyph, path);
  }
  return cache.get(glyph);
}

/**
 * The glyphs of one line: { atlas } entries from the Lato atlas, or
 * { font, glyph } from an installed font, each with its advance in ems.
 */
function glyphRun(line, weight) {
  const f = face(weight);
  const run = [];
  let fonts;
  for (const ch of line) {
    const cp = ch.codePointAt(0);
    const atlas = f.glyphs[cp];
    if (atlas) { run.push({ atlas, advance: atlas[4] / f.size }); continue; }
    if (INVISIBLE.test(ch)) continue;
    if (fonts === undefined) fonts = fallbackFonts(hanPreference(line));
    const hit = fonts && fonts.fontFor(cp, weight === 'bold');
    if (hit) run.push({ font: hit.font, glyph: hit.glyph, advance: hit.font.advance(hit.glyph) / hit.font.unitsPerEm });
    else run.push({ atlas: f.glyphs[63], advance: f.glyphs[63][4] / f.size });
  }
  return run;
}

function lineWidth(line, sizePx, weight) {
  let w = 0;
  for (const g of glyphRun(String(line), weight)) w += g.advance;
  return w * sizePx;
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

// ---- outline glyphs ----------------------------------------------------------

/** Flatten path commands (font units, y up) to closed polygons in pixels. */
function flatten(path, ox, baseline, scale) {
  const polys = [];
  let poly = null, px = 0, py = 0;
  const to = (x, y) => [ox + x * scale, baseline - y * scale];
  const curve = (pts, n) => {
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      const x = pts.length === 3
        ? u * u * pts[0][0] + 2 * u * t * pts[1][0] + t * t * pts[2][0]
        : u * u * u * pts[0][0] + 3 * u * u * t * pts[1][0] + 3 * u * t * t * pts[2][0] + t * t * t * pts[3][0];
      const y = pts.length === 3
        ? u * u * pts[0][1] + 2 * u * t * pts[1][1] + t * t * pts[2][1]
        : u * u * u * pts[0][1] + 3 * u * u * t * pts[1][1] + 3 * u * t * t * pts[2][1] + t * t * t * pts[3][1];
      poly.push(x, y);
    }
  };
  // Enough segments to keep each one within ~0.2px of the true curve.
  const steps = (dev) => Math.max(1, Math.min(64, Math.ceil(Math.sqrt(dev / 0.8))));
  for (const [op, ...v] of path) {
    if (op === 'M') { poly = []; polys.push(poly); [px, py] = to(v[0], v[1]); poly.push(px, py); continue; }
    if (!poly) continue;
    if (op === 'L') { [px, py] = to(v[0], v[1]); poly.push(px, py); }
    else if (op === 'Q') {
      const c = to(v[0], v[1]), e = to(v[2], v[3]);
      curve([[px, py], c, e], steps(Math.hypot(px - 2 * c[0] + e[0], py - 2 * c[1] + e[1])));
      [px, py] = e;
    } else if (op === 'C') {
      const c1 = to(v[0], v[1]), c2 = to(v[2], v[3]), e = to(v[4], v[5]);
      const dev = 3 * Math.max(Math.hypot(px - 2 * c1[0] + c2[0], py - 2 * c1[1] + c2[1]),
        Math.hypot(c1[0] - 2 * c2[0] + e[0], c1[1] - 2 * c2[1] + e[1]));
      curve([[px, py], c1, c2, e], steps(dev));
      [px, py] = e;
    }
  }
  return polys;
}

/**
 * Accumulate one edge's signed area into `acc` (row-major, `w` wide): after a
 * running sum along each row, every cell holds its exact coverage.
 */
function accumulateEdge(acc, w, h, x0, y0, x1, y1) {
  if (y0 === y1) return;
  let dir = 1;
  if (y0 > y1) { dir = -1; [x0, y0, x1, y1] = [x1, y1, x0, y0]; }
  const dxdy = (x1 - x0) / (y1 - y0);
  let x = x0;
  if (y0 < 0) { x -= y0 * dxdy; y0 = 0; }
  const yEnd = Math.min(h, Math.ceil(y1));
  for (let y = Math.floor(y0); y < yEnd; y++) {
    const dy = Math.min(y + 1, y1) - Math.max(y, y0);
    const xNext = x + dxdy * dy;
    const d = dy * dir;
    const lo = Math.max(0, Math.min(x, xNext)), hi = Math.min(w, Math.max(x, xNext));
    const row = y * w;
    const loFloor = Math.floor(lo), hiCeil = Math.ceil(hi);
    if (hiCeil <= loFloor + 1) {
      const mid = (lo + hi) / 2 - loFloor;
      acc[row + loFloor] += d * (1 - mid);
      acc[row + loFloor + 1] += d * mid;
    } else {
      const s = 1 / (hi - lo);
      const loFrac = lo - loFloor;
      const a0 = 0.5 * s * (1 - loFrac) ** 2;
      const hiFrac = hi - hiCeil + 1;
      const aEnd = 0.5 * s * hiFrac ** 2;
      acc[row + loFloor] += d * a0;
      if (hiCeil === loFloor + 2) {
        acc[row + loFloor + 1] += d * (1 - a0 - aEnd);
      } else {
        const a1 = s * (1.5 - loFrac);
        acc[row + loFloor + 1] += d * (a1 - a0);
        for (let xi = loFloor + 2; xi < hiCeil - 1; xi++) acc[row + xi] += d * s;
        const a2 = a1 + (hiCeil - loFloor - 3) * s;
        acc[row + hiCeil - 1] += d * (1 - a2 - aEnd);
      }
      acc[row + hiCeil] += d * aEnd;
    }
    x = xNext;
  }
}

/** Fill a glyph outline with its origin at (ox, baseline). */
function fillOutline(img, path, ox, baseline, scale, color) {
  const polys = flatten(path, ox, baseline, scale);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i += 2) {
      minX = Math.min(minX, poly[i]); maxX = Math.max(maxX, poly[i]);
      minY = Math.min(minY, poly[i + 1]); maxY = Math.max(maxY, poly[i + 1]);
    }
  }
  if (!(maxX > minX && maxY > minY)) return;
  const bx = Math.floor(minX), by = Math.floor(minY);
  const w = Math.ceil(maxX) - bx + 2, h = Math.ceil(maxY) - by + 1;
  if (bx >= img.width || by >= img.height || bx + w <= 0 || by + h <= 0 || w * h > 16e6) return;
  const acc = new Float32Array(w * h + 2);
  for (const poly of polys) {
    const n = poly.length;
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n; // the last point closes back to the first
      accumulateEdge(acc, w, h, poly[i] - bx, poly[i + 1] - by, poly[j] - bx, poly[j + 1] - by);
    }
  }
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x < w; x++) {
      sum += acc[y * w + x];
      const cov = Math.min(1, Math.abs(sum));
      if (cov > 0.002) blend(img, bx + x, by + y, color, cov * 255);
    }
  }
}

/** Draw one line with its line box's top-left at (x, top). */
function drawLine(img, x, top, line, sizePx, color, weight) {
  const f = face(weight);
  const k = sizePx / f.size;
  let pen = x;
  for (const g of glyphRun(line, weight)) {
    if (g.font) {
      // Installed-font glyphs sit on the atlas baseline, scaled to the same em size.
      fillOutline(img, outlineOf(g.font, g.glyph), pen, top + f.ascent * k, sizePx / g.font.unitsPerEm, color);
      pen += g.advance * sizePx;
      continue;
    }
    const [gx, gy, gw, left, advance] = g.atlas;
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
  const chars = Array.from(t); // never split a character outside the BMP
  const head = (n) => chars.slice(0, n).join('').trimEnd();
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (lineWidth(`${head(mid)}…`, sizePx, weight) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${head(lo)}…`;
}

/**
 * Greedy word wrap that also breaks between Chinese, Japanese and Korean
 * characters; the last allowed line is ellipsized.
 */
function wrapText(text, sizePx, maxWidth, { weight = 'regular', maxLines = Infinity } = {}) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      breakChunks(word).forEach((chunk, i) => {
        const next = line ? `${line}${i ? '' : ' '}${chunk}` : chunk;
        if (line && lineWidth(next, sizePx, weight) > maxWidth) {
          lines.push(line);
          line = chunk;
        } else {
          line = next;
        }
      });
    }
    lines.push(line);
  }
  if (lines.length <= maxLines) return lines.map((l) => fitText(l, sizePx, maxWidth, { weight }));
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = fitText(`${kept[maxLines - 1]}…`, sizePx, maxWidth, { weight });
  return kept.map((l, i) => (i < maxLines - 1 ? fitText(l, sizePx, maxWidth, { weight }) : l));
}

module.exports = { measureText, drawText, drawTextCentered, fitText, wrapText, lineWidth, setFallbackFonts };
