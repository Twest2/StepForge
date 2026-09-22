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
const SIZES = [16, 32, 48, 64, 128, 256, 512];

function renderIcon(size) {
  let source = decodePng(fs.readFileSync(SOURCE));
  // Reduce in stages so small desktop icons retain smooth edges and detail.
  while (source.width > size * 2) {
    source = resize(source, Math.ceil(source.width / 2), Math.ceil(source.height / 2));
  }
  return resize(source, size, size);
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
  console.log(`wrote packaging and application icons from ${path.basename(SOURCE)}`);
}

if (require.main === module) main();

module.exports = { renderIcon, SIZES };
