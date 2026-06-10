'use strict';

const { FONT8X8 } = require('./font8x8');

/**
 * Software rasterizer for annotation rendering in exports. Operates on
 * RGBA images ({ width, height, data: Buffer }). The same normalized
 * annotation scene graph drawn by the editor canvas is burned into pixels
 * here, so exports match the editor.
 *
 * Stroke widths are normalized to a 1000px-wide reference image and scaled,
 * font sizes are fractions of image height — both resolution-independent.
 */

function createImage(width, height, color = [255, 255, 255, 255]) {
  const data = Buffer.alloc(width * height * 4);
  for (let p = 0; p < data.length; p += 4) {
    data[p] = color[0]; data[p + 1] = color[1]; data[p + 2] = color[2]; data[p + 3] = color[3];
  }
  return { width, height, data };
}

function cloneImage(img) {
  return { width: img.width, height: img.height, data: Buffer.from(img.data) };
}

function parseColor(str, fallback = [0, 0, 0, 255]) {
  if (Array.isArray(str)) return str;
  if (typeof str !== 'string' || str === 'transparent' || str === 'none' || str === '') return str === undefined ? fallback : [0, 0, 0, 0];
  const m = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(str.trim());
  if (!m) return fallback;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff, m[2] ? parseInt(m[2], 16) : 255];
}

function blendPixel(img, x, y, color) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const a = color[3] / 255;
  if (a <= 0) return;
  const p = (y * img.width + x) * 4;
  const d = img.data;
  if (a >= 1) {
    d[p] = color[0]; d[p + 1] = color[1]; d[p + 2] = color[2]; d[p + 3] = 255;
    return;
  }
  d[p] = Math.round(color[0] * a + d[p] * (1 - a));
  d[p + 1] = Math.round(color[1] * a + d[p + 1] * (1 - a));
  d[p + 2] = Math.round(color[2] * a + d[p + 2] * (1 - a));
  d[p + 3] = Math.max(d[p + 3], Math.round(255 * a));
}

function fillRect(img, x, y, w, h, color) {
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(img.width, Math.round(x + w)), y1 = Math.min(img.height, Math.round(y + h));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) blendPixel(img, xx, yy, color);
  }
}

function strokeRect(img, x, y, w, h, color, t) {
  fillRect(img, x - t / 2, y - t / 2, w + t, t, color);             // top
  fillRect(img, x - t / 2, y + h - t / 2, w + t, t, color);         // bottom
  fillRect(img, x - t / 2, y + t / 2, t, h - t, color);             // left
  fillRect(img, x + w - t / 2, y + t / 2, t, h - t, color);         // right
}

function ovalCoverage(cx, cy, rx, ry, px, py) {
  const dx = (px - cx) / rx, dy = (py - cy) / ry;
  return dx * dx + dy * dy;
}

function fillOval(img, x, y, w, h, color) {
  const cx = x + w / 2, cy = y + h / 2, rx = Math.max(1, w / 2), ry = Math.max(1, h / 2);
  const y0 = Math.max(0, Math.floor(y)), y1 = Math.min(img.height, Math.ceil(y + h));
  const x0 = Math.max(0, Math.floor(x)), x1 = Math.min(img.width, Math.ceil(x + w));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      if (ovalCoverage(cx, cy, rx, ry, xx + 0.5, yy + 0.5) <= 1) blendPixel(img, xx, yy, color);
    }
  }
}

function strokeOval(img, x, y, w, h, color, t) {
  const cx = x + w / 2, cy = y + h / 2;
  const rxO = Math.max(1, w / 2 + t / 2), ryO = Math.max(1, h / 2 + t / 2);
  const rxI = Math.max(0.5, w / 2 - t / 2), ryI = Math.max(0.5, h / 2 - t / 2);
  const y0 = Math.max(0, Math.floor(cy - ryO)), y1 = Math.min(img.height, Math.ceil(cy + ryO));
  const x0 = Math.max(0, Math.floor(cx - rxO)), x1 = Math.min(img.width, Math.ceil(cx + rxO));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const px = xx + 0.5, py = yy + 0.5;
      if (ovalCoverage(cx, cy, rxO, ryO, px, py) <= 1 && ovalCoverage(cx, cy, rxI, ryI, px, py) > 1) {
        blendPixel(img, xx, yy, color);
      }
    }
  }
}

