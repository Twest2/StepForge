'use strict';

/**
 * Just enough TrueType to embed system fonts in PDFs: read a .ttf or one face
 * of a .ttc, map characters to glyphs, report advance widths and metrics, and
 * write a subset holding only the glyphs a document uses. Glyph ids are kept
 * (unused glyphs become empty), so a PDF can address glyphs by their original
 * id through CIDToGIDMap /Identity. Only glyf-outline fonts are supported;
 * CFF ("OTTO") fonts are rejected.
 */

const TTC_TAG = 0x74746366; // 'ttcf'
const TRUETYPE_VERSIONS = new Set([0x00010000, 0x74727565]); // 1.0, 'true'
// Tables a PDF viewer needs to draw TrueType glyphs (PDF 32000-1, 9.9).
const SUBSET_TABLES = ['cvt ', 'fpgm', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'prep'];

const tagAt = (buf, at) => buf.toString('latin1', at, at + 4);

function tableDirectory(buf, at) {
  const version = buf.readUInt32BE(at);
  if (version === 0x4f54544f) throw new Error('CFF (OpenType) outlines are not supported');
  if (!TRUETYPE_VERSIONS.has(version)) throw new Error('not a TrueType font');
  const tables = {};
  const count = buf.readUInt16BE(at + 4);
  for (let i = 0; i < count; i++) {
    const rec = at + 12 + i * 16;
    const offset = buf.readUInt32BE(rec + 8);
    const length = buf.readUInt32BE(rec + 12);
    if (offset + length > buf.length) throw new Error('font table runs past the end of the file');
    tables[tagAt(buf, rec)] = { offset, length };
  }
  for (const tag of ['glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp']) {
    if (!tables[tag]) throw new Error(`font has no ${tag} table`);
  }
  return tables;
}

/** A character -> glyph lookup from the best Unicode cmap subtable. */
function readCmap(buf, cmap) {
  const count = buf.readUInt16BE(cmap.offset + 2);
  let best = null;
  let bestRank = 0;
  for (let i = 0; i < count; i++) {
    const rec = cmap.offset + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const at = cmap.offset + buf.readUInt32BE(rec + 4);
    const format = buf.readUInt16BE(at);
    // Prefer full-Unicode format 12, then the BMP format 4.
    const unicode = (platform === 3 && (encoding === 1 || encoding === 10)) || platform === 0;
    const rank = !unicode ? 0 : format === 12 ? 2 : format === 4 ? 1 : 0;
    if (rank > bestRank) { best = { at, format }; bestRank = rank; }
  }
  if (!best) throw new Error('font has no Unicode character map');
  const { at, format } = best;
  if (format === 12) {
    const groups = buf.readUInt32BE(at + 12);
    return (cp) => {
      let lo = 0, hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = at + 16 + mid * 12;
        if (cp < buf.readUInt32BE(g)) hi = mid - 1;
        else if (cp > buf.readUInt32BE(g + 4)) lo = mid + 1;
        else return buf.readUInt32BE(g + 8) + cp - buf.readUInt32BE(g);
      }
      return 0;
    };
  }
  const segs = buf.readUInt16BE(at + 6) / 2;
  const ends = at + 14;
  const starts = ends + segs * 2 + 2;
  const deltas = starts + segs * 2;
  const ranges = deltas + segs * 2;
  return (cp) => {
    if (cp > 0xffff) return 0;
    let lo = 0, hi = segs - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp > buf.readUInt16BE(ends + mid * 2)) lo = mid + 1;
      else hi = mid - 1;
    }
    if (lo >= segs || cp < buf.readUInt16BE(starts + lo * 2)) return 0;
    const delta = buf.readInt16BE(deltas + lo * 2);
    const rangeAt = ranges + lo * 2;
    const range = buf.readUInt16BE(rangeAt);
    if (!range) return (cp + delta) & 0xffff;
    const glyphAt = rangeAt + range + (cp - buf.readUInt16BE(starts + lo * 2)) * 2;
    const glyph = buf.readUInt16BE(glyphAt);
    return glyph ? (glyph + delta) & 0xffff : 0;
  };
}

/** The PostScript name (name id 6), or '' when the font has none. */
function readPostScriptName(buf, name) {
  if (!name) return '';
  const count = buf.readUInt16BE(name.offset + 2);
  const strings = name.offset + buf.readUInt16BE(name.offset + 4);
  for (let i = 0; i < count; i++) {
    const rec = name.offset + 6 + i * 12;
    if (buf.readUInt16BE(rec + 6) !== 6) continue;
    const platform = buf.readUInt16BE(rec);
    const at = strings + buf.readUInt16BE(rec + 10);
    const raw = buf.subarray(at, at + buf.readUInt16BE(rec + 8));
    const text = platform === 3 || platform === 0 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1');
    if (text) return text;
  }
  return '';
}

