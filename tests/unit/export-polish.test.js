'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { GuideStore } = require('../../core/store');
const { BrandingStore } = require('../../core/branding');
const { buildRenderAst } = require('../../core/renderast');
const { exportPdf } = require('../../exporters/pdf');
const { exportDocx } = require('../../exporters/docx');
const { exportHtmlRich } = require('../../exporters/html');
const { exportGifGuide } = require('../../exporters/gif');
const { logoNeedsCard, coverLogo, luminance, hexToRgb } = require('../../exporters/branding');
const { unzipSync } = require('../../core/zip');
const { encodePng } = require('../../core/png');
const raster = require('../../core/raster');
const { decodeGif } = require('./gifdecode');
const { makeTmpDir, rmrf } = require('./helpers');

function tmp(t, label) {
  const dir = makeTmpDir(label);
  t.after(() => rmrf(dir));
  return dir;
}

/** A wordmark in dark ink on transparent: it vanishes on a dark band. */
function darkLogo() {
  const img = raster.createImage(300, 80, [0, 0, 0, 0]);
  raster.fillRect(img, 0, 0, 80, 80, [15, 40, 70, 255]);
  raster.fillRect(img, 100, 25, 200, 30, [15, 40, 70, 255]);
  return img;
}

/** Inflated content streams of a PDF, in page order. */
function pdfPages(buf) {
  const text = buf.toString('latin1');
  const out = [];
  const re = /\d+ 0 obj\n<< \/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length;
    out.push(zlib.inflateSync(buf.subarray(start, start + Number(m[1]))).toString('latin1'));
  }
  return out;
}

/** A branded guide with a Band cover and a dark logo. */
function bandGuide(t, label, steps = 2) {
  const root = tmp(t, label);
  const store = new GuideStore(path.join(root, 'data'));
  const guide = store.createGuide({ title: 'Band cover' });
  const png = encodePng(raster.createImage(640, 400, [240, 242, 245, 255]));
  for (let i = 1; i <= steps; i++) store.addStep(guide.guideId, { title: `Step ${i}`, descriptionHtml: `<p>Do thing ${i}.</p>` }, png, { width: 640, height: 400 });
  store.addStep(guide.guideId, { kind: 'empty', title: 'No screenshot here' });
  const brands = new BrandingStore(path.join(root, 'settings'));
  const logo = brands.addAsset(encodePng(darkLogo()), { kind: 'image', fileName: 'logo.png' });
  const profile = brands.save({ name: 'Northwind', colors: { primary: '#0E7490', accent: '#F59E0B', text: '#1E293B' }, logo: logo.id, cover: 'band' });
  return { root, ast: buildRenderAst(store, guide.guideId, { branding: brands.resolve(profile.id) }) };
}

test('a dark logo gets a white card on a dark band, and not on white', () => {
  const logo = darkLogo();
  assert.equal(logoNeedsCard(logo, luminance(hexToRgb('#0E7490'))), true);
  assert.equal(logoNeedsCard(logo, luminance([255, 255, 255])), false);
  const brand = { logo: { png: encodePng(logo), width: 300, height: 80 } };
  const card = coverLogo(brand, '#0E7490');
  assert.equal(card.carded, true);
  assert.ok(card.img.width > 300 && card.img.height > 80, 'padding around the logo');
  const at = (x, y) => [...card.img.data.subarray((y * card.img.width + x) * 4, (y * card.img.width + x) * 4 + 4)];
  assert.deepEqual(at(Math.round(card.img.width / 2), 2), [255, 255, 255, 255], 'white card');
  assert.equal(at(0, 0)[3], 0, 'rounded corner left clear');
  assert.equal(coverLogo(brand, '#FFFFFF').carded, false);
  assert.equal(coverLogo(brand, '#FFFFFF').img.width, 300);
});

test('the Band cover puts a dark logo on a card in PDF, Word, HTML and the GIF title card', (t) => {
  const { root, ast } = bandGuide(t, 'band-card');
  // PDF: the cover's logo image is the carded one (wider than the logo, with padding).
  const pdf = fs.readFileSync(exportPdf(ast, path.join(root, 'pdf')).file).toString('latin1');
  const widths = [...pdf.matchAll(/\/Subtype \/Image \/Width (\d+)/g)].map((m) => Number(m[1]));
  assert.ok(widths.some((w) => w > 300 && w < 400), 'a carded logo in the PDF');
  // Word: the cover uses the carded logo picture.
  const docx = new Map(unzipSync(fs.readFileSync(exportDocx(ast, path.join(root, 'docx')).file)).map((e) => [e.name, e.data]));
  assert.ok(docx.has('word/media/brand-logo-card.png'));
  assert.match(docx.get('word/_rels/document.xml.rels').toString('utf8'), /Target="media\/brand-logo-card.png"/);
  // HTML: the logo carries the card class.
  const html = fs.readFileSync(exportHtmlRich(ast, path.join(root, 'html')).file, 'utf8');
  assert.match(html, /<img class="brand-logo on-card"/);
  // GIF: white card pixels on the band's title card.
  const gif = decodeGif(fs.readFileSync(exportGifGuide(ast, path.join(root, 'gif')).file));
  const first = gif.frames[0];
  const palette = first.palette || gif.palette;
  const white = first.indices.filter((i) => palette[i * 3] === 255 && palette[i * 3 + 1] === 255 && palette[i * 3 + 2] === 255).length;
  assert.ok(white > 2000, 'a white card behind the logo');
});

