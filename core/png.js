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

/** Encode an RGBA image { width, height, data } to PNG bytes. */
function encodePng(img) {
  const { width, height, data } = img;
  if (!width || !height || data.length !== width * height * 4) {
    throw new Error('png: encode expects RGBA data of width*height*4');
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  // compression/filter/interlace = 0

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { decodePng, encodePng };
