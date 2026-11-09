'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { buildRenderAst } = require('../../core/renderast');
const { runExport } = require('../../exporters');
const { exportPdf } = require('../../exporters/pdf');
const { importGuide } = require('../../exporters/confluence');
const { FallbackFonts } = require('../../core/pdf-fonts');
const { unzipSync } = require('../../core/zip');
const site = require('../../core/pages-site');
const { makeTmpDir, rmrf } = require('./helpers');
const { buildFixtureGuide } = require('./fixture-guide');

/**
 * The text StepForge adds to an export ("Contents", "Last verified: …", alt
 * text, page numbers) follows the interface language; a guide's own text
 * doesn't change.
 */

const ENGLISH_LABELS = ['Last verified', 'Author:', 'Contents', 'Screenshot for step', 'steps · generated', 'Untitled step', '(skipped)'];

function fixture(t) {
  const dir = makeTmpDir('export-language');
  t.after(() => rmrf(dir));
  const { store, guide } = buildFixtureGuide(path.join(dir, 'data'));
  const g = store.getGuide(guide.guideId);
  g.metadata = { ...g.metadata, author: 'Casey', lastVerified: '2026-11-09' };
  g.flags = { ...g.flags, hideSkippedStepsInExports: false };
  store.saveGuide(g);
  // A step without a title, to show the "Untitled step" fallback.
  store.addStep(guide.guideId, { kind: 'empty', title: '' });
  const ast = (language) => buildRenderAst(store, guide.guideId, { language, now: new Date('2026-11-09T10:00:00Z') });
  return { dir, ast };
}

/** The text of a PDF's pages: content streams inflated, as Latin-1. */
function pdfStreams(file) {
  const buf = fs.readFileSync(file);
  const text = buf.toString('latin1');
  const out = [];
  for (const m of text.matchAll(/\/Length (\d+)[^]*?\nstream\n/g)) {
    const start = m.index + m[0].length;
    const raw = buf.subarray(start, start + Number(m[1]));
    try { out.push(zlib.inflateSync(raw).toString('latin1')); } catch { out.push(raw.toString('latin1')); }
  }
  return out.join('\n');
}

const docxText = (file) => unzipSync(fs.readFileSync(file)).find((e) => e.name === 'word/document.xml').data.toString('utf8');

test('the render AST carries the export language and translated alt text', (t) => {
  const { ast } = fixture(t);
  const en = ast();
  assert.equal(en.language, 'en');
  assert.equal(en.steps[0].altText, 'Screenshot for step 1: Open AcmeSync settings');
  const zh = ast('zh-CN');
  assert.equal(zh.language, 'zh-CN');
  assert.equal(zh.steps[0].altText, '步骤 1 的截图：Open AcmeSync settings', 'the guide’s own title stays as written');
  assert.equal(ast('xx').language, 'en', 'an unknown language falls back to English');
});

test('PDF: cover details, contents and labels follow the language; English is unchanged', (t) => {
  const { dir, ast } = fixture(t);
  const en = pdfStreams(exportPdf(ast('en'), path.join(dir, 'en')).file);
  assert.match(en, /Last verified: 2026-11-09/);
  assert.match(en, /\(Contents\) Tj/);
  assert.match(en, /Untitled step/);

  const fr = pdfStreams(exportPdf(ast('fr'), path.join(dir, 'fr')).file);
  for (const text of ['Dernière vérification : 2026-11-09', 'Auteur : Casey', '(Sommaire) Tj', 'Étape sans titre', 'Open AcmeSync settings']) {
    assert.ok(fr.includes(text), `fr PDF has ${text}`);
  }
  assert.doesNotMatch(fr, /Last verified|\(Contents\)|Untitled step/);

  // Chinese text needs installed fonts; without any it is drawn as "?", but no English label is left.
  const zh = pdfStreams(exportPdf(ast('zh-CN'), path.join(dir, 'zh'), {}, { fallbackFonts: new FallbackFonts([]) }).file);
  for (const label of ENGLISH_LABELS) assert.ok(!zh.includes(label), `zh PDF has no "${label}"`);
});

test('DOCX and Confluence Word: labels follow the language', (t) => {
  const { dir, ast } = fixture(t);
  const zh = docxText(runExport('docx', ast('zh-CN'), path.join(dir, 'docx')).file);
  for (const text of ['上次验证：2026-11-09', '作者：Casey', '目录', '未命名步骤', '步骤 1 的截图：Open AcmeSync settings', '警告：Access']) {
    assert.ok(zh.includes(text), `zh DOCX has ${text}`);
  }
  for (const label of ENGLISH_LABELS) assert.ok(!zh.includes(label), `zh DOCX has no "${label}"`);
  const en = docxText(runExport('docx', ast('en'), path.join(dir, 'docx-en')).file);
  assert.ok(en.includes('Last verified: 2026-11-09') && en.includes('>Contents<') && en.includes('Warning: Access'));

  const ja = runExport('confluence', ast('ja'), path.join(dir, 'confluence'), { apiFiles: true });
  const word = docxText(ja.file);
  assert.ok(word.includes('最終確認日：2026-11-09') && word.includes('スキップ'), 'Confluence Word document');
  const page = fs.readFileSync(ja.apiPage, 'utf8');
  assert.ok(page.includes('最終確認日：2026-11-09') && !page.includes('Last verified'), 'Confluence storage page');
  const howTo = fs.readFileSync(path.join(ja.folder, 'HOW-TO-IMPORT.txt'), 'utf8');
  assert.match(howTo, /を Confluence に追加する方法/);
  assert.match(howTo, /curl -u you@example\.com:API_TOKEN/, 'commands stay as they are');
});

