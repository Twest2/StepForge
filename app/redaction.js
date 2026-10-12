'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { normalizeAnnotation } = require('../core/schema');
const { RevisionConflictError } = require('../core/store');
const redaction = require('../core/redaction');

/*
 * Blurs private details in a guide's screenshots. Text recognition reads
 * each screenshot at twice its size (small interface text is read far more
 * reliably), core/redaction.js picks out the private details, and each one
 * becomes a blur annotation. Blurs are drawn into every exported and
 * published image, so the hidden pixels never leave the computer.
 *
 * A step remembers that it was checked (and against which rules, image and
 * word list), so a guide is only read again where something changed.
 */

const MAX_READ_WIDTH = 4000;

/**
 * A raw 32-bit BGRA bitmap (Electron's nativeImage.toBitmap()) as a binary
 * PPM, which text recognition reads as readily as a PNG. Encoding a large
 * PNG blocks the main process for a third of a second; this takes a few ms.
 *
 * PPM has no alpha, so each pixel is laid over white first, as a viewer
 * shows it. Otherwise an imported PNG with dark text on a transparent
 * background (transparent pixels are stored as black) reads as solid black
 * and none of its text is found. Skia's bitmaps are premultiplied, so over
 * white a channel is c + (255 - alpha); the clamp keeps straight-alpha input
 * in range.
 */
function bitmapToPpm(bgra, width, height) {
  const stride = bgra.length / height;
  if (!Number.isInteger(stride) || stride < width * 4) throw new Error('A screenshot in this guide couldn’t be read.');
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii');
  const ppm = Buffer.allocUnsafe(header.length + width * height * 3);
  header.copy(ppm);
  let o = header.length;
  for (let y = 0; y < height; y += 1) {
    for (let i = y * stride, end = i + width * 4; i < end; i += 4, o += 3) {
      const white = 255 - bgra[i + 3];
      ppm[o] = Math.min(255, bgra[i + 2] + white);
      ppm[o + 1] = Math.min(255, bgra[i + 1] + white);
      ppm[o + 2] = Math.min(255, bgra[i] + white);
    }
  }
  return ppm;
}

class RedactionService {
  /**
   * `readLines(image)` returns recognized lines with word boxes.
   * `loadImage(path)` returns { width, height, encode(scale) } for a
   * screenshot, `encode` giving the image enlarged `scale` times in a form
   * `readLines` takes. `concurrency` screenshots are read at once.
   */
  constructor({ store, settings, readLines, loadImage, concurrency = 1 }) {
    Object.assign(this, { store, settings, readLines, loadImage, concurrency });
    this.running = new Map();
    this.preparing = Promise.resolve();
  }

  /**
   * Enlarging a screenshot keeps the main process busy for ~100 ms. With
   * several screenshots being read at once, they're enlarged one at a time
   * and other events (input, IPC) are handled in between.
   */
  prepare(fn) {
    const turn = this.preparing.then(() => new Promise((resolve) => setTimeout(resolve, 0))).then(fn);
    this.preparing = turn.catch(() => {});
    return turn;
  }

  options() {
    const terms = this.settings.get('redaction')?.terms;
    return { terms: Array.isArray(terms) ? terms.filter((t) => typeof t === 'string') : [] };
  }

  // What a step was last checked against. Changing any of it means checking again.
  checkedKey(guideId, step, options) {
    let modified = 0;
    try { modified = fs.statSync(this.store.stepImagePath(guideId, step.stepId)).mtimeMs; } catch { /* no image */ }
    const terms = crypto.createHash('sha256').update(JSON.stringify(options.terms)).digest('hex').slice(0, 12);
    return `${redaction.RULES_VERSION}:${step.image?.workingPath}:${step.image?.size?.width}x${step.image?.size?.height}:${modified}:${terms}`;
  }

  async readScreenshot(guideId, step, options) {
    const { image, scale, encoded } = await this.prepare(async () => {
      const loaded = await this.loadImage(this.store.stepImagePath(guideId, step.stepId));
      const enlarge = Math.max(1, Math.min(2, MAX_READ_WIDTH / Math.max(1, loaded.width)));
      return { image: loaded, scale: enlarge, encoded: loaded.encode(enlarge) };
    });
    const lines = await this.readLines(encoded);
    // Word boxes come back in the enlarged image's pixels.
    const toStep = (v, axis) => v / scale * (axis === 'x' ? step.image.size.width / image.width : step.image.size.height / image.height);
    const scaled = lines.map((line) => ({ words: line.words.map((w) => ({ text: w.text,
      bbox: { x0: toStep(w.bbox.x0, 'x'), x1: toStep(w.bbox.x1, 'x'), y0: toStep(w.bbox.y0, 'y'), y1: toStep(w.bbox.y1, 'y') } })) }));
    return redaction.findInLines(scaled, options);
  }

