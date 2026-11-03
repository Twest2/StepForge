'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTmpDir, rmrf } = require('./helpers');
const { GuideStore } = require('../../core/store');
const { encodePng, decodePng } = require('../../core/png');
const { createImage } = require('../../core/raster');
const fmt = require('../../core/image-format');
const { optimizeGuideImages } = require('../../core/image-optimize');
const { renderStepImage, buildRenderAst } = require('../../core/renderast');

// A stand-in for Chromium's codec: a WebP is a valid VP8L header (so the
// size can be read) padded to `size` bytes, and decodes back to the PNG it
// was made from. `encodeAs` lets a test pick the output size.
function fakeCodec({ encodeAs = null, decodeFails = false } = {}) {
  const pngs = new Map();
  let next = 1;
  const calls = { encode: 0, decode: 0 };
  return {
    calls,
    async encodeWebp(png, quality) {
      calls.encode++;
      const { width, height } = decodePng(png);
      const id = next++;
      pngs.set(id, png);
      const body = Buffer.alloc(encodeAs ?? Math.max(16, Math.floor(png.length / 4)));
      const header = Buffer.alloc(25);
      header.write('RIFF', 0, 'latin1');
      header.writeUInt32LE(body.length + 17, 4);
      header.write('WEBP', 8, 'latin1');
      header.write('VP8L', 12, 'latin1');
      header.writeUInt32LE(body.length + 5, 16);
      header[20] = 0x2f;
      header.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 21);
      return Buffer.concat([header, body, Buffer.from([id])]);
    },
    async decodeToPng(buffer) {
      calls.decode++;
      if (decodeFails) throw new Error('decode failed');
      return pngs.get(buffer[buffer.length - 1]);
    },
  };
}

function solid(width, height, color = [40, 80, 160, 255]) {
  return encodePng(createImage(width, height, color));
}

function rgbaPartial(width, height) {
  const img = createImage(width, height, [200, 30, 30, 128]);
  return encodePng(img);
}