test('HTML, Markdown and Wiki.js: labels, script text and the page language follow the language', (t) => {
  const { dir, ast } = fixture(t);
  const rich = fs.readFileSync(runExport('html-rich', ast('ru'), path.join(dir, 'rich')).file, 'utf8');
  assert.match(rich, /<html lang="ru"/);
  for (const text of ['Последняя проверка: 2026-11-09', '<h2>Содержание</h2>', 'Отметить шаг как выполненный', 'Сделано в StepForge', '"Выполнено: {done} из {total}"', '"Копировать код"', 'Пропущенный']) {
    assert.ok(rich.includes(text), `ru HTML has ${text}`);
  }
  // What a reader sees: the page and its scripts' strings, without code comments.
  const visible = rich.replace(/^\s*\/\/.*$/gm, '');
  for (const label of [...ENGLISH_LABELS, 'Mark step as done', 'Made with StepForge', ' done\'', 'Copy code']) assert.ok(!visible.includes(label), `ru HTML has no "${label}"`);
  const en = fs.readFileSync(runExport('html-rich', ast('en'), path.join(dir, 'rich-en')).file, 'utf8');
  assert.match(en, /<html lang="en"/);
  assert.ok(en.includes('<h2>Contents</h2>') && en.includes('"{done} of {total} done"') && en.includes('Last verified: 2026-11-09'));

  const md = fs.readFileSync(runExport('markdown', ast('es'), path.join(dir, 'md')).file, 'utf8');
  for (const text of ['## Contenido', 'Última verificación: 2026-11-09', '*(omitido)*', 'Paso sin título', '![Captura de pantalla del paso 1: Open AcmeSync settings]']) {
    assert.ok(md.includes(text), `es Markdown has ${text}`);
  }
  const gfm = fs.readFileSync(runExport('markdown', ast('es'), path.join(dir, 'gfm'), { githubAlerts: true }).file, 'utf8');
  assert.match(gfm, /> \[!WARNING\]/, 'GitHub alert names stay English: GitHub only knows those');
  const wiki = fs.readFileSync(runExport('wikijs', ast('fr'), path.join(dir, 'wiki'), { frontMatter: true }).file, 'utf8');
  assert.match(wiki, /> \*\*Access\*\*/);
  assert.match(wiki, /^\*5 étapes · généré le 2026-11-09\*$/m);
});

test('clipboard, PPTX and JSON summaries follow the language', (t) => {
  const { dir, ast } = fixture(t);
  const clip = runExport('clipboard', ast('zh-CN'), path.join(dir, 'clip'));
  assert.match(clip.text, /上次验证：2026-11-09/);
  assert.match(clip.text, /（已跳过）/);
  assert.match(clip.text, /警告：Access/);
  assert.match(clip.html, /未命名步骤/);

  const pptx = unzipSync(fs.readFileSync(runExport('pptx', ast('ja'), path.join(dir, 'pptx')).file));
  const slides = pptx.filter((e) => e.name.startsWith('ppt/slides/slide')).map((e) => e.data.toString('utf8')).join('\n');
  assert.ok(slides.includes('目次') && slides.includes('最終確認日：2026-11-09'), 'PPTX contents and cover');
  assert.ok(!slides.includes('>Contents<') && !slides.includes('Last verified'));

  const json = JSON.parse(fs.readFileSync(runExport('json', ast('fr'), path.join(dir, 'json')).file, 'utf8'));
  assert.equal(json.guide.summary, '5 étapes · généré le 2026-11-09');
});

test('the Confluence import instructions are unchanged in English', () => {
  const howTo = importGuide({ guide: { title: 'Back up' }, language: 'en' }, 'Back up.docx', 2, true);
  assert.match(howTo, /^How to add "Back up" to Confluence\n=+\n\nImport this Word document from your browser:/);
  assert.match(howTo, /     Root page title:  Back up\n     Where to import:  Import as a new page in the current space\n     Split by heading: Don't split\n5\. Select Import\./);
  assert.match(howTo, /attachments\/           2 screenshots the page shows\./);
});

test('GitHub Pages: the credit link works in any language, and the front page follows the language', (t) => {
  const { dir, ast } = fixture(t);
  const html = site.prepareGuideHtml(fs.readFileSync(runExport('html-simple', ast('ja'), path.join(dir, 'pages')).file, 'utf8'));
  assert.match(html, /<span class="credit">StepForge で作成<\/span> · <a href="https:\/\/github\.com\/Twest2\/StepForge"/);
  assert.match(site.rootIndex('zh-CN'), /<html lang="zh-CN">[\s\S]*<h1>分享的指南<\/h1>/);
  assert.equal(site.rootIndex(), site.ROOT_INDEX);
  assert.match(site.ROOT_INDEX, /<h1>Shared guides<\/h1>/);
});
