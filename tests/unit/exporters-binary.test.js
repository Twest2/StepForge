'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const { GuideStore } = require('../../core/store');
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

/** Inflate each page's content stream, in page order, for op-level assertions. */
function pageContents(buf) {
  const text = buf.toString('latin1');
  const out = [];
  const re = /\d+ 0 obj\n<< \/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const len = Number(m[1]);
    const start = m.index + m[0].length;
    out.push(zlib.inflateSync(buf.subarray(start, start + len)).toString('latin1'));
  }
  return out;
}

/** Map each step bookmark's title to the 0-based page index it lands on. */
function bookmarkPages(buf) {
  const text = buf.toString('latin1');
  const kids = [...text.match(/\/Type \/Pages \/Kids \[([^\]]+)\]/)[1].matchAll(/(\d+) 0 R/g)]
    .map((m) => Number(m[1]));
  const pageIndexOf = new Map(kids.map((id, i) => [id, i]));
  const out = [];
  for (const m of text.matchAll(/\/Title \(([^)]*)\)([^>]*)/g)) {
    const dest = /\/Dest \[(\d+) 0 R/.exec(m[2]);
    if (dest) out.push({ title: m[1], pageIndex: pageIndexOf.get(Number(dest[1])) });
  }
  return out;
}

/** Resolve each Link annotation's `/Dest` on the page at `pageIndex` to a 0-based page index. */
function tocLinkTargets(buf, pageIndex) {
  const text = buf.toString('latin1');
  const kids = [...text.match(/\/Type \/Pages \/Kids \[([^\]]+)\]/)[1].matchAll(/(\d+) 0 R/g)]
    .map((m) => Number(m[1]));
  const pageIndexOf = new Map(kids.map((id, i) => [id, i]));
  const objBody = (id) => new RegExp(`(?:^|\\n)${id} 0 obj\\n([\\s\\S]*?)\\nendobj`).exec(text)[1];

  const annots = /\/Annots \[([^\]]+)\]/.exec(objBody(kids[pageIndex]));
  if (!annots) return [];
  return [...annots[1].matchAll(/(\d+) 0 R/g)].map((m) => {
    const body = objBody(Number(m[1]));
    assert.match(body, /\/Subtype \/Link/);
    const dest = /\/Dest \[(\d+) 0 R/.exec(body);
    return pageIndexOf.get(Number(dest[1]));
  });
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

test('PDF Contents: each entry is a clickable link to its step\'s page', (t) => {
  const { ast, root } = fixtureAst(t, 'pdftoc');
  const buf = fs.readFileSync(exportPdf(ast, path.join(root, 'out')).file);

  const bookmarks = bookmarkPages(buf); // one per step, in document order
  const tocTargets = tocLinkTargets(buf, 1); // page 0 = cover, page 1 = Contents
  const tocPage = pageContents(buf)[1];
  const blueTocLines = [...tocPage.matchAll(/BT \/F1 10\.5 Tf 0\.145 0\.388 0\.922 rg 1 0 0 1 [\d.]+ [\d.]+ Tm \(([^)]*)\) Tj ET/g)]
    .map((m) => m[1]);

  assert.deepEqual(tocTargets, bookmarks.map((b) => b.pageIndex));
  assert.deepEqual(blueTocLines, ast.steps.map((step) => `${step.number}. ${step.title || 'Untitled step'}`));
});

test('PDF renders under Ghostscript end-to-end', { skip: !hasTool('gs') }, (t) => {
  const { ast, root } = fixtureAst(t, 'pdfgs');
  const { file, pageCount } = exportPdf(ast, path.join(root, 'out'));
  const out = execFileSync('gs', ['-dBATCH', '-dNOPAUSE', '-sDEVICE=nullpage', file], { stdio: 'pipe' }).toString();
  assert.match(out, new RegExp(`Processing pages 1 through ${pageCount}`));
});

