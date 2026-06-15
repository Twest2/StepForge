'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildRenderAst, renderStepImage } = require('../../core/renderast');
const { exportJson } = require('../../exporters/json');
const { exportMarkdown } = require('../../exporters/markdown');
const { exportWikiJs } = require('../../exporters/wikijs');
const { exportHtmlSimple, exportHtmlRich } = require('../../exporters/html');
const { exportConfluence } = require('../../exporters/confluence');
const { htmlToMarkdown } = require('../../exporters/htmlmd');
const { decodePng } = require('../../core/png');
const { buildFixtureGuide } = require('./fixture-guide');
const { makeTmpDir, rmrf } = require('./helpers');

test('render AST: numbering, placeholder expansion, hidden/skipped filtering', (t) => {
  const root = makeTmpDir('ast');
  t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));

  const ast = buildRenderAst(store, guide.guideId, { globals: { Author: 'GlobalAuthor' } });

  assert.equal(ast.guide.title, 'Configure AcmeSync backups');
  // Guide-level placeholder wins over global.
  assert.ok(ast.guide.descriptionHtml.includes('Casey'));

  // Hidden always excluded; skipped excluded by default flag.
  const titles = ast.steps.map((s) => s.title);
  assert.ok(!titles.includes('Internal-only note'));
  assert.ok(!titles.includes('Legacy path'));

  // Hierarchical numbering: 1, 1.1, 2
  assert.deepEqual(ast.steps.map((s) => s.number), ['1', '1.1', '2']);
  assert.equal(ast.steps[0].title, 'Open AcmeSync settings');
  assert.equal(ast.steps[1].depth, 1);

  // Step images resolve to real decodable files with annotations burned in.
  const img = renderStepImage(ast.steps[0]);
  assert.equal(img.width, 320);
  // Red rect stroke on the left border (x=0.125*320=40), away from the badge.
  const p = (100 * 320 + 40) * 4;
  assert.deepEqual([img.data[p], img.data[p + 1], img.data[p + 2]], [255, 0, 0]);
});

test('render AST: guide metadata defaults to empty strings and expands placeholders', (t) => {
  const root = makeTmpDir('astmeta');
  t.after(() => rmrf(root));
  const { store, guide: bare } = buildFixtureGuide(path.join(root, 'data'));

  // Fixture guide has no metadata set: all fields default to ''.
  const noMeta = buildRenderAst(store, bare.guideId);
  assert.deepEqual(noMeta.guide.metadata, { author: '', coAuthors: '', organization: '' });

  // Set metadata with placeholders and re-check expansion against guide + global scope.
  const guide = store.getGuide(bare.guideId);
  guide.metadata = {
    author: '[[Author]]',
    coAuthors: 'Alex Lee, [[CoAuthor]]',
    organization: '[[Org]]',
  };
  store.saveGuide(guide);

  const ast = buildRenderAst(store, guide.guideId, { globals: { CoAuthor: 'Sam Patel', Org: 'GlobalOrg' } });
  // Guide-level placeholder (Author -> Casey) wins over global; CoAuthor/Org fall back to globals.
  assert.deepEqual(ast.guide.metadata, {
    author: 'Casey',
    coAuthors: 'Alex Lee, Sam Patel',
    organization: 'GlobalOrg',
  });
});

test('JSON export produces a parseable document with real image files', (t) => {
  const root = makeTmpDir('expjson');
  t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const out = path.join(root, 'out');

  const ast = buildRenderAst(store, guide.guideId);
  const { file, imageCount } = exportJson(ast, out);

  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.guide.title, 'Configure AcmeSync backups');
  assert.equal(doc.steps.length, 3);
  assert.equal(imageCount, 2);
  assert.deepEqual(doc.steps.map((s) => s.number), ['1', '1.1', '2']);

  // Image paths are relative to the JSON file and decode as PNGs of the
  // declared dimensions.
  for (const step of doc.steps.filter((s) => s.image)) {
    const imgFile = path.join(out, step.image.relPath);
    const img = decodePng(fs.readFileSync(imgFile));
    assert.equal(img.width, step.image.width);
    assert.equal(img.height, step.image.height);
  }

  // Code/table blocks survive structurally.
  const s2 = doc.steps.find((s) => s.number === '2');
  assert.equal(s2.codeBlocks[0].language, 'cron');
  assert.equal(s2.tableBlocks[0].rows[1][0], 'Weekdays');
});