function drawLine(img, x0, y0, x1, y1, color, t) {
  const half = Math.max(0.5, t / 2);
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - half - 1));
  const maxX = Math.min(img.width, Math.ceil(Math.max(x0, x1) + half + 1));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - half - 1));
  const maxY = Math.min(img.height, Math.ceil(Math.max(y0, y1) + half + 1));
  const dx = x1 - x0, dy = y1 - y0;
  const lenSq = dx * dx + dy * dy || 1;
  for (let yy = minY; yy < maxY; yy++) {
    for (let xx = minX; xx < maxX; xx++) {
      const px = xx + 0.5, py = yy + 0.5;
      let u = ((px - x0) * dx + (py - y0) * dy) / lenSq;
      u = Math.max(0, Math.min(1, u));
      const ex = x0 + u * dx - px, ey = y0 + u * dy - py;
      if (ex * ex + ey * ey <= half * half) blendPixel(img, xx, yy, color);
    }
  }
}

/** Scanline polygon fill (even-odd). points: [[x,y],...] */
function fillPolygon(img, points, color) {
  const ys = points.map((p) => p[1]);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(img.height, Math.ceil(Math.max(...ys)));
  for (let yy = y0; yy < y1; yy++) {
    const scanY = yy + 0.5;
    const xs = [];
    for (let i = 0; i < points.length; i++) {
      const [ax, ay] = points[i];
      const [bx, by] = points[(i + 1) % points.length];
      if ((ay <= scanY && by > scanY) || (by <= scanY && ay > scanY)) {
        xs.push(ax + ((scanY - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.round(xs[k]));
      const xb = Math.min(img.width, Math.round(xs[k + 1]));
      for (let xx = xa; xx < xb; xx++) blendPixel(img, xx, yy, color);
    }
  }
}

function drawArrow(img, x0, y0, x1, y1, color, t) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const headLen = Math.min(len * 0.4, Math.max(10, t * 4));
  const ux = dx / len, uy = dy / len;
  const bx = x1 - ux * headLen, by = y1 - uy * headLen;
  drawLine(img, x0, y0, bx, by, color, t);
  const wing = headLen * 0.5;
  fillPolygon(img, [
    [x1, y1],
    [bx - uy * wing, by + ux * wing],
    [bx + uy * wing, by - ux * wing],
  ], color);
}

function boxBlur(img, x, y, w, h, radius) {
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(img.width, Math.round(x + w)), y1 = Math.min(img.height, Math.round(y + h));
  if (x1 <= x0 || y1 <= y0) return;
  const r = Math.max(1, Math.round(radius));
  // Two passes of box blur approximates gaussian well enough for redaction.
  for (let pass = 0; pass < 2; pass++) {
    const src = Buffer.from(img.data);
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        let rs = 0, gs = 0, bs = 0, n = 0;
        for (let oy = -r; oy <= r; oy += Math.max(1, Math.floor(r / 3))) {
          for (let ox = -r; ox <= r; ox += Math.max(1, Math.floor(r / 3))) {
            const sx = Math.min(x1 - 1, Math.max(x0, xx + ox));
            const sy = Math.min(y1 - 1, Math.max(y0, yy + oy));
            const p = (sy * img.width + sx) * 4;
            rs += src[p]; gs += src[p + 1]; bs += src[p + 2]; n++;
          }
        }
        const p = (yy * img.width + xx) * 4;
        img.data[p] = Math.round(rs / n);
        img.data[p + 1] = Math.round(gs / n);
        img.data[p + 2] = Math.round(bs / n);
      }
    }
  }
}

/** Nearest-neighbour scaled copy of a region (used by magnify). */
function magnifyRegion(img, x, y, w, h, zoom, borderColor, t) {
  const src = cloneImage(img);
  const cx = x + w / 2, cy = y + h / 2;
  const sw = w / zoom, sh = h / zoom;
  const sx0 = cx - sw / 2, sy0 = cy - sh / 2;
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(img.width, Math.round(x + w)), y1 = Math.min(img.height, Math.round(y + h));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      // Only inside the oval lens
      if (ovalCoverage(cx, cy, w / 2, h / 2, xx + 0.5, yy + 0.5) > 1) continue;
      const sx = Math.min(img.width - 1, Math.max(0, Math.round(sx0 + ((xx - x) / w) * sw)));
      const sy = Math.min(img.height - 1, Math.max(0, Math.round(sy0 + ((yy - y) / h) * sh)));
      const sp = (sy * src.width + sx) * 4;
      const dp = (yy * img.width + xx) * 4;
      img.data[dp] = src.data[sp]; img.data[dp + 1] = src.data[sp + 1];
      img.data[dp + 2] = src.data[sp + 2]; img.data[dp + 3] = 255;
    }
  }
  strokeOval(img, x, y, w, h, borderColor, t);
}

// ---- text -----------------------------------------------------------------

function glyphFor(ch) {
  const code = ch.codePointAt(0);
  return FONT8X8[code >= 0 && code < 128 ? code : 63]; // '?' fallback
}

