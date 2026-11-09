'use strict';

// Brand profile screenshot options: alignment, border and side-by-side steps
// in PDF, Word and HTML. Off by default, so exports stay as they were.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { BrandingStore, normalizeProfile } = require('../../core/branding');
const { GuideStore } = require('../../core/store');
const { buildRenderAst } = require('../../core/renderast');
const { exportPdf } = require('../../exporters/pdf');
const { exportDocx } = require('../../exporters/docx');
const { exportHtmlSimple, exportHtmlRich } = require('../../exporters/html');
const { unzipSync } = require('../../core/zip');
const { encodePng } = require('../../core/png');
const raster = require('../../core/raster');
const { createBrandTools } = require('../../core/agent-brand-tools');
const { makeTmpDir, rmrf } = require('./helpers');

const NOW = new Date(Date.UTC(2026, 10, 9, 12));

/**
 * A guide whose first step has a description and a tall screenshot (so PDF
 * shows it narrower than the page), the second only a screenshot, and the
 * third a description, a screenshot and callouts placed before the image and
 * after the description. Returns render ASTs for the given screenshot options
 * and for no branding.
 */
function fixture(t, screenshots) {
  const root = makeTmpDir('brand-shots');
  t.after(() => rmrf(root));
  const store = new GuideStore(path.join(root, 'data'));
  const guide = store.createGuide({ title: 'Reset a password' });
  const tall = raster.createImage(200, 600, [40, 90, 160, 255]);
  store.addStep(guide.guideId, { title: 'Open Settings', descriptionHtml: '<p>Click the gear icon in the corner.</p>' },
    encodePng(tall), { width: 200, height: 600 }, { position: 0 });
  const wide = raster.createImage(320, 200, [200, 120, 40, 255]);
  store.addStep(guide.guideId, { title: 'Save' }, encodePng(wide), { width: 320, height: 200 }, { position: 1 });
  store.addStep(guide.guideId, {
    title: 'Confirm',
    descriptionHtml: '<p>Choose Confirm.</p>',
    textBlocks: [
      { position: 'after-description', level: 'warn', title: 'Check who is asking', descriptionHtml: '<p>Verify identity.</p>' },
      { position: 'before-image', level: 'info', title: 'Look here', descriptionHtml: '<p>The button is at the bottom.</p>' },
    ],
  }, encodePng(wide), { width: 320, height: 200 }, { position: 2 });
  const brands = new BrandingStore(path.join(root, 'settings'));
  const profile = brands.save({ name: 'Acme', screenshots });
  return {
    root,
    ast: buildRenderAst(store, guide.guideId, { now: NOW, branding: brands.resolve(profile.id) }),
    plain: buildRenderAst(store, guide.guideId, { now: NOW }),
  };
}

function pdfPages(file) {
  const buf = fs.readFileSync(file);
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

/** Every image drawn on the PDF's pages: { x, y, w, h } in points. */
function pdfImages(file) {
  return pdfPages(file).flatMap((page) => [...page.matchAll(/q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/Im\d+ Do Q/g)]
    .map((m) => ({ w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]) })));
}

const docxXml = (file) => unzipSync(fs.readFileSync(file)).find((e) => e.name === 'word/document.xml').data.toString('utf8');

test('screenshot options: off by default, and invalid values fall back to the defaults', () => {
  assert.deepEqual(normalizeProfile({}).screenshots, { align: 'left', border: false, borderColor: '#D0D5DD', layout: 'stacked' });
  assert.deepEqual(normalizeProfile({ screenshots: { align: 'middle', border: 'yes', borderColor: 'red', layout: 'grid' } }).screenshots,
    { align: 'left', border: false, borderColor: '#D0D5DD', layout: 'stacked' });
  assert.deepEqual(normalizeProfile({ screenshots: { align: 'center', border: true, borderColor: '#173f7a', layout: 'side-by-side' } }).screenshots,
    { align: 'center', border: true, borderColor: '#173F7A', layout: 'side-by-side' });
});

test('screenshot options: a profile with the defaults exports exactly what no options did', (t) => {
  const { root, ast } = fixture(t, undefined);
  const { ast: explicit } = fixture(t, { align: 'left', border: false, layout: 'stacked' });
  const pdfA = pdfPages(exportPdf(ast, path.join(root, 'a')).file);
  const pdfB = pdfPages(exportPdf(explicit, path.join(root, 'b')).file);
  assert.deepEqual(pdfA, pdfB);
  const doc = docxXml(exportDocx(ast, path.join(root, 'docx')).file);
  assert.ok(!doc.includes('<w:jc w:val="center"/>') && !doc.includes('<a:ln '), 'no alignment or border');
  const html = fs.readFileSync(exportHtmlSimple(ast, path.join(root, 'html')).file, 'utf8');
  assert.ok(!html.includes('step-split') && !html.includes('.shot img { margin-left') && !html.includes('.shot img { border:'));
});

