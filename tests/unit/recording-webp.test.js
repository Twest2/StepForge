'use strict';

// A recording saves its screenshots as PNG and converts them to WebP once it
// is over (core/image-optimize.js convertStepsToWebp).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GuideStore } = require('../../core/store');
const { saveStepFromEditor } = require('../../core/editor-save');
const { convertStepsToWebp } = require('../../core/image-optimize');
const { createImageCodec } = require('../../core/image-codec');
const { sniffImageFormat } = require('../../core/image-format');
const { encodePng } = require('../../core/png');
const { createImage, fillRect } = require('../../core/raster');
const { makeTmpDir, rmrf } = require('./helpers');

const codec = createImageCodec({ electron: undefined });

/** A screen-like PNG (flat areas and bars), which WebP stores smaller. */
function screenPng(seed = 0) {
  const image = createImage(240, 160, [245, 245, 245, 255]);
  fillRect(image, 0, 0, 240, 24, [40, 60, 90, 255]);
  for (let i = 0; i < 6; i++) fillRect(image, 12, 36 + i * 20, 80 + ((i * 37 + seed * 13) % 140), 8, [30 + seed * 20, 30, 30, 255]);
  return encodePng(image);
}

function recording(t, count = 3) {
  const root = makeTmpDir('recording-webp');
  t.after(() => rmrf(root));
  const store = new GuideStore(root);
  const { guideId } = store.createGuide({ title: 'Recorded' });
  const steps = Array.from({ length: count }, (_, i) => store.addStep(guideId, { title: `Click ${i + 1}` }, screenPng(i), { width: 240, height: 160 }));
  return { store, guideId, steps, file: (stepId, which = 'originalPath') => path.join(store.stepDir(guideId, stepId), store.getStep(guideId, stepId).image[which]) };
}

test('a recording’s PNG screenshots become WebP, the same pictures, without the guide looking edited', async (t) => {
  const { store, guideId, steps, file } = recording(t);
  const before = steps.map((s) => fs.readFileSync(file(s.stepId)));
  const pngNames = steps.map((s) => store.getStep(guideId, s.stepId).image.originalPath);
  const updatedAt = store.getGuide(guideId).updatedAt;

  const report = await convertStepsToWebp(store, guideId, steps.map((s) => s.stepId), { codec, concurrency: 3 });

  assert.equal(report.converted, 3);
  assert.deepEqual(report.errors, []);
  assert.ok(report.bytesAfter < report.bytesBefore);
  const sharp = require('sharp');
  for (const [i, s] of steps.entries()) {
    const step = store.getStep(guideId, s.stepId);
    const bytes = fs.readFileSync(file(s.stepId));
    assert.equal(sniffImageFormat(bytes), 'webp');
    assert.equal(step.image.workingPath, step.image.originalPath);
    assert.deepEqual(step.image.reencodedFrom, { originalPath: pngNames[i], workingPath: pngNames[i] });
    assert.equal(fs.existsSync(path.join(store.stepDir(guideId, s.stepId), pngNames[i])), false, 'the PNG is removed');
    const [a, b] = await Promise.all([bytes, before[i]].map((buf) => sharp(buf).ensureAlpha().raw().toBuffer()));
    assert.ok(a.equals(b), 'the WebP holds exactly the PNG’s pixels');
  }
  assert.equal(store.getGuide(guideId).updatedAt, updatedAt, 'a format change is not an edit');
});