test('Markdown export: TOC anchors resolve, images exist, blocks rendered', (t) => {
  const root = makeTmpDir('expmd');
  t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const out = path.join(root, 'out');

  const ast = buildRenderAst(store, guide.guideId);
  const { file } = exportMarkdown(ast, out);
  const md = fs.readFileSync(file, 'utf8');

  // Every TOC link points at an anchor that exists in the document.
  const tocLinks = [...md.matchAll(/\]\(#([a-z0-9-]+)\)/g)].map((m) => m[1]);
  assert.equal(tocLinks.length, 3);
  for (const anchor of tocLinks) {
    assert.ok(md.includes(`<a id="${anchor}"></a>`), `anchor ${anchor} exists`);
  }

  // Every image reference resolves to a real PNG on disk.
  const imgRefs = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  assert.equal(imgRefs.length, 2);
  for (const rel of imgRefs) {
    const img = decodePng(fs.readFileSync(path.join(out, rel)));
    assert.equal(img.width, 320);
  }

  // Structure: title heading, step headings with numbers, fenced code, table.
  const lines = md.split('\n');
  assert.equal(lines[0], '# Configure AcmeSync backups');
  assert.ok(lines.some((l) => l.startsWith('## 1. Open AcmeSync settings')));
  assert.ok(lines.some((l) => l.startsWith('### 1.1. Verify the gear icon')));
  const fenceStart = lines.indexOf('```cron');
  assert.ok(fenceStart > 0, 'code fence present');
  assert.equal(lines[fenceStart + 1], '0 2 * * * /usr/local/bin/acmesync --backup');
  assert.equal(lines[fenceStart + 2], '```');
  assert.ok(lines.some((l) => /^\| Day \| Window \|$/.test(l)), 'table header row');
  // Warning text block became a styled HTML callout with its content.
  assert.ok(md.includes('<div class="sf-callout sf-callout-warning"'));
  assert.ok(md.includes('border-left: 4px solid #f59e0b'));
  assert.ok(md.includes('Warning: Access'));
  assert.ok(md.includes('<p>Admins only.</p>'));
});

test('Wiki.js export: TOC is included, wiki callouts render, images exist', (t) => {
  const root = makeTmpDir('expwikijs');
  t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const out = path.join(root, 'out');

  const ast = buildRenderAst(store, guide.guideId);
  const { file } = exportWikiJs(ast, out);
  const md = fs.readFileSync(file, 'utf8');

  const lines = md.split('\n');
  assert.equal(lines[0], '# Configure AcmeSync backups');
  assert.ok(lines.some((l) => l === '## Contents'));
  assert.ok(lines.some((l) => l.startsWith('## 1. Open AcmeSync settings')));
  assert.ok(lines.some((l) => l.startsWith('> **Access**')));
  assert.ok(lines.includes('> Admins only.'));
  assert.ok(lines.includes('{.is-warning}'));

  const imgRefs = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  assert.equal(imgRefs.length, 2);
  for (const rel of imgRefs) {
    const img = decodePng(fs.readFileSync(path.join(out, rel)));
    assert.equal(img.width, 320);
  }
});

test('Confluence export writes storage-format XML and image attachments', (t) => {
  const root = makeTmpDir('expconf');
  t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const out = path.join(root, 'out');

  const ast = buildRenderAst(store, guide.guideId);
  const { file, attachmentCount } = exportConfluence(ast, out);
  const xml = fs.readFileSync(file, 'utf8');

  assert.equal(attachmentCount, 2);
  assert.ok(xml.includes('<ac:structured-macro ac:name="code">'));
  assert.ok(xml.includes('ri:attachment ri:filename='));
  assert.ok(xml.includes('0 2 * * * /usr/local/bin/acmesync --backup'));

  const attachmentsDir = path.join(out, 'configure-acmesync-backups-attachments');
  const files = fs.readdirSync(attachmentsDir);
  assert.equal(files.length, 2);
  for (const name of files) {
    const img = decodePng(fs.readFileSync(path.join(attachmentsDir, name)));
    assert.equal(img.width, 320);
    assert.equal(img.height, 200);
  }
});

test('Simple HTML export is self-contained with valid embedded images', (t) => {
  const root = makeTmpDir('exphtml');
  t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const out = path.join(root, 'out');

  const ast = buildRenderAst(store, guide.guideId);
  const { file } = exportHtmlSimple(ast, out);
  const html = fs.readFileSync(file, 'utf8');

  // No external references: every src/href is data:, #anchor, or https user link.
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    assert.ok(
      ref.startsWith('data:') || ref.startsWith('#') || ref.startsWith('https://docs.example.com'),
      `unexpected external ref: ${ref.slice(0, 60)}`
    );
  }

  // Embedded images decode back to the original dimensions.
  const uris = [...html.matchAll(/src="data:image\/png;base64,([^"]+)"/g)].map((m) => m[1]);
  assert.equal(uris.length, 2);
  for (const b64 of uris) {
    const img = decodePng(Buffer.from(b64, 'base64'));
    assert.equal(img.width, 320);
    assert.equal(img.height, 200);
  }

  // One section per exported step, with the right ids.
  const ids = [...html.matchAll(/<section class="step[^"]*" id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['step-1', 'step-1-1', 'step-2']);
});

test('Rich HTML export: TOC matches sections, checkboxes per step, local-only persistence', (t) => {
  const root = makeTmpDir('exprich');
  t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const out = path.join(root, 'out');

  const ast = buildRenderAst(store, guide.guideId);
  const { file } = exportHtmlRich(ast, out);
  const html = fs.readFileSync(file, 'utf8');

  const tocAnchors = [...html.matchAll(/<li class="d\d">\s*<a href="#([^"]+)"/g)].map((m) => m[1]);
  const sectionIds = [...html.matchAll(/<section class="step[^"]*" id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tocAnchors, sectionIds);
  assert.equal(sectionIds.length, 3);

  const checkboxes = [...html.matchAll(/<input type="checkbox" class="step-done" data-step="([^"]+)"/g)];
  assert.equal(checkboxes.length, 3);

  // Progress persists via localStorage only — no network APIs in the script.
  assert.ok(html.includes('localStorage'));
  for (const banned of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'navigator.sendBeacon', 'http://']) {
    assert.ok(!html.includes(banned), `must not contain ${banned}`);
  }
});

test('htmlToMarkdown converts the sanitizer-allowed tag set', () => {
  const md = htmlToMarkdown(
    '<p>Use <b>bold</b>, <em>italic</em> and <code>cmd --flag</code>.</p>' +
    '<ul><li>one</li><li>two</li></ul>' +
    '<ol><li>first</li><li>second</li></ol>' +
    '<table><tr><th>K</th><th>V</th></tr><tr><td>a</td><td>1</td></tr></table>' +
    '<pre><code>line1\nline2</code></pre>' +
    '<p><a href="https://x.example">link</a> &amp; entity</p>'
  );
  const lines = md.split('\n');
  assert.ok(lines.includes('Use **bold**, *italic* and `cmd --flag`.'));
  assert.ok(lines.includes('- one') && lines.includes('- two'));
  assert.ok(lines.includes('1. first') && lines.includes('2. second'));
  assert.ok(lines.includes('| K | V |') && lines.includes('| a | 1 |'));
  const fence = lines.indexOf('```');
  assert.deepEqual(lines.slice(fence, fence + 4), ['```', 'line1', 'line2', '```']);
  assert.ok(lines.includes('[link](https://x.example) & entity'));
});

test('preview mode limits the AST to the first N steps', (t) => {
  const root = makeTmpDir('preview');
  t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const ast = buildRenderAst(store, guide.guideId, { maxSteps: 2 });
  assert.equal(ast.steps.length, 2);
  assert.deepEqual(ast.steps.map((s) => s.number), ['1', '1.1']);
});
