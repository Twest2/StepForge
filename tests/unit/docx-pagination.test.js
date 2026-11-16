'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { exportDocx } = require('../../exporters/docx');
const { renderStepImage } = require('../../core/renderast');
const { encodePng } = require('../../core/png');
const { unzipSync } = require('../../core/zip');
const { paginationFixture } = require('./docx-pagination-fixture');
const fixtures = require('../fixtures/docx-pagination.json');

function exported(t, specs = fixtures.ordinary, options = {}) {
  const fixture = paginationFixture(t, specs, options);
  const result = exportDocx(fixture.ast, path.join(fixture.root, 'out'), { includeToc: false, ...options });
  const entries = unzipSync(fs.readFileSync(result.file));
  const xml = entries.find(e => e.name === 'word/document.xml').data.toString();
  // Fixtures contain no tables unless explicitly requested; match actual
  // emitted paragraphs rather than inspecting the exporter implementation.
  const paragraphs = xml.match(/<w:p>[\s\S]*?<\/w:p>/g);
  const first = paragraphs.findIndex(p => p.includes('<w:bookmarkStart'));
  return { ...fixture, result, xml, entries, paragraphs: paragraphs.slice(first) };
}

const props = xml => xml.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/)?.[1] || '';
const kept = xml => /<w:keepNext w:val="1"\/>/.test(props(xml));
const ended = xml => /<w:keepNext w:val="0"\/>/.test(props(xml));
const linesKept = xml => /<w:keepLines w:val="1"\/>/.test(props(xml));
const pictures = r => r.paragraphs.filter(p => p.includes('<w:drawing>'));

test('DOCX pagination: heading, instructions and screenshot stay together within one step', t => {
  const { paragraphs: p } = exported(t);
  assert.equal(p.length, 6);
  p.forEach((xml, i) => {
    assert.equal(kept(xml), i % 3 !== 2);
    assert.ok(linesKept(xml));
  });
});

test('DOCX pagination: process headings attach to their first child, not all siblings', t => {
  const r = exported(t, fixtures.nested);
  assert.deepEqual(r.ast.steps.map(s => s.number), ['1', '1.1', '1.2', '2']);
  assert.match(r.xml, /<w:pStyle w:val="Heading2"\/>/);
  assert.equal(pictures(r).length, 3);
  pictures(r).forEach(xml => assert.ok(ended(xml), 'each substep ends at its own screenshot'));
  assert.match(props(r.paragraphs[0]), /<w:pageBreakBefore\/>/);
});

test('DOCX pagination: a short caption ends its own picture chain', t => {
  const { paragraphs: p } = exported(t, fixtures.caption);
  assert.equal(p.length, 4);
  p.slice(0, -1).forEach(xml => assert.ok(kept(xml)));
  assert.ok(ended(p[3]) && linesKept(p[3]));
  assert.match(p[3], /This example is illustrative; your setup may differ/);
});

test('DOCX pagination: intervening callouts remain attached to the picture', t => {
  const positions = ['before-title', 'after-title', 'before-description', 'after-description', 'before-image'];
  const r = exported(t, [{ ...fixtures.ordinary[0], notes: positions.map((position, i) => ({
    position, level: i % 2 ? 'warn' : 'info', title: `Check ${i + 1}`, text: 'Review this example.' })) }]);
  // before-title is before the first bookmark, so inspect all body paragraphs
  // after the cover's explicit page break, including that leading callout.
  const body = r.xml.split('<w:br w:type="page"/>')[1];
  const p = body.match(/<w:p>[\s\S]*?<\/w:p>/g);
  assert.equal(p.length, 8);
  p.slice(0, -1).forEach(xml => assert.ok(kept(xml) && linesKept(xml)));
  assert.ok(ended(p.at(-1)));
});

test('DOCX pagination: a heading without instructions stays with its screenshot', t => {
  const { paragraphs: p } = exported(t, [{ ...fixtures.ordinary[0], instructions: '' }]);
  assert.equal(p.length, 2);
  assert.ok(kept(p[0]) && ended(p[1]));
});

test('DOCX pagination: oversized instructions can split before a fitting image/caption suffix', t => {
  const { paragraphs: p } = exported(t, fixtures.oversized);
  assert.ok(kept(p[0]));
  assert.ok(ended(p[1]));
  assert.match(props(p[1]), /<w:keepLines w:val="0"\/>/);
  assert.ok(kept(p[2]) && ended(p[3]));
});

test('DOCX pagination: long trailing commentary is not made into a picture caption', t => {
  const { paragraphs: p } = exported(t, [{ ...fixtures.ordinary[0], notes: [{
    position: 'after-image', title: 'More information', text: 'Additional explanation. '.repeat(2000) }] }]);
  assert.ok(ended(p[2]) && ended(p[3]));
  assert.ok(!linesKept(p[3]));
});