test('converting skips deleted steps, files already changed, and screenshots that are already WebP', async (t) => {
  const { store, guideId, steps, file } = recording(t);
  store.deleteStep(guideId, steps[0].stepId);
  await convertStepsToWebp(store, guideId, [steps[1].stepId], { codec });
  const webp = fs.readFileSync(file(steps[1].stepId));

  // The file changed after it was read: keep it, report why.
  let swapped = false;
  const sneaky = { ...codec, async encodeWebp(...args) {
    if (!swapped) { swapped = true; fs.writeFileSync(file(steps[2].stepId), screenPng(9)); }
    return codec.encodeWebp(...args);
  } };
  const report = await convertStepsToWebp(store, guideId, steps.map((s) => s.stepId), { codec: sneaky });
  assert.equal(report.converted, 0);
  assert.equal(report.keptPng, 1, 'the already-WebP step is left alone');
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].stepId, steps[2].stepId);
  assert.equal(sniffImageFormat(fs.readFileSync(file(steps[2].stepId))), 'png');
  assert.ok(fs.readFileSync(file(steps[1].stepId)).equals(webp));
});

test('a step edited while it converts is read again and still converted, keeping the edit', async (t) => {
  const { store, guideId, steps, file } = recording(t, 1);
  const { stepId } = steps[0];
  let edited = false;
  const racing = { ...codec, async encodeWebp(...args) {
    if (!edited) {
      edited = true;
      const step = store.getStep(guideId, stepId);
      store.saveStep(guideId, { ...step, title: 'Renamed while converting' });
    }
    return codec.encodeWebp(...args);
  } };
  const report = await convertStepsToWebp(store, guideId, [stepId], { codec: racing });
  assert.equal(report.converted, 1);
  assert.equal(store.getStep(guideId, stepId).title, 'Renamed while converting');
  assert.equal(sniffImageFormat(fs.readFileSync(file(stepId))), 'webp');
});

test('the hooks around each swap see the step before and after, for state tied to the old file', async (t) => {
  const { store, guideId, steps } = recording(t, 2);
  const seen = [];
  await convertStepsToWebp(store, guideId, steps.map((s) => s.stepId), {
    codec,
    beforeRewrite: (step) => step.image.originalPath,
    afterRewrite: (saved, oldPath) => seen.push([oldPath, saved.image.reencodedFrom.originalPath, saved.image.originalPath.endsWith('.webp')]),
  });
  assert.equal(seen.length, 2);
  for (const [oldPath, recorded, isWebp] of seen) {
    assert.equal(oldPath, recorded);
    assert.equal(isWebp, true);
  }
});

test('an editor still holding the PNG file names saves its annotation edits after the conversion', async (t) => {
  // Otherwise the save looks like it is for a different screenshot, and the
  // stored annotations win: a marker drawn just after stopping would vanish.
  const { store, guideId, steps } = recording(t, 1);
  const { stepId } = steps[0];
  const loaded = store.getStep(guideId, stepId);
  const baseStep = structuredClone(loaded);
  await convertStepsToWebp(store, guideId, [stepId], { codec });

  const edited = { ...loaded, annotations: [{ id: 'a1', type: 'oval', x: 0.1, y: 0.1, w: 0.2, h: 0.2, style: {} }] };
  const saved = saveStepFromEditor(store, guideId, edited, baseStep);
  assert.equal(saved.annotations.length, 1, 'the user’s new annotation is kept');
  assert.ok(saved.image.originalPath.endsWith('.webp'), 'the editor cannot point the step back at the PNG');
});

test('a real new screenshot still counts as a different picture after a conversion', async (t) => {
  const { store, guideId, steps } = recording(t, 1);
  const { stepId } = steps[0];
  await convertStepsToWebp(store, guideId, [stepId], { codec });
  const converted = store.getStep(guideId, stepId);
  const cropped = store.setWorkingImage(guideId, stepId, screenPng(5), { width: 120, height: 80 });
  assert.equal(cropped.image.reencodedFrom, undefined, 'a crop is not a re-encode');

  const stale = { ...converted, annotations: [{ id: 'a2', type: 'oval', x: 0.5, y: 0.5, w: 0.1, h: 0.1, style: {} }] };
  const saved = saveStepFromEditor(store, guideId, stale, structuredClone(converted));
  assert.deepEqual(saved.annotations, cropped.annotations, 'annotations follow the screenshot they were drawn on');
});