test('PDF: screenshots narrower than the page sit left, centered or right, with an optional border', (t) => {
  const x = {};
  for (const align of ['left', 'center', 'right']) {
    const { root, ast } = fixture(t, { align, border: align === 'center', borderColor: '#173F7A' });
    const file = exportPdf(ast, path.join(root, align)).file;
    const shot = pdfImages(file)[0];
    x[align] = shot.x;
    if (align === 'center') {
      const page = pdfPages(file).find((p) => p.includes(`${shot.x.toFixed(2)} ${shot.y.toFixed(2)} cm`));
      assert.ok(page.includes(`0.090 0.247 0.478 RG 0.75 w ${shot.x.toFixed(2)} ${shot.y.toFixed(2)} ${shot.w.toFixed(2)} ${shot.h.toFixed(2)} re S`),
        'a border in the chosen color around the screenshot');
    }
  }
  const usable = 595.28 - 2 * x.left; // left-aligned starts at the margin
  const plain = fixture(t, {});
  const shotW = pdfImages(exportPdf(plain.ast, path.join(plain.root, 'w')).file)[0].w;
  assert.ok(shotW < usable - 100, 'the tall screenshot is narrower than the page');
  assert.ok(Math.abs(x.center - (x.left + (usable - shotW) / 2)) < 0.1, `centered (${x.left}, ${x.center})`);
  assert.ok(Math.abs(x.right - (x.left + usable - shotW)) < 0.1, `right (${x.right})`);
});

test('PDF: side by side puts the screenshot left and the description right, top-aligned', (t) => {
  const { root, ast } = fixture(t, { layout: 'side-by-side' });
  const file = exportPdf(ast, path.join(root, 'pdf')).file;
  const [first, second] = pdfImages(file);
  const usable = 595.28 - 2 * first.x;
  assert.ok(first.w <= Math.round(usable * 0.55) + 0.01, 'the screenshot fits its column');
  const page = pdfPages(file).find((p) => p.includes('(gear)'));
  const desc = page.match(/1 0 0 1 ([\d.]+) ([\d.]+) Tm [^\n]*?\(Click\) Tj/);
  assert.ok(desc && page.includes('/Im1 Do'), 'the description is on the screenshot’s page');
  assert.ok(Math.abs(Number(desc[1]) - (first.x + Math.round(usable * 0.55) + 16)) < 0.1, 'in the right-hand column');
  assert.ok(Number(desc[1]) > first.x + first.w, 'the description starts right of the screenshot');
  const descTop = Number(desc[2]) + 10.5;
  assert.ok(Math.abs(descTop - (first.y + first.h)) < 12, 'the description starts level with the screenshot');
  assert.ok(Math.abs(second.w - usable) < 0.1, 'a step without a description stays stacked, full width');

  // Third step: "Look here" above the screenshot in the left column, the
  // warning under the description in the right column.
  const third = pdfImages(file)[2];
  const thirdPage = pdfPages(file).find((p) => p.includes('(Confirm.)'));
  const at = (label) => thirdPage.match(new RegExp(`1 0 0 1 ([\\d.]+) ([\\d.]+) Tm [^\\n]*?\\(${label}`));
  const look = at('Note: Look'), confirm = at('Choose'), warn = at('Warning');
  assert.ok(look && confirm && warn, 'all three on the step’s page');
  assert.ok(Number(look[1]) < third.x + third.w && Number(look[2]) > third.y + third.h, 'the before-image callout is above the screenshot, in its column');
  assert.ok(Number(warn[1]) > third.x + third.w && Number(warn[2]) < Number(confirm[2]), 'the after-description callout is under the description, in the text column');
});

