'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { markdownHtml } = require('../../core/placeholder-markdown');
const { expandPlaceholders, expandRichPlaceholders, resolveScopes } = require('../../core/placeholders');
const { GuideStore } = require('../../core/store');
const { Settings } = require('../../core/settings');
const { buildRenderAst } = require('../../core/renderast');
const { makeTmpDir, rmrf } = require('./helpers');
const md = text => ({ format: 'markdown', text });

test('Markdown preserves paragraphs, lists, links, and literal code safely', () => {
  const html = markdownHtml('**Bold** and *italic*\nnext\n\n- One\n- Two\n\n[Help](https://example.com)\n\n```\n<script>literal</script>\n```');
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<em>italic<\/em><br>next/);
  assert.match(html, /<ul><li>One<\/li><li>Two<\/li><\/ul>/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /&lt;script&gt;literal/);
  assert.doesNotMatch(markdownHtml('[bad](javascript:alert) <img onerror=alert(1)>'), /href=|<img/);
});

test('opt-in formatting preserves old strings, overrides, and unresolved tokens', () => {
  const globals = { Text: md('**Formatted**'), Legacy: '**literal**' };
  assert.equal(expandPlaceholders('[[Text]] [[Legacy]] [[Missing]]', globals), 'Formatted **literal** [[Missing]]');
  assert.equal(expandRichPlaceholders('<p>[[Text]]</p>', globals), '<p><strong>Formatted</strong></p>');
  assert.equal(expandPlaceholders('[[Text]]', resolveScopes({ globals, guide: { placeholders: { Text: 'Override' } } })), 'Override');
  const html = expandRichPlaceholders('<a title="[[Text]]">[[Text]]</a>', { Text: md('**Text**') });
  assert.match(html, /title="Text"/);
});

test('Markdown source persists and renders through the common export AST', t => {
  const root = makeTmpDir('markdown-placeholder'); t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const settings = new Settings(store.settingsDir);
  settings.setGlobalPlaceholders({ Help: md('**First**\n\n- Second\n- Third') });
  const loaded = new Settings(store.settingsDir).getGlobalPlaceholders();
  assert.equal(loaded.Help.text, '**First**\n\n- Second\n- Third');
  const guide = store.createGuide({ title: '[[Help]]', descriptionHtml: '<p>[[Help]]</p>' });
  const ast = buildRenderAst(store, guide.guideId, { globals: loaded });
  assert.doesNotMatch(ast.guide.title, /\*\*|<strong>/);
  assert.match(ast.guide.descriptionHtml, /<strong>First<\/strong>/);
  assert.match(ast.guide.descriptionHtml, /<li>Second<\/li>/);
});
