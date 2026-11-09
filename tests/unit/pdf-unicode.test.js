'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { TrueTypeFont } = require('../../core/ttf');
const { FallbackFonts, systemFontCandidates, hanPreference } = require('../../core/pdf-fonts');
const { PdfBuilder, breakChunks } = require('../../core/pdf');
const { exportPdf } = require('../../exporters/pdf');
const { buildRenderAst } = require('../../core/renderast');
const { GuideStore } = require('../../core/store');
const { fileNameSlug } = require('../../core/util');
const { makeTmpDir, rmrf } = require('./helpers');
const { makeFont, makeCollection } = require('./font-fixtures');


// --- Reading a PDF back: the text a viewer would copy.

function pdfObjects(buf) {
  const text = buf.toString('latin1');
  const objects = new Map();
  const re = /(\d+) 0 obj\n([\s\S]*?)\nendobj\n/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let body = m[2];
    let stream = null;
    const s = body.indexOf('\nstream\n');
    if (s >= 0) {
      const start = m.index + m[0].indexOf('\nstream\n') + 8;
      const length = Number(/\/Length (\d+)/.exec(body)[1]);
      stream = buf.subarray(start, start + length);
      if (/\/FlateDecode/.test(body.slice(0, s))) stream = zlib.inflateSync(stream);
      body = body.slice(0, s);
    }
    objects.set(Number(m[1]), { body, stream });
  }
  return objects;
}

/** Every page's text in reading order, decoding embedded fonts through their ToUnicode maps. */
function extractText(buf) {
  const objects = pdfObjects(buf);
  const fonts = new Map(); // resource name -> null (built-in) | Map<hex glyph, text>
  for (const { body } of objects.values()) {
    const res = /\/Font << ([^>]*) >>/.exec(body);
    if (!res) continue;
    for (const [, name, id] of res[1].matchAll(/\/(\w+) (\d+) 0 R/g)) {
      const font = objects.get(Number(id)).body;
      const toUnicode = /\/ToUnicode (\d+) 0 R/.exec(font);
      if (!toUnicode) { fonts.set(name, null); continue; }
      const cmap = objects.get(Number(toUnicode[1])).stream.toString('latin1');
      const map = new Map();
      for (const [, glyph, utf16] of cmap.matchAll(/<([0-9A-F]{4})> <([0-9A-F]+)>/g)) {
        map.set(glyph, Buffer.from(utf16, 'hex').swap16().toString('utf16le'));
      }
      fonts.set(name, map);
    }
  }
  const pages = [];
  for (const { body } of objects.values()) {
    if (!/\/Type \/Page /.test(body)) continue;
    const content = objects.get(Number(/\/Contents (\d+) 0 R/.exec(body)[1])).stream.toString('latin1');
    let font = null;
    let out = '';
    for (const [, name, literal, hex] of content.matchAll(/\/(\w+) [\d.]+ Tf|\(((?:\\.|[^\\)])*)\) Tj|<([0-9A-F]*)> Tj/g)) {
      if (name) font = fonts.get(name);
      else if (literal !== undefined) out += literal.replace(/\\(.)/g, '$1');
      else for (let i = 0; i < hex.length; i += 4) out += font.get(hex.slice(i, i + 4)) ?? '�';
    }
    pages.push(out);
  }
  return pages.join('\n');
}

// Every non-Latin character the tests draw, so the test font has them all.
const CJK = [...new Set('打开设置点击用户按钮然后重置密码設定を開くユーザー설정열기，。（）')].join('');
const CYRILLIC = [...new Set('ОткройтенастройкиСбросароляНажмитекнопку')].join('');

function fakeFonts(fontsByFace) {
  return new FallbackFonts(
    Object.keys(fontsByFace).map((file) => ({ regular: { file, index: 0 }, bold: null })),
    { load: (face) => new TrueTypeFont(fontsByFace[face.file], face.index) },
  );
}

// --- TrueType

