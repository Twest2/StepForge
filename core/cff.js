'use strict';

/**
 * Glyph outlines from an OpenType font's 'CFF ' table (Type 2 charstrings),
 * the format of most Linux CJK fonts (Noto Sans CJK, Source Han Sans). Only
 * outlines are read: character mapping and metrics come from the font's
 * cmap/hmtx tables (core/ttf.js). Hints are skipped. CID-keyed fonts pick
 * their local subroutines through FDSelect.
 */

function readOffset(buf, at, size) {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + buf[at + i];
  return v;
}

/** A CFF INDEX at `at`: its items as [start, end) byte ranges, and where it ends. */
function readIndex(buf, at) {
  const count = buf.readUInt16BE(at);
  if (!count) return { items: [], end: at + 2 };
  const size = buf[at + 2];
  const base = at + 3 + (count + 1) * size - 1; // offsets count from 1
  const items = [];
  let prev = readOffset(buf, at + 3, size);
  for (let i = 1; i <= count; i++) {
    const next = readOffset(buf, at + 3 + i * size, size);
    items.push([base + prev, base + next]);
    prev = next;
  }
  return { items, end: base + prev };
}

/** A CFF DICT as { operator: operands }; escaped operators are 1200 + the second byte. */
function readDict(buf, at, end) {
  const dict = {};
  let operands = [];
  while (at < end) {
    const b0 = buf[at];
    if (b0 <= 21) {
      const op = b0 === 12 ? 1200 + buf[at + 1] : b0;
      at += b0 === 12 ? 2 : 1;
      dict[op] = operands;
      operands = [];
    } else if (b0 === 28) { operands.push(buf.readInt16BE(at + 1)); at += 3; }
    else if (b0 === 29) { operands.push(buf.readInt32BE(at + 1)); at += 5; }
    else if (b0 === 30) {
      let text = '';
      for (at++; at < end; at++) {
        const nibbles = [buf[at] >> 4, buf[at] & 15];
        if (nibbles.some((n) => n === 15)) { text += nibbles[0] === 15 ? '' : realNibble(nibbles[0]); at++; break; }
        text += realNibble(nibbles[0]) + realNibble(nibbles[1]);
      }
      operands.push(Number(text) || 0);
    } else if (b0 >= 32 && b0 <= 246) { operands.push(b0 - 139); at += 1; }
    else if (b0 >= 247 && b0 <= 250) { operands.push((b0 - 247) * 256 + buf[at + 1] + 108); at += 2; }
    else if (b0 >= 251 && b0 <= 254) { operands.push(-(b0 - 251) * 256 - buf[at + 1] - 108); at += 2; }
    else at += 1; // reserved
  }
  return dict;
}

function realNibble(n) {
  return n < 10 ? String(n) : ['.', 'E', 'E-', '', '-'][n - 10] || '';
}

/** Subroutine numbers are stored relative to a bias that depends on how many there are. */
function bias(subrs) {
  return subrs.length < 1240 ? 107 : subrs.length < 33900 ? 1131 : 32768;
}

class CffOutlines {
  /** @param {Buffer} buf the font file; @param {number} offset where its 'CFF ' table starts. */
  constructor(buf, offset) {
    this.buf = buf;
    let at = offset + buf[offset + 2]; // header size
    at = readIndex(buf, at).end; // Name INDEX
    const tops = readIndex(buf, at);
    at = readIndex(buf, tops.end).end; // String INDEX
    this.globalSubrs = readIndex(buf, at).items;
    if (!tops.items.length) throw new Error('CFF table has no fonts');
    const top = readDict(buf, ...tops.items[0]);
    if (!top[17]) throw new Error('CFF font has no CharStrings');
    this.charStrings = readIndex(buf, offset + top[17][0]).items;
    const localSubrs = (dict) => {
      if (!dict[18] || dict[18].length < 2) return [];
      const [size, from] = dict[18];
      const priv = readDict(buf, offset + from, offset + from + size);
      return priv[19] ? readIndex(buf, offset + from + priv[19][0]).items : [];
    };
    if (top[1236] && top[1237]) { // CID-keyed: FDArray + FDSelect
      this.fontDicts = readIndex(buf, offset + top[1236][0]).items.map(([s, e]) => localSubrs(readDict(buf, s, e)));
      this.fdSelect = readFdSelect(buf, offset + top[1237][0], this.charStrings.length);
    } else {
      this.fontDicts = [localSubrs(top)];
      this.fdSelect = () => 0;
    }
  }

