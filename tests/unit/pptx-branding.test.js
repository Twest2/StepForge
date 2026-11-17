'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  BrandingStore, normalizeProfile, brandTemplateDefaults, profileAssetIds, mapProfileAssets,
} = require('../../core/branding');
const { buildRenderAst } = require('../../core/renderast');
const { exportPptx } = require('../../exporters/pptx');
const { unzipSync } = require('../../core/zip');
const { encodePng } = require('../../core/png');
const raster = require('../../core/raster');
const { buildFixtureGuide } = require('./fixture-guide');
const { makeTmpDir, rmrf } = require('./helpers');

const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
const MARGIN_X = Math.round(0.6 * 914400);

function tmp(t, label) {
  const dir = makeTmpDir(label);
  t.after(() => rmrf(dir));
  return dir;
}

const png = (w, h, color) => encodePng(raster.createImage(w, h, color));

/** A wordmark: a dark square and dark bars on transparent, like a logo with dark text. */
function darkLogo() {
  const img = raster.createImage(300, 80, [0, 0, 0, 0]);
  raster.fillRect(img, 0, 0, 80, 80, [15, 40, 70, 255]);
  raster.fillRect(img, 100, 25, 200, 30, [15, 40, 70, 255]);
  return encodePng(img);
}

/** Stripes of light and dark: a picture no single text color reads on. */
function busyPicture() {
  const img = raster.createImage(960, 540, [240, 240, 235, 255]);
  for (let x = 0; x < 960; x += 80) raster.fillRect(img, x, 0, 40, 540, [20, 30, 60, 255]);
  return encodePng(img);
}

