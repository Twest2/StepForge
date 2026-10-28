'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  BrandingStore, normalizeProfile, brandTemplateDefaults, fontFamilyName, familyFromFileName, FONT_SUGGESTIONS,
} = require('../../core/branding');
const { sanitizeSvg, svgSize } = require('../../core/svg-sanitize');
const { buildSampleAst } = require('../../core/branding-sample');
const { DEFAULT_SETTINGS } = require('../../core/settings');
const { buildRenderAst } = require('../../core/renderast');
const { runExport } = require('../../exporters');
const { withBrand, fontKind, textOn } = require('../../exporters/branding');
const { exportHtmlSimple, exportHtmlRich } = require('../../exporters/html');
const { exportPdf } = require('../../exporters/pdf');
const { exportDocx } = require('../../exporters/docx');
const { exportPptx } = require('../../exporters/pptx');
const { exportMarkdown } = require('../../exporters/markdown');
const { exportWikiJs } = require('../../exporters/wikijs');
const { exportConfluence } = require('../../exporters/confluence');
const { exportGifGuide } = require('../../exporters/gif');
const { exportImageBundle } = require('../../exporters/image-bundle');
const { exportJson } = require('../../exporters/json');
const { pageFromExport: confluencePage } = require('../../app/confluence');
const { pageFromExport: wikiPage } = require('../../app/wikijs');
const { unzipSync, zipSync } = require('../../core/zip');
const { decodePng, encodePng } = require('../../core/png');
const raster = require('../../core/raster');
const { decodeGif } = require('./gifdecode');
const { buildFixtureGuide } = require('./fixture-guide');
const { makeTmpDir, rmrf } = require('./helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const NOW = new Date('2026-10-28T12:00:00Z');

function tmp(t, label) {
  const dir = makeTmpDir(label);
  t.after(() => rmrf(dir));
  return dir;
}

/** A minimal TrueType file: just a `name` table naming the family. */
function sfntWithName(family) {
  const str = Buffer.from(family, 'utf16le').swap16();
  const name = Buffer.alloc(18 + str.length);
  name.writeUInt16BE(0, 0); // format
  name.writeUInt16BE(1, 2); // count
  name.writeUInt16BE(18, 4); // string storage offset
  name.writeUInt16BE(3, 6); // Windows
  name.writeUInt16BE(1, 8); // Unicode BMP
  name.writeUInt16BE(0x409, 10); // en-US
  name.writeUInt16BE(1, 12); // family
  name.writeUInt16BE(str.length, 14);
  name.writeUInt16BE(0, 16);
  str.copy(name, 18);
  const head = Buffer.alloc(28);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt16BE(1, 4);
  head.write('name', 12, 'latin1');
  head.writeUInt32BE(28, 20);
  head.writeUInt32BE(name.length, 24);
  return Buffer.concat([head, name]);
}

/** The same font as WOFF: the name table deflated when that makes it smaller, as the format requires. */
function woffWithName(family) {
  const table = sfntWithName(family).subarray(28);
  const deflated = zlib.deflateSync(table);
  const packed = deflated.length < table.length ? deflated : table;
  const header = Buffer.alloc(44);
  header.write('wOFF', 0, 'latin1');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(64 + packed.length, 8);
  header.writeUInt16BE(1, 12);
  const dir = Buffer.alloc(20);
  dir.write('name', 0, 'latin1');
  dir.writeUInt32BE(64, 4);
  dir.writeUInt32BE(packed.length, 8);
  dir.writeUInt32BE(table.length, 12);
  return Buffer.concat([header, dir, packed]);
}

function jpegHeader(width, height) {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

/** A logo with a transparent background and a solid square in one color. */
function logoPng(color = [23, 63, 122, 255]) {
  const img = raster.createImage(120, 60, [0, 0, 0, 0]);
  raster.fillRect(img, 0, 0, 60, 60, color);
  return encodePng(img);
}

/**
 * The fixture guide plus a brand profile with every option set. Returns its
 * render AST with and without the profile.
 */
function brandFixture(t, label, overrides = {}) {
  const root = tmp(t, label);
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const brands = new BrandingStore(path.join(root, 'settings'));
  const logo = brands.addAsset(logoPng(), { kind: 'image', fileName: 'acme-logo.png' });
  const banner = brands.addAsset(encodePng(raster.createImage(800, 160, [53, 169, 199, 255])), { kind: 'image', fileName: 'banner.png' });
  const font = brands.addAsset(sfntWithName('Acme Serif'), { kind: 'font', fileName: 'AcmeSerif-Bold.ttf' });
  const profile = brands.save({
    name: 'Acme',
    colors: { primary: '#173F7A', accent: '#35A9C7', text: '#303846' },
    fonts: { heading: { name: 'Acme Serif', asset: font.id }, body: { name: 'Georgia' } },
    logo: logo.id,
    banner: banner.id,
    header: { text: 'Acme · Service Desk', logo: true },
    footer: { text: '© Acme. Internal use only.', pageNumbers: true },
    html: { css: '.step-head h2 { color: var(--brand-primary); }' },
    ...overrides,
  });
  const ast = buildRenderAst(store, guide.guideId, { now: NOW, branding: brands.resolve(profile.id) });
  const plain = buildRenderAst(store, guide.guideId, { now: NOW });
  return { root, ast, plain, brands, profile, logo, banner, font };
}

function zipEntries(file) {
  return new Map(unzipSync(fs.readFileSync(file)).map((e) => [e.name, e.data.toString('utf8')]));
}

/** Inflate each page's content stream, in page order. */
function pdfPages(buf) {
  const text = buf.toString('latin1');
  const out = [];
  const re = /\d+ 0 obj\n<< \/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length;
    out.push(zlib.inflateSync(buf.subarray(start, start + Number(m[1]))).toString('latin1'));
  }
  return out;
}

// ---- profiles ------------------------------------------------------------------

test('branding: a profile is normalized: colors, fonts, choices and limits', () => {
  const p = normalizeProfile({
    id: 'brand-x',
    name: '  Acme\u0000 Corp  ',
    colors: { primary: '#abc', accent: 'red', text: '#1a2B3c' },
    fonts: { heading: { name: 'Evil"; } body { x: url(y)', asset: 'nope' }, body: { name: 'Georgia' } },
    logo: 'f'.repeat(32),
    cover: 'sideways',
    html: { css: 'a{}\r\nb{}', colorScheme: 'neon' },
    watermark: { enabled: 'yes', position: 'middle', opacity: 7 },
  });
  assert.equal(p.name, 'Acme Corp');
  assert.deepEqual(p.colors, { primary: '#AABBCC', accent: '#0EA5E9', text: '#1A2B3C' });
  assert.equal(p.fonts.heading.name, 'Evil body x url y');
  assert.equal(p.fonts.heading.asset, null);
  assert.equal(p.logo, 'f'.repeat(32));
  assert.equal(p.cover, 'standard');
  assert.equal(p.html.css, 'a{}\nb{}');
  assert.equal(p.html.colorScheme, 'light');
  assert.deepEqual(p.watermark, { enabled: false, position: 'bottom-right', opacity: 1 });
  assert.equal(normalizeProfile({}).name, 'Untitled brand');
  assert.equal(normalizeProfile({ header: {}, footer: {} }).footer.pageNumbers, true, 'page numbers default on');
});

test('branding: profiles are saved, listed by name, duplicated and deleted', (t) => {
  const brands = new BrandingStore(tmp(t, 'brand-store'));
  assert.deepEqual(brands.list(), []);
  const b = brands.save({ name: 'Zeta' });
  const a = brands.save({ name: 'alpha', logo: 'a'.repeat(32) });
  assert.match(a.id, /^brand-[0-9a-f-]{36}$/);
  assert.equal(a.logo, null, 'a logo that was never uploaded is dropped');
  assert.deepEqual(brands.list().map((p) => p.name), ['alpha', 'Zeta']);
  const renamed = brands.save({ ...b, name: 'Beta' });
  assert.equal(renamed.id, b.id, 'saving with an id updates that profile');
  assert.equal(renamed.createdAt, b.createdAt);
  const copy = brands.duplicate(a.id);
  assert.equal(copy.name, 'alpha copy');
  assert.notEqual(copy.id, a.id);
  brands.remove(a.id);
  assert.deepEqual(brands.list().map((p) => p.name), ['alpha copy', 'Beta']);
  assert.equal(brands.get('brand-../../etc'), null, 'ids are never paths');
  assert.throws(() => brands.remove('../settings'), /Unknown brand profile/);
});

test('branding: images are sniffed by content; PNGs StepForge can read are their own raster', (t) => {
  const brands = new BrandingStore(tmp(t, 'brand-assets'));
  const png = brands.addAsset(logoPng(), { kind: 'image', fileName: 'logo.png' });
  assert.equal(png.mime, 'image/png');
  assert.deepEqual([png.width, png.height, png.needsRaster], [120, 60, false]);
  assert.match(png.dataUrl, /^data:image\/png;base64,/);

  const jpg = brands.addAsset(jpegHeader(640, 200), { kind: 'image', fileName: 'photo.jpg' });
  assert.deepEqual([jpg.mime, jpg.width, jpg.height, jpg.needsRaster], ['image/jpeg', 640, 200, true]);

  const svg = brands.addAsset(Buffer.from('<svg viewBox="0 0 200 50"><script>alert(1)</script><rect width="200" height="50" onclick="x()"/></svg>'), { kind: 'image', fileName: 'logo.svg' });
  assert.deepEqual([svg.mime, svg.width, svg.height, svg.needsRaster], ['image/svg+xml', 200, 50, true]);
  const stored = Buffer.from(svg.dataUrl.split(',')[1], 'base64').toString('utf8');
  assert.doesNotMatch(stored, /script|onclick/);

  // The renderer's PNG drawing completes it; anything else is refused.
  const drawn = brands.setRaster(svg.id, encodePng(raster.createImage(800, 200, [1, 2, 3, 255])));
  assert.equal(drawn.needsRaster, false);
  assert.throws(() => brands.setRaster(jpg.id, Buffer.from('not a png')), /converted to PNG/);
  assert.throws(() => brands.setRaster('0'.repeat(32), encodePng(raster.createImage(2, 2))), /Unknown image/);

  assert.throws(() => brands.addAsset(Buffer.from('GIF89a......'), { kind: 'image' }), /PNG, JPG or SVG/);
  assert.throws(() => brands.addAsset(Buffer.from('<html><svg></svg></html>'), { kind: 'image' }), /PNG, JPG or SVG/);
  assert.throws(() => brands.addAsset(Buffer.alloc(11 * 1024 * 1024, 1), { kind: 'image' }), /smaller than 10 MB/);
  assert.equal(brands.addAsset(logoPng(), { kind: 'image' }).id, png.id, 'the same file is stored once');
});

test('branding: font files are checked and named from their name table', (t) => {
  const brands = new BrandingStore(tmp(t, 'brand-fonts'));
  const ttf = brands.addAsset(sfntWithName('Acme Sans'), { kind: 'font', fileName: 'whatever.ttf' });
  assert.deepEqual([ttf.family, ttf.format, ttf.mime], ['Acme Sans', 'truetype', 'font/ttf']);
  const long = 'Acme Web Display Display Display Display';
  assert.ok(zlib.deflateSync(sfntWithName(long).subarray(28)).length < sfntWithName(long).length - 28, 'this one is stored deflated');
  assert.equal(fontFamilyName(woffWithName(long)), long);
  assert.equal(fontFamilyName(woffWithName('Acme')), 'Acme', 'and this one raw');
  const woff2 = Buffer.concat([Buffer.from('wOF2', 'latin1'), Buffer.alloc(40)]);
  const named = brands.addAsset(woff2, { kind: 'font', fileName: 'BrandGrotesk-Regular.woff2' });
  assert.deepEqual([named.family, named.format], ['BrandGrotesk', 'woff2'], 'WOFF2 falls back to the file name');
  assert.equal(familyFromFileName('my_font.otf'), 'my');
  assert.throws(() => brands.addAsset(Buffer.from('ttcf0000000000'), { kind: 'font' }), /WOFF2, WOFF, TTF or OTF/);
});

test('branding: unused assets are removed after a day, used and recent ones are kept', (t) => {
  const brands = new BrandingStore(tmp(t, 'brand-gc'));
  const used = brands.addAsset(logoPng([200, 0, 0, 255]), { kind: 'image' });
  const unused = brands.addAsset(logoPng([0, 200, 0, 255]), { kind: 'image' });
  brands.save({ name: 'Uses one', logo: used.id });
  const files = () => fs.readdirSync(brands.assetsDir).sort();
  brands.collectGarbage();
  assert.ok(files().some((f) => f.startsWith(unused.id)), 'a fresh upload may belong to a profile being edited');
  brands.collectGarbage({ now: Date.now() + 2 * 24 * 60 * 60 * 1000 });
  assert.ok(!files().some((f) => f.startsWith(unused.id)), 'an old unused asset and its raster go');
  assert.ok(files().some((f) => f === `${used.id}.png`) && files().some((f) => f === `${used.id}.raster.png`));
});

test('branding: profiles round-trip through .sfbrand files, with every asset checked again', (t) => {
  const dir = tmp(t, 'brand-share');
  const from = new BrandingStore(path.join(dir, 'a'));
  const logo = from.addAsset(Buffer.from('<svg width="40" height="20"><rect width="40" height="20"/></svg>'), { kind: 'image', fileName: 'logo.svg' });
  from.setRaster(logo.id, encodePng(raster.createImage(400, 200, [9, 9, 9, 255])));
  const font = from.addAsset(sfntWithName('Acme Sans'), { kind: 'font', fileName: 'acme.ttf' });
  const profile = from.save({ name: 'Acme', logo: logo.id, fonts: { body: { name: 'Acme Sans', asset: font.id } } });
  const file = path.join(dir, 'acme.sfbrand');
  from.exportProfile(profile.id, file);

  const to = new BrandingStore(path.join(dir, 'b'));
  to.save({ name: 'Acme' });
  const imported = to.importProfile(file);
  assert.equal(imported.name, 'Acme (imported)');
  assert.notEqual(imported.id, profile.id);
  assert.equal(to.describe(imported.logo).needsRaster, false, 'the PNG drawing comes along');
  assert.equal(to.describe(imported.fonts.body.asset).family, 'Acme Sans');

  // A tampered file can't smuggle a script into an SVG.
  const entries = unzipSync(fs.readFileSync(file)).map((e) => (e.name.endsWith('.svg')
    ? { name: e.name, data: Buffer.from('<svg><script>steal()</script><circle r="4"/></svg>') } : e));
  fs.writeFileSync(file, zipSync(entries));
  const tampered = to.importProfile(file);
  const svg = Buffer.from(to.describe(tampered.logo).dataUrl.split(',')[1], 'base64').toString('utf8');
  assert.doesNotMatch(svg, /script|steal/);
  assert.match(svg, /<circle r="4"\/>/);

  fs.writeFileSync(file, zipSync([{ name: 'manifest.json', data: '{"format":"stepforge-template-archive"}' }]));
  assert.throws(() => to.importProfile(file), /isn’t a StepForge brand profile/);
});

test('branding: SVGs keep their drawing and lose scripts, handlers and outside links', () => {
  const dirty = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "boom">]>
<svg width="120px" height="40" onload="evil()" xmlns:foo="urn:x">
  <script>alert(1)</script>
  <foreignObject><div>hi</div></foreignObject>
  <style>@import url(https://tracker.example/x.css); .a { fill: url(#g); background: url(https://t.example/p.png) }</style>
  <defs><linearGradient id="g"><stop offset="0" stop-color="#173F7A"/></linearGradient></defs>
  <a href="javascript:alert(1)"><rect class="a" width="10" height="10" fill="url(#g)"/></a>
  <use href="https://evil.example/sprite.svg#x"/><use xlink:href="#g"/>
  <image href="data:image/png;base64,iVBORw0KGgo="/><image href="file:///etc/passwd"/>
  <animate attributeName="href" to="javascript:alert(1)"/>
  <text x="1" y="2">A &amp; B &nbsp; &lt;</text>
</svg>`;
  const clean = sanitizeSvg(dirty);
  assert.match(clean, /^<svg xmlns:xlink="http:\/\/www\.w3\.org\/1999\/xlink" xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="120px" height="40">/);
  for (const bad of ['script', 'onload', 'foreignObject', 'tracker', 't.example', 'javascript', 'evil.example', 'file:', 'animate', 'ENTITY', 'xmlns:foo']) {
    assert.ok(!clean.includes(bad), `removed: ${bad}`);
  }
  for (const good of ['<linearGradient id="g">', 'fill="url(#g)"', '<rect class="a"', 'xlink:href="#g"', 'data:image/png;base64', 'A &amp; B &amp;nbsp; &lt;']) {
    assert.ok(clean.includes(good), `kept: ${good}`);
  }
  assert.deepEqual(svgSize(clean), { width: 120, height: 40 });
  assert.deepEqual(svgSize('<svg viewBox="0 0 300 100" width="150">'), { width: 150, height: 50 });
  assert.throws(() => sanitizeSvg('<html><body/></html>'), /Not an SVG/);
});

// ---- exports -------------------------------------------------------------------

test('branding: export options are the exporter defaults, then the brand, then what was chosen', () => {
  const brand = { colors: { primary: '#173F7A' } };
  assert.deepEqual(brandTemplateDefaults('html-rich', brand), { accentColor: '#173F7A' });
  assert.deepEqual(brandTemplateDefaults('pdf', brand), { accentColor: [23, 63, 122] });
  assert.deepEqual(brandTemplateDefaults('json', brand), {});
  assert.deepEqual(brandTemplateDefaults('pdf', null), {});
  const ast = { branding: brand };
  assert.equal(withBrand('gif', { accentColor: '#0068FF', width: 960 }, ast).accentColor, '#173F7A');
  assert.equal(withBrand('gif', { accentColor: '#0068FF' }, ast, { accentColor: '#FF0000' }).accentColor, '#FF0000');
  assert.equal(withBrand('gif', { accentColor: '#0068FF' }, {}).accentColor, '#0068FF');
  assert.equal(fontKind('Georgia'), 'serif');
  assert.equal(fontKind('Noto Sans'), 'sans');
  assert.equal(fontKind('Microsoft Sans Serif'), 'sans');
  assert.equal(fontKind('Cascadia Mono'), 'mono');
  assert.equal(fontKind(''), 'sans');
  assert.equal(textOn('#173F7A'), '#FFFFFF');
  assert.equal(textOn('#F5D90A'), '#111111');
});

test('branding: HTML exports carry the logo, banner, colors, fonts, footer and the profile’s CSS', (t) => {
  const { root, ast, plain, logo } = brandFixture(t, 'brand-html', { html: { css: '.x{}</style><script>alert(1)</script>' } });
  for (const exporter of [exportHtmlSimple, exportHtmlRich]) {
    const html = fs.readFileSync(exporter(ast, path.join(root, 'html')).file, 'utf8');
    assert.match(html, /--brand-primary: #173F7A; --brand-accent: #35A9C7; --brand-text: #303846;/);
    assert.match(html, /--font-heading: "Acme Serif", Georgia/);
    assert.match(html, /--font-body: "Georgia", Georgia/);
    assert.match(html, /@font-face \{ font-family: "Acme Serif"; src: url\(data:font\/ttf;base64,/);
    assert.ok(html.includes(`<img class="brand-logo" src="${logo.dataUrl}" alt="Logo" width="120" height="60">`));
    assert.match(html, /<img class="brand-banner" src="data:image\/png;base64,/);
    assert.match(html, /<p class="brand-tagline">Acme · Service Desk<\/p>/);
    assert.match(html, /<footer class="doc-footer">© Acme\. Internal use only\. · 2026-10-28<\/footer>/);
    assert.match(html, /class="doc-header cover-standard"/);
    assert.match(html, /:root \{ color-scheme: light; --text: #303846; \}/);
    assert.ok(!html.includes('prefers-color-scheme: dark'), 'a light-only profile has no dark colors');
    assert.ok(html.includes('.x{}<\\/style><script>alert(1)</script>'), 'the profile’s CSS can’t end the <style> element');
    assert.equal(html.match(/<\/style>/g).length, 1);
  }
  const unbranded = fs.readFileSync(exportHtmlSimple(plain, path.join(root, 'plain')).file, 'utf8');
  assert.match(unbranded, /prefers-color-scheme: dark/);
  assert.match(unbranded, /Made with StepForge/);
  assert.ok(!unbranded.includes('brand-'), 'no branding, no brand markup');
});

test('branding: an HTML profile can follow dark mode, and Export dialog colors beat the brand’s', (t) => {
  const { root, ast } = brandFixture(t, 'brand-html2', { cover: 'band', html: { colorScheme: 'auto' } });
  const html = fs.readFileSync(exportHtmlRich(ast, path.join(root, 'a'), { accentColor: '#FF0000' }).file, 'utf8');
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /@media \(prefers-color-scheme: light\) \{ :root \{ --text: #303846; \} \}/);
  assert.match(html, /class="doc-header cover-band"/);
  assert.match(html, /--accent:rgb\(255,0,0\)/);
  const branded = fs.readFileSync(exportHtmlRich(ast, path.join(root, 'b')).file, 'utf8');
  assert.match(branded, /--accent:rgb\(23,63,122\)/);
});

test('branding: PDF uses the closest built-in fonts, a transparent logo, and a header and footer after the cover', (t) => {
  const { root, ast, plain } = brandFixture(t, 'brand-pdf');
  const buf = fs.readFileSync(exportPdf(ast, path.join(root, 'pdf')).file);
  const pages = pdfPages(buf);
  const text = buf.toString('latin1');
  assert.match(text, /\/BaseFont \/Times-Bold/);
  assert.match(text, /\/SMask \d+ 0 R/, 'the logo keeps its transparency');
  assert.match(pages[0], /\/F10 28 Tf/, 'a serif heading font sets the title in Times Bold');
  assert.ok(!pages[0].includes('Page 1 of'), 'no header or footer on the cover');
  assert.ok(pages[1].includes(`(Page 2 of ${pages.length}) Tj`));
  assert.ok(pages[1].includes('(Acme \xB7 Service Desk) Tj'));
  assert.ok(pages[1].includes('(\xA9 Acme. Internal use only.) Tj'));
  assert.match(pages[2], /\/F9 10\.5 Tf/, 'Georgia body text is Times');
  assert.match(pages[2], /0\.188 0\.220 0\.275 rg/, 'body text in the brand’s text color');

  const plainBuf = fs.readFileSync(exportPdf(plain, path.join(root, 'plain')).file);
  assert.ok(!plainBuf.toString('latin1').includes('/SMask'));
  assert.ok(!pdfPages(plainBuf).some((p) => /Page \d+ of/.test(p)));
  assert.match(pdfPages(plainBuf)[0], /\/F2 28 Tf/);
});

test('branding: Word gets brand styles, the logo on the cover, and a header and footer part', (t) => {
  const { root, ast, plain } = brandFixture(t, 'brand-docx');
  const z = zipEntries(exportDocx(ast, path.join(root, 'docx')).file);
  const styles = z.get('word/styles.xml');
  assert.match(styles, /w:rFonts w:ascii="Georgia"/);
  assert.match(styles, /<w:style w:type="paragraph" w:styleId="Heading1">[\s\S]*?w:ascii="Acme Serif"[\s\S]*?<w:color w:val="173F7A"\/>/);
  assert.match(styles, /<w:color w:val="303846"\/>/);
  const doc = z.get('word/document.xml');
  assert.match(doc, /<w:headerReference w:type="default" r:id="rId\d+"\/><w:headerReference w:type="first"/);
  assert.match(doc, /<w:titlePg\/>/);
  assert.match(doc, /name="Logo" descr="Logo"/);
  assert.match(z.get('word/header1.xml'), /Acme · Service Desk/);
  assert.match(z.get('word/header1.xml'), /r:embed="rId1"/);
  assert.match(z.get('word/_rels/header1.xml.rels'), /Target="media\/brand-logo.png"/);
  assert.match(z.get('word/footer1.xml'), /© Acme\. Internal use only\.[\s\S]*w:instr=" PAGE "[\s\S]*w:instr=" NUMPAGES "/);
  assert.ok(z.has('word/media/brand-logo.png') && z.has('word/media/brand-banner.png'));
  assert.match(z.get('[Content_Types].xml'), /PartName="\/word\/footer1.xml" ContentType="[^"]+footer\+xml"/);
  const rels = z.get('word/_rels/document.xml.rels');
  for (const m of rels.matchAll(/Target="([^"]+)"/g)) assert.ok(z.has(`word/${m[1]}`), `${m[1]} exists`);

  const p = zipEntries(exportDocx(plain, path.join(root, 'plain')).file);
  assert.ok(!p.has('word/header1.xml'));
  assert.match(p.get('word/styles.xml'), /w:ascii="Calibri"[\s\S]*2563EB/);
});

test('branding: PowerPoint gets a brand theme, logo, footer and slide numbers on the master, and a title layout', (t) => {
  const { root, ast, plain } = brandFixture(t, 'brand-pptx', { cover: 'band' });
  const z = zipEntries(exportPptx(ast, path.join(root, 'pptx')).file);
  const theme = z.get('ppt/theme/theme1.xml');
  assert.match(theme, /<a:theme [^>]*name="Acme">/);
  assert.match(theme, /<a:dk1><a:srgbClr val="303846"\/><\/a:dk1>/);
  assert.match(theme, /<a:accent1><a:srgbClr val="173F7A"\/><\/a:accent1><a:accent2><a:srgbClr val="35A9C7"\/>/);
  assert.match(theme, /<a:majorFont><a:latin typeface="Acme Serif"\/>[\s\S]*<a:minorFont><a:latin typeface="Georgia"\/>/);
  const master = z.get('ppt/slideMasters/slideMaster1.xml');
  assert.match(master, /name="Logo"[\s\S]*r:embed="rId3"/);
  assert.match(master, /© Acme\. Internal use only\./);
  assert.match(master, /<a:fld [^>]*type="slidenum">/);
  assert.match(z.get('ppt/slideMasters/_rels/slideMaster1.xml.rels'), /Id="rId3"[^>]*Target="..\/media\/brand-logo.png"/);
  assert.ok(z.has('ppt/media/brand-logo.png') && z.has('ppt/media/brand-banner.png'));
  const title = z.get('ppt/slides/slide1.xml');
  assert.match(title, /showMasterSp="0"/, 'the title slide has its own, larger logo');
  assert.match(title, /<a:prstGeom prst="rect"><a:avLst\/><\/a:prstGeom><a:solidFill><a:schemeClr val="accent1"\/>/);
  assert.match(title, /<a:srgbClr val="FFFFFF"\/><\/a:solidFill><a:latin typeface="\+mj-lt"\/><\/a:rPr><a:t>Configure AcmeSync backups/);
  assert.match(z.get('ppt/slides/_rels/slide1.xml.rels'), /brand-logo.png[\s\S]*|brand-banner.png/);
  const step = [...z.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).map((k) => z.get(k)).find((x) => x.includes('Open AcmeSync settings'));
  assert.ok(step && !step.includes('showMasterSp'), 'step slides show the master’s logo and footer');
  for (const [name, xml] of z) {
    if (!name.endsWith('.rels')) continue;
    const base = path.posix.dirname(path.posix.dirname(name));
    for (const m of xml.matchAll(/Target="([^"]+)"/g)) assert.ok(z.has(path.posix.normalize(path.posix.join(base, m[1]))), `${name} → ${m[1]}`);
  }

  const p = zipEntries(exportPptx(plain, path.join(root, 'plain')).file);
  assert.match(p.get('ppt/theme/theme1.xml'), /<a:accent1><a:srgbClr val="2563EB"\/>[\s\S]*<a:latin typeface="Calibri"\/>/);
  assert.ok(!p.get('ppt/slideMasters/slideMaster1.xml').includes('Logo'));
  assert.ok(!p.get('ppt/slides/slide1.xml').includes('showMasterSp'));
});

test('branding: Markdown and Wiki.js pages show the logo and banner; publishing uploads them', (t) => {
  const { root, ast, plain } = brandFixture(t, 'brand-md', { cover: 'centered' });
  const md = fs.readFileSync(exportMarkdown(ast, path.join(root, 'md')).file, 'utf8');
  assert.match(md, /^<p align="center"><img src="steps-configure-acmesync-backups\/brand-banner.png" alt="" width="100%"><\/p>\n\n<p align="center"><img src="steps-configure-acmesync-backups\/brand-logo.png" alt="Logo" height="48"><\/p>\n\n\*Acme · Service Desk\*\n\n# Configure AcmeSync backups/);
  assert.match(md, /background:#173f7a;/);
  assert.match(md, /---\n\n\*© Acme\. Internal use only\.\*\n$/);
  const logo = decodePng(fs.readFileSync(path.join(root, 'md', 'steps-configure-acmesync-backups', 'brand-logo.png')));
  assert.deepEqual([logo.width, logo.height], [120, 60], 'small enough to show at 48px, sharp on high-DPI screens');

  // Exporting without branding into the same folder doesn't leave the old logo behind.
  exportMarkdown(plain, path.join(root, 'md'));
  assert.ok(!fs.existsSync(path.join(root, 'md', 'steps-configure-acmesync-backups', 'brand-logo.png')));

  const wiki = exportWikiJs(ast, path.join(root, 'wiki'), { assetFolder: '/guides/acme' });
  const content = fs.readFileSync(wiki.file, 'utf8');
  assert.match(content, /^!\[\]\(\/guides\/acme\/brand-banner.png\)\n\n!\[Logo\]\(\/guides\/acme\/brand-logo.png\)/);
  assert.ok(!content.includes('<img'), 'Wiki.js gets Markdown images, in case it strips HTML');
  const page = wikiPage(wiki.file, '/guides/acme');
  assert.deepEqual(page.assets.map((a) => a.name).filter((n) => n.startsWith('brand-')), ['brand-banner.png', 'brand-logo.png']);
});

test('branding: Confluence’s Word import and REST page open with the logo; publishing attaches it', (t) => {
  const { root, ast } = brandFixture(t, 'brand-confluence');
  const result = exportConfluence(ast, path.join(root, 'c'), { apiFiles: true });
  const xhtml = fs.readFileSync(result.apiPage, 'utf8');
  assert.match(xhtml, /^<p><ac:image ac:width="760" ac:alt="Banner"><ri:attachment ri:filename="brand-banner.png" \/><\/ac:image><\/p>\n<p><ac:image ac:height="48" ac:alt="Logo"><ri:attachment ri:filename="brand-logo.png" \/><\/ac:image><\/p>/);
  assert.match(xhtml, /<p><em>© Acme\. Internal use only\.<\/em><\/p>$/m);
  const page = confluencePage(path.dirname(result.apiPage));
  assert.ok(page.attachments.some((a) => a.name === 'brand-logo.png'));
  assert.ok(page.attachments.some((a) => a.name === 'step-001.png'), 'screenshots are still renamed');
  const word = zipEntries(result.file);
  assert.match(word.get('word/document.xml'), /descr="Banner"[\s\S]*descr="Logo"[\s\S]*Acme · Service Desk/);
});

test('branding: GIF and image bundle put the logo on the title card and as an optional watermark', (t) => {
  const magenta = [255, 0, 255, 255];
  const root = tmp(t, 'brand-wm');
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const brands = new BrandingStore(path.join(root, 'settings'));
  const mark = brands.addAsset(encodePng(raster.createImage(40, 40, magenta)), { kind: 'image' });
  const profile = brands.save({ name: 'WM', logo: mark.id, watermark: { enabled: true, position: 'top-left', opacity: 1 } });
  const ast = buildRenderAst(store, guide.guideId, { now: NOW, branding: brands.resolve(profile.id) });

  const bundle = exportImageBundle(ast, path.join(root, 'bundle'));
  const meta = JSON.parse(fs.readFileSync(bundle.file, 'utf8'));
  const shot = decodePng(fs.readFileSync(path.join(bundle.folder, meta.steps.find((s) => s.image).image)));
  const px = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
  assert.deepEqual(px(shot, 10, 10), [255, 0, 255], 'brand watermark in the top-left corner');

  // A watermark picked in the Export dialog wins.
  const green = path.join(root, 'green.png');
  fs.writeFileSync(green, encodePng(raster.createImage(24, 24, [0, 255, 0, 255])));
  const chosen = exportImageBundle(ast, path.join(root, 'chosen'), { watermarkPath: green, watermarkOpacity: 1 });
  const chosenShot = decodePng(fs.readFileSync(path.join(chosen.folder, meta.steps.find((s) => s.image).image)));
  assert.notDeepEqual(px(chosenShot, 10, 10), [255, 0, 255]);
  assert.deepEqual(px(chosenShot, chosenShot.width - 18, chosenShot.height - 18), [0, 255, 0]);

  const gif = decodeGif(fs.readFileSync(exportGifGuide(ast, path.join(root, 'gif')).file));
  const color = (frame, x, y) => {
    const i = frame.indices[y * frame.width + x];
    return [...frame.palette.subarray(i * 3, i * 3 + 3)];
  };
  const step = gif.frames[1];
  // The screenshot is letterboxed into the frame; the mark sits in its corner.
  const near = [];
  for (let y = 0; y < 40; y++) for (let x = 0; x < 80; x++) near.push(color(step, x, y).join());
  assert.ok(near.includes('255,0,255'), 'watermark on the step frames');
  const titleCard = gif.frames[0];
  const card = [];
  for (let y = 0; y < titleCard.height; y += 2) for (let x = 0; x < titleCard.width; x += 2) card.push(color(titleCard, x, y).join());
  assert.ok(card.includes('255,0,255'), 'logo on the title card');
});

test('branding: JSON exports stay raw data', (t) => {
  const { root, ast, plain } = brandFixture(t, 'brand-json');
  const branded = fs.readFileSync(exportJson(ast, path.join(root, 'a')).file, 'utf8');
  const unbranded = fs.readFileSync(exportJson(plain, path.join(root, 'b')).file, 'utf8');
  assert.equal(branded, unbranded);
});

test('branding: the design preview sample exports in every format, branded or not', (t) => {
  const root = tmp(t, 'brand-sample');
  const brands = new BrandingStore(path.join(root, 'settings'));
  const logo = brands.addAsset(logoPng(), { kind: 'image' });
  const draft = { name: 'Draft', logo: logo.id, cover: 'band', watermark: { enabled: true } };
  for (const [label, branding] of [['plain', null], ['draft', brands.resolveDraft(draft)]]) {
    const ast = buildSampleAst({ dir: path.join(root, label, 'library'), branding, now: NOW });
    assert.equal(ast.steps.length, 3);
    assert.equal(Boolean(ast.branding), Boolean(branding));
    for (const format of ['html-simple', 'html-rich', 'pdf', 'docx', 'pptx', 'markdown', 'wikijs', 'confluence', 'gif', 'image-bundle', 'json']) {
      const result = runExport(format, ast, path.join(root, label, format), {});
      assert.ok(fs.existsSync(result.file), `${label} ${format}`);
    }
  }
});

// ---- wiring --------------------------------------------------------------------

test('branding: Settings default to no branding, and every export path passes the profile on', () => {
  assert.deepEqual(DEFAULT_SETTINGS.branding, { activeProfileId: '' });
  const main = read('app/main.js');
  const calls = [...main.matchAll(/runExportInWorker\(\{[\s\S]*?\}\);/g)].map((m) => m[0]);
  assert.equal(calls.length, 4);
  for (const call of calls) assert.match(call, /branding: exportBranding\(/, call.slice(0, 120));
  assert.match(main, /h\('export:preview'[\s\S]{0,500}branding: exportBranding\(brandProfileId\)/);
  assert.match(read('core/export-worker.js'), /buildRenderAst\(store, guideId, \{[^}]*branding/);
  assert.match(read('app/export-runner.js'), /worker\.send\(\{[^}]*branding/);
});

test('branding: the renderer offers the same font suggestions as core/branding.js, and loads before dialogs.js', () => {
  const src = read('app/renderer/branding.js');
  const offered = JSON.parse(`[${src.match(/const BRAND_FONT_SUGGESTIONS = \[([\s\S]*?)\];/)[1].replace(/'/g, '"').replace(/,\s*$/, '')}]`);
  assert.deepEqual(offered, FONT_SUGGESTIONS);
  const html = read('app/renderer/index.html');
  assert.ok(html.indexOf('<script src="branding.js">') > html.indexOf('<script src="util.js">'));
  assert.ok(html.indexOf('<script src="branding.js">') < html.indexOf('<script src="dialogs.js">'));
});
