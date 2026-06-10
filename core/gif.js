'use strict';

/**
 * GIF89a encoder (pure JS). Uses a fixed 6x7x6 RGB palette (252 colors),
 * full-frame LZW-compressed frames, and a NETSCAPE looping extension.
 * Good enough for screenshot slideshows; deterministic output.
 */

const R_LEVELS = 6, G_LEVELS = 7, B_LEVELS = 6;

function buildPalette() {
  const palette = Buffer.alloc(256 * 3);
  let i = 0;
  for (let r = 0; r < R_LEVELS; r++) {
    for (let g = 0; g < G_LEVELS; g++) {
      for (let b = 0; b < B_LEVELS; b++) {
        palette[i * 3] = Math.round((r * 255) / (R_LEVELS - 1));
        palette[i * 3 + 1] = Math.round((g * 255) / (G_LEVELS - 1));
        palette[i * 3 + 2] = Math.round((b * 255) / (B_LEVELS - 1));
        i++;
      }
    }
  }
  return palette; // remaining entries stay black
}

const PALETTE = buildPalette();

function quantizeIndex(r, g, b) {
  const ri = Math.round((r / 255) * (R_LEVELS - 1));
  const gi = Math.round((g / 255) * (G_LEVELS - 1));
  const bi = Math.round((b / 255) * (B_LEVELS - 1));
  return ri * G_LEVELS * B_LEVELS + gi * B_LEVELS + bi;
}

/** Map an RGBA image to palette indices. */
function toIndices(img) {
  const n = img.width * img.height;
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    out[i] = quantizeIndex(img.data[p], img.data[p + 1], img.data[p + 2]);
  }
  return out;
}

/** GIF LZW compression of palette indices, minCodeSize 8. */
function lzwEncode(indices) {
  const MIN_CODE = 8;
  const CLEAR = 1 << MIN_CODE;        // 256
  const EOI = CLEAR + 1;              // 257
  const MAX_CODE = 4096;

  const bytes = [];
  let bitBuf = 0, bitCnt = 0;
  let codeSize = MIN_CODE + 1;
  const emit = (code) => {
    bitBuf |= code << bitCnt;
    bitCnt += codeSize;
    while (bitCnt >= 8) {
      bytes.push(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCnt -= 8;
    }
  };

  let dict = new Map();
  let next = EOI + 1;
  const reset = () => { dict = new Map(); next = EOI + 1; codeSize = MIN_CODE + 1; };

  emit(CLEAR);
  let prefix = -1;
  for (let i = 0; i < indices.length; i++) {
    const c = indices[i];
    if (prefix < 0) { prefix = c; continue; }
    const key = prefix * 256 + c;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
    } else {
      emit(prefix);
      dict.set(key, next);
      next++;
      // The decoder builds its table one entry behind the encoder, so the
      // width change happens at (1<<codeSize)+1, not (1<<codeSize).
      if (next === (1 << codeSize) + 1 && codeSize < 12) codeSize++;
      if (next >= MAX_CODE) {
        emit(CLEAR);
        reset();
      }
      prefix = c;
    }
  }
  if (prefix >= 0) emit(prefix);
  emit(EOI);
  if (bitCnt > 0) bytes.push(bitBuf & 0xff);

  // Pack into <=255-byte sub-blocks
  const out = [Buffer.from([MIN_CODE])];
  for (let i = 0; i < bytes.length; i += 255) {
    const blockData = bytes.slice(i, i + 255);
    out.push(Buffer.from([blockData.length]), Buffer.from(blockData));
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

/**
 * Encode frames (RGBA images, all same size) into an animated GIF.
 * delayCs is per-frame delay in centiseconds; loop 0 = forever.
 */
function encodeGif(frames, { delayCs = 150, loop = 0 } = {}) {
  if (!frames.length) throw new Error('gif: no frames');
  const { width, height } = frames[0];
  const parts = [];

  parts.push(Buffer.from('GIF89a', 'latin1'));
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0xf7; // GCT present, 8-bit color, 256 entries
  lsd[5] = 0;    // background color
  lsd[6] = 0;    // aspect
  parts.push(lsd, PALETTE);

  // NETSCAPE2.0 looping extension
  parts.push(Buffer.from([0x21, 0xff, 0x0b]));
  parts.push(Buffer.from('NETSCAPE2.0', 'latin1'));
  parts.push(Buffer.from([0x03, 0x01, loop & 0xff, (loop >> 8) & 0xff, 0x00]));

  for (const frame of frames) {
    if (frame.width !== width || frame.height !== height) {
      throw new Error('gif: all frames must share dimensions');
    }
    const gce = Buffer.alloc(8);
    gce[0] = 0x21; gce[1] = 0xf9; gce[2] = 4;
    gce[3] = 0x04; // disposal: do not dispose
    gce.writeUInt16LE(Math.max(2, Math.round(delayCs)), 4);
    gce[6] = 0; gce[7] = 0;
    parts.push(gce);

    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(0, 1); desc.writeUInt16LE(0, 3);
    desc.writeUInt16LE(width, 5); desc.writeUInt16LE(height, 7);
    desc[9] = 0; // no local color table
    parts.push(desc, lzwEncode(toIndices(frame)));
  }

  parts.push(Buffer.from([0x3b])); // trailer
  return Buffer.concat(parts);
}

module.exports = { encodeGif, PALETTE, quantizeIndex, toIndices, lzwEncode };
