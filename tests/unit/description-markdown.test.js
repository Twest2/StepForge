'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { descriptionToMarkdown, descriptionFromMarkdown } = require('../../core/description-markdown');
const { htmlToMarkdown } = require('../../exporters/htmlmd');

const roundTrip = (markdown) => {
  const html = descriptionFromMarkdown(markdown);
  return { html, again: descriptionFromMarkdown(descriptionToMarkdown(html)) };
};

test('guide descriptions turn Markdown into formatting', () => {
  const html = descriptionFromMarkdown('**Bold**, *italic* and `npm test`\n\n- One\n- Two\n\n1. First\n\n[Docs](https://example.com)');
  assert.equal(html,
    '<p><strong>Bold</strong>, <em>italic</em> and <code>npm test</code></p>'
    + '<ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol>'
    + '<p><a href="https://example.com">Docs</a></p>');
});

test('plain text keeps its line breaks, and a blank line starts a new paragraph', () => {
  assert.equal(descriptionFromMarkdown('  Line one  \nline two\n\n\n\nNew paragraph\n'),
    '<p>Line one<br>line two</p><p>New paragraph</p>');
  assert.equal(descriptionFromMarkdown('Price is 5 * 3 * 2'), '<p>Price is 5 * 3 * 2</p>');
  assert.equal(descriptionFromMarkdown('   \n'), '');
});

test('raw HTML in a description stays text', () => {
  const html = descriptionFromMarkdown('<script>alert(1)</script> & <b>not bold</b>');
  assert.equal(html, '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;not bold&lt;/b&gt;</p>');
  assert.equal(descriptionToMarkdown(html), '<script>alert(1)</script> & <b>not bold</b>');
});

test('opening and saving a description without changes keeps its formatting', () => {
  for (const markdown of [
    '**Bold** and *italic* with `<b>code</b>`\n\n- One\n- **Two**\n\n1. First\n2. Second',
    '[Docs](https://example.com/a?b=1&c=2) and [step 2](step:abc123)',
    '```\nnpm install\n<x> &amp;\n```',
    'Use [[Product]] here\n\n[[Footer]]',
    '- <b>x</b> &amp;lt;',
  ]) {
    const { html, again } = roundTrip(markdown);
    assert.equal(again, html, markdown);
  }
  assert.equal(descriptionToMarkdown('<p>See <a href="step:abc123">step 2</a>.</p>'), 'See [step 2](step:abc123).');
});

test('Markdown exports keep escaped text and code inside descriptions', () => {
  assert.equal(htmlToMarkdown('<p>Run <code>&lt;div&gt;</code></p><pre><code>a &lt;b&gt; &amp;amp;</code></pre>'),
    'Run `<div>`\n\n```\na <b> &amp;\n```');
  assert.equal(htmlToMarkdown('<ul><li>&lt;b&gt;x&lt;/b&gt;</li></ul>'), '- <b>x</b>');
});

test('headings, quotes, dividers and ~~strikethrough~~ become formatting; _underscores_ stay text', () => {
  assert.equal(descriptionFromMarkdown('# Title\n## Part\n#### Small\n###### Tiny ##'),
    '<h1>Title</h1><h2>Part</h2><h4>Small</h4><h4>Tiny</h4>');
  assert.equal(descriptionFromMarkdown('#hashtag and C# stay text'), '<p>#hashtag and C# stay text</p>');
  assert.equal(descriptionFromMarkdown('> Quoted **text**\n> - item\n>\n> > Nested'),
    '<blockquote><p>Quoted <strong>text</strong></p><ul><li>item</li></ul><blockquote><p>Nested</p></blockquote></blockquote>');
  assert.equal(descriptionFromMarkdown('Above\n\n---\n\n* * *\nBelow'), '<p>Above</p><hr><hr><p>Below</p>');
  assert.equal(descriptionFromMarkdown('~~Old~~ new, 2~3, _not italic_'), '<p><s>Old</s> new, 2~3, _not italic_</p>');
});

test('lists nest by indenting, mix kinds, and continue across blank lines', () => {
  assert.equal(descriptionFromMarkdown('- One\n  - Sub\n    - Deep\n  - Sub 2\n- Two\n\n- Three\n\n1. First\n   * Point\n2) Second'),
    '<ul><li>One<ul><li>Sub<ul><li>Deep</li></ul></li><li>Sub 2</li></ul></li><li>Two</li><li>Three</li></ul>'
    + '<ol><li>First<ul><li>Point</li></ul></li><li>Second</li></ol>');
  assert.equal(descriptionFromMarkdown('- Item\n  more of it\nAfter'), '<ul><li>Item<br>more of it</li></ul><p>After</p>');
});

test('tables need a | --- | line under the header; cells keep formatting and escaped pipes', () => {
  assert.equal(descriptionFromMarkdown('| Setting | Value |\n|:--|--:|\n| **Port** | 80 \\| 443 |\n| Only one |\n\nAfter'),
    '<table><thead><tr><th>Setting</th><th>Value</th></tr></thead>'
    + '<tbody><tr><td><strong>Port</strong></td><td>80 | 443</td></tr><tr><td>Only one</td><td></td></tr></tbody></table>'
    + '<p>After</p>');
  assert.equal(descriptionFromMarkdown('a | b\nnot a table'), '<p>a | b<br>not a table</p>');
});