/** Width/height of text at a pixel size (8x8 glyphs, integer scaled). */
function measureText(text, sizePx) {
  const scale = Math.max(1, Math.round(sizePx / 8));
  const lines = String(text).split('\n');
  const w = Math.max(...lines.map((l) => l.length)) * 8 * scale;
  return { width: w, height: lines.length * 10 * scale, scale, lineHeight: 10 * scale };
}

function drawText(img, x, y, text, sizePx, color) {
  const { scale, lineHeight } = measureText(text, sizePx);
  const lines = String(text).split('\n');
  let ty = Math.round(y);
  for (const line of lines) {
    let tx = Math.round(x);
    for (const ch of line) {
      const glyph = glyphFor(ch);
      for (let gy = 0; gy < 8; gy++) {
        const row = glyph[gy];
        for (let gx = 0; gx < 8; gx++) {
          if (!(row & (1 << gx))) continue;
          fillRect(img, tx + gx * scale, ty + gy * scale, scale, scale, color);
        }
      }
      tx += 8 * scale;
    }
    ty += lineHeight;
  }
}

function drawTextCentered(img, cx, cy, text, sizePx, color) {
  const m = measureText(text, sizePx);
  drawText(img, cx - m.width / 2, cy - m.height / 2 + m.scale, text, sizePx, color);
}

function drawCursorIcon(img, x, y, sizePx, color) {
  const s = sizePx;
  fillPolygon(img, [
    [x, y], [x, y + s], [x + s * 0.28, y + s * 0.75],
    [x + s * 0.45, y + s * 1.05], [x + s * 0.58, y + s * 0.98],
    [x + s * 0.42, y + s * 0.68], [x + s * 0.72, y + s * 0.68],
  ], [255, 255, 255, 255]);
  // dark outline by drawing slightly smaller inner arrow
  fillPolygon(img, [
    [x + 2, y + 4], [x + 2, y + s - 3], [x + s * 0.26, y + s * 0.7],
    [x + s * 0.42, y + s * 0.98], [x + s * 0.52, y + s * 0.93],
    [x + s * 0.37, y + s * 0.63], [x + s * 0.62, y + s * 0.63],
  ], color);
}

// ---- composition ----------------------------------------------------------

function crop(img, x, y, w, h) {
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
  const cw = Math.min(img.width - x0, Math.round(w)), ch = Math.min(img.height - y0, Math.round(h));
  if (cw <= 0 || ch <= 0) throw new Error('crop: empty region');
  const out = createImage(cw, ch);
  for (let yy = 0; yy < ch; yy++) {
    img.data.copy(out.data, yy * cw * 4, ((y0 + yy) * img.width + x0) * 4, ((y0 + yy) * img.width + x0 + cw) * 4);
  }
  return out;
}

/** Bilinear resize. */
function resize(img, w, h) {
  const out = createImage(w, h);
  for (let yy = 0; yy < h; yy++) {
    const sy = ((yy + 0.5) * img.height) / h - 0.5;
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(img.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let xx = 0; xx < w; xx++) {
      const sx = ((xx + 0.5) * img.width) / w - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(img.width - 1, x0 + 1);
      const fx = sx - x0;
      const dp = (yy * w + xx) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = img.data[(y0 * img.width + x0) * 4 + c];
        const p01 = img.data[(y0 * img.width + x1) * 4 + c];
        const p10 = img.data[(y1 * img.width + x0) * 4 + c];
        const p11 = img.data[(y1 * img.width + x1) * 4 + c];
        out.data[dp + c] = Math.round(
          p00 * (1 - fx) * (1 - fy) + p01 * fx * (1 - fy) + p10 * (1 - fx) * fy + p11 * fx * fy
        );
      }
    }
  }
  return out;
}

function drawImage(dst, src, dx, dy) {
  for (let yy = 0; yy < src.height; yy++) {
    for (let xx = 0; xx < src.width; xx++) {
      const sp = (yy * src.width + xx) * 4;
      blendPixel(dst, dx + xx, dy + yy, [src.data[sp], src.data[sp + 1], src.data[sp + 2], src.data[sp + 3]]);
    }
  }
}

// ---- annotation rendering ---------------------------------------------------

const DRAW_ORDER = { blur: 0, highlight: 1, magnify: 2, rect: 3, oval: 3, line: 3, arrow: 3, cursor: 4, number: 5, text: 6, tooltip: 7 };

/**
 * Burn annotations into a copy of the base image. Annotation coords are
 * fractions of the image; returns a new image.
 */
