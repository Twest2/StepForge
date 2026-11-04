'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createImageCodec } = require('../../core/image-codec');
const { optimizeScreenshot, prepareExportImages, sniffImageFormat } = require('../../core/image-format');
const { optimizeGuideImages } = require('../../core/image-optimize');
const { encodePng, decodePng } = require('../../core/png');
const raster = require('../../core/raster');
const { GuideStore } = require('../../core/store');
const { Settings } = require('../../core/settings');
const { renderStepImage, buildRenderAst } = require('../../core/renderast');
const { exportGuideArchive, importGuideArchive } = require('../../core/archive');
const { listSnapshots, restoreSnapshot } = require('../../core/snapshots');
const { createAgentTools } = require('../../core/agent-tools');
const { runExportInWorker } = require('../../app/export-runner');
const { unzipSync } = require('../../core/zip');
const { buildFixtureGuide } = require('./fixture-guide');
const { makeTmpDir, rmrf } = require('./helpers');
const codec = createImageCodec();

function screenshot() {
  const image = raster.createImage(480, 240, [248, 249, 250, 255]);
  raster.fillRect(image, 0, 0, 480, 32, [25, 45, 65, 255]);
  raster.drawText(image, 12, 48, 'Save settings   12345   const value = true;', 16, [10, 20, 30, 255]);
  raster.drawText(image, 12, 80, 'Small UI text and colored edges must stay sharp.', 12, [30, 40, 50, 255]);
  raster.fillRect(image, 15, 130, 115, 35, [0, 104, 255, 255]);
  raster.drawText(image, 34, 139, 'Save', 14, [255, 255, 255, 255]);
  return encodePng(image);
}

function library(t) {
  const root = makeTmpDir('image-codec-real');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const guide = store.createGuide({ title: 'Image optimization' });
  const png = screenshot();
  const step = store.addStep(guide.guideId, { title: 'Read the small text', annotations: [{ type: 'arrow', x: 0.1, y: 0.1, w: 0.4, h: 0.3 }, { type: 'blur', x: 0.02, y: 0.2, w: 0.2, h: 0.1 }] }, png, { width: 480, height: 240 });
  return { root, store, guide, step, png };
}

test('real lossless WebP preserves every RGBA byte, including colors under transparent pixels', async () => {
  const image = raster.createImage(80, 40);
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = (i * 13) % 256;
    image.data[i + 1] = (i * 7) % 256;
    image.data[i + 2] = (i * 3) % 256;
    image.data[i + 3] = [0, 64, 128, 255][(i / 4) % 4];
  }
  const webp = await codec.encodeWebp(encodePng(image));
  assert.equal(sniffImageFormat(webp), 'webp');
  const decoded = decodePng(await codec.decodeToPng(webp));
  assert.equal(decoded.width, image.width);
  assert.equal(decoded.height, image.height);
  assert.deepEqual(decoded.data, image.data);
});

test('new settings default to lossless and lossy quality cannot load below the protected range', (t) => {
  const { store } = library(t);
  let settings = new Settings(store.settingsDir);
  assert.deepEqual(settings.get('images'), { format: 'webp', lossless: true, webpQuality: 0.95 });
  fs.writeFileSync(settings.file, JSON.stringify({ images: { format: 'webp', webpQuality: 0.2 } }));
  settings = new Settings(store.settingsDir);
  assert.equal(settings.get('images.lossless'), true);
  assert.equal(settings.get('images.webpQuality'), 0.95);
});

test('screenshot text stays pixel-exact in lossless mode and protected lossy output stays within its limits', async () => {
  const png = screenshot();
  const original = decodePng(png);
  const lossless = await optimizeScreenshot(png, { codec });
  assert.equal(lossless.format, 'webp');
  assert.ok(lossless.buffer.length < png.length);
  assert.deepEqual(decodePng(await codec.decodeToPng(lossless.buffer)).data, original.data);
  const lossy = await codec.encodeWebp(png, { lossless: false, quality: 0.95 });
  const pixels = decodePng(await codec.decodeToPng(lossy)).data;
  let error = 0;
  for (let i = 0; i < pixels.length; i++) {
    const delta = Math.abs(pixels[i] - original.data[i]);
    assert.ok(delta <= 8);
    if (i % 4 === 3) assert.equal(delta, 0);
    else error += delta * delta;
  }
  assert.ok(Math.sqrt(error / (pixels.length * 0.75)) <= 1.5);
  const skipped = await optimizeScreenshot(lossless.buffer, { codec });
  assert.equal(skipped.buffer, lossless.buffer, 'existing WebP is not recompressed');
});

