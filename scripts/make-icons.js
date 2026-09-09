#!/usr/bin/env node
'use strict';

// Generate the shipped PNG icon set from the approved 512px StepForge raster
// in this directory. Keeping the source in the icon set means packages use
// the same artwork as the development application without external tooling.

const fs = require('node:fs');
const path = require('node:path');
const { decodePng, encodePng } = require('../core/png');

const OUT_DIR = path.join(__dirname, '..', 'packaging', 'assets', 'icons');
const SOURCE = path.join(OUT_DIR, 'stepforge-512.png');
const SIZES = [16, 32, 48, 64, 128, 256, 512];

function renderIcon(size) {
  const source = decodePng(fs.readFileSync(SOURCE));
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor((y + 0.5) * source.height / size));
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor((x + 0.5) * source.width / size));
      const from = (sourceY * source.width + sourceX) * 4;
      source.data.copy(data, (y * size + x) * 4, from, from + 4);
    }
  }
  return { width: size, height: size, data };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const size of SIZES) {
    const png = encodePng(renderIcon(size));
    fs.writeFileSync(path.join(OUT_DIR, `stepforge-${size}.png`), png);
  }
  fs.copyFileSync(path.join(OUT_DIR, 'stepforge-256.png'), path.join(OUT_DIR, 'stepforge.png'));
  console.log(`wrote ${SIZES.length + 1} icons from ${path.basename(SOURCE)}`);
}

if (require.main === module) main();

module.exports = { renderIcon, SIZES };