test('TrueType: maps characters through format 12 and format 4 cmaps, with widths and metrics', () => {
  for (const format12 of [true, false]) {
    const font = new TrueTypeFont(makeFont({ chars: '中文Ж', width: 900, unitsPerEm: 2048, format12 }));
    assert.equal(font.glyphFor('中'.codePointAt(0)), 1);
    assert.equal(font.glyphFor('Ж'.codePointAt(0)), 3);
    assert.equal(font.glyphFor('x'.codePointAt(0)), 0, 'missing characters map to .notdef');
    assert.equal(font.advance(1), 900);
    assert.equal(font.unitsPerEm, 2048);
    assert.equal(font.postScriptName, 'TestSans');
    assert.equal(font.ascent, 800);
  }
  const astral = new TrueTypeFont(makeFont({ chars: '\u{20B9F}A' }));
  assert.equal(astral.glyphFor(0x20b9f), 1, 'characters beyond the BMP need the format 12 table');
});

test('TrueType: reads the right face of a .ttc and rejects CFF fonts', () => {
  const ttc = makeCollection(makeFont({ chars: 'A', name: 'First' }), makeFont({ chars: 'BC', name: 'Second' }));
  assert.equal(new TrueTypeFont(ttc, 0).postScriptName, 'First');
  const second = new TrueTypeFont(ttc, 1);
  assert.equal(second.postScriptName, 'Second');
  assert.equal(second.glyphFor('C'.codePointAt(0)), 2);
  assert.throws(() => new TrueTypeFont(ttc, 2), /2 faces/);
  assert.throws(() => new TrueTypeFont(Buffer.from('OTTO\0\0\0\0\0\0\0\0', 'latin1')), /CFF/);
});

test('TrueType: a subset keeps only the used glyphs, their components and every glyph id', () => {
  const font = new TrueTypeFont(makeFont({ chars: '一二三四', composite: true }));
  const composite = font.glyphCount - 1;
  assert.deepEqual(font.components(composite), [1]);
  const subset = new TrueTypeFont(font.subset([3, composite]));
  assert.equal(subset.glyphCount, font.glyphCount, 'glyph ids stay valid for CIDToGIDMap /Identity');
  const size = (f, g) => { const [s, e] = f.glyphRange(g); return e - s; };
  assert.ok(size(subset, 3) > 0);
  assert.ok(size(subset, 1) > 0, 'a composite glyph keeps the glyph it is built from');
  assert.ok(size(subset, 0) > 0, '.notdef is always kept');
  assert.equal(size(subset, 2), 0);
  assert.equal(size(subset, 4), 0);
  assert.equal(subset.advance(3), font.advance(3));
});

// --- Fallback fonts

test('fallback fonts: tried in order, loaded only when needed, bold first for bold text', () => {
  const loads = [];
  let listed = 0;
  const files = {
    latin: makeFont({ chars: 'Ж' }),
    han: makeFont({ chars: '中Ж' }),
    hanBold: makeFont({ chars: '中', name: 'Bold' }),
  };
  const fonts = new FallbackFonts(() => {
    listed += 1;
    return [{ regular: { file: 'latin', index: 0 }, bold: null }, { regular: { file: 'han', index: 0 }, bold: { file: 'hanBold', index: 0 } }];
  }, { load: (face) => { loads.push(face.file); return new TrueTypeFont(files[face.file]); } });
  assert.equal(listed, 0, 'no font search until a character needs one');
  assert.equal(fonts.fontFor('Ж'.codePointAt(0)).font.postScriptName, 'TestSans');
  assert.deepEqual(loads, ['latin']);
  assert.equal(fonts.fontFor('中'.codePointAt(0), true).font.postScriptName, 'Bold');
  assert.equal(fonts.fontFor('中'.codePointAt(0)).font, fonts.fonts.get('han#0'), 'regular text uses the regular face');
  assert.equal(fonts.fontFor(0x1f680), null);
  assert.equal(listed, 1);
  const broken = new FallbackFonts([{ regular: { file: 'x', index: 0 } }, { regular: { file: 'han', index: 0 } }],
    { load: (face) => { if (face.file === 'x') throw new Error('CFF'); return new TrueTypeFont(files.han); } });
  assert.ok(broken.fontFor('中'.codePointAt(0)), 'an unreadable font is skipped');
});