test('DOCX pagination: forced page breaks and heading style definitions are retained', t => {
  const r = exported(t, fixtures.ordinary.map(s => ({ ...s, newPage: true })));
  const heads = r.paragraphs.filter(p => p.includes('<w:bookmarkStart'));
  assert.equal(heads.length, 2);
  heads.forEach(p => {
    assert.match(props(p), /<w:pageBreakBefore\/>/);
    assert.match(props(p), /<w:pStyle w:val="Heading1"\/>/);
    assert.ok(kept(p));
  });
  assert.equal((r.xml.match(/<w:pageBreakBefore\/>/g) || []).length, 2);
});

test('DOCX pagination: a forced-page step starts with its before-title callout', t => {
  const r = exported(t, [{ ...fixtures.ordinary[0], newPage: true,
    notes: [{ position: 'before-title', title: 'Before starting', text: 'Check the example.' }] }]);
  const body = r.xml.split('<w:br w:type="page"/>')[1];
  const p = body.match(/<w:p>[\s\S]*?<\/w:p>/g);
  assert.match(props(p[0]), /<w:pageBreakBefore\/>/);
  assert.doesNotMatch(props(p[1]), /<w:pageBreakBefore\/>/);
  // CT_PPr order: keepLines, pageBreakBefore, then the callout's border/shading.
  assert.match(props(p[0]), /<w:keepLines w:val="1"\/><w:pageBreakBefore\/><w:shd\b/);
});

test('DOCX pagination: fitting side-by-side rows stay atomic, oversized rows can split', t => {
  const normal = exported(t, fixtures.ordinary.slice(0, 1), { sideBySide: true });
  const long = exported(t, fixtures.oversized.slice(0, 1), { sideBySide: true });
  assert.match(normal.xml, /<w:cantSplit\/>/);
  assert.doesNotMatch(long.xml, /<w:cantSplit\/>/);
});

test('DOCX pagination: a standalone title-only step does not attach to the next step', t => {
  const { paragraphs: p } = exported(t, [{ title: 'Section summary' }, fixtures.ordinary[0]]);
  assert.ok(ended(p[0]));
});

test('DOCX pagination: image-free exports do not keep instructions with an independent step', t => {
  const r = exported(t, fixtures.ordinary, { includeImages: false });
  assert.doesNotMatch(r.xml, /<w:drawing>/);
  r.paragraphs.filter(p => !p.includes('<w:bookmarkStart')).forEach(p => assert.ok(!kept(p)));
});

test('DOCX pagination: tall pictures fit their page without rewriting annotated image bytes', t => {
  const r = exported(t, [{ title: 'Inspect the tall example', screenshot: [100, 3000], annotations: [{
    type: 'oval', x: 0.2, y: 0.1, w: 0.5, h: 0.02, style: { stroke: '#E5484D', strokeWidth: 3 } }] }]);
  const extent = Number(r.xml.match(/<wp:extent cx="\d+" cy="(\d+)"/)[1]);
  assert.ok(extent / 635 <= 13130);
  const png = r.entries.find(e => e.name.startsWith('word/media/')).data;
  const expected = encodePng(renderStepImage(r.ast.steps[0]));
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(png), hash(expected));
});

test('DOCX pagination: very narrow tall pictures keep visible, proportional extents', t => {
  const r = exported(t, [1, 2].map(i => ({ title: `Narrow example ${i}`, screenshot: [1, i === 1 ? 2000 : 20000] })));
  const extents = [...r.xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)].map(m => [Number(m[1]), Number(m[2])]);
  assert.equal(extents.length, 2);
  for (const [cx, cy] of extents) {
    assert.ok(cx > 0 && cy > 0, `extent ${cx}x${cy} is visible`);
    assert.ok(cy / 635 <= 13130, 'fits the printable height');
  }
  assert.ok(Math.abs(extents[0][1] / extents[0][0] - 2000) / 2000 < 0.01, 'aspect ratio is preserved');
});

test('DOCX pagination: Normal has no global keeps and Heading styles retain their keeps', t => {
  const r = exported(t);
  const styles = r.entries.find(e => e.name === 'word/styles.xml').data.toString();
  const normal = styles.match(/<w:style[^>]*w:styleId="Normal"[\s\S]*?<\/w:style>/)[0];
  assert.doesNotMatch(normal, /<w:keep(?:Next|Lines)/);
  assert.equal((styles.match(/<w:keepNext\/>/g) || []).length, 3);
  assert.equal((styles.match(/<w:keepLines\/>/g) || []).length, 3);
});
