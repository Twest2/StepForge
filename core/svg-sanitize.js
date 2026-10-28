'use strict';

/**
 * Sanitize an SVG logo or banner so it can be embedded in exports. Exports
 * only ever show it through <img> (where scripts never run), so this is
 * defense in depth: the markup is rebuilt from an allowlist of static SVG
 * elements and attributes. Scripts, event handlers, foreignObject,
 * animation, external references (anything not "#id" or an embedded raster
 * data: URL) and CSS imports are dropped.
 */

const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'metadata', 'style',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'marker', 'image',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feDropShadow', 'feFlood',
  'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset',
]);

// Wrappers whose children are kept even though the element itself goes.
const UNWRAP = new Set(['a', 'switch']);

const ATTRIBUTES = new Set([
  'id', 'class', 'style', 'transform', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'fx', 'fy', 'fr', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'points', 'pathLength',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'color',
  'clip-path', 'clip-rule', 'mask', 'filter', 'display', 'visibility', 'overflow',
  'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod',
  'patternUnits', 'patternContentUnits', 'patternTransform', 'clipPathUnits', 'maskUnits', 'maskContentUnits',
  'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient', 'marker-start', 'marker-mid', 'marker-end',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'text-anchor', 'dominant-baseline',
  'alignment-baseline', 'baseline-shift', 'letter-spacing', 'word-spacing', 'text-decoration', 'dx', 'dy',
  'rotate', 'textLength', 'lengthAdjust', 'startOffset', 'method', 'spacing', 'side',
  'vector-effect', 'shape-rendering', 'text-rendering', 'image-rendering', 'paint-order', 'mix-blend-mode', 'isolation',
  'filterUnits', 'primitiveUnits', 'in', 'in2', 'result', 'mode', 'values', 'type', 'operator',
  'k1', 'k2', 'k3', 'k4', 'stdDeviation', 'flood-color', 'flood-opacity', 'radius', 'tableValues',
  'slope', 'intercept', 'amplitude', 'exponent', 'color-interpolation-filters', 'enable-background',
  'xmlns', 'xmlns:xlink', 'version', 'xml:space', 'href', 'xlink:href',
]);

const MAX_DEPTH = 64;

/** True for a reference that stays inside the file or is an embedded raster. */
function safeHref(value) {
  const v = String(value).trim();
  return /^#[\w.:-]+$/.test(v) || /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(v);
}