test('every new syntax survives reopening Guide information unchanged', () => {
  const markdown = [
    '# Title', '## Part', '> Quote with **bold**', '>', '> - item', '---',
    '- One', '  - Sub', '    - Deep', '- Two', '1. First', '2. Second',
    '| A | B |', '| --- | --- |', '| **1** | 2 \\| 3 |', '~~gone~~ and `code`',
  ].join('\n\n');
  const { html, again } = roundTrip(markdown);
  assert.equal(again, html);
  assert.match(descriptionToMarkdown(html), /- One\n {2}- Sub\n {4}- Deep\n- Two/);
});

test('plain-text exports keep list text and separate table cells', () => {
  const { htmlToText } = require('../../core/util');
  assert.equal(htmlToText(descriptionFromMarkdown('Intro\n\n- One\n  - Sub\n1. First\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> Quote\n\n---\n\n~~gone~~')),
    'Intro\n• One\n• Sub\n• First\nA | B\n1 | 2\nQuote\ngone');
  assert.equal(htmlToText('<ul><li class="x">One</li></ul>'), '• One');
});

test('rich exports: PDF shows table cells apart and strikes text, Word gets a real table, Markdown keeps nesting', (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const zlib = require('node:zlib');
  const { buildFixtureGuide } = require('./fixture-guide');
  const { makeTmpDir, rmrf } = require('./helpers');
  const { buildRenderAst } = require('../../core/renderast');
  const { exportPdf } = require('../../exporters/pdf');
  const { buildConfluenceWord } = require('../../exporters/confluence-word');
  const { unzipSync } = require('../../core/zip');
  const { htmlToBlocks } = require('../../core/htmlblocks');
  const { exportMarkdown } = require('../../exporters/markdown');

  const root = makeTmpDir('desc-md-exports');
  t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const withDescription = (markdown) => {
    const g = store.getGuide(guide.guideId);
    g.descriptionHtml = descriptionFromMarkdown(markdown);
    store.saveGuide(g);
    return buildRenderAst(store, guide.guideId);
  };
  const coverOps = (ast, name) => {
    const buf = fs.readFileSync(exportPdf(ast, path.join(root, name), { includeImages: false }).file);
    const m = /\d+ 0 obj\n<< \/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/.exec(buf.toString('latin1'));
    return zlib.inflateSync(buf.subarray(m.index + m[0].length, m.index + m[0].length + Number(m[1]))).toString('latin1');
  };

  const table = '| Setting | Value |\n| --- | --- |\n| Port | 443 |';
  assert.deepEqual(htmlToBlocks(descriptionFromMarkdown(table)).map((b) => [b.type, b.header, b.cells]),
    [['tr', true, ['Setting', 'Value']], ['tr', false, ['Port', '443']]]);
  // A real table: a bordered cell per column on each row, a shaded header,
  // and each column's text starting one column width further right.
  const tableOps = coverOps(withDescription(table), 'pdf-table');
  const cellX = (word) => Number(new RegExp(`1 0 0 1 ([\\d.]+) ([\\d.]+) Tm [^\\n]*\\(${word}\\) Tj`).exec(tableOps)[1]);
  const cells = [...tableOps.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re S/g)].map((m) => m.slice(1).map(Number));
  assert.equal(cells.length, 4, 'two rows of two bordered cells');
  const colW = cells[0][2];
  assert.ok(Math.abs(cellX('443') - cellX('Port') - colW) < 0.01);
  assert.ok(Math.abs(cellX('Value') - cellX('Setting') - colW) < 0.01);
  assert.ok(Math.abs(cellX('Port') - cellX('Setting')) < 0.01);
  assert.match(tableOps, /\/F2 [\d.]+ Tf [^\n]*\(Setting\) Tj/, 'header cells are bold');
  assert.ok(!/\(\|\) Tj/.test(tableOps), 'no text separators between cells');

  const fills = (ops) => (ops.match(/ re f\b/g) || []).length;
  assert.equal(fills(coverOps(withDescription('Use ~~old~~ new'), 'pdf-strike')) - fills(coverOps(withDescription('Use old new'), 'pdf-plain')), 1);
  // The line spans exactly "old" (Helvetica widths at the 12 pt cover size), starting after "Use ".
  const { standardTextWidth } = require('../../core/pdf-metrics');
  const struck = coverOps(withDescription('Use ~~old~~ new'), 'pdf-strike-2');
  const textX = Number(/1 0 0 1 ([\d.]+) [\d.]+ Tm \/F1 12 Tf [\d. ]+rg \(Use\) Tj/.exec(struck)[1]);
  const line = [...struck.matchAll(/([\d.]+) [\d.]+ ([\d.]+) ([\d.]+) re f/g)].find((m) => Number(m[3]) < 1);
  assert.ok(Math.abs(Number(line[1]) - (textX + standardTextWidth('Use ', 12, 'F1'))) < 0.02);
  assert.ok(Math.abs(Number(line[2]) - standardTextWidth('old', 12, 'F1')) < 0.02);
  assert.equal(standardTextWidth('old', 10, 'F2'), (611 + 278 + 611) / 100);
  assert.equal(standardTextWidth('abc', 10, 'F3'), 18);
  assert.equal(standardTextWidth('café', 10, 'F1'), null);
  assert.equal(standardTextWidth('a', 10, 'F9'), null);

  const docx = unzipSync(buildConfluenceWord(withDescription(`${table}\n\n~~gone~~`), new Map(), { includeImages: false }));
  const xml = docx.find((e) => e.name === 'word/document.xml').data.toString('utf8');
  assert.match(xml, /<w:tbl>[\s\S]*Setting[\s\S]*Port[\s\S]*443[\s\S]*<\/w:tbl>/);
  assert.match(xml, /<w:strike\/><\/w:rPr><w:t xml:space="preserve">gone</);

  const md = fs.readFileSync(exportMarkdown(withDescription('- One\n  - Sub\n> Quote **bold**'), path.join(root, 'md')).file, 'utf8');
  assert.match(md, /- One\n {2}- Sub\n\n> Quote \*\*bold\*\*/);
});

