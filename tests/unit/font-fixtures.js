'use strict';

// A tiny TrueType (or CFF) font, built here so the tests need no installed fonts.

function table(size, write) {
  const buf = Buffer.alloc(size);
  write(buf);
  return buf;
}

/** A square glyph `width` units wide: one contour of four on-curve points. */
function boxGlyph(width) {
  return table(36, (b) => {
    b.writeInt16BE(1, 0); b.writeInt16BE(0, 2); b.writeInt16BE(0, 4); b.writeInt16BE(width, 6); b.writeInt16BE(700, 8);
    b.writeUInt16BE(3, 10); // last point of the contour
    b.writeUInt16BE(0, 12); // no instructions
    b.fill(1, 14, 18); // on-curve, 16-bit coordinate deltas
    [0, width, 0, -width].forEach((dx, i) => b.writeInt16BE(dx, 18 + i * 2));
    [0, 0, 700, 0].forEach((dy, i) => b.writeInt16BE(dy, 26 + i * 2));
  });
}

/** A composite glyph drawn from `part` (so subsetting must keep `part`). */
function compositeGlyph(part) {
  return table(20, (b) => {
    b.writeInt16BE(-1, 0); b.writeInt16BE(0, 2); b.writeInt16BE(0, 4); b.writeInt16BE(500, 6); b.writeInt16BE(700, 8);
    b.writeUInt16BE(0x0003, 10); // ARG_1_AND_2_ARE_WORDS | ARGS_ARE_XY_VALUES, last component
    b.writeUInt16BE(part, 12);
    b.writeInt16BE(0, 14); b.writeInt16BE(0, 16);
  });
}

function cmapFormat4(map) {
  const cps = [...map.keys()].filter((cp) => cp <= 0xffff).sort((a, b) => a - b);
  const segs = cps.length + 1;
  return table(16 + segs * 8, (b) => {
    b.writeUInt16BE(4, 0); b.writeUInt16BE(16 + segs * 8, 2); b.writeUInt16BE(segs * 2, 6);
    const ends = 14, starts = ends + segs * 2 + 2, deltas = starts + segs * 2; // idRangeOffsets stay 0
    cps.forEach((cp, i) => {
      b.writeUInt16BE(cp, ends + i * 2); b.writeUInt16BE(cp, starts + i * 2);
      b.writeInt16BE(((map.get(cp) - cp) << 16) >> 16, deltas + i * 2);
    });
    b.writeUInt16BE(0xffff, ends + cps.length * 2); b.writeUInt16BE(0xffff, starts + cps.length * 2);
    b.writeInt16BE(1, deltas + cps.length * 2);
  });
}

function cmapFormat12(map) {
  const cps = [...map.keys()].sort((a, b) => a - b);
  return table(16 + cps.length * 12, (b) => {
    b.writeUInt16BE(12, 0); b.writeUInt32BE(16 + cps.length * 12, 4); b.writeUInt32BE(cps.length, 12);
    cps.forEach((cp, i) => { b.writeUInt32BE(cp, 16 + i * 12); b.writeUInt32BE(cp, 20 + i * 12); b.writeUInt32BE(map.get(cp), 24 + i * 12); });
  });
}

/**
 * A TrueType font with a box glyph for each character in `chars` (glyph ids
 * from 1), the given advance widths, and an optional composite glyph.
 * `glyphs` replaces individual glyph records by id; `cff` (a 'CFF ' table)
 * makes it an OpenType CFF font instead, with no glyf/loca tables.
 */