test('PDF cover: title in big text above the accent rule, guide metadata below it', (t) => {
  const root = makeTmpDir('pdfcover');
  t.after(() => rmrf(root));
  const { store, guide: bare } = buildFixtureGuide(path.join(root, 'data'));

  // No metadata set: cover has no Author/Co-authors/Organization lines.
  const astNoMeta = buildRenderAst(store, bare.guideId);
  const { file: fileNoMeta } = exportPdf(astNoMeta, path.join(root, 'out1'));
  const coverNoMeta = pageContents(fs.readFileSync(fileNoMeta))[0];
  assert.ok(!coverNoMeta.includes('Author:'));
  assert.ok(!coverNoMeta.includes('Co-authors:'));
  assert.ok(!coverNoMeta.includes('Organization:'));

  // Set guide metadata, then re-export.
  const guide = store.getGuide(bare.guideId);
  guide.metadata = { author: 'Jane Doe', coAuthors: 'Alex Lee', organization: 'Acme Corp' };
  store.saveGuide(guide);
  const ast = buildRenderAst(store, guide.guideId);
  const { file } = exportPdf(ast, path.join(root, 'out2'));
  const cover = pageContents(fs.readFileSync(file))[0];

  assert.ok(cover.includes('Author: Jane Doe'));
  assert.ok(cover.includes('Co-authors: Alex Lee'));
  assert.ok(cover.includes('Organization: Acme Corp'));

  // Title (28pt, F2) sits above the accent rule (a 3pt-tall filled rect),
  // which sits above the metadata lines (11pt, F1). PDF y increases
  // upward, so items higher on the page have larger y values.
  const titleY = Number(/\/F2 28 Tf [\d.]+ [\d.]+ [\d.]+ rg 1 0 0 1 [\d.]+ ([\d.]+) Tm \(Configure AcmeSync backups\) Tj/.exec(cover)[1]);
  const ruleY = Number(/[\d.]+ [\d.]+ [\d.]+ rg ([\d.]+) ([\d.]+) [\d.]+ 3\.00 re f/.exec(cover)[2]);
  const authorY = Number(/\/F1 11 Tf [\d.]+ [\d.]+ [\d.]+ rg 1 0 0 1 [\d.]+ ([\d.]+) Tm \(Author: Jane Doe\) Tj/.exec(cover)[1]);
  assert.ok(titleY > 740, 'title starts near the top edge');
  assert.ok(titleY > ruleY, 'title sits above the accent rule');
  assert.ok(ruleY > authorY, 'metadata sits below the accent rule');
});

test('PDF pagination: short steps pack onto a page; a step that does not fit moves to a fresh page', (t) => {
  const root = makeTmpDir('pdfpage');
  t.after(() => rmrf(root));
  const store = new GuideStore(path.join(root, 'data'));
  const guide = store.createGuide({ title: 'Pagination test' });
  const filler = (n) => `<p>${'Lorem ipsum dolor sit amet consectetur. '.repeat(n)}</p>`;
  store.addStep(guide.guideId, { kind: 'empty', title: 'Step A', descriptionHtml: '<p>Short content A.</p>' });
  store.addStep(guide.guideId, { kind: 'empty', title: 'Step B', descriptionHtml: '<p>Short content B.</p>' });
  // Doesn't fit in what's left of page 1, but fits comfortably on its own
  // page — with enough room left for step D to pack onto that same page.
  store.addStep(guide.guideId, { kind: 'empty', title: 'Step C', descriptionHtml: filler(95) });
  store.addStep(guide.guideId, { kind: 'empty', title: 'Step D', descriptionHtml: '<p>Short content D.</p>' });
  const ast = buildRenderAst(store, guide.guideId);
  const { file, pageCount } = exportPdf(ast, path.join(root, 'out'), { includeCover: false, includeToc: false });
  const pages = bookmarkPages(fs.readFileSync(file));

  assert.deepEqual(pages.map((p) => p.pageIndex), [0, 0, 1, 1]);
  assert.equal(pageCount, 2);
});

