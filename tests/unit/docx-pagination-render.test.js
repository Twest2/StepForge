'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { exportDocx } = require('../../exporters/docx');
const { paginationFixture } = require('./docx-pagination-fixture');
const fixtures = require('../fixtures/docx-pagination.json');

const missing = ['libreoffice', 'pdftotext', 'pdfimages'].filter(tool => {
  try {
    execFileSync(tool, [tool === 'libreoffice' ? '--version' : '-v'], { stdio: 'pipe' });
    return false;
  } catch { return true; }
});
const options = { skip: missing.length ? `Optional rendering tools unavailable: ${missing.join(', ')}` : false, timeout: 120000 };

function rendered(t, specs, settings = {}) {
  const fixture = paginationFixture(t, specs, settings);
  const out = path.join(fixture.root, 'out');
  const { file } = exportDocx(fixture.ast, out, { includeToc: false });
  // A private profile prevents interference with a user's running office app.
  execFileSync('libreoffice', [`-env:UserInstallation=${pathToFileURL(path.join(fixture.root, 'office-profile')).href}`,
    '--headless', '--convert-to', 'pdf', '--outdir', out, file], { stdio: 'pipe', timeout: 90000 });
  const pdf = file.replace(/\.docx$/, '.pdf');
  const text = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' });
  const pages = text.replace(/\f\s*$/, '').split('\f');
  const listing = execFileSync('pdfimages', ['-list', pdf], { encoding: 'utf8' });
  const imagePages = listing.split('\n').filter(line => /^\s*\d+\s+\d+\s+image\s/.test(line))
    .map(line => Number(line.trim().split(/\s+/)[0]));
  assert.equal(imagePages.length, fixture.ast.steps.filter(s => s.image).length);
  pages.forEach((page, i) => assert.ok(page.trim() || imagePages.includes(i + 1), `page ${i + 1} is not blank`));
  const pageOfHeading = step => {
    const number = step.number.replace(/\./g, '\\.');
    const index = pages.findIndex(page => new RegExp(`^\\s*${number}\\.\\s`, 'm').test(page));
    assert.ok(index >= 0, `heading ${step.number} is present`);
    return index + 1;
  };
  return { ...fixture, pages, imagePages, pageOfHeading };
}

test('DOCX pagination rendering: fitting substeps/captions stay together without keeping their entire process', options, t => {
  const specs = [{ key: 'process', title: 'Configure the workspace', newPage: true }];
  for (let i = 1; i <= 12; i++) specs.push({
    parent: 'process', title: `Complete action ${i}`, instructions: 'Choose an option and review its result.',
    screenshot: [1200, 650], notes: [{ position: 'after-image', title: `Check ${i}`, text: 'Confirm this example before continuing.' }],
  });
  specs.push({ title: 'Verify the workspace', newPage: true, instructions: 'Review the completed setup.', screenshot: [1200, 650] });
  const r = rendered(t, specs);
  r.ast.steps.filter(s => s.image).forEach((step, i) => {
    assert.equal(r.pageOfHeading(step), r.imagePages[i], `step ${step.number} stays with its picture`);
    if (i < 12) assert.ok(r.pages[r.imagePages[i] - 1].includes(`Check ${i + 1}`), 'caption stays with picture');
  });
  assert.ok(new Set(r.imagePages.slice(0, 12)).size > 1, 'siblings flow onto multiple pages');
  r.ast.steps.filter(s => s.forceNewPage).forEach(step => {
    assert.match(r.pages[r.pageOfHeading(step) - 1], new RegExp(`^\\s*${step.number}\\.\\s`));
  });
});

test('DOCX pagination rendering: oversized instructions split while the picture/caption suffix stays together', options, t => {
  const r = rendered(t, fixtures.oversized.map(s => ({ ...s, repeat: s.repeat ? 240 : undefined })));
  assert.ok(r.pages.length > 2);
  assert.ok(r.pages[r.imagePages[0] - 1].includes('Check the result'));
  assert.equal(r.pageOfHeading(r.ast.steps[1]), r.imagePages[1], 'the independent next step stays intact');
});

test('DOCX pagination rendering: a tall picture fits without stranding its heading or inserting blank pages', options, t => {
  const r = rendered(t, [{ title: 'Inspect the tall example', screenshot: [100, 3000] }, fixtures.ordinary[0]]);
  r.ast.steps.forEach((step, i) => assert.equal(r.pageOfHeading(step), r.imagePages[i]));
  assert.ok(r.pages.length <= 3, 'cover and at most one page per step');
});

test('DOCX pagination rendering: an oversized side-by-side row can span pages before the next step', options, t => {
  const r = rendered(t, fixtures.oversized.map(s => ({ ...s, repeat: s.repeat ? 240 : undefined })), { sideBySide: true });
  assert.ok(r.pages.length > 2);
  assert.equal(r.pageOfHeading(r.ast.steps[1]), r.imagePages[1]);
  assert.ok(r.imagePages[1] > r.imagePages[0]);
});
