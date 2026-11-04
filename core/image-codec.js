'use strict';

// Load the Node-API codec only when an image needs it. The same codec works in
// Electron, export workers and the headless MCP process on Windows and Linux.
const sharp = (...args) => require('sharp')(...args);

function createImageCodec() {
  return {
    async decodeToPng(buffer) {
      return sharp(buffer).autoOrient().ensureAlpha().png().toBuffer();
    },
    async encodeWebp(png, { lossless = true, quality = 0.95 } = {}) {
      const metadata = await sharp(png).metadata();
      // WebP is 8-bit and single-frame here. Keep inputs we cannot preserve.
      if (metadata.depth !== 'uchar' || metadata.bitsPerSample > 8 || metadata.pages > 1
        || metadata.orientation > 1 || metadata.width > 16383 || metadata.height > 16383) return null;
      const options = { lossless, quality: Math.round(quality * 100), alphaQuality: 100, exact: true, effort: 4 };
      const webp = await sharp(png).keepMetadata().webp(options).toBuffer();
      if (!lossless) {
        // Text and small colored UI edges are vulnerable to chroma artifacts.
        // Fall back to lossless when a high-quality lossy candidate changes
        // alpha, an individual channel by >8, or RMS color error by >1.5/255.
        const before = await sharp(png).ensureAlpha().raw().toBuffer();
        const after = await sharp(webp).ensureAlpha().raw().toBuffer();
        let error = 0;
        let acceptable = before.length === after.length;
        for (let i = 0; acceptable && i < before.length; i++) {
          const delta = Math.abs(before[i] - after[i]);
          if ((i % 4 === 3 && delta !== 0) || delta > 8) acceptable = false;
          else if (i % 4 !== 3) error += delta * delta;
        }
        if (!acceptable || Math.sqrt(error / (before.length * 0.75)) > 1.5) {
          return sharp(png).keepMetadata().webp({ ...options, lossless: true }).toBuffer();
        }
      }
      return webp;
    },
    close() {},
  };
}

module.exports = { createImageCodec };
