'use strict';

const zlib = require('node:zlib');
const crypto = require('node:crypto');

/**
 * Minimal PDF 1.4 writer: pages, Helvetica, Times and Courier text (regular,
 * bold, italic), rects/lines, deflated content streams, RGB images (with an
 * alpha soft mask when they have transparency) as XObjects, and a simple
 * outline (bookmarks). Coordinates passed in are top-left based in points;
 * converted to PDF's bottom-left space internally.
 *
 * The built-in fonts only cover WinAnsiEncoding (Western European). With
 * `fallbackFonts` (core/pdf-fonts.js), every other character is drawn from an
 * installed TrueType font, embedded as a subset with a ToUnicode map so the
 * text stays selectable and searchable; without one, such characters are "?".
 */

const FONTS = {
  F1: 'Helvetica', F2: 'Helvetica-Bold', F3: 'Courier', F4: 'Helvetica-Oblique', F5: 'Helvetica-BoldOblique',
  // Code-block styles: syntax themes set comments in italic and some tokens in bold.
  F6: 'Courier-Bold', F7: 'Courier-Oblique', F8: 'Courier-BoldOblique',
  // For brand profiles whose fonts are serif.
  F9: 'Times-Roman', F10: 'Times-Bold', F11: 'Times-Italic', F12: 'Times-BoldItalic',
};
// Approximate average glyph width factors (per 1pt font size) for wrapping.
// Courier is monospaced: every glyph is exactly 0.6em in every style.
const FONT_WIDTH_FACTOR = {
  F1: 0.51, F2: 0.55, F3: 0.6, F4: 0.51, F5: 0.55, F6: 0.6, F7: 0.6, F8: 0.6,
  F9: 0.46, F10: 0.5, F11: 0.45, F12: 0.49,
};

/** Font resources per family and style, for text that follows a brand font. */
const FONT_FAMILIES = {
  sans: { regular: 'F1', bold: 'F2', italic: 'F4', boldItalic: 'F5' },
  serif: { regular: 'F9', bold: 'F10', italic: 'F11', boldItalic: 'F12' },
  mono: { regular: 'F3', bold: 'F6', italic: 'F7', boldItalic: 'F8' },
};

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

// Characters the built-in fonts can't show: they need an installed font.
const OUTSIDE_WINANSI = new RegExp(`[^\\x00-\\xff${Object.keys(WINANSI_EXTRA).map((c) => `\\u${Number(c).toString(16)}`).join('')}]`, 'u');
const encodable = (code) => code <= 0xff || WINANSI_EXTRA[code] !== undefined;
const BOLD_FONTS = new Set(['F2', 'F5', 'F6', 'F8', 'F10', 'F12']);

// Line breaks for Chinese, Japanese and Korean (core/text-wrap.js, shared with annotations).
const { breakChunks, isWide } = require('./text-wrap');

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

/**
 * A PDF text string (document metadata, bookmark titles). Printable ASCII goes out as a
 * plain literal; anything else becomes UTF-16BE hex with a byte-order mark,
 * which every viewer decodes and which has no Latin-1 / PDFDocEncoding gaps.
 */
function pdfTextString(text) {
  const clean = String(text)
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^[\x20-\x7E]*$/.test(clean)) return `(${esc(clean)})`;
  const be = Buffer.from(clean, 'utf16le').swap16();
  return `<FEFF${be.toString('hex').toUpperCase()}>`;
}

function col(c) {
  return `${(c[0] / 255).toFixed(3)} ${(c[1] / 255).toFixed(3)} ${(c[2] / 255).toFixed(3)}`;
}

/** A 6-letter subset tag (PDF 32000-1, 9.6.4) that differs per subset. */
function subsetTag(name, glyphs) {
  const hash = crypto.createHash('sha1').update(`${name}:${glyphs.join(',')}`).digest();
  return [...hash.subarray(0, 6)].map((b) => String.fromCharCode(65 + (b % 26))).join('');
}

/** A ToUnicode CMap: glyph id -> the text it shows, for copy and search. */
function toUnicodeCMap(glyphs) {
  const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');
  const utf16 = (text) => Buffer.from(text, 'utf16le').swap16().toString('hex').toUpperCase();
  const entries = [...glyphs].sort((a, b) => a[0] - b[0]).map(([glyph, text]) => `<${hex4(glyph)}> <${utf16(text)}>`);
  const blocks = [];
  for (let i = 0; i < entries.length; i += 100) {
    const block = entries.slice(i, i + 100);
    blocks.push(`${block.length} beginbfchar\n${block.join('\n')}\nendbfchar`);
  }
  return [
    '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
    '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange',
    ...blocks,
    'endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end',
  ].join('\n');
}