test('an estimate never edits guide files; applying preserves rendered annotations and creates a recoverable snapshot', async (t) => {
  const { store, guide, step, png } = library(t);
  const before = renderStepImage(buildRenderAst(store, guide.guideId).steps[0]);
  const estimate = await optimizeGuideImages(store, guide.guideId, { codec });
  assert.ok(estimate.savedBytes > 0);
  assert.equal(store.getStep(guide.guideId, step.stepId).image.originalPath, 'original.png');
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guide.guideId, step.stepId)), png);
  assert.equal(listSnapshots(store, guide.guideId).length, 0);
  const applied = await optimizeGuideImages(store, guide.guideId, { codec, dryRun: false, expectedHash: estimate.estimateHash });
  assert.equal(applied.savedBytes, estimate.savedBytes);
  assert.equal(applied.optimized, 1);
  const images = await prepareExportImages(store, guide.guideId, { codec });
  const after = renderStepImage(buildRenderAst(store, guide.guideId, { images }).steps[0]);
  assert.deepEqual(after, before, 'annotations and screenshot pixels do not change');
  const snapshots = listSnapshots(store, guide.guideId);
  assert.equal(snapshots.length, 1);
  restoreSnapshot(store, guide.guideId, snapshots[0]);
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guide.guideId, step.stepId)), png);
});

test('changes after an estimate or during encoding cannot overwrite current guide content', async (t) => {
  const { store, guide, step, png } = library(t);
  const estimate = await optimizeGuideImages(store, guide.guideId, { codec });
  store.saveStep(guide.guideId, { ...store.getStep(guide.guideId, step.stepId), title: 'Changed after estimate' });
  await assert.rejects(optimizeGuideImages(store, guide.guideId, { codec, dryRun: false, expectedHash: estimate.estimateHash }), /Guide changed/);
  assert.equal(listSnapshots(store, guide.guideId).length, 0);
  const racing = { ...codec, async encodeWebp(bytes, options) {
    store.saveStep(guide.guideId, { ...store.getStep(guide.guideId, step.stepId), title: 'Changed while encoding' });
    return codec.encodeWebp(bytes, options);
  } };
  await assert.rejects(optimizeGuideImages(store, guide.guideId, { codec: racing, dryRun: false }), /Guide changed/);
  assert.equal(store.getStep(guide.guideId, step.stepId).title, 'Changed while encoding');
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guide.guideId, step.stepId)), png);
});

test('old and optimized archives remain readable, and headless agent screenshot reads keep working', async (t) => {
  const { root, store, guide, step, png } = library(t);
  const old = path.join(root, 'old.sfgz');
  exportGuideArchive(store, guide.guideId, old);
  const oldCopy = importGuideArchive(store, old);
  assert.equal(store.listSteps(oldCopy.guideId).values().next().value.image.originalPath, 'original.png');
  await optimizeGuideImages(store, guide.guideId, { codec, dryRun: false });
  const archive = path.join(root, 'optimized.sfgz');
  exportGuideArchive(store, guide.guideId, archive);
  const copy = importGuideArchive(store, archive);
  const copied = store.listSteps(copy.guideId).values().next().value;
  assert.match(copied.image.originalPath, /\.webp$/);
  const tools = createAgentTools({ store, agentSettings: () => ({ enabled: true, screenshots: true }) });
  const result = await tools.find(tool => tool.name === 'get_step').handler({ guide_id: copy.guideId, step_id: copied.stepId, include_screenshot: true });
  const image = result.content.find(block => block.type === 'image');
  assert.ok(image, 'headless reads produce a screenshot without Electron');
  assert.equal(image.mimeType, 'image/png');
  assert.deepEqual(decodePng(Buffer.from(image.data, 'base64')), raster.renderAnnotations(decodePng(png), copied.annotations), 'headless screenshots preserve annotations and privacy blurs');
  const changed = store.getStep(guide.guideId, step.stepId);
  store.saveStep(guide.guideId, { ...changed, title: 'Still editable' });
  assert.equal(store.getStep(guide.guideId, step.stepId).title, 'Still editable');
  assert.ok(png.length > 0);
});

