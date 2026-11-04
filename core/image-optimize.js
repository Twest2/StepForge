'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSnapshot } = require('./snapshots');
const { optimizeScreenshot, sniffImageFormat, getImageCodec, DEFAULT_WEBP_QUALITY } = require('./image-format');

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// Bind consent to the guide and exact source bytes used for the estimate.
async function imageEstimateHash(store, guideId, options) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(options));
  hash.update(JSON.stringify(store.getGuide(guideId)));
  for (const [stepId, step] of store.listSteps(guideId)) {
    hash.update(JSON.stringify([stepId, step.revision, step.image]));
    if (!step.image) continue;
    for (const rel of new Set([step.image.originalPath, step.image.workingPath].filter(Boolean))) {
      const file = path.join(store.stepDir(guideId, stepId), rel);
      let bytes;
      try { bytes = await fs.promises.readFile(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; bytes = 'missing'; }
      hash.update(JSON.stringify([rel, Buffer.isBuffer(bytes) ? digest(bytes) : bytes]));
    }
  }
  return hash.digest('hex');
}

/** Estimate without changing guide files; apply only after explicit consent. */
async function optimizeGuideImages(store, guideId, {
  dryRun = true,
  format = 'webp',
  lossless = true,
  webpQuality = DEFAULT_WEBP_QUALITY,
  expectedHash = null,
  codec = getImageCodec(),
} = {}) {
  if (format === 'webp' && !codec) throw new Error('Image optimization needs an image codec.');
  const started = Date.now();
  const options = { format, lossless, webpQuality };
  const estimateHash = await imageEstimateHash(store, guideId, options);
  const changed = () => Object.assign(new Error('Guide changed. Estimate image savings again before applying.'), { code: 'IMAGE_ESTIMATE_CHANGED' });
  if (expectedHash && estimateHash !== expectedHash) throw changed();
  const report = {
    dryRun, estimateHash, steps: 0, screenshots: 0, optimized: 0, keptPng: 0, alreadyOptimized: 0,
    bytesBefore: 0, bytesAfter: 0, errors: [], proposedImages: 0,
  };
  const plans = [];
  for (const [stepId, step] of store.listSteps(guideId)) {
    if (!step.image) continue;
    report.steps++;
    const dir = store.stepDir(guideId, stepId);
    const buffers = {};
    const hashes = {};
    let saving = 0;
    for (const rel of new Set([step.image.originalPath, step.image.workingPath].filter(Boolean))) {
      const file = path.join(dir, rel);
      if (!fs.existsSync(file)) { report.errors.push({ stepId, file: rel, message: 'Screenshot file is missing.' }); continue; }
      report.screenshots++;
      const bytes = await fs.promises.readFile(file);
      report.bytesBefore += bytes.length;
      report.bytesAfter += bytes.length;
      if (sniffImageFormat(bytes) !== 'png') { report.alreadyOptimized++; continue; }
      try {
        const result = await optimizeScreenshot(bytes, { ...options, codec });
        if (result.format === 'webp') {
          buffers[rel] = result.buffer;
          hashes[rel] = digest(bytes);
          saving += bytes.length - result.buffer.length;
          report.proposedImages++;
        } else report.keptPng++;
      } catch (err) {
        report.keptPng++;
        report.errors.push({ stepId, file: rel, message: err.message });
      }
    }
    if (Object.keys(buffers).length) plans.push({ stepId, revision: step.revision, buffers, hashes, saving });
  }
  if (await imageEstimateHash(store, guideId, options) !== estimateHash) throw changed();
  report.estimatedSavedBytes = plans.reduce((sum, plan) => sum + plan.saving, 0);
  report.changedSteps = plans.length;
  if (dryRun) report.bytesAfter -= report.estimatedSavedBytes;
  else if (plans.length) {
    createSnapshot(store, guideId, { label: 'before optimizing images' });
    for (const plan of plans) {
      try {
        store.rewriteStepImages(guideId, plan.stepId, plan.buffers, { expectedRevision: plan.revision, expectedHashes: plan.hashes });
        report.optimized += Object.keys(plan.buffers).length;
        report.bytesAfter -= plan.saving;
      } catch (err) {
        report.errors.push({ stepId: plan.stepId, message: err.message });
      }
    }
  }
  report.savedBytes = report.bytesBefore - report.bytesAfter;
  report.elapsedMs = Date.now() - started;
  return report;
}

module.exports = { optimizeGuideImages, imageEstimateHash };
