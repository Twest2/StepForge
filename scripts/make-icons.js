#!/usr/bin/env node
'use strict';

// Generate runtime and packaging icons from the supplied artwork in assets/images.
// Generated files are committed so builds need no image tooling or network access.

const fs = require('node:fs');
const path = require('node:path');
const { decodePng, encodePng } = require('../core/png');
const { resize } = require('../core/raster');

const OUT_DIR = path.join(__dirname, '..', 'packaging', 'assets', 'icons');
const SOURCE_DIR = path.join(__dirname, '..', 'assets', 'images');
const SOURCE = path.join(SOURCE_DIR, 'StepForge_logo.png');
const APP_DIR = path.join(__dirname, '..', 'app', 'assets');
// electron-builder's AppX build-resources folder: the Microsoft Store tiles.
const APPX_DIR = path.join(__dirname, '..', 'build', 'appx');
const SIZES = [16, 32, 48, 64, 128, 256, 512];
// [file, width, height, logo size]. The Square44x44 target sizes are the
// taskbar and Start list icons; "altform-unplated" draws them without a tile
// plate behind them.
const APPX_ASSETS = [
  ['StoreLogo.png', 50, 50, 50],
  ['Square44x44Logo.png', 44, 44, 44],
  ...[16, 24, 32, 48, 256].map((size) => [`Square44x44Logo.targetsize-${size}_altform-unplated.png`, size, size, size]),
  ['Square150x150Logo.png', 150, 150, 100],
  ['Wide310x150Logo.png', 310, 150, 100],
];

function renderIcon(size) {
  let source = decodePng(fs.readFileSync(SOURCE));
  // Reduce in stages so small desktop icons retain smooth edges and detail.
  while (source.width > size * 2) {
    source = resize(source, Math.ceil(source.width / 2), Math.ceil(source.height / 2));
  }
  return resize(source, size, size);
}

/** The logo centered on a transparent width × height tile. */
function renderTile(width, height, logoSize) {
  const logo = renderIcon(logoSize);
  if (logo.width === width && logo.height === height) return logo;
  const tile = { width, height, data: Buffer.alloc(width * height * 4) };
  const left = Math.floor((width - logoSize) / 2), top = Math.floor((height - logoSize) / 2);
  for (let y = 0; y < logoSize; y++) {
    logo.data.copy(tile.data, ((top + y) * width + left) * 4, y * logoSize * 4, (y + 1) * logoSize * 4);
  }
  return tile;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const size of SIZES) {
    const png = encodePng(renderIcon(size));
    fs.writeFileSync(path.join(OUT_DIR, `stepforge-${size}.png`), png);
  }
  fs.copyFileSync(path.join(OUT_DIR, 'stepforge-256.png'), path.join(OUT_DIR, 'stepforge.png'));
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.copyFileSync(path.join(OUT_DIR, 'stepforge-512.png'), path.join(APP_DIR, 'stepforge.png'));
  fs.copyFileSync(path.join(SOURCE_DIR, 'StepForge_logo.ico'), path.join(APP_DIR, 'stepforge.ico'));
  fs.copyFileSync(path.join(SOURCE_DIR, 'StepForge_logo.svg'), path.join(OUT_DIR, '..', 'stepforge.svg'));
  fs.mkdirSync(APPX_DIR, { recursive: true });
  for (const [file, width, height, logoSize] of APPX_ASSETS) {
    fs.writeFileSync(path.join(APPX_DIR, file), encodePng(renderTile(width, height, logoSize)));
  }
  console.log(`wrote packaging, application and Microsoft Store icons from ${path.basename(SOURCE)}`);
}

if (require.main === module) main();

module.exports = { renderIcon, renderTile, SIZES, APPX_ASSETS };