test('every export worker decodes real WebP screenshots and Office packages contain PNG images', async (t) => {
  const root = makeTmpDir('webp-all-exports');
  t.after(() => rmrf(root));
  const { store, guide } = buildFixtureGuide(path.join(root, 'data'));
  const applied = await optimizeGuideImages(store, guide.guideId, { codec, dryRun: false });
  assert.equal(applied.optimized, 2);
  for (const format of ['pdf', 'docx', 'pptx', 'markdown', 'html-simple', 'html-rich', 'wikijs', 'confluence', 'gif', 'image-bundle', 'json']) {
    const result = await runExportInWorker({ dataDir: store.root, guideId: guide.guideId, format, options: {}, outDir: path.join(root, format), globals: {} });
    assert.ok(fs.statSync(result.file).size > 0, format);
    assert.ok((result.imageCount ?? result.frameCount) >= 2, `${format}: screenshots exported`);
    if (['docx', 'pptx', 'confluence'].includes(format)) {
      const media = unzipSync(fs.readFileSync(result.file)).filter(entry => /\.(png|jpe?g)$/i.test(entry.name));
      assert.ok(media.length >= 2, `${format}: embedded images`);
      for (const image of media) assert.ok(decodePng(image.data).width > 0);
    }
  }
});

test('long Windows previews use a content-typed data URL while short paths retain cache-busted file URLs', async (t) => {
  const { root, png } = library(t);
  const { imagePreviewUrl } = require('../../core/image-format');
  const dir = path.join(root, 'long-path-'.repeat(12), 'nested-'.repeat(12));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'optimized.webp');
  const webp = await codec.encodeWebp(png);
  fs.writeFileSync(file, webp);
  assert.ok(file.length >= 240);
  assert.equal(imagePreviewUrl(file, { platform: 'win32' }), `data:image/webp;base64,${webp.toString('base64')}`);
  const short = path.join(root, 'image.png');
  fs.writeFileSync(short, png);
  const url = new URL(imagePreviewUrl(short, { platform: 'win32' }));
  assert.equal(url.protocol, 'file:');
  assert.ok(url.searchParams.has('v'));
});

test('export preparation ignores omitted, missing and out-of-preview screenshots', async (t) => {
  const { store, guide, step, png } = library(t);
  const first = await codec.encodeWebp(png);
  store.replaceImages(guide.guideId, step.stepId, { original: first }, { width: 480, height: 240 });
  const hidden = store.addStep(guide.guideId, { title: 'Hidden', hidden: true }, first, { width: 480, height: 240 });
  const missing = store.addStep(guide.guideId, { title: 'Missing' }, png, { width: 480, height: 240 });
  const later = store.addStep(guide.guideId, { title: 'After preview' }, first, { width: 480, height: 240 });
  fs.unlinkSync(store.stepImagePath(guide.guideId, hidden.stepId));
  fs.unlinkSync(store.stepImagePath(guide.guideId, missing.stepId));
  const calls = [];
  const tracking = { ...codec, async decodeToPng(bytes) { calls.push(bytes); return codec.decodeToPng(bytes); } };
  const preview = await prepareExportImages(store, guide.guideId, { codec: tracking, maxSteps: 2 });
  assert.equal(calls.length, 1);
  assert.equal(preview.size, 1);
  assert.equal(preview.has(store.stepImagePath(guide.guideId, later.stepId)), false);
  const all = await prepareExportImages(store, guide.guideId, { codec: tracking });
  assert.equal(all.size, 2);
});

test('the recording screenshot-storage path uses the shared lossless codec and keeps PNG when disabled', async () => {
  const CaptureService = require('../../app/capture');
  const png = screenshot();
  const get = (format) => (key) => ({ 'images.format': format, 'images.lossless': true, 'images.webpQuality': 0.95 })[key];
  const stored = await CaptureService.prototype.storeScreenshot.call({ settings: { get: get('webp') } }, png);
  assert.equal(sniffImageFormat(stored), 'webp');
  assert.deepEqual(decodePng(await codec.decodeToPng(stored)).data, decodePng(png).data);
  assert.equal(await CaptureService.prototype.storeScreenshot.call({ settings: { get: get('png') } }, png), png);
});