test('fallback fonts: Windows lists installed fonts for the guide language; Linux keeps TrueType from fontconfig', (t) => {
  const root = makeTmpDir('win-fonts');
  t.after(() => rmrf(root));
  fs.mkdirSync(path.join(root, 'Fonts'));
  for (const name of ['segoeui.ttf', 'msyh.ttc', 'msyhbd.ttc', 'YuGothR.ttc', 'malgun.ttf']) fs.writeFileSync(path.join(root, 'Fonts', name), '');
  const files = (text) => systemFontCandidates({ text, platform: 'win32', env: { WINDIR: root } })
    .map((pair) => path.basename((pair.regular || pair.bold).file));
  assert.deepEqual(files('打开'), ['segoeui.ttf', 'msyh.ttc', 'YuGothR.ttc', 'malgun.ttf']);
  assert.deepEqual(files('設定を開く'), ['segoeui.ttf', 'YuGothR.ttc', 'msyh.ttc', 'malgun.ttf']);
  assert.deepEqual(files('설정'), ['segoeui.ttf', 'malgun.ttf', 'msyh.ttc', 'YuGothR.ttc']);
  const yahei = systemFontCandidates({ platform: 'win32', env: { WINDIR: root } }).find((pair) => pair.regular?.file.endsWith('msyh.ttc'));
  assert.ok(yahei.bold.file.endsWith('msyhbd.ttc'));
  assert.equal(hanPreference('ひらがな'), 'ja');

  const calls = [];
  const run = (cmd, args) => {
    calls.push(args.at(-1));
    return '/usr/share/fonts/DejaVuSans.ttf\t0\tTrueType\n/usr/share/fonts/NotoSansCJK.ttc\t2\tCFF\n/usr/share/fonts/wqy-zenhei.ttc\t1\tTrueType\n';
  };
  const linux = systemFontCandidates({ text: '打开', platform: 'linux', run });
  assert.ok(calls.includes('sans-serif:lang=zh-cn'));
  assert.deepEqual(linux.filter((pair) => pair.regular).map((pair) => [pair.regular.file, pair.regular.index]),
    [['/usr/share/fonts/DejaVuSans.ttf', 0], ['/usr/share/fonts/wqy-zenhei.ttc', 1]], 'CFF fonts are skipped');
  assert.deepEqual(systemFontCandidates({ platform: 'linux', run: () => { throw new Error('no fc-match'); } }), []);
});

// --- PDF builder

test('PDF: text outside WinAnsi is drawn from an embedded subset with a ToUnicode map', () => {
  const pdf = new PdfBuilder({ fallbackFonts: fakeFonts({ cjk: makeFont({ chars: CJK + CYRILLIC }) }) });
  pdf.addPage();
  pdf.text('Step 1: 打开设置 - Откройте', 72, 72);
  pdf.textRun([{ text: '点击', font: 'F1', color: [0, 0, 0] }, { text: '用户', font: 'F2', color: [0, 0, 255] }, { text: ' OK', font: 'F2', color: [0, 0, 0] }], 72, 100, 11);
  const buf = pdf.build();
  const text = buf.toString('latin1');
  assert.match(text, /\/Subtype \/Type0 \/BaseFont \/[A-Z]{6}\+TestSans \/Encoding \/Identity-H/);
  assert.match(text, /\/Subtype \/CIDFontType2 .* \/CIDToGIDMap \/Identity/);
  assert.match(text, /\/FontFile2 \d+ 0 R/);
  assert.equal(extractText(buf), 'Step 1: 打开设置 - Откройте点击用户 OK');
  // The embedded program parses as a font that has exactly the used glyphs.
  const objects = pdfObjects(buf);
  const program = [...objects.values()].find((o) => /\/Length1 /.test(o.body)).stream;
  const embedded = new TrueTypeFont(program);
  const original = new TrueTypeFont(makeFont({ chars: CJK + CYRILLIC }));
  const [s, e] = embedded.glyphRange(original.glyphFor('打'.codePointAt(0)));
  assert.ok(e > s);
  const [s2, e2] = embedded.glyphRange(original.glyphFor('密'.codePointAt(0)));
  assert.equal(e2 - s2, 0, 'unused glyphs are left out');
});

test('PDF: Western text is unchanged, and characters no font has stay "?"', () => {
  const draw = (fallbackFonts) => {
    const pdf = new PdfBuilder({ fallbackFonts });
    pdf.addPage();
    pdf.text('Café “quotes” – €5', 72, 72, { font: 'F2' });
    pdf.textRun([{ text: 'Bold', font: 'F2', color: [0, 0, 0] }, { text: ' and plain', font: 'F1', color: [1, 0, 0] }], 72, 90, 11);
    return pdf.build();
  };
  assert.deepEqual(draw(fakeFonts({ cjk: makeFont({ chars: CJK }) })), draw(null), 'no font lookups, identical bytes');
  const pdf = new PdfBuilder({ fallbackFonts: fakeFonts({ cjk: makeFont({ chars: '中' }) }) });
  pdf.addPage();
  pdf.text('中 🚀 Ж', 72, 72);
  assert.equal(extractText(pdf.build()), '中 ? ?');
});

