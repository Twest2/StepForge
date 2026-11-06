'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildRenderAst } = require('../../core/renderast');
const { BrandingStore } = require('../../core/branding');
const { runExport } = require('../../exporters');
const { exportClipboard, preferSmallerImages } = require('../../exporters/clipboard');
const { decodePng, encodePng } = require('../../core/png');
const raster = require('../../core/raster');
const { buildFixtureGuide } = require('./fixture-guide');
const { makeTmpDir, rmrf } = require('./helpers');

function fixture(t, label) {
  const root = makeTmpDir(label);
  t.after(() => rmrf(root));
  return { root, ...buildFixtureGuide(path.join(root, 'data')) };
}

/** Every <img> in the HTML, with its attributes and decoded pixels. */
function images(html) {
  return [...html.matchAll(/<img src="data:image\/(png|jpeg);base64,([^"]+)" width="(\d+)" height="(\d+)" alt="([^"]*)"/g)]
    .map(([, type, data, width, height, alt]) => ({
      type, width: Number(width), height: Number(height), alt,
      pixels: type === 'png' ? decodePng(Buffer.from(data, 'base64')) : null,
    }));
}

const pixel = (img, x, y) => {
  const p = (y * img.width + x) * 4;
  return [img.data[p], img.data[p + 1], img.data[p + 2]];
};

