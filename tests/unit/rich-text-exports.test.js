'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { GuideStore } = require('../../core/store');
const { buildRenderAst } = require('../../core/renderast');
const { exportDocx } = require('../../exporters/docx');
const { exportPptx } = require('../../exporters/pptx');
const { richParagraphs, sliceRuns, markedText } = require('../../exporters/pptx-text');
const { WordRichText } = require('../../exporters/word-rich');
const { unzipSync } = require('../../core/zip');
const { encodePng } = require('../../core/png');
const raster = require('../../core/raster');
const { makeTmpDir, rmrf } = require('./helpers');

const LONG = 'Check the account name and email carefully before you continue. The reset signs the user out of every device. '.repeat(30);

/** A guide whose steps use every kind of formatting a description can hold. */
function richGuide(t) {
  const root = makeTmpDir('rich-text');
  t.after(() => rmrf(root));
  const store = new GuideStore(path.join(root, 'data'));
  const guide = store.createGuide({ title: 'Rich text', descriptionHtml: '<p>For the <b>service desk</b>.</p>' });
  const png = encodePng(raster.createImage(640, 380, [240, 242, 245, 255]));
  const first = store.addStep(guide.guideId, {
    title: 'Open the Users page',
    descriptionHtml: '<p>Select <b>Users</b>. See the <a href="https://docs.example.com/users">Users guide</a> for <i>bulk</i> changes and <s>old</s> notes.</p>',
  }, png, { width: 640, height: 380 });
  store.addStep(guide.guideId, {
    title: 'Reset the password',
    descriptionHtml: `<p>Run <code>adminctl unlock</code> first:</p><ol><li>Pick <b>Email a link</b>.</li><li>Choose <b>Send</b>.</li></ol>`
      + `<ul><li>works anywhere</li></ul><blockquote>The old password stops working.</blockquote><p>Go back to <a href="step:${first.stepId}">the Users page</a>.</p>`,
    textBlocks: [{ position: 'after-description', level: 'success', title: 'Shortcut', descriptionHtml: '<p>Press <b>Ctrl+R</b>:</p><ul><li>works in <i>every</i> browser</li></ul>' }],
  }, png, { width: 640, height: 380 });
  store.addStep(guide.guideId, { kind: 'empty', title: 'A long one', descriptionHtml: `<p>Start with <b>${LONG}</b> and <i>${LONG}</i></p>` });
  return { root, ast: buildRenderAst(store, guide.guideId), firstId: first.stepId };
}

const unzip = (file) => new Map(unzipSync(fs.readFileSync(file)).map((e) => [e.name, e.data.toString('utf8')]));

