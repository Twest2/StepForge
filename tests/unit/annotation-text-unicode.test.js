'use strict';

// Annotation text burned into exported screenshots (text boxes, tooltips,
// GIF title cards) must show every script, not just the Lato atlas.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TrueTypeFont } = require('../../core/ttf');
const { FallbackFonts, systemFontCandidates } = require('../../core/pdf-fonts');
const text = require('../../core/text-raster');
const raster = require('../../core/raster');
const { table, makeFont } = require('./font-fixtures');

const CHINESE = '中打开设置然后重置密码按钮';
const JAPANESE = '設定を開く';

/** One contour: on (0,0), off (500,1000), on (1000,0). */
function curveGlyph() {
  return table(29, (b) => {
    b.writeInt16BE(1, 0); b.writeInt16BE(1000, 6); b.writeInt16BE(1000, 8);
    b.writeUInt16BE(2, 10); // last point
    b.writeUInt16BE(0, 12); // no instructions
    b[14] = 1; b[15] = 0; b[16] = 1; // on, off, on; 16-bit deltas
    [0, 500, 500].forEach((dx, i) => b.writeInt16BE(dx, 17 + i * 2));
    [0, 1000, -1000].forEach((dy, i) => b.writeInt16BE(dy, 23 + i * 2));
  });
}

/** Glyph 1 placed at (10, 20) at half size. */
function scaledComposite() {
  return table(20, (b) => {
    b.writeInt16BE(-1, 0);
    b.writeUInt16BE(0x000b, 10); // words, xy values, one scale, last component
    b.writeUInt16BE(1, 12);
    b.writeInt16BE(10, 14); b.writeInt16BE(20, 16);
    b.writeInt16BE(8192, 18); // 0.5 in F2Dot14
  });
}

// --- a minimal CFF table

function cffIndex(items) {
  if (!items.length) return Buffer.from([0, 0]);
  const head = Buffer.alloc(3 + (items.length + 1) * 4);
  head.writeUInt16BE(items.length, 0);
  head[2] = 4;
  let offset = 1;
  items.forEach((item, i) => { head.writeUInt32BE(offset, 3 + i * 4); offset += item.length; });
  head.writeUInt32BE(offset, 3 + items.length * 4);
  return Buffer.concat([head, ...items]);
}

const OPS = { hlineto: 6, rmoveto: 21, endchar: 14, callgsubr: 29, return: 11, hvcurveto: 31 };
function charString(...parts) {
  const bytes = [];
  for (const p of parts) {
    if (typeof p === 'string') bytes.push(OPS[p]);
    else if (p >= -107 && p <= 107) bytes.push(p + 139);
    else bytes.push(28, (p >> 8) & 0xff, p & 0xff);
  }
  return Buffer.from(bytes);
}

function cffTable(charStrings, globalSubrs) {
  const header = Buffer.from([1, 0, 4, 4]);
  const name = cffIndex([Buffer.from('TestCFF')]);
  const strings = cffIndex([]);
  const gsubrs = cffIndex(globalSubrs);
  const topSize = 3 + 2 * 4 + 6;
  const charStringsAt = header.length + name.length + topSize + strings.length + gsubrs.length;
  const top = Buffer.from([29, 0, 0, 0, 0, 17]);
  top.writeInt32BE(charStringsAt, 1);
  return Buffer.concat([header, name, cffIndex([top]), strings, gsubrs, cffIndex(charStrings)]);
}

function cffFont() {
  return makeFont({
    chars: '中文',
    cff: cffTable([
      charString('endchar'),
      // A width (600) before the first move, then a box drawn with alternating lines.
      charString(600, 100, 0, 'rmoveto', 400, 700, -400, 'hlineto', 'endchar'),
      charString(0, 0, 'rmoveto', -107, 'callgsubr', 'endchar'),
    ], [charString(100, 50, 50, 100, 'hvcurveto', 'return')]),
  });
}

// --- test fallback fonts

function fakeFallbacks(buf, asked = []) {
  return (prefer) => {
    asked.push(prefer);
    return new FallbackFonts([{ regular: { file: 'test.ttf', index: 0 }, bold: null }], { load: () => new TrueTypeFont(buf, 0, { cff: true }) });
  };
}

function withFonts(t, factory) {
  text.setFallbackFonts(factory);
  t.after(() => text.setFallbackFonts());
}