/** A minimal JPEG header (the store reads its size; PowerPoint gets the bytes as they are). */
function jpeg(width, height) {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

function brandDeck(t, label, { pptx = {}, images = {}, ...overrides } = {}, options = {}) {
  const root = tmp(t, label);
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const brands = new BrandingStore(path.join(root, 'settings'));
  const add = (data, name) => brands.addAsset(data, { kind: 'image', fileName: name }).id;
  const logo = add(images.logo || darkLogo(), 'logo.png');
  const ids = {};
  for (const key of ['titleBackground', 'slideBackground']) if (images[key]) ids[key] = add(images[key], `${key}.${images[key][0] === 0xff ? 'jpg' : 'png'}`);
  const profile = brands.save({
    name: 'Northwind',
    colors: { primary: '#0E7490', accent: '#F59E0B', text: '#1E293B' },
    logo,
    footer: { text: 'Northwind IT', pageNumbers: true },
    pptx: { ...pptx, ...ids },
    ...overrides,
  });
  const ast = buildRenderAst(store, guide.guideId, { branding: brands.resolve(profile.id) });
  const { file, slideCount } = exportPptx(ast, path.join(root, 'out'), options);
  const z = new Map(unzipSync(fs.readFileSync(file)).map((e) => [e.name, e.data]));
  const text = (name) => z.get(name)?.toString('utf8');
  const slides = Array.from({ length: slideCount }, (_, i) => text(`ppt/slides/slide${i + 1}.xml`));
  return { z, text, slides, brands, profile };
}

/** A shape's box by name: { x, y, w, h }. */
function box(xml, name) {
  const m = xml.match(new RegExp(`name="${name}"[^>]*/?>[\\s\\S]*?<a:off x="(\\d+)" y="(\\d+)"/><a:ext cx="(\\d+)" cy="(\\d+)"/>`));
  return m && { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
}

const stepSlide = (slides) => slides.find((xml) => xml.includes('name="Step number"'));

test('PowerPoint branding: a profile keeps backgrounds, logo position and screenshot position, with safe defaults', () => {
  const plain = normalizeProfile({});
  assert.deepEqual(plain.pptx, { titleBackground: null, slideBackground: null, logoPosition: 'top-right', screenshotPosition: 'auto' });
  const odd = normalizeProfile({ pptx: { titleBackground: '../etc/passwd', slideBackground: 'a'.repeat(32), logoPosition: 'middle', screenshotPosition: 'diagonal' } });
  assert.deepEqual(odd.pptx, { titleBackground: null, slideBackground: 'a'.repeat(32), logoPosition: 'top-right', screenshotPosition: 'auto' });
  const set = normalizeProfile({ pptx: { logoPosition: 'bottom-left', screenshotPosition: 'full' } });
  assert.equal(set.pptx.logoPosition, 'bottom-left');
  assert.equal(set.pptx.screenshotPosition, 'full');
  assert.deepEqual(brandTemplateDefaults('pptx', set), { screenshotPosition: 'full' });
  assert.deepEqual(brandTemplateDefaults('pptx', plain), { screenshotPosition: 'auto' });
});

test('PowerPoint branding: background pictures are kept, cleaned up, shared and listed for drawing like logos', (t) => {
  const dir = tmp(t, 'pptx-brand-store');
  const brands = new BrandingStore(path.join(dir, 'a'));
  const title = brands.addAsset(png(64, 36, [10, 40, 80, 255]), { kind: 'image', fileName: 'title.png' });
  const photo = brands.addAsset(jpeg(1920, 1080), { kind: 'image', fileName: 'slides.jpg' });
  const profile = brands.save({ name: 'Acme', pptx: { titleBackground: title.id, slideBackground: photo.id, logoPosition: 'top-left' } });
  assert.equal(profile.pptx.titleBackground, title.id);
  assert.equal(profile.pptx.slideBackground, photo.id);
  assert.deepEqual(profileAssetIds(profile).sort(), [title.id, photo.id].sort());
  // Every reference goes through mapProfileAssets, so saving, importing and syncing see them all.
  const seen = [];
  mapProfileAssets(profile, (id) => { if (id) seen.push(id); return id; });
  assert.deepEqual(seen.sort(), profileAssetIds(profile).sort());
  // A reference to a file that doesn't exist is dropped.
  assert.equal(brands.save({ ...profile, pptx: { ...profile.pptx, titleBackground: 'f'.repeat(32) } }).pptx.titleBackground, null);
  brands.save(profile);

  // The JPEG needs the renderer's PNG drawing, like a JPEG logo.
  assert.deepEqual(brands.pendingRasters().map((a) => a.id), [photo.id]);
  brands.collectGarbage({ now: Date.now() + 3 * 24 * 60 * 60 * 1000 });
  assert.ok(brands.assetMeta(title.id) && brands.assetMeta(photo.id), 'backgrounds in use are never cleaned up');

  const resolved = brands.resolve(profile.id);
  assert.equal(resolved.pptx.titleBackground.mime, 'image/png');
  assert.equal(resolved.pptx.slideBackground.mime, 'image/jpeg');

  const file = path.join(dir, 'acme.sfbrand');
  brands.exportProfile(profile.id, file);
  const to = new BrandingStore(path.join(dir, 'b'));
  const imported = to.importProfile(file);
  assert.ok(to.assetMeta(imported.pptx.titleBackground) && to.assetMeta(imported.pptx.slideBackground), 'backgrounds come along in .sfbrand files');
  assert.equal(imported.pptx.logoPosition, 'top-left');
});

test('PowerPoint branding: the slide background is on the master, and step slides drop the accent bar for it', (t) => {
  const { text, slides, z } = brandDeck(t, 'pptx-slide-bg', { images: { slideBackground: png(192, 108, [250, 250, 250, 255]) } });
  assert.match(text('ppt/slideMasters/slideMaster1.xml'), /<p:cSld><p:bg><p:bgPr><a:blipFill [^>]*><a:blip r:embed="rId4"\/>/);
  assert.match(text('ppt/slideMasters/_rels/slideMaster1.xml.rels'), /Id="rId4"[^>]*Target="\.\.\/media\/brand-slide-background\.png"/);
  assert.ok(z.has('ppt/media/brand-slide-background.png'));
  assert.ok(!stepSlide(slides).includes('name="Accent"'));
  // Without one, the master keeps the plain background and slides keep their bar.
  const plain = brandDeck(t, 'pptx-no-bg');
  assert.doesNotMatch(plain.text('ppt/slideMasters/slideMaster1.xml'), /<p:bg><p:bgPr>/);
  assert.match(stepSlide(plain.slides), /name="Accent"/);
});

test('PowerPoint branding: a JPEG background goes in as JPEG', (t) => {
  const root = tmp(t, 'pptx-jpeg');
  const brands = new BrandingStore(path.join(root, 'settings'));
  const photo = brands.addAsset(jpeg(1920, 1080), { kind: 'image', fileName: 'office.jpg' });
  brands.setRaster(photo.id, png(192, 108, [20, 30, 40, 255]));
  const profile = brands.save({ name: 'Acme', pptx: { titleBackground: photo.id } });
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const { file } = exportPptx(buildRenderAst(store, guide.guideId, { branding: brands.resolve(profile.id) }), path.join(root, 'out'));
  const z = new Map(unzipSync(fs.readFileSync(file)).map((e) => [e.name, e.data]));
  assert.ok(z.has('ppt/media/brand-title-background.jpg'));
  assert.match(z.get('[Content_Types].xml').toString('utf8'), /<Default Extension="jpg" ContentType="image\/jpeg"\/>/);
  assert.match(z.get('ppt/slides/_rels/slide1.xml.rels').toString('utf8'), /Id="rId4"[^>]*brand-title-background\.jpg/);
  assert.match(z.get('ppt/slides/slide1.xml').toString('utf8'), /<p:cSld><p:bg><p:bgPr><a:blipFill [^>]*><a:blip r:embed="rId4"\/>/);
  // Only the dark drawing says what's behind the title: white text.
  assert.match(z.get('ppt/slides/slide1.xml').toString('utf8'), /<a:srgbClr val="FFFFFF"\/><\/a:solidFill><a:latin typeface="\+mj-lt"\/><\/a:rPr><a:t>Configure AcmeSync backups/);
});

test('PowerPoint branding: title text is white on a dark background, dark on a light one, and on a panel over a busy one', (t) => {
  const titleRun = (xml) => xml.match(/<a:srgbClr val="([0-9A-F]{6})"\/><\/a:solidFill><a:latin typeface="\+mj-lt"\/><\/a:rPr><a:t>Configure AcmeSync/)?.[1];
  const dark = brandDeck(t, 'pptx-dark', { images: { titleBackground: png(192, 108, [12, 30, 60, 255]) } }).slides[0];
  assert.equal(titleRun(dark), 'FFFFFF');
  assert.ok(!dark.includes('name="Text panel"'));
  assert.ok(dark.includes('name="Logo card"'), 'a dark logo on a dark picture sits on a white card');
  const light = brandDeck(t, 'pptx-light', { images: { titleBackground: png(192, 108, [245, 247, 250, 255]) } }).slides[0];
  assert.equal(titleRun(light), '1E293B', 'the brand’s text color');
  assert.ok(!light.includes('name="Text panel"') && !light.includes('name="Logo card"'));
  const busy = brandDeck(t, 'pptx-busy', { images: { titleBackground: busyPicture() } }).slides[0];
  assert.match(busy, /name="Text panel"[\s\S]*?<a:alpha val="\d+"\/>/);
  // The title slide picture replaces the Band cover's color.
  const band = brandDeck(t, 'pptx-band', { cover: 'band', images: { titleBackground: png(192, 108, [245, 247, 250, 255]) } }).slides[0];
  assert.ok(!band.includes('name="Band"'));
});

test('PowerPoint branding: the logo goes in the corner the profile picks, and the slide makes room for it', (t) => {
  const at = (position) => {
    const deck = brandDeck(t, `pptx-logo-${position}`, { pptx: { logoPosition: position } });
    return { master: deck.text('ppt/slideMasters/slideMaster1.xml'), step: stepSlide(deck.slides), title: deck.slides[0] };
  };
  const topRight = at('top-right');
  const logoTR = box(topRight.master, 'Logo');
  assert.equal(logoTR.x + logoTR.w, SLIDE_W - MARGIN_X);
  assert.ok(box(topRight.step, 'Title').x + box(topRight.step, 'Title').w <= logoTR.x, 'the title stops short of the logo');

  const topLeft = at('top-left');
  const logoTL = box(topLeft.master, 'Logo');
  assert.equal(logoTL.x, MARGIN_X);
  assert.ok(box(topLeft.step, 'Step number').y >= logoTL.y + logoTL.h, 'the step header starts below the logo');

  const bottomRight = at('bottom-right');
  const logoBR = box(bottomRight.master, 'Logo');
  assert.ok(logoBR.y + logoBR.h <= SLIDE_H && logoBR.y > SLIDE_H * 0.85);
  const footers = [...bottomRight.master.matchAll(/name="Footer"[\s\S]*?<a:off x="(\d+)" y="\d+"\/><a:ext cx="(\d+)"/g)].map((m) => ({ x: +m[1], w: +m[2] }));
  assert.ok(footers.every((f) => f.x + f.w <= logoBR.x), 'footer text and slide number stay left of the logo');
  const shot = box(bottomRight.step, 'Screenshot');
  assert.ok(shot.y + shot.h < logoBR.y, 'the screenshot stays above the logo');

  const bottomLeft = at('bottom-left');
  const logoBL = box(bottomLeft.master, 'Logo');
  assert.ok(bottomLeft.master.match(/name="Footer"[\s\S]*?<a:off x="(\d+)"/)[1] > logoBL.x + logoBL.w);

  const none = at('none');
  assert.ok(!none.master.includes('name="Logo"'));
  assert.ok(none.title.includes('name="Logo"'), 'the title slide still shows the logo');
});

test('PowerPoint branding: the profile’s screenshot position and border are the defaults; the Export dialog wins', (t) => {
  const left = brandDeck(t, 'pptx-pos', { pptx: { screenshotPosition: 'left' }, screenshots: { border: true, borderColor: '#0E7490' } });
  const step = stepSlide(left.slides);
  assert.ok(box(step, 'Screenshot').x < box(step, 'Text').x);
  assert.match(step, /name="Screenshot"[\s\S]*?<a:ln w="12700"><a:solidFill><a:srgbClr val="0E7490"\/>/);
  const chosen = stepSlide(brandDeck(t, 'pptx-pos-chosen', { pptx: { screenshotPosition: 'left' } }, { screenshotPosition: 'below' }).slides);
  assert.ok(box(chosen, 'Screenshot').y > box(chosen, 'Text').y);
});

test('PowerPoint branding: the brand editor offers the same logo and screenshot positions as core/branding.js', () => {
  const { SLIDE_LOGO_POSITIONS, SLIDE_SCREENSHOT_POSITIONS } = require('../../core/branding');
  const { OPTION_INFO } = require('../../exporters/pptx');
  const source = fs.readFileSync(path.join(__dirname, '../../app/renderer/branding.js'), 'utf8');
  const values = (name) => [...source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))[1].matchAll(/value: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(values('BRAND_SLIDE_LOGO_POSITIONS'), SLIDE_LOGO_POSITIONS);
  assert.deepEqual(values('BRAND_SLIDE_SCREENSHOT_POSITIONS'), SLIDE_SCREENSHOT_POSITIONS);
  assert.deepEqual(OPTION_INFO.screenshotPosition.choices.map((c) => c.value), SLIDE_SCREENSHOT_POSITIONS, 'the Export dialog too');
});