test('PDF headings get a size per level; continued list lines and pasted dividers keep their structure', (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const zlib = require('node:zlib');
  const { buildFixtureGuide } = require('./fixture-guide');
  const { makeTmpDir, rmrf } = require('./helpers');
  const { buildRenderAst } = require('../../core/renderast');
  const { exportPdf } = require('../../exporters/pdf');
  const { buildConfluenceWord } = require('../../exporters/confluence-word');
  const { unzipSync } = require('../../core/zip');

  const root = makeTmpDir('desc-md-levels');
  t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const withDescription = (markdown) => {
    const g = store.getGuide(guide.guideId);
    g.descriptionHtml = descriptionFromMarkdown(markdown);
    store.saveGuide(g);
    return buildRenderAst(store, guide.guideId);
  };
  const coverOps = (ast, name) => {
    const buf = fs.readFileSync(exportPdf(ast, path.join(root, name), { includeImages: false }).file);
    const m = /\d+ 0 obj\n<< \/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/.exec(buf.toString('latin1'));
    return zlib.inflateSync(buf.subarray(m.index + m[0].length, m.index + m[0].length + Number(m[1]))).toString('latin1');
  };
  // Font size and x position of the text run that draws `word`.
  const drawn = (ops, word) => {
    const m = new RegExp(`1 0 0 1 ([\\d.]+) ([\\d.]+) Tm /F\\d+ ([\\d.]+) Tf [^\\n]*\\(${word}\\) Tj`).exec(ops);
    return m && { x: Number(m[1]), y: Number(m[2]), size: Number(m[3]) };
  };

  const headings = coverOps(withDescription('# One\n## Two\n### Three\n#### Four\n\nBody'), 'pdf-headings');
  const sizes = ['One', 'Two', 'Three', 'Four', 'Body'].map((word) => drawn(headings, word).size);
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i - 1] - sizes[i] >= 0.5, `level ${i} (${sizes[i - 1]}pt) is clearly bigger than the next (${sizes[i]}pt)`);
  assert.ok(sizes[0] >= sizes[4] * 1.5, 'a top heading is at least half again the body size');

  // Pasted text often has non-breaking spaces; "* * *" is still a divider.
  assert.equal(descriptionFromMarkdown('Above\n\n* * *\n\nBelow'), '<p>Above</p><hr><p>Below</p>');

  // The indented line continues the bullet: no second bullet, aligned with the item's text.
  const list = coverOps(withDescription('- Third bullet\n  continued below\n- Next'), 'pdf-cont');
  const item = drawn(list, 'Third');
  const cont = drawn(list, 'continued');
  // The bullet is byte 0x95 (WinAnsi •), drawn on its own before each item.
  assert.equal((list.match(/\(\x95\) Tj/g) || []).length, 2, 'two bullets for two items');
  assert.ok(Math.abs(cont.x - item.x) < 0.01 && cont.y < item.y);

  // Word (Confluence): the continuation is an indented paragraph without a list number.
  const docx = unzipSync(buildConfluenceWord(withDescription('1. First\n   still first\n2. Second'), new Map(), { includeImages: false }));
  const xml = docx.find((entry) => entry.name === 'word/document.xml').data.toString('utf8');
  const paragraphOf = (word) => xml.split('</w:p>').find((p) => p.includes(`>${word}`));
  assert.match(paragraphOf('First'), /<w:numPr>/);
  assert.doesNotMatch(paragraphOf('still first'), /<w:numPr>/);
  assert.match(paragraphOf('still first'), /<w:ind w:left="720"\/>/);
  assert.match(paragraphOf('Second'), /<w:numPr>/);
});
