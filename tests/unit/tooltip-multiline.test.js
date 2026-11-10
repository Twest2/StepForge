'use strict';

// Tooltip text wraps onto several lines in the editor and in exports, in
// every interface language, instead of being squeezed onto one line.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const wrap = require('../../core/text-wrap');
const text = require('../../core/text-raster');
const raster = require('../../core/raster');
const { TrueTypeFont } = require('../../core/ttf');
const { FallbackFonts } = require('../../core/pdf-fonts');
const { makeFont } = require('./font-fixtures');
const { rendererI18n } = require('./helpers');

// A real tooltip in each language StepForge speaks.
const SAMPLES = {
  en: 'Click Save to keep your changes before you close the window.',
  es: 'Haz clic en Guardar para conservar los cambios antes de cerrar la ventana.',
  fr: 'Cliquez sur Enregistrer pour conserver vos modifications avant de fermer la fenêtre.',
  ru: 'Нажмите «Сохранить», чтобы сохранить изменения перед закрытием окна.',
  ja: '「保存」をクリックして、ウィンドウを閉じる前に変更を保存します。',
  'zh-CN': '在关闭窗口之前，点击“保存”以保留你的更改。',
};
const SPACELESS = new Set(['ja', 'zh-CN']);
const NO_BREAK_BEFORE = '、。，．：；！？）」』】〉》”’';
const NO_BREAK_AFTER = '（「『【〈《“‘';

// Widths at a 10 px font, like real ones: letters about 0.6 em, Chinese and Japanese 1.2 em.
const measure = (str) => Array.from(str).reduce((sum, ch) => sum + (wrap.isWide(ch) ? 12 : 6), 0);

test('wrapping: every language breaks into lines that fit, losing and squeezing nothing', () => {
  for (const [lang, sample] of Object.entries(SAMPLES)) {
    const lines = wrap.wrapLines(sample, 200, measure);
    assert.ok(lines.length >= 2, `${lang}: wraps (${lines.length} lines)`);
    for (const line of lines) assert.ok(measure(line) <= 200, `${lang}: "${line}" fits`);
    if (SPACELESS.has(lang)) {
      assert.equal(lines.join(''), sample, `${lang}: every character kept, in order`);
      for (const line of lines.slice(1)) assert.ok(!NO_BREAK_BEFORE.includes(Array.from(line)[0]), `${lang}: no line starts with "${line[0]}"`);
      for (const line of lines.slice(0, -1)) assert.ok(!NO_BREAK_AFTER.includes(Array.from(line).at(-1)), `${lang}: no line ends with an opening mark`);
    } else {
      assert.equal(lines.join(' '), sample, `${lang}: breaks only at spaces`);
    }
  }
});

test('wrapping: typed line breaks and empty lines stay; a word wider than the box is split', () => {
  assert.deepEqual(wrap.wrapLines('Step one\n\nStep two', 500, measure), ['Step one', '', 'Step two']);
  assert.deepEqual(wrap.wrapLines('a\r\nb', 500, measure), ['a', 'b']);
  const url = 'https://example.com/a/very/long/path';
  const lines = wrap.wrapLines(`Open ${url}`, 72, measure);
  assert.equal(lines.join('').replace('Open', ''), url);
  for (const line of lines) assert.ok(measure(line) <= 72);
  // Emoji and other characters outside the BMP are never cut in half.
  assert.deepEqual(wrap.wrapLines('😀😀😀', 12, measure), ['😀😀', '😀']);
});

test('layout: the font only gets smaller when the box is too short, and the same for every line', () => {
  const at = (str, size) => measure(str) * size / 10;
  const roomy = wrap.layoutBoxText({ text: SAMPLES.en, width: 150, height: 200, size: 10, measure: at });
  assert.equal(roomy.size, 10, 'fits at its own size');
  assert.ok(roomy.lines.length >= 3);
  const short = wrap.layoutBoxText({ text: SAMPLES.en, width: 150, height: 30, size: 10, minSize: 5, measure: at });
  assert.ok(short.size < 10 && short.size >= 5, `smaller (${short.size})`);
  assert.ok(short.lines.length * short.lineHeight <= 30 || short.size === 5);
  const tiny = wrap.layoutBoxText({ text: SAMPLES.en, width: 150, height: 8, size: 10, minSize: 6, measure: at });
  assert.equal(tiny.lines.length, 1);
  assert.match(tiny.lines[0], /…$/, 'what still doesn’t fit ends in …');
});

// --- exports

const YELLOW = [255, 238, 0];

