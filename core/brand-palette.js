'use strict';

/**
 * Brand colors from a logo: Settings → Branding → Pick colors from logo.
 * The renderer draws the logo small on a canvas and passes its pixels here.
 * Primary is the logo's most prominent color, Accent its next distinct one
 * (darkened until links read well on white), and Text its darkest neutral,
 * or a near-black tinted toward Primary.
 */

(function attachBrandPalette(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  // The renderer (sandboxed, without require) loads this file with a script tag.
  if (root) {
    root.StepForgeBrandPalette = api;
  }
})(typeof window !== 'undefined' ? window : null, () => {
  // Colors closer than this (RGB distance) are one color: anti-aliasing and JPEG noise.
  const MERGE_DISTANCE = 40;
  // A color covering less of the logo than this is a fringe, not a brand color.
  const MIN_SHARE = 0.01;
  // Links on white: WCAG AA for body text. Body text: AAA.
  const LINK_CONTRAST = 4.5;
  const TEXT_CONTRAST = 7;

  function toHsl({ r, g, b }) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    return { h: h * 60, s, l };
  }

  function fromHsl({ h, s, l }) {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) };
  }

  function toHex({ r, g, b }) {
    return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  }

  function luminance({ r, g, b }) {
    const lin = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  /** Contrast ratio against white (1 to 21). */
  function contrastOnWhite(rgb) {
    return 1.05 / (luminance(rgb) + 0.05);
  }

  /** The color, darkened just enough to reach `ratio` against white. */
  function readableOnWhite(rgb, ratio) {
    if (contrastOnWhite(rgb) >= ratio) return rgb;
    const hsl = toHsl(rgb);
    for (let l = hsl.l; l > 0; l -= 0.01) {
      const next = fromHsl({ ...hsl, l });
      if (contrastOnWhite(next) >= ratio) return next;
    }
    return { r: 0, g: 0, b: 0 };
  }

  function hueDistance(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  const distance = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

  /**
   * { primary, accent, text } as #RRGGBB from RGBA pixels (a canvas's
   * ImageData.data), or null when the logo has no usable color: it's empty,
   * or only white and light gray.
   */
  function colorsFromPixels(data, { minAlpha = 128 } = {}) {
    const buckets = new Map();
    let opaque = 0;
    for (let i = 0; i + 3 < data.length; i += 4) {
      if (data[i + 3] < minAlpha) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      opaque += 1;
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, bucket = { n: 0, r: 0, g: 0, b: 0 });
      bucket.n += 1; bucket.r += r; bucket.g += g; bucket.b += b;
    }
    if (!opaque) return null;

    // Merge similar colors, biggest first, so each cluster centers on its main shade.
    const clusters = [];
    for (const bucket of [...buckets.values()].sort((x, y) => y.n - x.n)) {
      const color = { r: bucket.r / bucket.n, g: bucket.g / bucket.n, b: bucket.b / bucket.n };
      const near = clusters.find((c) => distance(c, color) < MERGE_DISTANCE);
      if (near) {
        const n = near.n + bucket.n;
        near.r = (near.r * near.n + bucket.r) / n;
        near.g = (near.g * near.n + bucket.g) / n;
        near.b = (near.b * near.n + bucket.b) / n;
        near.n = n;
      } else {
        clusters.push({ ...color, n: bucket.n });
      }
    }
    const colors = clusters
      .map((c) => ({ rgb: { r: c.r, g: c.g, b: c.b }, share: c.n / opaque, ...toHsl(c) }))
      .filter((c) => c.share >= MIN_SHARE);

    // Colorful enough to be a brand color, and neither near-white nor near-black.
    const chromatic = colors
      .filter((c) => c.s >= 0.25 && c.l >= 0.12 && c.l <= 0.9)
      .sort((a, b) => b.share * (0.4 + b.s) - a.share * (0.4 + a.s));
    // Grays and blacks, the most used first; a black-and-white logo is all neutral.
    const neutrals = colors.filter((c) => !chromatic.includes(c) && c.l <= 0.75).sort((a, b) => b.share - a.share);

    const primary = chromatic[0] || neutrals[0];
    if (!primary) return null;
    const second = chromatic.slice(1).find((c) => hueDistance(c.h, primary.h) >= 30);
    const accent = readableOnWhite((second || primary).rgb, LINK_CONTRAST);
    const darkest = neutrals.filter((c) => c.l <= 0.3).sort((a, b) => a.l - b.l)[0];
    const text = darkest && contrastOnWhite(darkest.rgb) >= TEXT_CONTRAST
      ? darkest.rgb
      : readableOnWhite(fromHsl({ h: primary.h, s: Math.min(primary.s, 0.3), l: 0.14 }), TEXT_CONTRAST);
    return { primary: toHex(primary.rgb), accent: toHex(accent), text: toHex(text) };
  }

  return { colorsFromPixels, contrastOnWhite, readableOnWhite, toHex };
});
