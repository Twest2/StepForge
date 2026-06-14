'use strict';

const zlib = require('node:zlib');

/**
 * Minimal PDF 1.4 writer: pages, Helvetica/Helvetica-Bold/Courier text,
 * rects/lines, deflated content streams, RGB images as XObjects, and a
 * simple outline (bookmarks). Coordinates passed in are top-left based in
 * points; converted to PDF's bottom-left space internally.
 */

const FONTS = { F1: 'Helvetica', F2: 'Helvetica-Bold', F3: 'Courier', F4: 'Helvetica-Oblique', F5: 'Helvetica-BoldOblique' };
// Approximate average glyph width factors (per 1pt font size) for wrapping.
const FONT_WIDTH_FACTOR = { F1: 0.51, F2: 0.55, F3: 0.6, F4: 0.51, F5: 0.55 };

function esc(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// "Smart typography" characters commonly produced by rich-text editors and
// pasted content (e.g. from Word/Google Docs) that have a printable glyph in
// WinAnsiEncoding (cp1252) outside the Latin-1 range; map to that byte
// instead of falling back to "?".
const WINANSI_EXTRA = {
  0x20ac: 0x80, // €
  0x2026: 0x85, // … ellipsis
  0x2030: 0x89, // ‰
  0x2039: 0x8b, // ‹
  0x203a: 0x9b, // ›
  0x2018: 0x91, // ' left single quote
  0x2019: 0x92, // ' right single quote
  0x201c: 0x93, // " left double quote
  0x201d: 0x94, // " right double quote
  0x2022: 0x95, // • bullet
  0x2013: 0x96, // – en dash
  0x2014: 0x97, // — em dash
  0x2122: 0x99, // ™
};

function toLatin1(text) {
  let out = '';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code <= 0xff) out += ch;
    else if (WINANSI_EXTRA[code] !== undefined) out += String.fromCharCode(WINANSI_EXTRA[code]);
    else out += '?';
  }
  return out;
}

function col(c) {
  return `${(c[0] / 255).toFixed(3)} ${(c[1] / 255).toFixed(3)} ${(c[2] / 255).toFixed(3)}`;
}

class PdfBuilder {
  constructor({ pageWidth = 595.28, pageHeight = 841.89 } = {}) {
    this.pageWidth = pageWidth;
    this.pageHeight = pageHeight;
    this.pages = [];
    this.images = []; // { name, width, height, data (deflated RGB), smask? }
    this.imageCache = new Map();
    this.bookmarks = []; // { title, pageIndex, y }
  }

  addPage() {
    this.pages.push({ ops: [] });
    return this.pages.length - 1;
  }

  get currentPage() {
    if (!this.pages.length) this.addPage();
    return this.pages[this.pages.length - 1];
  }

  textWidth(text, size, font = 'F1') {
    return String(text).length * size * (FONT_WIDTH_FACTOR[font] || 0.51);
  }

