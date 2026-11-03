'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { decodePng } = require('./png');

/**
 * Screenshot storage formats. New captures are stored as WebP when Chromium
 * can encode them smaller than the PNG; old guides keep their PNGs. Every
 * reader goes through rasterToPng(), which passes PNG through and asks the
 * app's Chromium codec (see app/image-codec.js) to decode anything else, so
 * there is one place that knows how to turn stored bytes into PNG.
 */

const DEFAULT_WEBP_QUALITY = 0.95;
const MIN_WEBP_QUALITY = 0.8;
const MAX_WEBP_QUALITY = 1;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let activeCodec = null;

/**
 * Register the codec the app uses for WebP. `codec` has
 * `decodeToPng(buffer) -> Promise<Buffer>` and
 * `encodeWebp(png, quality) -> Promise<Buffer|null>`.
 */
function setImageCodec(codec) {
  activeCodec = codec || null;
}

function getImageCodec() {
  return activeCodec;
}

/** 'png' | 'webp' | 'jpeg' | 'gif' | 'bmp' | null, by content (never by name). */
function sniffImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.toString('latin1', 0, 3) === 'GIF') return 'gif';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'bmp';
  return null;
}

/** Pixel size from the header alone (PNG IHDR, WebP VP8X/VP8L/VP8), or null. */
function readImageSize(buffer) {
  const format = sniffImageFormat(buffer);
  if (format === 'png' && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (format !== 'webp' || buffer.length < 30) return null;
  const chunk = buffer.toString('latin1', 12, 16);
  if (chunk === 'VP8X') {
    return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
  }
  if (chunk === 'VP8L' && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/** File extension for bytes the store keeps: WebP or PNG. */
function storedExtension(buffer) {
  return sniffImageFormat(buffer) === 'webp' ? 'webp' : 'png';
}

function clampWebpQuality(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_WEBP_QUALITY;
  return Math.min(MAX_WEBP_QUALITY, Math.max(MIN_WEBP_QUALITY, n));
}

/** PNG bytes of an image of any format the codec can decode. PNG passes through. */
async function rasterToPng(buffer) {
  const format = sniffImageFormat(buffer);
  if (format === 'png') return buffer;
  if (!format) throw new Error('not an image');
  if (!activeCodec) throw new Error(`StepForge can't decode ${format} images here.`);
  return activeCodec.decodeToPng(buffer);
}

/**
 * Encode a PNG as WebP when that is smaller and keeps the pixel size. Only
 * opaque images are converted: Chromium's lossy WebP changes colours under
 * partial alpha, so those stay PNG. Returns { buffer, format }.
 */
async function optimizeScreenshot(png, { format = 'webp', webpQuality = DEFAULT_WEBP_QUALITY, codec = activeCodec } = {}) {
  if (sniffImageFormat(png) !== 'png' || format !== 'webp' || !codec) return { buffer: png, format: 'png' };
  if (hasPartialAlpha(png)) return { buffer: png, format: 'png' };
  const webp = await encodeWebpVerified(png, codec, webpQuality);
  if (!webp || webp.length >= png.length) return { buffer: png, format: 'png' };
  return { buffer: webp, format: 'webp' };
}

/** True when some pixel is neither opaque nor fully transparent-free: any alpha below 255. */
function hasPartialAlpha(png) {
  const colorType = png[25]; // IHDR colour type: 4 (grey+alpha) or 6 (RGBA) may carry alpha
  if (colorType !== 4 && colorType !== 6) return false;
  const { width, height, data } = decodePng(png);
  for (let i = 3; i < width * height * 4; i += 4) if (data[i] !== 255) return true;
  return false;
}

/** The WebP bytes, or null when the codec fails or changes the pixel size. */
async function encodeWebpVerified(png, codec, webpQuality) {
  const before = readImageSize(png);
  let webp = null;
  try {
    webp = await codec.encodeWebp(png, clampWebpQuality(webpQuality));
  } catch {
    return null;
  }
  if (!webp || sniffImageFormat(webp) !== 'webp') return null;
  const after = readImageSize(webp);
  if (!before || !after || before.width !== after.width || before.height !== after.height) return null;
  return webp;
}

/**
 * Export-time pixels for every step screenshot the store keeps as WebP:
 * Map of absolute file path -> PNG bytes, for the render AST to read.
 */
async function prepareExportImages(store, guideId, { codec = activeCodec } = {}) {
  const images = new Map();
  for (const [stepId, step] of store.listSteps(guideId)) {
    if (!step.image) continue;
    const absPath = path.join(store.stepDir(guideId, stepId), step.image.workingPath);
    if (images.has(absPath)) continue;
    const bytes = fs.readFileSync(absPath);
    if (sniffImageFormat(bytes) !== 'webp') continue;
    if (!codec) throw new Error(`StepForge can't decode the WebP screenshot in ${stepId}.`);
    images.set(absPath, await codec.decodeToPng(bytes));
  }
  return images;
}

module.exports = {
  DEFAULT_WEBP_QUALITY, MIN_WEBP_QUALITY, MAX_WEBP_QUALITY,
  setImageCodec, getImageCodec, sniffImageFormat, readImageSize, storedExtension,
  clampWebpQuality, rasterToPng, optimizeScreenshot, encodeWebpVerified, prepareExportImages, hasPartialAlpha,
};
