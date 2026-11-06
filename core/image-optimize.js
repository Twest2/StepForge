'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSnapshot } = require('./snapshots');
const { optimizeScreenshot, sniffImageFormat, getImageCodec, DEFAULT_WEBP_QUALITY } = require('./image-format');

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * How many screenshots to read and encode at once: about one per processor
 * core (half the hardware threads), at most 8, and at most one per GB of
 * memory, since a large screenshot takes a few hundred MB while it encodes.
 */
function defaultConcurrency() {
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(8, Math.floor(cpus / 2), Math.floor(os.totalmem() / 2 ** 30)));
}

/** `fn(item)` for every item, at most `limit` at a time; results in item order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

/** Each step's screenshot files (original and crop), in step order. */
function screenshotFiles(store, guideId, steps = store.listSteps(guideId)) {
  const files = [];
  for (const [stepId, step] of steps) {
    if (!step.image) continue;
    const dir = store.stepDir(guideId, stepId);
    for (const rel of new Set([step.image.originalPath, step.image.workingPath].filter(Boolean))) {
      files.push({ stepId, step, rel, file: path.join(dir, rel) });
    }
  }
  return files;
}

// Bind consent to the guide and exact source bytes used for the estimate.
async function imageEstimateHash(store, guideId, options, concurrency = defaultConcurrency()) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(options));
  hash.update(JSON.stringify(store.getGuide(guideId)));
  const steps = store.listSteps(guideId);
  const files = screenshotFiles(store, guideId, steps);
  // Read and hash the files side by side, then add them in step order.
  const digests = await mapLimit(files, concurrency, async ({ file }) => {
    try { return digest(await fs.promises.readFile(file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return 'missing'; }
  });
  let at = 0;
  for (const [stepId, step] of steps) {
    hash.update(JSON.stringify([stepId, step.revision, step.image]));
    while (at < files.length && files[at].stepId === stepId) {
      hash.update(JSON.stringify([files[at].rel, digests[at]]));
      at++;
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
  concurrency = defaultConcurrency(),
} = {}) {
  if (format === 'webp' && !codec) throw new Error('Image optimization needs an image codec.');
  const started = Date.now();
  const options = { format, lossless, webpQuality };
  const estimateHash = await imageEstimateHash(store, guideId, options, concurrency);
  const changed = () => Object.assign(new Error('Guide changed. Estimate image savings again before applying.'), { code: 'IMAGE_ESTIMATE_CHANGED' });
  if (expectedHash && estimateHash !== expectedHash) throw changed();
  const report = {
    dryRun, estimateHash, steps: 0, screenshots: 0, optimized: 0, keptPng: 0, alreadyOptimized: 0,
    bytesBefore: 0, bytesAfter: 0, errors: [], proposedImages: 0,
  };
  // Read and encode several screenshots at once, then tally them in step
  // order. Only each file's size and hash are kept, not the original bytes.
  const steps = store.listSteps(guideId);
  report.steps = [...steps.values()].filter((step) => step.image).length;
  const files = screenshotFiles(store, guideId, steps);
  const results = await mapLimit(files, concurrency, async ({ file }) => {
    let bytes;
    try { bytes = await fs.promises.readFile(file); }
    catch (error) { if (error.code === 'ENOENT') return { missing: true }; throw error; }
    const size = bytes.length;
    if (sniffImageFormat(bytes) !== 'png') return { size };
    try {
      return { size, hash: digest(bytes), result: await optimizeScreenshot(bytes, { ...options, codec }) };
    } catch (error) {
      return { size, error };
    }
  });
  const byStep = new Map();
  files.forEach(({ stepId, step, rel }, index) => {
    const { missing, size, hash, result, error } = results[index];
    if (missing) { report.errors.push({ stepId, file: rel, message: 'Screenshot file is missing.' }); return; }
    report.screenshots++;
    report.bytesBefore += size;
    report.bytesAfter += size;
    if (error) {
      report.keptPng++;
      report.errors.push({ stepId, file: rel, message: error.message });
    } else if (!result) report.alreadyOptimized++;
    else if (result.format === 'webp') {
      if (!byStep.has(stepId)) byStep.set(stepId, { stepId, revision: step.revision, buffers: {}, hashes: {}, saving: 0 });
      const plan = byStep.get(stepId);
      plan.buffers[rel] = result.buffer;
      plan.hashes[rel] = hash;
      plan.saving += size - result.buffer.length;
      report.proposedImages++;
    } else report.keptPng++;
  });
  const plans = [...byStep.values()];
  if (await imageEstimateHash(store, guideId, options, concurrency) !== estimateHash) throw changed();
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

module.exports = { optimizeGuideImages, imageEstimateHash, defaultConcurrency, mapLimit };