class TrueTypeFont {
  /** @param {Buffer} buf a .ttf, or a .ttc with `index` choosing the face. */
  constructor(buf, index = 0) {
    let at = 0;
    if (buf.readUInt32BE(0) === TTC_TAG) {
      const faces = buf.readUInt32BE(8);
      if (index >= faces) throw new Error(`font collection has ${faces} faces, not ${index + 1}`);
      at = buf.readUInt32BE(12 + index * 4);
    }
    this.buf = buf;
    this.tables = tableDirectory(buf, at);
    const head = this.tables.head.offset;
    this.unitsPerEm = buf.readUInt16BE(head + 18);
    this.bbox = [0, 2, 4, 6].map((d) => buf.readInt16BE(head + 36 + d));
    this.longLoca = buf.readInt16BE(head + 50) === 1;
    const hhea = this.tables.hhea.offset;
    this.ascent = buf.readInt16BE(hhea + 4);
    this.descent = buf.readInt16BE(hhea + 6);
    this.metricCount = buf.readUInt16BE(hhea + 34);
    this.glyphCount = buf.readUInt16BE(this.tables.maxp.offset + 4);
    const os2 = this.tables['OS/2'];
    this.capHeight = os2 && os2.length >= 90 && buf.readUInt16BE(os2.offset) >= 2
      ? buf.readInt16BE(os2.offset + 88) : Math.round(this.ascent * 0.7);
    this.postScriptName = readPostScriptName(buf, this.tables.name);
    // A subset has no cmap: PDFs address its glyphs by id.
    this.lookup = this.tables.cmap ? readCmap(buf, this.tables.cmap) : () => 0;
  }

  /** Glyph id for a code point, or 0 (.notdef) when the font has none. */
  glyphFor(codePoint) {
    const glyph = this.lookup(codePoint);
    return glyph < this.glyphCount ? glyph : 0;
  }

  /** Advance width of a glyph, in font units. */
  advance(glyph) {
    const hmtx = this.tables.hmtx.offset;
    const i = Math.min(glyph, this.metricCount - 1);
    return this.buf.readUInt16BE(hmtx + i * 4);
  }

  glyphRange(glyph) {
    const loca = this.tables.loca.offset;
    const start = this.longLoca ? this.buf.readUInt32BE(loca + glyph * 4) : this.buf.readUInt16BE(loca + glyph * 2) * 2;
    const end = this.longLoca ? this.buf.readUInt32BE(loca + glyph * 4 + 4) : this.buf.readUInt16BE(loca + glyph * 2 + 2) * 2;
    const glyf = this.tables.glyf.offset;
    return [glyf + start, glyf + Math.max(start, end)];
  }

  /** Glyphs a composite glyph is built from (they must be embedded too). */
  components(glyph) {
    const [start, end] = this.glyphRange(glyph);
    if (end - start < 10 || this.buf.readInt16BE(start) >= 0) return [];
    const parts = [];
    let at = start + 10;
    for (;;) {
      const flags = this.buf.readUInt16BE(at);
      parts.push(this.buf.readUInt16BE(at + 2));
      at += 4 + (flags & 0x1 ? 4 : 2);
      if (flags & 0x8) at += 2;
      else if (flags & 0x40) at += 4;
      else if (flags & 0x80) at += 8;
      if (!(flags & 0x20)) return parts;
    }
  }

  /**
   * A standalone TrueType font holding .notdef plus `glyphs` (and anything
   * they reference); every other glyph id stays valid but empty.
   */
  subset(glyphs) {
    const keep = new Set([0]);
    const queue = [...glyphs];
    while (queue.length) {
      const glyph = queue.pop();
      if (keep.has(glyph) || glyph >= this.glyphCount) continue;
      keep.add(glyph);
      queue.push(...this.components(glyph));
    }
    const loca = Buffer.alloc((this.glyphCount + 1) * 4);
    const pieces = [];
    let size = 0;
    for (let glyph = 0; glyph < this.glyphCount; glyph++) {
      loca.writeUInt32BE(size, glyph * 4);
      if (!keep.has(glyph)) continue;
      const [start, end] = this.glyphRange(glyph);
      const padded = (end - start + 3) & ~3;
      const piece = Buffer.alloc(padded);
      this.buf.copy(piece, 0, start, end);
      pieces.push(piece);
      size += padded;
    }
    loca.writeUInt32BE(size, this.glyphCount * 4);
    const copy = (tag) => Buffer.from(this.buf.subarray(this.tables[tag].offset, this.tables[tag].offset + this.tables[tag].length));
    const head = copy('head');
    head.writeUInt32BE(0, 8); // checkSumAdjustment, set below
    head.writeInt16BE(1, 50); // long loca offsets
    const data = { head, loca, glyf: Buffer.concat(pieces), hhea: copy('hhea'), hmtx: copy('hmtx'), maxp: copy('maxp') };
    for (const tag of ['cvt ', 'fpgm', 'prep']) if (this.tables[tag]) data[tag] = copy(tag);
    return writeFont(data);
  }
}

function checksum(buf) {
  let sum = 0;
  const padded = buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4))]) : buf;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

function writeFont(data) {
  const tags = SUBSET_TABLES.filter((tag) => data[tag]);
  const pow = 2 ** Math.floor(Math.log2(tags.length));
  const header = Buffer.alloc(12 + tags.length * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(tags.length, 4);
  header.writeUInt16BE(pow * 16, 6);
  header.writeUInt16BE(Math.log2(pow), 8);
  header.writeUInt16BE(tags.length * 16 - pow * 16, 10);
  let offset = header.length;
  const bodies = [];
  tags.forEach((tag, i) => {
    const body = data[tag];
    const rec = 12 + i * 16;
    header.write(tag, rec, 'latin1');
    header.writeUInt32BE(checksum(body), rec + 4);
    header.writeUInt32BE(offset, rec + 8);
    header.writeUInt32BE(body.length, rec + 12);
    const padded = (body.length + 3) & ~3;
    bodies.push(body, Buffer.alloc(padded - body.length));
    offset += padded;
  });
  const font = Buffer.concat([header, ...bodies]);
  const headAt = header.readUInt32BE(12 + tags.indexOf('head') * 16 + 8);
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headAt + 8);
  return font;
}

module.exports = { TrueTypeFont };