/** Rows of text in the box: runs of rows with text-colored pixels. */
function textRows(img) {
  const rows = [];
  let inRow = false;
  let minX = Infinity, maxX = -1;
  for (let y = 0; y < img.height; y++) {
    let hit = false;
    for (let x = 0; x < img.width; x++) {
      const p = (y * img.width + x) * 4;
      if (img.data[p] > 200 && img.data[p + 1] > 180 && img.data[p + 2] < 90) { hit = true; minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    }
    if (hit && !inRow) rows.push(y);
    inRow = hit;
  }
  return { rows: rows.length, minX, maxX };
}

test('exports: tooltips draw every language on several lines inside the box', (t) => {
  // An installed font for the scripts the built-in font doesn't have, as on a real computer.
  const others = [...new Set(Object.values(SAMPLES).join('').replace(/[\x00-\x7f]/g, ''))].join('');
  const font = makeFont({ chars: others, width: 600 });
  text.setFallbackFonts(() => new FallbackFonts([{ regular: { file: 'test.ttf', index: 0 }, bold: null }], { load: () => new TrueTypeFont(font, 0) }));
  t.after(() => text.setFallbackFonts());
  for (const [lang, sample] of Object.entries(SAMPLES)) {
    const box = { x: 0.1, y: 0.1, w: 0.5, h: 0.6 };
    const img = raster.renderAnnotations(raster.createImage(400, 300, [255, 255, 255, 255]), [
      { type: 'tooltip', ...box, text: sample, style: { fontSize: 0.05, textColor: '#FFEE00', tail: 'bottom' } },
    ]);
    const ink = textRows(img);
    assert.ok(ink.rows >= 2, `${lang}: ${ink.rows} lines`);
    assert.ok(ink.minX >= box.x * 400 && ink.maxX <= (box.x + box.w) * 400, `${lang}: text stays inside the tooltip`);
  }
});

test('exports: typed line breaks show as separate lines even when the text is short', () => {
  const img = raster.renderAnnotations(raster.createImage(400, 300, [255, 255, 255, 255]), [
    { type: 'tooltip', x: 0.1, y: 0.1, w: 0.6, h: 0.4, text: 'Save\nthen close', style: { fontSize: 0.05, textColor: '#FFEE00' } },
  ]);
  assert.equal(textRows(img).rows, 2);
});

// --- editor canvas

function loadCanvas() {
  const fills = [];
  let font = '';
  const ctx = new Proxy({
    fillText: (...args) => fills.push(args),
    measureText: (str) => ({ width: measure(str) * (parseFloat(/(\d+(\.\d+)?)px/.exec(font)?.[1]) || 10) / 10 }),
  }, {
    get: (target, key) => (key in target ? target[key] : key === 'font' ? font : () => {}),
    set: (target, key, value) => { if (key === 'font') font = value; else target[key] = value; return true; },
  });
  const element = {
    width: 0, height: 0, style: {}, parentElement: { clientWidth: 400, clientHeight: 300 },
    addEventListener() {}, setPointerCapture() {}, getContext: () => ctx,
    getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 300 }; },
  };
  const window = {
    devicePixelRatio: 1, matchMedia: () => ({ matches: false, addEventListener() {} }),
    StepForgeTextWrap: wrap, StepForgeAnnotationProperties: require('../../core/annotation-properties'),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/canvas.js'), 'utf8'),
    { ...rendererI18n(), window, document: { createElement: () => element } });
  const canvas = new window.AnnotationCanvas(element, {});
  canvas.setZoom(1);
  canvas.setImage({}, 400, 300);
  return { canvas, fills };
}

test('editor: tooltip text is drawn line by line at full width, never squeezed into one line', () => {
  for (const [lang, sample] of Object.entries(SAMPLES)) {
    const { canvas, fills } = loadCanvas();
    canvas.setAnnotations([{ id: 'a', type: 'tooltip', x: 0.1, y: 0.1, w: 0.5, h: 0.6, text: sample, style: { fontSize: 0.05 } }]);
    fills.length = 0;
    canvas.render();
    assert.ok(fills.length >= 2, `${lang}: ${fills.length} lines`);
    assert.ok(fills.every((args) => args[3] === undefined), `${lang}: no maximum width that squeezes the text`);
    assert.equal(fills.map((args) => args[0]).join(SPACELESS.has(lang) ? '' : ' '), sample, `${lang}: all the text`);
  }
});

test('editor: a tooltip grows to fit its text, and its tail keeps pointing at the same place', () => {
  const { canvas } = loadCanvas();
  for (const [tail, keep] of [['bottom', (a) => a.y + a.h], ['top', (a) => a.y], ['left', (a) => a.y + a.h / 2]]) {
    const ann = { id: 'a', type: 'tooltip', x: 0.2, y: 0.4, w: 0.4, h: 0.08, text: SAMPLES.fr, style: { fontSize: 0.05, tail } };
    const before = keep(ann);
    assert.equal(canvas.growTooltipToFit(ann), true, tail);
    assert.ok(ann.h > 0.08, `${tail}: taller (${ann.h.toFixed(3)})`);
    assert.ok(Math.abs(keep(ann) - before) < 1e-9, `${tail}: tail point unchanged`);
    assert.equal(canvas.growTooltipToFit(ann), false, `${tail}: already fits`);
  }
  const short = { id: 'b', type: 'tooltip', x: 0.2, y: 0.4, w: 0.4, h: 0.3, text: 'OK', style: { fontSize: 0.05 } };
  assert.equal(canvas.growTooltipToFit(short), false, 'never shrinks a box the user made bigger');
  assert.equal(short.h, 0.3);
});