test('Word: alignment, a picture border and a two-column table for side by side', (t) => {
  const { root, ast } = fixture(t, { align: 'center', border: true, borderColor: '#173F7A', layout: 'side-by-side' });
  const doc = docxXml(exportDocx(ast, path.join(root, 'docx')).file);
  assert.equal((doc.match(/<a:ln w="9525"><a:solidFill><a:srgbClr val="173F7A"\/><\/a:solidFill><\/a:ln>/g) || []).length, 3, 'every screenshot bordered');
  const split = doc.match(/<w:tbl><w:tblPr><w:tblW w:w="9638" w:type="dxa"\/>[\s\S]*?<\/w:tbl>/);
  assert.ok(split, 'side-by-side table');
  const [left, right] = [...split[0].matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((m) => m[1]);
  assert.match(left, /<w:drawing>/);
  assert.match(right, /Click the gear icon/);
  assert.match(split[0], /<w:tblBorders>(<w:\w+ w:val="nil"\/>){6}<\/w:tblBorders>/, 'no table borders');
  assert.equal((doc.match(/<w:tbl>/g) || []).length, 2, 'the step without a description stays stacked');
  const [, third] = doc.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g);
  const [media, text] = [...third.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((m) => m[1]);
  assert.ok(media.indexOf('Look here') < media.indexOf('<w:drawing>'), 'a before-image callout sits above the screenshot');
  assert.ok(text.indexOf('Choose Confirm') < text.indexOf('Check who is asking'), 'an after-description callout sits under the description');
  assert.match(doc, /<w:pPr><w:jc w:val="center"\/><\/w:pPr><w:r><w:drawing>/, 'stacked screenshot centered');

  const right2 = docxXml(exportDocx(fixture(t, { align: 'right' }).ast, path.join(root, 'right')).file);
  assert.match(right2, /<w:jc w:val="right"\/><\/w:pPr><w:r><w:drawing>/);
});

test('HTML: alignment and border CSS, and a responsive two-column step', (t) => {
  const { root, ast, plain } = fixture(t, { align: 'right', border: true, borderColor: '#173F7A', layout: 'side-by-side' });
  for (const exporter of [exportHtmlSimple, exportHtmlRich]) {
    const html = fs.readFileSync(exporter(ast, path.join(root, exporter.name)).file, 'utf8');
    assert.match(html, /\.shot \{ text-align: right; \}/, 'moves a linked flowchart’s inline-block wrapper too');
    assert.match(html, /\.shot img \{ margin-left: auto; margin-right: 0; \}/);
    assert.match(html, /\.shot img \{ border: 1px solid #173F7A; \}/);
    assert.match(html, /\.step-split \{ display: grid;/);
    assert.match(html, /@media \(max-width: 720px\) \{ \.step-split \{ grid-template-columns: minmax\(0, 1fr\); \} \}/);
    assert.match(html, /<div class="step-split"><div class="split-media"><figure class="shot"><img [^>]+><\/figure><\/div><div class="split-text"><div class="desc"><p>Click the gear icon/);
    assert.equal((html.match(/class="step-split"/g) || []).length, 2, 'only steps with a description are split');
    const third = html.slice(html.lastIndexOf('class="step-split"'));
    const media = third.slice(third.indexOf('split-media'), third.indexOf('split-text'));
    const text = third.slice(third.indexOf('split-text'));
    assert.ok(media.indexOf('Look here') >= 0 && media.indexOf('Look here') < media.indexOf('<figure'), 'a before-image callout sits above the screenshot');
    assert.ok(text.indexOf('Choose Confirm') < text.indexOf('Check who is asking'), 'an after-description callout sits under the description');
  }
  const unbranded = fs.readFileSync(exportHtmlSimple(plain, path.join(root, 'plain')).file, 'utf8');
  assert.ok(!unbranded.includes('step-split'));
});

test('AI agents can read and change the screenshot options', async (t) => {
  const root = makeTmpDir('brand-shots-agent');
  t.after(() => rmrf(root));
  class AgentError extends Error {}
  const tools = createBrandTools({
    settingsDir: root, requireEnabled: () => {}, agentSettings: () => ({ branding: true }), AgentError,
    text: (value) => ({ type: 'text', text: JSON.stringify(value) }),
  });
  const call = async (name, args) => JSON.parse((await tools.find((tool) => tool.name === name).handler(args)).content[0].text);
  const created = await call('create_brand_profile', { name: 'Acme', screenshots: { align: 'center', border: true, border_color: '#112233' } });
  assert.deepEqual(created.screenshots, { align: 'center', border: true, border_color: '#112233', layout: 'stacked' });
  const updated = await call('update_brand_profile', { profile_id: created.profile_id, screenshots: { layout: 'side-by-side' } });
  assert.deepEqual(updated.screenshots, { align: 'center', border: true, border_color: '#112233', layout: 'side-by-side' });
  await assert.rejects(call('update_brand_profile', { profile_id: created.profile_id, screenshots: { align: 'middle' } }), AgentError);
});
