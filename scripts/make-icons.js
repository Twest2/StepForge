#!/usr/bin/env node
'use strict';

// Generate the StepForge PNG icon set from original geometry using the repo's
// own rasterizer + PNG writer (no external image tooling or third-party art).
// Mirrors packaging/assets/stepforge.svg. Output: packaging/assets/icons/.

const fs = require('node:fs');
const path = require('node:path');
const { createImage, fillRect, fillOval } = require('../core/raster');
const { encodePng } = require('../core/png');

const OUT_DIR = path.join(__dirname, '..', 'packaging', 'assets', 'icons');
const SIZES = [16, 32, 48, 64, 128, 256, 512];

const BG_TOP = [37, 99, 235, 255];
const BG_BOTTOM = [30, 58, 138, 255];
const WHITE = [255, 255, 255, 255];
const SPARK = [250, 204, 21, 255];

function lerp(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    255,
  ];
}

function renderIcon(size) {
  const img = createImage(size, size, [0, 0, 0, 0]);
  const s = size / 256; // scale from the 256px reference design

  // Rounded-square background approximated by a vertical gradient fill.
  for (let y = 0; y < size; y += 1) {
    fillRect(img, 0, y, size, 1, lerp(BG_TOP, BG_BOTTOM, y / size));
  }

  // Three ascending steps (x, y, w, h in reference px).
  const steps = [
    [52, 150, 52, 54],
    [102, 116, 52, 88],
    [152, 82, 52, 122],
  ];
  for (const [x, y, w, h] of steps) {
    fillRect(img, Math.round(x * s), Math.round(y * s), Math.round(w * s), Math.round(h * s), WHITE);
  }

  // Capture spark on the top step.
  const r = Math.max(2, Math.round(16 * s));
  fillOval(img, Math.round(178 * s - r), Math.round(60 * s - r), r * 2, r * 2, SPARK);

  return img;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const size of SIZES) {
    const png = encodePng(renderIcon(size));
    fs.writeFileSync(path.join(OUT_DIR, `stepforge-${size}.png`), png);
  }
  // A conventional default name for the desktop entry / hicolor 256px slot.
  fs.copyFileSync(path.join(OUT_DIR, 'stepforge-256.png'), path.join(OUT_DIR, 'stepforge.png'));
  console.log(`wrote ${SIZES.length + 1} icons to ${OUT_DIR}`);
}

if (require.main === module) main();

module.exports = { renderIcon, SIZES };