class PdfBuilder {
  constructor({ pageWidth = 595.28, pageHeight = 841.89, title = '', author = '', fallbackFonts = null } = {}) {
    this.fallbackFonts = fallbackFonts; // see core/pdf-fonts.js
    this.embedded = new Map(); // TrueTypeFont -> { res: 'U1', glyphs: Map<glyph id, text> }
    this.pageWidth = pageWidth;
    this.pageHeight = pageHeight;
    this.title = title; // document metadata for the /Info dictionary
    this.author = author;
    this.pages = [];
    this.images = []; // { name, width, height, data (deflated RGB), smask? }
    this.imageCache = new Map();
    this.bookmarks = []; // { title, pageIndex, y }
    this.links = []; // { pageIndex, x, yTop, w, h, target }
    this.targetPage = null; // set by onPage()
  }

  addPage() {
    this.pages.push({ ops: [] });
    return this.pages.length - 1;
  }

  get currentPage() {
    if (!this.pages.length) this.addPage();
    return this.pages[this.targetPage ?? this.pages.length - 1];
  }

  /** Draw on an earlier page (headers and footers once every page exists). */
  onPage(index, draw) {
    this.targetPage = index;
    try { draw(); } finally { this.targetPage = null; }
  }

  /** True when `text` has characters only an installed font can draw. */
  needsFallback(text) {
    return Boolean(this.fallbackFonts) && OUTSIDE_WINANSI.test(text);
  }

  /**
   * Split text into runs drawn by one font: `font: null` for the built-in
   * font, or an installed font with the glyph id of each character.
   */
  segments(text, font) {
    const runs = [];
    for (const ch of String(text)) {
      const code = ch.codePointAt(0);
      const hit = encodable(code) ? null : this.fallbackFonts.fontFor(code, BOLD_FONTS.has(font));
      const last = runs[runs.length - 1];
      const run = last && last.font === (hit ? hit.font : null) ? last : null;
      if (run) { run.text += ch; if (hit) run.glyphs.push(hit.glyph); } else {
        runs.push({ font: hit ? hit.font : null, text: ch, glyphs: hit ? [hit.glyph] : [] });
      }
    }
    return runs;
  }

  textWidth(text, size, font = 'F1') {
    if (!this.needsFallback(text)) return String(text).length * size * (FONT_WIDTH_FACTOR[font] || 0.51);
    let width = 0;
    for (const run of this.segments(text, font)) {
      if (!run.font) width += [...run.text].length * size * (FONT_WIDTH_FACTOR[font] || 0.51);
      else for (const glyph of run.glyphs) width += (run.font.advance(glyph) / run.font.unitsPerEm) * size;
    }
    return width;
  }

  /**
   * PDF text-showing operators for `text`, switching to an installed font
   * where the built-in one has no glyph. `state.font` tracks the current
   * resource so a run only sets the font when it changes.
   */
  showText(text, font, size, state) {
    const ops = [];
    const runs = this.needsFallback(text) ? this.segments(text, font) : [{ font: null, text }];
    for (const run of runs) {
      let res = font;
      let shown;
      if (run.font) {
        if (!this.embedded.has(run.font)) this.embedded.set(run.font, { res: `U${this.embedded.size + 1}`, glyphs: new Map() });
        const entry = this.embedded.get(run.font);
        res = entry.res;
        const chars = [...run.text];
        run.glyphs.forEach((glyph, i) => { if (!entry.glyphs.has(glyph)) entry.glyphs.set(glyph, chars[i]); });
        shown = `<${run.glyphs.map((g) => g.toString(16).toUpperCase().padStart(4, '0')).join('')}>`;
      } else {
        shown = `(${esc(toLatin1(run.text))})`;
      }
      if (state.font !== res) { ops.push(`/${res} ${size} Tf`); state.font = res; }
      ops.push(`${shown} Tj`);
    }
    return ops.join(' ');
  }

  /**
   * Greedy word wrap to maxWidth points. Lines break at spaces, and between
   * Chinese, Japanese or Korean characters.
   */
  wrapText(text, size, maxWidth, font = 'F1') {
    const lines = [];
    for (const para of String(text).split('\n')) {
      const words = para.split(/\s+/).filter(Boolean);
      if (!words.length) { lines.push(''); continue; }
      let line = '';
      for (const word of words) {
        breakChunks(word).forEach((chunk, i) => {
          const candidate = line ? `${line}${i ? '' : ' '}${chunk}` : chunk;
          if (this.textWidth(candidate, size, font) <= maxWidth || !line) line = candidate;
          else { lines.push(line); line = chunk; }
        });
      }
      lines.push(line);
    }
    return lines;
  }

