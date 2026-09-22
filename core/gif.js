'use strict';

/**
 * GIF89a encoder (pure JS). Each frame gets its own 256-color palette built
 * by median cut, so screenshots keep their real UI colors instead of
 * banding into a fixed palette. Full-frame LZW-compressed frames and a
 * NETSCAPE looping extension; deterministic output.
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

/** Map an RGBA image to indices in the fixed palette. */
function toIndices(img) {
  const n = img.width * img.height;
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    out[i] = quantizeIndex(img.data[p], img.data[p + 1], img.data[p + 2]);
  }
  return out;
}

// Colors are bucketed at 6 bits per channel (262144 buckets) for median cut.
const BITS = 6;
const SHIFT = 8 - BITS;
const keyOf = (r, g, b) => ((r >> SHIFT) << (2 * BITS)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);

/**
 * Build an adaptive palette for one frame with median cut and map every
 * pixel to its nearest entry. Returns { palette: Buffer(768), indices }.
 */
function quantizeFrame(img) {
  const n = img.width * img.height;
  const count = new Map(); // key -> [pixels, sumR, sumG, sumB]
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const r = img.data[p], g = img.data[p + 1], b = img.data[p + 2];
    const k = keyOf(r, g, b);
    const e = count.get(k);
    if (e) { e[0]++; e[1] += r; e[2] += g; e[3] += b; } else count.set(k, [1, r, g, b]);
  }
  const colors = [...count.values()].map(([c, r, g, b]) => ({ c, r: r / c, g: g / c, b: b / c }));

  // Variance-based median cut: repeatedly split the box with the largest
  // squared error, at the point along its widest channel that minimizes the
  // error of the two halves. A dominant background color can't swallow the
  // light UI tones next to it this way.
  const stats = (box) => {
    let c = 0, sr = 0, sg = 0, sb = 0, sq = 0;
    for (const col of box) {
      c += col.c; sr += col.r * col.c; sg += col.g * col.c; sb += col.b * col.c;
      sq += (col.r * col.r + col.g * col.g + col.b * col.b) * col.c;
    }
    return { c, sse: sq - (sr * sr + sg * sg + sb * sb) / c };
  };
  const boxes = [{ colors, ...stats(colors) }];
  while (boxes.length < 256) {
    let pick = -1;
    boxes.forEach((box, i) => {
      if (box.colors.length > 1 && box.sse > 1e-6 && (pick < 0 || box.sse > boxes[pick].sse)) pick = i;
    });
    if (pick < 0) break;
    const box = boxes[pick].colors;
    let ch = 'r', widest = -1;
    for (const k of ['r', 'g', 'b']) {
      let lo = 255, hi = 0;
      for (const col of box) { if (col[k] < lo) lo = col[k]; if (col[k] > hi) hi = col[k]; }
      if (hi - lo > widest) { widest = hi - lo; ch = k; }
    }
    box.sort((x, y) => x[ch] - y[ch]);
    let totalC = 0, totalS = 0, totalQ = 0;
    for (const col of box) { totalC += col.c; totalS += col[ch] * col.c; totalQ += col[ch] * col[ch] * col.c; }
    let accC = 0, accS = 0, accQ = 0, cut = 1, best = Infinity;
    for (let i = 0; i < box.length - 1; i++) {
      const col = box[i];
      accC += col.c; accS += col[ch] * col.c; accQ += col[ch] * col[ch] * col.c;
      if (box[i + 1][ch] === col[ch]) continue;
      const restC = totalC - accC, restS = totalS - accS, restQ = totalQ - accQ;
      const err = (accQ - (accS * accS) / accC) + (restQ - (restS * restS) / restC);
      if (err < best) { best = err; cut = i + 1; }
    }
    const left = box.slice(0, cut), right = box.slice(cut);
    boxes.splice(pick, 1, { colors: left, ...stats(left) }, { colors: right, ...stats(right) });
  }

  const palette = Buffer.alloc(256 * 3);
  const entries = boxes.map(({ colors: box }, i) => {
    let c = 0, r = 0, g = 0, b = 0;
    for (const col of box) { c += col.c; r += col.r * col.c; g += col.g * col.c; b += col.b * col.c; }
    const e = [Math.round(r / c), Math.round(g / c), Math.round(b / c)];
    palette[i * 3] = e[0]; palette[i * 3 + 1] = e[1]; palette[i * 3 + 2] = e[2];
    return e;
  });

  const nearest = new Map();
  for (const [k, [c, sr, sg, sb]] of count) {
    const r = sr / c, g = sg / c, b = sb / c;
    let best = 0, bestD = Infinity;
    entries.forEach(([pr, pg, pb], i) => {
      const d = 2 * (r - pr) ** 2 + 4 * (g - pg) ** 2 + 3 * (b - pb) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    nearest.set(k, best);
  }
  const indices = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    indices[i] = nearest.get(keyOf(img.data[p], img.data[p + 1], img.data[p + 2]));
  }
  return { palette, indices };
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
 * delayCs is the per-frame delay in centiseconds, or `delays` gives one per
 * frame; loop 0 = forever.
 */
function encodeGif(frames, { delayCs = 150, delays = null, loop = 0 } = {}) {
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
  const quantized = frames.map(quantizeFrame);
  parts.push(lsd, quantized[0].palette);

  // NETSCAPE2.0 looping extension
  parts.push(Buffer.from([0x21, 0xff, 0x0b]));
  parts.push(Buffer.from('NETSCAPE2.0', 'latin1'));
  parts.push(Buffer.from([0x03, 0x01, loop & 0xff, (loop >> 8) & 0xff, 0x00]));

  frames.forEach((frame, i) => {
    if (frame.width !== width || frame.height !== height) {
      throw new Error('gif: all frames must share dimensions');
    }
    const gce = Buffer.alloc(8);
    gce[0] = 0x21; gce[1] = 0xf9; gce[2] = 4;
    gce[3] = 0x04; // disposal: do not dispose
    gce.writeUInt16LE(Math.max(2, Math.round((delays && delays[i]) || delayCs)), 4);
    gce[6] = 0; gce[7] = 0;
    parts.push(gce);

    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(0, 1); desc.writeUInt16LE(0, 3);
    desc.writeUInt16LE(width, 5); desc.writeUInt16LE(height, 7);
    // Frame 0 uses the global table; later frames carry their own.
    desc[9] = i === 0 ? 0 : 0x87;
    parts.push(desc);
    if (i > 0) parts.push(quantized[i].palette);
    parts.push(lzwEncode(quantized[i].indices));
  });

  parts.push(Buffer.from([0x3b])); // trailer
  return Buffer.concat(parts);
}

module.exports = { encodeGif, PALETTE, quantizeIndex, toIndices, quantizeFrame, lzwEncode };
