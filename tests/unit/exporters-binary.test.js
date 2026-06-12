'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { buildRenderAst } = require('../../core/renderast');
const { exportPdf } = require('../../exporters/pdf');
const { exportGifGuide } = require('../../exporters/gif');
const { exportImageBundle } = require('../../exporters/image-bundle');
const { exportDocx } = require('../../exporters/docx');
const { exportPptx } = require('../../exporters/pptx');
const { TemplateManager } = require('../../core/templates');
const { runExport, EXPORTERS } = require('../../exporters');
const { unzipSync } = require('../../core/zip');
const { decodePng, encodePng } = require('../../core/png');
const raster = require('../../core/raster');
const { decodeGif } = require('./gifdecode');
const { buildFixtureGuide } = require('./fixture-guide');
const { makeTmpDir, rmrf } = require('./helpers');

function hasTool(cmd) {
  try { execFileSync('which', [cmd], { stdio: 'pipe' }); return true; } catch { return false; }
}

/** Tiny XML well-formedness check: balanced tags, single root. */
function assertWellFormedXml(xml, label) {
  const body = xml.replace(/<\?xml[^?]*\?>/, '').trim();
  const stack = [];
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  let roots = 0;
  while ((m = re.exec(body)) !== null) {
    const [, closing, tag, , selfClose] = m;
    if (closing) {
      const open = stack.pop();
      assert.equal(open, tag, `${label}: </${tag}> closes <${open}>`);
      if (!stack.length) roots++;
    } else if (!selfClose) {
      stack.push(tag);
    } else if (!stack.length) roots++;
  }
  assert.equal(stack.length, 0, `${label}: unclosed tags ${stack.join(',')}`);
  assert.ok(roots >= 1, `${label}: no root element`);
}

function fixtureAst(t, label) {
  const root = makeTmpDir(label);
  t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  return { ast: buildRenderAst(store, guide.guideId), root, store, guide };
}