  text(str, x, yTop, { size = 11, font = 'F1', color = [0, 0, 0] } = {}) {
    const y = this.pageHeight - yTop - size;
    // Tabs have no glyph in WinAnsiEncoding and render as "?"; expand to spaces.
    const clean = String(str).replace(/\t/g, '    ');
    if (!this.needsFallback(clean)) {
      this.currentPage.ops.push(
        `BT /${font} ${size} Tf ${col(color)} rg 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${esc(toLatin1(clean))}) Tj ET`
      );
      return;
    }
    this.currentPage.ops.push(
      `BT ${col(color)} rg 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ${this.showText(clean, font, size, { font: null })} ET`
    );
  }

  /**
   * Render a line made of mixed-font/color segments (e.g. bold/italic runs)
   * as one continuous text object: consecutive Tj operators without an
   * intervening Tm advance the cursor by each font's real glyph widths, so
   * spacing matches the viewer's metrics exactly (unlike our approximate
   * textWidth(), which is only used for word-wrap decisions).
   */
  textRun(parts, x, yTop, size) {
    const y = this.pageHeight - yTop - size;
    const ops = [`BT 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`];
    const state = { font: null };
    let curColor = null;
    for (const part of parts) {
      if (!part.text) continue;
      const clean = String(part.text).replace(/\t/g, '    ');
      const plain = !this.needsFallback(clean);
      if (plain && part.font !== state.font) {
        ops.push(`/${part.font} ${size} Tf`);
        state.font = part.font;
      }
      if (!curColor || part.color[0] !== curColor[0] || part.color[1] !== curColor[1] || part.color[2] !== curColor[2]) {
        ops.push(`${col(part.color)} rg`);
        curColor = part.color;
      }
      ops.push(plain ? `(${esc(toLatin1(clean))}) Tj` : this.showText(clean, part.font, size, state));
    }
    ops.push('ET');
    this.currentPage.ops.push(ops.join(' '));
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

  /**
   * Draw an RGBA raster image. Screenshots are opaque; an image with
   * transparency (a logo) keeps it through a soft mask.
   */
  image(img, x, yTop, w, h) {
    let name = this.imageCache.get(img);
    if (!name) {
      name = `Im${this.images.length + 1}`;
      const n = img.width * img.height;
      const rgb = Buffer.alloc(n * 3);
      let alpha = null;
      for (let i = 0; i < n; i++) {
        rgb[i * 3] = img.data[i * 4];
        rgb[i * 3 + 1] = img.data[i * 4 + 1];
        rgb[i * 3 + 2] = img.data[i * 4 + 2];
        if (img.data[i * 4 + 3] !== 255 && !alpha) alpha = Buffer.alloc(n, 255);
        if (alpha) alpha[i] = img.data[i * 4 + 3];
      }
      this.images.push({ name, width: img.width, height: img.height, data: zlib.deflateSync(rgb), smask: alpha ? zlib.deflateSync(alpha) : null });
      this.imageCache.set(img, name);
    }
    const y = this.pageHeight - yTop - h;
    this.currentPage.ops.push(
      `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${name} Do Q`
    );
    return name;
  }

  bookmark(title, pageIndex = this.pages.length - 1) {
    this.bookmarks.push({ title: String(title), pageIndex }); // a text string, encoded when written
  }

  /**
   * Add a clickable region that jumps to another page (e.g. a Contents
   * entry linking to a step). `target` is either a page index, or an
   * object whose `pageIndex` is filled in later — once the destination
   * page is known — and read when `build()` runs.
   */
  linkRect(x, yTop, w, h, target, pageIndex = this.pages.length - 1) {
    this.links.push({ pageIndex, x, yTop, w, h, target });
  }

  /** Write an installed font's subset as a Type0 font; returns its object id. */
  embedFont(font, entry, addObj) {
    const glyphs = [...entry.glyphs.keys()].sort((a, b) => a - b);
    const program = font.subset(glyphs);
    const data = zlib.deflateSync(program);
    const scale = (v) => Math.round((v * 1000) / font.unitsPerEm);
    const name = `${subsetTag(font.postScriptName, glyphs)}+${(font.postScriptName || 'Font').replace(/[^A-Za-z0-9-]/g, '') || 'Font'}`;
    const fileId = addObj({ dict: `<< /Length ${data.length} /Length1 ${program.length} /Filter /FlateDecode >>`, stream: data });
    const descriptorId = addObj(
      `<< /Type /FontDescriptor /FontName /${name} /Flags 4 /FontBBox [${font.bbox.map(scale).join(' ')}] /ItalicAngle 0 ` +
      `/Ascent ${scale(font.ascent)} /Descent ${scale(font.descent)} /CapHeight ${scale(font.capHeight)} /StemV 80 /FontFile2 ${fileId} 0 R >>`
    );
    const widths = glyphs.map((g) => `${g} [${scale(font.advance(g))}]`).join(' ');
    const cidId = addObj(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
      `/FontDescriptor ${descriptorId} 0 R /DW ${scale(font.advance(0))} /W [${widths}] /CIDToGIDMap /Identity >>`
    );
    const cmap = zlib.deflateSync(Buffer.from(toUnicodeCMap(entry.glyphs), 'latin1'));
    const cmapId = addObj({ dict: `<< /Filter /FlateDecode /Length ${cmap.length} >>`, stream: cmap });
    return addObj(
      `<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${cidId} 0 R] /ToUnicode ${cmapId} 0 R >>`
    );
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
    for (const [font, entry] of this.embedded) fontIds[entry.res] = this.embedFont(font, entry, addObj);
    const imageIds = {};
    for (const img of this.images) {
      const smaskId = img.smask ? addObj({
        dict: `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
          `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.smask.length} >>`,
        stream: img.smask,
      }) : 0;
      imageIds[img.name] = addObj({
        dict: `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smaskId ? ` /SMask ${smaskId} 0 R` : ''} /Length ${img.data.length} >>`,
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

    // Link annotations (e.g. clickable Contents entries that jump to a
    // step's page). Targets resolved late, after every step has claimed a
    // page, so `target` may be an object whose `pageIndex` was only just set.
    const pageAnnots = new Map(); // page index -> [annotation object id, ...]
    for (const link of this.links) {
      const targetIndex = typeof link.target === 'number' ? link.target : link.target?.pageIndex;
      if (targetIndex == null || !pageIds[targetIndex]) continue;
      const y1 = this.pageHeight - link.yTop - link.h;
      const y2 = this.pageHeight - link.yTop;
      // A target with a `yTop` opens at that spot of its page (a step's heading), else the whole page.
      const top = typeof link.target === 'object' && Number.isFinite(link.target.yTop)
        ? (this.pageHeight - link.target.yTop + 6).toFixed(2) : null;
      const dest = top ? `/XYZ 0 ${top} null` : '/Fit';
      const annotId = addObj(
        `<< /Type /Annot /Subtype /Link /Rect [${link.x.toFixed(2)} ${y1.toFixed(2)} ${(link.x + link.w).toFixed(2)} ${y2.toFixed(2)}] ` +
        `/Border [0 0 0] /Dest [${pageIds[targetIndex]} 0 R ${dest}] >>`
      );
      if (!pageAnnots.has(link.pageIndex)) pageAnnots.set(link.pageIndex, []);
      pageAnnots.get(link.pageIndex).push(annotId);
    }
    for (const [pageIndex, annotIds] of pageAnnots) {
      const id = pageIds[pageIndex];
      objects[id - 1] = objects[id - 1].replace(/ >>$/, ` /Annots [${annotIds.map((a) => `${a} 0 R`).join(' ')}] >>`);
    }

    let outlinesRef = '';
    if (this.bookmarks.length) {
      const outlineRootId = objects.length + 1;
      const itemIds = this.bookmarks.map((_, i) => outlineRootId + 1 + i);
      addObj(`<< /Type /Outlines /First ${itemIds[0]} 0 R /Last ${itemIds[itemIds.length - 1]} 0 R /Count ${itemIds.length} >>`);
      this.bookmarks.forEach((bm, i) => {
        const parts = [
          `/Title ${pdfTextString(bm.title)}`,
          `/Parent ${outlineRootId} 0 R`,
          `/Dest [${pageIds[bm.pageIndex]} 0 R /Fit]`,
        ];
        if (i > 0) parts.push(`/Prev ${itemIds[i - 1]} 0 R`);
        if (i < itemIds.length - 1) parts.push(`/Next ${itemIds[i + 1]} 0 R`);
        addObj(`<< ${parts.join(' ')} >>`);
      });
      outlinesRef = `/Outlines ${outlineRootId} 0 R /PageMode /UseOutlines`;
    }

    // Document information dictionary: viewers show /Title in their title
    // bar and accessibility checkers look for it.
    const hasTitle = Boolean(String(this.title).trim());
    const infoParts = [];
    if (hasTitle) infoParts.push(`/Title ${pdfTextString(this.title)}`);
    if (String(this.author).trim()) infoParts.push(`/Author ${pdfTextString(this.author)}`);
    const infoId = infoParts.length ? addObj(`<< ${infoParts.join(' ')} >>`) : 0;
    const viewerPrefs = hasTitle ? '/ViewerPreferences << /DisplayDocTitle true >>' : '';

    objects[0] = `<< /Type /Catalog /Pages 2 0 R ${outlinesRef} ${viewerPrefs} >>`;
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
    xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${infoId ? ` /Info ${infoId} 0 R` : ''} >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(chunks);
  }
}

module.exports = { PdfBuilder, FONTS, FONT_FAMILIES, breakChunks, isWide };