test('PDF: widths come from the font, and lines break between Chinese, Japanese and Korean characters', () => {
  const pdf = new PdfBuilder({ fallbackFonts: fakeFonts({ cjk: makeFont({ chars: CJK, width: 1000 }) }) });
  assert.equal(pdf.textWidth('打开设置', 10), 40, 'four 1em characters at 10pt');
  assert.equal(pdf.textWidth('OK', 10), 10.2, 'built-in fonts keep their estimate');
  const lines = pdf.wrapText('点击用户按钮，然后重置密码。', 10, 45);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => pdf.textWidth(line, 10) <= 45 || [...line].length <= 2));
  assert.equal(lines.join(''), '点击用户按钮，然后重置密码。');
  assert.ok(lines.every((line) => !/^[，。]/.test(line)), 'closing punctuation never starts a line');
  assert.deepEqual(breakChunks('（用户）。OK'), ['（用', '户）。', 'OK']);
  assert.deepEqual(breakChunks('settings'), ['settings']);
  assert.deepEqual(new PdfBuilder().wrapText('Click the Save button', 10, 60), ['Click the', 'Save button']);
});

// --- Export

test('PDF export: a Chinese and Russian guide keeps its text and its file name', (t) => {
  const root = makeTmpDir('pdf-unicode');
  t.after(() => rmrf(root));
  const store = new GuideStore(path.join(root, 'data'));
  const guide = store.createGuide({ title: '重置密码 / Сброс пароля' });
  store.addStep(guide.guideId, { title: '打开设置', descriptionHtml: '<p>点击<b>用户</b>按钮。</p>' });
  store.addStep(guide.guideId, { title: 'Откройте настройки', descriptionHtml: '<ul><li>Нажмите кнопку</li></ul>' });
  store.addStep(guide.guideId, { title: 'Code', codeBlocks: [{ language: 'text', code: '# 打开设置 then OK' }] });
  const fallbackFonts = fakeFonts({ all: makeFont({ chars: CJK + CYRILLIC }) });
  const { file } = exportPdf(buildRenderAst(store, guide.guideId), path.join(root, 'out'), {}, { fallbackFonts });
  assert.equal(path.basename(file), '重置密码-сброс-пароля.pdf');
  const text = extractText(fs.readFileSync(file));
  for (const expected of ['打开设置', '点击用户按钮。', 'Откройте настройки', 'Нажмите кнопку']) assert.ok(text.includes(expected), expected);
});

test('export file names keep every script but drop accents and characters Windows forbids', () => {
  assert.equal(fileNameSlug('重置密码 / Сброс пароля', 'guide'), '重置密码-сброс-пароля');
  assert.equal(fileNameSlug('設定を開く デ'), '設定を開く-デ', 'kana with marks stay composed');
  assert.equal(fileNameSlug('설정 열기'), '설정-열기', 'Korean syllables stay composed');
  assert.equal(fileNameSlug('Café résumé – naïve', 'guide'), 'cafe-resume-naive');
  assert.equal(fileNameSlug('a<b>:c"/\\|?*d', 'guide'), 'abcd');
  assert.equal(fileNameSlug('...', 'guide'), 'guide');
  assert.equal([...fileNameSlug('文'.repeat(200))].length, 80);
});

// --- Real installed fonts, when this machine has them (Windows CI does).

test('PDF export with this computer\'s fonts draws whatever it has fonts for', (t) => {
  const fonts = new FallbackFonts(() => systemFontCandidates({ text: '中' }));
  const covered = (text) => [...text].every((ch) => ch === ' ' || fonts.fontFor(ch.codePointAt(0)));
  const sample = ['重置密码 Сброс', 'Сброс'].find(covered);
  if (!sample) return t.skip('no installed font has Chinese or Cyrillic');
  const pdf = new PdfBuilder({ fallbackFonts: fonts });
  pdf.addPage();
  pdf.text(sample, 72, 72);
  assert.equal(extractText(pdf.build()), sample);
});
