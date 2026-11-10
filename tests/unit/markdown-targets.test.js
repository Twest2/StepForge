'use strict';

// Export → Markdown → Compatibility → "Write for": GitHub, Azure DevOps,
// MkDocs and Docusaurus output, and templates saved with the old switches.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildRenderAst } = require('../../core/renderast');
const { exportMarkdown, OPTION_INFO, markdownTarget } = require('../../exporters/markdown');
const { mdxSafe } = require('../../exporters/markdown-guide');
const { TemplateManager } = require('../../core/templates');
const { buildFixtureGuide } = require('./fixture-guide');
const { makeTmpDir, rmrf } = require('./helpers');

function exportAs(t, options) {
  const root = makeTmpDir('mdtarget');
  t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const ast = buildRenderAst(store, guide.guideId);
  const outDir = path.join(root, 'out');
  const { file } = exportMarkdown(ast, outDir, options);
  return { md: fs.readFileSync(file, 'utf8'), outDir };
}

test('Write for: a dropdown of the five targets, Any Markdown viewer by default', () => {
  assert.deepEqual(OPTION_INFO.target.choices.map((c) => c.value), ['standard', 'github', 'azure', 'mkdocs', 'docusaurus']);
  assert.equal(OPTION_INFO.target.group, 'Compatibility');
  // The width only shows for Azure DevOps.
  assert.equal(OPTION_INFO.imageMaxWidth.dependsOn, 'target');
  assert.equal(OPTION_INFO.imageMaxWidth.dependsOnValue, 'azure');
  assert.equal(OPTION_INFO.githubAlerts, undefined);
  assert.equal(OPTION_INFO.azureWiki, undefined);
});

test('Any Markdown viewer is unchanged: styled HTML callouts and an accent bar, no front matter', (t) => {
  const { md } = exportAs(t, {});
  assert.ok(md.startsWith('# Configure AcmeSync backups\n'));
  assert.ok(md.includes('<div class="sf-callout sf-callout-warning"'));
  assert.ok(md.includes('<div style="height:4px;'));
});

test('GitHub writes alerts, also for options saved as githubAlerts', (t) => {
  for (const options of [{ target: 'github' }, { githubAlerts: true }]) {
    const { md } = exportAs(t, options);
    assert.ok(!md.includes('<div'), 'no styled HTML');
    assert.ok(md.includes('> [!WARNING]\n> **Access**\n> Admins only.'));
  }
});

test('Azure DevOps sizes screenshots with =WIDTHx, only when a width is set', (t) => {
  assert.match(exportAs(t, { target: 'azure', imageMaxWidth: 600 }).md, /!\[[^\]]*\]\(steps-[^)]+\.png =600x\)/);
  assert.match(exportAs(t, { azureWiki: true, imageMaxWidth: 400 }).md, / =400x\)/);
  assert.doesNotMatch(exportAs(t, { target: 'azure' }).md, / =\d+x\)/);
  // Other targets ignore a leftover width.
  assert.doesNotMatch(exportAs(t, { target: 'mkdocs', imageMaxWidth: 600 }).md, / =\d+x\)/);
});

test('MkDocs: title front matter and !!! admonitions with an indented body', (t) => {
  const { md } = exportAs(t, { target: 'mkdocs' });
  assert.ok(md.startsWith('---\ntitle: "Configure AcmeSync backups"\n---\n\n# Configure AcmeSync backups\n'));
  assert.ok(md.includes('!!! warning "Access"\n    Admins only.\n'), md);
  assert.ok(!md.includes('<div'), 'no styled HTML');
  assert.ok(md.includes('```'), 'code blocks stay fenced');
});

test('Docusaurus: front matter, ::: admonitions, ./ image links, no HTML that MDX rejects', (t) => {
  const { md } = exportAs(t, { target: 'docusaurus' });
  assert.ok(md.startsWith('---\ntitle: "Configure AcmeSync backups"\n---\n'));
  assert.ok(md.includes(':::warning[Access]\n\nAdmins only.\n\n:::'), md);
  assert.match(md, /!\[[^\]]*\]\(\.\/steps-[^)]+\.png\)/);
  assert.ok(!md.includes('<div'));
  assert.ok(!/<img|style="/.test(md), 'no <img> or style strings');
  // Only the step anchors remain as tags.
  for (const tag of md.match(/<[a-z][^>]*>/g) || []) assert.match(tag, /^<a id="step-[\w-]+">$/);
});

test('mdxSafe escapes { } < outside code and keeps anchors, fences and inline code', () => {
  const src = [
    '<a id="step-1"></a>',
    'Set {name} to <value> and a\\<b',
    'Run `echo {x} <y>` now',
    '```json',
    '{ "a": "<b>" }',
    '```',
    '> quote',
  ].join('\n');
  assert.equal(mdxSafe(src), [
    '<a id="step-1"></a>',
    'Set \\{name\\} to \\<value> and a\\<b',
    'Run `echo {x} <y>` now',
    '```json',
    '{ "a": "<b>" }',
    '```',
    '> quote',
  ].join('\n'));
});

test('templates saved with the old switches load as the matching choice', (t) => {
  const root = makeTmpDir('mdtpl');
  t.after(() => rmrf(root));
  const templates = new TemplateManager(root);
  templates.save('markdown', 'Gh', { toc: false, githubAlerts: true, azureWiki: false });
  templates.save('markdown', 'Az', { githubAlerts: false, azureWiki: true, imageMaxWidth: 500 });
  templates.save('markdown', 'Plain', { githubAlerts: false, azureWiki: false });
  templates.save('markdown', 'New', { target: 'docusaurus' });
  assert.deepEqual(templates.load('markdown', 'Gh'), { toc: false, target: 'github' });
  assert.deepEqual(templates.load('markdown', 'Az'), { imageMaxWidth: 500, target: 'azure' });
  assert.deepEqual(templates.load('markdown', 'Plain'), { target: 'standard' });
  assert.deepEqual(templates.load('markdown', 'New'), { target: 'docusaurus' });
  assert.equal(markdownTarget({ target: 'nonsense' }), 'standard');
});