test('the GIF title card counts every step, not only those with a screenshot', (t) => {
  const { root, ast } = bandGuide(t, 'gif-count', 2);
  const { titleCardMeta } = require('../../exporters/gif');
  assert.equal(titleCardMeta(ast), '3 steps', 'two with screenshots and one without');
  assert.ok(fs.existsSync(exportGifGuide(ast, path.join(root, 'gif')).file));
});

test('PDF callout labels are dark enough to read on their tint', (t) => {
  const root = tmp(t, 'pdf-labels');
  const store = new GuideStore(path.join(root, 'data'));
  const guide = store.createGuide({ title: 'Labels' });
  store.addStep(guide.guideId, {
    kind: 'empty',
    title: 'Callouts',
    textBlocks: ['info', 'success', 'warn', 'error'].map((level) => ({ position: 'after-description', level, title: level, descriptionHtml: '<p>Text.</p>' })),
  });
  const pages = pdfPages(fs.readFileSync(exportPdf(buildRenderAst(store, guide.guideId), path.join(root, 'out')).file)).join('\n');
  for (const [rgb, label] of [['0.114 0.306 0.847', 'Note: info'], ['0.016 0.471 0.341', 'Tip: success'], ['0.706 0.325 0.035', 'Warning: warn'], ['0.725 0.110 0.110', 'Important: error']]) {
    assert.match(pages, new RegExp(`${rgb} rg [^\\n]*\\(${label}\\) Tj`), label);
  }
});

test('PDF keeps a short callout after a screenshot on the screenshot’s page', (t) => {
  const root = tmp(t, 'pdf-keep');
  const store = new GuideStore(path.join(root, 'data'));
  const guide = store.createGuide({ title: 'Keep together' });
  const png = encodePng(raster.createImage(640, 300, [240, 242, 245, 255]));
  // Steps too long for one page, of growing length, end their screenshots at
  // every height on a page; the callout after each one must not be left behind.
  for (let i = 1; i <= 16; i++) {
    store.addStep(guide.guideId, {
      title: `Step ${i}`,
      descriptionHtml: `<p>${'Read the instructions carefully before you go on. '.repeat(70 + i * 6)}</p>`,
      textBlocks: [{ position: 'after-image', level: 'info', title: `After ${i}`, descriptionHtml: '<p>Check the result.</p>' }],
    }, png, { width: 640, height: 300 });
  }
  const pages = pdfPages(fs.readFileSync(exportPdf(buildRenderAst(store, guide.guideId), path.join(root, 'out'), { includeCover: false, includeToc: false }).file));
  for (const [n, page] of pages.entries()) {
    const label = page.search(/\(Note: After \d+\) Tj/);
    if (label < 0) continue;
    const image = page.search(/ Do Q/);
    assert.ok(image >= 0 && image < label, `page ${n + 1}: the callout follows its screenshot on the same page`);
  }
});

test('Word code blocks are padded and tables span the text width with a shaded header', (t) => {
  const root = tmp(t, 'docx-polish');
  const store = new GuideStore(path.join(root, 'data'));
  const guide = store.createGuide({ title: 'Code' });
  store.addStep(guide.guideId, {
    kind: 'empty',
    title: 'Run it',
    codeBlocks: [{ id: 'c', language: 'bash', code: 'adminctl audit --user jdoe' }],
    tableBlocks: [{ id: 't', rows: [['Field', 'Expected'], ['Action', 'reset']] }],
  });
  const doc = unzipSync(fs.readFileSync(exportDocx(buildRenderAst(store, guide.guideId), path.join(root, 'out')).file))
    .find((e) => e.name === 'word/document.xml').data.toString('utf8');
  const code = doc.match(/<w:p><w:pPr>((?:(?!<\/w:pPr>)[^])*)<\/w:pPr>(?:(?!<\/w:p>)[^])*adminctl/)[1];
  assert.match(code, /<w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="([0-9A-F]{6})"\/>[^]*<\/w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="\1"\/>/, 'borders in the fill color pad the box');
  assert.match(code, /<w:ind w:left="140" w:right="140"\/>/);
  assert.match(doc, /<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"\/>/, 'full width');
  assert.match(doc, /<w:tcW w:w="2500" w:type="pct"\/><w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"\/><\/w:tcPr>[^]*?Field/, 'shaded header row');
});

test('HTML: callouts after a step title sit in the step body, and step heads align to the top', (t) => {
  const root = tmp(t, 'html-polish');
  const store = new GuideStore(path.join(root, 'data'));
  const guide = store.createGuide({ title: 'HTML' });
  store.addStep(guide.guideId, {
    kind: 'empty',
    title: 'A step',
    descriptionHtml: '<p>Body.</p>',
    textBlocks: [{ position: 'after-title', level: 'info', title: 'First', descriptionHtml: '<p>After the title.</p>' }],
  });
  const html = fs.readFileSync(exportHtmlRich(buildRenderAst(store, guide.guideId), path.join(root, 'out')).file, 'utf8');
  assert.match(html, /<div class="step-body">\s*<aside class="callout callout-info"[^>]*>[^]*?After the title\.[^]*?Body\./);
  assert.match(html, /\.step-head \{ display: flex; align-items: flex-start;/);
});
