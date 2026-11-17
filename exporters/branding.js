'use strict';

const { decodePng, encodePng } = require('../core/png');
const raster = require('../core/raster');
const { brandTemplateDefaults, hexToRgb } = require('../core/branding');

/**
 * Exporter helpers for the brand profile on `ast.branding` (core/branding.js
 * loadBranding). Every exporter treats a missing profile as "no branding" and
 * then produces exactly what it did before branding existed.
 */

/** Options for an export: the exporter's defaults, then the brand's, then what was chosen. */
function withBrand(format, defaults, ast, template = {}) {
  return { ...defaults, ...brandTemplateDefaults(format, ast?.branding), ...template };
}

const decoded = new WeakMap();

/** The logo or banner as an RGBA image (null when it has no PNG raster). */
function brandRaster(asset) {
  if (!asset || !asset.png) return null;
  if (!decoded.has(asset)) {
    let img = null;
    try { img = decodePng(asset.png); } catch { img = null; }
    decoded.set(asset, img);
  }
  return decoded.get(asset);
}

/** (w, h) scaled to fit inside maxW × maxH, never enlarged. */
function fitSize(w, h, maxW, maxH) {
  const scale = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** The image resized to fit maxW × maxH pixels. */
function fitRaster(img, maxW, maxH) {
  const size = fitSize(img.width, img.height, maxW, maxH);
  return size.width === img.width && size.height === img.height ? img : raster.resize(img, size.width, size.height);
}

/** The logo or banner as PNG bytes no larger than maxW × maxH (for formats that show images at their own size). */
function scaledPng(asset, maxW, maxH) {
  const img = brandRaster(asset);
  if (!img) return null;
  const out = fitRaster(img, maxW, maxH);
  return { data: encodePng(out), width: out.width, height: out.height };
}

/** The original image as a data: URL (an SVG stays sharp at any size). */
function imageDataUri(asset) {
  return `data:${asset.mime};base64,${asset.data.toString('base64')}`;
}

const SERIF = /serif|times|georgia|garamond|cambria|palatino|antiqua|baskerville|bodoni|caslon|constantia|didot|merriweather|playfair|lora\b|minion|charter|schoolbook|rockwell|crimson|slab/i;
const MONO = /mono|courier|consolas|menlo|monaco|source code|fira code|cascadia/i;

/** The closest built-in PDF font family for a font name: 'sans' (Helvetica), 'serif' (Times) or 'mono' (Courier). */
function fontKind(name) {
  const n = String(name || '');
  if (/\bsans\b/i.test(n)) return 'sans';
  if (MONO.test(n)) return 'mono';
  if (SERIF.test(n)) return 'serif';
  return 'sans';
}

const CSS_STACKS = {
  sans: '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
  serif: 'Georgia, Cambria, "Times New Roman", Times, serif',
  mono: 'ui-monospace, "Cascadia Code", Consolas, "Liberation Mono", monospace',
};

/** A CSS font-family list: the brand font first, then system fonts of the same kind. */
function cssFontStack(name) {
  const stack = CSS_STACKS[fontKind(name)];
  return name ? `"${name}", ${stack}` : stack;
}

/** Black or white, whichever reads better on `hex`. */
function textOn(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.36 ? '#111111' : '#FFFFFF';
}

/** Relative luminance (0..1) of an sRGB color given as [r, g, b]. */
function luminance([r, g, b]) {
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The WCAG contrast ratio of two luminances. */
function contrast(a, b) {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Whether a logo needs a white card to show up on a background of luminance
 * `behind`: when more than a quarter of its visible pixels stand out from it
 * by less than 3:1, the WCAG minimum for graphics (a dark wordmark on a dark
 * band, say).
 */
function logoNeedsCard(img, behind) {
  if (!img || behind == null) return false;
  const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 20000)));
  let visible = 0;
  let faint = 0;
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const i = (y * img.width + x) * 4;
      if (img.data[i + 3] < 128) continue;
      visible += 1;
      if (contrast(luminance([img.data[i], img.data[i + 1], img.data[i + 2]]), behind) < 3) faint += 1;
    }
  }
  return visible > 0 && faint / visible > 0.25;
}

/**
 * The brand's logo for a cover on `background` (hex): the logo itself, or,
 * when it wouldn't show up there, the logo on a white rounded card. Returns
 * an RGBA image and whether it's carded, or null without a logo raster.
 */
function coverLogo(brand, background) {
  const img = brand ? brandRaster(brand.logo) : null;
  if (!img) return null;
  if (!background || !logoNeedsCard(img, luminance(hexToRgb(background)))) return { img, carded: false };
  const pad = Math.max(8, Math.round(Math.min(img.width, img.height) * 0.18));
  const card = raster.createImage(img.width + pad * 2, img.height + pad * 2, [0, 0, 0, 0]);
  raster.fillRoundRect(card, 0, 0, card.width, card.height, Math.round(pad * 0.9), [255, 255, 255, 255]);
  raster.drawImage(card, img, pad, pad);
  return { img: card, carded: true };
}

/**
 * Lay a logo over an image as a watermark: at most a fifth of the image's
 * width (and half its height), in a corner, at `opacity`. Changes `img` in place.
 */
function overlayWatermark(img, mark, { position = 'bottom-right', opacity = 0.6 } = {}) {
  const maxW = Math.max(16, Math.round(img.width * 0.2));
  const maxH = Math.max(16, Math.round(img.height * 0.5));
  const scaled = mark.width > maxW || mark.height > maxH ? fitRaster(mark, maxW, maxH) : raster.cloneImage(mark);
  const alpha = Math.round(255 * Math.max(0, Math.min(1, opacity)));
  for (let i = 3; i < scaled.data.length; i += 4) {
    scaled.data[i] = Math.round((scaled.data[i] * alpha) / 255);
  }
  const margin = Math.max(6, Math.round(img.width * 0.02));
  const x = position.endsWith('left') ? margin : img.width - scaled.width - margin;
  const y = position.startsWith('top') ? margin : img.height - scaled.height - margin;
  raster.drawImage(img, scaled, Math.max(0, x), Math.max(0, y));
}

/**
 * How the brand places step screenshots (core/branding.js `screenshots`);
 * without a profile, the way exports always placed them.
 */
function screenshotOptions(ast) {
  const shots = ast?.branding?.screenshots;
  return {
    align: shots?.align || 'left',
    border: shots?.border === true,
    borderColor: shots?.borderColor || '#D0D5DD',
    layout: shots?.layout || 'stacked',
  };
}

module.exports = {
  withBrand,
  screenshotOptions,
  brandRaster,
  fitSize,
  fitRaster,
  scaledPng,
  imageDataUri,
  fontKind,
  cssFontStack,
  textOn,
  overlayWatermark,
  hexToRgb,
  luminance,
  contrast,
  logoNeedsCard,
  coverLogo,
};
