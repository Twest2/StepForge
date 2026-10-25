'use strict';

const zlib = require('node:zlib');
const { crc32 } = require('./zip');

/**
 * Pure-JS PNG codec. Decodes 8-bit greyscale/RGB/palette/grey+alpha/RGBA
 * (non-interlaced) into RGBA; encodes RGBA. Enough for screenshots and
 * export rasterization without native dependencies.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DIM = 32768;

function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 57 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('png: bad signature');
  }
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];

  while (pos + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(pos);
    const type = buffer.toString('latin1', pos + 4, pos + 8);
    const dataStart = pos + 8;
    if (len > buffer.length - dataStart) throw new Error('png: truncated chunk');
    const data = buffer.subarray(dataStart, dataStart + len);
    const expectCrc = buffer.readUInt32BE(dataStart + len);
    if (crc32(buffer.subarray(pos + 4, dataStart + len)) !== expectCrc) {
      throw new Error(`png: CRC mismatch in ${type}`);
    }
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      if (width <= 0 || height <= 0 || width > MAX_DIM || height > MAX_DIM) {
        throw new Error('png: unreasonable dimensions');
      }
      if (bitDepth !== 8) throw new Error(`png: unsupported bit depth ${bitDepth}`);
      if (![0, 2, 3, 4, 6].includes(colorType)) throw new Error(`png: bad color type ${colorType}`);
      if (interlace !== 0) throw new Error('png: interlaced images not supported');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos = dataStart + len + 4;
  }
  if (!width) throw new Error('png: missing IHDR');
  if (idat.length === 0) throw new Error('png: missing IDAT');

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const bpp = channels; // bytes per pixel at 8-bit depth
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error('png: scanline data too short');

  // Unfilter
  const lines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = (stride + 1) * y + 1;
    const dst = stride * y;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[src + x];
      const left = x >= bpp ? lines[dst + x - bpp] : 0;
      const up = y > 0 ? lines[dst + x - stride] : 0;
      const upLeft = y > 0 && x >= bpp ? lines[dst + x - stride - bpp] : 0;
      let val;
      switch (filter) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + left; break;
        case 2: val = rawByte + up; break;
        case 3: val = rawByte + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
          val = rawByte + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default: throw new Error(`png: bad filter ${filter}`);
      }
      lines[dst + x] = val & 0xff;
    }
  }

  // Expand to RGBA
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const s = i * bpp;
    switch (colorType) {
      case 0:
        out[p] = out[p + 1] = out[p + 2] = lines[s];
        out[p + 3] = 255;
        break;
      case 2:
        out[p] = lines[s]; out[p + 1] = lines[s + 1]; out[p + 2] = lines[s + 2];
        out[p + 3] = 255;
        break;
      case 3: {
        const idx = lines[s];
        if (!palette || idx * 3 + 2 >= palette.length) throw new Error('png: palette index out of range');
        out[p] = palette[idx * 3]; out[p + 1] = palette[idx * 3 + 1]; out[p + 2] = palette[idx * 3 + 2];
        out[p + 3] = trns && idx < trns.length ? trns[idx] : 255;
        break;
      }
      case 4:
        out[p] = out[p + 1] = out[p + 2] = lines[s];
        out[p + 3] = lines[s + 1];
        break;
      case 6:
        out[p] = lines[s]; out[p + 1] = lines[s + 1]; out[p + 2] = lines[s + 2];
        out[p + 3] = lines[s + 3];
        break;
    }
  }
  return { width, height, data: out };
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function isOpaque(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
  return true;
}

// A filtered byte read as a signed value, by magnitude: libpng's heuristic
// for which filter will deflate smallest is the row with the lowest sum.
const COST = Uint8Array.from({ length: 256 }, (_, b) => (b < 128 ? b : 256 - b));

/**
 * Filter every scanline with the filter that suits it (none, sub, up,
 * average or paeth), each row prefixed by its filter type byte.
 */
function filterAdaptive(pixels, height, stride, bpp) {
  const raw = Buffer.alloc((stride + 1) * height);
  const candidates = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  const [none, sub, up, avg, paeth] = candidates;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = row - stride;
    let c0 = 0, c1 = 0, c2 = 0, c3 = 0, c4 = 0;
    for (let x = 0; x < stride; x++) {
      const v = pixels[row + x];
      const a = x >= bpp ? pixels[row + x - bpp] : 0;
      const b = y > 0 ? pixels[prev + x] : 0;
      const c = y > 0 && x >= bpp ? pixels[prev + x - bpp] : 0;
      const p = a + b - c;
      const pa = p > a ? p - a : a - p, pb = p > b ? p - b : b - p, pc = p > c ? p - c : c - p;
      const f1 = (v - a) & 0xff, f2 = (v - b) & 0xff, f3 = (v - ((a + b) >> 1)) & 0xff;
      const f4 = (v - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      none[x] = v; sub[x] = f1; up[x] = f2; avg[x] = f3; paeth[x] = f4;
      c0 += COST[v]; c1 += COST[f1]; c2 += COST[f2]; c3 += COST[f3]; c4 += COST[f4];
    }
    const costs = [c0, c1, c2, c3, c4];
    let best = 0;
    for (let f = 1; f < 5; f++) if (costs[f] < costs[best]) best = f;
    raw[y * (stride + 1)] = best;
    candidates[best].copy(raw, y * (stride + 1) + 1);
  }
  return raw;
}

function filterNone(pixels, height, stride) {
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return raw;
}

/**
 * Encode an RGBA image { width, height, data } to PNG bytes. Opaque images
 * (every screenshot) are written as RGB, and scanlines are filtered, which
 * makes screenshots about a fifth smaller than RGBA with no filtering.
 * Lossless either way.
 */
function encodePng(img) {
  const { width, height, data } = img;
  if (!width || !height || data.length !== width * height * 4) {
    throw new Error('png: encode expects RGBA data of width*height*4');
  }
  const opaque = isOpaque(data);
  const bpp = opaque ? 3 : 4;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = opaque ? 2 : 6;  // RGB : RGBA
  // compression/filter/interlace = 0

  const stride = width * bpp;
  let pixels = data;
  if (opaque) {
    pixels = Buffer.alloc(stride * height);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      pixels[j] = data[i]; pixels[j + 1] = data[i + 1]; pixels[j + 2] = data[i + 2];
    }
  }

  // The filter heuristic misjudges large flat areas (plain UI screenshots),
  // where leaving rows unfiltered deflates smaller, so keep the smaller.
  const filtered = zlib.deflateSync(filterAdaptive(pixels, height, stride, bpp), { level: 6 });
  const plain = zlib.deflateSync(filterNone(pixels, height, stride), { level: 6 });
  const idat = plain.length < filtered.length ? plain : filtered;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { decodePng, encodePng };
