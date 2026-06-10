'use strict';

/**
 * Minimal GIF decoder used only by tests to verify the encoder end-to-end:
 * parses header/palette/frames and decompresses LZW back to RGB pixels.
 */

function decodeGif(buf) {
  if (buf.toString('latin1', 0, 6) !== 'GIF89a') throw new Error('not GIF89a');
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  const gctSize = packed & 0x80 ? 2 << (packed & 0x07) : 0;
  let pos = 13;
  const palette = buf.subarray(pos, pos + gctSize * 3);
  pos += gctSize * 3;

  const frames = [];
  let loops = null;
  while (pos < buf.length) {
    const block = buf[pos++];
    if (block === 0x3b) break; // trailer
    if (block === 0x21) { // extension
      const label = buf[pos++];
      if (label === 0xff) {
        const size = buf[pos];
        const app = buf.toString('latin1', pos + 1, pos + 1 + size);
        pos += 1 + size;
        const sub = [];
        while (buf[pos] !== 0) { sub.push(buf.subarray(pos + 1, pos + 1 + buf[pos])); pos += 1 + buf[pos]; }
        pos++;
        if (app.startsWith('NETSCAPE')) loops = Buffer.concat(sub).readUInt16LE(1);
      } else {
        while (buf[pos] !== 0) pos += 1 + buf[pos];
        pos++;
      }
    } else if (block === 0x2c) { // image descriptor
      const fw = buf.readUInt16LE(pos + 4);
      const fh = buf.readUInt16LE(pos + 6);
      const lpacked = buf[pos + 8];
      pos += 9;
      if (lpacked & 0x80) pos += (2 << (lpacked & 0x07)) * 3;
      const minCode = buf[pos++];
      const chunks = [];
      while (buf[pos] !== 0) { chunks.push(buf.subarray(pos + 1, pos + 1 + buf[pos])); pos += 1 + buf[pos]; }
      pos++;
      const indices = lzwDecode(Buffer.concat(chunks), minCode, fw * fh);
      frames.push({ width: fw, height: fh, indices });
    } else {
      throw new Error(`unknown block 0x${block.toString(16)} at ${pos - 1}`);
    }
  }
  return { width, height, palette, frames, loops };
}

function lzwDecode(data, minCode, expectedPixels) {
  const CLEAR = 1 << minCode;
  const EOI = CLEAR + 1;
  let codeSize = minCode + 1;
  let dict = [];
  const resetDict = () => {
    dict = [];
    for (let i = 0; i < CLEAR; i++) dict[i] = [i];
    dict[CLEAR] = null; dict[EOI] = null;
    codeSize = minCode + 1;
  };
  resetDict();

  const out = [];
  let bitPos = 0;
  let prev = null;
  const readCode = () => {
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const byte = data[bitPos >> 3];
      if (byte === undefined) return -1;
      code |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return code;
  };

  for (;;) {
    const code = readCode();
    if (code < 0 || code === EOI) break;
    if (code === CLEAR) { resetDict(); prev = null; continue; }
    let entry;
    if (dict[code]) entry = dict[code];
    else if (code === dict.length && prev) entry = [...prev, prev[0]];
    else throw new Error(`bad LZW code ${code} (dict ${dict.length})`);
    out.push(...entry);
    if (prev) {
      dict.push([...prev, entry[0]]);
      if (dict.length === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = entry;
    if (out.length >= expectedPixels) break;
  }
  return out;
}

module.exports = { decodeGif };