test('clipboard: the guide pastes as plain inline-styled HTML, steps in order with their annotated screenshots', (t) => {
  const { store, guide } = fixture(t, 'clip-html');
  const ast = buildRenderAst(store, guide.guideId);
  const { html, imageCount } = runExport('clipboard', ast, '/unused');

  // Nothing mail and document apps drop or refuse: no style sheet, script, classes or outside links.
  assert.doesNotMatch(html, /<style|<script|<link|class=|<html|<body|<nav/i);
  assert.doesNotMatch(html, /src="(?!data:)/);
  // Every style attribute ends where it should (a stray double quote would cut it short).
  for (const m of html.matchAll(/ style="([^"]*)"(.)/g)) assert.match(m[2], /[> ]/, m[1]);

  // Title, description and steps with placeholders filled in.
  assert.match(html, /<h1[^>]*>Configure AcmeSync backups<\/h1>/);
  assert.match(html, /Maintained by <strong>Casey<\/strong>/);
  assert.ok(!html.includes('[['), 'every placeholder is filled in');
  const headings = [...html.matchAll(/<(h2|h3)[^>]*><span[^>]*>([\d.]+)\.<\/span> ([^<]+)<\/\1>/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(headings, [
    ['h2', '1', 'Open AcmeSync settings'],
    ['h3', '1.1', 'Verify the gear icon is visible'],
    ['h2', '2', 'Enable nightly backups'],
  ]);
  assert.ok(!html.includes('Internal-only note') && !html.includes('Legacy path'), 'hidden and skipped steps stay out, as in exports');
  assert.match(html, /3 steps/);

  // Each image step's screenshot is embedded, annotated as exported.
  assert.equal(imageCount, 2);
  const shots = images(html);
  assert.equal(shots.length, 2);
  assert.deepEqual(shots.map((s) => [s.width, s.height]), [[320, 200], [320, 200]]);
  assert.match(shots[0].alt, /Open AcmeSync settings/);
  assert.deepEqual(pixel(shots[0].pixels, 40, 100), [255, 0, 0], 'the red rectangle annotation is drawn in');
  assert.deepEqual(pixel(shots[1].pixels, 160, 100), [20, 140, 90]);
  // Screenshot 1 sits after step 1's heading and before step 2's.
  const at = (text) => html.indexOf(text);
  const imgs = [...html.matchAll(/<img /g)].map((m) => m.index);
  assert.ok(at('Open AcmeSync settings</h2>') < imgs[0] && imgs[0] < at('Verify the gear icon'));
  assert.ok(at('Enable nightly backups</h2>') < imgs[1]);

  // Blocks: a warning callout, a code block and a table, all inline-styled.
  assert.match(html, /<div style="[^"]*border:1px solid #9a6700[^"]*"><p style="[^"]*">Access<\/p><div><p>Admins only\.<\/p><\/div><\/div>/);
  assert.match(html, /<pre style="font-family:Consolas[^"]*">[\s\S]*acmesync[\s\S]*--backup[\s\S]*<\/pre>/);
  assert.match(html, /<th style="[^"]*">Day<\/th><th style="[^"]*">Window<\/th><\/tr><tr><td style="[^"]*">Weekdays<\/td><td style="[^"]*">02:00-03:00<\/td>/);
  // Links in step text keep working.
  assert.match(html, /<a href="https:\/\/docs\.example\.com">Settings<\/a>/);
});

test('clipboard: the plain-text version has the same steps, numbers and blocks', (t) => {
  const { store, guide } = fixture(t, 'clip-text');
  const { text } = exportClipboard(buildRenderAst(store, guide.guideId), '/unused');
  assert.equal(text, [
    'Configure AcmeSync backups',
    'Maintained by Casey.',
    '3 steps',
    '1. Open AcmeSync settings\n\nClick the gear icon, then choose Settings.',
    '1.1. Verify the gear icon is visible\n\nWarning: Access\nAdmins only.',
    '2. Enable nightly backups\n\nUse the schedule below.\n\n    0 2 * * * /usr/local/bin/acmesync --backup\n\nDay | Window\nWeekdays | 02:00-03:00\nWeekends | 04:00-05:00',
  ].join('\n\n') + '\n');
});

test('clipboard: large screenshots are scaled down and blurs are drawn in', (t) => {
  const { store } = fixture(t, 'clip-scale');
  // A 1600×1000 screenshot: black and white stripes, with a blur over the left half.
  const shot = raster.createImage(1600, 1000, [255, 255, 255, 255]);
  for (let x = 0; x < 1600; x += 8) raster.fillRect(shot, x, 0, 4, 1000, [0, 0, 0, 255]);
  const guide = store.createGuide({ title: 'Wide' });
  store.addStep(guide.guideId, { title: 'Wide screen', annotations: [{ type: 'blur', x: 0, y: 0, w: 0.5, h: 1, radius: 12 }] },
    encodePng(shot), { width: 1600, height: 1000 });

  const { html } = exportClipboard(buildRenderAst(store, guide.guideId), '/unused');
  const [first] = images(html);
  assert.deepEqual([first.width, first.height], [800, 500]);
  assert.deepEqual([first.pixels.width, first.pixels.height], [800, 500]);
  // Scaled to half size the stripes are 2 px wide: still sharp, except under the blur.
  const spread = (x0, x1) => {
    const values = [];
    for (let x = x0; x < x1; x += 1) values.push(pixel(first.pixels, x, 250)[0]);
    return Math.max(...values) - Math.min(...values);
  };
  assert.ok(spread(500, 700) > 200, `the rest keeps its stripes (spread ${spread(500, 700)})`);
  assert.ok(spread(100, 300) < 8, `blurred half is flat (spread ${spread(100, 300)})`);

  const narrow = exportClipboard(buildRenderAst(store, guide.guideId), '/unused', { maxImageWidth: 400 });
  assert.deepEqual(images(narrow.html).slice(0, 1).map((s) => [s.width, s.height]), [[400, 250]]);
});

test('clipboard: a brand profile adds its banner, logo, header, footer and color', (t) => {
  const { root, store, guide } = fixture(t, 'clip-brand');
  const brands = new BrandingStore(path.join(root, 'settings'));
  const logo = brands.addAsset(encodePng(raster.createImage(120, 60, [200, 40, 40, 255])), { kind: 'image', fileName: 'logo.png' });
  const banner = brands.addAsset(encodePng(raster.createImage(1600, 320, [53, 169, 199, 255])), { kind: 'image', fileName: 'banner.png' });
  const profile = brands.save({
    name: 'Acme', colors: { primary: '#173F7A', accent: '#35A9C7', text: '#303846' },
    logo: logo.id, banner: banner.id,
    header: { text: 'Acme · [[Product]] desk', logo: true }, footer: { text: '© Acme. Internal use only.' },
  });
  const ast = buildRenderAst(store, guide.guideId, { branding: brands.resolve(profile.id) });
  const { html, text } = exportClipboard(ast, '/unused');
  const all = images(html);
  assert.equal(all.length, 4, 'banner, logo and two screenshots');
  assert.deepEqual([all[0].width, all[0].height], [800, 160], 'the banner fits the same width');
  assert.equal(all[1].alt, 'Logo');
  assert.ok(all[1].height <= 48);
  assert.match(html, />Acme · AcmeSync desk<\/p>/);
  assert.match(html, />© Acme\. Internal use only\.<\/p>\n<\/div>$/);
  assert.match(html, /<span style="color:#173F7A">1\.<\/span>/);
  assert.ok(text.startsWith('Acme · AcmeSync desk\n\nConfigure AcmeSync backups'));
  assert.ok(text.endsWith('© Acme. Internal use only.\n'));
});

test('clipboard: images become JPEG only where that is smaller', () => {
  const png = (bytes) => `<img src="data:image/png;base64,${Buffer.from(bytes).toString('base64')}" width="1" height="1">`;
  const html = `${png('a'.repeat(100))}${png('b'.repeat(10))}${png('c'.repeat(50))}`;
  const seen = [];
  const out = preferSmallerImages(html, (buf) => {
    seen.push(buf.toString()[0]);
    if (buf.toString()[0] === 'a') return Buffer.from('j'.repeat(20)); // smaller: used
    if (buf.toString()[0] === 'b') return Buffer.from('j'.repeat(20)); // larger: kept
    return null; // transparency: kept
  });
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.deepEqual([...out.matchAll(/data:image\/(png|jpeg);base64,([^"]+)/g)].map((m) => [m[1], Buffer.from(m[2], 'base64').toString()]), [
    ['jpeg', 'j'.repeat(20)], ['png', 'b'.repeat(10)], ['png', 'c'.repeat(50)],
  ]);
});

test('clipboard: step links become plain text and description tables get borders', (t) => {
  const { store, guide, s1, s2 } = fixture(t, 'clip-desc');
  const step = store.getStep(guide.guideId, s2.stepId);
  store.saveStep(guide.guideId, { ...step, descriptionHtml: `<p>Back to <a href="step:${s1.stepId}">the first step</a>.</p><table><tr><td colspan="2">Wide</td></tr></table>` });
  const { html } = exportClipboard(buildRenderAst(store, guide.guideId), '/unused');
  assert.match(html, /<p>Back to the first step\.<\/p>/);
  assert.match(html, /<table style="border-collapse:collapse[^"]*"><tbody><tr><td colspan="2" style="border:1px solid #d0d7de[^"]*">Wide<\/td>|<table style="border-collapse:collapse[^"]*"><tr><td colspan="2" style="border:1px solid #d0d7de[^"]*">Wide<\/td>/);
});