  /** Check one step's screenshot and add blurs. Returns the number added. */
  async checkStep(guideId, stepId, { force = false, options = this.options() } = {}) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const step = this.store.getStep(guideId, stepId);
      if (step.kind !== 'image' || !step.image?.size) return 0;
      const key = this.checkedKey(guideId, step, options);
      if (!force && step.redaction?.checked === key) return 0;
      const findings = await this.readScreenshot(guideId, step, options);
      const blurs = redaction.newBlurs(step, findings, step.image.size).map((blur) => normalizeAnnotation(blur));
      step.annotations = [...(step.annotations || []), ...blurs];
      step.redaction = { ...(step.redaction || {}), checked: key };
      try {
        this.store.saveStep(guideId, step, { expectedRevision: step.revision });
        return blurs.length;
      } catch (err) {
        // Edited while it was being read: read the new version and try again.
        if (!(err instanceof RevisionConflictError)) throw err;
      }
    }
    return 0;
  }

  /**
   * Check every screenshot in a guide that hasn't been checked since it
   * last changed. `onProgress({ done, total })` follows along.
   */
  checkGuide(guideId, { force = false, onProgress = () => {} } = {}) {
    // One check per guide at a time; a second request joins the first.
    if (this.running.has(guideId) && !force) return this.running.get(guideId);
    const job = (async () => {
      const guide = this.store.getGuide(guideId);
      const options = this.options();
      const steps = this.store.listSteps(guideId);
      const pending = guide.stepsOrder.map((id) => steps.get(id)).filter((step) => step?.kind === 'image' && step.image?.size
        && (force || step.redaction?.checked !== this.checkedKey(guideId, step, options)));
      let added = 0;
      let done = 0;
      let next = 0;
      let failed = false;
      onProgress({ done, total: pending.length });
      // Several screenshots are read side by side; the first error stops the rest.
      const checkNext = async () => {
        while (next < pending.length && !failed) {
          const step = pending[next];
          next += 1;
          let blurs;
          try {
            blurs = await this.checkStep(guideId, step.stepId, { force, options });
          } catch (err) {
            failed = true;
            throw err;
          }
          // Not `added += await …`: that reads `added` before another check finishes.
          added += blurs;
          done += 1;
          onProgress({ done, total: pending.length });
        }
      };
      const lanes = Math.max(1, Math.min(this.concurrency, pending.length));
      const results = await Promise.allSettled(Array.from({ length: lanes }, checkNext));
      const error = results.find((result) => result.status === 'rejected');
      if (error) throw error.reason;
      return { checked: pending.length, added, ...this.review(guideId) };
    })().finally(() => { if (this.running.get(guideId) === job) this.running.delete(guideId); });
    this.running.set(guideId, job);
    return job;
  }

  /**
   * What to review: every blur StepForge added and every private detail in
   * step text, in guide order. Screenshot findings aren't stored as text,
   * so they're listed by kind.
   */
  review(guideId) {
    const guide = this.store.getGuide(guideId);
    const steps = this.store.listSteps(guideId);
    const options = this.options();
    const blurs = [];
    const text = [];
    guide.stepsOrder.forEach((stepId, index) => {
      const step = steps.get(stepId);
      if (!step) return;
      for (const ann of step.annotations || []) {
        if (ann.type === 'blur' && ann.redact) blurs.push({ stepId, stepNumber: index + 1, annotationId: ann.id, kind: ann.redact.kind, label: redaction.KINDS[ann.redact.kind] || 'Private detail' });
      }
      for (const found of redaction.findInStepText(step, options)) {
        text.push({ stepId, stepNumber: index + 1, field: found.field, kind: found.kind, key: found.key,
          label: redaction.KINDS[found.kind] || 'Private detail', preview: redaction.maskText(found.kind, found.text) });
      }
    });
    return { blurs, text, steps: new Set([...blurs, ...text].map((item) => item.stepId)).size };
  }

  update(guideId, stepId, change) {
    const step = this.store.getStep(guideId, stepId);
    change(step);
    return this.store.saveStep(guideId, step);
  }

  /** "Not private": remove a blur StepForge added and don't add it again. */
  keepVisible({ guideId, stepId, annotationId }) {
    return this.update(guideId, stepId, (step) => {
      const ann = (step.annotations || []).find((a) => a.id === annotationId);
      if (!ann) return;
      step.annotations = step.annotations.filter((a) => a !== ann);
      if (ann.redact?.key) step.redaction = { ...(step.redaction || {}), dismissed: [...new Set([...(step.redaction?.dismissed || []), ann.redact.key])] };
    });
  }

  /** Stop flagging a detail in step text. */
  keepText({ guideId, stepId, key }) {
    return this.update(guideId, stepId, (step) => {
      step.redaction = { ...(step.redaction || {}), dismissed: [...new Set([...(step.redaction?.dismissed || []), key])] };
    });
  }

  /** Replace every private detail in a step's title and description with "[hidden]". */
  hideText({ guideId, stepId }) {
    const options = this.options();
    return this.update(guideId, stepId, (step) => Object.assign(step, redaction.hideInStepText(step, options)));
  }
}

module.exports = { RedactionService, MAX_READ_WIDTH, bitmapToPpm };