function inkBox(img, color) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const p = (y * img.width + x) * 4;
      if (img.data[p] === color[0] && img.data[p + 1] === color[1] && img.data[p + 2] === color[2]) {
        count++;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  return { count, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// --- outlines

test('TrueType outlines: on- and off-curve points become lines and quadratic curves; composites are moved and scaled', () => {
  const font = new TrueTypeFont(makeFont({ chars: 'AB', glyphs: { 1: curveGlyph(), 2: scaledComposite() } }));
  assert.deepEqual(font.outline(1), [['M', 0, 0], ['Q', 500, 1000, 1000, 0], ['L', 0, 0]]);
  assert.deepEqual(font.outline(2), [['M', 10, 20], ['Q', 260, 520, 510, 20], ['L', 10, 20]]);
  assert.deepEqual(font.outline(0)[0], ['M', 0, 0], 'the plain box glyph');
  assert.deepEqual(font.outline(99), [], 'glyph ids past the end draw nothing');
});

test('CFF outlines: read only when asked for, with widths skipped, alternating lines, subroutines and curves', () => {
  const buf = cffFont();
  assert.throws(() => new TrueTypeFont(buf), /CFF/, 'PDF embedding still rejects CFF fonts');
  const font = new TrueTypeFont(buf, 0, { cff: true });
  assert.equal(font.glyphFor('文'.codePointAt(0)), 2);
  assert.deepEqual(font.outline(1), [['M', 100, 0], ['L', 500, 0], ['L', 500, 700], ['L', 100, 700]]);
  assert.deepEqual(font.outline(2), [['M', 0, 0], ['C', 100, 0, 150, 50, 150, 150]]);
  assert.throws(() => font.subset([1]), /cannot be subset/);
});

test('Linux font lists keep CFF fonts (Noto Sans CJK) only for drawing', () => {
  const run = () => '/f/DejaVuSans.ttf\t0\tTrueType\n/f/NotoSansCJK-Regular.ttc\t2\tCFF\n';
  const files = (cff) => systemFontCandidates({ text: '打开', platform: 'linux', run, cff })
    .filter((pair) => pair.regular).map((pair) => `${pair.regular.file}#${pair.regular.index}`);
  assert.deepEqual(files(false), ['/f/DejaVuSans.ttf#0']);
  assert.deepEqual(files(true), ['/f/DejaVuSans.ttf#0', '/f/NotoSansCJK-Regular.ttc#2']);
});

// --- drawing

test('text boxes draw Chinese from an installed font at the annotation size instead of "?"', (t) => {
  const red = [229, 72, 77, 255];
  const draw = () => raster.renderAnnotations(raster.createImage(400, 200), [
    { type: 'text', x: 0.1, y: 0.1, w: 0.5, h: 0.2, text: '中', style: { stroke: '#E5484D', fontSize: 0.1 } },
  ]);
  text.setFallbackFonts(() => null);
  const missing = inkBox(draw(), red);
  withFonts(t, fakeFallbacks(makeFont({ chars: CHINESE })));
  const drawn = inkBox(draw(), red);
  // The test glyph is a 1000x700 box on a 1000-unit em: 20x14 px at 20 px.
  assert.ok(Math.abs(drawn.w - 20) <= 1 && Math.abs(drawn.h - 14) <= 1, `box ${drawn.w}x${drawn.h}`);
  assert.ok(drawn.count >= 18 * 12, `solid fill (${drawn.count} px)`);
  assert.ok(missing.count < drawn.count / 2, 'without a font it is a "?"');
});

test('tooltips center and fit Chinese text, and CFF fonts draw too', (t) => {
  withFonts(t, fakeFallbacks(cffFont()));
  const yellow = [255, 238, 0, 255];
  const out = raster.renderAnnotations(raster.createImage(400, 200), [
    { type: 'tooltip', x: 0.1, y: 0.1, w: 0.6, h: 0.3, text: '中', style: { fontSize: 0.1, textColor: '#FFEE00' } },
  ]);
  const ink = inkBox(out, yellow);
  // CFF glyph 1 is a 400x700 box: 8x14 px at 20 px.
  assert.ok(Math.abs(ink.w - 8) <= 1 && Math.abs(ink.h - 14) <= 1, `box ${ink.w}x${ink.h}`);
});

test('measuring, wrapping and fitting use installed-font widths and break between Chinese characters', (t) => {
  const asked = [];
  withFonts(t, fakeFallbacks(makeFont({ chars: CHINESE + JAPANESE }), asked));
  assert.equal(text.lineWidth('中中', 20), 40);
  assert.equal(text.lineWidth('中️‍', 20), 20, 'variation selectors and joiners take no space');
  const lines = text.wrapText('打开设置然后重置密码', 20, 100);
  assert.deepEqual(lines, ['打开设置然', '后重置密码']);
  const fitted = text.fitText('打开设置然后重置密码', 20, 100);
  assert.ok(fitted.endsWith('…') && text.lineWidth(fitted, 20) <= 100);
  text.lineWidth(JAPANESE, 20);
  assert.deepEqual([...new Set(asked)], ['zh', 'ja'], 'Japanese text asks for Japanese fonts first');
});

test('fitting never splits a character outside the Basic Multilingual Plane', (t) => {
  withFonts(t, () => null);
  const fitted = text.fitText('😀😀😀😀😀😀😀😀😀😀', 20, 50);
  assert.ok(fitted.endsWith('…'));
  assert.doesNotMatch(fitted, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
});

test('with this computer\'s fonts, Chinese annotation text is not drawn as "?"', (t) => {
  const fonts = new FallbackFonts(() => systemFontCandidates({ cff: true }), { load: (face) => new TrueTypeFont(require('node:fs').readFileSync(face.file), face.index, { cff: true }) });
  if (!fonts.fontFor('中'.codePointAt(0), true)) return t.skip('no installed font has Chinese');
  const draw = (str) => raster.renderAnnotations(raster.createImage(300, 120), [
    { type: 'text', x: 0.05, y: 0.1, w: 0.9, h: 0.5, text: str, style: { stroke: '#000000', fontSize: 0.25 } },
  ]);
  text.setFallbackFonts(() => null);
  const unknown = draw('中文');
  text.setFallbackFonts();
  t.after(() => text.setFallbackFonts());
  const zh = draw('中文');
  const differing = zh.data.filter((v, i) => v !== unknown.data[i]).length;
  assert.ok(differing > 500, `Chinese glyphs differ from "??" (${differing} bytes)`);
  assert.notDeepEqual(draw('中').data, draw('文').data, 'different characters draw differently');
});