test('sniffs PNG, WebP, JPEG, GIF and BMP by content, and rejects other bytes', () => {
  assert.equal(fmt.sniffImageFormat(solid(4, 4)), 'png');
  assert.equal(fmt.sniffImageFormat(Buffer.from('RIFF0000WEBPVP8L', 'latin1')), 'webp');
  assert.equal(fmt.sniffImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpeg');
  assert.equal(fmt.sniffImageFormat(Buffer.from('GIF89a......', 'latin1')), 'gif');
  assert.equal(fmt.sniffImageFormat(Buffer.from('BM............', 'latin1')), 'bmp');
  assert.equal(fmt.sniffImageFormat(Buffer.from('plain text file')), null);
});

test('reads pixel sizes from PNG and WebP headers without decoding', () => {
  assert.deepEqual(fmt.readImageSize(solid(37, 11)), { width: 37, height: 11 });
  // VP8L: 14-bit width-1 and height-1 packed after the 0x2f signature.
  const vp8l = Buffer.alloc(30);
  vp8l.write('RIFF', 0, 'latin1'); vp8l.write('WEBP', 8, 'latin1'); vp8l.write('VP8L', 12, 'latin1');
  vp8l[20] = 0x2f; vp8l.writeUInt32LE(((1279) | ((759) << 14)) >>> 0, 21);
  assert.deepEqual(fmt.readImageSize(vp8l), { width: 1280, height: 760 });
  // VP8X: 24-bit canvas width-1 and height-1 at offsets 24 and 27.
  const vp8x = Buffer.alloc(30);
  vp8x.write('RIFF', 0, 'latin1'); vp8x.write('WEBP', 8, 'latin1'); vp8x.write('VP8X', 12, 'latin1');
  vp8x.writeUIntLE(1999, 24, 3); vp8x.writeUIntLE(919, 27, 3);
  assert.deepEqual(fmt.readImageSize(vp8x), { width: 2000, height: 920 });
  assert.equal(fmt.readImageSize(Buffer.from('not an image at all, really')), null);
});

test('rasterToPng passes PNG through and only asks the codec for other formats', async () => {
  const png = solid(3, 3);
  assert.equal(await fmt.rasterToPng(png), png);
  fmt.setImageCodec(null);
  await assert.rejects(fmt.rasterToPng(Buffer.from('RIFF0000WEBPVP8L', 'latin1')), /can't decode webp/);
  const codec = fakeCodec();
  fmt.setImageCodec(codec);
  try {
    const webp = await codec.encodeWebp(png, 0.95);
    assert.deepEqual(await fmt.rasterToPng(webp), png);
  } finally {
    fmt.setImageCodec(null);
  }
});

test('optimizeScreenshot keeps WebP only when it is smaller and the size is unchanged', async () => {
  const png = solid(200, 100);
  const smaller = await fmt.optimizeScreenshot(png, { codec: fakeCodec() });
  assert.equal(smaller.format, 'webp');
  assert.ok(smaller.buffer.length < png.length);

  const bigger = await fmt.optimizeScreenshot(png, { codec: fakeCodec({ encodeAs: png.length * 2 }) });
  assert.equal(bigger.format, 'png');
  assert.equal(bigger.buffer, png);

  const wrongSize = fakeCodec();
  wrongSize.encodeWebp = async () => Buffer.concat([Buffer.from([...Buffer.from('RIFF0000WEBPVP8L', 'latin1')]), Buffer.alloc(40)]);
  assert.equal((await fmt.optimizeScreenshot(png, { codec: wrongSize })).format, 'png');

  const failing = fakeCodec();
  failing.encodeWebp = async () => { throw new Error('encoder crashed'); };
  assert.equal((await fmt.optimizeScreenshot(png, { codec: failing })).format, 'png');
});

test('optimizeScreenshot leaves partially transparent images and the PNG setting alone', async () => {
  const codec = fakeCodec();
  const semi = rgbaPartial(40, 40);
  assert.equal(fmt.hasPartialAlpha(semi), true);
  assert.equal((await fmt.optimizeScreenshot(semi, { codec })).format, 'png');
  assert.equal(codec.calls.encode, 0);
  assert.equal((await fmt.optimizeScreenshot(solid(40, 40), { format: 'png', codec })).format, 'png');
  assert.equal(codec.calls.encode, 0);
});

test('WebP quality is clamped to the 0.8 to 1 range', () => {
  assert.equal(fmt.clampWebpQuality(0.2), 0.8);
  assert.equal(fmt.clampWebpQuality(1.5), 1);
  assert.equal(fmt.clampWebpQuality('nonsense'), fmt.DEFAULT_WEBP_QUALITY);
});

test('new captures are stored as WebP with a .webp name, and old PNG names are kept', () => {
  const dir = makeTmpDir('image-store');
  try {
    const store = new GuideStore(dir);
    const guide = store.createGuide({ title: 'Format names' });
    const webp = Buffer.concat([Buffer.from('RIFF0000WEBPVP8L', 'latin1'), Buffer.alloc(20)]);
    const step = store.addStep(guide.guideId, { title: 'Webp' }, webp, { width: 1, height: 1 });
    assert.equal(step.image.originalPath, 'original.webp');
    assert.equal(step.image.workingPath, 'original.webp');
    assert.ok(fs.existsSync(store.stepImagePath(guide.guideId, step.stepId, 'original')));

    const old = store.addStep(guide.guideId, { title: 'Old' }, solid(5, 5), { width: 5, height: 5 });
    assert.equal(old.image.originalPath, 'original.png');
  } finally {
    rmrf(dir);
  }
});

test('replacing a screenshot with another format renames the file and removes the old one', () => {
  const dir = makeTmpDir('image-replace');
  try {
    const store = new GuideStore(dir);
    const guide = store.createGuide({ title: 'Replace' });
    const step = store.addStep(guide.guideId, { title: 'Step' }, solid(5, 5), { width: 5, height: 5 });
    const webp = Buffer.concat([Buffer.from('RIFF0000WEBPVP8L', 'latin1'), Buffer.alloc(20)]);
    const saved = store.replaceImages(guide.guideId, step.stepId, { original: webp }, { width: 5, height: 5 }, step);
    assert.equal(saved.image.originalPath, 'original.webp');
    assert.equal(saved.image.workingPath, 'original.webp');
    const stepDir = store.stepDir(guide.guideId, step.stepId);
    assert.deepEqual(fs.readdirSync(stepDir).filter((f) => f.startsWith('original')).sort(), ['original.webp']);
  } finally {
    rmrf(dir);
  }
});

test('a crop keeps its own working file, named after the stored format', () => {
  const dir = makeTmpDir('image-crop');
  try {
    const store = new GuideStore(dir);
    const guide = store.createGuide({ title: 'Crop' });
    const step = store.addStep(guide.guideId, { title: 'Step' }, solid(8, 8), { width: 8, height: 8 });
    const cropped = solid(4, 4, [1, 2, 3, 255]);
    const saved = store.setWorkingImage(guide.guideId, step.stepId, cropped, { width: 4, height: 4 });
    assert.equal(saved.image.originalPath, 'original.png');
    assert.equal(saved.image.workingPath, 'working.png');
  } finally {
    rmrf(dir);
  }
});

test('prepareExportImages decodes only WebP screenshots, and the render AST uses them', async () => {
  const dir = makeTmpDir('image-export');
  try {
    const store = new GuideStore(dir);
    const guide = store.createGuide({ title: 'Export' });
    const pngStep = store.addStep(guide.guideId, { title: 'Old' }, solid(6, 4), { width: 6, height: 4 });
    const shot = solid(7, 5, [9, 99, 199, 255]);
    const codec = fakeCodec();
    const webp = await codec.encodeWebp(shot, 0.95);
    const webpStep = store.addStep(guide.guideId, { title: 'New' }, webp, { width: 7, height: 5 });

    const prepared = await fmt.prepareExportImages(store, guide.guideId, { codec });
    assert.equal(prepared.size, 1);
    const webpPath = store.stepImagePath(guide.guideId, webpStep.stepId, 'working');
    assert.deepEqual(prepared.get(webpPath), shot);

    const ast = buildRenderAst(store, guide.guideId, { images: prepared });
    const webpAst = ast.steps.find((s) => s.title === 'New');
    const rendered = renderStepImage(webpAst);
    assert.equal(rendered.width, 7);
    // Without the prepared pixels, the same step is refused rather than mis-read.
    assert.throws(() => renderStepImage(buildRenderAst(store, guide.guideId).steps.find((s) => s.title === 'New')), /not prepared/);
    assert.equal(renderStepImage(ast.steps.find((s) => s.title === 'Old')).width, 6);
    assert.equal(pngStep.image.originalPath, 'original.png');
  } finally {
    rmrf(dir);
  }
});

test('optimize guide images: dry run reports savings and writes nothing, apply converts and snapshots', async () => {
  const dir = makeTmpDir('image-optimize');
  try {
    const store = new GuideStore(dir);
    const guide = store.createGuide({ title: 'Old guide' });
    const shot = solid(120, 60, [12, 34, 56, 255]);
    const crop = solid(60, 30, [200, 10, 10, 255]);
    const step = store.addStep(guide.guideId, { title: 'Step one' }, shot, { width: 120, height: 60 });
    store.setWorkingImage(guide.guideId, step.stepId, crop, { width: 60, height: 30 });
    const translucent = store.addStep(guide.guideId, { title: 'Transparent' }, rgbaPartial(10, 10), { width: 10, height: 10 });
    store.addStep(guide.guideId, { title: 'Text only' });

    const codec = fakeCodec();
    const before = fs.readFileSync(store.stepImagePath(guide.guideId, step.stepId, 'original'));
    const dry = await optimizeGuideImages(store, guide.guideId, { dryRun: true, codec });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.steps, 2, 'steps with a screenshot');
    assert.equal(dry.screenshots, 3);
    assert.equal(dry.optimized, 0);
    assert.equal(dry.changedSteps, 1);
    assert.ok(dry.savedBytes > 0);
    assert.equal(dry.keptPng, 1, 'partially transparent screenshot stays PNG');
    assert.deepEqual(fs.readFileSync(store.stepImagePath(guide.guideId, step.stepId, 'original')), before, 'dry run writes nothing');
    assert.equal(store.getStep(guide.guideId, step.stepId).image.originalPath, 'original.png');

    const applied = await optimizeGuideImages(store, guide.guideId, { dryRun: false, codec });
    assert.equal(applied.optimized, 2);
    const after = store.getStep(guide.guideId, step.stepId);
    assert.equal(after.image.originalPath, 'original.webp');
    assert.equal(after.image.workingPath, 'working.webp');
    assert.equal(store.getStep(guide.guideId, translucent.stepId).image.originalPath, 'original.png');
    assert.ok(fs.readdirSync(store.stepDir(guide.guideId, step.stepId)).includes('working.webp'));
    assert.ok(!fs.readdirSync(store.stepDir(guide.guideId, step.stepId)).includes('working.png'));
    assert.ok(fs.existsSync(path.join(dir, 'library', 'guides', guide.guideId, 'history', 'snapshots')));

    // Already optimized: a second run finds nothing to change and skips the WebP files.
    const again = await optimizeGuideImages(store, guide.guideId, { dryRun: true, codec });
    assert.equal(again.changedSteps, 0);
    assert.equal(again.alreadyOptimized, 2);
  } finally {
    rmrf(dir);
  }
});

test('optimize refuses to run without a codec and never runs on its own', async () => {
  const dir = makeTmpDir('image-optimize-codec');
  try {
    const store = new GuideStore(dir);
    const guide = store.createGuide({ title: 'No codec' });
    store.addStep(guide.guideId, { title: 'Step' }, solid(20, 20), { width: 20, height: 20 });
    await assert.rejects(optimizeGuideImages(store, guide.guideId, { dryRun: false, codec: null }), /needs the StepForge app/);
    assert.equal(store.getStep(guide.guideId, store.listSteps(guide.guideId).keys().next().value).image.originalPath, 'original.png');
  } finally {
    rmrf(dir);
  }
});
