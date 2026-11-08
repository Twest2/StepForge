'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTmpDir, rmrf } = require('./helpers');
const { GuideStore } = require('../../core/store');
const { createStep } = require('../../core/schema');
const { sanitizeHtml } = require('../../core/sanitize');
const { render } = require('../../core/markdown-description');
const { buildRenderAst } = require('../../core/renderast');
const { runExport } = require('../../exporters');

const html = (source) => sanitizeHtml(render(source));

test('Markdown descriptions render GitHub-style Markdown and safe inline HTML', () => {
  const out = html('# Title\n\n**bold** ~~gone~~\nnext\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n'
    + '<details><summary>More</summary><kbd>Ctrl</kbd></details>\n\n<script>alert(1)</script><img src="https://x.test/a.png">\n\n![logo](https://x.test/l.png) https://example.com');
  assert.match(out, /<h1>Title<\/h1>/);
  assert.match(out, /<strong>bold<\/strong> <s>gone<\/s><br>\nnext/);
  assert.match(out, /<table>[\s\S]*<td>2<\/td>/);
  assert.match(out, /☑ done[\s\S]*☐ todo/);
  assert.match(out, /<details><summary>More<\/summary><kbd>Ctrl<\/kbd><\/details>/);
  assert.doesNotMatch(out, /script|<img/);
  assert.match(out, /<a href="https:\/\/x.test\/l.png">logo<\/a>/, 'an image is a link, never loaded');
  assert.match(out, /<a href="https:\/\/example.com">/);
});

test('the Markdown source is kept while it matches the HTML, and rebuilt when something else rewrote the HTML', () => {
  const source = 'Some **bold** text';
  assert.equal(createStep({ descriptionMarkdown: source, descriptionHtml: html(source) }).descriptionMarkdown, source);
  // AI, an agent, Find and replace or the private-detail check changed the HTML.
  const rewritten = createStep({ descriptionMarkdown: source, descriptionHtml: '<p>Some <strong>new</strong> text</p>' });
  assert.equal(rewritten.descriptionHtml, '<p>Some <strong>new</strong> text</p>');
  assert.equal(rewritten.descriptionMarkdown, 'Some **new** text');
  assert.equal('descriptionMarkdown' in createStep({ descriptionHtml: '<p>x</p>' }), false, 'rich text has no source');
});

test('Markdown exports use the source as written, with step links renumbered and pointing at the step', (t) => {
  const dir = makeTmpDir('md-mode');
  t.after(() => rmrf(dir));
  const store = new GuideStore(dir);
  const guide = store.createGuide({ title: 'G' });
  const a = store.addStep(guide.guideId, { title: 'A' });
  const b = store.addStep(guide.guideId, { title: 'B' });
  const source = `| Key | Value |\n|---|---|\n| x | 1 |\n\nThen see [Step 2](step:${b.stepId}).\n\n<script>bad()</script>`;
  store.saveStep(guide.guideId, { ...store.getStep(guide.guideId, a.stepId), descriptionMarkdown: source, descriptionHtml: html(source) });
  store.saveGuide({ ...store.getGuide(guide.guideId), stepsOrder: [b.stepId, a.stepId] });
  const ast = buildRenderAst(store, guide.guideId);
  const step = ast.steps.find((s) => s.stepId === a.stepId);
  assert.match(step.descriptionMarkdown, new RegExp(`\\[Step 1\\]\\(step:${b.stepId}\\)`));
  assert.match(step.descriptionHtml, />Step 1<\/a>/);
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  const md = fs.readFileSync(runExport('markdown', ast, out).file, 'utf8');
  assert.match(md, /\| Key \| Value \|\n\|---\|---\|/);
  assert.match(md, /\[Step 1\]\(#step-1\)/);
  assert.doesNotMatch(md, /script/);
});

test('links need no https://: bare domains, www. and [text](domain) link to https', () => {
  const out = html('See example.com, www.stepforge.dev and [docs](docs.github.com/en). Not file.txt or v1.2.');
  assert.match(out, /<a href="https:\/\/example.com">example.com<\/a>/);
  assert.match(out, /<a href="https:\/\/www.stepforge.dev">/);
  assert.match(out, /<a href="https:\/\/docs.github.com\/en">docs<\/a>/);
  assert.doesNotMatch(out, /file\.txt<\/a>|v1\.2<\/a>/);
  const { findLinks } = require('../../core/markdown-description');
  assert.deepEqual(findLinks('go to google.com now').map((l) => l.url), ['https://google.com']);
});

test('a saved Markdown source survives a renderer that would draw it differently', () => {
  const source = '**Kept** as written';
  // HTML an older renderer made: not what a fresh render gives today.
  const older = '<p><b>Kept</b> as written</p>';
  assert.notEqual(html(source), older);
  const { descriptionMarkdownFor } = createStep({ descriptionMarkdown: '', descriptionHtml: older });
  const kept = createStep({ descriptionMarkdown: source, descriptionHtml: older, descriptionMarkdownFor });
  assert.equal(kept.descriptionMarkdown, source);
  assert.equal(kept.descriptionHtml, older);
  const changedRender = createStep({ descriptionMarkdown: source, descriptionHtml: '<p><strong>Kept</strong> as written!</p>', descriptionMarkdownFor: 'stale' });
  assert.equal(changedRender.descriptionMarkdown, '**Kept** as written!', 'a real rewrite still rebuilds the source');
});