  /** Greedy word wrap to maxWidth points. */
  wrapText(text, size, maxWidth, font = 'F1') {
    const lines = [];
    for (const para of String(text).split('\n')) {
      const words = para.split(/\s+/).filter(Boolean);
      if (!words.length) { lines.push(''); continue; }
      let line = '';
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (this.textWidth(candidate, size, font) <= maxWidth || !line) line = candidate;
        else { lines.push(line); line = word; }
      }
      lines.push(line);
    }
    return lines;
  }

  text(str, x, yTop, { size = 11, font = 'F1', color = [0, 0, 0] } = {}) {
    const y = this.pageHeight - yTop - size;
    // Tabs have no glyph in WinAnsiEncoding and render as "?"; expand to spaces.
    const clean = String(str).replace(/\t/g, '    ');
    this.currentPage.ops.push(
      `BT /${font} ${size} Tf ${col(color)} rg 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${esc(toLatin1(clean))}) Tj ET`
    );
  }

  rect(x, yTop, w, h, { fill = null, stroke = null, lineWidth = 1 } = {}) {
    const y = this.pageHeight - yTop - h;
    const ops = [];
    if (fill) ops.push(`${col(fill)} rg`);
    if (stroke) ops.push(`${col(stroke)} RG ${lineWidth} w`);
    ops.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re`);
    ops.push(fill && stroke ? 'B' : fill ? 'f' : 'S');
    this.currentPage.ops.push(ops.join(' '));
  }

  line(x0, y0t, x1, y1t, { color = [0, 0, 0], width = 1 } = {}) {
    const y0 = this.pageHeight - y0t, y1 = this.pageHeight - y1t;
    this.currentPage.ops.push(
      `${col(color)} RG ${width} w ${x0.toFixed(2)} ${y0.toFixed(2)} m ${x1.toFixed(2)} ${y1.toFixed(2)} l S`
    );
  }

  /** Draw an RGBA raster image; alpha is dropped (composited upstream). */
  image(img, x, yTop, w, h) {
    let name = this.imageCache.get(img);
    if (!name) {
      name = `Im${this.images.length + 1}`;
      const rgb = Buffer.alloc(img.width * img.height * 3);
      for (let i = 0, n = img.width * img.height; i < n; i++) {
        rgb[i * 3] = img.data[i * 4];
        rgb[i * 3 + 1] = img.data[i * 4 + 1];
        rgb[i * 3 + 2] = img.data[i * 4 + 2];
      }
      this.images.push({ name, width: img.width, height: img.height, data: zlib.deflateSync(rgb) });
      this.imageCache.set(img, name);
    }
    const y = this.pageHeight - yTop - h;
    this.currentPage.ops.push(
      `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${name} Do Q`
    );
    return name;
  }

  bookmark(title, pageIndex = this.pages.length - 1) {
    this.bookmarks.push({ title: toLatin1(title), pageIndex });
  }

  build() {
    if (!this.pages.length) this.addPage();
    const objects = []; // 1-based; objects[i] = body string|Buffer after header
    const addObj = (body) => { objects.push(body); return objects.length; };

    // Reserve ids: 1 catalog, 2 pages tree (filled later)
    addObj(null); // 1: catalog placeholder
    addObj(null); // 2: pages placeholder

    const fontIds = {};
    for (const [res, base] of Object.entries(FONTS)) {
      fontIds[res] = addObj(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`);
    }
    const imageIds = {};
    for (const img of this.images) {
      imageIds[img.name] = addObj({
        dict: `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.data.length} >>`,
        stream: img.data,
      });
    }

    const fontRes = Object.entries(fontIds).map(([r, id]) => `/${r} ${id} 0 R`).join(' ');
    const imgRes = this.images.map((img) => `/${img.name} ${imageIds[img.name]} 0 R`).join(' ');
    const resources = `<< /Font << ${fontRes} >> ${this.images.length ? `/XObject << ${imgRes} >>` : ''} >>`;

    const pageIds = [];
    for (const page of this.pages) {
      const content = zlib.deflateSync(Buffer.from(page.ops.join('\n'), 'latin1'));
      const contentId = addObj({
        dict: `<< /Filter /FlateDecode /Length ${content.length} >>`,
        stream: content,
      });
      pageIds.push(addObj(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.pageWidth} ${this.pageHeight}] ` +
        `/Resources ${resources} /Contents ${contentId} 0 R >>`
      ));
    }

    let outlinesRef = '';
    if (this.bookmarks.length) {
      const outlineRootId = objects.length + 1;
      const itemIds = this.bookmarks.map((_, i) => outlineRootId + 1 + i);
      addObj(`<< /Type /Outlines /First ${itemIds[0]} 0 R /Last ${itemIds[itemIds.length - 1]} 0 R /Count ${itemIds.length} >>`);
      this.bookmarks.forEach((bm, i) => {
        const parts = [
          `/Title (${esc(bm.title)})`,
          `/Parent ${outlineRootId} 0 R`,
          `/Dest [${pageIds[bm.pageIndex]} 0 R /Fit]`,
        ];
        if (i > 0) parts.push(`/Prev ${itemIds[i - 1]} 0 R`);
        if (i < itemIds.length - 1) parts.push(`/Next ${itemIds[i + 1]} 0 R`);
        addObj(`<< ${parts.join(' ')} >>`);
      });
      outlinesRef = `/Outlines ${outlineRootId} 0 R /PageMode /UseOutlines`;
    }

    objects[0] = `<< /Type /Catalog /Pages 2 0 R ${outlinesRef} >>`;
    objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

    // Serialize with xref
    const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets = [0];
    objects.forEach((body, idx) => {
      offsets.push(offset);
      let objBuf;
      if (body && typeof body === 'object' && body.stream) {
        objBuf = Buffer.concat([
          Buffer.from(`${idx + 1} 0 obj\n${body.dict}\nstream\n`, 'latin1'),
          body.stream,
          Buffer.from('\nendstream\nendobj\n', 'latin1'),
        ]);
      } else {
        objBuf = Buffer.from(`${idx + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
      }
      chunks.push(objBuf);
      offset += objBuf.length;
    });

    const xrefStart = offset;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i++) {
      xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(chunks);
  }
}

module.exports = { PdfBuilder, FONTS };