/** CSS from a style attribute or <style> element, without imports or outside URLs. */
function sanitizeCss(css) {
  return String(css)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, target) => (/^#[\w.:-]+$/.test(target.trim()) ? m : 'none'))
    .replace(/expression\s*\(|behavior\s*:|-moz-binding|javascript:/gi, '')
    .replace(/</g, '');
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Text content: XML's own entities and numeric ones stay; any other "&" is escaped. */
function escapeText(text) {
  return String(text)
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')
    .replace(/>/g, '&gt;');
}

function decodeAttr(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseAttributes(source) {
  const attrs = [];
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    attrs.push([m[1], decodeAttr(m[2] ?? m[3] ?? m[4] ?? '')]);
  }
  return attrs;
}

function keepAttribute(element, name, value) {
  if (!ATTRIBUTES.has(name)) return null;
  const v = String(value);
  if (/javascript:|vbscript:|expression\s*\(/i.test(v)) return null;
  if (name === 'href' || name === 'xlink:href') return safeHref(v) ? v.trim() : null;
  if (name === 'style') return sanitizeCss(v);
  if (/url\(/i.test(v)) {
    const ok = [...v.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].every((m) => /^#[\w.:-]+$/.test(m[2].trim()));
    if (!ok) return null;
  }
  return v;
}

/**
 * Return sanitized SVG markup, or throw when the input isn't an SVG
 * document. The root element always declares the SVG namespace, which
 * browsers need to draw an SVG from an image URL.
 */
function sanitizeSvg(input) {
  let src = Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '');
  src = src.replace(/^﻿/, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/gi, '');

  const out = [];
  const stack = []; // { name, kept }
  let dropping = 0; // depth inside an element dropped with its content
  let sawRoot = false;
  let usesXlink = false;
  let pos = 0;
  const tagRe = /<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(src)) !== null) {
    const text = src.slice(pos, m.index);
    pos = tagRe.lastIndex;
    const inStyle = stack.length && stack[stack.length - 1].name === 'style' && stack[stack.length - 1].kept;
    if (text && !dropping && sawRoot) out.push(inStyle ? sanitizeCss(text) : escapeText(text.replace(/</g, '')));
    if (m[1] !== undefined) {
      if (!dropping && sawRoot) out.push(inStyle ? sanitizeCss(m[1]) : escapeText(m[1]).replace(/</g, '&lt;'));
      continue;
    }
    const closing = m[2] === '/';
    const name = m[3];
    const selfClosing = m[5] === '/';
    if (closing) {
      // Close back to the matching element; stray closing tags are ignored.
      let i = stack.length - 1;
      while (i >= 0 && stack[i].name !== name) i -= 1;
      if (i < 0) continue;
      while (stack.length > i) {
        const top = stack.pop();
        if (top.dropped) dropping -= 1;
        else if (top.kept) out.push(`</${top.name}>`);
      }
      continue;
    }
    if (!sawRoot) {
      if (name !== 'svg') throw new Error('Not an SVG image.');
      sawRoot = true;
    }
    if (stack.length >= MAX_DEPTH) throw new Error('The SVG is nested too deeply.');
    let entry;
    if (dropping) {
      entry = { name, dropped: true };
      dropping += 1;
    } else if (ELEMENTS.has(name)) {
      const attrs = [];
      for (const [attr, value] of parseAttributes(m[4])) {
        const kept = keepAttribute(name, attr, value);
        if (kept === null) continue;
        if (attr.startsWith('xlink:')) usesXlink = true;
        attrs.push(`${attr}="${escapeAttr(kept)}"`);
      }
      if (name === 'svg' && stack.length === 0) {
        const withoutNs = attrs.filter((a) => !a.startsWith('xmlns=') && !a.startsWith('xmlns:xlink='));
        attrs.length = 0;
        attrs.push('xmlns="http://www.w3.org/2000/svg"', ...withoutNs);
      }
      out.push(`<${name}${attrs.length ? ` ${attrs.join(' ')}` : ''}${selfClosing ? '/' : ''}>`);
      entry = { name, kept: true };
    } else if (UNWRAP.has(name)) {
      entry = { name, kept: false };
    } else {
      entry = { name, dropped: true };
      dropping += 1;
    }
    if (selfClosing) {
      if (entry.dropped) dropping -= 1;
      continue;
    }
    stack.push(entry);
  }
  if (!sawRoot) throw new Error('Not an SVG image.');
  while (stack.length) {
    const top = stack.pop();
    if (top.kept) out.push(`</${top.name}>`);
  }
  let svg = out.join('');
  if (usesXlink) svg = svg.replace(/^<svg /, '<svg xmlns:xlink="http://www.w3.org/1999/xlink" ');
  return svg;
}

function cssLength(value) {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/i.exec(String(value || ''));
  return m ? Number(m[1]) : 0;
}

/** The drawing size of a (sanitized) SVG: its width/height, else its viewBox. */
function svgSize(svg) {
  const root = /<svg\b([^>]*)>/i.exec(String(svg));
  if (!root) return { width: 0, height: 0 };
  const attrs = Object.fromEntries(parseAttributes(root[1]));
  let width = cssLength(attrs.width);
  let height = cssLength(attrs.height);
  const box = String(attrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
  if (box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
    if (!width && !height) { width = box[2]; height = box[3]; }
    else if (!width) width = (height * box[2]) / box[3];
    else if (!height) height = (width * box[3]) / box[2];
  }
  return { width: Math.round(width), height: Math.round(height) };
}

module.exports = { sanitizeSvg, svgSize, sanitizeCss };