test('PDF pagination: a step longer than one page starts fresh and overflows; the next step starts on a new page', (t) => {
  const root = makeTmpDir('pdfpage2');
  t.after(() => rmrf(root));
  const store = new GuideStore(path.join(root, 'data'));
  const guide = store.createGuide({ title: 'Pagination overflow test' });
  const filler = (n) => `<p>${'Lorem ipsum dolor sit amet consectetur. '.repeat(n)}</p>`;
  store.addStep(guide.guideId, { kind: 'empty', title: 'Step A', descriptionHtml: '<p>Short content A.</p>' });
  store.addStep(guide.guideId, { kind: 'empty', title: 'Step B', descriptionHtml: '<p>Short content B.</p>' });
  // Longer than a full page: starts on its own page and overflows onto the next.
  store.addStep(guide.guideId, { kind: 'empty', title: 'Step C', descriptionHtml: filler(120) });
  store.addStep(guide.guideId, { kind: 'empty', title: 'Step D', descriptionHtml: '<p>Short content D.</p>' });
  const ast = buildRenderAst(store, guide.guideId);
  const { file, pageCount } = exportPdf(ast, path.join(root, 'out'), { includeCover: false, includeToc: false });
  const pages = bookmarkPages(fs.readFileSync(file));

  // A and B pack onto page 0; C starts fresh on page 1 and overflows onto
  // page 2; D is forced onto a fresh page 3 rather than sharing C's spillover.
  assert.deepEqual(pages.map((p) => p.pageIndex), [0, 0, 1, 3]);
  assert.equal(pageCount, 4);
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
  for (const required of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/settings.xml', 'word/styles.xml']) {
    assert.ok(entries.has(required), `missing ${required}`);
  }
  assertWellFormedXml(entries.get('word/document.xml').toString('utf8'), 'document.xml');
  assertWellFormedXml(entries.get('[Content_Types].xml').toString('utf8'), 'content types');
  assertWellFormedXml(entries.get('word/settings.xml').toString('utf8'), 'settings.xml');
  assertWellFormedXml(entries.get('word/styles.xml').toString('utf8'), 'styles.xml');

  // Every relationship target exists in the package, every embed has a rel.
  const relsXml = entries.get('word/_rels/document.xml.rels').toString('utf8');
  const relTargets = [...relsXml.matchAll(/Target="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(relTargets.length, 8);
  assert.ok(relTargets.includes('settings.xml'));
  assert.ok(relTargets.includes('styles.xml'));

  const mediaTargets = relTargets.filter((target) => target.startsWith('media/'));
  assert.equal(mediaTargets.length, 6);
  const iconTargets = mediaTargets.filter((target) => target.includes('callout-'));
  const imageTargets = mediaTargets.filter((target) => target.includes('image'));
  assert.equal(iconTargets.length, 4);
  assert.equal(imageTargets.length, 2);

  for (const target of iconTargets) {
    assert.ok(entries.has(`word/${target}`), `relationship target ${target} present`);
    const img = decodePng(entries.get(`word/${target}`));
    assert.equal(img.width, 24);
  }
  for (const target of imageTargets) {
    assert.ok(entries.has(`word/${target}`), `relationship target ${target} present`);
    const img = decodePng(entries.get(`word/${target}`));
    assert.equal(img.width, 320);
  }
  const docXml = entries.get('word/document.xml').toString('utf8');
  const embeds = [...docXml.matchAll(/r:embed="(rId\d+)"/g)].map((m) => m[1]);
  const relIds = [...relsXml.matchAll(/Id="(rId\d+)"/g)].map((m) => m[1]).filter((id) => id !== 'rId1');
  for (const id of embeds) {
    assert.ok(relIds.includes(id), `missing relationship for ${id}`);
  }
  assert.ok(docXml.includes('TOC \\o &quot;1-3&quot; \\h \\z \\u'));
  assert.ok(docXml.includes('w:pStyle w:val="Heading1"'));
  assert.ok(docXml.includes('w:pStyle w:val="Heading2"'));
  assert.ok(docXml.includes('w:outlineLvl w:val="0"'));
  assert.ok(docXml.includes('w:outlineLvl w:val="1"'));

  const stylesXml = entries.get('word/styles.xml').toString('utf8');
  assert.ok(stylesXml.includes('w:style w:type="paragraph" w:styleId="Heading1"'));
  assert.ok(stylesXml.includes('w:style w:type="paragraph" w:styleId="Heading2"'));
  assert.ok(stylesXml.includes('w:style w:type="paragraph" w:styleId="Heading3"'));

  // unzip CLI also accepts the package (it is a plain zip).
  assert.ok(entries.size >= 6);
});

test('PPTX export: slides per step, master/layout/theme present, rels resolve', (t) => {
  const { ast, root } = fixtureAst(t, 'pptx');
  const { file, slideCount, imageCount } = exportPptx(ast, path.join(root, 'out'));

  assert.equal(slideCount, 5, 'title slide + contents slide + 3 steps');
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
  assert.ok(entries.get('ppt/slides/slide2.xml').toString('utf8').includes('Contents'));
  // image rels on slides resolve to media files.
  for (let i = 1; i <= slideCount; i++) {
    const rels = entries.get(`ppt/slides/_rels/slide${i}.xml.rels`).toString('utf8');
    for (const m of rels.matchAll(/Target="\.\.\/media\/([^"]+)"/g)) {
      assert.ok(entries.has(`ppt/media/${m[1]}`), `media ${m[1]} present`);
    }
  }
});

test('PPTX export: TOC paginates onto additional slides before it would overflow', (t) => {
  const root = makeTmpDir('pptxtoc');
  t.after(() => rmrf(root));
  const store = new GuideStore(path.join(root, 'data'));
  const guide = store.createGuide({ title: 'Large TOC test' });

  for (let i = 1; i <= 40; i++) {
    store.addStep(guide.guideId, { kind: 'empty', title: `Step ${i}` });
  }

  const ast = buildRenderAst(store, guide.guideId);
  const { file, slideCount } = exportPptx(ast, path.join(root, 'out'));
  const entries = new Map(unzipSync(fs.readFileSync(file)).map((e) => [e.name, e.data]));
  const slideXmls = Array.from({ length: slideCount }, (_, i) => entries.get(`ppt/slides/slide${i + 1}.xml`).toString('utf8'));
  const tocSlides = slideXmls.filter((xml) => xml.includes('Contents'));

  assert.ok(tocSlides.length >= 2, 'large TOC should span multiple slides');
  assert.ok(tocSlides[0].includes('1. Step 1'));
  assert.ok(!tocSlides[0].includes('40. Step 40'));
  assert.ok(tocSlides.at(-1).includes('40. Step 40'));
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

  assert.equal(Object.keys(EXPORTERS).length, 11, 'all eleven formats wired');
  assert.throws(() => runExport('exe', ast, path.join(root, 'out3')));
});