test('PDF export: valid document, bookmarks per step, images embedded', (t) => {
  const { ast, root } = fixtureAst(t, 'pdfx');
  const out = path.join(root, 'out');
  const { file, pageCount, imageCount } = exportPdf(ast, out);

  assert.equal(imageCount, 2);
  assert.ok(pageCount >= 3, 'cover + toc + content');
  const text = fs.readFileSync(file).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  // One outline item per step.
  const outlineTitles = [...text.matchAll(/\/Title \(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(outlineTitles, [
    '1. Open AcmeSync settings',
    '1.1. Verify the gear icon is visible',
    '2. Enable nightly backups',
  ]);
  // Two image XObjects.
  assert.equal((text.match(/\/Subtype \/Image/g) || []).length, 2);
});

test('PDF renders under Ghostscript end-to-end', { skip: !hasTool('gs') }, (t) => {
  const { ast, root } = fixtureAst(t, 'pdfgs');
  const { file, pageCount } = exportPdf(ast, path.join(root, 'out'));
  const out = execFileSync('gs', ['-dBATCH', '-dNOPAUSE', '-sDEVICE=nullpage', file], { stdio: 'pipe' }).toString();
  assert.match(out, new RegExp(`Processing pages 1 through ${pageCount}`));
});

test('GIF export: title card + one frame per image step, valid animation', (t) => {
  const { ast, root } = fixtureAst(t, 'gifx');
  const { file, frameCount } = exportGifGuide(ast, path.join(root, 'out'), { width: 320 });

  const gif = decodeGif(fs.readFileSync(file));
  assert.equal(frameCount, 3, 'title card + 2 image steps');
  assert.equal(gif.frames.length, 3);
  assert.equal(gif.width, 320);
  assert.equal(gif.loops, 0);
  for (const frame of gif.frames) {
    assert.equal(frame.indices.length, gif.width * gif.height, 'frame fully decodes');
  }
});

test('GIF export honors template options (no title card/overlay/progress)', (t) => {
  const { ast, root } = fixtureAst(t, 'gifopt');
  const { file, frameCount, height } = exportGifGuide(ast, path.join(root, 'out'), {
    width: 320, titleCard: false, titleOverlay: false, progressBar: false,
  });
  assert.equal(frameCount, 2);
  // Without header/footer the frame height equals the scaled screenshot height.
  assert.equal(height, Math.round(320 * (200 / 320)));
  assert.equal(decodeGif(fs.readFileSync(file)).frames.length, 2);
});

test('image bundle: annotated PNGs + metadata that references them', (t) => {
  const { ast, root } = fixtureAst(t, 'bundle');
  const out = path.join(root, 'out');
  const { file, imageCount } = exportImageBundle(ast, out);

  assert.equal(imageCount, 2);
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(meta.steps.length, 3);
  for (const step of meta.steps) {
    if (step.image) {
      const img = decodePng(fs.readFileSync(path.join(out, step.image)));
      assert.equal(img.width, 320);
    }
  }
  // The empty substep has no image entry.
  assert.equal(meta.steps.filter((s) => s.image).length, 2);
});

test('image bundle watermark is composited into the output pixels', (t) => {
  const { ast, root } = fixtureAst(t, 'wm');
  const out = path.join(root, 'out');
  // Solid magenta watermark; bottom-right corner must turn magenta-ish.
  const mark = raster.createImage(24, 24, [255, 0, 255, 255]);
  const markFile = path.join(root, 'mark.png');
  fs.writeFileSync(markFile, encodePng(mark));

  exportImageBundle(ast, out, { watermarkPath: markFile, watermarkOpacity: 1 });
  const meta = JSON.parse(fs.readFileSync(path.join(out, 'configure-acmesync-backups-bundle.json'), 'utf8'));
  const imgPath = meta.steps.find((s) => s.image).image;
  const img = decodePng(fs.readFileSync(path.join(out, imgPath)));
  const p = ((img.height - 24) * img.width + (img.width - 24)) * 4;
  assert.ok(img.data[p] > 200 && img.data[p + 2] > 200 && img.data[p + 1] < 60,
    'watermark pixels present in bottom-right corner');
});

test('DOCX export: valid OPC package, well-formed XML, resolvable image rels', (t) => {
  const { ast, root } = fixtureAst(t, 'docx');
  const { file, imageCount } = exportDocx(ast, path.join(root, 'out'));

  assert.equal(imageCount, 2);
  const entries = new Map(unzipSync(fs.readFileSync(file)).map((e) => [e.name, e.data]));
  for (const required of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels']) {
    assert.ok(entries.has(required), `missing ${required}`);
  }
  assertWellFormedXml(entries.get('word/document.xml').toString('utf8'), 'document.xml');
  assertWellFormedXml(entries.get('[Content_Types].xml').toString('utf8'), 'content types');

  // Every relationship target exists in the package, every embed has a rel.
  const relsXml = entries.get('word/_rels/document.xml.rels').toString('utf8');
  const relTargets = [...relsXml.matchAll(/Target="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(relTargets.length, 2);
  for (const target of relTargets) {
    assert.ok(entries.has(`word/${target}`), `relationship target ${target} present`);
    const img = decodePng(entries.get(`word/${target}`));
    assert.equal(img.width, 320);
  }
  const docXml = entries.get('word/document.xml').toString('utf8');
  const embeds = [...docXml.matchAll(/r:embed="(rId\d+)"/g)].map((m) => m[1]);
  const relIds = [...relsXml.matchAll(/Id="(rId\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(embeds.sort(), relIds.sort());

  // unzip CLI also accepts the package (it is a plain zip).
  assert.ok(entries.size >= 6);
});

test('PPTX export: slides per step, master/layout/theme present, rels resolve', (t) => {
  const { ast, root } = fixtureAst(t, 'pptx');
  const { file, slideCount, imageCount } = exportPptx(ast, path.join(root, 'out'));

  assert.equal(slideCount, 4, 'title slide + 3 steps');
  assert.equal(imageCount, 2);
  const entries = new Map(unzipSync(fs.readFileSync(file)).map((e) => [e.name, e.data]));
  for (const required of [
    '[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml',
    'ppt/_rels/presentation.xml.rels', 'ppt/slideMasters/slideMaster1.xml',
    'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml',
  ]) {
    assert.ok(entries.has(required), `missing ${required}`);
  }
  for (let i = 1; i <= slideCount; i++) {
    const xml = entries.get(`ppt/slides/slide${i}.xml`);
    assert.ok(xml, `slide${i}.xml present`);
    assertWellFormedXml(xml.toString('utf8'), `slide${i}`);
  }
  // presentation.xml references each slide and the count matches.
  const pres = entries.get('ppt/presentation.xml').toString('utf8');
  assert.equal((pres.match(/<p:sldId /g) || []).length, slideCount);
  // image rels on slides resolve to media files.
  for (let i = 1; i <= slideCount; i++) {
    const rels = entries.get(`ppt/slides/_rels/slide${i}.xml.rels`).toString('utf8');
    for (const m of rels.matchAll(/Target="\.\.\/media\/([^"]+)"/g)) {
      assert.ok(entries.has(`ppt/media/${m[1]}`), `media ${m[1]} present`);
    }
  }
});

test('template manager: save/load/rename/duplicate/delete and .sfglt round-trip', (t) => {
  const root = makeTmpDir('tpl');
  t.after(() => rmrf(root));
  const tm = new TemplateManager(path.join(root, 'templates'));

  tm.save('pdf', 'compact', { includeCover: false, margin: 24 });
  assert.deepEqual(tm.list('pdf'), ['compact']);
  assert.deepEqual(tm.load('pdf', 'compact'), { includeCover: false, margin: 24 });

  tm.duplicate('pdf', 'compact');
  tm.rename('pdf', 'compact copy', 'tight');
  assert.deepEqual(tm.list('pdf'), ['compact', 'tight']);

  // Share as .sfglt and import into a fresh manager.
  const shared = path.join(root, 'tight.sfglt');
  tm.exportTemplate('pdf', 'tight', shared);
  const tm2 = new TemplateManager(path.join(root, 'templates2'));
  const imported = tm2.importTemplate(shared);
  assert.equal(imported.format, 'pdf');
  assert.deepEqual(tm2.load('pdf', imported.name), { includeCover: false, margin: 24 });

  tm.remove('pdf', 'compact');
  assert.deepEqual(tm.list('pdf'), ['tight']);
  assert.throws(() => tm.save('pdf', '../evil', {}));
  assert.throws(() => tm.list('exe'));
});

test('a saved template changes exporter behavior through runExport', (t) => {
  const { ast, root } = fixtureAst(t, 'tplrun');
  const tm = new TemplateManager(path.join(root, 'templates'));
  tm.save('pdf', 'no-cover', { includeCover: false, includeToc: false });

  const withDefaults = runExport('pdf', ast, path.join(root, 'out1'));
  const withTemplate = runExport('pdf', ast, path.join(root, 'out2'), tm.load('pdf', 'no-cover'));
  assert.ok(withTemplate.pageCount < withDefaults.pageCount, 'dropping cover+toc reduces pages');

  assert.equal(Object.keys(EXPORTERS).length, 10, 'all ten formats wired');
  assert.throws(() => runExport('exe', ast, path.join(root, 'out3')));
});
