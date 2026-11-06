'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { withApp, readJson, decodePngFile, pixelAt } = require('./lib/fixtures');
const { openLibrary, openGuideCard, exportThroughUi } = require('./lib/flows');
const { unzipSync } = require('../../core/zip');

const TITLE = 'Reset a password in Admin Portal';


test('JSON and Markdown exported through the dialog keep step order and real screenshot files', () => withApp('exports-data', {}, async (app, env) => {
  await openLibrary(app);
  await openGuideCard(app, 'Reset a password');
  const file = await exportThroughUi(app, env, 'json', '.json');
  const doc = readJson(file);
  assert.equal(doc.guide.title, TITLE);
  assert.equal(doc.steps.length, 4, 'hidden and skipped sample steps are excluded');
  const diskSteps = require('./lib/fixtures').readSteps(path.join(env.dataDir, 'library/guides/guide-sample-reset-password'));
  assert.deepEqual(doc.steps.map((s) => s.title), diskSteps.filter((s) => !s.step.hidden && !s.step.skipped)
    .map((s) => s.step.title.replace('[[Product]]', 'Admin Portal')));
  const images = doc.steps.filter((s) => s.image).map((s) => path.resolve(path.dirname(file), s.image.relPath));
  assert.ok(images.length >= 3);
  for (const image of images) {
    const decoded = decodePngFile(image);
    assert.ok(decoded.width > 200 && decoded.height > 100);
    assert.equal(pixelAt(decoded, 0, 0)[3], 255);
  }
  const markdown = await exportThroughUi(app, env, 'markdown', '.md');
  const contents = fs.readFileSync(markdown, 'utf8');
  const headings = contents.split('\n').filter((line) => /^#{1,3} /.test(line)).map((line) => line.replace(/^#+ /, ''));
  assert.equal(headings[0], TITLE);
  for (const step of doc.steps) assert.ok(headings.some((h) => h.endsWith(step.title)), `heading for ${step.title}`);
  const links = [...contents.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  assert.equal(links.length, images.length);
  for (const image of links) assert.ok(decodePngFile(path.resolve(path.dirname(markdown), image)).width > 0);
}));

test('HTML, PDF and Word exported through the dialog are readable documents with images', () => withApp('exports-documents', {}, async (app, env) => {
  await openLibrary(app);
  await openGuideCard(app, 'Reset a password');
  const html = await exportThroughUi(app, env, 'html-simple', '.html');
  const document = await app.evaluate(`(() => {
    const doc = new DOMParser().parseFromString(${JSON.stringify(fs.readFileSync(html, 'utf8'))}, 'text/html');
    return { title: doc.querySelector('h1').textContent.trim(), images: Array.from(doc.images, i => i.getAttribute('src')) };
  })()`);
  assert.equal(document.title, TITLE);
  assert.ok(document.images.length >= 3);
  for (const src of document.images) {
    assert.ok(src.startsWith('data:image/png;base64,'));
    assert.ok(require('../../core/png').decodePng(Buffer.from(src.split(',')[1], 'base64')).width > 0);
  }
  const pdf = await exportThroughUi(app, env, 'pdf', '.pdf');
  // Poppler actually parses the cross-reference table, page tree and content.
  execFileSync('pdfinfo', [pdf], { stdio: 'pipe' });
  const pdfText = execFileSync('pdftotext', [pdf, '-'], { encoding: 'utf8' });
  assert.ok(pdfText.includes(TITLE));
  assert.ok(pdfText.includes('Enable the reset policy'));
  const docx = await exportThroughUi(app, env, 'docx', '.docx');
  const entries = unzipSync(fs.readFileSync(docx));
  const xml = entries.find((entry) => entry.name === 'word/document.xml');
  assert.ok(xml);
  const parsed = await app.evaluate(`(() => {
    const doc = new DOMParser().parseFromString(${JSON.stringify(xml.data.toString('utf8'))}, 'application/xml');
    return { errors: doc.getElementsByTagName('parsererror').length, text: doc.documentElement.textContent,
      drawings: doc.getElementsByTagNameNS('*', 'drawing').length };
  })()`);
  assert.equal(parsed.errors, 0);
  assert.ok(parsed.text.includes(TITLE));
  assert.ok(parsed.drawings >= 3);
  assert.ok(entries.filter((entry) => entry.name.startsWith('word/media/')).length >= 3);
}));