function makeFont({ chars, width = 1000, unitsPerEm = 1000, name = 'TestSans', format12 = true, composite = false, glyphs: custom = {}, cff = null }) {
  const map = new Map([...chars].map((ch, i) => [ch.codePointAt(0), i + 1]));
  const glyphs = [boxGlyph(500), ...[...chars].map(() => boxGlyph(width))];
  if (composite) glyphs.push(compositeGlyph(1));
  for (const [id, record] of Object.entries(custom)) glyphs[Number(id)] = record;
  const loca = Buffer.alloc((glyphs.length + 1) * 4);
  let at = 0;
  glyphs.forEach((g, i) => { loca.writeUInt32BE(at, i * 4); at += g.length; });
  loca.writeUInt32BE(at, glyphs.length * 4);
  const sub4 = cmapFormat4(map);
  const sub12 = format12 ? cmapFormat12(map) : null;
  const cmap = Buffer.concat([table(4 + (sub12 ? 16 : 8), (b) => {
    b.writeUInt16BE(sub12 ? 2 : 1, 2);
    b.writeUInt16BE(3, 4); b.writeUInt16BE(1, 6); b.writeUInt32BE(4 + (sub12 ? 16 : 8), 8);
    if (sub12) { b.writeUInt16BE(3, 12); b.writeUInt16BE(10, 14); b.writeUInt32BE(4 + 16 + sub4.length, 16); }
  }), sub4, ...(sub12 ? [sub12] : [])]);
  const nameUtf16 = Buffer.from(name, 'utf16le').swap16();
  const tables = {
    cmap,
    glyf: Buffer.concat(glyphs),
    head: table(54, (b) => { b.writeUInt32BE(0x00010000, 0); b.writeUInt16BE(unitsPerEm, 18); b.writeInt16BE(700, 42); b.writeInt16BE(1000, 40); b.writeInt16BE(1, 50); }),
    hhea: table(36, (b) => { b.writeInt16BE(800, 4); b.writeInt16BE(-200, 6); b.writeUInt16BE(glyphs.length, 34); }),
    hmtx: Buffer.concat(glyphs.map((_, i) => table(4, (b) => b.writeUInt16BE(i ? width : 500, 0)))),
    loca,
    maxp: table(6, (b) => { b.writeUInt32BE(0x00005000, 0); b.writeUInt16BE(glyphs.length, 4); }),
    ...(cff ? { 'CFF ': cff } : {}),
    name: Buffer.concat([table(18, (b) => {
      b.writeUInt16BE(1, 2); b.writeUInt16BE(18, 4);
      b.writeUInt16BE(3, 6); b.writeUInt16BE(1, 8); b.writeUInt16BE(0x409, 10); b.writeUInt16BE(6, 12); b.writeUInt16BE(nameUtf16.length, 14);
    }), nameUtf16]),
  };
  if (cff) { delete tables.glyf; delete tables.loca; }
  const tags = Object.keys(tables).sort();
  const header = Buffer.alloc(12 + tags.length * 16);
  header.writeUInt32BE(cff ? 0x4f54544f : 0x00010000, 0);
  header.writeUInt16BE(tags.length, 4);
  let offset = header.length;
  const bodies = [];
  tags.forEach((tag, i) => {
    const body = tables[tag];
    header.write(tag, 12 + i * 16, 'latin1');
    header.writeUInt32BE(offset, 12 + i * 16 + 8);
    header.writeUInt32BE(body.length, 12 + i * 16 + 12);
    const padded = (body.length + 3) & ~3;
    bodies.push(body, Buffer.alloc(padded - body.length));
    offset += padded;
  });
  return Buffer.concat([header, ...bodies]);
}

/** Two fonts in one .ttc file. */
function makeCollection(first, second) {
  const head = Buffer.alloc(20);
  head.write('ttcf', 0, 'latin1');
  head.writeUInt32BE(0x00010000, 4);
  head.writeUInt32BE(2, 8);
  head.writeUInt32BE(20, 12);
  head.writeUInt32BE(20 + first.length, 16);
  // Table offsets in a collection count from the start of the file.
  const shift = (font, by) => {
    const copy = Buffer.from(font);
    for (let i = 0; i < copy.readUInt16BE(4); i++) copy.writeUInt32BE(copy.readUInt32BE(12 + i * 16 + 8) + by, 12 + i * 16 + 8);
    return copy;
  };
  return Buffer.concat([head, shift(first, 20), shift(second, 20 + first.length)]);
}

module.exports = { table, boxGlyph, compositeGlyph, makeFont, makeCollection };