  /** Path commands for a glyph, in font units (same format as TrueTypeFont.outline). */
  outline(glyph) {
    const range = this.charStrings[glyph];
    if (!range) return [];
    const buf = this.buf;
    const globals = this.globalSubrs;
    const locals = this.fontDicts[this.fdSelect(glyph)] || [];
    const path = [];
    const stack = [];
    let x = 0, y = 0, stems = 0, widthRead = false, done = false;
    const takeWidth = (expected) => { if (!widthRead && stack.length > expected) stack.shift(); widthRead = true; };
    const stemHints = () => { takeWidth(stack.length & ~1); stems += stack.length >> 1; stack.length = 0; };
    const moveTo = (nx, ny) => { x = nx; y = ny; path.push(['M', x, y]); };
    const lineTo = (nx, ny) => { x = nx; y = ny; path.push(['L', x, y]); };
    const curveTo = (c1x, c1y, c2x, c2y, nx, ny) => { x = nx; y = ny; path.push(['C', c1x, c1y, c2x, c2y, x, y]); };
    const relCurve = (s, i) => {
      const c1x = x + s[i], c1y = y + s[i + 1], c2x = c1x + s[i + 2], c2y = c1y + s[i + 3];
      curveTo(c1x, c1y, c2x, c2y, c2x + s[i + 4], c2y + s[i + 5]);
    };

    const run = (start, end, depth) => {
      let at = start;
      while (at < end && !done) {
        const b0 = buf[at++];
        if (b0 === 28) { stack.push(buf.readInt16BE(at)); at += 2; continue; }
        if (b0 >= 32) {
          if (b0 <= 246) stack.push(b0 - 139);
          else if (b0 <= 250) stack.push((b0 - 247) * 256 + buf[at++] + 108);
          else if (b0 <= 254) stack.push(-(b0 - 251) * 256 - buf[at++] - 108);
          else { stack.push(buf.readInt32BE(at) / 65536); at += 4; }
          continue;
        }
        const s = stack;
        switch (b0) {
          case 1: case 3: case 18: case 23: stemHints(); break; // hstem, vstem, hstemhm, vstemhm
          case 19: case 20: stemHints(); at += (stems + 7) >> 3; break; // hintmask, cntrmask
          case 21: takeWidth(2); moveTo(x + s[0], y + s[1]); s.length = 0; break; // rmoveto
          case 22: takeWidth(1); moveTo(x + s[0], y); s.length = 0; break; // hmoveto
          case 4: takeWidth(1); moveTo(x, y + s[0]); s.length = 0; break; // vmoveto
          case 5: for (let i = 0; i + 1 < s.length; i += 2) lineTo(x + s[i], y + s[i + 1]); s.length = 0; break; // rlineto
          case 6: case 7: { // hlineto, vlineto: alternating
            let horizontal = b0 === 6;
            for (const v of s) { if (horizontal) lineTo(x + v, y); else lineTo(x, y + v); horizontal = !horizontal; }
            s.length = 0;
            break;
          }
          case 8: for (let i = 0; i + 5 < s.length; i += 6) relCurve(s, i); s.length = 0; break; // rrcurveto
          case 24: { // rcurveline
            let i = 0;
            for (; i + 5 < s.length - 2; i += 6) relCurve(s, i);
            if (i + 1 < s.length) lineTo(x + s[i], y + s[i + 1]);
            s.length = 0;
            break;
          }
          case 25: { // rlinecurve
            let i = 0;
            for (; i + 1 < s.length - 6; i += 2) lineTo(x + s[i], y + s[i + 1]);
            if (i + 5 < s.length) relCurve(s, i);
            s.length = 0;
            break;
          }
          case 26: case 27: { // vvcurveto, hhcurveto
            let i = 0, extra = 0;
            if (s.length % 2) extra = s[i++];
            for (; i + 3 < s.length; i += 4) {
              if (b0 === 26) {
                const c1x = x + extra, c1y = y + s[i], c2x = c1x + s[i + 1], c2y = c1y + s[i + 2];
                curveTo(c1x, c1y, c2x, c2y, c2x, c2y + s[i + 3]);
              } else {
                const c1x = x + s[i], c1y = y + extra, c2x = c1x + s[i + 1], c2y = c1y + s[i + 2];
                curveTo(c1x, c1y, c2x, c2y, c2x + s[i + 3], c2y);
              }
              extra = 0;
            }
            s.length = 0;
            break;
          }
          case 30: case 31: { // vhcurveto, hvcurveto: alternating start tangents
            let horizontal = b0 === 31;
            for (let i = 0; i + 3 < s.length; horizontal = !horizontal) {
              const last = s.length - i === 5 ? s[i + 4] : 0;
              if (horizontal) {
                const c1x = x + s[i], c1y = y, c2x = c1x + s[i + 1], c2y = c1y + s[i + 2];
                curveTo(c1x, c1y, c2x, c2y, c2x + last, c2y + s[i + 3]);
              } else {
                const c1x = x, c1y = y + s[i], c2x = c1x + s[i + 1], c2y = c1y + s[i + 2];
                curveTo(c1x, c1y, c2x, c2y, c2x + s[i + 3], c2y + last);
              }
              i += s.length - i === 5 ? 5 : 4;
            }
            s.length = 0;
            break;
          }
          case 10: case 29: { // callsubr, callgsubr
            const subrs = b0 === 10 ? locals : globals;
            const sub = subrs[s.pop() + bias(subrs)];
            if (sub && depth < 10) run(sub[0], sub[1], depth + 1);
            break;
          }
          case 11: return; // return
          case 14: done = true; return; // endchar (accented-character "seac" arguments are ignored)
          case 12: flex(buf[at++], s); s.length = 0; break;
          default: s.length = 0; break;
        }
      }
    };

    const flex = (op, s) => {
      const x0 = x, y0 = y;
      if (op === 35 && s.length >= 12) { relCurve(s, 0); relCurve(s, 6); } // flex
      else if (op === 34 && s.length >= 7) { // hflex
        const c1x = x + s[0], c2x = c1x + s[1], c2y = y + s[2];
        curveTo(c1x, y, c2x, c2y, c2x + s[3], c2y);
        const c3x = x + s[4], c4x = c3x + s[5];
        curveTo(c3x, c2y, c4x, y0, c4x + s[6], y0);
      } else if (op === 36 && s.length >= 9) { // hflex1
        const c1x = x + s[0], c1y = y + s[1], c2x = c1x + s[2], c2y = c1y + s[3];
        curveTo(c1x, c1y, c2x, c2y, c2x + s[4], c2y);
        const c3x = x + s[5], c4x = c3x + s[6], c4y = c2y + s[7];
        curveTo(c3x, c2y, c4x, c4y, c4x + s[8], y0);
      } else if (op === 37 && s.length >= 11) { // flex1
        const c1x = x + s[0], c1y = y + s[1], c2x = c1x + s[2], c2y = c1y + s[3];
        curveTo(c1x, c1y, c2x, c2y, c2x + s[4], c2y + s[5]);
        const c3x = x + s[6], c3y = y + s[7], c4x = c3x + s[8], c4y = c3y + s[9];
        if (Math.abs(c4x - x0) > Math.abs(c4y - y0)) curveTo(c3x, c3y, c4x, c4y, c4x + s[10], y0);
        else curveTo(c3x, c3y, c4x, c4y, x0, c4y + s[10]);
      }
    };

    run(range[0], range[1], 0);
    return path;
  }
}

function readFdSelect(buf, at, glyphCount) {
  const format = buf[at];
  if (format === 0) return (glyph) => (glyph < glyphCount ? buf[at + 1 + glyph] : 0);
  if (format !== 3) return () => 0;
  const ranges = buf.readUInt16BE(at + 1);
  return (glyph) => {
    let lo = 0, hi = ranges - 1, fd = 0;
    while (lo <= hi) { // last range whose first glyph is <= glyph
      const mid = (lo + hi) >> 1;
      if (buf.readUInt16BE(at + 3 + mid * 3) <= glyph) { fd = buf[at + 5 + mid * 3]; lo = mid + 1; }
      else hi = mid - 1;
    }
    return fd;
  };
}

module.exports = { CffOutlines, readIndex, readDict };
