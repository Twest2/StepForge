'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createSnapshot } = require('./snapshots');
const { optimizeScreenshot, sniffImageFormat, getImageCodec, DEFAULT_WEBP_QUALITY } = require('./image-format');

/**
 * "Optimize guide images": convert a guide's PNG screenshots to WebP where
 * that is smaller. Old guides are never converted on their own; this runs
 * only when asked. A dry run encodes every screenshot but writes nothing and
 * reports what applying would save. Applying takes a snapshot first, so the
 * guide can be restored from History. Already-WebP files are skipped.
 */
async function optimizeGuideImages(store, guideId, {
  dryRun = true,
  format = 'webp',
  webpQuality = DEFAULT_WEBP_QUALITY,
  codec = getImageCodec(),
} = {}) {
  if (format === 'webp' && !codec) throw new Error('WebP encoding needs the StepForge app.');
  const started = Date.now();
  const report = {
    dryRun, steps: 0, screenshots: 0, optimized: 0, keptPng: 0, alreadyOptimized: 0,
    bytesBefore: 0, bytesAfter: 0, errors: [],
  };
  const plans = [];

  for (const [stepId, step] of store.listSteps(guideId)) {
    if (!step.image) continue;
    report.steps += 1;
    const dir = store.stepDir(guideId, stepId);
    const files = [...new Set([step.image.originalPath, step.image.workingPath])];
    const buffers = {};
    for (const rel of files) {
      const file = path.join(dir, rel);
      if (!fs.existsSync(file)) continue;
      report.screenshots += 1;
      const bytes = fs.readFileSync(file);
      report.bytesBefore += bytes.length;
      if (sniffImageFormat(bytes) !== 'png') {
        report.alreadyOptimized += 1;
        report.bytesAfter += bytes.length;
        continue;
      }
      try {
        const { buffer, format: stored } = await optimizeScreenshot(bytes, { format, webpQuality, codec });
        report.bytesAfter += buffer.length;
        if (stored === 'webp') buffers[rel] = buffer;
        else report.keptPng += 1;
      } catch (err) {
        report.bytesAfter += bytes.length;
        report.keptPng += 1;
        report.errors.push({ stepId, file: rel, message: err && err.message ? err.message : String(err) });
      }
    }
    if (Object.keys(buffers).length) plans.push({ stepId, buffers });
  }

  report.savedBytes = report.bytesBefore - report.bytesAfter;
  report.changedSteps = plans.length;
  if (!dryRun && plans.length) {
    createSnapshot(store, guideId, { label: 'before optimizing images' });
    for (const { stepId, buffers } of plans) {
      try {
        store.rewriteStepImages(guideId, stepId, buffers);
        report.optimized += Object.keys(buffers).length;
      } catch (err) {
        report.errors.push({ stepId, message: err && err.message ? err.message : String(err) });
      }
    }
  }
  report.elapsedMs = Date.now() - started;
  return report;
}

module.exports = { optimizeGuideImages };
