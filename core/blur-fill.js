'use strict';

/**
 * Fills a blur annotation's rectangle so nothing inside it can be recovered.
 * A real blur keeps a function of the hidden pixels, and with the font and
 * the blur code known, text under it can be found by blurring guesses until
 * one matches. Here every filled pixel is built only from the pixels just
 * outside the rectangle (softened along each edge, then blended inward), so
 * the result is the same whatever was underneath.
 *
 * Used by the export rasterizer (core/raster.js) and the editor canvas
 * (app/renderer/canvas.js), so exports look like the editor.
 */
(function attachBlurFill(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.StepForgeBlurFill = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  // Used when nothing around the rectangle can be read, e.g. it covers the
  // whole image.
  const NEUTRAL = [128, 128, 128, 255];

  /** A rectangle in whole image pixels, clipped to the image; null if empty. */
  function pixelRect(img, x, y, w, h) {
    const x0 = Math.max(0, Math.round(Math.min(x, x + w)));
    const y0 = Math.max(0, Math.round(Math.min(y, y + h)));
    const x1 = Math.min(img.width, Math.round(Math.max(x, x + w)));
    const y1 = Math.min(img.height, Math.round(Math.max(y, y + h)));
    return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
  }

  function inside(rects, x, y) {
    return rects.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);
  }

  /**
   * One edge of the surroundings: `length` pixels starting at (x, y) and
   * stepping by (dx, dy), box-averaged over `radius` along the edge. Pixels
   * outside the image or inside a hidden rectangle are never read; a gap is
   * filled from the nearest readable pixel. Null if none is readable.
   */
  function edge(img, x, y, dx, dy, length, radius, hidden) {
    const sums = new Float64Array((length + 1) * 4);
    const counts = new Float64Array(length + 1);
    for (let i = 0; i < length; i++) {
      const px = x + dx * i, py = y + dy * i;
      const ok = px >= 0 && py >= 0 && px < img.width && py < img.height && !inside(hidden, px, py);
      counts[i + 1] = counts[i] + (ok ? 1 : 0);
      const p = (py * img.width + px) * 4;
      for (let c = 0; c < 4; c++) sums[(i + 1) * 4 + c] = sums[i * 4 + c] + (ok ? img.data[p + c] : 0);
    }
    if (!counts[length]) return null;
    const out = new Float64Array(length * 4);
    const known = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      const a = Math.max(0, i - radius), b = Math.min(length, i + radius + 1);
      const n = counts[b] - counts[a];
      if (!n) continue;
      known[i] = 1;
      for (let c = 0; c < 4; c++) out[i * 4 + c] = (sums[b * 4 + c] - sums[a * 4 + c]) / n;
    }
    // Fill gaps from the last known value, and any leading gap from the first.
    const first = known.indexOf(1);
    for (let i = 0; i < length; i++) {
      if (known[i]) continue;
      const from = i < first ? first : i - 1;
      out.copyWithin(i * 4, from * 4, from * 4 + 4);
    }
    return out;
  }

  /**
   * Fill rectangle `r` ({ x0, y0, x1, y1 } from pixelRect) of `img` in place.
   * `hidden` lists every rectangle whose pixels must not be read, including
   * `r` itself, so overlapping blurs never read each other's contents.
   * `radius` softens detail along the edges.
   */
  function fillFromSurroundings(img, r, { radius = 8, hidden = [r] } = {}) {
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    const s = Math.max(1, Math.round(radius));
    const top = edge(img, r.x0, r.y0 - 1, 1, 0, w, s, hidden);
    const bottom = edge(img, r.x0, r.y1, 1, 0, w, s, hidden);
    const left = edge(img, r.x0 - 1, r.y0, 0, 1, h, s, hidden);
    const right = edge(img, r.x1, r.y0, 0, 1, h, s, hidden);
    if (!top && !bottom && !left && !right) {
      for (let yy = r.y0; yy < r.y1; yy++) {
        for (let xx = r.x0; xx < r.x1; xx++) {
          const p = (yy * img.width + xx) * 4;
          for (let c = 0; c < 4; c++) img.data[p + c] = NEUTRAL[c];
        }
      }
      return;
    }
    // Blend the edges inward, each weighted by closeness, so the fill meets
    // its surroundings seamlessly.
    for (let yy = r.y0; yy < r.y1; yy++) {
      const j = yy - r.y0;
      const wt = top ? 1 / (j + 1) : 0, wb = bottom ? 1 / (h - j) : 0;
      for (let xx = r.x0; xx < r.x1; xx++) {
        const i = xx - r.x0;
        const wl = left ? 1 / (i + 1) : 0, wr = right ? 1 / (w - i) : 0;
        const total = wt + wb + wl + wr;
        const p = (yy * img.width + xx) * 4;
        for (let c = 0; c < 4; c++) {
          let v = 0;
          if (top) v += top[i * 4 + c] * wt;
          if (bottom) v += bottom[i * 4 + c] * wb;
          if (left) v += left[j * 4 + c] * wl;
          if (right) v += right[j * 4 + c] * wr;
          img.data[p + c] = Math.round(v / total);
        }
      }
    }
  }

  return { pixelRect, fillFromSurroundings };
});