function renderAnnotations(baseImg, annotations = []) {
  const img = cloneImage(baseImg);
  const W = img.width, H = img.height;
  const px = (frac, total) => frac * total;
  const strokePx = (sw) => Math.max(1, Math.round((sw || 3) * W / 1000));
  const fontPx = (style) => Math.max(8, Math.round((style.fontSize || 0.022) * H));

  const ordered = [...annotations].sort((a, b) => (DRAW_ORDER[a.type] ?? 3) - (DRAW_ORDER[b.type] ?? 3));

  for (const ann of ordered) {
    const x = px(ann.x, W), y = px(ann.y, H), w = px(ann.w, W), h = px(ann.h, H);
    const style = ann.style || {};
    const stroke = parseColor(style.stroke, [229, 72, 77, 255]);
    const fill = parseColor(style.fill, [0, 0, 0, 0]);
    const textColor = parseColor(style.textColor, [255, 255, 255, 255]);
    const t = strokePx(style.strokeWidth);

    switch (ann.type) {
      case 'rect':
        if (fill[3] > 0) fillRect(img, x, y, w, h, fill);
        strokeRect(img, x, y, w, h, stroke, t);
        break;
      case 'oval':
        if (fill[3] > 0) fillOval(img, x, y, w, h, fill);
        strokeOval(img, x, y, w, h, stroke, t);
        break;
      case 'line':
        drawLine(img, x, y, x + w, y + h, stroke, t);
        break;
      case 'arrow':
        drawArrow(img, x, y, x + w, y + h, stroke, t);
        break;
      case 'blur':
        boxBlur(img, x, y, w, h, ann.radius || 8);
        break;
      case 'highlight':
        fillRect(img, x, y, w, h, [255, 235, 59, 105]);
        break;
      case 'magnify':
        magnifyRegion(img, x, y, w, h, ann.zoom || 2, stroke, t);
        break;
      case 'text': {
        drawText(img, x, y, ann.text || '', fontPx(style), stroke[3] > 0 ? stroke : [0, 0, 0, 255]);
        break;
      }
      case 'tooltip': {
        const bg = parseColor(style.fill === 'transparent' || !style.fill ? '#1F2937' : style.fill);
        fillRect(img, x, y, w, h, bg);
        strokeRect(img, x, y, w, h, parseColor(style.stroke, [17, 24, 39, 255]), Math.max(1, Math.round(t / 2)));
        const tail = style.tail || 'bottom';
        const ts = Math.max(6, Math.min(w, h) * 0.25);
        if (tail === 'bottom') fillPolygon(img, [[x + w / 2 - ts, y + h], [x + w / 2 + ts, y + h], [x + w / 2, y + h + ts * 1.4]], bg);
        if (tail === 'top') fillPolygon(img, [[x + w / 2 - ts, y], [x + w / 2 + ts, y], [x + w / 2, y - ts * 1.4]], bg);
        if (tail === 'left') fillPolygon(img, [[x, y + h / 2 - ts], [x, y + h / 2 + ts], [x - ts * 1.4, y + h / 2]], bg);
        if (tail === 'right') fillPolygon(img, [[x + w, y + h / 2 - ts], [x + w, y + h / 2 + ts], [x + w + ts * 1.4, y + h / 2]], bg);
        drawTextCentered(img, x + w / 2, y + h / 2, ann.text || '', fontPx(style), textColor);
        break;
      }
      case 'number': {
        const r = Math.max(8, Math.min(w, h) / 2);
        const cx = x + w / 2, cy = y + h / 2;
        fillOval(img, cx - r, cy - r, r * 2, r * 2, stroke);
        drawTextCentered(img, cx, cy, String(ann.value ?? '?'), Math.max(8, r), textColor);
        break;
      }
      case 'cursor':
        drawCursorIcon(img, x, y, Math.max(12, Math.min(w, h)), [17, 24, 39, 255]);
        break;
      default:
        break;
    }
  }
  return img;
}

/** Apply focused view (zoom/pan crop, then scale back to original size). */
function applyFocusedView(img, fv) {
  if (!fv || !fv.enabled || !(fv.zoom > 1)) return img;
  const vw = img.width / fv.zoom, vh = img.height / fv.zoom;
  const cx = Math.min(Math.max(fv.panX * img.width, vw / 2), img.width - vw / 2);
  const cy = Math.min(Math.max(fv.panY * img.height, vh / 2), img.height - vh / 2);
  const region = crop(img, cx - vw / 2, cy - vh / 2, vw, vh);
  return resize(region, img.width, img.height);
}

module.exports = {
  createImage, cloneImage, parseColor, blendPixel,
  fillRect, strokeRect, fillOval, strokeOval, drawLine, drawArrow,
  fillPolygon, boxBlur, magnifyRegion,
  measureText, drawText, drawTextCentered, drawCursorIcon,
  crop, resize, drawImage,
  renderAnnotations, applyFocusedView,
};