test('Word keeps description formatting: bold, italic, strikethrough, code, links, real lists and quotes', (t) => {
  const { root, ast } = richGuide(t);
  const z = unzip(exportDocx(ast, path.join(root, 'docx')).file);
  const doc = z.get('word/document.xml');
  const rels = z.get('word/_rels/document.xml.rels');
  assert.match(doc, /<w:r><w:rPr><w:b\/><w:color w:val="1F2937"\/><w:sz w:val="20"\/><\/w:rPr><w:t xml:space="preserve">Users<\/w:t><\/w:r>/, 'bold');
  assert.match(doc, /<w:i\/>[^]*?<w:t xml:space="preserve">bulk<\/w:t>/, 'italic');
  assert.match(doc, /<w:strike\/>[^]*?<w:t xml:space="preserve">old<\/w:t>/, 'strikethrough');
  assert.match(doc, /<w:rFonts w:ascii="Courier New"[^>]*\/>[^]*?<w:t xml:space="preserve">adminctl unlock<\/w:t>/, 'inline code');
  // A web link is a hyperlink relationship; a link to a step goes to its heading's bookmark.
  const id = doc.match(/<w:hyperlink r:id="(rId\d+)"><w:r><w:rPr>[^]*?<w:u w:val="single"\/><\/w:rPr><w:t xml:space="preserve">Users guide<\/w:t>/)[1];
  assert.match(rels, new RegExp(`Id="${id}" Type="[^"]+/hyperlink" Target="https://docs.example.com/users" TargetMode="External"`));
  const anchor = doc.match(/<w:hyperlink w:anchor="([^"]+)">[^]*?the Users page/)[1];
  assert.match(doc, new RegExp(`<w:bookmarkStart w:id="\\d+" w:name="${anchor}"/>[^]*?Open the Users page`));
  // Real numbered and bulleted lists, with a numbering part.
  const items = [...doc.matchAll(/<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="(\d+)"\/><\/w:numPr>[^]*?<w:t xml:space="preserve">([^<]+)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(items.map(([, text]) => text), ['Pick ', 'Choose ', 'works anywhere']);
  assert.equal(items[0][0], items[1][0], 'one numbered list');
  assert.notEqual(items[1][0], items[2][0], 'then a separate bulleted one');
  const numbering = z.get('word/numbering.xml');
  assert.match(numbering, /<w:num w:numId="1"><w:abstractNumId w:val="1"\/>/);
  assert.match(numbering, /<w:numFmt w:val="bullet"\/><w:lvlText w:val="•"\/>/, 'a bullet any font has');
  assert.match(rels, /Type="[^"]+\/numbering" Target="numbering.xml"/);
  assert.match(z.get('[Content_Types].xml'), /PartName="\/word\/numbering.xml" ContentType="[^"]+numbering\+xml"/);
  assert.match(doc, /<w:i\/><w:color w:val="505F79"\/>[^]*?The old password stops working\./, 'quote');
  // The guide's description on the cover keeps its formatting too.
  assert.match(doc, /<w:b\/><w:color w:val="444444"\/><w:sz w:val="22"\/><\/w:rPr><w:t xml:space="preserve">service desk</);
});

test('Word callouts keep their formatting in one box, with lists as lines inside it', (t) => {
  const { root, ast } = richGuide(t);
  const doc = unzip(exportDocx(ast, path.join(root, 'docx')).file).get('word/document.xml');
  const box = '<w:pBdr><w:left w:val="single" w:sz="24" w:space="4" w:color="047857"/></w:pBdr><w:shd w:val="clear" w:fill="ECFDF5"/>';
  const paras = [...doc.matchAll(/<w:p><w:pPr>([^]*?)<\/w:pPr>([^]*?)<\/w:p>/g)].filter((m) => m[1].includes(box));
  assert.equal(paras.length, 3, 'label, text and list item share the border and shading');
  assert.match(paras[0][2], /Tip: Shortcut/);
  assert.match(paras[1][2], /<w:b\/>[^]*?Ctrl\+R/);
  assert.match(paras[2][2], /• <\/w:t>[^]*?works in /);
  assert.ok(paras.every((m) => !m[1].includes('<w:numPr>') && !m[1].includes('<w:ind')), 'no indent to break the box');
  assert.match(paras[2][1], /<w:spacing w:before="0" w:after="160"\/>/, 'space after the box, not inside it');
});

test('PowerPoint keeps description formatting, real bullets and numbers, and links', (t) => {
  const { root, ast } = richGuide(t);
  const { file, slideCount } = exportPptx(ast, path.join(root, 'pptx'));
  const z = unzip(file);
  const slides = Array.from({ length: slideCount }, (_, i) => z.get(`ppt/slides/slide${i + 1}.xml`));
  const slideOf = (title) => slides.findIndex((xml) => xml.includes('name="Step number"') && xml.includes(`<a:t>${title}</a:t>`)) + 1;
  const first = slideOf('Open the Users page');
  const second = slideOf('Reset the password');
  const s1 = z.get(`ppt/slides/slide${first}.xml`);
  const s2 = z.get(`ppt/slides/slide${second}.xml`);
  assert.match(s1, /<a:rPr lang="en-US" sz="\d+" b="1" dirty="0">[^]*?<a:t>Users<\/a:t>/, 'bold');
  assert.match(s1, /i="1"[^>]*>[^]*?<a:t>bulk<\/a:t>/, 'italic');
  assert.match(s1, /strike="sngStrike"[^>]*>[^]*?<a:t>old<\/a:t>/, 'strikethrough');
  assert.match(s2, /<a:latin typeface="Consolas"\/><\/a:rPr><a:t>adminctl unlock<\/a:t>/, 'inline code');
  assert.match(s2, /<a:buAutoNum type="arabicPeriod"\/><\/a:pPr><a:r>[^]*?<a:t>Pick </, 'a numbered list');
  assert.match(s2, /<a:buAutoNum type="arabicPeriod" startAt="2"\/><\/a:pPr><a:r>[^]*?<a:t>Choose </);
  assert.match(s2, /<a:buChar char="•"\/><\/a:pPr><a:r>[^]*?<a:t>works anywhere<\/a:t>/, 'a bulleted list');
  assert.match(s2, /i="1"[^>]*>[^]*?<a:t>The old password stops working\.<\/a:t>/, 'quote');
  // The web link points at its page; the step link jumps to that step's slide.
  const web = s1.match(/<a:hlinkClick r:id="(rId\d+)"\/><\/a:rPr><a:t>Users guide<\/a:t>/)[1];
  assert.match(z.get(`ppt/slides/_rels/slide${first}.xml.rels`), new RegExp(`Id="${web}" Type="[^"]+/hyperlink" Target="https://docs.example.com/users" TargetMode="External"`));
  const jump = s2.match(/<a:hlinkClick r:id="(rId\d+)" action="ppaction:\/\/hlinksldjump"\/><\/a:rPr><a:t>the Users page<\/a:t>/)[1];
  assert.match(z.get(`ppt/slides/_rels/slide${second}.xml.rels`), new RegExp(`Id="${jump}" Type="[^"]+/slide" Target="slide${first}.xml"`));
  // A callout's text keeps its formatting, its list items marked.
  assert.match(s2, /<a:t>Tip: Shortcut<\/a:t>[^]*?b="1"[^>]*>[^]*?<a:t>Ctrl\+R<\/a:t>[^]*?<a:t>• <\/a:t>[^]*?<a:t>works in <\/a:t>/);
});

test('PowerPoint keeps formatting on both sides of a split onto a "(continued)" slide', (t) => {
  const { root, ast } = richGuide(t);
  const { file, slideCount } = exportPptx(ast, path.join(root, 'pptx'));
  const z = unzip(file);
  const slides = Array.from({ length: slideCount }, (_, i) => z.get(`ppt/slides/slide${i + 1}.xml`)).filter((xml) => xml.includes('<a:t>A long one'));
  assert.ok(slides.length >= 2, 'the long step continues');
  const runs = (xml) => [...xml.matchAll(/<a:rPr [^>]*?b="(\d)"(?: i="1")?[^>]*>[^]*?<a:t>([^<]*)<\/a:t>/g)];
  // Bold text stays bold and italic text stays italic on every slide it reaches.
  for (const xml of slides) {
    for (const m of [...xml.matchAll(/<a:rPr ([^>]*)>(?:(?!<\/a:rPr>)[^])*<\/a:rPr><a:t>([^<]*)<\/a:t>/g)]) {
      if (m[2].startsWith('Check the account') && !m[1].includes('sz="2800"')) assert.ok(m[1].includes('b="1"') || m[1].includes('i="1"'), `"${m[2].slice(0, 30)}" keeps its style`);
    }
  }
  assert.ok(runs(slides[0]).length > 0);
});

test('slide text helpers: paragraphs, list markers and splitting runs', () => {
  const paras = richParagraphs('<p>A <b>bold</b>  word<br>next line</p><ol><li>one</li><li>two</li></ol><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
  assert.deepEqual(paras.slice(0, 2).map((p) => p.text), ['A bold word', 'next line']);
  assert.deepEqual(paras[0].runs.map((r) => [r.text, Boolean(r.bold)]), [['A ', false], ['bold', true], [' word', false]]);
  assert.deepEqual(paras.slice(2, 4).map(markedText), ['1. one', '2. two']);
  assert.deepEqual(paras[4].rows, [['A', 'B'], ['1', '2']]);
  const runs = paras[0].runs;
  assert.deepEqual(sliceRuns(runs, 0, 4).map((r) => r.text), ['A ', 'bo']);
  assert.deepEqual(sliceRuns(runs, 6).map((r) => [r.text, Boolean(r.bold)]), [['word', false]], 'leading space dropped');
});

test('Word rich text: the Confluence (styled) form refers to styles and keeps the Symbol bullet', () => {
  const rels = [];
  const rich = new WordRichText({ ast: { steps: [] }, rel: (type, target) => { rels.push(target); return 'rId9'; }, anchorFor: () => 'x', table: () => '<w:tbl/>' });
  const xml = rich.richText('<ul><li>one</li></ul><blockquote>q</blockquote><p><a href="https://example.com">l</a></p>');
  assert.match(xml, /<w:pStyle w:val="ListParagraph"\/><w:numPr>/);
  assert.match(xml, /<w:pStyle w:val="Quote"\/>/);
  assert.match(xml, /<w:rStyle w:val="Hyperlink"\/>/);
  assert.deepEqual(rels, ['https://example.com']);
  assert.match(rich.numberingXml(), /<w:lvlText w:val=""\/>[^]*?<w:rFonts w:ascii="Symbol"/);
});

/** A one-step guide with `descriptionHtml`, as a render AST. */
function oneStepGuide(t, descriptionHtml) {
  const root = makeTmpDir('rich-text-one');
  t.after(() => rmrf(root));
  const store = new GuideStore(path.join(root, 'data'));
  const guide = store.createGuide({ title: 'One step' });
  store.addStep(guide.guideId, { kind: 'empty', title: 'The step', descriptionHtml });
  return { root, ast: buildRenderAst(store, guide.guideId) };
}

const NESTED = '<ol><li>Parent<ul><li>Child<ol><li>Grandchild</li></ol></li></ul></li><li>Next</li></ol>';

test('nested lists keep their depth on slides and in Word, and the outer list keeps counting', (t) => {
  assert.deepEqual(richParagraphs(NESTED).map((p) => [p.text, p.list.level]), [['Parent', 0], ['Child', 1], ['Grandchild', 2], ['Next', 0]]);
  assert.deepEqual(richParagraphs(NESTED).map(markedText), ['1. Parent', '  • Child', '    1. Grandchild', '2. Next']);

  const { root, ast } = oneStepGuide(t, NESTED);
  const doc = unzip(exportDocx(ast, path.join(root, 'docx')).file).get('word/document.xml');
  const items = [...doc.matchAll(/<w:ilvl w:val="(\d)"\/><w:numId w:val="(\d+)"\/>[^]*?<w:t xml:space="preserve">([^<]*)<\/w:t>/g)]
    .map((m) => ({ text: m[3], lvl: Number(m[1]), num: m[2] }));
  assert.deepEqual(items.map((i) => [i.text, i.lvl]), [['Parent', 0], ['Child', 1], ['Grandchild', 2], ['Next', 0]]);
  assert.equal(items[3].num, items[0].num, '"Next" continues the outer numbered list, so it is numbered 2');
});

test('links with several query parameters keep their "&" in Word and PowerPoint', (t) => {
  const { root, ast } = oneStepGuide(t, '<p>See <a href="https://example.com/?a=1&amp;b=2">the page</a>.</p>');
  const docxRels = unzip(exportDocx(ast, path.join(root, 'docx')).file).get('word/_rels/document.xml.rels');
  assert.match(docxRels, /Target="https:\/\/example\.com\/\?a=1&amp;b=2" TargetMode="External"/);
  const pptx = unzip(exportPptx(ast, path.join(root, 'pptx')).file);
  const slideRels = [...pptx].filter(([name]) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name)).map(([, xml]) => xml).join('');
  assert.match(slideRels, /Target="https:\/\/example\.com\/\?a=1&amp;b=2" TargetMode="External"/);
  assert.doesNotMatch(docxRels + slideRels, /&amp;amp;/);
});

test('PowerPoint splits long unbroken text onto "(continued)" slides without repeating or losing any of it', (t) => {
  // No spaces to wrap at, so lines break between characters.
  const bold = '粗'.repeat(1500);
  const plain = '文'.repeat(1500);
  const { root, ast } = oneStepGuide(t, `<p><b>${bold}</b>${plain}</p>`);
  const { file, slideCount } = exportPptx(ast, path.join(root, 'pptx'));
  const z = unzip(file);
  const slides = Array.from({ length: slideCount }, (_, i) => z.get(`ppt/slides/slide${i + 1}.xml`)).filter((xml) => xml.includes('<a:t>The step'));
  assert.ok(slides.length >= 2, 'the step continues');
  const runs = slides.flatMap((xml) => [...xml.matchAll(/<a:rPr ([^>]*)>(?:(?!<\/a:rPr>)[^])*<\/a:rPr><a:t>([^<]*)<\/a:t>/g)]);
  const count = (ch) => runs.reduce((n, m) => n + [...m[2]].filter((c) => c === ch).length, 0);
  assert.equal(count('粗'), 1500);
  assert.equal(count('文'), 1500);
  for (const m of runs) {
    if (m[2].includes('粗')) assert.ok(m[1].includes('b="1"') && !m[2].includes('文'), 'bold text stays bold and apart from plain text');
  }
});
